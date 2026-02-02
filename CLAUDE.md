# Claude Code Instructions

## Project Overview

Email sync and **daily report generation system** for **MAS Precision Parts** - a precision parts manufacturing company. Syncs emails via IMAP, categorizes into threads, and generates scheduled reports:

- **7am EST**: Morning reminder (overnight emails + pending todos from yesterday)
- **12pm EST**: Midday update (morning emails + todo status update)
- **4pm EST**: Full daily summary (afternoon emails + final todo status)

## Critical Business Logic

### Who is MAS Precision Parts?
- **We are MAS Precision Parts** (sales@masprecisionparts.com)
- Emails FROM us are **outgoing** (we're sending to customers or vendors)
- Emails TO us are **incoming** (from customers or vendors)

### Customer vs Vendor Distinction
This is the MOST IMPORTANT classification rule:

| Scenario | Category | Item Type |
|----------|----------|-----------|
| Customer sends US a PO | customer | po_received |
| WE send a PO to vendor | vendor | po_sent |
| Customer asks US for quote | customer | quote_request |
| WE ask vendor for quote | vendor | general |
| **WE send invoice to customer** | **customer** | general |
| **WE send quotation/quote/estimate** | **customer** | general |
| Thread starts with [RECEIVED] | customer | (they initiated) |
| Thread starts with [SENT] PO/RFQ | vendor | (we're buying) |

**Key rules:**
- When WE send an **invoice, quotation, quote, or estimate** → it's a **CUSTOMER** interaction (we're billing/quoting them)
- When WE send a **PO or RFQ** → it's a **VENDOR** interaction (we're buying from them)
- The simple "first email direction = category" rule has exceptions for invoices/quotes!

### Action Items (Todos)
Todos are identified when:
1. **po_unacknowledged**: Customer sent PO, we haven't replied
2. **quote_unanswered**: Customer requested quote, we haven't replied
3. **general_unanswered**: Customer email, last message is from them
4. **vendor_followup**: Vendor asked a follow-up question (e.g., we sent RFQ, vendor needs clarification)

**Important:** AI also checks `needsResponse` - if the last email is "thanks", "sounds good", or similar acknowledgment, no todo is created even if the last email is from the customer/vendor.

### Acknowledgment Detection

The system detects simple acknowledgment emails that don't need a response:
- "Thanks!", "Thank you!", "Great thanks!"
- "Got it!", "Sounds good!", "Perfect!"
- "Received!", "Noted!", "Will do!"

**Key edge cases handled:**
1. **Signature images ≠ real attachments**: Emails often have signature images that appear as "attachments". These are detected by:
   - Small file size (<100KB)
   - Image content types (PNG, JPEG, GIF)
   - Real attachments are PDFs, documents, large files
2. **"Thank you and kind regards" ≠ acknowledgment**: Polite closings with attachments (like a PO) are NOT acknowledgments
3. **Customer "thanks" after our reply**: If customer says "Great thanks!" after we acknowledge their PO, the todo is RESOLVED (we replied)

### PO Detection Fallback

If AI misclassifies a PO as "general", the system detects POs from subject patterns:
- "PO number", "PO attached", "PO#"
- "Purchase order"
- Patterns like "PO 12345", "PO00221"

### Todo Resolution Logic

A todo is resolved in two ways:

**1. Automatic Resolution (email activity):**
- When **we send ANY email** in that thread during the time window
- Customer sends PO → We acknowledge → Customer says "Thanks!" → **TODO IS RESOLVED** (we replied)

**2. Manual Dismissal (user clicks "Mark Complete"):**
- Adds threadKey to `dismissed_threads` table (persists across report regeneration)
- Future reports will NOT recreate todos for dismissed threadKeys
- Can be un-dismissed via `DELETE /api/dismissed-threads` with `{ threadKey }`

**Why two mechanisms?**
- Auto-resolution is based on email activity in current report window
- Manual dismissal is permanent until explicitly un-dismissed
- This prevents manually resolved todos from reappearing when customers send follow-up emails

