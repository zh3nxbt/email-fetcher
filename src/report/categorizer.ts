import { db, schema } from "@/db";
import { and, gte, lte, inArray, desc } from "drizzle-orm";
import type { Email, Category, ItemType, ReportThread } from "@/db/schema";
import { groupEmailsIntoThreads, normalizeSubject, fetchFullThreadEmails } from "@/sync/threader";
import type { CategorizedThread, TimeWindow, EmailForPrompt } from "./types";
import { categorizeThreadWithAI, categorizeThreadsBatch, type ThreadForBatch } from "./summarizer";
import { getTrustedDomains, isDomainTrusted } from "@/quickbooks/trusted-domains";
import { smartPoDetection } from "./po-detector";

// Batch configuration
const MAX_THREADS_PER_BATCH = 20;

const OUR_DOMAIN = process.env.IMAP_USER?.split("@")[1]?.toLowerCase() || "masprecisionparts.com";

// Fetch emails within a time window
export async function fetchEmailsInWindow(window: TimeWindow): Promise<Email[]> {
  const emails = await db
    .select()
    .from(schema.emails)
    .where(
      and(
        gte(schema.emails.date, window.start),
        lte(schema.emails.date, window.end)
      )
    );
  return emails;
}

// Count emails by direction
export function countEmailsByDirection(emails: Email[]): { received: number; sent: number } {
  let received = 0;
  let sent = 0;

  for (const email of emails) {
    if (isOutbound(email)) {
      sent++;
    } else {
      received++;
    }
  }

  return { received, sent };
}

// Check if an email is outbound (from us)
export function isOutbound(email: Email): boolean {
  const fromLower = email.fromAddress?.toLowerCase() || "";
  return (
    fromLower.includes(OUR_DOMAIN) ||
    email.mailbox === "Sent" ||
    email.mailbox === "Sent Items"
  );
}

// Get the external contact from a thread
export function getExternalContact(emails: Email[]): { email: string | null; name: string | null } {
  for (const email of emails) {
    // Check inbound emails first
    if (!isOutbound(email) && email.fromAddress) {
      const fromLower = email.fromAddress.toLowerCase();
      if (!fromLower.includes(OUR_DOMAIN)) {
        return {
          email: email.fromAddress,
          name: email.fromName || null,
        };
      }
    }
  }

  // Check outbound emails' recipients
  for (const email of emails) {
    if (isOutbound(email) && email.toAddresses) {
      try {
        const toList = JSON.parse(email.toAddresses) as string[];
        for (const to of toList) {
          const toLower = to.toLowerCase();
          if (!toLower.includes(OUR_DOMAIN)) {
            return { email: to, name: null };
          }
        }
      } catch {
        // If not JSON, try parsing as comma-separated
        const toList = email.toAddresses.split(",").map((s) => s.trim());
        for (const to of toList) {
          const toLower = to.toLowerCase();
          if (!toLower.includes(OUR_DOMAIN)) {
            return { email: to, name: null };
          }
        }
      }
    }
  }

  return { email: null, name: null };
}

// Determine initial category based on first email direction and content
// With full thread context, this is just a hint - the AI will make the final decision
export function determineInitialCategory(emails: Email[]): Category {
  if (emails.length === 0) return "other";

  // Sort by date to get first email (oldest)
  const sorted = [...emails].sort((a, b) => {
    const dateA = a.date?.getTime() || 0;
    const dateB = b.date?.getTime() || 0;
    return dateA - dateB;
  });

  const firstEmail = sorted[0];

  // Check for automated/newsletter emails
  if (isAutomatedEmail(firstEmail)) {
    return "other";
  }

  // Simple heuristic: first email direction suggests category
  // But the AI will have full context to make the final decision
  if (isOutbound(firstEmail)) {
    // We sent first - could be vendor (PO/RFQ) or customer (invoice/quote)
    // Default to "vendor" as a hint, AI will correct if it's an invoice/quote
    return "vendor";
  } else {
    // They sent first - typically a customer reaching out
    return "customer";
  }
}

