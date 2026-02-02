/**
 * CLI Entry Point for QB Sync Alert Checks
 *
 * Usage:
 *   npm run jobs:check              # Hourly check + email
 *   npm run jobs:check --preview    # Show without sending
 *   npm run jobs:check --morning    # Morning review mode
 */

import "dotenv/config";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { syncEmails } from "@/sync/syncer";
import { categorizeThreads } from "@/report/categorizer";
import type { TimeWindow } from "@/report/types";
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
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  return {
    preview: args.includes("--preview"),
    morning: args.includes("--morning"),
  };
}

function printUsage() {
  console.log(`
Usage: npm run jobs:check [options]

Options:
  --preview      Show alerts in console, don't send email
  --morning      Morning review mode (full summary of all open alerts)

Examples:
  npm run jobs:check                    # Run hourly check and send alert email
  npm run jobs:check -- --preview       # Preview alerts in console
  npm run jobs:check -- --morning       # Send morning review email
`);
}

/**
 * Get hourly check window (last 2 hours)
 */
function getHourlyWindow(): TimeWindow {
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 60 * 60 * 1000);
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
 * Run hourly alert check
 */
async function runHourlyCheck(options: CliOptions): Promise<void> {
  console.log("=== QB Sync Hourly Check ===\n");

  // Sync recent emails
  console.log("Syncing emails (last 2 hours)...");
  const syncResult = await syncEmails();
  console.log(`Synced ${syncResult.emailsSynced} emails\n`);

  // Get recent threads
  const window = getHourlyWindow();
  console.log(`Checking emails from ${window.start.toISOString()} to ${window.end.toISOString()}\n`);

  const threads = await categorizeThreads(window);
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
    await sendReportEmail(subject, html, ALERT_RECIPIENT);

    // Mark alerts as notified
    const alertIds = [
      ...result.newAlerts.map((a) => a.id),
      ...result.escalations.map((a) => a.id),
    ];
    await markAlertsNotified(alertIds);

    console.log(`\nAlert email sent.`);
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

  const threads = await categorizeThreads(window);
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
    if (options.morning) {
      await runMorningReview(options);
    } else {
      await runHourlyCheck(options);
    }
    process.exit(0);
  } catch (error) {
    console.error("Alert check failed:", error);
    process.exit(1);
  }
}

main();
