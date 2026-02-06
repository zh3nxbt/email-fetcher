# MAS Dashboard — Replace Email Reports with Interactive Web UI

## Context

MAS Precision Parts currently relies on scheduled email reports (7am/12pm/4pm) to track email TODOs and QuickBooks sync alerts. The workflow is passive — staff read an email, then manually act on it. The new dashboard replaces this with an interactive, real-time web UI where staff can see all action items, dismiss/resolve them, correct AI mistakes, view full email threads, manage QB jobs, and write back to QuickBooks — all from one screen. Email reports will be fully deprecated.

**Users:** 2-3 office staff, desktop primary, mobile secondary.
**QB Writes:** Confirmed supported by Conductor.is plan.

---

## Progress Tracker

### Phase 1 (Foundation) — PARTIALLY COMPLETE

**Done:**
- [x] Schema: 3 new tables added to `src/db/schema.ts` — `dashTodos`, `dashAiCorrections`, `qbWriteLog`
- [x] Enum: `dash_todo_status` ('open', 'resolved', 'dismissed') created
- [x] Migration script: `src/db/migrate-dashboard.ts` created and ran successfully
- [x] Tables created in DB: `dash_todos`, `dash_ai_corrections`, `qb_write_log`
- [x] Seeded `dash_todos` from existing `email_todo_items` + `email_report_threads` (47 rows: 2 open, 37 resolved, 8 dismissed)
- [x] Type exports added: `DashTodo`, `NewDashTodo`, `DashAiCorrection`, `NewDashAiCorrection`, `QbWriteLogEntry`, `NewQbWriteLogEntry`, `DashTodoStatus`

**Not done yet:**
- [ ] Install Shadcn UI components (table, tabs, dialog, etc.)
- [ ] Tabbed layout (rewrite `src/app/page.tsx`)
- [ ] Component file structure

**Table naming convention:** All tables use prefixes for clarity in Supabase:
- `dash_*` — dashboard tables (`dash_todos`, `dash_ai_corrections`)
- `qb_*` — QuickBooks tables (`qb_write_log`, existing `qb_sync_alerts`)
- `email_*` — existing email tables

**Migration note:** `npm run db:push` is broken (Drizzle bug). All schema changes use raw SQL migration scripts with idempotent checks (`IF NOT EXISTS`, `SELECT 1 FROM information_schema...`). The seed query needed `::dash_todo_status` casts for enum columns.

Run migration: `npx tsx src/db/migrate-dashboard.ts`

### Phase 2 (Todo APIs) — Batch 2 COMPLETE

**Done:**
- [x] `src/app/api/todos/route.ts` — GET with filters (status, category, itemType, todoType, search, sort, pagination) + POST bulk resolve/dismiss
- [x] `src/app/api/todos/correct/route.ts` — POST AI correction (inserts into dash_ai_corrections, updates dash_todos, recalculates todoType, backward compat with email_report_threads)
- [x] `src/app/api/threads/[threadKey]/emails/route.ts` — GET full email thread (transitive expansion via message_id/in_reply_to/references, subject fallback, isOutbound computed)

**API details:**
- GET /api/todos returns `{ todos[], total, filters: { categories, todoTypes, itemTypes } }` with counts per filter value
- POST /api/todos accepts `{ action: "resolve"|"dismiss", threadKeys: [...] }`, also updates legacy tables
- POST /api/todos/correct accepts `{ threadKey, corrections: { category?, itemType?, needsResponse?, contactName? } }`, stores original values, recalculates todoType using `deriveTodoType()`
- GET /api/threads/[threadKey]/emails returns `{ threadKey, todo, emails[] }` with `isOutbound` computed per email

### Phase 3 (Sync & AI) — Batch 3 COMPLETE

**Done:**
- [x] `src/dashboard/todo-sync.ts` — Upsert logic: inserts new todos, auto-resolves when we reply (resolvedBy='email_activity'), updates metadata for existing threads, respects dismissed_threads
- [x] `src/app/api/sync-and-refresh/route.ts` — POST endpoint: syncEmails → categorizeThreads → identifyTodos → syncDashTodos. Time window from last sync metadata with 30min overlap.
- [x] `src/report/summarizer.ts` — Modified `categorizeWithModel()` to load last 20 corrections from `dash_ai_corrections` via `loadCorrectionsForPrompt()` and inject as few-shot examples into the classification prompt

