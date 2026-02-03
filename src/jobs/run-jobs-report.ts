/**
 * CLI Entry Point for QB Sync Alert Checks
 *
 * Usage:
 *   npm run jobs:check                       # Hourly check + email
 *   npm run jobs:check --preview             # Show without sending
 *   npm run jobs:check --morning             # Morning review mode
 *   npm run jobs:check --since=2025-01-01    # Historical check from date
 */

import "dotenv/config";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

const JOBS_CHECK_KEY = "_jobs_check"; // Special key in email_sync_metadata
const JOBS_LOCK_KEY = 839271; // Advisory lock to prevent concurrent jobs:check runs
import { syncEmails } from "@/sync/syncer";
import { categorizeThreads } from "@/report/categorizer";
import type { TimeWindow, CategorizedThread } from "@/report/types";
import { sendReportEmail } from "@/report/email-sender";
import {
  runFullAlertCheck,
  getOpenAlertsSummary,
  markAlertsNotified,
} from "./alert-manager";
import {
  generateHourlyAlertHtml,
  generateMorningReviewHtml,
  generatePlainTextSummary,
} from "./alert-templates";

const TIMEZONE = process.env.REPORT_TIMEZONE || "America/New_York";
const ALERT_RECIPIENT = process.env.ALERT_RECIPIENT || process.env.REPORT_RECIPIENT;

interface CliOptions {
  preview: boolean;
  morning: boolean;
  since: Date | null;
  reanalyze: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);

  // Parse --since=YYYY-MM-DD
  let since: Date | null = null;
  const sinceArg = args.find((a) => a.startsWith("--since="));
  if (sinceArg) {
    const dateStr = sinceArg.split("=")[1];
    // Add time to avoid timezone issues (noon EST)
    since = new Date(`${dateStr}T12:00:00`);
    if (isNaN(since.getTime())) {
      console.error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD`);
      process.exit(1);
    }
  }

  return {
    preview: args.includes("--preview"),
    morning: args.includes("--morning"),
    since,
    reanalyze: args.includes("--reanalyze"),
  };
}

function printUsage() {
  console.log(`
Usage: npm run jobs:check [options]

Options:
  --preview           Show alerts in console, don't send email
  --morning           Morning review mode (full summary of all open alerts)
  --since=YYYY-MM-DD  Check all POs from specified date to today
  --reanalyze         Force re-analysis of all threads (bypass cache)

Examples:
  npm run jobs:check                         # Check from last run to now (incremental)
  npm run jobs:check -- --preview            # Preview alerts in console
  npm run jobs:check -- --morning            # Send morning review email
  npm run jobs:check -- --since=2025-01-01   # Check all POs from Jan 1 to today
  npm run jobs:check -- --since=2025-01-01 --preview  # Preview historical check
  npm run jobs:check -- --reanalyze          # Re-analyze all threads with AI

Note: The default check uses incremental timestamps stored in email_sync_metadata.
      First run falls back to 2 hours. Subsequent runs pick up from last checkpoint.
`);
}

/**
 * Get last job check timestamp from database
 * Returns null if never run before
 */
async function getLastJobCheckTime(): Promise<Date | null> {
  const result = await db
    .select({ lastSyncAt: schema.syncMetadata.lastSyncAt })
    .from(schema.syncMetadata)
    .where(eq(schema.syncMetadata.mailbox, JOBS_CHECK_KEY));

  return result.length > 0 ? result[0].lastSyncAt : null;
}

/**
 * Save current timestamp as last job check time
 */
async function saveJobCheckTime(timestamp: Date): Promise<void> {
  const existing = await db
    .select({ id: schema.syncMetadata.id })
    .from(schema.syncMetadata)
    .where(eq(schema.syncMetadata.mailbox, JOBS_CHECK_KEY));

  if (existing.length > 0) {
    await db
      .update(schema.syncMetadata)
      .set({ lastSyncAt: timestamp })
      .where(eq(schema.syncMetadata.mailbox, JOBS_CHECK_KEY));
  } else {
    await db.insert(schema.syncMetadata).values({
      mailbox: JOBS_CHECK_KEY,
      lastSyncAt: timestamp,
    });
  }
}

/**
 * Run a task under a Postgres advisory lock.
 * Prevents concurrent jobs:check runs from creating duplicate alerts/emails.
 */
async function withJobsLock(task: () => Promise<void>): Promise<void> {
  const result = await db.execute(sql`SELECT pg_try_advisory_lock(${JOBS_LOCK_KEY}) AS locked`);
  const locked = Boolean((result as unknown as Array<{ locked: boolean }>)[0]?.locked);

  if (!locked) {
    console.warn("Another jobs:check process is already running. Skipping this run.");
    return;
  }

  try {
    await task();
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${JOBS_LOCK_KEY})`);
  }
}

