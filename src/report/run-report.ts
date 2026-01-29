import "dotenv/config";
import { runDailySummary, runMorningReminder, runMiddayReport } from "./generator";
import { syncEmails } from "@/sync/syncer";
import type { ReportOptions } from "./types";

function parseArgs(): { morning: boolean; midday: boolean; options: ReportOptions } {
  const args = process.argv.slice(2);
  const morning = args.includes("--morning");
  const midday = args.includes("--midday");
  const preview = args.includes("--preview");
  const skipEmail = args.includes("--skip-email");

  let date: Date | undefined;
  const dateArg = args.find((arg) => arg.startsWith("--date="));
  if (dateArg) {
    const dateStr = dateArg.split("=")[1];
    date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      console.error(`Invalid date: ${dateStr}`);
      process.exit(1);
    }
  }

  return {
    morning,
    midday,
    options: { date, preview, skipEmail },
  };
}

function printUsage() {
  console.log(`
Usage: npm run report [options]

Options:
  --morning      Generate 7am morning reminder instead of 4pm daily summary
  --midday       Generate 12pm midday report instead of 4pm daily summary
  --preview      Output to console, don't save or email
  --skip-email   Save to database but don't send email
  --date=YYYY-MM-DD  Generate report for a specific date

Examples:
  npm run report                    # Generate and send 4pm daily summary
  npm run report -- --preview       # Preview daily summary in console
  npm run report -- --morning       # Generate and send 7am morning reminder
  npm run report -- --midday        # Generate and send 12pm midday report
  npm run report -- --date=2024-01-15 --preview   # Preview historical report
`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const { morning, midday, options } = parseArgs();

  try {
    // Sync emails first (unless previewing historical data)
    if (!options.date) {
      console.log("Syncing emails...");
      const syncResult = await syncEmails();
      console.log(`Synced ${syncResult.emailsSynced} emails\n`);
    }

    if (morning) {
      await runMorningReminder(options);
    } else if (midday) {
      await runMiddayReport(options);
    } else {
      await runDailySummary(options);
    }
    process.exit(0);
  } catch (error) {
    console.error("Report generation failed:", error);
    process.exit(1);
  }
}

main();
