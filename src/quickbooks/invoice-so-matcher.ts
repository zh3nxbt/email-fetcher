/**
 * Invoice-Sales Order Matcher
 *
 * Matches invoices to sales orders using simple PO# + total comparison.
 * No LLM needed - O(n×m) comparisons instead of O(n×m) API calls.
 */

import type { QBSalesOrder, QBInvoice } from "./types.js";

export interface SimpleMatchResult {
  salesOrder: QBSalesOrder;
  invoice: QBInvoice;
  isMatch: boolean;
  matchType: "full" | "partial" | "overbilled" | "none";
  matchReason: "linked" | "refNumber" | "amount";
  soTotal: number;
  invoiceTotal: number;
  difference: number; // positive = under-billed, negative = over-billed
}

/**
 * Normalize a reference number for comparison
 * Removes common prefixes (PO, SO, INV), whitespace, dashes, and lowercases
 */
function normalizeRef(ref: string | undefined): string {
  if (!ref) return "";
  return ref
    .toLowerCase()
    .replace(/^(po|so|inv|invoice|sales order)[\s#:-]*/i, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Check if two references match (normalized comparison)
 */
function refsMatch(ref1: string | undefined, ref2: string | undefined): boolean {
  const norm1 = normalizeRef(ref1);
  const norm2 = normalizeRef(ref2);
  if (!norm1 || !norm2) return false;
  return norm1 === norm2 || norm1.includes(norm2) || norm2.includes(norm1);
}

/**
 * Match invoices to sales orders using simple comparisons
 *
 * Matching priority:
 * 1. linkedTransactions - Invoice explicitly links to SO
 * 2. refNumber/memo match - Same PO number referenced
 * 3. Total amount match - Same total within tolerance
 */
export function matchByPoNumber(
  salesOrders: QBSalesOrder[],
  invoices: QBInvoice[]
): SimpleMatchResult[] {
  const matches: SimpleMatchResult[] = [];
  const matchedSoIds = new Set<string>();

  // Pass 1: Match by linkedTransactions (most reliable)
  for (const invoice of invoices) {
    if (!invoice.linkedTransactions) continue;

    for (const linked of invoice.linkedTransactions) {
      if (linked.transactionType === "qbd_sales_order" || linked.transactionType === "SalesOrder") {
        const so = salesOrders.find((s) => s.id === linked.id);
        if (so && !matchedSoIds.has(so.id)) {
          const soTotal = parseFloat(so.totalAmount || "0");
          const invTotal = parseFloat(invoice.totalAmount || "0");
          const diff = soTotal - invTotal;

          matches.push({
            salesOrder: so,
            invoice,
            isMatch: true,
            matchType: getMatchType(soTotal, invTotal),
            matchReason: "linked",
            soTotal,
            invoiceTotal: invTotal,
            difference: diff,
          });
          matchedSoIds.add(so.id);
        }
      }
    }
  }

  // Pass 2: Match by refNumber/memo (PO number)
  for (const so of salesOrders) {
    if (matchedSoIds.has(so.id)) continue;

    const soRefs = [so.refNumber, so.memo].filter(Boolean);

    for (const invoice of invoices) {
      const invRefs = [invoice.refNumber, invoice.memo].filter(Boolean);

      // Check if any ref matches
      const hasRefMatch = soRefs.some((soRef) =>
        invRefs.some((invRef) => refsMatch(soRef, invRef))
      );

      if (hasRefMatch) {
        const soTotal = parseFloat(so.totalAmount || "0");
        const invTotal = parseFloat(invoice.totalAmount || "0");
        const diff = soTotal - invTotal;

        matches.push({
          salesOrder: so,
          invoice,
          isMatch: true,
          matchType: getMatchType(soTotal, invTotal),
          matchReason: "refNumber",
          soTotal,
          invoiceTotal: invTotal,
          difference: diff,
        });
        matchedSoIds.add(so.id);
        break; // Only one match per SO
      }
    }
  }

  return matches;
}

/**
 * Determine match type based on totals
 */
function getMatchType(soTotal: number, invTotal: number): "full" | "partial" | "overbilled" {
  const diff = soTotal - invTotal;

  // Full match: within $0.01 or 0.1%
  if (Math.abs(diff) < 0.01 || Math.abs(diff / soTotal) < 0.001) {
    return "full";
  }

  // Partial: invoice < SO
  if (diff > 0) {
    return "partial";
  }

  // Overbilled: invoice > SO
  return "overbilled";
}

/**
 * Find sales orders that should be closed based on invoice matching
 *
 * Returns SOs where:
 * - SO is open (not manually closed, not marked fully invoiced)
 * - A matching invoice exists that covers the full SO amount
 */
export function findSosShouldBeClosed(
  salesOrders: QBSalesOrder[],
  invoices: QBInvoice[]
): SimpleMatchResult[] {
  // Only check open sales orders
  const openSOs = salesOrders.filter((so) => !so.isManuallyClosed && !so.isFullyInvoiced);

  if (openSOs.length === 0) {
    return [];
  }

  const matches = matchByPoNumber(openSOs, invoices);

  // Return fully invoiced SOs that should be closed
  return matches.filter((m) => m.matchType === "full");
}

/**
 * Find overbilled matches (invoice total > SO total)
 * These may indicate a pricing error
 */
export function findOverbilledMatches(
  salesOrders: QBSalesOrder[],
  invoices: QBInvoice[]
): SimpleMatchResult[] {
  const matches = matchByPoNumber(salesOrders, invoices);
  return matches.filter((m) => m.matchType === "overbilled");
}
