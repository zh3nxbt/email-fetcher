import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { db, schema } from "@/db";
import { and, eq, desc, inArray } from "drizzle-orm";
import type { ReportType, TodoItem } from "@/db/schema";
import type {
  TimeWindow,
  ReportOptions,
  GeneratedReport,
  MorningReportData,
  CategorizedThread,
  IdentifiedTodo,
  DisplayTodo,
} from "./types";
import {
  categorizeThreads,
  fetchEmailsInWindow,
  countEmailsByDirection,
  isLastEmailFromUs,
} from "./categorizer";
import { identifyTodos } from "./todo-analyzer";
import {
  generateDailySummaryHtml,
  generateMorningReminderHtml,
  generateMiddayReportHtml,
  generatePlainTextSummary,
} from "./templates";
import { sendReportEmail } from "./email-sender";
import { groupEmailsIntoThreads } from "@/sync/threader";

const TIMEZONE = process.env.REPORT_TIMEZONE || "America/New_York";

// Get the 4pm daily summary window (12pm to 4pm same day)
export function getDailySummaryWindow(forDate: Date): TimeWindow {
  // Convert to the target timezone
  const zonedDate = toZonedTime(forDate, TIMEZONE);

  // Start is 12pm on the given date (changed from 7am to chain from midday report)
  const startDate = new Date(zonedDate);
  startDate.setHours(12, 0, 0, 0);

  // End is 4pm on the given date
  const endDate = new Date(zonedDate);
  endDate.setHours(16, 0, 0, 0);

  // Convert back to UTC
  return {
    start: fromZonedTime(startDate, TIMEZONE),
    end: fromZonedTime(endDate, TIMEZONE),
  };
}

// Get the 7am morning reminder window (previous day 4pm to current day 7am)
export function getMorningReminderWindow(forDate: Date): TimeWindow {
  // Convert to the target timezone
  const zonedDate = toZonedTime(forDate, TIMEZONE);

  // End is 7am on the given date
  const endDate = new Date(zonedDate);
  endDate.setHours(7, 0, 0, 0);

  // Start is 4pm the previous day
  const startDate = new Date(zonedDate);
  startDate.setDate(startDate.getDate() - 1);
  startDate.setHours(16, 0, 0, 0);

  // Convert back to UTC
  return {
    start: fromZonedTime(startDate, TIMEZONE),
    end: fromZonedTime(endDate, TIMEZONE),
  };
}

// Get the 12pm midday report window (7am to 12pm same day)
export function getMiddayReportWindow(forDate: Date): TimeWindow {
  // Convert to the target timezone
  const zonedDate = toZonedTime(forDate, TIMEZONE);

  // Start is 7am on the given date
  const startDate = new Date(zonedDate);
  startDate.setHours(7, 0, 0, 0);

  // End is 12pm on the given date
  const endDate = new Date(zonedDate);
  endDate.setHours(12, 0, 0, 0);

  // Convert back to UTC
  return {
    start: fromZonedTime(startDate, TIMEZONE),
    end: fromZonedTime(endDate, TIMEZONE),
  };
}

// Check which todos are resolved by email activity in a time window
async function checkResolvedTodos(
  todos: { id: number; threadKey: string }[],
  window: TimeWindow
): Promise<Set<number>> {
  const resolvedIds = new Set<number>();

  if (todos.length === 0) return resolvedIds;

  // Fetch emails in the window
  const emails = await fetchEmailsInWindow(window);

  // Group into threads
  const threadMap = groupEmailsIntoThreads(emails);

  // Check each todo's thread
  for (const todo of todos) {
    const threadEmails = threadMap.get(todo.threadKey);

    if (threadEmails && threadEmails.length > 0) {
      // A todo is resolved if WE sent ANY email in this thread during the window
      // This handles cases where customer sends "thanks" after our reply
      const weRepliedInWindow = threadEmails.some(email => {
        const fromLower = email.fromAddress?.toLowerCase() || "";
        const OUR_DOMAIN = process.env.IMAP_USER?.split("@")[1]?.toLowerCase() || "masprecisionparts.com";
        return (
          fromLower.includes(OUR_DOMAIN) ||
          email.mailbox === "Sent" ||
          email.mailbox === "Sent Items" ||
          email.mailbox === "Sent Messages"
        );
      });

      if (weRepliedInWindow) {
        resolvedIds.add(todo.id);
      }
    }
  }

  return resolvedIds;
}

