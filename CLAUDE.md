# Claude Code Instructions

## Project Overview

Email sync and classification system for **MAS Precision Parts** - a precision parts manufacturing company. Syncs emails via IMAP, groups into threads, and uses AI to classify customer interactions.

## Critical Business Logic

### Who is MAS Precision Parts?
- **We are MAS Precision Parts** (sales@masprecisionparts.com)
- Emails FROM us are **outgoing** (we're sending to customers or vendors)
- Emails TO us are **incoming** (from customers or vendors)

### Customer vs Vendor Distinction
This is the MOST IMPORTANT classification rule:

| Scenario | Classification |
|----------|----------------|
| Customer sends US a PO | `po_received` ✓ |
| WE send a PO to vendor | `no_action` (we're buying) |
| Customer asks US for quote | `quote_request` ✓ |
| WE ask vendor for quote | `no_action` (we're buying) |
| Thread starts with [SENT] | Usually vendor interaction |
| Thread starts with [RECEIVED] | Usually customer interaction |

**Key rule:** If the FIRST email in a thread is [SENT], we initiated it = likely vendor/supplier interaction, not a customer.

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

### Database Operations

- **Batch queries** for checking existing UIDs (use `inArray()`)
- **Separate commands** for fetching vs classification:
  - `npm run sync` - Full sync (fetch + classify)
  - `npm run reclassify` - Re-classify only (keeps emails)
  - `npm run db:reset` - Clear everything

### Process Management

Always add `process.exit(0)` at end of CLI scripts - database connection keeps Node process alive.

### References Field

`parsed.references` from mailparser can be string OR array:
```typescript
references: Array.isArray(parsed.references)
  ? parsed.references.join(" ")
  : parsed.references || null
```

## Commands

```bash
npm run dev          # Start Next.js server
npm run sync         # Fetch emails + classify
npm run reclassify   # Re-classify without re-fetching
npm run db:reset     # Clear all data
npm run db:push      # Push schema to database
```

## Environment Variables

```env
IMAP_HOST=mail.example.com
IMAP_PORT=993
IMAP_USER=sales@masprecisionparts.com
IMAP_PASS=...
DATABASE_URL=...
ANTHROPIC_API_KEY=...
```

## File Locations

| Purpose | File |
|---------|------|
| Email sync | `src/sync/syncer.ts` |
| Classification prompt | `src/sync/classifier.ts` |
| Thread grouping | `src/sync/threader.ts` |
| IMAP parsing | `src/imap/parsers.ts` |
| Database schema | `src/db/schema.ts` |