**Key details:**
- `syncDashTodos()` is exported and reusable by CLI tools for backward compat
- `loadCorrectionsForPrompt()` is exported from todo-sync.ts, loads corrections with `applied_to_future=true`, includes thread subjects for context
- Time window defaults to 2h lookback on first run, then uses last sync metadata
- Auto-resolution only happens when `lastEmailFromUs=true` AND no new todo identified

### Phase 4 (QB Read APIs) — Batch 4 COMPLETE

**Done:**
- [x] `src/app/api/qb/jobs/route.ts` — GET active Sales Orders enriched with invoices, alerts, and email PO links. 5-min server-side cache, search/alertType filters.
- [x] `src/app/api/qb/alerts/route.ts` — GET alerts with counts by type, status/alertType filters
- [x] `src/app/api/qb/alerts/[id]/route.ts` — PATCH dismiss/resolve (local DB only, does NOT affect QuickBooks)

**QB is read-only:** Dashboard can view QB data (Sales Orders, invoices, alerts) but cannot write back to QuickBooks. Write APIs (create SO, close SO, create invoice) are deferred as a future feature.

**Key details:**
- Jobs endpoint fetches SOs + invoices from Conductor.is API, cross-references with local qb_sync_alerts and email_po_attachments
- Invoice-to-SO matching via linkedTransactions field on QB invoices
- Cache stores full unfiltered result; search/alertType filters applied on cached data
- PO totals converted from cents to dollars in API response

### Phases 5-7 — NOT STARTED (Phase 5 QB Writes deferred)

---

## Implementation Batches

Backend work is broken into batches of max 3 files each (per CLAUDE.md rules).

### Batch 1: Schema + Migration ✅ DONE
1. `src/db/schema.ts` — add `dashTodos`, `dashAiCorrections`, `qbWriteLog` tables + types
2. `src/db/migrate-dashboard.ts` — raw SQL migration + seed from existing data

### Batch 2: Todo API Routes ✅ DONE
1. `src/app/api/todos/route.ts` — GET (list with filters) + POST (bulk actions)
2. `src/app/api/todos/correct/route.ts` — POST AI correction
3. `src/app/api/threads/[threadKey]/emails/route.ts` — GET full email thread

### Batch 3: Sync & AI ✅ DONE
1. `src/dashboard/todo-sync.ts` — upsert logic for dash_todos from categorization results
2. `src/app/api/sync-and-refresh/route.ts` — IMAP sync + categorize + populate todos
3. `src/report/summarizer.ts` — inject AI corrections into prompt (modify existing)

### Batch 4: QB Read APIs ✅ DONE
1. `src/app/api/qb/jobs/route.ts` — GET active Sales Orders (read-only, enriched with invoices/alerts/POs)
2. `src/app/api/qb/alerts/route.ts` — GET alerts with counts
3. `src/app/api/qb/alerts/[id]/route.ts` — PATCH dismiss/resolve single alert (local DB only)

### Batch 5: QB Write APIs — DEFERRED (future feature)
QB writes (create SO, close SO, create invoice) deferred. Dashboard is read-only for QB data.
1. ~~`src/quickbooks/conductor-client.ts` — add write methods~~
2. ~~`src/quickbooks/types.ts` — add write input types~~
3. ~~`src/app/api/qb/sales-orders/route.ts` + `[id]/close/route.ts` + `src/app/api/qb/invoices/route.ts`~~

---

## Detailed API Specifications

### Todo APIs (Batch 2)

#### `GET /api/todos` — Main todo list

Reads from `dash_todos`. Powers the dashboard table.

**Query params:**
| Param | Type | Default | Example |
|-------|------|---------|---------|
| `status` | string | `"open"` | `open`, `resolved`, `dismissed`, `all` |
| `category` | string | (all) | `customer`, `vendor`, `other` |
| `itemType` | string | (all) | `po_received`, `po_sent`, `quote_request`, `general`, `other` |
| `todoType` | string | (all) | `po_unacknowledged`, `quote_unanswered`, `general_unanswered`, `vendor_followup` |
| `search` | string | (none) | Full-text on subject, contact name, contact email |
| `sortBy` | string | `"date"` | `date`, `priority`, `contact`, `category` |
| `sortOrder` | string | `"desc"` | `asc`, `desc` |
| `limit` | number | `50` | 1-100 |
| `offset` | number | `0` | Pagination offset |