// Mark todos as resolved in the database
async function markTodosResolved(todoIds: number[]): Promise<void> {
  if (todoIds.length === 0) return;

  await db
    .update(schema.todoItems)
    .set({ resolved: true, resolvedAt: new Date() })
    .where(inArray(schema.todoItems.id, todoIds));
}

// Get all manually dismissed threadKeys (persists across report regeneration)
async function getDismissedThreadKeys(): Promise<Set<string>> {
  const dismissed = await db
    .select({ threadKey: schema.dismissedThreads.threadKey })
    .from(schema.dismissedThreads);

  return new Set(dismissed.map((d) => d.threadKey));
}

// Get the 7am report from the same day (for 12pm report)
async function getSameDayMorningReport(forDate: Date) {
  const dateStr = forDate.toISOString().split("T")[0];

  const reports = await db
    .select()
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportType, "morning_reminder"),
        eq(schema.dailyReports.reportDate, dateStr)
      )
    )
    .orderBy(desc(schema.dailyReports.generatedAt))
    .limit(1);

  return reports[0] || null;
}

// Get the 12pm report from the same day (for 4pm report)
async function getSameDayMiddayReport(forDate: Date) {
  const dateStr = forDate.toISOString().split("T")[0];

  const reports = await db
    .select()
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportType, "midday_report"),
        eq(schema.dailyReports.reportDate, dateStr)
      )
    )
    .orderBy(desc(schema.dailyReports.generatedAt))
    .limit(1);

  return reports[0] || null;
}

// Get the 4pm report from the previous day (for 7am report)
async function getPreviousDayDailyReport(forDate: Date) {
  const yesterday = new Date(forDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const reports = await db
    .select()
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportType, "daily_summary"),
        eq(schema.dailyReports.reportDate, yesterdayStr)
      )
    )
    .orderBy(desc(schema.dailyReports.generatedAt))
    .limit(1);

  return reports[0] || null;
}

// Get unresolved todos from a report
async function getUnresolvedTodos(reportId: number) {
  return await db
    .select()
    .from(schema.todoItems)
    .where(
      and(
        eq(schema.todoItems.reportId, reportId),
        eq(schema.todoItems.resolved, false)
      )
    );
}

