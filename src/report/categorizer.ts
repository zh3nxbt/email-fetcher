import { db, schema } from "@/db";
import { and, gte, lte } from "drizzle-orm";
import type { Email, Category, ItemType } from "@/db/schema";
import { groupEmailsIntoThreads, normalizeSubject } from "@/sync/threader";
import type { CategorizedThread, TimeWindow, EmailForPrompt } from "./types";
import { categorizeThreadWithAI, categorizeThreadsBatch, type ThreadForBatch } from "./summarizer";

// Batch configuration
const MAX_THREADS_PER_BATCH = 20;

const OUR_DOMAIN = process.env.IMAP_USER?.split("@")[1]?.toLowerCase() || "masprecisionparts.com";

// Check if email has real attachments (PDFs, documents) vs just signature images
function hasRealAttachments(email: Email): boolean {
  if (!email.attachments) return false;

  try {
    const attachments = JSON.parse(email.attachments) as Array<{
      filename?: string;
      contentType?: string;
      size?: number;
    }>;

    // Real attachments are PDFs, Office docs, etc. - not images typically used in signatures
    const signatureImagePatterns = [
      /^image\/(png|jpeg|jpg|gif)$/i,
      /logo/i,
      /signature/i,
      /image\d+\.(png|jpg|jpeg|gif)$/i,
    ];

    for (const att of attachments) {
      const filename = att.filename?.toLowerCase() || "";
      const contentType = att.contentType?.toLowerCase() || "";

      // Skip small images (likely signature images, typically < 100KB)
      if (contentType.startsWith("image/") && (att.size || 0) < 100000) {
        continue;
      }

      // Skip files that look like signature images
      if (signatureImagePatterns.some(p => p.test(filename) || p.test(contentType))) {
        if ((att.size || 0) < 100000) continue;
      }

      // This looks like a real attachment (PDF, doc, large file, etc.)
      if (
        contentType.includes("pdf") ||
        contentType.includes("document") ||
        contentType.includes("spreadsheet") ||
        contentType.includes("msword") ||
        contentType.includes("excel") ||
        contentType.includes("application/") ||
        filename.endsWith(".pdf") ||
        filename.endsWith(".doc") ||
        filename.endsWith(".docx") ||
        filename.endsWith(".xls") ||
        filename.endsWith(".xlsx") ||
        (att.size || 0) > 100000 // Large files are likely real attachments
      ) {
        return true;
      }
    }

    return false;
  } catch {
    // If we can't parse, assume no real attachments
    return false;
  }
}

