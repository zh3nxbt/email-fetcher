import "dotenv/config";
import { db, schema } from "./index";

async function reset() {
  console.log("Clearing all data...");

  // Delete in order due to foreign key constraints
  await db.delete(schema.todoItems);
  console.log("  - Cleared todo_items");

  await db.delete(schema.reportThreads);
  console.log("  - Cleared report_threads");

  await db.delete(schema.dailyReports);
  console.log("  - Cleared daily_reports");

  await db.delete(schema.emails);
  console.log("  - Cleared emails");

  console.log("Done! Run 'npm run sync' to re-sync emails.");
  process.exit(0);
}

reset().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