// Check if an email is automated/newsletter
function isAutomatedEmail(email: Email): boolean {
  const subject = (email.subject || "").toLowerCase();
  const from = (email.fromAddress || "").toLowerCase();

  // Common patterns for automated emails
  const automatedPatterns = [
    /newsletter/i,
    /noreply/i,
    /no-reply/i,
    /donotreply/i,
    /automated/i,
    /notification/i,
    /alert@/i,
    /mailer-daemon/i,
    /postmaster/i,
  ];

  for (const pattern of automatedPatterns) {
    if (pattern.test(from) || pattern.test(subject)) {
      return true;
    }
  }

  return false;
}

// Check if the last email in thread is from us
export function isLastEmailFromUs(emails: Email[]): boolean {
  if (emails.length === 0) return false;

  // Sort by date descending to get last email
  const sorted = [...emails].sort((a, b) => {
    const dateA = a.date?.getTime() || 0;
    const dateB = b.date?.getTime() || 0;
    return dateB - dateA;
  });

  return isOutbound(sorted[0]);
}

// Get the last email date
export function getLastEmailDate(emails: Email[]): Date | null {
  if (emails.length === 0) return null;

  let latest: Date | null = null;
  for (const email of emails) {
    if (email.date && (!latest || email.date > latest)) {
      latest = email.date;
    }
  }
  return latest;
}

// Prepare emails for AI prompt
export function prepareEmailsForPrompt(emails: Email[]): EmailForPrompt[] {
  return emails.map((email) => ({
    from: email.fromName || email.fromAddress || "Unknown",
    to: email.toAddresses || "",
    date: email.date,
    subject: email.subject || "(no subject)",
    body: email.bodyText || "",
    isOutbound: isOutbound(email),
    hasAttachments: email.hasAttachments || false,
  }));
}

// Get cached categorizations from report_threads table
async function getCachedCategorizations(threadKeys: string[]): Promise<Map<string, ReportThread>> {
  if (threadKeys.length === 0) return new Map();

  // Get the most recent categorization for each threadKey
  const cached = await db
    .select()
    .from(schema.reportThreads)
    .where(inArray(schema.reportThreads.threadKey, threadKeys))
    .orderBy(desc(schema.reportThreads.id)); // Most recent first

  // Keep only the most recent entry per threadKey
  const result = new Map<string, ReportThread>();
  for (const row of cached) {
    if (!result.has(row.threadKey)) {
      result.set(row.threadKey, row);
    }
  }

  return result;
}

// Check if cached categorization is still valid (thread hasn't changed)
function isCacheValid(cached: ReportThread, currentLastEmailDate: Date | null): boolean {
  if (!cached.lastEmailDate || !currentLastEmailDate) return false;

  // Cache is valid if lastEmailDate matches (no new emails)
  return cached.lastEmailDate.getTime() === currentLastEmailDate.getTime();
}

