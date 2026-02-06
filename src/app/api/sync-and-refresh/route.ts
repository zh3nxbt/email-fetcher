import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { desc } from "drizzle-orm";
import { syncEmails } from "@/sync/syncer";
import { categorizeThreads } from "@/report/categorizer";
import { identifyTodos } from "@/report/todo-analyzer";
import { syncDashTodos } from "@/dashboard/todo-sync";
import type { TimeWindow } from "@/report/types";

// Default lookback window when no sync history exists (2 hours)
const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/**
 * Determine the time window for categorization.
 * Uses the most recent sync time across all mailboxes as the start.
 * Falls back to 2 hours ago if no sync history exists.
 */
async function getTimeWindow(): Promise<TimeWindow> {
  const now = new Date();

  // Get the most recent sync time from any mailbox
  const syncMeta = await db
    .select({ lastSyncAt: schema.syncMetadata.lastSyncAt })
    .from(schema.syncMetadata)
    .orderBy(desc(schema.syncMetadata.lastSyncAt))
    .limit(1);

  let start: Date;
  if (syncMeta.length > 0 && syncMeta[0].lastSyncAt) {
    // Use last sync time, but go back at least 30 minutes for overlap
    const lastSync = syncMeta[0].lastSyncAt;
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
    start = lastSync < thirtyMinAgo ? lastSync : thirtyMinAgo;
  } else {
    start = new Date(now.getTime() - DEFAULT_LOOKBACK_MS);
  }

  return { start, end: now };
}

// POST /api/sync-and-refresh — Sync emails + categorize + populate dash_todos
export async function POST() {
  try {
    // Step 1: Sync emails from IMAP
    console.log("[sync-and-refresh] Syncing emails from IMAP...");
    const syncResult = await syncEmails();
    console.log(`[sync-and-refresh] Synced ${syncResult.emailsSynced} emails`);

    // Step 2: Determine time window
    const window = await getTimeWindow();
    console.log(`[sync-and-refresh] Time window: ${window.start.toISOString()} → ${window.end.toISOString()}`);

    // Step 3: Categorize threads in window
    console.log("[sync-and-refresh] Categorizing threads...");
    const threads = await categorizeThreads(window);
    console.log(`[sync-and-refresh] Categorized ${threads.length} threads`);

    // Step 4: Identify todos from categorized threads
    const todos = identifyTodos(threads);
    console.log(`[sync-and-refresh] Identified ${todos.length} new action items`);

    // Step 5: Upsert into dash_todos
    console.log("[sync-and-refresh] Syncing to dash_todos...");
    const todoResult = await syncDashTodos(threads, todos);
    console.log(`[sync-and-refresh] Result: ${todoResult.newTodos} new, ${todoResult.resolvedTodos} resolved, ${todoResult.updatedThreads} updated`);

    return NextResponse.json({
      success: true,
      emailsSynced: syncResult.emailsSynced,
      threadsAnalyzed: threads.length,
      newTodos: todoResult.newTodos,
      resolvedTodos: todoResult.resolvedTodos,
      updatedThreads: todoResult.updatedThreads,
    });
  } catch (error) {
    console.error("[sync-and-refresh] Error:", error);
    return NextResponse.json(
      { error: "Sync and refresh failed", details: String(error) },
      { status: 500 }
    );
  }
}
