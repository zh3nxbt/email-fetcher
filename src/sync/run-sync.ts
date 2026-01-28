import "dotenv/config";
import { db, schema } from "@/db";
import { syncEmails } from "./syncer";

async function main() {
  console.log("=== Email Sync ===\n");

  try {
    // Sync emails from IMAP
    console.log("Syncing emails from IMAP...");
    const syncResult = await syncEmails();
    console.log(`  - Synced ${syncResult.emailsSynced} emails`);
    console.log(`  - Processed mailboxes: ${syncResult.mailboxesProcessed.join(", ")}`);
    if (syncResult.errors.length > 0) {
      console.log(`  - Errors: ${syncResult.errors.join(", ")}`);
    }

    // Summary
    const totalEmails = await db.select().from(schema.emails);
    console.log(`\nTotal emails in database: ${totalEmails.length}`);

    console.log("\n=== Sync complete ===");
    console.log("Run 'npm run report -- --preview' to generate a report.\n");
    process.exit(0);
  } catch (error) {
    console.error("Sync failed:", error);
    process.exit(1);
  }
}

main();
