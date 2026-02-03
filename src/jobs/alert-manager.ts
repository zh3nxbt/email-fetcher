/**
 * Alert Manager for QB Sync Alerts (Phase 6)
 *
 * Handles the 2-stage alert lifecycle:
 * Stage 1 (immediate): po_detected, po_detected_with_so, no_qb_customer, suspicious_po_email
 * Stage 2 (4h escalation): po_missing_so
 *
 * Also handles so_should_be_closed alerts for invoice/SO integrity.
 */

import { db, schema } from "@/db";
import { eq, and, lt, isNull, inArray, sql } from "drizzle-orm";
import type { QbSyncAlert, NewQbSyncAlert, QbSyncAlertType } from "@/db/schema";
import type { CategorizedThread, PoDetails } from "@/report/types.js";
import { ConductorClient } from "@/quickbooks/conductor-client.js";
import { createCustomerMatcher, type MatchResult } from "@/quickbooks/customer-matcher.js";
import {
  getCustomerJobDocuments,
  findMatchingSalesOrder,
  findMatchingEstimate,
} from "@/quickbooks/job-documents.js";
import { findSosShouldBeClosed, findOverbilledMatches } from "@/quickbooks/invoice-so-matcher.js";

const ESCALATION_HOURS = 4;

/**
 * Helper to safely create a ConductorClient
 * Returns null if QB credentials are not available
 */
function getQbClient(): ConductorClient | null {
  try {
    return new ConductorClient();
  } catch (error) {
    console.warn("QB client not available:", error);
    return null;
  }
}

export interface AlertSummary {
  newAlerts: QbSyncAlert[];
  escalations: QbSyncAlert[];
  resolved: QbSyncAlert[];
  openAlerts: QbSyncAlert[];
}

/**
 * Stage 1: Analyze PO threads and create immediate alerts
 *
 * Creates alerts for:
 * - po_detected: New PO, no SO yet
 * - po_detected_with_so: New PO, SO already exists (informational)
 * - no_qb_customer: Can't match to QB customer
 * - suspicious_po_email: Untrusted domain
 */
