import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "./index.js";

async function migrate() {
  console.log("Running dashboard migration...\n");

  // 1. Create dash_todo_status enum
  const enumCheck = await db.execute(sql`
    SELECT 1 FROM pg_type WHERE typname = 'dash_todo_status'
  `);
  const enumExists = Array.isArray(enumCheck) ? enumCheck.length > 0 : false;

  if (!enumExists) {
    await db.execute(sql`CREATE TYPE dash_todo_status AS ENUM ('open', 'resolved', 'dismissed')`);
    console.log("Created enum: dash_todo_status");
  } else {
    console.log("Enum dash_todo_status already exists");
  }

  // 2. Create dash_todos table
  const dashTodosCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'dash_todos'
  `);
  const dashTodosExists = Array.isArray(dashTodosCheck) ? dashTodosCheck.length > 0 : false;

  if (!dashTodosExists) {
    await db.execute(sql`
      CREATE TABLE dash_todos (
        id SERIAL PRIMARY KEY,
        thread_key TEXT NOT NULL UNIQUE,
        todo_type email_todo_type NOT NULL,
        category email_category NOT NULL,
        item_type email_item_type NOT NULL,
        contact_email TEXT,
        contact_name TEXT,
        subject TEXT,
        summary TEXT,
        description TEXT,
        first_detected_at TIMESTAMP NOT NULL,
        last_email_date TIMESTAMP,
        email_count INTEGER DEFAULT 0,
        needs_response BOOLEAN DEFAULT TRUE,
        last_email_from_us BOOLEAN DEFAULT FALSE,
        status dash_todo_status NOT NULL DEFAULT 'open',
        resolved_at TIMESTAMP,
        resolved_by TEXT,
        po_details JSONB,
        is_suspicious BOOLEAN DEFAULT FALSE,
        ai_corrected BOOLEAN DEFAULT FALSE,
        original_category email_category,
        original_item_type email_item_type,
        qb_alert_id INTEGER REFERENCES qb_sync_alerts(id),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX dash_todos_status_idx ON dash_todos(status, first_detected_at)`);
    await db.execute(sql`CREATE INDEX dash_todos_thread_key_idx ON dash_todos(thread_key)`);
    await db.execute(sql`CREATE INDEX dash_todos_category_idx ON dash_todos(category)`);
    console.log("Created table: dash_todos (with 3 indexes)");
  } else {
    console.log("Table dash_todos already exists");
  }

  // 3. Create dash_ai_corrections table
  const aiCorCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'dash_ai_corrections'
  `);
  const aiCorExists = Array.isArray(aiCorCheck) ? aiCorCheck.length > 0 : false;

  if (!aiCorExists) {
    await db.execute(sql`
      CREATE TABLE dash_ai_corrections (
        id SERIAL PRIMARY KEY,
        thread_key TEXT NOT NULL,
        field_corrected TEXT NOT NULL,
        original_value TEXT NOT NULL,
        corrected_value TEXT NOT NULL,
        corrected_by TEXT DEFAULT 'user',
        corrected_at TIMESTAMP NOT NULL DEFAULT NOW(),
        applied_to_future BOOLEAN DEFAULT TRUE,
        notes TEXT
      )
    `);
    await db.execute(sql`CREATE INDEX dash_ai_corrections_field_idx ON dash_ai_corrections(field_corrected, corrected_at)`);
    await db.execute(sql`CREATE INDEX dash_ai_corrections_thread_key_idx ON dash_ai_corrections(thread_key)`);
    console.log("Created table: dash_ai_corrections (with 2 indexes)");
  } else {
    console.log("Table dash_ai_corrections already exists");
  }

  // 4. Create qb_write_log table
  const qbLogCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'qb_write_log'
  `);
  const qbLogExists = Array.isArray(qbLogCheck) ? qbLogCheck.length > 0 : false;

  if (!qbLogExists) {
    await db.execute(sql`
      CREATE TABLE qb_write_log (
        id SERIAL PRIMARY KEY,
        operation TEXT NOT NULL,
        qb_object_type TEXT NOT NULL,
        qb_object_id TEXT,
        qb_ref_number TEXT,
        input_data JSONB,
        response_data JSONB,
        triggered_by TEXT DEFAULT 'dashboard',
        alert_id INTEGER REFERENCES qb_sync_alerts(id),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        success BOOLEAN NOT NULL DEFAULT TRUE,
        error_message TEXT
      )
    `);
    console.log("Created table: qb_write_log");
  } else {
    console.log("Table qb_write_log already exists");
  }

  // 5. Seed dash_todos from latest report's todo_items + report_threads
  const seedCheck = await db.execute(sql`SELECT count(*) as cnt FROM dash_todos`);
  const seedCount = Array.isArray(seedCheck) ? Number(seedCheck[0]?.cnt ?? 0) : 0;

  if (seedCount === 0) {
    console.log("\nSeeding dash_todos from existing todo_items + report_threads...");

    // Get open (unresolved, non-dismissed) todos from the most recent reports.
    // For each thread_key, take the latest todo entry and enrich with report_thread data.
    const seeded = await db.execute(sql`
      INSERT INTO dash_todos (
        thread_key, todo_type, category, item_type,
        contact_email, contact_name, subject, summary, description,
        first_detected_at, last_email_date, email_count,
        needs_response, last_email_from_us,
        status, resolved_at, resolved_by,
        po_details, created_at, updated_at
      )
      SELECT DISTINCT ON (t.thread_key)
        t.thread_key,
        t.todo_type,
        COALESCE(rt.category, 'customer') AS category,
        COALESCE(rt.item_type, 'general') AS item_type,
        COALESCE(t.contact_email, rt.contact_email) AS contact_email,
        COALESCE(t.contact_name, rt.contact_name) AS contact_name,
        COALESCE(t.subject, rt.subject) AS subject,
        rt.summary,
        t.description,
        COALESCE(t.original_date, NOW()) AS first_detected_at,
        rt.last_email_date,
        COALESCE(rt.email_count, 0) AS email_count,
        COALESCE(NOT rt.last_email_from_us, TRUE) AS needs_response,
        COALESCE(rt.last_email_from_us, FALSE) AS last_email_from_us,
        CASE
          WHEN t.resolved THEN 'resolved'::dash_todo_status
          WHEN d.thread_key IS NOT NULL THEN 'dismissed'::dash_todo_status
          ELSE 'open'::dash_todo_status
        END AS status,
        t.resolved_at,
        CASE
          WHEN t.resolved THEN 'auto'
          WHEN d.thread_key IS NOT NULL THEN 'manual'
          ELSE NULL
        END AS resolved_by,
        rt.po_details,
        NOW(),
        NOW()
      FROM email_todo_items t
      LEFT JOIN email_report_threads rt
        ON rt.thread_key = t.thread_key
        AND rt.report_id = t.report_id
      LEFT JOIN email_dismissed_threads d
        ON d.thread_key = t.thread_key
      ORDER BY t.thread_key, t.id DESC
      ON CONFLICT (thread_key) DO NOTHING
    `);

    // Count what we seeded
    const afterSeed = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'open') AS open,
        count(*) FILTER (WHERE status = 'resolved') AS resolved,
        count(*) FILTER (WHERE status = 'dismissed') AS dismissed
      FROM dash_todos
    `);
    const counts = Array.isArray(afterSeed) ? afterSeed[0] : {};
    console.log(`Seeded dash_todos: ${counts.open ?? 0} open, ${counts.resolved ?? 0} resolved, ${counts.dismissed ?? 0} dismissed`);
  } else {
    console.log(`\ndash_todos already has ${seedCount} rows, skipping seed`);
  }

  console.log("\nDashboard migration complete!");
  process.exit(0);
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
