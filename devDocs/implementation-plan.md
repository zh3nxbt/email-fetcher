# Email Job Flow Tracker - Implementation Plan

## Summary
A **Job Flow Tracker** that:
- Monitors customer emails via IMAP
- Uses **Claude Haiku** to analyze entire threads and determine action needed
- Groups emails into threads by customer
- Displays on a 3-column Kanban dashboard

## Kanban Board (3 Columns)

| Column | What Goes Here |
|--------|----------------|
| **To Do** | Threads requiring our response/action |
| **Quote Requests** | Customer asking for pricing/quote (pending our quote) |
| **PO Received / Jobs** | Purchase orders, confirmed jobs |

**Not shown:** Threads with no action needed (resolved, "thank you" emails, spam, etc.)

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   IMAP Server   │────▶│  Sync Service    │────▶│    Database     │
│  (Bluehost)     │     │                  │     │   (Supabase)    │
└─────────────────┘     └────────┬─────────┘     └────────┬────────┘
                                 │                        │
                                 ▼                        ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │  Claude Haiku   │     │   Next.js App   │
                        │  (Thread AI)    │     │  (Dashboard UI) │
                        └─────────────────┘     └─────────────────┘
```

---

## Tech Stack

| Component | Choice |
|-----------|--------|
| Framework | Next.js 15 |
| Database | **Supabase PostgreSQL** + Drizzle ORM |
| DB Driver | `postgres` (via pooler connection) |
| IMAP | imapflow + mailparser |
| Classification | Claude Haiku API (@anthropic-ai/sdk) |
| UI | Tailwind + shadcn/ui |

---

## Database (Supabase)

### Connection
Uses Supabase's **Transaction Pooler** for serverless compatibility:
```
postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

Set in `.env` as `DATABASE_URL`.

### Tables (all prefixed with `email_`)

**`email_messages`** - Raw email records
- `id`, `uid`, `message_id`
- `from_address`, `from_name`, `to_addresses`
- `subject`, `body_text`, `date`
- `in_reply_to`, `references`, `mailbox`
- `has_attachments`, `attachments`
- `synced_at`