**Response:**
```json
{
  "todos": [
    {
      "id": 1,
      "threadKey": "<abc@example.com>",
      "todoType": "po_unacknowledged",
      "category": "customer",
      "itemType": "po_received",
      "contactEmail": "harold.vahle@magna.com",
      "contactName": "Harold Vahle (Magna)",
      "subject": "Fw: PRD64378-1:Magna PO number 4500175105",
      "summary": "Customer forwarded PO number 4500175105 with attached print file.",
      "description": "Customer sent a PO that hasn't been acknowledged yet.",
      "firstDetectedAt": "2026-02-05T14:01:00Z",
      "lastEmailDate": "2026-02-05T14:01:00Z",
      "emailCount": 1,
      "needsResponse": true,
      "lastEmailFromUs": false,
      "status": "open",
      "poDetails": { "poNumber": "4500175105", "total": 125000 },
      "isSuspicious": false,
      "aiCorrected": false,
      "createdAt": "2026-02-05T20:00:00Z"
    }
  ],
  "total": 42,
  "filters": {
    "categories": { "customer": 30, "vendor": 10, "other": 2 },
    "todoTypes": { "po_unacknowledged": 5, "quote_unanswered": 8, "general_unanswered": 15, "vendor_followup": 14 },
    "itemTypes": { "po_received": 12, "quote_request": 8, "general": 20, "other": 2 }
  }
}
```

The `filters` object provides counts for each filter value so the UI can show "(5)" next to filter options.

---

#### `POST /api/todos/bulk` — Bulk resolve or dismiss

**Request:**
```json
{
  "action": "resolve" | "dismiss",
  "threadKeys": ["<abc@example.com>", "<def@example.com>"]
}
```

**Behavior:**
- `"resolve"`: Sets `status='resolved'`, `resolvedBy='manual'`, `resolvedAt=now` on each matching `dash_todos` row
- `"dismiss"`: Sets `status='dismissed'`, `resolvedBy='manual'`, `resolvedAt=now` on each matching `dash_todos` row. Also inserts into `email_dismissed_threads` (for backward compat with legacy report generation)

**Response:**
```json
{ "success": true, "updatedCount": 3 }
```

---

#### `GET /api/threads/[threadKey]/emails` — Full email thread for popup

Takes URL-encoded threadKey. Queries `email_messages` for all emails in that thread.

**Response:**
```json
{
  "threadKey": "<abc@example.com>",
  "todo": {
    "id": 1,
    "category": "customer",
    "itemType": "po_received",
    "todoType": "po_unacknowledged",
    "summary": "Customer forwarded PO...",
    "status": "open",
    "aiCorrected": false,
    "poDetails": { "poNumber": "4500175105", "total": 125000 }
  },
  "emails": [
    {
      "id": 501,
      "fromAddress": "harold.vahle@magna.com",
      "fromName": "Harold Vahle",
      "toAddresses": "[\"sales@masprecisionparts.com\"]",
      "subject": "Fw: PRD64378-1:Magna PO number 4500175105",
      "bodyText": "Hi, please see attached PO...",
      "date": "2026-02-05T14:01:00Z",
      "isOutbound": false,
      "hasAttachments": true,
      "attachments": "[{\"filename\":\"PO-4500175105.pdf\",\"contentType\":\"application/pdf\",\"size\":245000}]"
    },
    {
      "id": 502,
      "fromAddress": "sales@masprecisionparts.com",
      "fromName": "MAS Precision Parts",
      "toAddresses": "[\"harold.vahle@magna.com\"]",
      "subject": "Re: Fw: PRD64378-1:Magna PO number 4500175105",
      "bodyText": "Thanks Harold, we'll get on this right away.",
      "date": "2026-02-05T15:30:00Z",
      "isOutbound": true,
      "hasAttachments": false,
      "attachments": null
    }
  ]
}
```

`isOutbound` is computed by checking if `fromAddress` contains `masprecisionparts.com` or if `mailbox` is "Sent"/"Sent Messages".

---

#### `POST /api/todos/correct` — Record AI correction

**Request:**
```json
{
  "threadKey": "<abc@example.com>",
  "corrections": {
    "category": "customer",
    "itemType": "po_received",
    "needsResponse": true
  }
}
```

Only changed fields need to be included. Each changed field becomes a row in `dash_ai_corrections`.

