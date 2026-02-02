/**
 * Sync Analyzer for QuickBooks Job Sync (Phase 4)
 *
 * Compares email-detected POs with QuickBooks data to identify sync discrepancies.
 * Uses trusted domain filtering to skip suspicious/phishing emails before
 * analyzing PDFs or matching to QB customers.
 *
 * Flow:
 * 1. Filter out untrusted domains (potential phishing)
 * 2. Extract PO details from PDF attachments
 * 3. Match email contact to QB customer
 * 4. Check for matching Sales Order → po_has_so (all good)
 * 5. If no SO, check for matching Estimate → po_no_so_has_estimate
 * 6. If neither → po_no_so_no_estimate
 */

import type { CategorizedThread, PoDetails } from "../report/types.js";
import type { QBEstimate, QBSalesOrder } from "../quickbooks/types.js";
import { getExternalContact } from "../report/categorizer.js";
import {
  getTrustedDomains,
  isDomainTrusted,
  getTrustedDomainsStats,
} from "../quickbooks/trusted-domains.js";
import { ConductorClient } from "../quickbooks/conductor-client.js";
import { createCustomerMatcher, type MatchResult } from "../quickbooks/customer-matcher.js";
import {
  getCustomerJobDocuments,
  findMatchingSalesOrder,
  findMatchingEstimate,
} from "../quickbooks/job-documents.js";
import { analyzeEmailPdfs } from "../report/pdf-extractor.js";

export interface SyncAlert {
  type:
    | "po_has_so" // PO received, matching Sales Order found (all good)
    | "po_no_so_has_estimate" // PO received, no SO but found matching estimate
    | "po_no_so_no_estimate" // PO received, no SO and no matching estimate
    | "no_qb_customer" // Could not match email to QB customer
    | "job_not_invoiced" // Sales Order complete but no invoice
    | "suspicious_po_email"; // PO email from untrusted domain (potential phishing)
  customer: { email: string; name: string | null; qbId?: string };
  poThread?: CategorizedThread;
  salesOrder?: QBSalesOrder;
  estimate?: QBEstimate;
  poDetails?: PoDetails;
  customerMatch?: MatchResult;
  suggestedAction: string;
}

export interface AnalyzeResult {
  processed: CategorizedThread[];
  alerts: SyncAlert[];
}

/**
 * Analyze PO threads and compare with QuickBooks data
 *
 * @param poReceivedThreads - Threads categorized as po_received
 * @returns Analysis results including discrepancies found
 */