**`email_threads`** - Email thread summaries (AI-classified)
- `id`, `thread_id` (from email headers)
- `customer_email`, `customer_name`
- `subject` (normalized)
- `status` (action_needed, quote_request, po_received, no_action, not_customer)
- `status_reason` (AI's explanation)
- `email_count`
- `last_activity`, `created_at`, `classified_at`

**`email_thread_messages`** - Link table
- `thread_id`, `email_id`

### Migrations
```bash
npm run db:push      # Push schema to Supabase
npm run db:studio    # Open Drizzle Studio
```

---

## Configuration

- **Our email**: `sales@masprecisionparts.com`
- **API Key**: `ANTHROPIC_API_KEY` in `.env`
- **Database**: `DATABASE_URL` in `.env` (Supabase pooler URL)
- **Initial sync**: Last 30 days
- **Mailboxes**: `INBOX`, `Sent`, `Sent Items` (multiple users use different clients)

---

## Thread Classification with Claude Haiku

**Key insight:** Classify the **entire thread**, not individual emails. The LLM reads the conversation and determines the current state.

### Critical: Customer vs Vendor Distinction

MAS Precision Parts is OUR company. We must distinguish:

| Scenario | Classification |
|----------|----------------|
| Customer sends US a PO | `po_received` ✓ |
| WE send a PO to vendor | `no_action` (we're buying) |
| Customer asks US for quote | `quote_request` ✓ |
| WE ask vendor for quote | `no_action` (we're buying) |

**Rule:** If the FIRST email in a thread is [SENT] by us, we initiated the conversation = likely vendor/supplier interaction, NOT a customer.

**Prompt for each thread:**
```
You are analyzing an email thread for a precision parts manufacturing company.
Read the conversation and determine what action (if any) is needed from us.

Thread (oldest first):
{thread_emails_formatted}

Based on the conversation, classify this thread:

1. "action_needed" - We need to respond. Customer asked a question, made a request,
   or is waiting for information from us. Excludes simple "thank you" messages
   or cases where we said "we'll get back to you" and haven't yet.

2. "quote_request" - Customer is specifically asking for pricing, a quote, estimate,
   or RFQ. We need to prepare and send a quote.

3. "po_received" - Customer has sent a purchase order, confirmed an order, or
   indicated they want to proceed with buying.

4. "no_action" - No response needed. Thread is resolved, customer said "thank you",
   we're waiting on THEM to respond, or this is spam/newsletter/automated.

5. "not_customer" - This is not a customer email (newsletter, spam, internal, automated).

Respond with JSON only:
{
  "status": "action_needed" | "quote_request" | "po_received" | "no_action" | "not_customer",
  "reason": "brief explanation",
  "customer_name": "extracted customer name or company if identifiable"
}
```

**Examples of nuanced cases:**
- Customer: "Thank you!" → `no_action` (no reply needed)
- Us: "We'll check and get back to you tomorrow" → `action_needed` (we owe them a response)
- Customer: "Got it, thanks. I'll review and let you know." → `no_action` (ball is in their court)
- Customer: "Can you send me a quote for 100 units?" → `quote_request`

**Cost estimate:** ~$0.002-0.005 per thread (more tokens than single email, still cheap)

---

## Thread State Logic

```
For each thread:
  1. Fetch all emails in thread (both INBOX and Sent)
  2. Format as conversation (oldest first)
  3. Send to Claude Haiku for classification
  4. Store result:
     - action_needed → "To Do" column
     - quote_request → "Quote Requests" column
     - po_received → "PO/Jobs" column
     - no_action → Hidden (not displayed)
     - not_customer → Hidden (filtered out)
```

---

## Files Structure

```
src/
  db/
    schema.ts         # Drizzle schema (PostgreSQL)
    index.ts          # DB connection (Supabase)
  sync/
    syncer.ts         # IMAP sync service
    classifier.ts     # Claude Haiku thread classification
    threader.ts       # Thread grouping logic
    thread-processor.ts # Orchestrates sync + classification
    run-sync.ts       # CLI entry point
  lib/
    utils.ts          # cn() helper
  app/
    globals.css       # Tailwind styles
    layout.tsx        # Root layout
    page.tsx          # Dashboard
    api/
      threads/route.ts    # GET threads list
      threads/[id]/route.ts # GET/PATCH single thread
      sync/route.ts       # Trigger sync
  components/
    JobBoard.tsx    # 3-column Kanban
    JobCard.tsx     # Thread card
    JobColumn.tsx   # Single column
    EmailThread.tsx # Thread detail view
    ui/             # shadcn components
```

---

## Re-classification

Threads are re-classified when:
1. New email arrives in the thread
2. User manually triggers re-classification
3. Periodic refresh (optional)

This ensures status stays current as conversations evolve.

---

## Email Fetching Best Practices

### Use mailparser for MIME decoding
ImapFlow's `fetchOne({ source: true })` returns raw email bytes. Use `mailparser.simpleParser()` to decode:
- Base64 encoded content
- Quoted-printable encoding
- Charset conversion (UTF-8, ISO-8859-1, etc.)

### Avoid IMAP command conflicts
**DON'T** nest `fetchOne()` inside `fetch()` iterator - causes hangs:
```typescript
// BAD - hangs!
for await (const msg of client.fetch(uids)) {
  await client.fetchOne(msg.uid, {...});
}
```

**DO** collect UIDs first, then fetch individually:
```typescript
// GOOD
for (const uid of uidsToSync) {
  const msg = await client.fetchOne(uid, { source: true });
}
```

---

## Verification Plan

1. **Sync test**: Emails fetched and stored in database
2. **Threading test**: Related emails grouped together
3. **Classification test**:
   - "Thank you" email → no_action
   - "We'll get back to you" from us → action_needed
   - "Can I get a quote?" from customer → quote_request
   - WE ask vendor for quote → no_action (not quote_request!)
   - PO from customer → po_received
   - WE send PO to vendor → no_action (not po_received!)
4. **UI test**: 3 columns display correctly, no_action threads hidden
