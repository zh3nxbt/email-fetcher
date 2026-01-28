# Email Classification Logic

This document explains how the system categorizes emails, identifies action items (todos), and determines priority. Understanding this logic helps interpret report results and troubleshoot classification issues.

---

## Who is MAS Precision Parts?

**We are MAS Precision Parts** (sales@masprecisionparts.com) - a precision parts manufacturing company.

- Emails **FROM** us (or from Sent/Sent Messages mailbox) = **Outbound** [SENT]
- Emails **TO** us = **Inbound** [RECEIVED]

**Note:** Our IMAP server has two sent folders: `Sent` and `Sent Messages`. Both are synced.

---

## Thread Categories

Every email thread is classified into one of three categories:

### Customer
**Definition**: They are buying from us. The external party initiated contact seeking our products/services.

**How we determine this**:
- First email in thread is **[RECEIVED]** (they contacted us first)
- AI confirms they are inquiring about our services, requesting quotes, or placing orders

**Examples**:
- Customer emails asking about our capabilities
- Customer requests a quote for machining parts
- Customer sends a purchase order to us

### Vendor
**Definition**: We are buying from them. We initiated contact to purchase materials or services.

**How we determine this**:
- First email in thread is **[SENT]** (we contacted them first)
- AI confirms we are inquiring about their products, requesting quotes, or placing orders

**Examples**:
- We email a supplier asking for material pricing
- We send a purchase order to a vendor
- We follow up on a delivery from our supplier

### Other
**Definition**: Not a customer or vendor interaction. No action typically needed.

**How we determine this**:
- Email matches automated patterns (see below)
- AI determines it's not a business transaction

**Automated email patterns detected**:
- `newsletter`, `noreply`, `no-reply`, `donotreply`
- `automated`, `notification`, `alert@`
- `mailer-daemon`, `postmaster`

**Examples**:
- Newsletters and marketing emails
- System notifications
- Spam
- Internal company emails

---

## Item Types

Within Customer and Vendor categories, threads are further classified by item type:

| Item Type | Category | Description |
|-----------|----------|-------------|
| `po_received` | Customer | Customer sent us a purchase order |
| `po_sent` | Vendor | We sent a purchase order to vendor |
| `quote_request` | Customer | Customer asking us for pricing/quote |
| `general` | Both | General inquiry, question, conversation |
| `other` | Both | Doesn't fit other categories |

### AI Classification (Batch Mode)

For efficiency, threads are classified in batches (up to 20 threads per API call):

1. All threads are formatted as JSON with their emails
2. Single API call to Claude Haiku processes all threads
3. Response contains categorization for each thread
4. Fallback to individual calls if batch fails

**AI determines for each thread:**
```
1. CATEGORY: customer | vendor | other
2. ITEM_TYPE: po_received | po_sent | quote_request | general | other
3. CONTACT_NAME: Extracted from the external party
4. SUMMARY: 1-2 sentence description of thread status
5. NEEDS_RESPONSE: Does the last email require a response from us?
6. RELATED_TO: ThreadKey of related thread (for cross-thread merging)
```

**Performance:** 15 threads = 1 API call (vs 15 individual calls)

### needsResponse Detection

The AI analyzes the **last email** in each thread to determine if a response is expected:

- `true`: Customer asked a question, made a request, expects action
- `false`: Last email is "thanks", "sounds good", acknowledgment, or no response expected

**Why this matters:** Without this, a thread ending with "Thanks for the update!" would incorrectly create a todo.

### relatedTo Detection (Cross-Thread Merging)

The AI identifies when one thread is a **response** to another thread:

**Example scenario:**
- Thread A: "RFQ Plates" (we sent RFQ to vendor)
- Thread B: "Estimate 28522 from Valk's Machinery" (vendor sent quote via QuickBooks - different email chain)

These should be one thread but have different Message-IDs and subjects. The AI detects:
- Same vendor
- Matching part numbers/products
- Timing suggests response to our RFQ