// Detect simple acknowledgment emails that don't need a response
function isSimpleAcknowledgment(bodyText: string | null): boolean {
  if (!bodyText) return false;

  // Get first 200 chars, lowercase, and strip whitespace/signatures
  const firstPart = bodyText.slice(0, 200).toLowerCase().trim();

  // Extract text before common signature markers
  const beforeSignature = firstPart.split(/\n\s*[-_]{2,}|\n\s*sent from|\n\s*get outlook|\n\s*\[/)[0].trim();

  // Very short messages that are ONLY acknowledgments (strict patterns)
  // These must match the ENTIRE message before signature
  const strictAckPatterns = [
    /^(great )?thanks?!?\.?$/,
    /^thank you!?\.?$/,
    /^thanks!? ?so much!?\.?$/,
    /^got it!?\.?$/,
    /^sounds good!?\.?$/,
    /^perfect!?\.?$/,
    /^received!?\.?$/,
    /^ok!?\.?$/,
    /^okay!?\.?$/,
    /^will do!?\.?$/,
    /^noted!?\.?$/,
    /^acknowledged!?\.?$/,
    /^awesome!?\.?$/,
    /^great!?\.?$/,
  ];

  for (const pattern of strictAckPatterns) {
    if (pattern.test(beforeSignature)) {
      return true;
    }
  }

  // Also check for acknowledgment followed only by name/closing
  // e.g., "Great thanks!\n\nPreet" or "Thanks!\nBest,\nJohn"
  const ackWithClosingPattern = /^(great )?thanks?!?\.?\s*([\n\r]+\s*[a-z]+)?$/;
  if (ackWithClosingPattern.test(beforeSignature) && beforeSignature.length < 40) {
    return true;
  }

  // IMPORTANT: Do NOT match phrases like "Thank you and kind regards" or
  // "Thank you, please find attached" - these are polite openings, not acknowledgments
  // The patterns above are strict and require the message to be ONLY the acknowledgment

  return false;
}

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
export function determineInitialCategory(emails: Email[]): Category {
  if (emails.length === 0) return "other";

  // Sort by date to get first email
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

  const subject = (firstEmail.subject || "").toLowerCase();

  // If we SENT the first email, check what kind it is:
  if (isOutbound(firstEmail)) {
    // Invoices, quotations, quotes, estimates sent BY US = Customer interaction
    // (We're billing them or providing a quote they requested)
    if (
      subject.includes("invoice") ||
      subject.includes("quotation") ||
      subject.includes("quote") ||
      subject.includes("estimate") ||
      subject.includes("est_") ||
      subject.includes("inv_")
    ) {
      return "customer";
    }
    // PO, RFQ, or general inquiry sent BY US = Vendor interaction (we're buying)
    return "vendor";
  } else {
    // They sent first = Customer interaction (they're reaching out to us)
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

// Categorize all threads in a time window
export async function categorizeThreads(window: TimeWindow): Promise<CategorizedThread[]> {
  // Fetch emails in window
  const emails = await fetchEmailsInWindow(window);
  console.log(`Found ${emails.length} emails in window`);

  // Group into threads
  const threadMap = groupEmailsIntoThreads(emails);
  console.log(`Grouped into ${threadMap.size} threads`);

  // Prepare thread data for batch processing
  interface ThreadData {
    threadKey: string;
    threadEmails: Email[];
    initialCategory: Category;
    contact: { email: string | null; name: string | null };
    emailsForPrompt: EmailForPrompt[];
    lastEmailFromUs: boolean;
    lastEmailDate: Date | null;
  }

  const threadsData: ThreadData[] = [];

  for (const [threadKey, threadEmails] of threadMap) {
    if (threadEmails.length === 0) continue;

    const initialCategory = determineInitialCategory(threadEmails);
    const contact = getExternalContact(threadEmails);
    const emailsForPrompt = prepareEmailsForPrompt(threadEmails);
    const lastEmailFromUs = isLastEmailFromUs(threadEmails);
    const lastEmailDate = getLastEmailDate(threadEmails);

    threadsData.push({
      threadKey,
      threadEmails,
      initialCategory,
      contact,
      emailsForPrompt,
      lastEmailFromUs,
      lastEmailDate,
    });
  }

  // Attempt batch categorization
  const aiResults = await categorizeThreadsWithBatch(threadsData);

  // Build a map of threadKey to data for merging
  const dataByKey = new Map<string, typeof threadsData[0]>();
  for (const data of threadsData) {
    dataByKey.set(data.threadKey, data);
  }

  // Merge related threads based on AI suggestions
  const mergedInto = new Map<string, string>(); // threadKey -> merged into threadKey

  for (const [threadKey, result] of aiResults) {
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

    const firstEmail = data.threadEmails[0];
    const aiResult = aiResults.get(data.threadKey);

    // Collect all emails including from merged threads
    let allEmails = [...data.threadEmails];
    let mergedCount = 0;

    for (const [mergedKey, targetKey] of mergedInto) {
      if (targetKey === data.threadKey) {
        const mergedData = dataByKey.get(mergedKey);
        if (mergedData) {
          allEmails.push(...mergedData.threadEmails);
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

    // Recalculate last email info after merge
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
        .map(([key, _]) => aiResults.get(key))
        .filter(Boolean);

      // If any merged thread has a more recent interaction, use that info
      for (const mergedResult of mergedResults) {
        if (mergedResult && mergedResult.summary) {
          summary = `${summary} ${mergedResult.summary}`;
        }
      }
    }

    // Determine if response is needed:
    // - Not needed if last email is from us
    // - Not needed if last email is a simple acknowledgment (thanks, got it, etc.)
    // - Check for acknowledgment FIRST (signature images count as "attachments" but aren't real)
    // - If NOT an acknowledgment and has real attachments (PDF, etc.), needs response
    // - Otherwise use AI's assessment, defaulting to true
    let needsResponse = true;
    if (lastEmailFromUs) {
      needsResponse = false;
    } else if (isSimpleAcknowledgment(lastEmail?.bodyText)) {
      // Simple acknowledgments don't need response, even if they have signature images
      needsResponse = false;
    } else if (lastEmail?.hasAttachments && hasRealAttachments(lastEmail)) {
      // Emails with REAL attachments (PDF, documents) need a response
      needsResponse = true;
    } else {
      needsResponse = aiResult?.needsResponse ?? true;
    }

    // Determine item type - use AI result but override if subject clearly indicates PO
    let itemType = aiResult?.itemType ?? "general";
    const subjectLower = (firstEmail.subject || "").toLowerCase();
    const category = aiResult?.category ?? data.initialCategory;

    // If it's a customer thread and subject clearly indicates a PO, mark as po_received
    if (category === "customer" && itemType === "general") {
      if (
        subjectLower.includes("po number") ||
        subjectLower.includes("po attached") ||
        subjectLower.includes("po#") ||
        subjectLower.includes("purchase order") ||
        /\bpo\s*\d+/i.test(subjectLower) ||  // "PO 12345" or "PO12345"
        /\bpo\d{5,}/i.test(subjectLower)     // "PO00221" style
      ) {
        itemType = "po_received";
      }
    }

    categorizedThreads.push({
      threadKey: data.threadKey,
      emails: allEmails,
      category,
      itemType,
      contactEmail: data.contact.email,
      contactName: aiResult?.contactName ?? data.contact.name,
      subject: firstEmail.subject || "(no subject)",
      summary,
      emailCount: allEmails.length,
      lastEmailDate,
      lastEmailFromUs,
      needsResponse,
      poDetails: null,
    });
  }

  return categorizedThreads;
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
