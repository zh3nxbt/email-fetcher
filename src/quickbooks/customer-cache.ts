/**
 * Customer Cache with 24-hour TTL
 *
 * Caches QB customer list locally to avoid repeated API calls.
 * The cache is stored in data/qb-customers.json and refreshes every 24 hours.
 *
 * Benefits:
 * - Reduces API calls when matching emails to customers
 * - Enables using QB customer domains in trusted domain filter
 * - Single source of truth for customer list during analysis
 */

import fs from "fs";
import path from "path";
import type { ConductorClient } from "./conductor-client.js";
import type { QBCustomerMatch } from "./types.js";

// Cache configuration
const DATA_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(DATA_DIR, "qb-customers.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CustomerCache {
  customers: QBCustomerMatch[];
  timestamp: number; // Unix ms when cache was created
}

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Check if cache file exists
 */
function cacheExists(): boolean {
  return fs.existsSync(CACHE_FILE);
}

/**
 * Check if cache is stale (older than TTL)
 */
function isStale(): boolean {
  if (!cacheExists()) return true;

  try {
    const cache = loadCache();
    const age = Date.now() - cache.timestamp;
    return age >= CACHE_TTL_MS;
  } catch {
    return true;
  }
}

/**
 * Load cache from disk
 */
function loadCache(): CustomerCache {
  const content = fs.readFileSync(CACHE_FILE, "utf-8");
  return JSON.parse(content) as CustomerCache;
}

/**
 * Save cache to disk
 */
function saveCache(cache: CustomerCache): void {
  ensureDataDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Get customers from cache, refreshing if stale
 *
 * @param client - Conductor client for API calls
 * @returns Array of customers for matching
 */
export async function getCachedCustomers(
  client: ConductorClient
): Promise<QBCustomerMatch[]> {
  // Check if cache is fresh
  if (cacheExists() && !isStale()) {
    console.log("Using cached QB customer list");
    return loadCache().customers;
  }

  // Cache is stale or doesn't exist - refresh
  console.log("Fetching QB customer list from API...");
  const customers = await client.getCustomerListForMatching();
  saveCache({ customers, timestamp: Date.now() });
  console.log(`Cached ${customers.length} customers`);

  return customers;
}

/**
 * Force refresh the customer cache
 *
 * @param client - Conductor client for API calls
 */
export async function refreshCustomerCache(
  client: ConductorClient
): Promise<void> {
  console.log("Force refreshing QB customer cache...");
  const customers = await client.getCustomerListForMatching();
  saveCache({ customers, timestamp: Date.now() });
  console.log(`Cached ${customers.length} customers`);
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  exists: boolean;
  isStale: boolean;
  customerCount: number;
  ageHours: number | null;
} {
  if (!cacheExists()) {
    return { exists: false, isStale: true, customerCount: 0, ageHours: null };
  }

  try {
    const cache = loadCache();
    const ageMs = Date.now() - cache.timestamp;
    const ageHours = Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10;

    return {
      exists: true,
      isStale: isStale(),
      customerCount: cache.customers.length,
      ageHours,
    };
  } catch {
    return { exists: false, isStale: true, customerCount: 0, ageHours: null };
  }
}

/**
 * Delete the cache file
 */
export function clearCache(): void {
  if (cacheExists()) {
    fs.unlinkSync(CACHE_FILE);
    console.log("Customer cache cleared");
  }
}