export async function analyzeNewPoEmails(
  poReceivedThreads: CategorizedThread[]
): Promise<QbSyncAlert[]> {
  const newAlerts: QbSyncAlert[] = [];

  if (poReceivedThreads.length === 0) {
    return newAlerts;
  }

  // Check for existing alerts to avoid duplicates
  const existingAlerts = await db
    .select()
    .from(schema.qbSyncAlerts)
    .where(
      inArray(
        schema.qbSyncAlerts.threadKey,
        poReceivedThreads.map((t) => t.threadKey)
      )
    );

  const existingThreadKeys = new Set(existingAlerts.map((a) => a.threadKey));

  // Initialize QB client and matcher
  const client = getQbClient();
  const matcher = client ? createCustomerMatcher(client) : null;

  for (const thread of poReceivedThreads) {
    // Skip if alert already exists for this thread
    if (existingThreadKeys.has(thread.threadKey)) {
      console.log(`  Alert already exists for thread: ${thread.subject?.slice(0, 40)}...`);
      continue;
    }

    const now = new Date();

    // Base alert data (use pre-populated contact info from thread)
    const baseAlert: Partial<NewQbSyncAlert> = {
      threadKey: thread.threadKey,
      subject: thread.subject,
      contactEmail: thread.contactEmail,
      contactName: thread.contactName,
      detectedAt: now,
      status: "open",
    };

    // Check for suspicious domain (already determined during categorization)
    if (thread.isSuspicious) {
      const alert = await createAlert({
        ...baseAlert,
        alertType: "suspicious_po_email",
      } as NewQbSyncAlert);
      newAlerts.push(alert);
      console.log(`Suspicious: ${thread.contactEmail || "no email"} for "${thread.subject?.slice(0, 40)}..."`);
      continue;
    }

    // Use pre-extracted PO details from categorization
    const poDetails = thread.poDetails;

    // Update base alert with PO details
    if (poDetails) {
      baseAlert.poNumber = poDetails.poNumber;
      baseAlert.poTotal = poDetails.total ? Math.round(poDetails.total * 100) : null;
    }

    // Try to match to QB customer
    if (!client || !matcher) {
      // QB not available - create po_detected alert without QB info
      const alert = await createAlert({
        ...baseAlert,
        alertType: "po_detected",
      } as NewQbSyncAlert);
      newAlerts.push(alert);
      console.log(`PO detected (no QB): ${thread.contactEmail}`);
      continue;
    }

    // Get all customer matches (domain mapping may return multiple)
    const allMatches = await matcher.matchAll(thread.contactEmail!, thread.contactName || undefined);

    if (allMatches.length === 0) {
      const alert = await createAlert({
        ...baseAlert,
        alertType: "no_qb_customer",
      } as NewQbSyncAlert);
      newAlerts.push(alert);
      console.log(`No QB customer match: ${thread.contactEmail}`);
      continue;
    }

    // Check all matched customers for a matching SO
    let matchResult = allMatches[0]; // Default to first match
    let matchingSO: ReturnType<typeof findMatchingSalesOrder> = null;
    let matchingEst: ReturnType<typeof findMatchingEstimate> = null;

    for (const candidate of allMatches) {
      try {
        const docs = await getCustomerJobDocuments(client, candidate.customerId);
        const so = findMatchingSalesOrder(
          docs,
          poDetails?.poNumber || undefined,
          poDetails?.total || undefined
        );

        if (so) {
          // Found a matching SO - use this customer
          matchResult = candidate;
          matchingSO = so;
          break;
        }

        // Track first matching estimate (fallback)
        if (!matchingEst) {
          const est = findMatchingEstimate(
            docs,
            poDetails?.poNumber || undefined,
            poDetails?.total || undefined
          );
          if (est) {
            matchResult = candidate;
            matchingEst = est;
          }
        }
      } catch (error) {
        // Log error but continue checking other customers
        console.error(
          `Failed to fetch docs for customer ${candidate.customerId} (${candidate.customerName}):`,
          error instanceof Error ? error.message : error
        );
        continue;
      }
    }

    // Update with customer match info
    baseAlert.qbCustomerId = matchResult.customerId;
    baseAlert.qbCustomerName = matchResult.customerName;
    baseAlert.matchConfidence = matchResult.confidence;

    if (matchingSO) {
      // PO has corresponding SO - informational alert
      const alert = await createAlert({
        ...baseAlert,
        alertType: "po_detected_with_so",
        salesOrderId: matchingSO.id,
        salesOrderRef: matchingSO.refNumber,
        salesOrderTotal: matchingSO.totalAmount
          ? Math.round(parseFloat(matchingSO.totalAmount) * 100)
          : null,
      } as NewQbSyncAlert);
      newAlerts.push(alert);
      console.log(`PO with SO: ${thread.contactEmail} → SO ${matchingSO.refNumber}`);
      continue;
    }

    if (matchingEst) {
      baseAlert.estimateId = matchingEst.id;
      baseAlert.estimateRef = matchingEst.refNumber;
    }

    // No SO - create po_detected alert (will escalate after 4h)
    const alert = await createAlert({
      ...baseAlert,
      alertType: "po_detected",
    } as NewQbSyncAlert);
    newAlerts.push(alert);
    console.log(
      `PO detected (no SO): ${thread.contactEmail}${matchingEst ? ` (has estimate ${matchingEst.refNumber})` : ""}`
    );
  }

  return newAlerts;
}

/**
 * Stage 2: Check for escalations (4+ hours since detection, still no SO)
 *
 * Converts po_detected → po_missing_so if SO hasn't been created
 */