/**
 * Get hourly check window (from last check to now)
 * Falls back to 2 hours if no previous check recorded
 */
async function getHourlyWindow(): Promise<TimeWindow> {
  const now = new Date();
  const lastCheck = await getLastJobCheckTime();

  // Fall back to 2 hours if never run before
  const start = lastCheck || new Date(now.getTime() - 2 * 60 * 60 * 1000);

  return { start, end: now };
}

/**
 * Get overnight window (4pm yesterday to now)
 */
function getOvernightWindow(): TimeWindow {
  const now = new Date();
  const zonedNow = toZonedTime(now, TIMEZONE);

  // Start at 4pm yesterday
  const startZoned = new Date(zonedNow);
  startZoned.setDate(startZoned.getDate() - 1);
  startZoned.setHours(16, 0, 0, 0);

  return {
    start: fromZonedTime(startZoned, TIMEZONE),
    end: now,
  };
}

/**
 * Save categorized threads to database for future reference
 * Creates a "sync_check" report entry to link threads to
 * Deduplicates: replaces existing sync_check for the same date
 *
 * Note: Uses window.start for the date intentionally - this groups
 * historical checks by their start date for proper filtering
 */
async function saveCategorizedThreads(
  threads: CategorizedThread[],
  window: TimeWindow
): Promise<number> {
  const dateStr = window.start.toISOString().split("T")[0];

  // DELETE existing sync_check for this date (prevents duplicates on re-run)
  const existing = await db
    .select({ id: schema.dailyReports.id })
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportDate, dateStr),
        eq(schema.dailyReports.reportType, "sync_check")
      )
    );

  if (existing.length > 0) {
    console.log(`Replacing existing sync_check report for ${dateStr}`);
    for (const old of existing) {
      // report_threads will cascade delete due to FK constraint
      await db.delete(schema.dailyReports).where(eq(schema.dailyReports.id, old.id));
    }
  }

  // Create a minimal report entry to link threads
  const [report] = await db
    .insert(schema.dailyReports)
    .values({
      reportDate: dateStr,
      reportType: "sync_check", // Dedicated type to avoid conflicts with daily reports
      emailsReceived: threads.filter((t) => !t.lastEmailFromUs).length,
      emailsSent: threads.filter((t) => t.lastEmailFromUs).length,
      generatedAt: new Date(),
      reportHtml: `<p>Historical sync check from ${window.start.toISOString()} to ${window.end.toISOString()}</p>`,
    })
    .returning({ id: schema.dailyReports.id });

  // Save all threads in one insert (faster for historical runs)
  const threadRows = threads.map((thread) => ({
      reportId: report.id,
      threadKey: thread.threadKey,
      category: thread.category,
      itemType: thread.itemType,
      contactEmail: thread.contactEmail,
      contactName: thread.contactName,
      subject: thread.subject,
      summary: thread.summary,
      emailCount: thread.emailCount,
      lastEmailDate: thread.lastEmailDate,
    }));

  if (threadRows.length > 0) {
    await db.insert(schema.reportThreads).values(threadRows);
  }

  console.log(`Saved ${threads.length} categorized threads to report_threads (report ID: ${report.id})`);
  return report.id;
}

/**
 * Run historical check from a specific date
 */
