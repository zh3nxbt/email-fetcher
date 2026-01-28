import type { CategorizedThread, MorningReportData, DisplayTodo } from "./types";
import { getTodoPriority } from "./todo-analyzer";

// Styles shared across templates
const styles = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
    color: #333;
    max-width: 700px;
    margin: 0 auto;
    padding: 16px;
    background-color: #f5f5f5;
  }
  .container {
    background-color: white;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  h1 {
    color: #1a1a1a;
    margin-top: 0;
    font-size: 20px;
    margin-bottom: 16px;
  }
  h2 {
    color: #666;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 20px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e0e0e0;
  }
  .section {
    margin-bottom: 20px;
  }
  .section-action-items {
    background-color: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .section-action-items h2 {
    color: #92400e;
    margin-top: 0;
    border-bottom-color: #f59e0b;
  }
  .section-summaries {
    background-color: #f9fafb;
    border-radius: 8px;
    padding: 16px;
  }
  .section-summaries h2 {
    margin-top: 0;
  }
  .section-summaries h2:not(:first-child) {
    margin-top: 20px;
  }
  .thread-item {
    display: flex;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .thread-item:last-child {
    border-bottom: none;
  }
  .thread-label {
    flex-shrink: 0;
    width: 70px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    color: #6b7280;
    padding-top: 2px;
  }
  .thread-label.po { color: #059669; }
  .thread-label.rfq { color: #2563eb; }
  .thread-content {
    flex: 1;
    min-width: 0;
  }
  .thread-subject {
    font-weight: 500;
    color: #1a1a1a;
    font-size: 14px;
    margin-bottom: 2px;
  }
  .email-count {
    display: inline-block;
    background-color: #e5e7eb;
    color: #6b7280;
    font-size: 11px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 10px;
    margin-left: 6px;
  }
  .thread-from {
    font-size: 13px;
    color: #666;
    margin-bottom: 4px;
  }
  .thread-summary {
    font-size: 13px;
    color: #888;
  }
  .todo-item {
    display: flex;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .todo-item:last-child {
    border-bottom: none;
  }
  .todo-label {
    flex-shrink: 0;
    width: 120px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    padding-top: 2px;
  }
  .todo-label.urgent { color: #dc2626; }
  .todo-label.pending { color: #d97706; }
  .todo-content {
    flex: 1;
    min-width: 0;
  }
  .todo-resolved {
    opacity: 0.6;
  }
  .todo-resolved .todo-subject,
  .todo-resolved .todo-from,
  .todo-resolved .todo-summary {
    text-decoration: line-through;
  }
  .todo-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 2px;
  }
  .todo-complete-btn {
    display: none;
    background-color: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: #374151;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s ease;
  }
  .todo-complete-btn:hover {
    background-color: #e5e7eb;
    border-color: #9ca3af;
  }
  .todo-complete-btn.completed {
    background-color: #dcfce7;
    border-color: #86efac;
    color: #166534;
    cursor: default;
  }
  .todo-subject {
    font-weight: 500;
    font-size: 14px;
    flex: 1;
  }
  .todo-from {
    font-size: 13px;
    color: #666;
    margin-bottom: 4px;
  }
  .todo-summary {
    font-size: 13px;
    color: #888;
  }
  .resolved-tag {
    font-size: 11px;
    color: #16a34a;
    font-weight: 500;
    margin-left: 8px;
  }
  .empty-state {
    color: #999;
    font-size: 13px;
    padding: 12px 0;
  }
  .footer {
    margin-top: 20px;
    padding-top: 12px;
    border-top: 1px solid #e0e0e0;
    font-size: 11px;
    color: #999;
    text-align: center;
  }
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getThreadLabel(itemType: string): { text: string; class: string; color: string } {
  switch (itemType) {
    case "po_received":
      return { text: "PO Received", class: "po", color: "#059669" }; // green
    case "po_sent":
      return { text: "PO Sent", class: "po", color: "#059669" }; // green
    case "quote_request":
      return { text: "RFQ", class: "rfq", color: "#2563eb" }; // blue
    default:
      return { text: "General", class: "", color: "#6b7280" }; // gray
  }
}

function renderThread(thread: CategorizedThread): string {
  const label = getThreadLabel(thread.itemType);

  return `
    <div class="thread-item">
      <div class="thread-label ${label.class}" style="color: ${label.color};">${label.text}</div>
      <div class="thread-content">
        <div class="thread-subject">${escapeHtml(thread.subject)}<span class="email-count">${thread.emailCount}</span></div>
        <div class="thread-from">${escapeHtml(thread.contactName || thread.contactEmail || "Unknown")}</div>
        ${thread.summary ? `<div class="thread-summary">${escapeHtml(thread.summary)}</div>` : ""}
      </div>
    </div>
  `;
}

function getTodoLabel(todoType: string): { text: string; class: string } {
  switch (todoType) {
    case "po_unacknowledged":
      return { text: "Need to Ack PO", class: "urgent" };
    case "quote_unanswered":
      return { text: "Need to Send Quote", class: "pending" };
    case "general_unanswered":
      return { text: "Need to Reply", class: "pending" };
    default:
      return { text: "Action Needed", class: "pending" };
  }
}

function renderDisplayTodo(todo: DisplayTodo): string {
  const age = todo.originalDate ? Math.floor((Date.now() - todo.originalDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
  const priority = getTodoPriority(todo.todoType, age);
  const label = getTodoLabel(todo.todoType);
  const labelColor = label.class === "urgent" ? "#dc2626" : "#d97706";

  return `
    <div class="todo-item ${todo.resolved ? "todo-resolved" : ""}" data-thread-key="${escapeHtml(todo.threadKey)}">
      <div class="todo-label" style="${todo.resolved ? "" : `color: ${labelColor};`}">${label.text}</div>
      <div class="todo-content">
        <div class="todo-header">
          <div class="todo-subject">
            ${escapeHtml(todo.subject)}
            ${todo.resolved ? '<span class="resolved-tag">resolved</span>' : ""}
          </div>
          ${todo.resolved
            ? '<button class="todo-complete-btn completed" disabled>Completed</button>'
            : `<button class="todo-complete-btn" data-thread-key="${escapeHtml(todo.threadKey)}">Mark Complete</button>`
          }
        </div>
        <div class="todo-from">${escapeHtml(todo.contactName || todo.contactEmail || "Unknown")}</div>
        ${todo.description ? `<div class="todo-summary">${escapeHtml(todo.description)}</div>` : ""}
      </div>
    </div>
  `;
}

// Sort order for item types
const itemTypeSortOrder: Record<string, number> = {
  po_received: 1,
  po_sent: 1,
  quote_request: 2,
  general: 3,
  other: 4,
};

function sortThreadsByItemType(threads: CategorizedThread[]): CategorizedThread[] {
  return [...threads].sort((a, b) => {
    const orderA = itemTypeSortOrder[a.itemType] || 99;
    const orderB = itemTypeSortOrder[b.itemType] || 99;
    return orderA - orderB;
  });
}

function renderThreadSection(
  title: string,
  threads: CategorizedThread[]
): string {
  if (threads.length === 0) {
    return "";
  }

  const sorted = sortThreadsByItemType(threads);

  return `
    <div class="section">
      <h2>${title}</h2>
      ${sorted.map(renderThread).join("")}
    </div>
  `;
}

// Generate daily summary HTML
export function generateDailySummaryHtml(
  date: Date,
  received: number,
  sent: number,
  threads: CategorizedThread[],
  todos: DisplayTodo[]
): string {
  const dateStr = date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const customerThreads = threads.filter((t) => t.category === "customer");
  const vendorThreads = threads.filter((t) => t.category === "vendor");

  const pendingTodos = todos.filter((t) => !t.resolved);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Email Report - ${dateStr}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="container">
    <h1>${dateStr}</h1>
    <div style="font-size: 13px; color: #666; margin-bottom: 16px;">
      ${received} received, ${sent} sent
    </div>

    ${pendingTodos.length > 0 ? `
    <div class="section-action-items">
      <h2>Action Items</h2>
      ${todos.map(renderDisplayTodo).join("")}
    </div>
    ` : ""}

    <div class="section-summaries">
      ${renderThreadSection("Customers", customerThreads)}
      ${renderThreadSection("Vendors", vendorThreads)}
    </div>

    <div class="footer">
      ${received} received, ${sent} sent
    </div>
  </div>
</body>
</html>
  `;
}

// Generate morning reminder HTML
export function generateMorningReminderHtml(data: MorningReportData): string {
  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const unresolvedTodos = data.pendingTodos.filter(t => !t.resolved);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Morning Reminder - ${dateStr}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="container">
    <h1>${dateStr}</h1>
    <div style="font-size: 13px; color: #666; margin-bottom: 16px;">
      ${data.overnightReceived} received, ${data.overnightSent} sent overnight
    </div>

    ${unresolvedTodos.length > 0 ? `
    <div class="section-action-items">
      <h2>Action Items</h2>
      ${data.pendingTodos.map((todo) => {
        const label = getTodoLabel(todo.todoType);
        const labelColor = label.class === "urgent" ? "#dc2626" : "#d97706";
        return `
        <div class="todo-item ${todo.resolved ? "todo-resolved" : ""}" data-thread-key="${escapeHtml(todo.threadKey)}">
          <div class="todo-label" style="${todo.resolved ? "" : `color: ${labelColor};`}">${label.text}</div>
          <div class="todo-content">
            <div class="todo-header">
              <div class="todo-subject">
                ${escapeHtml(todo.subject || "(no subject)")}
                ${todo.resolved ? '<span class="resolved-tag">resolved</span>' : ""}
              </div>
              ${todo.resolved
                ? '<button class="todo-complete-btn completed" disabled>Completed</button>'
                : `<button class="todo-complete-btn" data-thread-key="${escapeHtml(todo.threadKey)}">Mark Complete</button>`
              }
            </div>
            <div class="todo-from">${escapeHtml(todo.contactName || todo.contactEmail || "Unknown")}</div>
            ${todo.description ? `<div class="todo-summary">${escapeHtml(todo.description)}</div>` : ""}
          </div>
        </div>
      `}).join("")}
    </div>
    ` : `
    <div class="section">
      <div class="empty-state">No pending items</div>
    </div>
    `}

    ${data.overnightEmails.length > 0 ? `
    <div class="section">
      <h2>Overnight</h2>
      ${data.overnightEmails.slice(0, 10).map(renderThread).join("")}
      ${data.overnightEmails.length > 10 ? `
        <div class="empty-state">+${data.overnightEmails.length - 10} more</div>
      ` : ""}
    </div>
    ` : ""}

    <div class="footer">
      ${data.overnightReceived} received, ${data.overnightSent} sent overnight
    </div>
  </div>
</body>
</html>
  `;
}

// Generate plain text version for console preview
export function generatePlainTextSummary(
  date: Date,
  received: number,
  sent: number,
  threads: CategorizedThread[],
  todos: DisplayTodo[]
): string {
  const lines: string[] = [];
  const dateStr = date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const pendingTodos = todos.filter((t) => !t.resolved);

  lines.push(`\n${dateStr}`);
  lines.push(`${received} received, ${sent} sent\n`);

  if (pendingTodos.length > 0) {
    lines.push(`ACTION ITEMS:`);
    for (const todo of todos) {
      const status = todo.resolved ? "[x]" : "[ ]";
      lines.push(`  ${status} ${todo.subject}`);
      lines.push(`      ${todo.contactName || todo.contactEmail || "Unknown"}`);
    }
    lines.push("");
  }

  const customerThreads = threads.filter((t) => t.category === "customer");
  const vendorThreads = threads.filter((t) => t.category === "vendor");

  if (customerThreads.length > 0) {
    lines.push(`CUSTOMERS:`);
    for (const thread of customerThreads) {
      lines.push(`  ${thread.subject}`);
      lines.push(`      ${thread.contactName || thread.contactEmail || "Unknown"}`);
      if (thread.summary) lines.push(`      ${thread.summary}`);
    }
    lines.push("");
  }

  if (vendorThreads.length > 0) {
    lines.push(`VENDORS:`);
    for (const thread of vendorThreads) {
      lines.push(`  ${thread.subject}`);
      lines.push(`      ${thread.contactName || thread.contactEmail || "Unknown"}`);
      if (thread.summary) lines.push(`      ${thread.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