export async function checkEscalations(): Promise<QbSyncAlert[]> {
  const escalations: QbSyncAlert[] = [];

  // Find po_detected alerts older than ESCALATION_HOURS
  const cutoffTime = new Date(Date.now() - ESCALATION_HOURS * 60 * 60 * 1000);

  const candidateAlerts = await db
    .select()
    .from(schema.qbSyncAlerts)
    .where(
      and(
        eq(schema.qbSyncAlerts.alertType, "po_detected"),
        eq(schema.qbSyncAlerts.status, "open"),
        lt(schema.qbSyncAlerts.detectedAt, cutoffTime),
        isNull(schema.qbSyncAlerts.escalatedAt) // Not already escalated
      )
    );

  if (candidateAlerts.length === 0) {
    return escalations;
  }

  console.log(`Checking ${candidateAlerts.length} alerts for escalation...`);

  // Initialize QB client
  const client = getQbClient();
  if (!client) {
    // Escalate all candidates without re-checking QB (conservative - better to alert than miss)
    console.warn(`Escalating ${candidateAlerts.length} alerts without QB verification`);
    for (const alert of candidateAlerts) {
      const escalated = await escalateAlert(alert);
      if (escalated) {
        escalations.push(escalated);
      }
    }
    return escalations;
  }

  // Batch fetch documents by customer ID to avoid N+1 queries
  const customerIds = [...new Set(
    candidateAlerts
      .map((a) => a.qbCustomerId)
      .filter((id): id is string => id !== null)
  )];

  const allDocs = new Map<string, Awaited<ReturnType<typeof getCustomerJobDocuments>>>();
  for (const customerId of customerIds) {
    const docs = await getCustomerJobDocuments(client, customerId);
    allDocs.set(customerId, docs);
  }

  for (const alert of candidateAlerts) {
    if (!alert.qbCustomerId) {
      // Can't check QB without customer ID - escalate anyway
      const escalated = await escalateAlert(alert);
      if (escalated) {
        escalations.push(escalated);
      }
      continue;
    }

    // Use pre-fetched documents
    const docs = allDocs.get(alert.qbCustomerId);
    if (!docs) {
      // Shouldn't happen, but escalate to be safe
      const escalated = await escalateAlert(alert);
      if (escalated) {
        escalations.push(escalated);
      }
      continue;
    }

    const matchingSO = findMatchingSalesOrder(
      docs,
      alert.poNumber || undefined,
      alert.poTotal ? alert.poTotal / 100 : undefined
    );

    if (matchingSO) {
      // SO now exists - resolve the alert instead of escalating
      await resolveAlert(alert.id, "auto");
      console.log(`Alert ${alert.id} resolved: SO ${matchingSO.refNumber} found`);
    } else {
      // Still no SO - escalate
      const escalated = await escalateAlert(alert);
      if (escalated) {
        escalations.push(escalated);
        console.log(`Alert ${alert.id} escalated: still no SO after ${ESCALATION_HOURS}h`);
      }
    }
  }

  return escalations;
}

/**
 * Check for SOs that should be closed (fully invoiced but still open)
 */
export async function checkInvoiceSoMismatch(): Promise<QbSyncAlert[]> {
  const alerts: QbSyncAlert[] = [];

  // Get unique QB customer IDs from recent po_detected_with_so alerts
  const recentAlerts = await db
    .select()
    .from(schema.qbSyncAlerts)
    .where(
      and(
        eq(schema.qbSyncAlerts.alertType, "po_detected_with_so"),
        eq(schema.qbSyncAlerts.status, "open")
      )
    );

  const customerIds = [...new Set(recentAlerts.map((a) => a.qbCustomerId).filter(Boolean))] as string[];

  if (customerIds.length === 0) {
    return alerts;
  }

  const client = getQbClient();
  if (!client) {
    return alerts;
  }

  for (const customerId of customerIds) {
    const docs = await getCustomerJobDocuments(client, customerId, { includeFullyInvoiced: true });

    // Use PO# + total matching to find SOs that should be closed
    const sosShouldClose = findSosShouldBeClosed(docs.salesOrders, docs.invoices);

    for (const match of sosShouldClose) {
      // Check if alert already exists
      const existing = await db
        .select()
        .from(schema.qbSyncAlerts)
        .where(
          and(
            eq(schema.qbSyncAlerts.alertType, "so_should_be_closed"),
            eq(schema.qbSyncAlerts.salesOrderId, match.salesOrder.id)
          )
        );

      if (existing.length > 0) {
        continue;
      }

      const alert = await createAlert({
        alertType: "so_should_be_closed",
        threadKey: `so_${match.salesOrder.id}`,
        subject: `SO ${match.salesOrder.refNumber} should be closed`,
        qbCustomerId: customerId,
        qbCustomerName: docs.customerName,
        salesOrderId: match.salesOrder.id,
        salesOrderRef: match.salesOrder.refNumber,
        salesOrderTotal: match.salesOrder.totalAmount
          ? Math.round(parseFloat(match.salesOrder.totalAmount) * 100)
          : null,
        invoiceId: match.invoice.id,
        invoiceRef: match.invoice.refNumber,
        invoiceTotal: match.invoice.totalAmount
          ? Math.round(parseFloat(match.invoice.totalAmount) * 100)
          : null,
        detectedAt: new Date(),
        status: "open",
      });

      alerts.push(alert);
      console.log(
        `SO should be closed: ${match.salesOrder.refNumber} (Invoice ${match.invoice.refNumber})`
      );
    }
  }

  return alerts;
}

