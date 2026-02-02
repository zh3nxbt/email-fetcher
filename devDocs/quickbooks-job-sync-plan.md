# QuickBooks Job Sync & Alert System

## Goal
Create an alert system that compares email-detected POs with QuickBooks data to identify sync discrepancies. When a customer sends a PO, the corresponding QB estimate should be marked "CONFIRMED" (or converted to a Sales Order).

## Architecture Decision
**Extend current repo** - shares email sync, database, and AI infrastructure. New modules will be clearly separated.

## Required QB Data Access
The system needs to access these QuickBooks entities:

| Entity | Purpose |
|--------|---------|
| **Customers** | Match email contacts to QB customer records |
| **Sales Orders** | **PRIMARY** - Check if SO exists for received PO |
| **Estimates** | **FALLBACK** - Find matching estimate when no SO exists |
| **Invoices** | Complete the documentation chain - verify jobs are invoiced |

**Workflow:**
1. PO received via email
2. Check if Sales Order exists for this customer/job → **if yes, all good**
3. If no Sales Order → find matching Estimate and flag "needs SO"
4. After job complete → verify Invoice was created

**Decision:** Sales Orders are the source of truth. Estimate status (CONFIRMED/COMPLETE) is NOT used.

## Current File Structure
```
src/
  quickbooks/                    # QB integration
    conductor-client.ts          # ✅ Conductor API client
    types.ts                     # ✅ QB entity types (Customer, Estimate, SalesOrder, Invoice)
    customer-matcher.ts          # ✅ Fuzzy matching email contacts to QB customers
    customer-cache.ts            # ✅ 24h TTL cache for QB customer list
    job-documents.ts             # ✅ Unified job document fetching + matching
    invoice-so-matcher.ts        # ✅ LLM-based invoice/SO line item matching
    trusted-domains.ts           # ✅ Domain trust filter (sent emails + whitelist + QB customers)
    index.ts                     # ✅ Module exports
    test-connection.ts           # ✅ Test script (npm run qb:test)
    refresh-cache.ts             # ✅ Manual cache refresh (npm run qb:refresh-customers)
  jobs/                          # Job tracking
    sync-analyzer.ts             # ✅ Compare emails vs QB data (legacy, console-only)
    alert-manager.ts             # ✅ Alert persistence, escalation, auto-resolution
    alert-templates.ts           # ✅ HTML email templates for alerts
    run-jobs-report.ts           # ✅ CLI entry point (npm run jobs:check)
    test-sync-analyzer.ts        # ✅ Test script (npm run qb:sync-analyze)
data/
  qb-customers.json              # Cached QB customer list (auto-generated)
```

## Implementation Phases

### Phase 1: Port Conductor Client to TypeScript ✅
- [x] Copy `temp/mas-quickbooks-data/conductor-client.js` logic
- [x] Convert to TypeScript with proper types
- [x] Methods implemented:
  - `getCustomers()` / `getCustomer(id)`
  - `getEstimates()` / `getEstimate(id)` / `getEstimatesForCustomer()`
  - `getSalesOrders()` / `getSalesOrder(id)` / `getSalesOrdersForCustomer()`
  - `getInvoices()` / `getInvoice(id)` / `getInvoicesForCustomer()`
  - `getVendors()` / `getVendor(id)`
  - `testConnection()`
- [x] Env vars: `CONDUCTOR_API_KEY`, `CONDUCTOR_END_USER_ID`

### Phase 2: Customer Matching ✅
- [x] Created `customer-matcher.ts`
- [x] Fetch QB customers with `getCustomerListForMatching()`
- [x] Match email `contactEmail` or `contactName` to QB customer
- [x] Fuzzy matching (normalize names, handle variations)
- [x] Returns `{ customerId, customerName, confidence, matchType }` or `null`

### Phase 3: Job Documents Organization ✅
- [x] Created `job-documents.ts` with:
  - `getCustomerJobDocuments()` - fetches sales orders, invoices, estimates in parallel
  - `findMatchingSalesOrder()` - matches PO to existing SO by ref/amount
  - `findMatchingEstimate()` - fallback when no SO exists
  - `getJobDocumentsSummary()` - statistics for quick overview
- [x] Added to test script (`npm run qb:test`)

**Decision:** Sales Orders are the PRIMARY source of truth. Estimates are fallback only (used to identify which estimate needs to be converted to SO).