async function runHistoricalCheck(options: CliOptions): Promise<void> {
  const sinceDate = options.since!;
  const now = new Date();

  console.log("=== QB Sync Historical Check ===\n");
  console.log(`Checking all POs from ${sinceDate.toLocaleDateString()} to today\n`);

  // Sync emails (will skip duplicates automatically)
  console.log("Syncing emails (skipping duplicates)...");
  const syncResult = await syncEmails();
  console.log(`Synced ${syncResult.emailsSynced} new emails\n`);

  // Get all threads in the date range
  const window: TimeWindow = { start: sinceDate, end: now };
  console.log(`Analyzing threads from ${window.start.toISOString()} to ${window.end.toISOString()}\n`);

  const threads = await categorizeThreads(window, { reanalyze: options.reanalyze });

  // Save all categorized threads to database
  await saveCategorizedThreads(threads, window);

  const poReceivedThreads = threads.filter((t) => t.itemType === "po_received");
  console.log(`Found ${poReceivedThreads.length} po_received threads in date range\n`);

  if (poReceivedThreads.length === 0) {
    console.log("No PO emails found in the specified date range.");
    return;
  }

  // Run full alert check on all POs
  const result = await runFullAlertCheck(poReceivedThreads);

  console.log("\n=== Historical Check Summary ===");
  console.log(`Total POs analyzed: ${poReceivedThreads.length}`);
  console.log(`New alerts created: ${result.newAlerts.length}`);
  console.log(`Escalations: ${result.escalations.length}`);
  console.log(`Auto-resolved: ${result.resolved.length}`);
  console.log(`Total open alerts: ${result.openAlerts.length}`);

  // Get full summary for the report
  const summary = await getOpenAlertsSummary();

  if (options.preview) {
    // Print detailed summary to console
    console.log("\n" + generatePlainTextSummary(summary));
  } else {
    // Send comprehensive email report
    const html = generateMorningReviewHtml(summary);
    const dateRange = `${sinceDate.toLocaleDateString("en-US", {
      timeZone: TIMEZONE,
      month: "short",
      day: "numeric",
    })} - ${now.toLocaleDateString("en-US", {
      timeZone: TIMEZONE,
      month: "short",
      day: "numeric",
    })}`;

    const subject = `QB Sync Report - ${dateRange} (${poReceivedThreads.length} POs)`;
    await sendReportEmail(subject, html, ALERT_RECIPIENT);

    // Mark all alerts as notified
    const alertIds = [
      ...summary.poDetected.map((a) => a.id),
      ...summary.poMissingSo.map((a) => a.id),
      ...summary.noQbCustomer.map((a) => a.id),
      ...summary.suspiciousEmail.map((a) => a.id),
      ...summary.soShouldBeClosed.map((a) => a.id),
    ];
    await markAlertsNotified(alertIds);

    console.log(`\nHistorical report email sent to ${ALERT_RECIPIENT}`);
  }
}

/**
 * Run hourly alert check
 */
async function runHourlyCheck(options: CliOptions): Promise<void> {
  console.log("=== QB Sync Hourly Check ===\n");

  // Get window first to show what we're checking
  const window = await getHourlyWindow();
  const lastCheckInfo = window.start.getTime() < Date.now() - 2 * 60 * 60 * 1000
    ? `(from last check: ${window.start.toLocaleString("en-US", { timeZone: TIMEZONE })})`
    : "(first run, using 2h fallback)";
  console.log(`Time window: ${window.start.toISOString()} to ${window.end.toISOString()}`);
  console.log(`${lastCheckInfo}\n`);

  // Sync recent emails
  console.log("Syncing emails...");
  const syncResult = await syncEmails();
  console.log(`Synced ${syncResult.emailsSynced} emails\n`);

  const threads = await categorizeThreads(window, { reanalyze: options.reanalyze });
  const poReceivedThreads = threads.filter((t) => t.itemType === "po_received");
  console.log(`Found ${poReceivedThreads.length} po_received threads\n`);

  // Run full alert check
  const result = await runFullAlertCheck(poReceivedThreads);

  console.log("\n=== Summary ===");
  console.log(`New alerts: ${result.newAlerts.length}`);
  console.log(`Escalations: ${result.escalations.length}`);
  console.log(`Auto-resolved: ${result.resolved.length}`);
  console.log(`Total open: ${result.openAlerts.length}`);

  // Generate email if there are alerts to report
  const hasContent =
    result.newAlerts.length > 0 ||
    result.escalations.length > 0 ||
    result.resolved.length > 0;

  if (!hasContent) {
    console.log("\nNo new activity to report.");
    // Save checkpoint even with no activity (but not in preview mode)
    if (!options.preview) {
      await saveJobCheckTime(window.end);
    }
    return;
  }

  const html = generateHourlyAlertHtml({
    newAlerts: result.newAlerts,
    escalations: result.escalations,
    resolved: result.resolved,
  });

  if (options.preview) {
    // Print summary to console
    const summary = await getOpenAlertsSummary();
    console.log(generatePlainTextSummary(summary));
  } else {
    // Send email
    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      timeZone: TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const subject = `QB Sync Alert - ${timeStr}`;

    // IMPORTANT: Only save checkpoint AFTER email is confirmed sent
    // This prevents lost alerts if SMTP fails mid-send
    try {
      await sendReportEmail(subject, html, ALERT_RECIPIENT);

      // Mark alerts as notified
      const alertIds = [
        ...result.newAlerts.map((a) => a.id),
        ...result.escalations.map((a) => a.id),
      ];
      await markAlertsNotified(alertIds);

      // Save checkpoint timestamp for next run (only after email succeeds)
      await saveJobCheckTime(window.end);
      console.log(`\nAlert email sent.`);
    } catch (emailError) {
      console.error("Email failed - NOT saving checkpoint to allow retry on next run:", emailError);
      throw emailError;
    }
  }
}