/**
 * Auto-resolve alerts when SO/customer is added
 */
export async function checkAndResolveAlerts(): Promise<QbSyncAlert[]> {
  const resolved: QbSyncAlert[] = [];

  const client = getQbClient();
  if (!client) {
    return resolved;
  }

  // Check po_detected and po_missing_so alerts
  const poAlerts = await db
    .select()
    .from(schema.qbSyncAlerts)
    .where(
      and(
        inArray(schema.qbSyncAlerts.alertType, ["po_detected", "po_missing_so"]),
        eq(schema.qbSyncAlerts.status, "open")
      )
    );

  for (const alert of poAlerts) {
    if (!alert.qbCustomerId) continue;

    const docs = await getCustomerJobDocuments(client, alert.qbCustomerId);
    const matchingSO = findMatchingSalesOrder(
      docs,
      alert.poNumber || undefined,
      alert.poTotal ? alert.poTotal / 100 : undefined
    );

    if (matchingSO) {
      await resolveAlert(alert.id, "auto");
      resolved.push({ ...alert, status: "resolved" });
      console.log(`Auto-resolved alert ${alert.id}: SO ${matchingSO.refNumber} found`);
    }
  }

  // Check no_qb_customer alerts
  const noCustomerAlerts = await db
    .select()
    .from(schema.qbSyncAlerts)
    .where(
      and(
        eq(schema.qbSyncAlerts.alertType, "no_qb_customer"),
        eq(schema.qbSyncAlerts.status, "open")
      )
    );

  const matcher = createCustomerMatcher(client);

  for (const alert of noCustomerAlerts) {
    if (!alert.contactEmail) continue;

    const matchResult = await matcher.match(alert.contactEmail, alert.contactName || undefined);

    if (matchResult) {
      await resolveAlert(alert.id, "auto");
      resolved.push({ ...alert, status: "resolved" });
      console.log(
        `Auto-resolved alert ${alert.id}: customer ${matchResult.customerName} found`
      );
    }
  }

  return resolved;
}

/**
 * Get all open alerts (for display/notification)
 */
export async function getOpenAlerts(): Promise<QbSyncAlert[]> {
  return db
    .select()
    .from(schema.qbSyncAlerts)
    .where(eq(schema.qbSyncAlerts.status, "open"));
}

/**
 * Get actionable alerts (open, not yet notified today)
 */
export async function getActionableAlerts(): Promise<QbSyncAlert[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return db
    .select()
    .from(schema.qbSyncAlerts)
    .where(
      and(
        eq(schema.qbSyncAlerts.status, "open"),
        // Either never notified or notified before today
        isNull(schema.qbSyncAlerts.lastNotifiedAt)
      )
    );
}

/**
 * Get summary for morning review
 */
export async function getOpenAlertsSummary(): Promise<{
  poDetected: QbSyncAlert[];
  poWithSo: QbSyncAlert[];
  poMissingSo: QbSyncAlert[];
  noQbCustomer: QbSyncAlert[];
  suspiciousEmail: QbSyncAlert[];
  soShouldBeClosed: QbSyncAlert[];
}> {
  const openAlerts = await getOpenAlerts();

  return {
    poDetected: openAlerts.filter((a) => a.alertType === "po_detected"),
    poWithSo: openAlerts.filter((a) => a.alertType === "po_detected_with_so"),
    poMissingSo: openAlerts.filter((a) => a.alertType === "po_missing_so"),
    noQbCustomer: openAlerts.filter((a) => a.alertType === "no_qb_customer"),
    suspiciousEmail: openAlerts.filter((a) => a.alertType === "suspicious_po_email"),
    soShouldBeClosed: openAlerts.filter((a) => a.alertType === "so_should_be_closed"),
  };
}