### Phase 3.25: Customer Cache ✅
Created `customer-cache.ts` to reduce API calls:
- [x] `getCachedCustomers()` - returns cached list or fetches fresh
- [x] 24-hour TTL, stored in `data/qb-customers.json`
- [x] `refreshCustomerCache()` - force refresh
- [x] CLI: `npm run qb:refresh-customers`

**Benefits:**
- Sync analyzer can run multiple times without hammering QB API
- Trusted domain filter uses cached customer emails
- Customer matching uses cached list for fuzzy search

### Phase 3.5: Trusted Domain Filter ✅
Created `trusted-domains.ts` to prevent processing emails from suspicious domains:
- [x] `getTrustedDomains()` - builds combined set from:
  - Domains we've emailed (extracted from sent folder recipients)
  - Manual whitelist from `TRUSTED_DOMAINS` env var
  - QB customer email domains (from cached customer list)
- [x] `isDomainTrusted(email, trustedDomains)` - checks if email domain is trusted
- [x] `getTrustedDomainsStats()` - debugging/logging helper
- [x] Added to test script (`npm run qb:test`)

**Why this matters:**
- Protects against analyzing infected PDF attachments from phishing emails
- Prevents wasting API calls matching phishing emails to QB customers
- Automatically trusts domains we have business relationships with

**Config:**
```env
# Optional manual whitelist (comma-separated)
TRUSTED_DOMAINS=newvendor.com,legitcustomer.ca
```

### Phase 4: Sync Analyzer ✅
Created `sync-analyzer.ts` with full PO→QB comparison logic:
- [x] Trust filter integration (skip untrusted domains before PDF analysis)
- [x] Input: Recent `po_received` threads from database
- [x] Logic:
  ```
  For each po_received thread:
    1. Skip if domain is untrusted → suspicious_po_email alert
    2. Extract PO details from PDF attachments (Claude vision)
    3. Find matching QB customer (fuzzy matching)
    4. If no customer match → no_qb_customer alert
    5. Find Sales Orders for customer by PO# or amount
    6. If SO found → po_has_so (all good)
    7. If no SO, check for matching Estimate → po_no_so_has_estimate
    8. If no SO and no Estimate → po_no_so_no_estimate
  ```
- [x] Output: Array of `SyncAlert` objects
- [x] Test script: `npm run qb:sync-analyze`

### Phase 5: Alert Types ✅
Implemented in `sync-analyzer.ts`:
```typescript
type SyncAlertType =
  | "po_has_so"             // PO received, matching Sales Order found (all good)
  | "po_no_so_has_estimate" // PO received, no SO but found matching estimate
  | "po_no_so_no_estimate"  // PO received, no SO and no matching estimate
  | "no_qb_customer"        // Can't match email to any QB customer
  | "suspicious_po_email"   // PO email from untrusted domain (potential phishing)

interface SyncAlert {
  type: SyncAlertType
  threadKey: string
  subject: string
  contactEmail: string
  contactName: string
  poDetails?: { poNumber?: string, total?: number }
  qbCustomer?: { id: string, name: string, confidence: string }
  salesOrder?: { id: string, refNumber: string, totalAmount: number }
  estimate?: { id: string, refNumber: string, totalAmount: number }
  message: string
}
```

**Alert descriptions:**
| Alert Type | Trigger | Suggested Action |
|------------|---------|------------------|
| `po_has_so` | PO received, matching Sales Order exists | No action needed (informational) |
| `po_no_so_has_estimate` | PO received, no SO but estimate found | Convert estimate to Sales Order |
| `po_no_so_no_estimate` | PO received, no SO and no estimate | Create Sales Order |
| `no_qb_customer` | Can't match email to QB customer | Add customer to QuickBooks |
| `suspicious_po_email` | PO email from domain we've never emailed | Review manually - may be phishing or new customer |

**Note:** `job_not_invoiced` alert moved to future phase (requires tracking SO completion status).

### Phase 6: Scheduled Alerts with Persistence ✅
**Prerequisite:** Phase 4 & 5 complete ✅

**Implemented:** 2-stage alert model with database persistence

**Schedule:**
- `npm run jobs:check --morning` at 7am/9am EST (morning review)
- `npm run jobs:check` hourly 9am-4pm EST (incremental)