export async function analyzePoThreads(
  poReceivedThreads: CategorizedThread[]
): Promise<AnalyzeResult> {
  const result: AnalyzeResult = {
    processed: [],
    alerts: [],
  };

  if (poReceivedThreads.length === 0) {
    return result;
  }

  // Load trusted domains once for all threads
  const trustedDomains = await getTrustedDomains();
  const stats = await getTrustedDomainsStats();
  console.log(
    `Trusted domains: ${stats.totalTrusted} (${stats.fromSentEmails} from sent emails, ${stats.fromManualWhitelist} from whitelist, ${stats.fromQbCustomers} from QB customers)`
  );

  // Initialize QB client and matcher once for all threads
  let client: ConductorClient | null = null;
  let matcher: ReturnType<typeof createCustomerMatcher> | null = null;

  try {
    client = new ConductorClient();
    matcher = createCustomerMatcher(client);
  } catch (error) {
    console.warn("QB client not available, skipping QB matching:", error);
  }

  for (const thread of poReceivedThreads) {
    // Get the external contact (customer who sent the PO)
    const contact = getExternalContact(thread.emails);

    if (!contact.email) {
      // No contact email - flag as suspicious
      result.alerts.push({
        type: "suspicious_po_email",
        customer: { email: "unknown", name: contact.name },
        poThread: thread,
        suggestedAction: "Review manually - no sender email found",
      });
      console.log(
        `Flagged thread "${thread.subject?.slice(0, 40)}...": no contact email`
      );
      continue;
    }

    // Check if domain is trusted before processing
    if (!isDomainTrusted(contact.email, trustedDomains)) {
      const domain = contact.email.split("@")[1];
      result.alerts.push({
        type: "suspicious_po_email",
        customer: { email: contact.email, name: contact.name },
        poThread: thread,
        suggestedAction: `Review manually - domain "${domain}" not in trusted list (may be phishing or new customer)`,
      });
      console.log(`Flagged untrusted domain: ${contact.email}`);
      continue;
    }

    // Domain is trusted - safe to proceed with PDF analysis and QB matching
    result.processed.push(thread);
    console.log(`Processing trusted thread from: ${contact.email}`);

    // Step 1: Extract PO details from PDF attachments (if any)
    let poDetails: PoDetails | null = null;
    const emailWithPdf = thread.emails.find(
      (e) => e.hasAttachments && e.attachments?.toLowerCase().includes("pdf")
    );
    if (emailWithPdf) {
      try {
        console.log(`  Analyzing PDF attachment from email ${emailWithPdf.uid}...`);
        const pdfResults = await analyzeEmailPdfs(emailWithPdf.uid, emailWithPdf.mailbox);
        if (pdfResults.length > 0) {
          poDetails = pdfResults[0].details;
          console.log(
            `  Extracted PO: ${poDetails.poNumber || "N/A"}, Total: ${poDetails.total || "N/A"}`
          );
        }
      } catch (error) {
        console.warn(`  Failed to analyze PDF:`, error);
      }
    }

    // Step 2: Match email contact to QB customer
    if (!client || !matcher) {
      // QB not available - can't do further matching
      console.log(`  Skipping QB matching (client not available)`);
      continue;
    }

    const matchResult = await matcher.match(contact.email, contact.name || undefined);

    if (!matchResult) {
      // Can't match to QB customer - flag as needing attention
      result.alerts.push({
        type: "no_qb_customer",
        customer: { email: contact.email, name: contact.name },
        poThread: thread,
        poDetails: poDetails || undefined,
        suggestedAction: `Add customer to QuickBooks or verify email matches existing customer`,
      });
      console.log(`  No QB customer match for: ${contact.email}`);
      continue;
    }

    console.log(
      `  Matched to QB customer: ${matchResult.customerName} (${matchResult.confidence} confidence)`
    );

    // Step 3: Fetch job documents for this customer
    const docs = await getCustomerJobDocuments(client, matchResult.customerId);
    console.log(
      `  Found ${docs.salesOrders.length} SOs, ${docs.estimates.length} estimates`
    );

    // Step 4: Check for matching Sales Order
    const matchingSO = findMatchingSalesOrder(
      docs,
      poDetails?.poNumber || undefined,
      poDetails?.total || undefined
    );

    if (matchingSO) {
      // All good - PO has corresponding SO
      result.alerts.push({
        type: "po_has_so",
        customer: {
          email: contact.email,
          name: contact.name,
          qbId: matchResult.customerId,
        },
        poThread: thread,
        salesOrder: matchingSO,
        poDetails: poDetails || undefined,
        customerMatch: matchResult,
        suggestedAction: "No action needed - Sales Order exists",
      });
      console.log(`  ✓ Found matching SO: ${matchingSO.refNumber || matchingSO.id}`);
      continue;
    }

    // Step 5: No SO - check for matching Estimate
    const matchingEst = findMatchingEstimate(
      docs,
      poDetails?.poNumber || undefined,
      poDetails?.total || undefined
    );

    if (matchingEst) {
      result.alerts.push({
        type: "po_no_so_has_estimate",
        customer: {
          email: contact.email,
          name: contact.name,
          qbId: matchResult.customerId,
        },
        poThread: thread,
        estimate: matchingEst,
        poDetails: poDetails || undefined,
        customerMatch: matchResult,
        suggestedAction: `Convert Estimate ${matchingEst.refNumber || matchingEst.id} to Sales Order`,
      });
      console.log(`  ⚠ No SO, but found estimate: ${matchingEst.refNumber || matchingEst.id}`);
    } else {
      result.alerts.push({
        type: "po_no_so_no_estimate",
        customer: {
          email: contact.email,
          name: contact.name,
          qbId: matchResult.customerId,
        },
        poThread: thread,
        poDetails: poDetails || undefined,
        customerMatch: matchResult,
        suggestedAction: "Create Sales Order (no matching estimate found)",
      });
      console.log(`  ⚠ No SO and no matching estimate`);
    }
  }

  return result;
}

/**
 * Filter threads to only those from trusted domains
 * Useful for pre-filtering before more expensive operations
 */
export async function filterTrustedThreads(
  threads: CategorizedThread[]
): Promise<{
  trusted: CategorizedThread[];
  untrusted: CategorizedThread[];
}> {
  const trustedDomains = await getTrustedDomains();

  const trusted: CategorizedThread[] = [];
  const untrusted: CategorizedThread[] = [];

  for (const thread of threads) {
    const contact = getExternalContact(thread.emails);

    if (contact.email && isDomainTrusted(contact.email, trustedDomains)) {
      trusted.push(thread);
    } else {
      untrusted.push(thread);
    }
  }

  return { trusted, untrusted };
}

/**
 * Print trusted domain statistics for debugging
 */
export async function printTrustedDomainStats(): Promise<void> {
  const stats = await getTrustedDomainsStats();

  console.log("\n=== Trusted Domains ===");
  console.log(`Total: ${stats.totalTrusted}`);
  console.log(`From sent emails: ${stats.fromSentEmails}`);
  console.log(`From manual whitelist: ${stats.fromManualWhitelist}`);
  console.log("\nDomains:");
  for (const domain of stats.domains) {
    console.log(`  - ${domain}`);
  }
  console.log("");
}
