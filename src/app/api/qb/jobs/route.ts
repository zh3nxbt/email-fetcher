import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { ConductorClient } from "@/quickbooks/conductor-client";
import type { QBSalesOrder, QBInvoice } from "@/quickbooks/types";
import type { QbSyncAlert } from "@/db/schema";

// Server-side cache (5 min TTL)
let cachedResult: { data: unknown; cachedAt: Date } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface EnrichedJob {
  salesOrder: {
    id: string;
    refNumber: string | null;
    customerName: string;
    customerId: string;
    transactionDate: string;
    totalAmount: number;
    isManuallyClosed: boolean;
    isFullyInvoiced: boolean;
    lineCount: number;
  };
  emailPo: {
    threadKey: string;
    poNumber: string | null;
    poTotal: number | null;
    contactEmail: string | null;
    receivedDate: string | null;
  } | null;
  invoices: {
    refNumber: string | null;
    totalAmount: number;
    isPaid: boolean;
  }[];
  alerts: {
    id: number;
    alertType: string;
    status: string;
    detectedAt: string;
  }[];
  ageInDays: number;
  invoicedAmount: number;
  invoicedPercent: number;
}

function daysBetween(dateStr: string): number {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

// GET /api/qb/jobs — Active Sales Orders enriched with email/alert data
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const refresh = url.searchParams.get("refresh") === "true";
    const search = url.searchParams.get("search")?.toLowerCase();
    const alertType = url.searchParams.get("alertType");

    // Check cache
    if (!refresh && cachedResult && (Date.now() - cachedResult.cachedAt.getTime()) < CACHE_TTL_MS) {
      let jobs = (cachedResult.data as { jobs: EnrichedJob[] }).jobs;
      // Apply client-side filters on cached data
      if (search) {
        jobs = jobs.filter((j) =>
          j.salesOrder.customerName.toLowerCase().includes(search) ||
          (j.salesOrder.refNumber?.toLowerCase().includes(search)) ||
          (j.emailPo?.poNumber?.toLowerCase().includes(search))
        );
      }
      if (alertType) {
        jobs = jobs.filter((j) => j.alerts.some((a) => a.alertType === alertType && a.status === "open"));
      }

      return NextResponse.json({
        ...(cachedResult.data as object),
        jobs,
        cachedAt: cachedResult.cachedAt,
      });
    }

    // Initialize QB client
    let client: ConductorClient;
    try {
      client = new ConductorClient();
    } catch {
      return NextResponse.json(
        { error: "QuickBooks not configured (missing CONDUCTOR_API_KEY or CONDUCTOR_END_USER_ID)" },
        { status: 503 }
      );
    }

    // Fetch all open Sales Orders (paginated)
    const allSalesOrders: QBSalesOrder[] = [];
    let cursor: string | undefined;
    let page = 0;
    const maxPages = 20;

    do {
      const params: Record<string, string | number> = { limit: 150 };
      if (cursor) params.cursor = cursor;

      const response = await client.getSalesOrders(params);
      if (response.data) {
        // Filter: only non-closed, non-fully-invoiced SOs
        const active = response.data.filter((so) => !so.isManuallyClosed);
        allSalesOrders.push(...active);
      }
      cursor = response.nextCursor;
      page++;
    } while (cursor && page < maxPages);

    // Fetch invoices (last 180 days to cover active jobs)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 180);
    const allInvoices: QBInvoice[] = [];
    cursor = undefined;
    page = 0;

    do {
      const params: Record<string, string | number> = {
        limit: 150,
        transactionDateFrom: sixMonthsAgo.toISOString().split("T")[0],
      };
      if (cursor) params.cursor = cursor;

      const response = await client.getInvoices(params);
      if (response.data) {
        allInvoices.push(...response.data);
      }
      cursor = response.nextCursor;
      page++;
    } while (cursor && page < maxPages);

    // Build invoice-to-SO mapping via linkedTransactions
    const invoicesBySoId = new Map<string, QBInvoice[]>();
    for (const inv of allInvoices) {
      if (inv.linkedTransactions) {
        for (const link of inv.linkedTransactions) {
          if (link.transactionType === "qbd_sales_order" || link.transactionType === "SalesOrder") {
            const existing = invoicesBySoId.get(link.id) || [];
            existing.push(inv);
            invoicesBySoId.set(link.id, existing);
          }
        }
      }
    }

    // Fetch all alerts from local DB
    const alerts = await db
      .select()
      .from(schema.qbSyncAlerts);

    // Build alert-to-SO mapping
    const alertsBySoId = new Map<string, QbSyncAlert[]>();
    const alertsByThreadKey = new Map<string, QbSyncAlert[]>();
    for (const alert of alerts) {
      if (alert.salesOrderId) {
        const existing = alertsBySoId.get(alert.salesOrderId) || [];
        existing.push(alert);
        alertsBySoId.set(alert.salesOrderId, existing);
      }
      const existing = alertsByThreadKey.get(alert.threadKey) || [];
      existing.push(alert);
      alertsByThreadKey.set(alert.threadKey, existing);
    }

    // Fetch PO data from alerts (they store poNumber, contactEmail, etc.)
    // Also check email_po_attachments for enriched PO info
    const threadKeysWithPo = alerts
      .filter((a) => a.poNumber)
      .map((a) => a.threadKey);

    const poAttachments = threadKeysWithPo.length > 0
      ? await db
          .select()
          .from(schema.poAttachments)
          .where(inArray(schema.poAttachments.threadKey, threadKeysWithPo))
      : [];

    const poByThreadKey = new Map(poAttachments.map((p) => [p.threadKey, p]));

    // Build enriched jobs
    const jobs: EnrichedJob[] = allSalesOrders.map((so) => {
      const soInvoices = invoicesBySoId.get(so.id) || [];
      const soAlerts = alertsBySoId.get(so.id) || [];

      // Find PO linked via alerts (by SO id or by customer match)
      const linkedAlert = soAlerts.find((a) => a.poNumber) ||
        alerts.find((a) => a.salesOrderId === so.id && a.poNumber);

      let emailPo: EnrichedJob["emailPo"] = null;
      if (linkedAlert) {
        const poAtt = poByThreadKey.get(linkedAlert.threadKey);
        emailPo = {
          threadKey: linkedAlert.threadKey,
          poNumber: linkedAlert.poNumber,
          poTotal: linkedAlert.poTotal ? linkedAlert.poTotal / 100 : null, // cents → dollars
          contactEmail: linkedAlert.contactEmail,
          receivedDate: linkedAlert.detectedAt?.toISOString() || null,
        };
      }

      const invoicedAmount = soInvoices.reduce((sum, inv) => sum + parseFloat(inv.totalAmount || "0"), 0);
      const soTotal = parseFloat(so.totalAmount || "0");
      const invoicedPercent = soTotal > 0 ? Math.round((invoicedAmount / soTotal) * 1000) / 10 : 0;

      return {
        salesOrder: {
          id: so.id,
          refNumber: so.refNumber || null,
          customerName: so.customer?.fullName || so.customer?.name || "Unknown",
          customerId: so.customer?.id || "",
          transactionDate: so.transactionDate,
          totalAmount: soTotal,
          isManuallyClosed: so.isManuallyClosed,
          isFullyInvoiced: so.isFullyInvoiced,
          lineCount: so.lines?.length || 0,
        },
        emailPo,
        invoices: soInvoices.map((inv) => ({
          refNumber: inv.refNumber || null,
          totalAmount: parseFloat(inv.totalAmount || "0"),
          isPaid: inv.isPaid,
        })),
        alerts: soAlerts.map((a) => ({
          id: a.id,
          alertType: a.alertType,
          status: a.status,
          detectedAt: a.detectedAt?.toISOString() || "",
        })),
        ageInDays: daysBetween(so.transactionDate),
        invoicedAmount,
        invoicedPercent,
      };
    });

    // Summary stats
    const summary = {
      totalJobs: jobs.length,
      overdueJobs: jobs.filter((j) => j.ageInDays > 45).length,
      uninvoicedJobs: jobs.filter((j) => j.invoicedPercent === 0).length,
      totalValue: jobs.reduce((sum, j) => sum + j.salesOrder.totalAmount, 0),
    };

    // Apply filters
    let filteredJobs = jobs;
    if (search) {
      filteredJobs = filteredJobs.filter((j) =>
        j.salesOrder.customerName.toLowerCase().includes(search) ||
        (j.salesOrder.refNumber?.toLowerCase().includes(search)) ||
        (j.emailPo?.poNumber?.toLowerCase().includes(search))
      );
    }
    if (alertType) {
      filteredJobs = filteredJobs.filter((j) =>
        j.alerts.some((a) => a.alertType === alertType && a.status === "open")
      );
    }

    const responseData = { jobs: filteredJobs, summary, cachedAt: new Date() };

    // Cache the full (unfiltered) result
    cachedResult = { data: { jobs, summary }, cachedAt: new Date() };

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Error fetching QB jobs:", error);
    return NextResponse.json(
      { error: "Failed to fetch QB jobs", details: String(error) },
      { status: 500 }
    );
  }
}