// Generate the 4pm daily summary report
export async function generateDailySummary(options: ReportOptions = {}): Promise<GeneratedReport> {
  const reportDate = options.date || new Date();
  const window = getDailySummaryWindow(reportDate);

  console.log(`Generating daily summary for window:`);
  console.log(`  Start: ${window.start.toISOString()} (12pm EST)`);
  console.log(`  End: ${window.end.toISOString()} (4pm EST)`);

  // Step 1: Get pending todos from this day's 12pm midday report
  console.log("\nStep 1: Fetching todos from midday report...");
  const middayReport = await getSameDayMiddayReport(reportDate);
  let middayTodosWithStatus: DisplayTodo[] = [];

  if (middayReport) {
    const middayTodos = await getUnresolvedTodos(middayReport.id);
    console.log(`  Found ${middayTodos.length} unresolved todos from 12pm report`);

    // Check which are resolved by 12pm-4pm activity
    const resolvedIds = await checkResolvedTodos(
      middayTodos.map(t => ({ id: t.id, threadKey: t.threadKey })),
      window
    );

    if (resolvedIds.size > 0) {
      console.log(`  ${resolvedIds.size} todos resolved by email activity`);
      await markTodosResolved([...resolvedIds]);
    }

    // Map all midday todos with their resolved status
    middayTodosWithStatus = middayTodos.map(t => ({
      threadKey: t.threadKey,
      todoType: t.todoType,
      description: t.description || "",
      contactEmail: t.contactEmail,
      contactName: t.contactName,
      originalDate: t.originalDate,
      subject: t.subject || "",
      resolved: resolvedIds.has(t.id),
    }));

    const stillPending = middayTodosWithStatus.filter(t => !t.resolved).length;
    console.log(`  ${stillPending} todos still pending, ${resolvedIds.size} resolved`);
  } else {
    console.log("  No midday report found for today");
  }

  // Step 2: Categorize threads in the 12pm-4pm window
  console.log("\nStep 2: Categorizing threads (12pm-4pm)...");
  let threads = await categorizeThreads(window, { reanalyze: options.reanalyze });
  console.log(`  Found ${threads.length} threads`);

  // Step 3: Identify new todos from today's activity
  console.log("\nStep 4: Identifying new action items...");
  const newTodosRaw = identifyTodos(threads);
  console.log(`  Found ${newTodosRaw.length} new action items`);

  // Get manually dismissed threads (persists across report regeneration)
  const dismissedThreadKeys = await getDismissedThreadKeys();
  console.log(`  ${dismissedThreadKeys.size} threads previously dismissed`);

  // Filter out dismissed threads from carried-over midday todos
  const dismissedFromMidday = middayTodosWithStatus.filter(t => dismissedThreadKeys.has(t.threadKey));
  if (dismissedFromMidday.length > 0) {
    console.log(`  Removing ${dismissedFromMidday.length} dismissed todos from midday carry-over`);
    middayTodosWithStatus = middayTodosWithStatus.filter(t => !dismissedThreadKeys.has(t.threadKey));
  }

  // Filter out new todos that are duplicates of UNRESOLVED midday todos (by threadKey)
  // Resolved todos should NOT block new todos - if a thread changed state (e.g., quote_unanswered → po_received)
  // we need to allow the new todo to be created
  const middayThreadKeys = new Set(
    middayTodosWithStatus.filter(t => !t.resolved).map(t => t.threadKey)
  );

  const trulyNewTodos = newTodosRaw.filter(t =>
    !middayThreadKeys.has(t.threadKey) && !dismissedThreadKeys.has(t.threadKey)
  );
  console.log(`  ${trulyNewTodos.length} are genuinely new (not carry-over or dismissed)`);

  // Convert new todos to DisplayTodo format (all unresolved)
  const newTodosDisplay: DisplayTodo[] = trulyNewTodos.map(t => ({
    ...t,
    resolved: false,
  }));

  // Combine for display: midday todos (with resolved status) + new todos
  const displayTodos: DisplayTodo[] = [...middayTodosWithStatus, ...newTodosDisplay];

  // For DB insertion: save BOTH unresolved midday todos AND new todos
  // This ensures the chain continues: 7am → 12pm → 4pm → next 7am can find them
  const unresolvedMiddayTodos: IdentifiedTodo[] = middayTodosWithStatus
    .filter(t => !t.resolved)
    .map(t => ({
      threadKey: t.threadKey,
      todoType: t.todoType,
      description: t.description,
      contactEmail: t.contactEmail,
      contactName: t.contactName,
      originalDate: t.originalDate,
      subject: t.subject,
    }));
  const todosForDb: IdentifiedTodo[] = [...unresolvedMiddayTodos, ...trulyNewTodos];

  const unresolvedCount = displayTodos.filter(t => !t.resolved).length;
  const resolvedCount = displayTodos.filter(t => t.resolved).length;
  console.log(`  Display: ${unresolvedCount} pending, ${resolvedCount} resolved`);

  // Step 5: Calculate metrics
  const emails = await fetchEmailsInWindow(window);
  const { received, sent } = countEmailsByDirection(emails);

  // Step 6: Generate HTML (pass displayTodos for rendering with resolved status)
  // Use window.end for the title date - it's correctly set to 4pm EST on the target day
  console.log("\nStep 5: Generating report...");
  const html = generateDailySummaryHtml(window.end, received, sent, threads, displayTodos);

  return {
    reportDate,
    reportType: "daily_summary",
    emailsReceived: received,
    emailsSent: sent,
    threads,
    todos: todosForDb, // Only new unresolved todos for DB
    displayTodos, // All todos (including resolved) for display
    html,
  };
}

