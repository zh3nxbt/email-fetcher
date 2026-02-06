import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, or, ilike, desc, asc, sql, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

// GET /api/todos — List dash_todos with filters, sorting, pagination
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "open";
    const category = url.searchParams.get("category");
    const itemType = url.searchParams.get("itemType");
    const todoType = url.searchParams.get("todoType");
    const search = url.searchParams.get("search");
    const sortBy = url.searchParams.get("sortBy") || "date";
    const sortOrder = url.searchParams.get("sortOrder") || "desc";
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

    // Build WHERE conditions
    const conditions: SQL[] = [];

    if (status && status !== "all") {
      conditions.push(eq(schema.dashTodos.status, status as "open" | "resolved" | "dismissed"));
    }
    if (category) {
      conditions.push(eq(schema.dashTodos.category, category as "customer" | "vendor" | "other"));
    }
    if (itemType) {
      conditions.push(eq(schema.dashTodos.itemType, itemType as "po_sent" | "po_received" | "quote_request" | "general" | "other"));
    }
    if (todoType) {
      conditions.push(eq(schema.dashTodos.todoType, todoType as "po_unacknowledged" | "quote_unanswered" | "general_unanswered" | "vendor_followup"));
    }
    if (search) {
      conditions.push(
        or(
          ilike(schema.dashTodos.subject, `%${search}%`),
          ilike(schema.dashTodos.contactName, `%${search}%`),
          ilike(schema.dashTodos.contactEmail, `%${search}%`)
        )!
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Determine sort column
    let orderByClause;
    const isDesc = sortOrder === "desc";
    switch (sortBy) {
      case "priority":
        // Priority order: po_unacknowledged > quote_unanswered > general_unanswered > vendor_followup
        orderByClause = isDesc
          ? desc(schema.dashTodos.todoType)
          : asc(schema.dashTodos.todoType);
        break;
      case "contact":
        orderByClause = isDesc
          ? desc(schema.dashTodos.contactName)
          : asc(schema.dashTodos.contactName);
        break;
      case "category":
        orderByClause = isDesc
          ? desc(schema.dashTodos.category)
          : asc(schema.dashTodos.category);
        break;
      case "date":
      default:
        orderByClause = isDesc
          ? desc(schema.dashTodos.firstDetectedAt)
          : asc(schema.dashTodos.firstDetectedAt);
        break;
    }

    // Execute main query and count query in parallel
    const [todos, countResult, filterCounts] = await Promise.all([
      db
        .select()
        .from(schema.dashTodos)
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(limit)
        .offset(offset),

      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.dashTodos)
        .where(whereClause),

      // Filter counts — always scoped to status filter only (so counts update as you filter)
      db.select({
        category: schema.dashTodos.category,
        itemType: schema.dashTodos.itemType,
        todoType: schema.dashTodos.todoType,
        cnt: sql<number>`count(*)::int`,
      })
        .from(schema.dashTodos)
        .where(status && status !== "all" ? eq(schema.dashTodos.status, status as "open" | "resolved" | "dismissed") : undefined)
        .groupBy(schema.dashTodos.category, schema.dashTodos.itemType, schema.dashTodos.todoType),
    ]);

    // Aggregate filter counts into friendly format
    const categories: Record<string, number> = {};
    const todoTypes: Record<string, number> = {};
    const itemTypes: Record<string, number> = {};

    for (const row of filterCounts) {
      categories[row.category] = (categories[row.category] || 0) + row.cnt;
      todoTypes[row.todoType] = (todoTypes[row.todoType] || 0) + row.cnt;
      itemTypes[row.itemType] = (itemTypes[row.itemType] || 0) + row.cnt;
    }

    return NextResponse.json({
      todos,
      total: countResult[0]?.count ?? 0,
      filters: { categories, todoTypes, itemTypes },
    });
  } catch (error) {
    console.error("Error fetching todos:", error);
    return NextResponse.json(
      { error: "Failed to fetch todos" },
      { status: 500 }
    );
  }
}

// POST /api/todos — Bulk resolve or dismiss
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, threadKeys } = body;

    if (!action || !["resolve", "dismiss"].includes(action)) {
      return NextResponse.json(
        { error: "action must be 'resolve' or 'dismiss'" },
        { status: 400 }
      );
    }
    if (!Array.isArray(threadKeys) || threadKeys.length === 0) {
      return NextResponse.json(
        { error: "threadKeys must be a non-empty array" },
        { status: 400 }
      );
    }

    const now = new Date();
    const newStatus = action === "resolve" ? "resolved" : "dismissed";

    // Update dash_todos
    const updated = await db
      .update(schema.dashTodos)
      .set({
        status: newStatus as "resolved" | "dismissed",
        resolvedAt: now,
        resolvedBy: "manual",
        updatedAt: now,
      })
      .where(
        and(
          inArray(schema.dashTodos.threadKey, threadKeys),
          eq(schema.dashTodos.status, "open")
        )
      )
      .returning({ threadKey: schema.dashTodos.threadKey });

    // For dismiss: also insert into email_dismissed_threads for backward compat
    if (action === "dismiss" && updated.length > 0) {
      for (const { threadKey } of updated) {
        await db
          .insert(schema.dismissedThreads)
          .values({
            threadKey,
            dismissedAt: now,
            reason: "manual",
          })
          .onConflictDoNothing();
      }
    }

    // For resolve: also mark legacy email_todo_items as resolved
    if (updated.length > 0) {
      const updatedKeys = updated.map((r) => r.threadKey);
      await db
        .update(schema.todoItems)
        .set({ resolved: true, resolvedAt: now })
        .where(inArray(schema.todoItems.threadKey, updatedKeys));
    }

    return NextResponse.json({
      success: true,
      updatedCount: updated.length,
    });
  } catch (error) {
    console.error("Error bulk updating todos:", error);
    return NextResponse.json(
      { error: "Failed to update todos" },
      { status: 500 }
    );
  }
}
