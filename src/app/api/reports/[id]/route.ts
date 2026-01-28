import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

// Returns a single report with its threads and todos
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const reportId = parseInt(id, 10);

    if (isNaN(reportId)) {
      return NextResponse.json({ error: "Invalid report ID" }, { status: 400 });
    }

    // Get report
    const reports = await db
      .select()
      .from(schema.dailyReports)
      .where(eq(schema.dailyReports.id, reportId));

    const report = reports[0];

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    // Get report threads
    const threads = await db
      .select()
      .from(schema.reportThreads)
      .where(eq(schema.reportThreads.reportId, reportId));

    // Get todos
    const todos = await db
      .select()
      .from(schema.todoItems)
      .where(eq(schema.todoItems.reportId, reportId));

    return NextResponse.json({ report, threads, todos });
  } catch (error) {
    console.error("Error fetching report:", error);
    return NextResponse.json(
      { error: "Failed to fetch report" },
      { status: 500 }
    );
  }
}