// Generate the 7am morning reminder
export async function generateMorningReminder(options: ReportOptions = {}): Promise<{
  reportDate: Date;
  data: MorningReportData;
  html: string;
}> {
  const reportDate = options.date || new Date();
  const window = getMorningReminderWindow(reportDate);

  console.log(`Generating morning reminder for window:`);
  console.log(`  Start: ${window.start.toISOString()} (4pm EST yesterday)`);
  console.log(`  End: ${window.end.toISOString()} (7am EST today)`);

  // Step 1: Get unresolved todos from yesterday's 4pm report
  console.log("\nStep 1: Fetching pending todos from yesterday's 4pm report...");
  const yesterdayReport = await getPreviousDayDailyReport(reportDate);
  let pendingTodos: MorningReportData["pendingTodos"] = [];
  let resolvedTodoIds: number[] = [];

  if (yesterdayReport) {
    const yesterdayTodos = await getUnresolvedTodos(yesterdayReport.id);
    console.log(`  Found ${yesterdayTodos.length} unresolved todos from 4pm report`);

    // Check which are resolved by overnight activity (4pm-7am)
    const resolvedIds = await checkResolvedTodos(
      yesterdayTodos.map(t => ({ id: t.id, threadKey: t.threadKey })),
      window
    );

    if (resolvedIds.size > 0) {
      console.log(`  ${resolvedIds.size} todos resolved by overnight email activity`);
      resolvedTodoIds = [...resolvedIds];
      await markTodosResolved(resolvedTodoIds);
    }

    // Map todos with resolved status for display
    pendingTodos = yesterdayTodos.map((t) => ({
      id: t.id,
      threadKey: t.threadKey,
      todoType: t.todoType,
      description: t.description,
      contactEmail: t.contactEmail,
      contactName: t.contactName,
      originalDate: t.originalDate,
      subject: t.subject,
      resolved: resolvedIds.has(t.id),
    }));

    console.log(`  ${pendingTodos.filter(t => !t.resolved).length} todos still pending`);
  } else {
    console.log("  No 4pm report found for yesterday");
  }

  // Step 2: Categorize overnight emails (4pm-7am)
  console.log("\nStep 2: Categorizing overnight emails...");
  const overnightEmails = await categorizeThreads(window, { reanalyze: options.reanalyze });
  const emails = await fetchEmailsInWindow(window);
  const { received: overnightReceived, sent: overnightSent } = countEmailsByDirection(emails);
  console.log(`  Found ${overnightEmails.length} threads (${overnightReceived} received, ${overnightSent} sent)`);

  // Step 3: Identify NEW action items from overnight emails
  console.log("\nStep 3: Identifying new action items from overnight emails...");
  const overnightTodosRaw = identifyTodos(overnightEmails);

  // Get manually dismissed threads (persists across report regeneration)
  const dismissedThreadKeys = await getDismissedThreadKeys();
  console.log(`  ${dismissedThreadKeys.size} threads previously dismissed`);

  // Filter out dismissed threads from carried-over pending todos
  const dismissedFromPending = pendingTodos.filter(t => dismissedThreadKeys.has(t.threadKey));
  if (dismissedFromPending.length > 0) {
    console.log(`  Removing ${dismissedFromPending.length} dismissed todos from pending list`);
    pendingTodos = pendingTodos.filter(t => !dismissedThreadKeys.has(t.threadKey));
  }

  // Filter out duplicates (already in UNRESOLVED pending todos from yesterday)
  // Resolved todos should NOT block new todos - if a thread changed state (e.g., quote_unanswered → po_received)
  // we need to allow the new todo to be created
  const pendingThreadKeys = new Set(
    pendingTodos.filter(t => !t.resolved).map(t => t.threadKey)
  );

  const newOvernightTodos = overnightTodosRaw.filter(t =>
    !pendingThreadKeys.has(t.threadKey) && !dismissedThreadKeys.has(t.threadKey)
  );
  console.log(`  Found ${newOvernightTodos.length} new action items from overnight emails (excluding dismissed)`);

  // Add new overnight todos to pending list (for display and saving)
  for (const todo of newOvernightTodos) {
    pendingTodos.push({
      id: 0, // Will be assigned when saved
      threadKey: todo.threadKey,
      todoType: todo.todoType,
      description: todo.description,
      contactEmail: todo.contactEmail,
      contactName: todo.contactName,
      originalDate: todo.originalDate,
      subject: todo.subject,
      resolved: false,
    });
  }

  // Step 4: Generate HTML
  console.log("\nStep 4: Generating report...");
  const data: MorningReportData = {
    pendingTodos,
    overnightEmails,
    overnightReceived,
    overnightSent,
  };

  // Use window.end for the title date - it's correctly set to 7am EST on the target day
  const html = generateMorningReminderHtml(data, window.end);

  return { reportDate, data, html };
}

