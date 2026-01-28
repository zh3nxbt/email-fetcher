# Email Report System - Implementation Plan

## Summary

A **Daily Report Generation System** for MAS Precision Parts that:
- Monitors customer and vendor emails via IMAP
- Uses **Claude Haiku** to categorize threads and extract PO details
- Generates two scheduled email reports:
  - **4pm EST**: Full daily summary (metrics, categorized threads, PO details, action items)
  - **7am EST**: Morning reminder (pending todos + overnight email summary)

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   IMAP Server   │────▶│  Sync Service    │────▶│    Database     │
│   (Bluehost)    │     │                  │     │   (Supabase)    │
└─────────────────┘     └────────┬─────────┘     └────────┬────────┘
                                 │                        │
                                 ▼                        ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │  Claude Haiku   │     │  Report Email   │
                        │  (Categorizer)  │     │  (SMTP Output)  │
                        └─────────────────┘     └─────────────────┘
```

---

## Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js + TypeScript |
| Framework | Next.js 15 (App Router) |
| Database | Supabase PostgreSQL + Drizzle ORM |
| IMAP | imapflow + mailparser |
| AI Classification | Claude Haiku (@anthropic-ai/sdk) - batch mode |
| PDF Parsing | pdf-parse |
| Email Sending | Nodemailer (SMTP) |
| Timezone | date-fns-tz |
| UI Components | shadcn/ui + Tailwind CSS |

---

## Database Schema

All tables prefixed with `email_`:

### `email_messages` - Raw email records
- `id`, `uid`, `message_id`
- `from_address`, `from_name`, `to_addresses`
- `subject`, `body_text`, `date`
- `in_reply_to`, `references`, `mailbox`
- `has_attachments`, `attachments`
- `synced_at`

### `email_daily_reports` - Generated reports
- `id`, `report_date`, `report_type` (daily_summary | morning_reminder)
- `emails_received`, `emails_sent`
- `generated_at`, `sent_at`
- `report_html`

### `email_report_threads` - Categorized thread summaries per report
- `id`, `report_id` (FK)
- `thread_key` (normalized subject/messageId)
- `category` (customer | vendor | other)
- `item_type` (po_sent | po_received | quote_request | general | other)
- `contact_email`, `contact_name`
- `subject`, `summary` (AI generated)
- `email_count`, `last_email_date`, `last_email_from_us`
- `po_details` (JSONB - extracted PO info)

### `email_todo_items` - Action items
- `id`, `report_id` (FK), `thread_key`
- `todo_type` (po_unacknowledged | quote_unanswered | general_unanswered)
- `description`, `contact_email`, `contact_name`
- `original_date`, `subject`
- `resolved`, `resolved_at`

---

## Report Time Windows

### 4pm Daily Summary
- **Window**: 7am EST same day → 4pm EST same day
- **Considers**: 7am morning report todos + emails from 7am-4pm
- **Shows**:
  - Resolved todos (struck out) from morning report
  - New todos from daytime emails
  - Categorized threads (Customer, Vendor, Other)
  - PO details extracted from PDFs

### 7am Morning Reminder
- **Window**: 4pm EST previous day → 7am EST current day
- **Considers**: Previous day's 4pm report todos + overnight emails
- **Shows**:
  - Pending todos (struck out if resolved overnight)
  - Overnight email summary

---

## File Structure

```
src/
  db/
    schema.ts          # Drizzle schema (PostgreSQL)
    index.ts           # Database connection
    reset.ts           # Clear all data
  imap/
    client.ts          # IMAP connection helpers
    parsers.ts         # MIME parsing utilities
  sync/
    syncer.ts          # Email sync from IMAP
    threader.ts        # Thread grouping logic
    run-sync.ts        # CLI entry point
  report/
    types.ts           # TypeScript interfaces
    categorizer.ts     # Thread categorization (customer/vendor/other)
    summarizer.ts      # AI prompts for categorization & summaries
    pdf-extractor.ts   # PDF attachment parsing for PO details
    todo-analyzer.ts   # Identify action items
    templates.ts       # HTML email templates
    email-sender.ts    # Nodemailer SMTP
    generator.ts       # Report orchestration
    run-report.ts      # CLI entry point
```

---

## Commands

```bash
npm run sync             # Fetch emails from IMAP
npm run report           # Generate 4pm daily summary
npm run report:morning   # Generate 7am morning reminder
npm run report -- --preview    # Preview without sending
npm run report -- --date=2024-01-15  # Historical report
npm run db:reset         # Clear all data
npm run db:push          # Push schema to database
```

---

## Environment Variables

```env
# IMAP
IMAP_HOST=mail.example.com
IMAP_PORT=993
IMAP_USER=sales@masprecisionparts.com
IMAP_PASS=...

# Database
DATABASE_URL=postgresql://...

# AI
ANTHROPIC_API_KEY=...

# Reports
REPORT_TIMEZONE=America/New_York
REPORT_RECIPIENT=manager@masprecisionparts.com

# SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="MAS Reports <reports@example.com>"
```

---

## Scheduling

Use Windows Task Scheduler or cron:
- `npm run report` at 4pm EST daily
- `npm run report:morning` at 7am EST daily

---

## Report Flow

### 4pm Daily Summary Generation
1. Get todos from same-day 7am morning report
2. Check which todos are resolved by 7am-4pm email activity
3. Fetch and categorize emails from 7am-4pm window
4. Extract PO details from vendor thread PDFs
5. Identify new todos from daytime threads
6. Generate HTML with: resolved todos + new todos + thread summaries
7. Save to database and send via email

### 7am Morning Reminder Generation
1. Get todos from previous day's 4pm report
2. Check which todos are resolved by overnight (4pm-7am) email activity
3. Categorize overnight emails
4. Generate HTML with: pending todos (resolved struck out) + overnight summary
5. Save to database and send via email

---

## Key Business Rules

See `devDocs/classification-logic.md` for detailed classification rules including:
- Customer vs Vendor determination
- Item type detection (PO, Quote Request, General)
- Todo identification logic
- Priority assignment

---

## Technical Implementation Notes

### Batch AI Categorization

Thread categorization uses batch API calls for efficiency:
- **Batch size**: Up to 20 threads per API call
- **Body truncation**: 500 chars in batch mode (vs 1500 for single thread)
- **Fallback**: If batch fails, falls back to individual calls
- **Efficiency**: 15 threads = 1 API call instead of 15

```
categorizeThreads() → categorizeThreadsWithBatch() → categorizeThreadsBatch()
                                                   ↘ (fallback) categorizeThreadWithAI()
```

**AI returns additional fields:**
- `needsResponse`: false for "thanks", "sounds good" messages (prevents false positive todos)
- `relatedTo`: threadKey if this thread is a response to another thread (enables cross-thread merging)

### Thread Grouping (3-Pass Algorithm)

Located in `src/sync/threader.ts`:

1. **Pass 1 - Message-ID/References**: Standard email threading via References header
2. **Pass 2 - In-Reply-To**: Fallback for emails with In-Reply-To but broken References
3. **Pass 3 - Subject-based**: Merges threads with same normalized subject (handles "RE: PO 1049" + "PO 1049")

Additionally, in `src/report/categorizer.ts`:
- **AI relatedTo merging**: Merges threads that are semantically related but have different subjects
- Example: "RFQ Plates" (our request) + "Estimate 28522 from Valk's Machinery" (vendor response via QuickBooks)

### Web UI Dashboard

Located at `src/app/page.tsx`:

**Features:**
- Date navigation (prev/next buttons + dropdown)
- Report type toggle (7am Morning / 4pm Summary)
- Inline HTML report display
- "Generate Report" button

**Generate Report Button:**
- Calls `POST /api/generate-report`
- Syncs emails first
- Determines report type based on current EST time:
  - 7am-4pm → `daily_summary` (4pm report)
  - 4pm-7am → `morning_reminder` (7am report)
- Replaces existing report for same date/type

### IMAP Server Configuration

MAS Precision Parts uses Dovecot IMAP with these mailboxes:
- `INBOX` - incoming emails
- `INBOX.Sent` (alias: "Sent") - primary sent folder
- `INBOX.Sent Messages` (alias: "Sent Messages") - secondary sent folder

**Important**: Both sent folders must be synced to capture all outbound emails.

### Timezone Handling

- **Database**: Stores UTC timestamps
- **Display**: Always convert to EST using `timeZone: "America/New_York"`
- **Report windows**: Calculated in EST, converted to UTC for queries
- **CLI dates**: Use `--date=YYYY-MM-DDTHH:MM:SS` format to avoid timezone shift

### IMAP SINCE Search

IMAP `SINCE` is date-only (ignores time). For precise datetime filtering:
1. Use SINCE to get approximate range from server
2. Post-filter in database with exact datetime cutoff

---

## Edge Cases & Gotchas

### Customer vs Vendor Classification

**Problem:** Simple "first email = direction" rule fails for invoices/quotations.

**Solution:** Check subject content before defaulting to direction-based classification:
```typescript
// In categorizer.ts - determineInitialCategory()
if (isOutbound(firstEmail)) {
  // Invoice/quotation/quote/estimate sent BY US = Customer (we're billing them)
  if (subject.includes("invoice") || subject.includes("quotation") || ...) {
    return "customer";
  }
  // PO/RFQ sent BY US = Vendor (we're buying)
  return "vendor";
}
```

### Acknowledgment Detection

**Problem:** "Great thanks!" emails with signature images appeared to have attachments, triggering false "needs response" flags.

**Solution:** Distinguish real attachments from signature images:
```typescript
function hasRealAttachments(email: Email): boolean {
  // Skip small images (<100KB) - likely signature images
  // Look for PDFs, documents, large files
}
```

**Problem:** "Thank you and kind regards" was matching acknowledgment patterns.

**Solution:** Use strict patterns that match ONLY the acknowledgment phrase:
```typescript
const strictAckPatterns = [
  /^(great )?thanks?!?\.?$/,  // Must match entire string
  /^thank you!?\.?$/,
  // NOT: /^thank you/ (would match "Thank you, please find attached...")
];
```

### Todo Resolution

**Problem:** Customer's "Great thanks!" after our reply was un-resolving todos (last email wasn't from us).

**Solution:** Check if we replied ANYWHERE in the thread, not just if last email is from us:
```typescript
// In generator.ts - checkResolvedTodos()
const weRepliedInWindow = threadEmails.some(email => isOutbound(email));
if (weRepliedInWindow) {
  resolvedIds.add(todo.id);
}
```

### PO Detection

**Problem:** AI sometimes classifies obvious POs as "general".

**Solution:** Post-process AI results with subject pattern matching:
```typescript
// In categorizer.ts
if (category === "customer" && itemType === "general") {
  if (subject.includes("po number") || /\bpo\d{5,}/i.test(subject)) {
    itemType = "po_received";
  }
}
```

### SMTP Self-Signed Certificates

**Problem:** `Error: self signed certificate` when sending emails.

**Solution:** Add TLS config to nodemailer:
```typescript
tls: { rejectUnauthorized: false }
```

### Email Template Styling

**Problem:** CSS classes stripped by email clients, colors not showing.

**Solution:** Always use inline styles for colors:
```html
<!-- Wrong -->
<span class="label-po">PO Received</span>

<!-- Correct -->
<span style="color: #059669;">PO Received</span>
```
