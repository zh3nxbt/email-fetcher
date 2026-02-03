/**
 * Trusted Domain Filter for QuickBooks Job Sync
 *
 * Prevents processing emails/PDFs from suspicious domains by:
 * 1. Automatically trusting domains we've emailed (from sent folder)
 * 2. Supporting a manual whitelist via TRUSTED_DOMAINS env var
 * 3. Trusting domains from QB customer emails (via cached customer list)
 *
 * This protects against:
 * - Analyzing infected PDF attachments from phishing emails
 * - Wasting API calls matching phishing emails to QB customers
 */

import { db } from "../db/index.js";
import { emails } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { getCachedCustomers } from "./customer-cache.js";
import { ConductorClient } from "./conductor-client.js";

/**
 * Extract domain from an email address
 * Returns lowercase domain or null if invalid
 */
export function extractDomain(email: string): string | null {
  const match = email.match(/@([^@\s]+)$/);
  if (!match) return null;
  return match[1].toLowerCase();
}

/**
 * Parse recipient addresses from email toAddresses field
 * The field stores a JSON array of addresses
 */
function parseRecipients(toAddresses: string | null): string[] {
  if (!toAddresses) return [];
  try {
    const parsed = JSON.parse(toAddresses);
    if (Array.isArray(parsed)) {
      return parsed.filter((addr): addr is string => typeof addr === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Generic/webmail domains that should not be trusted just because we emailed them
 * These could be personal accounts or shared mailboxes that don't represent trusted companies
 */
const GENERIC_DOMAINS = new Set([
  // Major webmail providers
  "gmail.com", "yahoo.com", "yahoo.ca", "hotmail.com", "outlook.com",
  "aol.com", "icloud.com", "protonmail.com", "mail.com",
  "live.com", "msn.com", "yandex.com", "zoho.com",
  // Regional variants
  "gmail.ca", "yahoo.co.uk", "hotmail.co.uk", "outlook.ca",
  // Other common free email
  "gmx.com", "gmx.net", "fastmail.com", "tutanota.com",
]);

/**
 * Get domains from sent email recipients in the database
 * These are domains we've actively communicated with
 *
 * Filters out generic webmail domains to prevent trusting personal accounts
 */
async function getSentEmailDomains(): Promise<Set<string>> {
  const domains = new Set<string>();

  // Query sent emails and extract recipient domains
  const sentEmails = await db
    .select({ toAddresses: emails.toAddresses })
    .from(emails)
    .where(sql`${emails.mailbox} IN ('Sent', 'INBOX.Sent', 'INBOX.Sent Messages', 'Sent Messages')`);

  for (const email of sentEmails) {
    const recipients = parseRecipients(email.toAddresses);
    for (const recipient of recipients) {
      const domain = extractDomain(recipient);
      if (domain && !GENERIC_DOMAINS.has(domain)) {
        domains.add(domain);
      }
    }
  }

  return domains;
}

/**
 * Get manually whitelisted domains from TRUSTED_DOMAINS env var
 * Format: comma-separated list of domains
 * Example: TRUSTED_DOMAINS=newvendor.com,legitcustomer.ca
 */
function getManualWhitelist(): Set<string> {
  const domains = new Set<string>();
  const envValue = process.env.TRUSTED_DOMAINS;

  if (!envValue) return domains;

  const parts = envValue.split(",");
  for (const part of parts) {
    const domain = part.trim().toLowerCase();
    if (domain) {
      domains.add(domain);
    }
  }

  return domains;
}

/**
 * Get domains from QuickBooks customer email addresses
 * Uses the cached customer list (24h TTL)
 */
async function getQbCustomerDomains(): Promise<Set<string>> {
  const domains = new Set<string>();

  if (!process.env.CONDUCTOR_API_KEY || !process.env.CONDUCTOR_END_USER_ID) {
    return domains;
  }

  try {
    const client = new ConductorClient();
    const customers = await getCachedCustomers(client);

    for (const customer of customers) {
      if (customer.email) {
        const domain = extractDomain(customer.email);
        if (domain) {
          domains.add(domain);
        }
      }
    }
  } catch (error) {
    // QB customer domains are optional - don't fail if unavailable
    console.warn("Could not load QB customer domains:", error);
  }

  return domains;
}

interface TrustedDomainsResult {
  domains: Set<string>;
  sentDomains: Set<string>;
  manualDomains: Set<string>;
  qbDomains: Set<string>;
}

/**
 * Load trusted domains from all sources
 * Single implementation shared by getTrustedDomains and getTrustedDomainsStats
 */
async function loadTrustedDomains(): Promise<TrustedDomainsResult> {
  const [sentDomains, manualDomains, qbDomains] = await Promise.all([
    getSentEmailDomains(),
    Promise.resolve(getManualWhitelist()),
    getQbCustomerDomains(),
  ]);

  // Combine all sets
  const domains = new Set<string>(sentDomains);
  for (const domain of manualDomains) {
    domains.add(domain);
  }
  for (const domain of qbDomains) {
    domains.add(domain);
  }

  return { domains, sentDomains, manualDomains, qbDomains };
}

/**
 * Build the complete set of trusted domains
 * Combines:
 * 1. Domains from sent email recipients (automatic trust)
 * 2. Manual whitelist from TRUSTED_DOMAINS env var
 * 3. Domains from QB customer emails (via cached list)
 */
export async function getTrustedDomains(): Promise<Set<string>> {
  return (await loadTrustedDomains()).domains;
}

/**
 * Check if an email address belongs to a trusted domain
 */
export function isDomainTrusted(email: string, trustedDomains: Set<string>): boolean {
  const domain = extractDomain(email);
  if (!domain) return false;
  return trustedDomains.has(domain);
}

/**
 * Filter a list of email addresses to only trusted ones
 */
export function filterTrustedEmails(
  emailAddresses: string[],
  trustedDomains: Set<string>
): string[] {
  return emailAddresses.filter((email) => isDomainTrusted(email, trustedDomains));
}

/**
 * Get statistics about trusted domains for debugging/logging
 */
export async function getTrustedDomainsStats(): Promise<{
  totalTrusted: number;
  fromSentEmails: number;
  fromManualWhitelist: number;
  fromQbCustomers: number;
  domains: string[];
}> {
  const { domains, sentDomains, manualDomains, qbDomains } = await loadTrustedDomains();

  return {
    totalTrusted: domains.size,
    fromSentEmails: sentDomains.size,
    fromManualWhitelist: manualDomains.size,
    fromQbCustomers: qbDomains.size,
    domains: Array.from(domains).sort(),
  };
}