### UI Labels
- **Todo labels**: "Need to Ack PO", "Need to Send Quote", "Need to Reply", "Reply to Vendor"
- **Thread labels**: "PO Received", "PO Sent", "RFQ", "General"
- **Sort order**: PO Received/Sent → RFQ → General → Other

## Technical Learnings

### Email Fetching (IMAP)

**DO:**
```typescript
// Use mailparser for proper MIME decoding
import { simpleParser } from "mailparser";
const msg = await client.fetchOne(uid, { source: true }, { uid: true });
const parsed = await simpleParser(msg.source);
// parsed.text is already decoded (base64, quoted-printable, charset)
```

**DON'T:**
```typescript
// DON'T use download() - it hangs
const { content } = await client.download(uid, part); // HANGS!

// DON'T nest fetchOne inside fetch iterator - causes IMAP command conflicts
for await (const msg of client.fetch(uids, {...})) {
  await client.fetchOne(msg.uid, {...}); // HANGS!
}
```

**Correct pattern:** Collect UIDs first, then fetch individually:
```typescript
const uidsToSync = [...]; // Get list first
for (const uid of uidsToSync) {
  const msg = await client.fetchOne(uid, { source: true }, { uid: true });
}
```

### IMAP Mailbox Names

MAS server uses Dovecot with `INBOX.` prefix and `.` separator:
- **INBOX** - main inbox
- **INBOX.Sent** (aliased as "Sent") - primary sent folder
- **INBOX.Sent Messages** (aliased as "Sent Messages") - secondary sent folder

**Important:** Both "Sent" and "Sent Messages" folders contain sent emails. The syncer fetches from both.

### IMAP SINCE Search Limitation

IMAP `SINCE` search is **date-only** (ignores time). To filter by datetime:
```typescript
// IMAP search returns all emails from the date onwards
const searchResult = await client.search({ since: sinceDate }, { uid: true });

// Post-filter in database if precise datetime cutoff needed
await db.delete(schema.emails).where(lt(schema.emails.date, cutoffDate));
```

### Timezone Handling

**Always use explicit timezone for EST display:**
```typescript
// CORRECT - explicit timezone
date.toLocaleDateString("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
});

// WRONG - uses system timezone
date.toLocaleDateString("en-US", { ... });
```

### CLI Date Argument Parsing

When passing dates via CLI, include time to avoid timezone shift:
```bash
# CORRECT - explicit time prevents UTC midnight issues
npm run report -- --date=2026-01-26T12:00:00

# WRONG - 2026-01-26 becomes Jan 25 in EST due to UTC midnight
npm run report -- --date=2026-01-26
```

### Process Management

Always add `process.exit(0)` at end of CLI scripts - database connection keeps Node process alive.

### References Field

`parsed.references` from mailparser can be string OR array:
```typescript
references: Array.isArray(parsed.references)
  ? parsed.references.join(" ")
  : parsed.references || null
```

### Next.js Hydration Warnings

Browser extensions can cause hydration mismatch warnings. Add `suppressHydrationWarning` to html/body:
```tsx
<html lang="en" suppressHydrationWarning>
  <body suppressHydrationWarning>
```

### SMTP Email Sending

**Self-signed certificates:** Some SMTP servers use self-signed TLS certificates. Handle with:
```typescript
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: {
    rejectUnauthorized: false, // Allow self-signed certs
  },
});
```

**Email syncing before report:** The `npm run report` command automatically syncs emails before generating. This ensures the report has the latest data.

### Email Template Styling

**Use inline styles for colors!** Email clients often strip `<style>` tags and CSS classes. Always use inline styles:
```typescript
// WRONG - CSS classes may be stripped
<div class="thread-label po">PO Received</div>

// CORRECT - inline styles work everywhere
<div style="color: #059669;">PO Received</div>
```