// Midday report data structure
export interface MiddayReportData {
  pendingTodos: {
    id: number;
    threadKey: string;
    todoType: "po_unacknowledged" | "quote_unanswered" | "general_unanswered" | "vendor_followup";
    description: string | null;
    contactEmail: string | null;
    contactName: string | null;
    originalDate: Date | null;
    subject: string | null;
    resolved?: boolean;
  }[];
  morningEmails: CategorizedThread[];
  morningReceived: number;
  morningSent: number;
}

// Generate the 12pm midday report
export async function generateMiddayReport(options: ReportOptions = {}): Promise<{
  reportDate: Date;
  data: MiddayReportData;
  html: string;
}> {
  const reportDate = options.date || new Date();
  const window = getMiddayReportWindow(reportDate);

  console.log(`Generating midday report for window:`);
  console.log(`  Start: ${window.start.toISOString()} (7am EST today)`);
  console.log(`  End: ${window.end.toISOString()} (12pm EST today)`);

  // Step 1: Get unresolved todos from today's 7am report
  console.log("\nStep 1: Fetching pending todos from today's 7am report...");
  const morningReport = await getSameDayMorningReport(reportDate);
  let pendingTodos: MiddayReportData["pendingTodos"] = [];
  let resolvedTodoIds: number[] = [];

  if (morningReport) {
    const morningTodos = await getUnresolvedTodos(morningReport.id);
    console.log(`  Found ${morningTodos.length} unresolved todos from 7am report`);

    // Check which are resolved by morning activity (7am-12pm)
    const resolvedIds = await checkResolvedTodos(
      morningTodos.map(t => ({ id: t.id, threadKey: t.threadKey })),
      window
    );

    if (resolvedIds.size > 0) {
      console.log(`  ${resolvedIds.size} todos resolved by morning email activity`);
      resolvedTodoIds = [...resolvedIds];
      await markTodosResolved(resolvedTodoIds);
    }

    // Map todos with resolved status for display
    pendingTodos = morningTodos.map((t) => ({
      id: t.id,
      threadKey: t.threadKey,
      todoType: t.todoType,
      description: t.description,
      contactEmail: t.contactEmail,
      contactName: t.contactName,
      originalDate: t.originalDate,
      subject: t.subject,
      resolved: resolvedIds.has(t.id),
    }));

    console.log(`  ${pendingTodos.filter(t => !t.resolved).length} todos still pending`);
  } else {
    console.log("  No 7am report found for today");
  }

  // Step 2: Categorize morning emails (7am-12pm)
  console.log("\nStep 2: Categorizing morning emails...");
  const morningEmails = await categorizeThreads(window, { reanalyze: options.reanalyze });
  const emails = await fetchEmailsInWindow(window);
  const { received: morningReceived, sent: morningSent } = countEmailsByDirection(emails);
  console.log(`  Found ${morningEmails.length} threads (${morningReceived} received, ${morningSent} sent)`);

  // Step 3: Identify NEW action items from morning emails
  console.log("\nStep 3: Identifying new action items from morning emails...");
  const morningTodosRaw = identifyTodos(morningEmails);

  // Get manually dismissed threads (persists across report regeneration)
  const dismissedThreadKeys = await getDismissedThreadKeys();
  console.log(`  ${dismissedThreadKeys.size} threads previously dismissed`);

  // Filter out dismissed threads from carried-over pending todos
  const dismissedFromPending = pendingTodos.filter(t => dismissedThreadKeys.has(t.threadKey));
  if (dismissedFromPending.length > 0) {
    console.log(`  Removing ${dismissedFromPending.length} dismissed todos from pending list`);
    pendingTodos = pendingTodos.filter(t => !dismissedThreadKeys.has(t.threadKey));
  }

  // Filter out duplicates (already in UNRESOLVED pending todos from morning)
  // Resolved todos should NOT block new todos - if a thread changed state (e.g., quote_unanswered → po_received)
  // we need to allow the new todo to be created
  const pendingThreadKeys = new Set(
    pendingTodos.filter(t => !t.resolved).map(t => t.threadKey)
  );

  const newMorningTodos = morningTodosRaw.filter(t =>
    !pendingThreadKeys.has(t.threadKey) && !dismissedThreadKeys.has(t.threadKey)
  );
  console.log(`  Found ${newMorningTodos.length} new action items from morning emails (excluding dismissed)`);

  // Add new morning todos to pending list (for display and saving)
  for (const todo of newMorningTodos) {
    pendingTodos.push({
      id: 0, // Will be assigned when saved
      threadKey: todo.threadKey,
      todoType: todo.todoType,
      description: todo.description,
      contactEmail: todo.contactEmail,
      contactName: todo.contactName,
      originalDate: todo.originalDate,
      subject: todo.subject,
      resolved: false,
    });
  }

  // Step 4: Generate HTML
  console.log("\nStep 4: Generating report...");
  const data: MiddayReportData = {
    pendingTodos,
    morningEmails,
    morningReceived,
    morningSent,
  };

  // Use window.end for the title date - it's correctly set to 12pm EST on the target day
  const html = generateMiddayReportHtml(data, window.end);

  return { reportDate, data, html };
}

