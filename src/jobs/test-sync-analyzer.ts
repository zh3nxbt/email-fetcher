/**
 * Test script for Sync Analyzer
 *
 * Loads recent po_received threads from the database and runs them through
 * the sync analyzer to verify QB matching and alert generation.
 *
 * Usage: npm run qb:sync-analyze
 */

import "dotenv/config";
import { db } from "../db/index.js";
import { reportThreads, dailyReports, emails } from "../db/schema.js";
import { desc, eq, and, inArray } from "drizzle-orm";
import type { CategorizedThread, PoDetails } from "../report/types.js";
import type { Email } from "../db/schema.js";
import { analyzePoThreads, printTrustedDomainStats } from "./sync-analyzer.js";
import { getCacheStats } from "../quickbooks/customer-cache.js";

/**
 * Get recent po_received threads from database
 * Reconstructs CategorizedThread objects from stored report threads
 */
async function getRecentPoReceivedThreads(limit = 10): Promise<CategorizedThread[]> {
  // Get most recent report with po_received threads
  const recentThreads = await db
    .select()
    .from(reportThreads)
    .innerJoin(dailyReports, eq(reportThreads.reportId, dailyReports.id))
    .where(eq(reportThreads.itemType, "po_received"))
    .orderBy(desc(dailyReports.reportDate))
    .limit(limit);

  if (recentThreads.length === 0) {
    return [];
  }

  // Get the emails for these threads
  const threadKeys = recentThreads.map((t) => t.email_report_threads.threadKey);
  const threadEmails = await db
    .select()
    .from(emails)
    .where(
      inArray(
        emails.subject,
        threadKeys.map((tk) => {
          // ThreadKey is typically the normalized subject
          // We need to find emails with matching subject
          return tk;
        })
      )
    );

  // Group emails by normalized subject (threadKey)
  const emailsByThread = new Map<string, Email[]>();
  for (const email of threadEmails) {
    const subject = email.subject || "";
    // Normalize subject to match threadKey
    const normalizedSubject = subject
      .replace(/^(RE:|FW:|FWD:)\s*/gi, "")
      .trim()
      .toLowerCase();

    if (!emailsByThread.has(normalizedSubject)) {
      emailsByThread.set(normalizedSubject, []);
    }
    emailsByThread.get(normalizedSubject)!.push(email);
  }

  // Build CategorizedThread objects
  const result: CategorizedThread[] = [];
  for (const row of recentThreads) {
    const thread = row.email_report_threads;
    const threadEmails = emailsByThread.get(thread.threadKey) || [];

    // Sort emails by date
    threadEmails.sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return dateA - dateB;
    });

    result.push({
      threadKey: thread.threadKey,
      emails: threadEmails,
      category: thread.category,
      itemType: thread.itemType,
      contactEmail: thread.contactEmail,
      contactName: thread.contactName,
      subject: thread.subject || "",
      summary: thread.summary,
      emailCount: thread.emailCount,
      lastEmailDate: thread.lastEmailDate,
      lastEmailFromUs: thread.lastEmailFromUs || false,
      needsResponse: !thread.lastEmailFromUs, // Assume needs response if last email not from us
      isNewThread: false,
      poDetails: thread.poDetails as PoDetails | null,
    });
  }

  return result;
}

async function main() {
  console.log("=== Sync Analyzer Test ===\n");

  // Show cache stats
  console.log("QB Customer Cache:");
  const cacheStats = getCacheStats();
  if (cacheStats.exists) {
    console.log(`  Customers: ${cacheStats.customerCount}`);
    console.log(`  Age: ${cacheStats.ageHours} hours`);
    console.log(`  Stale: ${cacheStats.isStale}`);
  } else {
    console.log("  No cache (will be created on first run)");
  }
  console.log("");

  // Show trusted domain stats
  await printTrustedDomainStats();

  // Load recent po_received threads
  console.log("Loading recent po_received threads...");
  const threads = await getRecentPoReceivedThreads(5);

  if (threads.length === 0) {
    console.log("No po_received threads found in database.");
    console.log("Run a report first to populate the database.");
    process.exit(0);
  }

  console.log(`Found ${threads.length} threads to analyze:\n`);
  for (const thread of threads) {
    console.log(`  - ${thread.subject?.slice(0, 60)}...`);
    console.log(`    Contact: ${thread.contactEmail || "unknown"}`);
    console.log(`    Emails: ${thread.emailCount}`);
  }
  console.log("");

  // Run analysis
  console.log("=== Running Analysis ===\n");
  const result = await analyzePoThreads(threads);

  // Show results
  console.log("\n=== Results ===\n");
  console.log(`Processed: ${result.processed.length} threads`);
  console.log(`Alerts: ${result.alerts.length}\n`);

  // Group alerts by type
  const alertsByType = new Map<string, typeof result.alerts>();
  for (const alert of result.alerts) {
    if (!alertsByType.has(alert.type)) {
      alertsByType.set(alert.type, []);
    }
    alertsByType.get(alert.type)!.push(alert);
  }

  // Display alerts
  for (const [type, alerts] of alertsByType) {
    console.log(`\n${type} (${alerts.length}):`);
    for (const alert of alerts) {
      console.log(`  - Customer: ${alert.customer.email}`);
      console.log(`    Subject: ${alert.poThread?.subject?.slice(0, 50) || "N/A"}...`);
      console.log(`    Action: ${alert.suggestedAction}`);
      if (alert.salesOrder) {
        console.log(`    SO: ${alert.salesOrder.refNumber || alert.salesOrder.id}`);
      }
      if (alert.estimate) {
        console.log(`    Estimate: ${alert.estimate.refNumber || alert.estimate.id}`);
      }
      if (alert.poDetails?.poNumber) {
        console.log(`    PO#: ${alert.poDetails.poNumber}`);
      }
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