// Categorize all threads in a time window
export async function categorizeThreads(
  window: TimeWindow,
  options: { reanalyze?: boolean } = {}
): Promise<CategorizedThread[]> {
  // Fetch emails in window
  const windowEmails = await fetchEmailsInWindow(window);
  console.log(`Found ${windowEmails.length} emails in window`);

  // Track which email IDs are in the window (for filtering display later)
  const windowEmailIds = new Set(windowEmails.map(e => e.id));

  // Expand to full thread history for better AI context
  // Pass window.end as cutoff to exclude future emails (important for historical reports)
  const allEmails = await fetchFullThreadEmails(windowEmails, window.end);

  // Group ALL emails into threads (gives AI full context)
  const threadMap = groupEmailsIntoThreads(allEmails);
  console.log(`Grouped into ${threadMap.size} threads (with full history)`);

  // Prepare thread data for batch processing
  interface ThreadData {
    threadKey: string;
    threadEmails: Email[];      // Full thread history (for AI context)
    windowEmails: Email[];      // Only emails in the time window (for display)
    initialCategory: Category;
    contact: { email: string | null; name: string | null };
    emailsForPrompt: EmailForPrompt[];
    lastEmailFromUs: boolean;
    lastEmailDate: Date | null;
    isNewThread: boolean;       // True if first email of thread is within the window
  }

  const threadsData: ThreadData[] = [];

  for (const [threadKey, threadEmails] of threadMap) {
    if (threadEmails.length === 0) continue;

    // Filter to only emails in the time window for display
    const windowEmailsInThread = threadEmails.filter(e => windowEmailIds.has(e.id));

    // Skip threads with no emails in the window (purely historical)
    if (windowEmailsInThread.length === 0) continue;

    // Use FULL thread for AI context (oldest first determines who initiated)
    const initialCategory = determineInitialCategory(threadEmails);
    const contact = getExternalContact(threadEmails);
    const emailsForPrompt = prepareEmailsForPrompt(threadEmails);
    const lastEmailFromUs = isLastEmailFromUs(threadEmails);
    const lastEmailDate = getLastEmailDate(threadEmails);

    // Check if thread is NEW (first email is within the window)
    const firstEmailDate = threadEmails[0]?.date;
    const isNewThread = firstEmailDate ? (firstEmailDate >= window.start && firstEmailDate <= window.end) : false;

    threadsData.push({
      threadKey,
      threadEmails,      // Full history for AI
      windowEmails: windowEmailsInThread,  // Window only for display
      initialCategory,
      contact,
      emailsForPrompt,
      lastEmailFromUs,
      lastEmailDate,
      isNewThread,
    });
  }

  // Check for cached categorizations (unless reanalyze is set)
  const cachedResults = new Map<string, { category: Category; itemType: ItemType; contactName: string | null; summary: string; needsResponse: boolean; relatedTo: string | null }>();
  let threadsToAnalyze = threadsData;

  if (!options.reanalyze) {
    const allThreadKeys = threadsData.map(t => t.threadKey);
    const cachedCategorizations = await getCachedCategorizations(allThreadKeys);

    const uncachedThreads: typeof threadsData = [];
    let cacheHits = 0;

    for (const data of threadsData) {
      const cached = cachedCategorizations.get(data.threadKey);

      if (cached && isCacheValid(cached, data.lastEmailDate)) {
        // Use cached result
        cachedResults.set(data.threadKey, {
          category: cached.category,
          itemType: cached.itemType,
          contactName: cached.contactName,
          summary: cached.summary || "",
          needsResponse: !data.lastEmailFromUs, // Recalculate based on current state
          relatedTo: null, // Can't preserve relatedTo from cache
        });
        cacheHits++;
      } else {
        // Need to analyze
        uncachedThreads.push(data);
      }
    }

    if (cacheHits > 0) {
      console.log(`  Using cached categorizations for ${cacheHits} threads`);
    }

    threadsToAnalyze = uncachedThreads;
  }

  // Attempt batch categorization for uncached threads
  let aiResults = new Map<string, { category: Category; itemType: ItemType; contactName: string | null; summary: string; needsResponse: boolean; relatedTo: string | null }>();

  if (threadsToAnalyze.length > 0) {
    console.log(`  Analyzing ${threadsToAnalyze.length} threads with AI...`);
    aiResults = await categorizeThreadsWithBatch(threadsToAnalyze);
  }

  // Merge cached and AI results
  const allResults = new Map([...cachedResults, ...aiResults]);

  // Build a map of threadKey to data for merging
  const dataByKey = new Map<string, typeof threadsData[0]>();
  for (const data of threadsData) {
    dataByKey.set(data.threadKey, data);
  }

  // Merge related threads based on AI suggestions
  const mergedInto = new Map<string, string>(); // threadKey -> merged into threadKey

  for (const [threadKey, result] of allResults) {
    if (result.relatedTo && dataByKey.has(result.relatedTo)) {
      // This thread should be merged into the related thread
      mergedInto.set(threadKey, result.relatedTo);
      console.log(`  Merging "${threadKey.slice(0, 30)}..." into related thread`);
    }
  }

  // Build final categorized threads (skipping merged ones)
  const categorizedThreads: CategorizedThread[] = [];

  for (const data of threadsData) {
    // Skip threads that were merged into another
    if (mergedInto.has(data.threadKey)) {
      continue;
    }

    // First email in full thread history (oldest) - used for category decisions
    const firstEmail = data.threadEmails[0];
    const aiResult = allResults.get(data.threadKey);

    // Collect all FULL HISTORY emails including from merged threads (for AI decisions)
    let allEmails = [...data.threadEmails];
    // Collect all WINDOW emails including from merged threads (for display)
    let displayEmails = [...data.windowEmails];
    let mergedCount = 0;

    for (const [mergedKey, targetKey] of mergedInto) {
      if (targetKey === data.threadKey) {
        const mergedData = dataByKey.get(mergedKey);
        if (mergedData) {
          allEmails.push(...mergedData.threadEmails);
          displayEmails.push(...mergedData.windowEmails);
          mergedCount++;
        }
      }
    }

    // Sort all emails by date
    allEmails.sort((a, b) => {
      const dateA = a.date?.getTime() || 0;
      const dateB = b.date?.getTime() || 0;
      return dateA - dateB;
    });
    displayEmails.sort((a, b) => {
      const dateA = a.date?.getTime() || 0;
      const dateB = b.date?.getTime() || 0;
      return dateA - dateB;
    });

    // Recalculate last email info based on FULL thread (not just window)
    const lastEmail = allEmails[allEmails.length - 1];
    const lastEmailFromUs = isOutbound(lastEmail);
    const lastEmailDate = lastEmail?.date || null;

    // Update summary if threads were merged
    let summary = aiResult?.summary ?? null;
    if (mergedCount > 0 && summary) {
      // The AI should have seen both threads, so summary should be comprehensive
      // But let's check if we need to update needsResponse based on merged thread
      const mergedResults = Array.from(mergedInto.entries())
        .filter(([_, target]) => target === data.threadKey)
        .map(([key, _]) => allResults.get(key))
        .filter(Boolean);

      // If any merged thread has a more recent interaction, use that info
      for (const mergedResult of mergedResults) {
        if (mergedResult && mergedResult.summary) {
          summary = `${summary} ${mergedResult.summary}`;
        }
      }
    }

    // Use AI results
    let itemType = aiResult?.itemType ?? "general";
    let category = aiResult?.category ?? data.initialCategory;

    // Definitional constraints only - these are logical, not heuristic
    // If someone sent us a PO, they're a customer by definition
    if (itemType === "po_received" && category !== "customer") {
      console.warn(`Category fix: po_received must be customer, not ${category} ("${firstEmail.subject}")`);
      category = "customer";
    }
    // If we sent a PO to them, they're a vendor by definition
    if (itemType === "po_sent" && category !== "vendor") {
      console.warn(`Category fix: po_sent must be vendor, not ${category} ("${firstEmail.subject}")`);
      category = "vendor";
    }
    // NOTE: We intentionally do NOT force quote_request → vendor.
    // The AI now correctly distinguishes:
    // - Customer asking US for quote → customer + quote_request
    // - WE asking vendor for quote → vendor + general (not quote_request)

    // Determine if response is needed:
    // - Not needed if last email is from us (we already replied)
    // - Otherwise trust AI's assessment (it has full thread context)
    //
    // NOTE: We intentionally do NOT override needsResponse for POs/RFQs.
    // The AI can detect when customer's last email is just "thanks" or acknowledgment.
    // Forcing needsResponse=true would create false action items.
    const needsResponse = !lastEmailFromUs && (aiResult?.needsResponse ?? true);

    categorizedThreads.push({
      threadKey: data.threadKey,
      emails: displayEmails,  // Only window emails for display
      category,
      itemType,
      contactEmail: data.contact.email,
      contactName: aiResult?.contactName ?? data.contact.name,
      subject: firstEmail.subject || "(no subject)",
      summary,
      emailCount: displayEmails.length,  // Count of window emails
      lastEmailDate,
      lastEmailFromUs,
      needsResponse,
      isNewThread: data.isNewThread,
      poDetails: null,
      isSuspicious: false, // Will be set for po_received threads below
    });
  }

  // Enrich po_received threads with trusted domain check and PO details
  await enrichPoReceivedThreads(categorizedThreads);

  return categorizedThreads;
}

