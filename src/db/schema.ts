import { pgTable, text, integer, serial, timestamp, boolean, date, jsonb, pgEnum } from "drizzle-orm/pg-core";

// Enums
export const reportTypeEnum = pgEnum("email_report_type", ["daily_summary", "morning_reminder", "midday_report"]);
export const categoryEnum = pgEnum("email_category", ["customer", "vendor", "other"]);
export const itemTypeEnum = pgEnum("email_item_type", ["po_sent", "po_received", "quote_request", "general", "other"]);
export const todoTypeEnum = pgEnum("email_todo_type", ["po_unacknowledged", "quote_unanswered", "general_unanswered"]);

// Email messages
export const emails = pgTable("email_messages", {
  id: serial("id").primaryKey(),
  uid: integer("uid").notNull(),
  messageId: text("message_id"),
  fromAddress: text("from_address"),
  fromName: text("from_name"),
  toAddresses: text("to_addresses"), // JSON array
  subject: text("subject"),
  bodyText: text("body_text"),
  date: timestamp("date"),
  inReplyTo: text("in_reply_to"),
  references: text("references"), // Space-separated message IDs
  mailbox: text("mailbox").notNull(), // INBOX, Sent, Sent Items
  hasAttachments: boolean("has_attachments").default(false),
  attachments: text("attachments"), // JSON array of attachment info
  syncedAt: timestamp("synced_at").notNull(),
});

// Daily reports
export const dailyReports = pgTable("email_daily_reports", {
  id: serial("id").primaryKey(),
  reportDate: date("report_date").notNull(),
  reportType: reportTypeEnum("report_type").notNull(),
  emailsReceived: integer("emails_received").notNull().default(0),
  emailsSent: integer("emails_sent").notNull().default(0),
  generatedAt: timestamp("generated_at").notNull(),
  sentAt: timestamp("sent_at"),
  reportHtml: text("report_html"),
});

// Report threads - categorized thread summaries for each report
export const reportThreads = pgTable("email_report_threads", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id")
    .notNull()
    .references(() => dailyReports.id, { onDelete: "cascade" }),
  threadKey: text("thread_key").notNull(), // Normalized subject/messageId
  category: categoryEnum("category").notNull(),
  itemType: itemTypeEnum("item_type").notNull(),
  contactEmail: text("contact_email"),
  contactName: text("contact_name"),
  subject: text("subject"),
  summary: text("summary"), // AI generated
  emailCount: integer("email_count").notNull().default(0),
  lastEmailDate: timestamp("last_email_date"),
  lastEmailFromUs: boolean("last_email_from_us").default(false),
  poDetails: jsonb("po_details"), // Extracted PO info: { items, total, vendor, poNumber }
});

// Todo items - action items identified in reports
export const todoItems = pgTable("email_todo_items", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id")
    .notNull()
    .references(() => dailyReports.id, { onDelete: "cascade" }),
  threadKey: text("thread_key").notNull(),
  todoType: todoTypeEnum("todo_type").notNull(),
  description: text("description"),
  contactEmail: text("contact_email"),
  contactName: text("contact_name"),
  originalDate: timestamp("original_date"),
  subject: text("subject"),
  resolved: boolean("resolved").notNull().default(false),
  resolvedAt: timestamp("resolved_at"),
});

// Dismissed threads - tracks manually dismissed threadKeys (persists across report regeneration)
export const dismissedThreads = pgTable("email_dismissed_threads", {
  id: serial("id").primaryKey(),
  threadKey: text("thread_key").notNull().unique(),
  dismissedAt: timestamp("dismissed_at").notNull(),
  reason: text("reason"), // "manual" or "auto"
});

// Sync metadata - tracks last sync time per mailbox for incremental sync
export const syncMetadata = pgTable("email_sync_metadata", {
  id: serial("id").primaryKey(),
  mailbox: text("mailbox").notNull().unique(),
  lastSyncAt: timestamp("last_sync_at").notNull(),
  lastUid: integer("last_uid"), // Highest UID synced
});

// Type exports
export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type DailyReport = typeof dailyReports.$inferSelect;
export type NewDailyReport = typeof dailyReports.$inferInsert;
export type ReportThread = typeof reportThreads.$inferSelect;
export type NewReportThread = typeof reportThreads.$inferInsert;
export type TodoItem = typeof todoItems.$inferSelect;
export type NewTodoItem = typeof todoItems.$inferInsert;
export type DismissedThread = typeof dismissedThreads.$inferSelect;
export type NewDismissedThread = typeof dismissedThreads.$inferInsert;
export type SyncMetadata = typeof syncMetadata.$inferSelect;
export type NewSyncMetadata = typeof syncMetadata.$inferInsert;

export type ReportType = "daily_summary" | "morning_reminder" | "midday_report";
export type Category = "customer" | "vendor" | "other";
export type ItemType = "po_sent" | "po_received" | "quote_request" | "general" | "other";
export type TodoType = "po_unacknowledged" | "quote_unanswered" | "general_unanswered";
