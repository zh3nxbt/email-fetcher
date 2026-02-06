import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

// PATCH /api/qb/alerts/[id] — Dismiss or resolve an alert (local DB only, does NOT affect QuickBooks)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const alertId = parseInt(id, 10);

    if (isNaN(alertId)) {
      return NextResponse.json(
        { error: "Invalid alert ID" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { action } = body;

    if (!action || !["dismiss", "resolve"].includes(action)) {
      return NextResponse.json(
        { error: "action must be 'dismiss' or 'resolve'" },
        { status: 400 }
      );
    }

    // Verify alert exists
    const existing = await db
      .select()
      .from(schema.qbSyncAlerts)
      .where(eq(schema.qbSyncAlerts.id, alertId));

    if (existing.length === 0) {
      return NextResponse.json(
        { error: "Alert not found" },
        { status: 404 }
      );
    }

    const now = new Date();
    const newStatus = action === "resolve" ? "resolved" : "dismissed";

    const [updated] = await db
      .update(schema.qbSyncAlerts)
      .set({
        status: newStatus as "resolved" | "dismissed",
        resolvedAt: now,
        resolvedBy: "manual",
      })
      .where(eq(schema.qbSyncAlerts.id, alertId))
      .returning();

    return NextResponse.json({
      success: true,
      alert: {
        id: updated.id,
        alertType: updated.alertType,
        status: updated.status,
        resolvedAt: updated.resolvedAt,
      },
    });
  } catch (error) {
    console.error("Error updating QB alert:", error);
    return NextResponse.json(
      { error: "Failed to update alert" },
      { status: 500 }
    );
  }
}
