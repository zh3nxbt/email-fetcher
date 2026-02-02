/**
 * Alert Email Templates
 *
 * HTML templates for QB Sync Alert notifications:
 * - Hourly: New alerts + escalations
 * - Morning review: Full summary of open alerts
 */

import type { QbSyncAlert } from "@/db/schema";

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
    margin-top: 24px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e0e0e0;
  }
  .section-urgent {
    background-color: #fef2f2;
    border: 1px solid #ef4444;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .section-urgent h2 {
    color: #991b1b;
    margin-top: 0;
    border-bottom-color: #fca5a5;
  }
  .section-warning {
    background-color: #fffbeb;
    border: 1px solid #f59e0b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .section-warning h2 {
    color: #92400e;
    margin-top: 0;
    border-bottom-color: #fcd34d;
  }
  .section-info {
    background-color: #eff6ff;
    border: 1px solid #3b82f6;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .section-info h2 {
    color: #1e40af;
    margin-top: 0;
    border-bottom-color: #93c5fd;
  }
  .section-success {
    background-color: #f0fdf4;
    border: 1px solid #22c55e;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .section-success h2 {
    color: #166534;
    margin-top: 0;
    border-bottom-color: #86efac;
  }
  .alert-item {
    padding: 12px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .alert-item:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
  .alert-subject {
    font-weight: 500;
    color: #1a1a1a;
    font-size: 14px;
    margin-bottom: 4px;
  }
  .alert-meta {
    font-size: 13px;
    color: #666;
    margin-bottom: 4px;
  }
  .alert-details {
    font-size: 12px;
    color: #888;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    margin-right: 6px;
  }
  .badge-urgent {
    background-color: #fee2e2;
    color: #991b1b;
  }
  .badge-warning {
    background-color: #fef3c7;
    color: #92400e;
  }
  .badge-info {
    background-color: #dbeafe;
    color: #1e40af;
  }
  .badge-success {
    background-color: #dcfce7;
    color: #166534;
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
  .summary-stats {
    display: flex;
    gap: 16px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .stat-box {
    background-color: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 12px 16px;
    text-align: center;
    min-width: 80px;
  }
  .stat-number {
    font-size: 24px;
    font-weight: 600;
    color: #1a1a1a;
  }
  .stat-label {
    font-size: 11px;
    color: #6b7280;
    text-transform: uppercase;
  }
  .stat-box.urgent .stat-number { color: #dc2626; }
  .stat-box.warning .stat-number { color: #d97706; }
  .stat-box.success .stat-number { color: #16a34a; }
`;

function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCurrency(cents: number | null): string {
  if (cents === null) return "N/A";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTimeAgo(date: Date | null): string {
  if (!date) return "";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays}d ago`;
  } else if (diffHours > 0) {
    return `${diffHours}h ago`;
  } else {
    const diffMins = Math.floor(diffMs / (1000 * 60));
    return `${diffMins}m ago`;
  }
}

function renderAlertItem(alert: QbSyncAlert): string {
  const poInfo = alert.poNumber ? `PO# ${alert.poNumber}` : "";
  const amountInfo = alert.poTotal ? formatCurrency(alert.poTotal) : "";
  const detailParts = [poInfo, amountInfo].filter(Boolean).join(" • ");

  let soInfo = "";
  if (alert.salesOrderRef) {
    soInfo = `SO: ${alert.salesOrderRef}`;
    if (alert.salesOrderTotal) {
      soInfo += ` (${formatCurrency(alert.salesOrderTotal)})`;
    }
  }

  let estimateInfo = "";
  if (alert.estimateRef) {
    estimateInfo = `Est: ${alert.estimateRef}`;
  }

  const qbInfo = [soInfo, estimateInfo].filter(Boolean).join(" | ");

  return `
    <div class="alert-item">
      <div class="alert-subject">${escapeHtml(alert.subject)}</div>
      <div class="alert-meta">
        ${escapeHtml(alert.contactName || alert.contactEmail || "Unknown")}
        ${alert.qbCustomerName ? ` → ${escapeHtml(alert.qbCustomerName)}` : ""}
        <span style="color: #9ca3af; font-size: 12px;">· ${formatTimeAgo(alert.detectedAt)}</span>
      </div>
      ${detailParts ? `<div class="alert-details">${detailParts}</div>` : ""}
      ${qbInfo ? `<div class="alert-details">${qbInfo}</div>` : ""}
    </div>
  `;
}

export interface HourlyAlertData {
  newAlerts: QbSyncAlert[];
  escalations: QbSyncAlert[];
  resolved: QbSyncAlert[];
}

/**
 * Generate hourly alert email HTML
 */
export function generateHourlyAlertHtml(data: HourlyAlertData): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const totalNew = data.newAlerts.length;
  const totalEscalations = data.escalations.length;
  const totalResolved = data.resolved.length;

  if (totalNew === 0 && totalEscalations === 0 && totalResolved === 0) {
    return ""; // No content to send
  }

  // Categorize new alerts
  const urgentAlerts = data.newAlerts.filter(
    (a) => a.alertType === "po_missing_so" || a.alertType === "suspicious_po_email"
  );
  const newPOs = data.newAlerts.filter(
    (a) => a.alertType === "po_detected" || a.alertType === "po_detected_with_so"
  );
  const noCustomer = data.newAlerts.filter((a) => a.alertType === "no_qb_customer");
  const soIssues = data.newAlerts.filter((a) => a.alertType === "so_should_be_closed");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QB Sync Alert - ${timeStr}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="container">
    <h1>QB Sync Alert</h1>
    <div style="font-size: 13px; color: #666; margin-bottom: 16px;">
      ${dateStr} at ${timeStr}
    </div>

    ${data.escalations.length > 0 ? `
    <div class="section-urgent">
      <h2>Escalations (${data.escalations.length})</h2>
      ${data.escalations.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${urgentAlerts.length > 0 ? `
    <div class="section-urgent">
      <h2>Urgent</h2>
      ${urgentAlerts.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${noCustomer.length > 0 ? `
    <div class="section-warning">
      <h2>Unknown Customer (${noCustomer.length})</h2>
      ${noCustomer.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${newPOs.length > 0 ? `
    <div class="section-info">
      <h2>New POs (${newPOs.length})</h2>
      ${newPOs.map((alert) => {
        const badge = alert.alertType === "po_detected_with_so"
          ? '<span class="badge badge-success">Has SO</span>'
          : '<span class="badge badge-warning">No SO</span>';
        return `
          <div class="alert-item">
            ${badge}
            <span class="alert-subject">${escapeHtml(alert.subject)}</span>
            <div class="alert-meta">
              ${escapeHtml(alert.contactName || alert.contactEmail || "Unknown")}
              ${alert.qbCustomerName ? ` → ${escapeHtml(alert.qbCustomerName)}` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
    ` : ""}

    ${soIssues.length > 0 ? `
    <div class="section-warning">
      <h2>SO Should Be Closed (${soIssues.length})</h2>
      ${soIssues.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${data.resolved.length > 0 ? `
    <div class="section-success">
      <h2>Auto-Resolved (${data.resolved.length})</h2>
      ${data.resolved.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    <div class="footer">
      QB Sync Alert · ${dateStr} ${timeStr}
    </div>
  </div>
</body>
</html>
  `;
}

export interface MorningSummaryData {
  poDetected: QbSyncAlert[];
  poWithSo: QbSyncAlert[];
  poMissingSo: QbSyncAlert[];
  noQbCustomer: QbSyncAlert[];
  suspiciousEmail: QbSyncAlert[];
  soShouldBeClosed: QbSyncAlert[];
}

/**
 * Generate morning review email HTML
 */
export function generateMorningReviewHtml(data: MorningSummaryData): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const totalOpen =
    data.poDetected.length +
    data.poMissingSo.length +
    data.noQbCustomer.length +
    data.suspiciousEmail.length +
    data.soShouldBeClosed.length;

  const hasUrgent = data.poMissingSo.length > 0 || data.suspiciousEmail.length > 0;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QB Sync Morning Review - ${dateStr}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="container">
    <h1>${dateStr} - QB Sync Morning Review</h1>

    <div class="summary-stats">
      <div class="stat-box ${hasUrgent ? 'urgent' : ''}">
        <div class="stat-number">${totalOpen}</div>
        <div class="stat-label">Open Alerts</div>
      </div>
      <div class="stat-box urgent">
        <div class="stat-number">${data.poMissingSo.length}</div>
        <div class="stat-label">Overdue SOs</div>
      </div>
      <div class="stat-box warning">
        <div class="stat-number">${data.poDetected.length}</div>
        <div class="stat-label">Pending</div>
      </div>
      <div class="stat-box success">
        <div class="stat-number">${data.poWithSo.length}</div>
        <div class="stat-label">With SO</div>
      </div>
    </div>

    ${data.poMissingSo.length > 0 ? `
    <div class="section-urgent">
      <h2>Overdue - No Sales Order (${data.poMissingSo.length})</h2>
      <p style="font-size: 12px; color: #991b1b; margin: 0 0 12px 0;">
        These POs have been waiting 4+ hours for a Sales Order
      </p>
      ${data.poMissingSo.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${data.suspiciousEmail.length > 0 ? `
    <div class="section-urgent">
      <h2>Suspicious Emails (${data.suspiciousEmail.length})</h2>
      <p style="font-size: 12px; color: #991b1b; margin: 0 0 12px 0;">
        POs from untrusted domains - review manually
      </p>
      ${data.suspiciousEmail.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${data.noQbCustomer.length > 0 ? `
    <div class="section-warning">
      <h2>Unknown Customer (${data.noQbCustomer.length})</h2>
      <p style="font-size: 12px; color: #92400e; margin: 0 0 12px 0;">
        Could not match email to QuickBooks customer
      </p>
      ${data.noQbCustomer.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${data.poDetected.length > 0 ? `
    <div class="section-info">
      <h2>Pending - Awaiting SO (${data.poDetected.length})</h2>
      <p style="font-size: 12px; color: #1e40af; margin: 0 0 12px 0;">
        Recent POs that don't have a Sales Order yet
      </p>
      ${data.poDetected.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${data.soShouldBeClosed.length > 0 ? `
    <div class="section-warning">
      <h2>SO Should Be Closed (${data.soShouldBeClosed.length})</h2>
      <p style="font-size: 12px; color: #92400e; margin: 0 0 12px 0;">
        Fully invoiced Sales Orders that are still open
      </p>
      ${data.soShouldBeClosed.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${data.poWithSo.length > 0 ? `
    <div class="section-success">
      <h2>All Good - POs with SO (${data.poWithSo.length})</h2>
      <p style="font-size: 12px; color: #166534; margin: 0 0 12px 0;">
        Recent POs that already have matching Sales Orders
      </p>
      ${data.poWithSo.map(renderAlertItem).join("")}
    </div>
    ` : ""}

    ${totalOpen === 0 && data.poWithSo.length === 0 ? `
    <div class="empty-state" style="text-align: center; padding: 40px;">
      <div style="font-size: 48px; margin-bottom: 16px;">✓</div>
      <div style="font-size: 16px; color: #16a34a; font-weight: 500;">All caught up!</div>
      <div style="font-size: 13px; color: #666;">No pending QB sync alerts</div>
    </div>
    ` : ""}

    <div class="footer">
      QB Sync Morning Review · ${dateStr}
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate plain text summary for console preview
 */
export function generatePlainTextSummary(data: MorningSummaryData): string {
  const lines: string[] = [];

  lines.push("\n=== QB Sync Alert Summary ===\n");

  if (data.poMissingSo.length > 0) {
    lines.push(`OVERDUE (${data.poMissingSo.length}):`);
    for (const alert of data.poMissingSo) {
      lines.push(`  ! ${alert.subject}`);
      lines.push(`    ${alert.contactName || alert.contactEmail} - ${formatTimeAgo(alert.detectedAt)}`);
    }
    lines.push("");
  }

  if (data.suspiciousEmail.length > 0) {
    lines.push(`SUSPICIOUS (${data.suspiciousEmail.length}):`);
    for (const alert of data.suspiciousEmail) {
      lines.push(`  ? ${alert.subject}`);
      lines.push(`    ${alert.contactEmail}`);
    }
    lines.push("");
  }

  if (data.noQbCustomer.length > 0) {
    lines.push(`NO QB CUSTOMER (${data.noQbCustomer.length}):`);
    for (const alert of data.noQbCustomer) {
      lines.push(`  - ${alert.subject}`);
      lines.push(`    ${alert.contactEmail}`);
    }
    lines.push("");
  }

  if (data.poDetected.length > 0) {
    lines.push(`PENDING (${data.poDetected.length}):`);
    for (const alert of data.poDetected) {
      lines.push(`  - ${alert.subject}`);
      lines.push(`    ${alert.contactName || alert.contactEmail} → ${alert.qbCustomerName || "?"}`);
    }
    lines.push("");
  }

  if (data.soShouldBeClosed.length > 0) {
    lines.push(`SO SHOULD BE CLOSED (${data.soShouldBeClosed.length}):`);
    for (const alert of data.soShouldBeClosed) {
      lines.push(`  - ${alert.salesOrderRef} (Invoice: ${alert.invoiceRef})`);
    }
    lines.push("");
  }

  if (data.poWithSo.length > 0) {
    lines.push(`WITH SO (${data.poWithSo.length}):`);
    for (const alert of data.poWithSo) {
      lines.push(`  ✓ ${alert.subject} → SO ${alert.salesOrderRef}`);
    }
    lines.push("");
  }

  const total =
    data.poMissingSo.length +
    data.suspiciousEmail.length +
    data.noQbCustomer.length +
    data.poDetected.length +
    data.soShouldBeClosed.length;

  if (total === 0 && data.poWithSo.length === 0) {
    lines.push("All caught up! No pending alerts.\n");
  }

  return lines.join("\n");
}