**Label colors:**
- PO Received: green (#059669)
- PO Sent: purple (#7c3aed)
- RFQ: blue (#2563eb)
- General: gray (#6b7280)
- Need to Ack PO: red (#dc2626)
- Need to Send Quote / Need to Reply: orange (#d97706)

### AI Classification

Thread categorization uses **Sonnet only** for reliable business email classification:
- Simplified business-context prompt (~40 lines vs 100+ previously)
- Body truncation: 800 chars in batch mode, 1500 for single
- Up to 20 threads per API call, falls back to individual calls if batch fails
- See `src/report/summarizer.ts` → `categorizeThreadsBatch()`

AI returns additional fields for each thread:
- **needsResponse**: `false` if last email is "thanks", "sounds good", etc.
- **relatedTo**: threadKey if this thread responds to another (e.g., vendor quote responding to our RFQ)

Post-AI processing uses only **definitional constraints** (not pattern heuristics):
- `po_received` → must be `customer` (they sent us PO)
- `po_sent` → must be `vendor` (we sent them PO)
- `quote_request` from us → must be `vendor` (we're buying)

### PDF Attachment Analysis

PDF attachments are analyzed using **Claude's visual PDF analysis** (not text extraction):
- PDFs are sent as base64 to Claude, which "sees" the document visually
- This preserves tables, formatting, and can read scanned/image-based PDFs
- See `src/report/pdf-extractor.ts` → `analyzePdfWithVision()`

**IMAP base64 decoding:** When fetching PDF attachments from IMAP, the content is often still base64-encoded. The code checks for the PDF magic number (`%PDF`) and decodes if needed:
```typescript
const first4 = rawContent.slice(0, 4).toString("ascii");
if (first4 !== "%PDF") {
  content = Buffer.from(rawContent.toString("ascii"), "base64");
}
```

**TODO:** Add DOCX support - Claude doesn't support DOCX directly. Options:
1. Convert DOCX to PDF before analysis
2. Use `mammoth` library to extract content as HTML/text

### Thread Grouping

Threads are grouped using three passes (`src/sync/threader.ts`):
1. **Message-ID/References**: Standard email threading
2. **In-Reply-To**: Fallback for broken references
3. **Subject-based**: Merges threads with same normalized subject (handles "RE: PO 1049" + "PO 1049")

Additionally, AI-detected `relatedTo` relationships merge threads that are semantically related but have different subjects (e.g., "RFQ Plates" → "Estimate 28522 from Valk's Machinery").

### Web UI Report Generation

The dashboard has a "Generate Report" button that:
- Syncs emails first
- Determines report type based on current EST time:
  - 7am-4pm → generates `daily_summary` (4pm report)
  - 4pm-7am → generates `morning_reminder` (7am report)
- Replaces existing report for same date/type
- API endpoint: `POST /api/generate-report`

## QuickBooks Integration

The system integrates with QuickBooks Desktop via Conductor.is API to verify POs against Sales Orders.

### Sync Analyzer Flow

When a customer sends a PO email (`po_received`), the sync analyzer:

1. **Trusted Domain Check**: Filters out emails from untrusted domains (phishing protection)
   - Sources: domains we've emailed, manual whitelist, QB customer emails
2. **PDF Analysis**: Extracts PO# and total from PDF attachments using Claude vision
3. **Customer Matching**: Fuzzy matches email contact to QB customer
4. **Sales Order Check**: Looks for matching SO by PO# or amount
5. **Estimate Fallback**: If no SO, checks for matching estimate

### Alert Types (2-Stage Model)

The system uses a 2-stage alert model with persistence:

**Stage 1 (Immediate - on PO detection):**
| Alert Type | Trigger | Action |
|------------|---------|--------|
| `po_detected` | New PO, no SO yet | Watch for SO creation |
| `po_detected_with_so` | New PO, SO already exists | None (informational) |
| `no_qb_customer` | Can't match email to QB customer | Add customer to QB |
| `suspicious_po_email` | Untrusted domain | Review manually |

**Stage 2 (Escalation - 4 hours after Stage 1):**
| Alert Type | Trigger | Action |
|------------|---------|--------|
| `po_missing_so` | 4+ hours since detection, still no SO | Create SO urgently |

**Invoice/SO Integrity:**
| Alert Type | Trigger | Action |
|------------|---------|--------|
| `so_should_be_closed` | Invoice exists, SO open, Invoice >= SO total | Close SO in QB |

**Alert Lifecycle:**
```
PO email arrives → po_detected (Stage 1)
    ↓ [4 hours, no SO]
po_missing_so (Stage 2)
    ↓ [SO created in QB]
Auto-resolved
```

**Auto-resolution triggers:**
- `po_detected` → Resolves when SO appears (before escalation)
- `po_missing_so` → Resolves when SO appears
- `no_qb_customer` → Resolves when customer added to QB

**Legacy alert types** (from Phase 4, console-only):
| Alert | Meaning |
|-------|---------|
| `po_has_so` | PO matches existing Sales Order |
| `po_no_so_has_estimate` | PO received, no SO, but found estimate |
| `po_no_so_no_estimate` | PO received, nothing in QB |

### Trusted Domain Sources

1. **Sent email recipients**: Domains we've emailed are auto-trusted
2. **Manual whitelist**: `TRUSTED_DOMAINS=newvendor.com,legitcustomer.ca`
3. **QB customer emails**: Domains from cached QB customer list

### Customer Cache

QB customer list is cached locally (`data/qb-customers.json`) with 24-hour TTL:
- Reduces API calls during analysis
- Powers QB customer domain trust filter
- Refresh manually: `npm run qb:refresh-customers`

### Customer Matching

Fuzzy matching with confidence levels:
- **exact**: Email matches QB customer email exactly
- **high**: Name variations match (e.g., "TNT Tools" vs "T.N.T. TOOLS 2025 INC")
- **medium**: Fuzzy match ≥70% similarity
- **low**: Email domain matches company name

### Morning Review

The morning review (`npm run jobs:check --morning`) provides a full summary:
- Overnight PO detections (since 4pm yesterday)
- All open escalations ("still no SO")
- Outstanding `no_qb_customer` alerts
- Suspicious email warnings
- SOs that should be closed (fully invoiced but still open)

### Files

```
src/quickbooks/
  conductor-client.ts    # Conductor.is API wrapper
  customer-matcher.ts    # Fuzzy customer matching
  customer-cache.ts      # 24h cached customer list
  job-documents.ts       # SO/Invoice/Estimate fetching + matching
  invoice-so-matcher.ts  # LLM-based line item matching
  trusted-domains.ts     # Domain trust filter
  types.ts               # QB entity types
src/jobs/
  sync-analyzer.ts       # Main PO→QB comparison logic (legacy)
  alert-manager.ts       # Alert persistence, escalation, resolution
  alert-templates.ts     # HTML email templates for alerts
  run-jobs-report.ts     # CLI entry point for jobs:check
  test-sync-analyzer.ts  # Test script
```

## Commands

```bash
npm run dev              # Start Next.js server
npm run sync             # Fetch emails from IMAP
npm run report           # Generate 4pm daily summary
npm run report:morning   # Generate 7am morning reminder
npm run report:midday    # Generate 12pm midday report
npm run report -- --preview  # Preview without sending
npm run report -- --date=2024-01-15  # Historical report
npm run db:reset         # Clear all data
npm run db:push          # Push schema to database
npm run qb:test          # Test QuickBooks connection
npm run qb:refresh-customers  # Force refresh QB customer cache
npm run qb:sync-analyze  # Test sync analyzer with real data
npm run jobs:check       # Run QB sync alert check (hourly)
npm run jobs:check -- --preview   # Preview alerts without sending
npm run jobs:check -- --morning   # Morning review mode
```

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
ALERT_RECIPIENT=reports@masprecisionparts.com  # QB sync alerts (falls back to REPORT_RECIPIENT)

# SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="MAS Reports <reports@example.com>"

# QuickBooks (via Conductor.is)
CONDUCTOR_API_KEY=...
CONDUCTOR_END_USER_ID=...

# Optional: Manual trusted domains (comma-separated)
TRUSTED_DOMAINS=newvendor.com,legitcustomer.ca
```

## File Structure

```
src/
  app/
    page.tsx               # Dashboard UI (report viewer + generate button)
    api/
      generate-report/     # POST - sync + generate report based on time
      reports/             # GET - list reports, GET [id] - single report
      sync/                # POST - email sync only
  db/
    schema.ts              # Database schema (emails, reports, todos)
    index.ts               # Database connection
    reset.ts               # Clear all data
  imap/
    client.ts              # IMAP connection helpers
    parsers.ts             # MIME parsing utilities
  sync/
    syncer.ts              # Email sync from IMAP
    threader.ts            # Thread grouping logic (3-pass: msgId, inReplyTo, subject)
    run-sync.ts            # CLI entry point
  report/
    types.ts               # TypeScript interfaces (CategorizedThread, CategorizationResult)
    categorizer.ts         # Thread categorization + AI relatedTo merging
    summarizer.ts          # AI prompts for batch categorization
    pdf-extractor.ts       # PDF attachment parsing for PO details
    todo-analyzer.ts       # Identify action items (checks needsResponse)
    templates.ts           # HTML email templates + labels + sorting
    email-sender.ts        # Nodemailer SMTP
    generator.ts           # Report orchestration
    run-report.ts          # CLI entry point
  quickbooks/
    conductor-client.ts    # Conductor.is REST API wrapper
    customer-matcher.ts    # Fuzzy email→QB customer matching
    customer-cache.ts      # 24h TTL cache for QB customer list
    job-documents.ts       # Fetch SOs/invoices/estimates, find matches
    trusted-domains.ts     # Domain trust filter (sent emails + whitelist + QB)
    types.ts               # QB entity types (Customer, SO, Invoice, Estimate)
    test-connection.ts     # CLI to test QB connection
    refresh-cache.ts       # CLI to force-refresh customer cache
  jobs/
    sync-analyzer.ts       # PO→QB comparison, generates alerts
    test-sync-analyzer.ts  # CLI to test sync analyzer
data/
  qb-customers.json        # Cached QB customer list (auto-generated)
```

## Database Schema

- **email_messages**: Raw synced emails
- **daily_reports**: Generated reports with metrics and HTML
- **report_threads**: Categorized thread summaries per report
- **todo_items**: Action items identified in reports
- **dismissed_threads**: Manually dismissed threadKeys (persists across report regeneration)
- **qb_sync_alerts**: QB sync alerts with 2-stage lifecycle (Phase 6)

## Scheduling

Use Windows Task Scheduler or cron:
- `npm run report:morning` at 7am EST daily
- `npm run report:midday` at 12pm EST daily
- `npm run report` at 4pm EST daily
- `npm run jobs:check --morning` at 7am or 9am EST daily (QB sync morning review)
- `npm run jobs:check` hourly 9am-4pm EST (QB sync incremental alerts)

### Todo Chain Flow

Todos carry over through the day in this sequence:
```
4pm → 7am (next day) → 12pm → 4pm → 7am (next day)
```

Each report checks if todos were resolved by email activity in that window and marks them accordingly.

## Git / SSH

This repo uses SSH with a custom host alias. The remote is configured as:
```
git@github-zh3n:zh3nxbt/mas-email-reports.git
```

This uses the `github-zh3n` alias defined in `~/.ssh/config`:
```
Host github-zh3n
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github_zh3n
  IdentitiesOnly yes
```

**Important:** Use `github-zh3n` instead of `github.com` in the remote URL to use the correct SSH key.