// Save report to database (deletes existing report for same date/type first)
export async function saveReport(report: GeneratedReport): Promise<number> {
  const dateStr = report.reportDate.toISOString().split("T")[0];

  // Delete existing report for the same date and type (cascade deletes threads and todos)
  const existing = await db
    .select({ id: schema.dailyReports.id })
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportDate, dateStr),
        eq(schema.dailyReports.reportType, report.reportType)
      )
    );

  if (existing.length > 0) {
    console.log(`  Replacing existing ${report.reportType} report for ${dateStr}`);
    for (const old of existing) {
      await db.delete(schema.dailyReports).where(eq(schema.dailyReports.id, old.id));
    }
  }

  // Insert the new report
  const [inserted] = await db
    .insert(schema.dailyReports)
    .values({
      reportDate: dateStr,
      reportType: report.reportType,
      emailsReceived: report.emailsReceived,
      emailsSent: report.emailsSent,
      generatedAt: new Date(),
      reportHtml: report.html,
    })
    .returning({ id: schema.dailyReports.id });

  const reportId = inserted.id;

  // Insert report threads
  for (const thread of report.threads) {
    await db.insert(schema.reportThreads).values({
      reportId,
      threadKey: thread.threadKey,
      category: thread.category,
      itemType: thread.itemType,
      contactEmail: thread.contactEmail,
      contactName: thread.contactName,
      subject: thread.subject,
      summary: thread.summary,
      emailCount: thread.emailCount,
      lastEmailDate: thread.lastEmailDate,
      lastEmailFromUs: thread.lastEmailFromUs,
      poDetails: thread.poDetails,
    });
  }

  // Insert todos
  for (const todo of report.todos) {
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

  return reportId;
}

// Mark report as sent
export async function markReportSent(reportId: number): Promise<void> {
  await db
    .update(schema.dailyReports)
    .set({ sentAt: new Date() })
    .where(eq(schema.dailyReports.id, reportId));
}

