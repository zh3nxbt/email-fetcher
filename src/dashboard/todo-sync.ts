import { db, schema } from "@/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import type { CategorizedThread, IdentifiedTodo } from "@/report/types";
import type { Category, ItemType, TodoType } from "@/db/schema";

export interface TodoSyncResult {
  newTodos: number;
  resolvedTodos: number;
  updatedThreads: number;
}

/**
 * Upsert dash_todos from categorized threads and identified todos.
 * Called by sync-and-refresh endpoint and can be called by CLI tools for backward compat.
 *
 * Logic:
 * 1. For each identified todo → upsert into dash_todos
 * 2. For threads where we replied (lastEmailFromUs) → auto-resolve open todos
 * 3. For existing threads with new emails → update metadata
 */
export async function syncDashTodos(
  threads: CategorizedThread[],
  todos: IdentifiedTodo[]
): Promise<TodoSyncResult> {
  const result: TodoSyncResult = { newTodos: 0, resolvedTodos: 0, updatedThreads: 0 };
  const now = new Date();

  // Build lookup maps
  const todosByThreadKey = new Map<string, IdentifiedTodo>();
  for (const todo of todos) {
    todosByThreadKey.set(todo.threadKey, todo);
  }

  const threadsByKey = new Map<string, CategorizedThread>();
  for (const thread of threads) {
    threadsByKey.set(thread.threadKey, thread);
  }

  // Get all thread keys we need to check
  const allThreadKeys = [...new Set([
    ...threads.map((t) => t.threadKey),
    ...todos.map((t) => t.threadKey),
  ])];

  if (allThreadKeys.length === 0) return result;

  // Fetch existing dash_todos for these thread keys
  const existing = await db
    .select()
    .from(schema.dashTodos)
    .where(inArray(schema.dashTodos.threadKey, allThreadKeys));

  const existingByKey = new Map(existing.map((e) => [e.threadKey, e]));

  // Process each thread
  for (const threadKey of allThreadKeys) {
    const thread = threadsByKey.get(threadKey);
    const todo = todosByThreadKey.get(threadKey);
    const existingTodo = existingByKey.get(threadKey);

    if (existingTodo) {
      // Thread already has a dash_todo entry
      if (existingTodo.status === "open" && thread?.lastEmailFromUs && !todo) {
        // We replied and there's no new todo → auto-resolve
        await db
          .update(schema.dashTodos)
          .set({
            status: "resolved",
            resolvedAt: now,
            resolvedBy: "email_activity",
            lastEmailDate: thread.lastEmailDate,
            emailCount: thread.emailCount,
            lastEmailFromUs: true,
            needsResponse: false,
            updatedAt: now,
          })
          .where(eq(schema.dashTodos.id, existingTodo.id));
        result.resolvedTodos++;
      } else if (thread) {
        // Update metadata (new emails in thread, maybe new summary)
        const updateData: Record<string, unknown> = {
          lastEmailDate: thread.lastEmailDate,
          emailCount: thread.emailCount,
          lastEmailFromUs: thread.lastEmailFromUs,
          needsResponse: thread.needsResponse,
          updatedAt: now,
        };

        // Update summary if AI provided a new one
        if (thread.summary) {
          updateData.summary = thread.summary;
        }

        // If there's a new todo for an already-open item, update type/description
        if (todo && existingTodo.status === "open") {
          updateData.todoType = todo.todoType;
          updateData.description = todo.description;
          if (todo.contactName) updateData.contactName = todo.contactName;
          if (todo.contactEmail) updateData.contactEmail = todo.contactEmail;
        }

        // Update PO details if available
        if (thread.poDetails) {
          updateData.poDetails = thread.poDetails;
        }
        if (thread.isSuspicious) {
          updateData.isSuspicious = true;
        }

        await db
          .update(schema.dashTodos)
          .set(updateData)
          .where(eq(schema.dashTodos.id, existingTodo.id));
        result.updatedThreads++;
      }
    } else if (todo && thread) {
      // New todo — insert into dash_todos
      // Skip if thread is in dismissed_threads (user manually dismissed it before)
      const dismissed = await db
        .select({ id: schema.dismissedThreads.id })
        .from(schema.dismissedThreads)
        .where(eq(schema.dismissedThreads.threadKey, threadKey))
        .limit(1);

      if (dismissed.length > 0) {
        // Already dismissed — insert as dismissed so it doesn't resurface
        await db
          .insert(schema.dashTodos)
          .values({
            threadKey,
            todoType: todo.todoType,
            category: thread.category,
            itemType: thread.itemType,
            contactEmail: todo.contactEmail || thread.contactEmail,
            contactName: todo.contactName || thread.contactName,
            subject: todo.subject || thread.subject,
            summary: thread.summary,
            description: todo.description,
            firstDetectedAt: todo.originalDate || now,
            lastEmailDate: thread.lastEmailDate,
            emailCount: thread.emailCount,
            needsResponse: thread.needsResponse,
            lastEmailFromUs: thread.lastEmailFromUs,
            status: "dismissed",
            resolvedAt: now,
            resolvedBy: "manual",
            poDetails: thread.poDetails,
            isSuspicious: thread.isSuspicious,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        continue;
      }

      await db
        .insert(schema.dashTodos)
        .values({
          threadKey,
          todoType: todo.todoType,
          category: thread.category,
          itemType: thread.itemType,
          contactEmail: todo.contactEmail || thread.contactEmail,
          contactName: todo.contactName || thread.contactName,
          subject: todo.subject || thread.subject,
          summary: thread.summary,
          description: todo.description,
          firstDetectedAt: todo.originalDate || now,
          lastEmailDate: thread.lastEmailDate,
          emailCount: thread.emailCount,
          needsResponse: thread.needsResponse,
          lastEmailFromUs: thread.lastEmailFromUs,
          status: "open",
          poDetails: thread.poDetails,
          isSuspicious: thread.isSuspicious,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing(); // Skip if thread_key already exists (race condition safety)

      result.newTodos++;
    }
  }

  return result;
}

/**
 * Load recent AI corrections for injection into AI prompts.
 * Returns formatted string to append to classification prompt.
 */
export async function loadCorrectionsForPrompt(limit: number = 20): Promise<string> {
  const corrections = await db
    .select({
      threadKey: schema.dashAiCorrections.threadKey,
      fieldCorrected: schema.dashAiCorrections.fieldCorrected,
      originalValue: schema.dashAiCorrections.originalValue,
      correctedValue: schema.dashAiCorrections.correctedValue,
    })
    .from(schema.dashAiCorrections)
    .where(eq(schema.dashAiCorrections.appliedToFuture, true))
    .orderBy(desc(schema.dashAiCorrections.correctedAt))
    .limit(limit);

  if (corrections.length === 0) return "";

  // Also look up subjects for context
  const threadKeys = [...new Set(corrections.map((c) => c.threadKey))];
  const todosWithSubjects = await db
    .select({ threadKey: schema.dashTodos.threadKey, subject: schema.dashTodos.subject })
    .from(schema.dashTodos)
    .where(inArray(schema.dashTodos.threadKey, threadKeys));

  const subjectByKey = new Map(todosWithSubjects.map((t) => [t.threadKey, t.subject]));

  const lines = corrections.map((c) => {
    const subject = subjectByKey.get(c.threadKey) || c.threadKey.slice(0, 40);
    return `- Thread "${subject}" was classified as ${c.fieldCorrected}="${c.originalValue}" but should be ${c.fieldCorrected}="${c.correctedValue}"`;
  });

  return `\nPREVIOUS CORRECTIONS (learn from these):\n${lines.join("\n")}\n`;
}