When `relatedTo` is set, the categorizer merges these threads into one.

---

## Todo Flags (Action Items)

Todos are identified for **customer threads only** where the **last email is NOT from us**. This means the customer is waiting for our response.

### Todo Types

| Todo Type | Trigger Condition | Description |
|-----------|------------------|-------------|
| `po_unacknowledged` | Customer thread + item_type = `po_received` + last email from them | Customer sent a PO and we haven't acknowledged it |
| `quote_unanswered` | Customer thread + item_type = `quote_request` + last email from them | Customer requested a quote and we haven't responded |
| `general_unanswered` | Customer thread + item_type = `general` or `other` + last email from them | Customer email awaiting our response |

### Key Rule: "Last Email From Us"

This is the critical check for todo identification:

- **Last email [SENT]** = We replied = **No todo needed**
- **Last email [RECEIVED]** = Customer waiting = **Todo created** (if `needsResponse` is true)

### When Todos Are NOT Created

- **Vendor threads**: We don't track action items for vendor interactions
- **Other threads**: Newsletters, spam, etc. don't need action
- **We replied last**: If the most recent email is from us, the ball is in their court
- **needsResponse = false**: AI determined last email doesn't need a reply (e.g., "Thanks!")

### UI Labels

Todos and threads are displayed with labels indicating what action is needed:

**Todo Labels** (left side of action items):
| Todo Type | Label |
|-----------|-------|
| `po_unacknowledged` | "Need to Ack PO" |
| `quote_unanswered` | "Need to Send Quote" |
| `general_unanswered` | "Need to Reply" |

**Thread Labels** (left side of thread summaries):
| Item Type | Label |
|-----------|-------|
| `po_received` | "PO Received" |
| `po_sent` | "PO Sent" |
| `quote_request` | "RFQ" |
| `general` | "General" |

### Thread Sorting

Within each section (Customers, Vendors), threads are sorted by business priority:

**Sort Order:**
1. PO Received / PO Sent (highest priority - money involved)
2. RFQ / Quote Request (potential money)
3. General
4. Other (lowest priority)

### Visual Separation

Reports visually distinguish sections:
- **Action Items**: Amber/yellow background with border (`#fef3c7` bg, `#f59e0b` border)
- **Customer/Vendor Summaries**: Gray background (`#f9fafb`)

This makes it immediately clear what needs attention.

---

## Todo Resolution

A todo is marked as **resolved** when:

1. New email activity occurs in that thread
2. The **last email in the thread is now from us**

This happens during report generation:
- 7am report checks overnight emails against yesterday's 4pm todos
- 4pm report checks daytime emails against morning's 7am todos

Resolved todos appear with ~~strikethrough~~ and a "RESOLVED" badge in reports.

---

## Priority Assignment

Todos are assigned priority based on type and age:

| Todo Type | Age | Priority |
|-----------|-----|----------|
| `po_unacknowledged` | Any | **HIGH** (red) |
| `quote_unanswered` | ≤ 2 days | MEDIUM (orange) |
| `quote_unanswered` | > 2 days | **HIGH** (red) |
| `general_unanswered` | ≤ 3 days | LOW (gray) |
| `general_unanswered` | > 3 days | MEDIUM (orange) |

**Rationale**:
- POs are always urgent - customer is ready to buy
- Quote requests become urgent if we're slow to respond
- General emails have more leeway but shouldn't be ignored

---

## Classification Decision Tree

```
1. Is email from automated source?
   YES → Category: OTHER, No todo
   NO → Continue

2. Is first email in thread [SENT]?
   YES → Category: VENDOR (we initiated, we're buying)
   NO → Category: CUSTOMER (they initiated, they're buying)

3. [AI Analysis] What type of interaction?
   → PO involved? → po_received (customer) or po_sent (vendor)
   → Quote request? → quote_request
   → Otherwise → general

4. [Customer threads only] Is last email from us?
   YES → No todo needed
   NO → Create todo based on item_type
```