/**
 * Mark alerts as notified
 */
export async function markAlertsNotified(alertIds: number[]): Promise<void> {
  if (alertIds.length === 0) return;

  const now = new Date();
  await db
    .update(schema.qbSyncAlerts)
    .set({
      lastNotifiedAt: now,
      notificationCount: sql`${schema.qbSyncAlerts.notificationCount} + 1`,
    })
    .where(inArray(schema.qbSyncAlerts.id, alertIds));
}

/**
 * Run full alert check (all stages)
 */
export async function runFullAlertCheck(
  poReceivedThreads: CategorizedThread[]
): Promise<AlertSummary> {
  console.log("\n=== Running QB Sync Alert Check ===\n");

  let newAlerts: QbSyncAlert[] = [];
  let escalations: QbSyncAlert[] = [];
  let resolved: QbSyncAlert[] = [];
  let soAlerts: QbSyncAlert[] = [];

  // Stage 1: Analyze new PO emails
  try {
    console.log("Stage 1: Analyzing new PO emails...");
    newAlerts = await analyzeNewPoEmails(poReceivedThreads);
    console.log(`  Created ${newAlerts.length} new alerts`);
  } catch (error) {
    console.error("Stage 1 failed:", error);
  }

  // Stage 2: Check for escalations
  try {
    console.log("\nStage 2: Checking for escalations...");
    escalations = await checkEscalations();
    console.log(`  Escalated ${escalations.length} alerts`);
  } catch (error) {
    console.error("Stage 2 failed:", error);
  }

  // Stage 3: Check for auto-resolution
  try {
    console.log("\nChecking for auto-resolution...");
    resolved = await checkAndResolveAlerts();
    console.log(`  Resolved ${resolved.length} alerts`);
  } catch (error) {
    console.error("Stage 3 failed:", error);
  }

  // Stage 4: Check for SO/Invoice mismatches
  try {
    console.log("\nChecking for SO/Invoice mismatches...");
    soAlerts = await checkInvoiceSoMismatch();
    console.log(`  Found ${soAlerts.length} SOs that should be closed`);
  } catch (error) {
    console.error("Stage 4 failed:", error);
  }

  // Get all open alerts
  const openAlerts = await getOpenAlerts();

  return {
    newAlerts: [...newAlerts, ...soAlerts],
    escalations,
    resolved,
    openAlerts,
  };
}

// Helper functions

async function createAlert(data: NewQbSyncAlert): Promise<QbSyncAlert> {
  const [alert] = await db.insert(schema.qbSyncAlerts).values(data).returning();
  return alert;
}

async function escalateAlert(alert: QbSyncAlert): Promise<QbSyncAlert | null> {
  const now = new Date();

  // Optimistic locking: only update if version matches (prevents duplicate escalations)
  const [updated] = await db
    .update(schema.qbSyncAlerts)
    .set({
      alertType: "po_missing_so",
      escalatedAt: now,
      version: sql`${schema.qbSyncAlerts.version} + 1`,
    })
    .where(
      and(
        eq(schema.qbSyncAlerts.id, alert.id),
        eq(schema.qbSyncAlerts.version, alert.version ?? 1),
        isNull(schema.qbSyncAlerts.escalatedAt) // Extra safety: not already escalated
      )
    )
    .returning();

  if (!updated) {
    console.log(`Alert ${alert.id} already modified by another process, skipping escalation`);
    return null;
  }

  return updated;
}

async function resolveAlert(alertId: number, by: "auto" | "manual"): Promise<void> {
  const now = new Date();
  await db
    .update(schema.qbSyncAlerts)
    .set({
      status: "resolved",
      resolvedAt: now,
      resolvedBy: by,
    })
    .where(eq(schema.qbSyncAlerts.id, alertId));
}

export async function dismissAlert(alertId: number): Promise<void> {
  const now = new Date();
  await db
    .update(schema.qbSyncAlerts)
    .set({
      status: "dismissed",
      resolvedAt: now,
      resolvedBy: "manual",
    })
    .where(eq(schema.qbSyncAlerts.id, alertId));
}
