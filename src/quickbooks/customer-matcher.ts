/**
 * Customer Matching
 *
 * Matches email contacts to QuickBooks customers using fuzzy matching
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { ConductorClient } from "./conductor-client.js";
import { getCachedCustomers } from "./customer-cache.js";
import type { QBCustomerMatch } from "./types.js";

// ============================================================
// Domain-to-Customer Mapping
// ============================================================

interface DomainMapping {
  qbCustomerName?: string; // Single customer (legacy)
  qbCustomerNames?: string[]; // Multiple customers
  note?: string;
}

let domainMappings: Record<string, DomainMapping> | null = null;

function loadDomainMappings(): Record<string, DomainMapping> {
  if (domainMappings) return domainMappings;

  const path = join(process.cwd(), "data", "domain-customer-mappings.json");
  if (!existsSync(path)) {
    domainMappings = {};
    return domainMappings;
  }

  try {
    domainMappings = JSON.parse(readFileSync(path, "utf-8"));
    return domainMappings!;
  } catch (e) {
    console.warn("Failed to load domain-customer-mappings.json:", e);
    domainMappings = {};
    return domainMappings;
  }
}

/**
 * Find domain mapping with subdomain fallback
 * e.g., "supplier.magna.com" → check "supplier.magna.com" → check "magna.com"
 *
 * Security: Only allows fallback for known safe subdomain patterns to prevent
 * attacker.domain.com from matching domain.com
 */
function findDomainMapping(
  domain: string,
  mappings: Record<string, DomainMapping>
): DomainMapping | null {
  // Exact match first
  if (mappings[domain]) return mappings[domain];

  // Try parent domain (remove first segment) - but only for safe subdomain patterns
  const parts = domain.split(".");
  if (parts.length > 2) {
    const subdomain = parts[0].toLowerCase();

    // Only allow fallback for common business subdomain patterns
    const safeSubdomains = [
      "mail", "email", "smtp",
      "sales", "orders", "purchasing",
      "ap", "ar", "accounts", "accounting",
      "portal", "secure", "b2b",
      "supplier", "vendor", "customer",
    ];

    if (safeSubdomains.includes(subdomain)) {
      const parent = parts.slice(1).join(".");
      if (mappings[parent]) return mappings[parent];
    }
  }

  return null;
}

export interface MatchResult {
  customerId: string;
  customerName: string;
  customerFullName: string;
  confidence: "exact" | "high" | "medium" | "low";
  matchType: "email" | "name" | "company" | "domain_mapping";
  matchedValue: string;
}

export interface CustomerMatcher {
  match(contactEmail: string, contactName?: string): Promise<MatchResult | null>;
  matchAll(contactEmail: string, contactName?: string): Promise<MatchResult[]>;
  refreshCache(): Promise<void>;
}

/**
 * Normalize a string for comparison
 * - Lowercase
 * - Remove common suffixes (Inc, LLC, Ltd, etc.)
 * - Remove punctuation and extra spaces
 */