---

## PO Details Extraction

For **vendor threads** with PDF attachments, the system:

1. Downloads PDF attachments from IMAP
2. Extracts text using `pdf-parse`
3. Uses AI to extract structured data:
   - PO Number
   - Vendor name
   - Line items (description, quantity, unit price, line total)
   - Total amount
   - Currency

This helps track what we've ordered and from whom.

---

## Common Classification Scenarios

| Scenario | Category | Item Type | needsResponse | Todo? |
|----------|----------|-----------|---------------|-------|
| Customer: "Can you quote 100 units?" | customer | quote_request | true | YES |
| Us: "Here's your quote attached" | customer | quote_request | - | NO (we replied) |
| Customer: "PO #12345 attached" | customer | po_received | true | YES |
| Customer: "Sounds great, thanks for the update!" | customer | general | **false** | NO |
| Customer: "Okay, we'll review and get back to you" | customer | general | **false** | NO |
| Us to vendor: "Please send quote for steel" | vendor | general | - | NO (vendor) |
| Vendor: "Estimate 28522 attached" | vendor | general | - | NO (vendor) |
| Us to vendor: "PO attached for 500 units" | vendor | po_sent | - | NO |
| Newsletter from supplier | other | other | - | NO |
| Us: "We'll check and get back to you" | customer | general | - | NO (we replied) |

**Key insight:** The `needsResponse` field catches "thanks" and acknowledgment messages that don't require action, preventing false positive todos.

---

## Thread Grouping Algorithm

Located in `src/sync/threader.ts`. Uses a 3-pass approach:

### Pass 1: Message-ID/References
Standard email threading using the References header chain.

### Pass 2: In-Reply-To Fallback
For emails with In-Reply-To header but broken/missing References.

### Pass 3: Subject-based Merging
Merges threads with the same normalized subject (ignoring "RE:", "FW:", etc.).

**Example:** "PO 1049" and "RE: PO 1049" become one thread even if Message-IDs don't match.

### AI relatedTo Merging
After AI classification, threads with `relatedTo` set are merged in `categorizer.ts`.

**Example:** Vendor quote via QuickBooks (new email chain) merged with our original RFQ.

---

## Troubleshooting Classification

### Thread in wrong category?
- Check if first email direction is correct (INBOX vs Sent mailbox)
- Check if our domain detection is working (`OUR_DOMAIN` env var)

### Missing sent emails?
- Server has two sent folders: `Sent` and `Sent Messages`
- Verify both are being synced (check `MAILBOXES` in syncer.ts)
- Run `npm run sync` to fetch any missing emails

### Related threads not merged?
- Subject-based merge requires normalized subject match (>5 chars)
- AI relatedTo detection requires semantic relationship (same vendor, matching products)
- Check console logs for "Merging ... into related thread"

### Todo not appearing?
- Verify it's a customer thread (not vendor)
- Check if last email is truly from the customer
- Check if `needsResponse` is `false` (AI determined no reply needed)
- Confirm item_type is being detected correctly

### Todo appearing incorrectly?
- We may have replied but email not synced yet
- Thread may have been re-categorized after AI review
- Check if last email is a "thanks" that AI should have caught

### False positive todo (e.g., "Thanks for the update!")?
- AI `needsResponse` detection should catch these
- Check `src/report/summarizer.ts` prompt for the needsResponse field
- May need to add more examples to AI prompt

### PO details missing?
- Only extracted for vendor threads with PDF attachments
- PDF may not be parseable (image-based, encrypted)
- AI extraction may have failed (check logs)

### Emails from wrong date range?
- IMAP SINCE search is date-only (ignores time)
- Post-filter in database if precise datetime cutoff needed
- CLI date arg should include time: `--date=2026-01-26T12:00:00`

### Web UI not showing report?
- Check if report exists in database for selected date/type
- Use "Generate Report" button to create new report
- Check browser console for API errors
