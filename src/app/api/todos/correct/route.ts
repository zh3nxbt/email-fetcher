import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import type { Category, ItemType, TodoType } from "@/db/schema";

// Recalculate todoType based on category + itemType
function deriveTodoType(category: Category, itemType: ItemType): TodoType {
  if (category === "customer") {
    if (itemType === "po_received") return "po_unacknowledged";
    if (itemType === "quote_request") return "quote_unanswered";
    return "general_unanswered";
  }
  // vendor or other
  return "vendor_followup";
}

// POST /api/todos/correct — Record AI correction and update dash_todo
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { threadKey, corrections } = body;

    if (!threadKey || !corrections || typeof corrections !== "object") {
      return NextResponse.json(
        { error: "threadKey and corrections object are required" },
        { status: 400 }
      );
    }

    // Look up the current dash_todo
    const todos = await db
      .select()
      .from(schema.dashTodos)
      .where(eq(schema.dashTodos.threadKey, threadKey));

    const todo = todos[0];
    if (!todo) {
      return NextResponse.json(
        { error: "Todo not found for this threadKey" },
        { status: 404 }
      );
    }

    const now = new Date();
    const correctedFields: string[] = [];

    // Map field names to current values
    const currentValues: Record<string, string> = {
      category: todo.category,
      itemType: todo.itemType,
      needsResponse: String(todo.needsResponse ?? true),
      contactName: todo.contactName || "",
    };

    // Insert one correction row per changed field
    for (const [field, newValue] of Object.entries(corrections)) {
      const originalValue = currentValues[field];
      if (originalValue === undefined || String(newValue) === originalValue) {
        continue; // Skip unchanged or unknown fields
      }

      await db.insert(schema.dashAiCorrections).values({
        threadKey,
        fieldCorrected: field,
        originalValue,
        correctedValue: String(newValue),
        correctedBy: "user",
        correctedAt: now,
        appliedToFuture: true,
      });

      correctedFields.push(field);
    }

    if (correctedFields.length === 0) {
      return NextResponse.json({
        success: true,
        correctedFields: [],
        message: "No fields changed",
      });
    }

    // Build the update object for dash_todos
    const updateData: Record<string, unknown> = {
      aiCorrected: true,
      updatedAt: now,
    };

    // Store original values before overwriting (only first correction keeps originals)
    if (!todo.aiCorrected) {
      if (corrections.category) {
        updateData.originalCategory = todo.category;
      }
      if (corrections.itemType) {
        updateData.originalItemType = todo.itemType;
      }
    }

    // Apply the corrections
    if (corrections.category) {
      updateData.category = corrections.category;
    }
    if (corrections.itemType) {
      updateData.itemType = corrections.itemType;
    }
    if (corrections.needsResponse !== undefined) {
      updateData.needsResponse = corrections.needsResponse;
    }
    if (corrections.contactName !== undefined) {
      updateData.contactName = corrections.contactName;
    }

    // Recalculate todoType if category or itemType changed
    const newCategory = (corrections.category || todo.category) as Category;
    const newItemType = (corrections.itemType || todo.itemType) as ItemType;
    const newTodoType = deriveTodoType(newCategory, newItemType);

    if (newTodoType !== todo.todoType) {
      updateData.todoType = newTodoType;
    }

    // Update dash_todos
    await db
      .update(schema.dashTodos)
      .set(updateData)
      .where(eq(schema.dashTodos.threadKey, threadKey));

    // Also update email_report_threads for backward compat (latest report entry)
    if (corrections.category || corrections.itemType) {
      const rtUpdate: Record<string, unknown> = {};
      if (corrections.category) rtUpdate.category = corrections.category;
      if (corrections.itemType) rtUpdate.itemType = corrections.itemType;

      await db
        .update(schema.reportThreads)
        .set(rtUpdate)
        .where(eq(schema.reportThreads.threadKey, threadKey));
    }

    return NextResponse.json({
      success: true,
      correctedFields,
      newTodoType,
    });
  } catch (error) {
    console.error("Error correcting todo:", error);
    return NextResponse.json(
      { error: "Failed to save correction" },
      { status: 500 }
    );
  }
}