function normalizeForComparison(str: string): string {
  return str
    .toLowerCase()
    .replace(/[.,'"!?()]/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|limited|incorporated)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract company name from email domain
 * e.g., "john@acme-tools.com" -> "acme tools"
 * e.g., "orders@sales.customer-domain.ca" -> "customer domain"
 *
 * Correctly handles subdomains by extracting the main domain before TLD
 */
function extractCompanyFromEmail(email: string): string | null {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return null;

  const fullDomain = email.slice(atIndex + 1).toLowerCase();
  const parts = fullDomain.split(".");

  // Need at least domain + TLD (e.g., "example.com")
  if (parts.length < 2) return null;

  // Get the domain part (second to last) - handles subdomains like sales.customer.com
  // For "sales.customer-domain.ca" → parts = ["sales", "customer-domain", "ca"]
  // We want "customer-domain" (index length-2)
  const domainPart = parts[parts.length - 2];

  // Skip generic email providers
  const genericDomains = [
    "gmail", "yahoo", "hotmail", "outlook", "aol", "icloud", "mail",
    "protonmail", "zoho", "yandex", "live", "msn"
  ];
  if (genericDomains.includes(domainPart)) return null;

  // Convert hyphens/underscores to spaces for matching
  return domainPart.replace(/[-_]/g, " ");
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses Levenshtein distance normalized by max length
 */
function stringSimilarity(a: string, b: string): number {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);

  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;

  // Check if one contains the other
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return shorter / longer;
  }

  // Levenshtein distance
  const matrix: number[][] = [];
  for (let i = 0; i <= na.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= nb.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= na.length; i++) {
    for (let j = 1; j <= nb.length; j++) {
      const cost = na[i - 1] === nb[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  const distance = matrix[na.length][nb.length];
  const maxLen = Math.max(na.length, nb.length);
  return 1 - distance / maxLen;
}

/**
 * Check if two strings are likely the same entity with variations
 * e.g., "TNT Tools" vs "T.N.T. TOOLS 2025 INC"
 */
function areVariationsOfSame(a: string, b: string): boolean {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);

  // Exact match after normalization
  if (na === nb) return true;

  // Remove all non-alphanumeric and compare
  const aClean = na.replace(/[^a-z0-9]/g, "");
  const bClean = nb.replace(/[^a-z0-9]/g, "");
  if (aClean === bClean) return true;

  // Check if the shorter is contained in the longer
  const shorter = aClean.length < bClean.length ? aClean : bClean;
  const longer = aClean.length < bClean.length ? bClean : aClean;
  if (longer.includes(shorter) && shorter.length >= 4) return true;

  return false;
}

export function createCustomerMatcher(client: ConductorClient): CustomerMatcher {
  let cachedCustomers: QBCustomerMatch[] | null = null;

  async function ensureCache(): Promise<QBCustomerMatch[]> {
    if (!cachedCustomers) {
      cachedCustomers = await getCachedCustomers(client);
    }
    return cachedCustomers;
  }

  async function matchAll(
    contactEmail: string,
    contactName?: string
  ): Promise<MatchResult[]> {
    const customers = await ensureCache();
    const results: MatchResult[] = [];
    const emailLower = contactEmail.toLowerCase();
    const companyFromEmail = extractCompanyFromEmail(contactEmail);

    // 0. Domain mapping lookup (highest priority - explicit mappings)
    const domain = contactEmail.split("@")[1]?.toLowerCase();
    if (domain) {
      const mappings = loadDomainMappings();
      const mapping = findDomainMapping(domain, mappings);
      if (mapping) {
        // Support both single and multiple customer names
        const customerNames = mapping.qbCustomerNames ||
          (mapping.qbCustomerName ? [mapping.qbCustomerName] : []);

        for (const qbName of customerNames) {
          const customer = customers.find(
            (c) => c.fullName === qbName || c.name === qbName
          );
          if (customer) {
            results.push({
              customerId: customer.id,
              customerName: customer.name,
              customerFullName: customer.fullName,
              confidence: "high",
              matchType: "domain_mapping",
              matchedValue: domain,
            });
          } else {
            console.warn(
              `Domain mapping found for ${domain} -> "${qbName}" but QB customer not found`
            );
          }
        }

        // Return if we found any matches
        if (results.length > 0) {
          return results;
        }
      }
    }

    for (const customer of customers) {
      // 1. Exact email match (highest confidence)
      if (customer.email && customer.email.toLowerCase() === emailLower) {
        results.push({
          customerId: customer.id,
          customerName: customer.name,
          customerFullName: customer.fullName,
          confidence: "exact",
          matchType: "email",
          matchedValue: customer.email,
        });
        continue;
      }

      // 2. Name matching
      if (contactName) {
        // Check against customer name
        if (areVariationsOfSame(contactName, customer.name)) {
          results.push({
            customerId: customer.id,
            customerName: customer.name,
            customerFullName: customer.fullName,
            confidence: "high",
            matchType: "name",
            matchedValue: customer.name,
          });
          continue;
        }

        // Check against company name
        if (customer.companyName && areVariationsOfSame(contactName, customer.companyName)) {
          results.push({
            customerId: customer.id,
            customerName: customer.name,
            customerFullName: customer.fullName,
            confidence: "high",
            matchType: "company",
            matchedValue: customer.companyName,
          });
          continue;
        }

        // Fuzzy match with lower threshold
        // Require minimum name length to prevent short name matches like "Inc" or "Co"
        const nameSim = stringSimilarity(contactName, customer.name);
        const normalizedContactName = normalizeForComparison(contactName);
        const normalizedCustomerName = normalizeForComparison(customer.name);
        const hasMinNameLength = normalizedContactName.length >= 4 && normalizedCustomerName.length >= 4;

        if (nameSim >= 0.7) {
          // Skip short names unless very high similarity
          if (!hasMinNameLength && nameSim < 0.9) {
            continue;
          }
          results.push({
            customerId: customer.id,
            customerName: customer.name,
            customerFullName: customer.fullName,
            confidence: nameSim >= 0.85 ? "high" : "medium",
            matchType: "name",
            matchedValue: customer.name,
          });
          continue;
        }

        if (customer.companyName) {
          const companySim = stringSimilarity(contactName, customer.companyName);
          const normalizedCompanyName = normalizeForComparison(customer.companyName);
          const hasMinCompanyLength = normalizedContactName.length >= 4 && normalizedCompanyName.length >= 4;

          if (companySim >= 0.7) {
            // Skip short names unless very high similarity
            if (!hasMinCompanyLength && companySim < 0.9) {
              continue;
            }
            results.push({
              customerId: customer.id,
              customerName: customer.name,
              customerFullName: customer.fullName,
              confidence: companySim >= 0.85 ? "high" : "medium",
              matchType: "company",
              matchedValue: customer.companyName,
            });
            continue;
          }
        }
      }

      // 3. Match email domain to company name
      if (companyFromEmail && customer.companyName) {
        const domainSim = stringSimilarity(companyFromEmail, customer.companyName);
        if (domainSim >= 0.6) {
          results.push({
            customerId: customer.id,
            customerName: customer.name,
            customerFullName: customer.fullName,
            confidence: domainSim >= 0.8 ? "medium" : "low",
            matchType: "company",
            matchedValue: customer.companyName,
          });
          continue;
        }
      }

      if (companyFromEmail && customer.name) {
        const domainNameSim = stringSimilarity(companyFromEmail, customer.name);
        if (domainNameSim >= 0.6) {
          results.push({
            customerId: customer.id,
            customerName: customer.name,
            customerFullName: customer.fullName,
            confidence: domainNameSim >= 0.8 ? "medium" : "low",
            matchType: "name",
            matchedValue: customer.name,
          });
        }
      }
    }

    // Sort by confidence (exact > high > medium > low)
    const confidenceOrder = { exact: 0, high: 1, medium: 2, low: 3 };
    results.sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence]);

    return results;
  }

  async function match(
    contactEmail: string,
    contactName?: string
  ): Promise<MatchResult | null> {
    const results = await matchAll(contactEmail, contactName);
    return results.length > 0 ? results[0] : null;
  }

  async function refreshCache(): Promise<void> {
    cachedCustomers = await client.getCustomerListForMatching();
  }

  return { match, matchAll, refreshCache };
}

export default createCustomerMatcher;