**New Database Table:** `qb_sync_alerts`
- Persists all alerts for historical tracking
- Tracks 2-stage lifecycle (detected → escalated → resolved)
- Notification tracking to avoid duplicate emails

**2-Stage Alert Model:**

Stage 1 (Immediate - on PO detection):
| Alert Type | Trigger |
|------------|---------|
| `po_detected` | New PO, no SO yet |
| `po_detected_with_so` | New PO, SO already exists (informational) |
| `no_qb_customer` | Can't match email to QB customer |
| `suspicious_po_email` | Untrusted domain |

Stage 2 (Escalation - 4 hours after Stage 1):
| Alert Type | Trigger |
|------------|---------|
| `po_missing_so` | 4+ hours since detection, still no SO |

Invoice/SO Integrity:
| Alert Type | Trigger |
|------------|---------|
| `so_should_be_closed` | Invoice exists, SO open, Invoice >= SO total |

**Files created:**
- `src/db/schema.ts` - Added `qbSyncAlerts` table and enums
- `src/quickbooks/invoice-so-matcher.ts` - LLM-based line item matching
- `src/jobs/alert-manager.ts` - Alert persistence, escalation, auto-resolution
- `src/jobs/alert-templates.ts` - HTML email templates for alerts
- `src/jobs/run-jobs-report.ts` - CLI entry point

**Commands:**
```bash
npm run jobs:check              # Hourly check + email
npm run jobs:check --preview    # Show without sending
npm run jobs:check --morning    # Morning review mode
```

**Hourly Flow:**
1. Sync recent emails (last 2 hours)
2. Stage 1: Create alerts for new POs
3. Stage 2: Check for 4-hour escalations
4. Auto-resolve any alerts where SO appeared
5. Send email if new alerts or escalations

**Morning Review:**
- Full summary of all open alerts
- Overnight PO detections
- Open escalations (still no SO)
- Outstanding no_qb_customer alerts
- Suspicious email warnings
- SOs that should be closed

**Auto-Resolution:**
- `po_detected` → Resolves when SO appears (before escalation)
- `po_missing_so` → Resolves when SO appears
- `no_qb_customer` → Resolves when customer added to QB

## Related Work: PDF Vision Analysis ✅

Implemented visual PDF analysis for extracting PO details from email attachments:
- `src/report/pdf-extractor.ts` - sends PDF as base64 to Claude for visual analysis
- Replaces old text-extraction approach (pdf-parse) which lost formatting
- Test script: `src/report/test-pdf-vision.ts`

**TODO:** Add DOCX support (Claude doesn't support DOCX directly)

## Matching Strategy
Since PO numbers may not directly match estimate numbers:
1. **Primary**: Customer email/name match
2. **Secondary**: Amount within tolerance (±5%)
3. **Tertiary**: Date proximity (estimate created before PO received)
4. **Manual override**: Store confirmed matches in DB

## Verification Plan
1. [x] Run test script to verify Conductor connection
2. [x] Verify customer matching works (check a known customer)
3. [x] Verify estimate/sales order fetching returns expected data
4. [x] Test edge cases: new customer (no QB match) → generates `no_qb_customer` alert
5. [x] Test trusted domain filter with real sent emails + QB customer domains
6. [x] Test sync analyzer end-to-end with `npm run qb:sync-analyze`

## Future Enhancements

### Phase 7: `job_not_invoiced` Alert (Planned)
Flag Sales Orders that are likely complete but haven't been invoiced.

**Detection Methods:**
1. **Time-based**: SO is 45+ days old with no matching invoice
2. **Email signals**: Check sent emails for completion indicators:
   - Shipping notifications ("shipped", "tracking number")
   - Completion messages ("job complete", "parts ready for pickup")
   - Delivery confirmations

**Alert Type:**
| Alert | Trigger | Action |
|-------|---------|--------|
| `job_not_invoiced` | SO 45+ days old OR email signals completion, no invoice | Create invoice |

**Implementation Notes:**
- QB doesn't track job completion status directly
- Combine time threshold + email analysis for higher confidence
- May need AI to classify "completion" emails from thread history

### Other Future Work
- Dashboard UI for job tracking / alert history
- Manual alert dismissal via API
- Auto-update QB estimate status via API (if Conductor supports writes)
- Sales Order conversion workflow
- DOCX attachment support (convert to PDF or extract text)