**Behavior:**
1. Reads current `dash_todos` row to get original values
2. Inserts one row per changed field into `dash_ai_corrections`
3. Updates `dash_todos` row: sets new values, `ai_corrected=true`, stores originals in `original_category`/`original_item_type`
4. If `category` or `itemType` changed, recalculates `todoType` based on new values
5. Updates matching `email_report_threads` rows for backward compat

**Response:**
```json
{ "success": true, "correctedFields": ["category", "itemType"], "newTodoType": "po_unacknowledged" }
```

---

### Sync API (Batch 3)

#### `POST /api/sync-and-refresh` — The "Sync & Refresh" button

Replaces `npm run report` for the dashboard. No request body needed.

**Behavior:**
1. Sync emails from IMAP (`syncEmails()` from `src/sync/syncer.ts`)
2. Determine time window (since last sync, or last 2 hours)
3. Categorize new/changed threads (`categorizeThreads()` from `src/report/categorizer.ts`)
4. Identify new todos (`identifyTodos()` from `src/report/todo-analyzer.ts`)
5. Upsert into `dash_todos`:
   - New threads with todos → INSERT
   - Existing threads where we replied → UPDATE status to 'resolved', resolvedBy='email_activity'
   - Existing threads with new emails → UPDATE lastEmailDate, emailCount, summary
6. Return summary

**Response:**
```json
{
  "success": true,
  "emailsSynced": 12,
  "newTodos": 3,
  "resolvedTodos": 1,
  "updatedThreads": 5
}
```

---

### AI Correction Injection (Batch 3)

Not an API — modification to `src/report/summarizer.ts`.

Before sending threads to Claude for classification, loads last 20 corrections from `dash_ai_corrections` where `applied_to_future=true`, ordered by `corrected_at DESC`. Appends as few-shot examples to the prompt:

```
PREVIOUS CORRECTIONS (learn from these):
- Thread "Fw: PO 4500175105" was classified as category="vendor" but should be category="customer"
- Thread "RE: RFQ Plates" was classified as item_type="general" but should be item_type="quote_request"
```

Cap at 20. When 50+ corrections accumulate, manually review patterns and update base prompt rules.

---

### QB Read APIs (Batch 4)

#### `GET /api/qb/jobs` — Active Sales Orders

Fetches open SOs from Conductor.is, enriches with local data.

**Query params:**
| Param | Type | Default |
|-------|------|---------|
| `search` | string | (none) — searches customer name, SO#, PO# |
| `alertType` | string | (all) — filter by alert type |
| `ageMin` | number | (none) — minimum age in days |
| `ageMax` | number | (none) — maximum age in days |
| `refresh` | boolean | `false` — bypass 5-minute cache |

**Response:**
```json
{
  "jobs": [
    {
      "salesOrder": {
        "id": "80000001-1234",
        "refNumber": "SO-1234",
        "customerName": "TNT Tools Inc",
        "customerId": "80000001-5678",
        "transactionDate": "2026-01-10",
        "totalAmount": 5250.00,
        "isManuallyClosed": false,
        "isFullyInvoiced": false,
        "lineCount": 3
      },
      "emailPo": {
        "threadKey": "<abc@example.com>",
        "poNumber": "PO-1049",
        "poTotal": 5000.00,
        "contactEmail": "john@tnttools.com",
        "receivedDate": "2026-01-08"
      },
      "invoices": [
        { "refNumber": "INV-789", "totalAmount": 2500.00, "isPaid": true }
      ],
      "alerts": [
        { "id": 1, "alertType": "po_detected_with_so", "status": "resolved", "detectedAt": "2026-01-08T15:00:00Z" }
      ],
      "ageInDays": 25,
      "invoicedAmount": 2500.00,
      "invoicedPercent": 47.6
    }
  ],
  "summary": {
    "totalJobs": 15,
    "overdueJobs": 3,
    "uninvoicedJobs": 5,
    "totalValue": 125000.00
  },
  "cachedAt": "2026-02-05T20:00:00Z"
}
```

Uses 5-minute server-side cache. `?refresh=true` bypasses.

---

#### `GET /api/qb/alerts` — QB sync alerts with counts

**Query params:**
| Param | Type | Default |
|-------|------|---------|
| `status` | string | `"open"` — `open`, `resolved`, `dismissed`, `all` |
| `alertType` | string | (all) |