/**
 * Enrich po_received threads with:
 * 1. Trusted domain check (sets isSuspicious flag)
 * 2. Smart PO detection from attachments (if domain is trusted)
 */
async function enrichPoReceivedThreads(threads: CategorizedThread[]): Promise<void> {
  const poReceivedThreads = threads.filter(t => t.itemType === "po_received");

  if (poReceivedThreads.length === 0) {
    return;
  }

  console.log(`\nEnriching ${poReceivedThreads.length} po_received threads...`);

  // Load trusted domains once
  const trustedDomains = await getTrustedDomains();

  for (const thread of poReceivedThreads) {
    // Check trusted domain
    if (!thread.contactEmail) {
      thread.isSuspicious = true;
      console.log(`  Suspicious (no email): "${thread.subject?.slice(0, 40)}..."`);
      continue;
    }

    if (!isDomainTrusted(thread.contactEmail, trustedDomains)) {
      thread.isSuspicious = true;
      console.log(`  Suspicious (untrusted domain): ${thread.contactEmail}`);
      continue;
    }

    // Domain is trusted - use smart PO detection
    // Find the specific email that likely contains the PO
    // (first inbound email with attachments in the thread)
    const poEmail = thread.emails.find((e) => {
      // Must be inbound (not from us)
      const fromLower = e.fromAddress?.toLowerCase() || "";
      const isInbound = !fromLower.includes(OUR_DOMAIN) &&
                        e.mailbox !== "Sent" &&
                        e.mailbox !== "Sent Items";

      if (!isInbound) return false;

      // Must have document attachments
      if (!e.hasAttachments || !e.attachments) return false;
      const lower = e.attachments.toLowerCase();
      return lower.includes("pdf") || lower.includes(".doc");
    });

    if (!poEmail) {
      console.log(`  No inbound email with attachments found for: "${thread.subject?.slice(0, 40)}..."`);
      continue;
    }

    try {
      const result = await smartPoDetection(poEmail, thread.threadKey, thread.subject);

      if (result.success && result.primaryPo) {
        thread.poDetails = result.primaryPo;
        const poCount = result.poDetailsList.length;
        if (poCount > 1) {
          console.log(`  Extracted ${poCount} POs: ${result.poDetailsList.map(p => p.poNumber || "?").join(", ")}`);
        } else {
          console.log(`  Extracted PO: ${result.primaryPo.poNumber || "(no number)"} $${result.primaryPo.total || "?"}`);
        }
      } else if (!result.success) {
        // No valid PO found - thread may need review
        // The failure is already logged by smartPoDetection
        console.log(`  No valid PO found in ${result.attemptedFiles.length} file(s) for: "${thread.subject?.slice(0, 40)}..."`);
        // Keep itemType as po_received but poDetails will be null
        // Templates will show warning based on this
      }
    } catch (error) {
      console.warn(`  Smart PO detection failed for "${thread.subject?.slice(0, 40)}...":`, error);
    }
  }
}

