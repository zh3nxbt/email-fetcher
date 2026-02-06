import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, or, sql, inArray } from "drizzle-orm";
import { generateThreadId, normalizeSubject } from "@/sync/threader";
import type { Email } from "@/db/schema";

const OUR_DOMAIN = "masprecisionparts.com";

function isOutbound(email: Email): boolean {
  if (email.mailbox === "Sent" || email.mailbox === "Sent Items" || email.mailbox === "INBOX.Sent" || email.mailbox === "INBOX.Sent Messages") {
    return true;
  }
  if (email.fromAddress?.toLowerCase().includes(OUR_DOMAIN)) {
    return true;
  }
  return false;
}

// GET /api/threads/[threadKey]/emails — Full email thread for popup
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadKey: string }> }
) {
  try {
    const { threadKey: rawThreadKey } = await params;
    const threadKey = decodeURIComponent(rawThreadKey);

    if (!threadKey) {
      return NextResponse.json(
        { error: "threadKey is required" },
        { status: 400 }
      );
    }

    // Look up the dash_todo for context
    const todos = await db
      .select()
      .from(schema.dashTodos)
      .where(eq(schema.dashTodos.threadKey, threadKey));

    const todo = todos[0] ?? null;

    // Find emails belonging to this thread.
    // thread_key is typically a message ID (e.g. <abc@example.com>) or subject:normalized
    // Strategy: find all emails whose generated threadId matches this threadKey
    let threadEmails: Email[] = [];

    if (threadKey.startsWith("subject:")) {
      // Subject-based thread key — match by normalized subject
      const normSubject = threadKey.slice("subject:".length);
      const allEmails = await db.select().from(schema.emails);
      threadEmails = allEmails.filter(
        (e) => normalizeSubject(e.subject) === normSubject
      );
    } else {
      // Message-ID-based thread key — find by references chain
      // Pass 1: find directly related emails
      const directMatches = await db
        .select()
        .from(schema.emails)
        .where(
          or(
            eq(schema.emails.messageId, threadKey),
            eq(schema.emails.inReplyTo, threadKey),
            sql`${schema.emails.references} LIKE ${"%" + threadKey + "%"}`
          )
        );

      if (directMatches.length === 0) {
        // Fall back: try finding via report_threads subject
        if (todo?.subject) {
          const normSubject = normalizeSubject(todo.subject);
          if (normSubject && normSubject.length > 10) {
            const allEmails = await db.select().from(schema.emails);
            threadEmails = allEmails.filter(
              (e) => normalizeSubject(e.subject) === normSubject
            );
          }
        }
      } else {
        // Collect all message IDs for transitive expansion
        const emailMap = new Map<number, Email>();
        const collectedMsgIds = new Set<string>();

        for (const email of directMatches) {
          emailMap.set(email.id, email);
          if (email.messageId) collectedMsgIds.add(email.messageId);
          if (email.inReplyTo) collectedMsgIds.add(email.inReplyTo);
          if (email.references) {
            for (const ref of email.references.split(/\s+/).filter(Boolean)) {
              collectedMsgIds.add(ref);
            }
          }
        }

        // Pass 2: expand transitively using collected message IDs
        const msgIdArray = Array.from(collectedMsgIds);
        if (msgIdArray.length > 0) {
          const expandedConditions = [
            inArray(schema.emails.messageId, msgIdArray),
            inArray(schema.emails.inReplyTo, msgIdArray),
          ];
          for (const msgId of msgIdArray) {
            expandedConditions.push(
              sql`${schema.emails.references} LIKE ${"%" + msgId + "%"}`
            );
          }

          const expanded = await db
            .select()
            .from(schema.emails)
            .where(or(...expandedConditions));

          for (const email of expanded) {
            emailMap.set(email.id, email);
          }
        }

        threadEmails = Array.from(emailMap.values());
      }
    }

    // Sort chronologically
    threadEmails.sort((a, b) => {
      const dateA = a.date?.getTime() || 0;
      const dateB = b.date?.getTime() || 0;
      return dateA - dateB;
    });

    // Format response
    const formattedEmails = threadEmails.map((e) => ({
      id: e.id,
      fromAddress: e.fromAddress,
      fromName: e.fromName,
      toAddresses: e.toAddresses,
      subject: e.subject,
      bodyText: e.bodyText,
      date: e.date,
      isOutbound: isOutbound(e),
      hasAttachments: e.hasAttachments,
      attachments: e.attachments,
    }));

    return NextResponse.json({
      threadKey,
      todo: todo
        ? {
            id: todo.id,
            category: todo.category,
            itemType: todo.itemType,
            todoType: todo.todoType,
            summary: todo.summary,
            status: todo.status,
            aiCorrected: todo.aiCorrected,
            poDetails: todo.poDetails,
          }
        : null,
      emails: formattedEmails,
    });
  } catch (error) {
    console.error("Error fetching thread emails:", error);
    return NextResponse.json(
      { error: "Failed to fetch thread emails" },
      { status: 500 }
    );
  }
}
