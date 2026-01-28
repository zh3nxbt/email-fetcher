import "dotenv/config";
import { db } from "./index";
import { sql } from "drizzle-orm";

async function migrate() {
  console.log("Creating email_dismissed_threads table...");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS email_dismissed_threads (
      id SERIAL PRIMARY KEY,
      thread_key TEXT NOT NULL UNIQUE,
      dismissed_at TIMESTAMP NOT NULL,
      reason TEXT
    )
  `);

  console.log("Table created successfully!");
  process.exit(0);
}

migrate().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