**Response:**
```json
{
  "alerts": [
    {
      "id": 1,
      "alertType": "po_missing_so",
      "threadKey": "<abc@example.com>",
      "subject": "Fw: PO 4500175105",
      "contactName": "Harold Vahle (Magna)",
      "poNumber": "4500175105",
      "poTotal": 125000,
      "qbCustomerName": "Magna International",
      "status": "open",
      "detectedAt": "2026-02-05T14:00:00Z",
      "escalatedAt": "2026-02-05T18:00:00Z"
    }
  ],
  "counts": {
    "po_detected": 3,
    "po_missing_so": 1,
    "no_qb_customer": 2,
    "suspicious_po_email": 0,
    "so_should_be_closed": 4,
    "po_detected_with_so": 0
  },
  "total": 10
}
```

---

#### `PATCH /api/qb/alerts/[id]` — Dismiss or resolve an alert

**Request:**
```json
{ "action": "dismiss" | "resolve" }
```

**Response:**
```json
{ "success": true, "alert": { "id": 1, "status": "dismissed", "resolvedAt": "..." } }
```

---

### QB Write APIs (Batch 5)

#### `POST /api/qb/sales-orders` — Create SO in QuickBooks

**Request:**
```json
{
  "customerId": "80000001-5678",
  "purchaseOrderNumber": "PO-1049",
  "transactionDate": "2026-02-05",
  "memo": "Created from dashboard",
  "lines": [
    { "description": "Precision plates 6x12", "quantity": 10, "rate": "525.00" }
  ],
  "alertId": 1
}
```

**Behavior:**
1. Calls `conductor-client.createSalesOrder()`
2. Logs to `qb_write_log` (success or failure)
3. If `alertId` provided, auto-resolves the `po_detected` or `po_missing_so` alert
4. Returns created SO

**Response:**
```json
{
  "success": true,
  "salesOrder": { "id": "80000001-9999", "refNumber": "SO-1500", "totalAmount": 5250.00 },
  "alertResolved": true
}
```

---

#### `POST /api/qb/sales-orders/[id]/close` — Close SO

**Request:** (no body needed — SO id is in URL)

**Behavior:**
1. Fetches current SO from Conductor to get `revisionNumber`
2. Calls `conductor-client.updateSalesOrder(id, { isManuallyClosed: true, revisionNumber })`
3. Logs to `qb_write_log`
4. Resolves any `so_should_be_closed` alert for this SO

**Response:**
```json
{ "success": true, "salesOrder": { "id": "...", "isManuallyClosed": true } }
```

---

#### `POST /api/qb/invoices` — Create invoice linked to SO

**Request:**
```json
{
  "customerId": "80000001-5678",
  "transactionDate": "2026-02-05",
  "purchaseOrderNumber": "PO-1049",
  "lines": [
    {
      "description": "Precision plates 6x12",
      "quantity": 10,
      "rate": "525.00",
      "linkToTransactionLine": {
        "transactionId": "80000001-9999",
        "transactionLineId": "line-001"
      }
    }
  ]
}
```

**Behavior:**
1. Calls `conductor-client.createInvoice()`
2. Logs to `qb_write_log`
3. Returns created invoice

**Response:**
```json
{
  "success": true,
  "invoice": { "id": "80000001-AAAA", "refNumber": "INV-900", "totalAmount": 5250.00 }
}
```

---

## Phase 1: Foundation — Tabs, Components, Schema

**Goal:** Skeleton app with two tabs, install UI components, create new DB tables.

### 1a. Install Shadcn UI Components

```bash
npx shadcn@latest add table tabs dialog dropdown-menu checkbox select input tooltip separator scroll-area skeleton popover
npm install sonner  # toast notifications
```

### 1b. New Database Tables

**`dash_todos`** — Standalone todo list decoupled from report IDs:
```
id, thread_key (UNIQUE), todo_type, category, item_type,
contact_email, contact_name, subject, summary, description,
first_detected_at, last_email_date, email_count,
needs_response, last_email_from_us,
status ('open'|'resolved'|'dismissed'), resolved_at, resolved_by,
po_details (jsonb), is_suspicious,
ai_corrected, original_category, original_item_type,
qb_alert_id (FK → qb_sync_alerts), created_at, updated_at
```

