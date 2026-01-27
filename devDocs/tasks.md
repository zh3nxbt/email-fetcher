# Job Flow Tracker - Task Breakdown

## Completed Tasks

All initial implementation tasks have been completed. The project is now using:
- **Supabase PostgreSQL** instead of SQLite
- **Drizzle ORM** with PostgreSQL driver (`postgres`)
- **Table prefix**: All tables use `email_` prefix

---

## Database Tables (Supabase)

| Table | Description |
|-------|-------------|
| `email_messages` | Raw email records from IMAP sync |
| `email_threads` | Thread summaries with AI classification |
| `email_thread_messages` | Junction table linking emails to threads |

---

## Key Commands

```bash
# Development
npm run dev          # Start Next.js dev server

# Database
npm run db:push      # Push schema changes to database
npm run db:studio    # Open Drizzle Studio
npm run db:reset     # Clear all data (emails + threads)

# Email Sync & Classification
npm run sync         # Full sync: fetch emails + classify threads
npm run reclassify   # Re-classify only (keeps emails, re-runs AI)

# Build
npm run build        # Production build
npm run typecheck    # TypeScript check
```

### When to use which command:
- **Changed classification prompt?** → `npm run reclassify`
- **Fixed email fetching bug?** → `npm run db:reset && npm run sync`
- **Just want fresh AI classifications?** → `npm run reclassify`

---

## Environment Variables

```env
# IMAP Configuration
IMAP_HOST=mail.example.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=sales@example.com
IMAP_PASS=your-password

# Supabase Database (use Transaction Pooler URL)
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres

# AI Classification
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Architecture Overview

```
IMAP Server → Sync Service → Supabase PostgreSQL → Next.js Dashboard
                   ↓
            Claude Haiku (classification)
```

---

## 3-Column Kanban

| To Do | Quote Requests | PO Received / Jobs |
|-------|----------------|-------------------|
| Threads needing our response | Quote/pricing requests | Purchase orders |

**Hidden:** Threads with `no_action` or `not_customer` status

---

## Thread-Level AI Classification

Claude Haiku reads the **entire conversation** and determines:

| Status | Meaning | Column |
|--------|---------|--------|
| `action_needed` | We need to respond | To Do |
| `quote_request` | Customer wants pricing | Quote Requests |
| `po_received` | Customer sent PO | PO/Jobs |
| `no_action` | Resolved, "thank you", ball in their court | Hidden |
| `not_customer` | Spam, newsletter, internal | Hidden |

**Nuanced cases handled:**
- "Thank you!" → `no_action` (no reply needed)
- Us: "We'll get back to you tomorrow" → `action_needed` (we owe them)
- Customer: "I'll review and let you know" → `no_action` (waiting on them)

---

## Pending Tasks

### #4 - Add Authentication
**Priority:** High
**Status:** Not Started

Protect the dashboard and API endpoints with authentication.

**Options to consider:**
- NextAuth.js with credentials provider (simple username/password)
- NextAuth.js with OAuth (Google, GitHub)
- Supabase Auth (integrates with existing Supabase setup)

**Scope:**
- [ ] Add login page
- [ ] Protect all `/api/*` routes with auth middleware
- [ ] Protect dashboard page (redirect to login if not authenticated)
- [ ] Add logout functionality
- [ ] Store session securely

---

### #5 - Write Tests
**Priority:** High
**Status:** Not Started

Add unit and integration tests for critical paths.

**Test coverage needed:**
- [ ] `src/sync/threader.ts` - Thread grouping logic (most critical)
- [ ] `src/sync/classifier.ts` - AI classification (mock API calls)
- [ ] `src/imap/parsers.ts` - Email parsing edge cases
- [ ] API routes - `/api/threads`, `/api/threads/[id]`, `/api/sync`
- [ ] Database operations - CRUD for threads/emails

**Setup:**
- Install Vitest or Jest
- Add test scripts to package.json
- Create `__tests__/` directory structure

---

## Completed Tasks

- [x] Migrate from SQLite to Supabase PostgreSQL
- [x] Fix broken email fetch query (N+1 → batch queries)
- [x] Add pagination to thread list API
- [x] Add batch processing to prevent OOM
- [x] Rename tables with `email_` prefix
- [x] Fix email body decoding (use mailparser instead of manual decoding)
- [x] Fix IMAP hanging issue (don't nest fetchOne in fetch iterator)
- [x] Fix customer vs vendor classification (outgoing POs/quotes = no_action)
- [x] Add `npm run reclassify` command (re-classify without re-fetching)
- [x] Fix `in_reply_to` and `references` field parsing

---

## Backlog (Lower Priority)

- [ ] Add database indexes for performance
- [ ] Implement background job queue for sync
- [ ] Rate limiting for Claude API calls
- [ ] Drag-and-drop for Kanban board
- [ ] Email search/filter functionality