// Run daily summary (main entry point)
export async function runDailySummary(options: ReportOptions = {}): Promise<void> {
  console.log("\n=== Daily Summary Report (4pm) ===\n");

  const report = await generateDailySummary(options);

  if (options.preview) {
    const plainText = generatePlainTextSummary(
      report.reportDate,
      report.emailsReceived,
      report.emailsSent,
      report.threads,
      report.displayTodos
    );
    console.log(plainText);
    return;
  }

  // Save to database
  console.log("\nSaving report to database...");
  const reportId = await saveReport(report);
  console.log(`  Report saved with ID: ${reportId}`);

  if (!options.skipEmail) {
    // Send email
    const dateStr = report.reportDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const subject = `Daily Email Report - ${dateStr}`;

    console.log("\nSending report email...");
    await sendReportEmail(subject, report.html);
    await markReportSent(reportId);
  }

  console.log("\n=== Daily Summary Complete ===\n");
}

// Run morning reminder (main entry point)
export async function runMorningReminder(options: ReportOptions = {}): Promise<void> {
  console.log("\n=== Morning Reminder Report (7am) ===\n");

  const { reportDate, data, html } = await generateMorningReminder(options);

  if (options.preview) {
    console.log("\n--- Morning Reminder Preview ---");
    console.log(`Pending todos: ${data.pendingTodos.filter(t => !t.resolved).length}`);
    console.log(`Resolved overnight: ${data.pendingTodos.filter(t => t.resolved).length}`);
    console.log(`Overnight threads: ${data.overnightEmails.length}`);
    console.log(`Overnight received: ${data.overnightReceived}`);
    console.log(`Overnight sent: ${data.overnightSent}`);

    if (data.pendingTodos.length > 0) {
      console.log("\nTodos from Yesterday:");
      for (const todo of data.pendingTodos) {
        const status = todo.resolved ? "[x] RESOLVED" : "[ ]";
        console.log(`  ${status} ${todo.todoType}: ${todo.subject}`);
        console.log(`      ${todo.contactName || todo.contactEmail || "Unknown"}`);
      }
    }

    if (data.overnightEmails.length > 0) {
      console.log("\nOvernight Threads:");
      for (const thread of data.overnightEmails.slice(0, 5)) {
        console.log(`  [${thread.category}] ${thread.subject}`);
      }
    }
    return;
  }

  // Save the morning report (delete existing first)
  const dateStr = reportDate.toISOString().split("T")[0];

  // Delete existing morning report for the same date (cascade deletes todos)
  const existing = await db
    .select({ id: schema.dailyReports.id })
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportDate, dateStr),
        eq(schema.dailyReports.reportType, "morning_reminder")
      )
    );

  if (existing.length > 0) {
    console.log(`  Replacing existing morning_reminder report for ${dateStr}`);
    for (const old of existing) {
      await db.delete(schema.dailyReports).where(eq(schema.dailyReports.id, old.id));
    }
  }

  const [inserted] = await db
    .insert(schema.dailyReports)
    .values({
      reportDate: dateStr,
      reportType: "morning_reminder",
      emailsReceived: data.overnightReceived,
      emailsSent: data.overnightSent,
      generatedAt: new Date(),
      reportHtml: html,
    })
    .returning({ id: schema.dailyReports.id });

  // Save overnight threads
  for (const thread of data.overnightEmails) {
    await db.insert(schema.reportThreads).values({
      reportId: inserted.id,
      threadKey: thread.threadKey,
      category: thread.category,
      itemType: thread.itemType,
      contactEmail: thread.contactEmail,
      contactName: thread.contactName,
      subject: thread.subject,
      summary: thread.summary,
      emailCount: thread.emailCount,
      lastEmailDate: thread.lastEmailDate,
      lastEmailFromUs: thread.lastEmailFromUs,
      poDetails: thread.poDetails,
    });
  }

  // Save todos that are still pending (for 4pm report to pick up)
  for (const todo of data.pendingTodos.filter(t => !t.resolved)) {
    await db.insert(schema.todoItems).values({
      reportId: inserted.id,
      threadKey: todo.threadKey,
      todoType: todo.todoType,
      description: todo.description,
      contactEmail: todo.contactEmail,
      contactName: todo.contactName,
      originalDate: todo.originalDate,
      subject: todo.subject,
    });
  }

  if (!options.skipEmail) {
    const dateStr = reportDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const subject = `Morning Todo Reminder - ${dateStr}`;

    console.log("\nSending reminder email...");
    await sendReportEmail(subject, html);
    await markReportSent(inserted.id);
  }

  console.log("\n=== Morning Reminder Complete ===\n");
}