/**
 * Run morning review
 */
async function runMorningReview(options: CliOptions): Promise<void> {
  console.log("=== QB Sync Morning Review ===\n");

  // Sync overnight emails
  console.log("Syncing overnight emails...");
  const syncResult = await syncEmails();
  console.log(`Synced ${syncResult.emailsSynced} emails\n`);

  // Get overnight threads for new alerts
  const window = getOvernightWindow();
  console.log(`Checking emails from ${window.start.toISOString()} to ${window.end.toISOString()}\n`);

  const threads = await categorizeThreads(window, { reanalyze: options.reanalyze });
  const poReceivedThreads = threads.filter((t) => t.itemType === "po_received");
  console.log(`Found ${poReceivedThreads.length} po_received threads\n`);

  // Run full alert check (creates new alerts, escalates old ones, resolves)
  await runFullAlertCheck(poReceivedThreads);

  // Get full summary of all open alerts
  const summary = await getOpenAlertsSummary();

  const totalOpen =
    summary.poDetected.length +
    summary.poMissingSo.length +
    summary.noQbCustomer.length +
    summary.suspiciousEmail.length +
    summary.soShouldBeClosed.length;

  console.log("\n=== Morning Summary ===");
  console.log(`Overdue (no SO): ${summary.poMissingSo.length}`);
  console.log(`Pending (awaiting SO): ${summary.poDetected.length}`);
  console.log(`With SO (all good): ${summary.poWithSo.length}`);
  console.log(`Unknown customer: ${summary.noQbCustomer.length}`);
  console.log(`Suspicious: ${summary.suspiciousEmail.length}`);
  console.log(`SO should close: ${summary.soShouldBeClosed.length}`);
  console.log(`Total open: ${totalOpen}`);

  if (options.preview) {
    // Print summary to console
    console.log(generatePlainTextSummary(summary));
  } else {
    // Send morning review email
    const html = generateMorningReviewHtml(summary);
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      timeZone: TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
    });

    const subject = `QB Sync Morning Review - ${dateStr}`;
    await sendReportEmail(subject, html, ALERT_RECIPIENT);

    // Mark all open alerts as notified
    const alertIds = [
      ...summary.poDetected.map((a) => a.id),
      ...summary.poMissingSo.map((a) => a.id),
      ...summary.noQbCustomer.map((a) => a.id),
      ...summary.suspiciousEmail.map((a) => a.id),
      ...summary.soShouldBeClosed.map((a) => a.id),
    ];
    await markAlertsNotified(alertIds);

    console.log(`\nMorning review email sent.`);
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const options = parseArgs();

  try {
    await withJobsLock(async () => {
      if (options.since) {
        await runHistoricalCheck(options);
      } else if (options.morning) {
        await runMorningReview(options);
      } else {
        await runHourlyCheck(options);
      }
    });
    process.exit(0);
  } catch (error) {
    console.error("Alert check failed:", error);
    process.exit(1);
  }
}

main();
