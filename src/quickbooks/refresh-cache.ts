/**
 * CLI script to manually refresh the QB customer cache
 *
 * Usage: npm run qb:refresh-customers
 */

import "dotenv/config";
import { ConductorClient } from "./conductor-client.js";
import { refreshCustomerCache, getCacheStats } from "./customer-cache.js";

async function main() {
  console.log("=== QB Customer Cache Refresh ===\n");

  // Show current cache state
  const beforeStats = getCacheStats();
  if (beforeStats.exists) {
    console.log("Current cache:");
    console.log(`  Customers: ${beforeStats.customerCount}`);
    console.log(`  Age: ${beforeStats.ageHours} hours`);
    console.log(`  Stale: ${beforeStats.isStale}`);
    console.log("");
  } else {
    console.log("No existing cache found.\n");
  }

  // Refresh cache
  const client = new ConductorClient();
  await refreshCustomerCache(client);

  // Show new cache state
  const afterStats = getCacheStats();
  console.log("\nNew cache:");
  console.log(`  Customers: ${afterStats.customerCount}`);
  console.log(`  Age: ${afterStats.ageHours} hours`);

  process.exit(0);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
