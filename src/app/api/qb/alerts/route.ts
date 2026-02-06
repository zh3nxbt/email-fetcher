import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, sql } from "drizzle-orm";
import type { QbSyncAlertType, QbAlertStatus } from "@/db/schema";

// GET /api/qb/alerts — QB sync alerts with counts by type
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "open";
    const alertType = url.searchParams.get("alertType");

    // Build query
    let query = db.select().from(schema.qbSyncAlerts).$dynamic();

    if (status && status !== "all") {
      query = query.where(eq(schema.qbSyncAlerts.status, status as QbAlertStatus));
    }

    const alerts = await query;

    // Apply alertType filter in JS (simpler than composing dynamic AND)
    const filtered = alertType
      ? alerts.filter((a) => a.alertType === alertType)
      : alerts;

    // Count by alert type (always scoped to the status filter)
    const counts: Record<string, number> = {};
    for (const alert of alerts) {
      counts[alert.alertType] = (counts[alert.alertType] || 0) + 1;
    }

    return NextResponse.json({
      alerts: filtered,
      counts,
      total: filtered.length,
    });
  } catch (error) {
    console.error("Error fetching QB alerts:", error);
    return NextResponse.json(
      { error: "Failed to fetch QB alerts" },
      { status: 500 }
    );
  }
}
