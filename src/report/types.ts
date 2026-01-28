import type { Email, Category, ItemType, TodoType, ReportType } from "@/db/schema";

// PO details extracted from PDFs
export interface PoDetails {
  poNumber: string | null;
  vendor: string | null;
  items: PoLineItem[];
  total: number | null;
  currency: string;
}

export interface PoLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
}

// Thread with categorization info (used during report generation)
export interface CategorizedThread {
  threadKey: string;
  emails: Email[];
  category: Category;
  itemType: ItemType;
  contactEmail: string | null;
  contactName: string | null;
  subject: string;
  summary: string | null;
  emailCount: number;
  lastEmailDate: Date | null;
  lastEmailFromUs: boolean;
  needsResponse: boolean; // AI-determined: does this thread need a response from us?
  poDetails: PoDetails | null;
}

// Todo item before DB insertion
export interface IdentifiedTodo {
  threadKey: string;
  todoType: TodoType;
  description: string;
  contactEmail: string | null;
  contactName: string | null;
  originalDate: Date | null;
  subject: string;
}

// Todo item for display (with resolved status)
export interface DisplayTodo extends IdentifiedTodo {
  resolved: boolean;
}

// Report data structure before DB insertion
export interface GeneratedReport {
  reportDate: Date;
  reportType: ReportType;
  emailsReceived: number;
  emailsSent: number;
  threads: CategorizedThread[];
  todos: IdentifiedTodo[]; // New todos (unresolved) for DB insertion
  displayTodos: DisplayTodo[]; // All todos for display (including resolved from morning)
  html: string;
}

// Email info for AI prompts
export interface EmailForPrompt {
  from: string;
  to: string;
  date: Date | null;
  subject: string;
  body: string;
  isOutbound: boolean;
  hasAttachments: boolean;
}

// AI categorization result
export interface CategorizationResult {
  category: Category;
  itemType: ItemType;
  contactName: string | null;
  summary: string;
  needsResponse: boolean; // Does this thread need a response from us?
  relatedTo: string | null; // ThreadKey of related thread (e.g., vendor quote responding to our RFQ)
}

// PO extraction result from AI
export interface PoExtractionResult {
  poNumber: string | null;
  vendor: string | null;
  items: PoLineItem[];
  total: number | null;
  currency: string;
}

// Time window for report generation
export interface TimeWindow {
  start: Date;
  end: Date;
}

// Report generation options
export interface ReportOptions {
  date?: Date; // Override date for historical reports
  preview?: boolean; // Output to console instead of sending email
  skipEmail?: boolean; // Generate but don't send
}

// Morning report specific data
export interface MorningReportData {
  pendingTodos: {
    id: number;
    threadKey: string;
    todoType: TodoType;
    description: string | null;
    contactEmail: string | null;
    contactName: string | null;
    originalDate: Date | null;
    subject: string | null;
    resolved?: boolean; // True if resolved by overnight email activity
  }[];
  overnightEmails: CategorizedThread[];
  overnightReceived: number;
  overnightSent: number;
}