// Batch categorization with fallback to individual calls
async function categorizeThreadsWithBatch(
  threadsData: Array<{
    threadKey: string;
    initialCategory: Category;
    emailsForPrompt: EmailForPrompt[];
  }>
): Promise<Map<string, { category: Category; itemType: ItemType; contactName: string | null; summary: string; needsResponse: boolean; relatedTo: string | null }>> {
  const results = new Map<string, { category: Category; itemType: ItemType; contactName: string | null; summary: string; needsResponse: boolean; relatedTo: string | null }>();

  if (threadsData.length === 0) {
    return results;
  }

  // Split into batches
  const batches: typeof threadsData[] = [];
  for (let i = 0; i < threadsData.length; i += MAX_THREADS_PER_BATCH) {
    batches.push(threadsData.slice(i, i + MAX_THREADS_PER_BATCH));
  }

  console.log(`Categorizing ${threadsData.length} threads in ${batches.length} batch(es)`);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchThreads: ThreadForBatch[] = batch.map((data) => ({
      threadKey: data.threadKey,
      initialCategory: data.initialCategory,
      emails: data.emailsForPrompt,
    }));

    try {
      console.log(`Processing batch ${batchIdx + 1}/${batches.length} (${batch.length} threads)`);
      const batchResults = await categorizeThreadsBatch(batchThreads);

      // Store results
      for (const [threadKey, result] of Object.entries(batchResults)) {
        results.set(threadKey, result);
      }
    } catch (error) {
      console.warn(`Batch ${batchIdx + 1} failed, falling back to individual calls:`, error);

      // Fallback: categorize individually
      for (const data of batch) {
        try {
          const aiResult = await categorizeThreadWithAI(data.emailsForPrompt, data.initialCategory);
          results.set(data.threadKey, aiResult);
        } catch (individualError) {
          console.error(`Individual categorization failed for ${data.threadKey}:`, individualError);
          // Use defaults - will be handled in caller
        }
      }
    }
  }

  return results;
}

// Get email counts for a time window
export async function getEmailCounts(window: TimeWindow): Promise<{ received: number; sent: number }> {
  const emails = await fetchEmailsInWindow(window);
  return countEmailsByDirection(emails);
}
