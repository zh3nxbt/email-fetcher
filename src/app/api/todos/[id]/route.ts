import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

// Mark a todo as resolved by ID
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Check if it's a numeric ID or a "resolve" action
    if (id === "resolve") {
      // Handle resolve by reportId + threadKey
      const body = await request.json();
      const { reportId, threadKey } = body;

      if (!reportId || !threadKey) {
        return NextResponse.json(
          { error: "reportId and threadKey are required" },
          { status: 400 }
        );
      }

      // Find ALL todos with this threadKey (across all reports)
      // This ensures regenerated reports will see this as resolved
      const todos = await db
        .select()
        .from(schema.todoItems)
        .where(eq(schema.todoItems.threadKey, threadKey));

      if (todos.length === 0) {
        return NextResponse.json({ error: "Todo not found" }, { status: 404 });
      }

      // Mark all matching todos as resolved across all reports
      await db
        .update(schema.todoItems)
        .set({
          resolved: true,
          resolvedAt: new Date(),
        })
        .where(eq(schema.todoItems.threadKey, threadKey));

      // Also add to dismissed_threads to persist across report regeneration
      await db
        .insert(schema.dismissedThreads)
        .values({
          threadKey,
          dismissedAt: new Date(),
          reason: "manual",
        })
        .onConflictDoNothing(); // Ignore if already dismissed

      return NextResponse.json({
        success: true,
        resolvedCount: todos.length,
      });
    }

    // Handle resolve by numeric ID
    const todoId = parseInt(id, 10);

    if (isNaN(todoId)) {
      return NextResponse.json({ error: "Invalid todo ID" }, { status: 400 });
    }

    // Get the todo first to verify it exists
    const todos = await db
      .select()
      .from(schema.todoItems)
      .where(eq(schema.todoItems.id, todoId));

    const todo = todos[0];

    if (!todo) {
      return NextResponse.json({ error: "Todo not found" }, { status: 404 });
    }

    // Mark as resolved
    await db
      .update(schema.todoItems)
      .set({
        resolved: true,
        resolvedAt: new Date(),
      })
      .where(eq(schema.todoItems.id, todoId));

    // Also add to dismissed_threads to persist across report regeneration
    await db
      .insert(schema.dismissedThreads)
      .values({
        threadKey: todo.threadKey,
        dismissedAt: new Date(),
        reason: "manual",
      })
      .onConflictDoNothing(); // Ignore if already dismissed

    return NextResponse.json({
      success: true,
      todo: { ...todo, resolved: true, resolvedAt: new Date() },
    });
  } catch (error) {
    console.error("Error updating todo:", error);
    return NextResponse.json(
      { error: "Failed to update todo" },
      { status: 500 }
    );
  }
}
