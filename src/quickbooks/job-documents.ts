/**
 * Job Documents Organizer
 *
 * Provides a unified view of customer job documents (Sales Orders, Invoices, Estimates)
 * to trace the job lifecycle:
 *   Email PO received → Sales Order exists? → If not, find matching Estimate → Eventually Invoiced?
 *
 * Sales Orders are the PRIMARY source of truth for confirmed jobs.
 * Estimates are only used as fallback when a PO has no corresponding Sales Order.
 */

import type { ConductorClient } from "./conductor-client.js";
import type { QBEstimate, QBSalesOrder, QBInvoice } from "./types.js";

// ============================================================
// Types
// ============================================================

export interface CustomerJobDocuments {
  customerId: string;
  customerName: string;
  salesOrders: QBSalesOrder[];
  invoices: QBInvoice[];
  estimates: QBEstimate[]; // Fallback only - used when no SO matches a PO
}

export interface GetJobDocumentsOptions {
  /** Only fetch documents updated after this date */
  since?: Date;
  /** Include fully invoiced sales orders (default: false) */
  includeFullyInvoiced?: boolean;
  /** Include paid invoices (default: true) */
  includePaidInvoices?: boolean;
}

// ============================================================
// Main Function
// ============================================================

/**
 * Get all job-related documents for a customer
 *
 * Fetches sales orders, invoices, and estimates in parallel.
 * Sales Orders are the primary reference; estimates are fallback only.
 */
export async function getCustomerJobDocuments(
  client: ConductorClient,
  customerId: string,
  options: GetJobDocumentsOptions = {}
): Promise<CustomerJobDocuments> {
  const { since, includeFullyInvoiced = false, includePaidInvoices = true } = options;

  // Format date for API if provided
  const updatedAfter = since?.toISOString();

  // Fetch all document types in parallel
  const [salesOrders, invoices, estimates, customer] = await Promise.all([
    client.getSalesOrdersForCustomer(customerId, {
      updatedAfter,
      includeFullyInvoiced,
    }),
    client.getInvoicesForCustomer(customerId, {
      updatedAfter,
      unpaidOnly: !includePaidInvoices,
    }),
    client.getEstimatesForCustomer(customerId, { updatedAfter }),
    client.getCustomer(customerId),
  ]);

  return {
    customerId,
    customerName: customer.fullName || customer.name,
    salesOrders,
    invoices,
    estimates,
  };
}

// ============================================================
// Shared Matching Helper
// ============================================================

interface DocumentWithRefAndAmount {
  refNumber?: string | null;
  memo?: string | null;
  totalAmount?: string | null;
}

/**
 * Match a document by PO number or amount
 * Shared logic for findMatchingSalesOrder and findMatchingEstimate
 *
 * PO matching rules:
 * - PO# must be at least 3 chars to match
 * - Exact match: "PO123" matches ref "PO123"
 * - Prefix match with letter suffix: "123" matches "123A", "123B"
 * - Prevents false positives like "PO 1" matching "PO 10"
 */
function matchByPoOrAmount<T extends DocumentWithRefAndAmount>(
  documents: T[],
  poNumber?: string,
  poAmount?: number
): T | null {
  for (const doc of documents) {
    // Match by PO number in ref or memo
    if (poNumber) {
      const poNorm = poNumber.toLowerCase().replace(/[^a-z0-9]/g, "");

      // Require minimum length to prevent overly broad matches
      if (poNorm.length >= 3) {
        const refNorm = (doc.refNumber || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const memoNorm = (doc.memo || "").toLowerCase().replace(/[^a-z0-9]/g, "");

        // Exact match
        if (refNorm === poNorm || memoNorm === poNorm) {
          return doc;
        }

        // Prefix match: PO# followed by a single letter suffix (e.g., "123" matches "123a")
        // This handles cases where SO has suffix like "PO123-A" or "PO123R1"
        const prefixPattern = new RegExp(`^${poNorm}[a-z]$`);
        if (prefixPattern.test(refNorm) || prefixPattern.test(memoNorm)) {
          return doc;
        }

        // Also check if ref/memo starts with PO# and has revision suffix like "-R1", "-REV1"
        const revisionPattern = new RegExp(`^${poNorm}(r|rev)?\\d*$`);
        if (revisionPattern.test(refNorm) || revisionPattern.test(memoNorm)) {
          return doc;
        }
      }
    }

    // Match by amount (within 5% tolerance for base amount, or within tax range)
    if (poAmount && doc.totalAmount) {
      const docAmount = parseFloat(doc.totalAmount);
      const baseTolerance = poAmount * 0.05;

      // Check base tolerance (5%)
      if (Math.abs(docAmount - poAmount) <= baseTolerance) {
        return doc;
      }

      // Also check if doc amount is within tax range (13% HST typical for Ontario)
      // This handles cases where PO is pre-tax and SO/Invoice is post-tax
      const taxTolerance = poAmount * 0.15; // Up to 15% for tax + minor adjustments
      if (docAmount > poAmount && docAmount <= poAmount * 1.15) {
        return doc;
      }
    }
  }

  return null;
}

// ============================================================
// Sales Order Helpers (Primary)
// ============================================================

/**
 * Find a sales order that might match a PO
 * Matches by ref number similarity or amount
 */
export function findMatchingSalesOrder(
  docs: CustomerJobDocuments,
  poNumber?: string,
  poAmount?: number
): QBSalesOrder | null {
  return matchByPoOrAmount(docs.salesOrders, poNumber, poAmount);
}

// ============================================================
// Estimate Helpers (Fallback)
// ============================================================

/**
 * Find an estimate that might match a PO (when no Sales Order exists)
 * Only used as fallback - the alert would be "PO received, no SO, found estimate"
 */
export function findMatchingEstimate(
  docs: CustomerJobDocuments,
  poNumber?: string,
  poAmount?: number
): QBEstimate | null {
  return matchByPoOrAmount(docs.estimates, poNumber, poAmount);
}

// ============================================================
// Internal Helpers (used by getJobDocumentsSummary)
// ============================================================

/**
 * Get open sales orders (not fully invoiced, not manually closed)
 */
function getOpenSalesOrders(docs: CustomerJobDocuments): QBSalesOrder[] {
  return docs.salesOrders.filter((so) => !so.isFullyInvoiced && !so.isManuallyClosed);
}

/**
 * Get unpaid invoices
 */
function getUnpaidInvoices(docs: CustomerJobDocuments): QBInvoice[] {
  return docs.invoices.filter((inv) => !inv.isPaid);
}

// ============================================================
// Summary
// ============================================================

export interface JobDocumentsSummary {
  totalSalesOrders: number;
  openSalesOrders: number;
  totalInvoices: number;
  unpaidInvoices: number;
  totalEstimates: number; // For reference only
}

/**
 * Get summary statistics for customer job documents
 */
export function getJobDocumentsSummary(docs: CustomerJobDocuments): JobDocumentsSummary {
  return {
    totalSalesOrders: docs.salesOrders.length,
    openSalesOrders: getOpenSalesOrders(docs).length,
    totalInvoices: docs.invoices.length,
    unpaidInvoices: getUnpaidInvoices(docs).length,
    totalEstimates: docs.estimates.length,
  };
}