**`dash_ai_corrections`** — Records when user corrects AI classification:
```
id, thread_key, field_corrected, original_value, corrected_value,
corrected_by, corrected_at, applied_to_future, notes
```

**`qb_write_log`** — Audit trail for all QB write operations:
```
id, operation, qb_object_type, qb_object_id, qb_ref_number,
input_data (jsonb), response_data (jsonb), triggered_by,
alert_id (FK → qb_sync_alerts), created_at, success, error_message
```

### 1c. Tabbed Layout

Replace `src/app/page.tsx` entirely. New structure:

```
<Header>
  "MAS Precision Parts — Job Flow Tracker"
  [Sync & Refresh] [Last synced: X min ago]
</Header>
<Tabs>
  <Tab 1: "Email Todos">  → <TodoDashboard />
  <Tab 2: "QB Jobs">      → <QBJobsDashboard />
</Tabs>
```

### 1d. Component File Structure

```
src/components/
  layout/
    header.tsx
    tab-shell.tsx
  todos/
    todo-table.tsx
    todo-filters.tsx
    thread-detail-dialog.tsx
    ai-correction-dialog.tsx
    bulk-actions-bar.tsx
  qb/
    jobs-table.tsx
    job-detail-dialog.tsx
    alert-summary-bar.tsx
    create-so-dialog.tsx
    create-invoice-dialog.tsx
  shared/
    empty-state.tsx
    relative-time.tsx
```

### Files Modified
- `src/app/page.tsx` — full rewrite
- `src/db/schema.ts` — add 3 new tables ✅ DONE
- `src/db/migrate-dashboard.ts` — new migration script ✅ DONE

---

## Phase 2: Email TODO Table (Core Feature)

**Goal:** Filterable, sortable table of all action items with thread popup.

### 2a. Todo Table Columns

| Column | Width | Content |
|--------|-------|---------|
| ☐ | 40px | Bulk select checkbox |
| Priority | 60px | Color dot: red (PO ack), orange (quote), gray (general) |
| Subject | flex | Thread subject — click opens thread popup |
| Contact | 150px | Name, email in tooltip |
| Category | 100px | Badge: Customer (green) / Vendor (purple) / Other (gray) |
| Type | 120px | Badge: PO Received, RFQ, General, etc. |
| Action Needed | 140px | Label: "Ack PO" (red), "Send Quote" (orange), etc. |
| Age | 80px | Relative time: "2h ago", "3 days" |
| Actions | 80px | Dropdown: Resolve, Dismiss, Correct AI, View |

### 2b. Thread Detail Dialog

Full-width modal showing:
- **Header:** Subject + Category/Type badges + Contact info
- **AI Summary:** Editable (pencil icon triggers AI correction dialog)
- **Email Timeline:** Chronological list, each email shows:
  - Direction indicator (→ outbound, ← inbound)
  - From/To, date, body (collapsible), attachment list
- **PO Details panel** (if po_received): PO#, total, line items
- **Actions bar:** [Resolve] [Dismiss] [Correct AI]

### 2c. Filter Bar

Horizontal above table:
```
[🔍 Search...] [Category ▾] [Type ▾] [Action ▾] [Status ▾] [Clear]
```
Each dropdown shows count per option. Filters update URL query params (shareable).

### 2d. Bulk Actions Bar

Floating bottom bar when items selected:
```
[3 selected] — [Resolve All] [Dismiss All] [Clear]
```

### Files Created
- `src/app/api/todos/route.ts` — GET list + POST bulk
- `src/app/api/todos/correct/route.ts` — POST AI correction
- `src/app/api/threads/[threadKey]/emails/route.ts` — GET thread emails
- `src/components/todos/todo-table.tsx`
- `src/components/todos/todo-filters.tsx`
- `src/components/todos/thread-detail-dialog.tsx`
- `src/components/todos/bulk-actions-bar.tsx`
- `src/components/shared/empty-state.tsx`
- `src/components/shared/relative-time.tsx`

### Files Modified
- `src/app/page.tsx` — wire up TodoDashboard
- `src/app/api/todos/[id]/route.ts` — extend to update `dash_todos` alongside `email_todo_items`

---

## Phase 3: Sync & Refresh

**Goal:** Dashboard triggers its own email sync + categorization, no dependency on CLI.

### 3a. Enhanced Sync Endpoint

