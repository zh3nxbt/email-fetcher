import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { desc } from "drizzle-orm";

// Returns recent reports
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "10", 10)));

    // Fetch recent reports
    const reports = await db
      .select()
      .from(schema.dailyReports)
      .orderBy(desc(schema.dailyReports.generatedAt))
      .limit(limit);

    return NextResponse.json({ reports });
  } catch (error: unknown) {
    console.error("Error fetching reports:", error);
    const message = error instanceof Error ? error.message : "Failed to fetch reports";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