// Run midday report (main entry point)
export async function runMiddayReport(options: ReportOptions = {}): Promise<void> {
  console.log("\n=== Midday Report (12pm) ===\n");

  const { reportDate, data, html } = await generateMiddayReport(options);

  if (options.preview) {
    console.log("\n--- Midday Report Preview ---");
    console.log(`Pending todos: ${data.pendingTodos.filter(t => !t.resolved).length}`);
    console.log(`Resolved this morning: ${data.pendingTodos.filter(t => t.resolved).length}`);
    console.log(`Morning threads: ${data.morningEmails.length}`);
    console.log(`Morning received: ${data.morningReceived}`);
    console.log(`Morning sent: ${data.morningSent}`);

    if (data.pendingTodos.length > 0) {
      console.log("\nTodos:");
      for (const todo of data.pendingTodos) {
        const status = todo.resolved ? "[x] RESOLVED" : "[ ]";
        console.log(`  ${status} ${todo.todoType}: ${todo.subject}`);
        console.log(`      ${todo.contactName || todo.contactEmail || "Unknown"}`);
      }
    }

    if (data.morningEmails.length > 0) {
      console.log("\nMorning Threads:");
      for (const thread of data.morningEmails.slice(0, 5)) {
        console.log(`  [${thread.category}] ${thread.subject}`);
      }
    }
    return;
  }

  // Save the midday report (delete existing first)
  const dateStr = reportDate.toISOString().split("T")[0];

  // Delete existing midday report for the same date (cascade deletes todos)
  const existing = await db
    .select({ id: schema.dailyReports.id })
    .from(schema.dailyReports)
    .where(
      and(
        eq(schema.dailyReports.reportDate, dateStr),
        eq(schema.dailyReports.reportType, "midday_report")
      )
    );

  if (existing.length > 0) {
    console.log(`  Replacing existing midday_report for ${dateStr}`);
    for (const old of existing) {
      await db.delete(schema.dailyReports).where(eq(schema.dailyReports.id, old.id));
    }
  }

  const [inserted] = await db
    .insert(schema.dailyReports)
    .values({
      reportDate: dateStr,
      reportType: "midday_report",
      emailsReceived: data.morningReceived,
      emailsSent: data.morningSent,
      generatedAt: new Date(),
      reportHtml: html,
    })
    .returning({ id: schema.dailyReports.id });

  // Save morning threads
  for (const thread of data.morningEmails) {
    await db.insert(schema.reportThreads).values({
      reportId: inserted.id,
      threadKey: thread.threadKey,
      category: thread.category,
      itemType: thread.itemType,
      contactEmail: thread.contactEmail,
      contactName: thread.contactName,
      subject: thread.subject,
      summary: thread.summary,
      emailCount: thread.emailCount,
      lastEmailDate: thread.lastEmailDate,
      lastEmailFromUs: thread.lastEmailFromUs,
      poDetails: thread.poDetails,
    });
  }

  // Save todos that are still pending (for 4pm report to pick up)
  for (const todo of data.pendingTodos.filter(t => !t.resolved)) {
    await db.insert(schema.todoItems).values({
      reportId: inserted.id,
      threadKey: todo.threadKey,
      todoType: todo.todoType,
      description: todo.description,
      contactEmail: todo.contactEmail,
      contactName: todo.contactName,
      originalDate: todo.originalDate,
      subject: todo.subject,
    });
  }

  if (!options.skipEmail) {
    const dateStr = reportDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const subject = `Midday Email Update - ${dateStr}`;

    console.log("\nSending midday report email...");
    await sendReportEmail(subject, html);
    await markReportSent(inserted.id);
  }

  console.log("\n=== Midday Report Complete ===\n");
}