**`POST /api/sync-and-refresh`**:
1. Sync emails from IMAP (`syncEmails()`)
2. Categorize new/changed threads (`categorizeThreads()`)
3. Identify new todos (`identifyTodos()`)
4. Upsert into `dash_todos` (new threads = insert, existing = update)
5. Auto-resolve todos where we sent a reply in the thread
6. Return: `{ emailsSynced, newTodos, resolvedTodos }`

### 3b. Header Sync Button

- Shows "Last synced: X min ago"
- Click triggers sync, shows spinner
- On complete: toast with summary, table auto-refreshes

### 3c. Auto-Polling

Frontend polls `GET /api/todos?status=open` every 5 minutes. If count changes, show subtle indicator. Tab title shows count: `(5) Job Flow Tracker`.

### 3d. Backward Compatibility

Keep `npm run report`, `npm run jobs:check` CLI commands working. They write to `email_todo_items` and `email_report_threads`. A helper function syncs changes from those tables into `dash_todos` so both paths stay consistent. Long-term, the CLI tools can be simplified to just call the same functions the API uses.

### Files Created
- `src/app/api/sync-and-refresh/route.ts`
- `src/dashboard/todo-sync.ts` — logic to upsert dash_todos from categorization results

### Files Modified
- `src/report/summarizer.ts` — inject AI corrections into prompt
- `src/components/layout/header.tsx` — sync button + status

---

## Phase 4: AI Feedback & Correction

**Goal:** When AI misclassifies, user corrects it. Corrections improve future AI.

### 4a. Correction Dialog

Triggered from thread detail or row action dropdown:
```
Current AI Classification:
  Category:    [Customer ▾]
  Item Type:   [PO Received ▾]
  Needs Reply: [Yes / No]

What AI originally said:
  Category: vendor | Item Type: general

[Save Correction]  [Cancel]
```

### 4b. Inject Corrections into AI Prompts

Modify `src/report/summarizer.ts` — before sending batch to Claude, load last 20 corrections from `dash_ai_corrections` and append as few-shot examples:

```
PREVIOUS CORRECTIONS (learn from these):
- Thread "Fw: PO 4500175105" was classified as category="vendor" but should be category="customer"
- Thread "RE: RFQ Plates" was classified as item_type="general" but should be item_type="quote_request"
```

Cap at 20 most recent. After 50+ corrections, analyze patterns and update base prompt rules instead.

### Files Created
- `src/components/todos/ai-correction-dialog.tsx`

### Files Modified
- `src/report/summarizer.ts` — inject correction examples into AI prompt

---

## Phase 5: QB Jobs Dashboard (Tab 2)

**Goal:** Show all active Sales Orders with alert flags, PO links, invoice status, and write-back to QuickBooks.

### 5a. Conductor Client Write Methods

Add to `src/quickbooks/conductor-client.ts`:
- `createSalesOrder(data)` — POST to `/quickbooks-desktop/sales-orders`
- `updateSalesOrder(id, data)` — POST to `/quickbooks-desktop/sales-orders/{id}` (requires `revisionNumber`)
- `createInvoice(data)` — POST to `/quickbooks-desktop/invoices`

Add corresponding types to `src/quickbooks/types.ts`.

### 5b. Jobs Table Columns

| Column | Content |
|--------|---------|
| SO# | Ref number, clickable for detail |
| Customer | QB customer name |
| PO# | Linked PO from email, or "—" |
| Total | SO dollar amount |
| Age | Days since SO created + color (green <30d, yellow 30-45d, red >45d) |
| Invoiced | Progress bar (0-100%) with dollar amount |
| Alerts | Color-coded alert badges |
| Actions | Dropdown: View, Close SO, Create Invoice, Dismiss Alert |

### 5c. Alert Summary Bar

Above jobs table:
```
[3 PO Detected] [1 Missing SO ⚠️] [2 No QB Customer] [1 Suspicious] [4 Close SO]
```
Each clickable to filter table.

### 5d. Job Detail Dialog

- SO details: lines, totals, dates, customer
- Linked PO: from email, with link to email thread (opens Thread Detail from Tab 1)
- Invoices: list with amounts, paid status
- Alert history: timeline
- Actions: [Close SO] [Create Invoice] [Dismiss Alert]

### 5e. Create SO Dialog

Pre-fills from PO data when triggered from `po_detected` alert:
- Customer (auto-matched)
- PO Number
- Line items from PDF analysis (editable)
- Total
- User reviews → "Create in QuickBooks" → toast on success

