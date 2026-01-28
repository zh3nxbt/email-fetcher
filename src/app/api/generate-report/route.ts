import { NextResponse } from "next/server";
import { toZonedTime } from "date-fns-tz";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { syncEmails } from "@/sync/syncer";
import {
  generateDailySummary,
  generateMorningReminder,
  saveReport,
} from "@/report/generator";
import type { ReportType } from "@/db/schema";

const TIMEZONE = process.env.REPORT_TIMEZONE || "America/New_York";

// Determine which report type based on current time
function getReportTypeForCurrentTime(): ReportType {
  const now = new Date();
  const zonedNow = toZonedTime(now, TIMEZONE);
  const hour = zonedNow.getHours();

  // 7am-4pm (7-16) = daily_summary (4pm report)
  // 4pm-7am (16-7) = morning_reminder (7am report)
  if (hour >= 7 && hour < 16) {
    return "daily_summary";
  } else {
    return "morning_reminder";
  }
}

// Delete existing report for date/type
async function deleteExistingReport(dateStr: string, reportType: ReportType): Promise<void> {
  // First get the report to find its ID
  const existing = await db
    .select({ id: schema.dailyReports.id })
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportDate, dateStr),
        eq(schema.dailyReports.reportType, reportType)
      )
    );

  for (const report of existing) {
    // Delete associated todos
    await db
      .delete(schema.todoItems)
      .where(eq(schema.todoItems.reportId, report.id));

    // Delete associated threads
    await db
      .delete(schema.reportThreads)
      .where(eq(schema.reportThreads.reportId, report.id));

    // Delete the report
    await db
      .delete(schema.dailyReports)
      .where(eq(schema.dailyReports.id, report.id));
  }
}

export async function POST() {
  try {
    // Step 1: Sync emails first
    console.log("Syncing emails...");
    const syncResult = await syncEmails();
    console.log(`Synced ${syncResult.emailsSynced} emails`);

    // Step 2: Determine report type based on current time
    const reportType = getReportTypeForCurrentTime();
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];

    console.log(`Generating ${reportType} report for ${dateStr}`);

    // Step 3: Delete existing report for this date/type
    await deleteExistingReport(dateStr, reportType);

    // Step 4: Generate and save report
    let reportId: number;

    if (reportType === "daily_summary") {
      const report = await generateDailySummary();
      reportId = await saveReport(report);
    } else {
      // Morning reminder - save directly
      const { reportDate, data, html } = await generateMorningReminder();

      const [inserted] = await db
        .insert(schema.dailyReports)
        .values({
          reportDate: reportDate.toISOString().split("T")[0],
          reportType: "morning_reminder",
          emailsReceived: data.overnightReceived,
          emailsSent: data.overnightSent,
          generatedAt: new Date(),
          reportHtml: html,
        })
        .returning({ id: schema.dailyReports.id });

      reportId = inserted.id;

      // Save todos
      for (const todo of data.pendingTodos.filter(t => !t.resolved)) {
        await db.insert(schema.todoItems).values({
          reportId,
          threadKey: todo.threadKey,
          todoType: todo.todoType,
          description: todo.description,
          contactEmail: todo.contactEmail,
          contactName: todo.contactName,
          originalDate: todo.originalDate,
          subject: todo.subject,
        });
      }
    }

    return NextResponse.json({
      success: true,
      reportType,
      reportId,
      emailsSynced: syncResult.emailsSynced,
    });
  } catch (error) {
    console.error("Report generation error:", error);
    return NextResponse.json(
      { error: "Report generation failed", details: String(error) },
      { status: 500 }
    );
  }
}