### Files Created
- `src/app/api/qb/jobs/route.ts`
- `src/app/api/qb/alerts/route.ts`
- `src/app/api/qb/alerts/[id]/route.ts`
- `src/app/api/qb/sales-orders/route.ts`
- `src/app/api/qb/sales-orders/[id]/close/route.ts`
- `src/app/api/qb/invoices/route.ts`
- `src/components/qb/jobs-table.tsx`
- `src/components/qb/job-detail-dialog.tsx`
- `src/components/qb/alert-summary-bar.tsx`
- `src/components/qb/create-so-dialog.tsx`
- `src/components/qb/create-invoice-dialog.tsx`

### Files Modified
- `src/quickbooks/conductor-client.ts` — add write methods
- `src/quickbooks/types.ts` — add write input types
- `src/app/page.tsx` — wire up QBJobsDashboard

---

## Phase 6: Deprecate Email Reports

**Goal:** Remove email sending, simplify CLI tools.

### 6a. Changes
- Remove `npm run report`, `npm run report:morning`, `npm run report:midday` from package.json (or make them just sync + populate dash_todos)
- Keep `npm run jobs:check` for scheduled alert checking, but make it write to `dash_todos` + `qb_sync_alerts` instead of sending email
- Remove SMTP config from `.env` (or keep for rare manual use)
- Remove email template code from `src/report/templates.ts` (or leave dead for reference)
- The `POST /api/generate-report` endpoint becomes `POST /api/sync-and-refresh`

### 6b. Scheduled Tasks Update
Replace Windows Task Scheduler entries:
- ~~7am/12pm/4pm: `npm run report`~~ → No longer needed (dashboard auto-refreshes)
- Keep: `npm run jobs:check` hourly for background QB alert detection → writes to DB, dashboard picks it up

---

## Phase 7: Advanced Features

### 7a. Keyboard Shortcuts
- `Ctrl+K`: Command palette (search across todos, jobs, contacts, PO#s)
- `r`: Refresh/sync
- `j`/`k`: Navigate table rows
- `Enter`: Open detail
- `d`: Dismiss, `x`: Resolve
- `1`/`2`: Switch tabs

### 7b. `job_not_invoiced` Alert (from QB sync plan Phase 7)
- Add enum value: `ALTER TYPE qb_sync_alert_type ADD VALUE IF NOT EXISTS 'job_not_invoiced'`
- Detect: SOs 45+ days old with no matching invoice
- Show in QB Jobs tab with "Create Invoice" action

### 7c. Weekly Summary Section
- Jobs started/completed this week
- POs received vs SOs created (match rate)
- Avg time from PO → SO creation
- Uninvoiced jobs by age bracket (30/45/60+ days)

### 7d. Customer Lookup
- Search by contact name/email
- Shows: all threads, open todos, QB customer match, last interaction
- Answers: "What's the status of everything with Customer X?"

### 7e. Activity Feed
- Chronological event log: "PO received from TNT Tools", "SO-1234 created", "Invoice 789 sent"
- "What happened while I was away?" view

### 7f. Browser Notifications
- When background `jobs:check` creates new alerts, show browser push notification
- Tab title badge count: `(3) Job Flow Tracker`

---

## Implementation Order

| Order | Phase | Description | Scope |
|-------|-------|-------------|-------|
| 1 | Phase 1 | Foundation (tabs, components, DB) | ~8 files |
| 2 | Phase 2 | Email TODO table | ~12 files |
| 3 | Phase 3 | Sync & refresh | ~4 files |
| 4 | Phase 4 | AI correction | ~4 files |
| 5 | Phase 5 | QB Jobs dashboard + writes | ~15 files |
| 6 | Phase 6 | Deprecate email reports | ~5 files |
| 7 | Phase 7 | Advanced features | incremental |

Each phase is independently useful. Phase 2 alone makes the dashboard valuable.

---

## Verification Plan

After each phase:
1. `npm run dev` — dashboard loads, tabs work
2. Manual test: create/resolve/dismiss todos via UI
3. Verify `dash_todos` table stays in sync with actions
4. For Phase 5: test QB write operations with `--preview` first
5. For Phase 4: verify AI correction appears in next categorization prompt
6. Mobile: test on phone browser at each phase (responsive layout)
