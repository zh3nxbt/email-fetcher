import Anthropic from "@anthropic-ai/sdk";
import type { Category, ItemType } from "@/db/schema";
import type { EmailForPrompt, CategorizationResult, PoExtractionResult, PoLineItem } from "./types";

const anthropic = new Anthropic();

// Model - Sonnet only for reliable classification
const MODEL_SONNET = "claude-sonnet-4-20250514";

// Truncation limits
const BODY_LIMIT_SINGLE = 1500;
const BODY_LIMIT_BATCH = 800;  // Increased from 300 for better context
const MAX_EMAILS_PER_THREAD = 6;  // Keep first 2 + last 3, or all if <= 6

function formatEmailForPrompt(email: EmailForPrompt, bodyLimit: number = BODY_LIMIT_SINGLE): string {
  const direction = email.isOutbound ? "[SENT]" : "[RECEIVED]";
  const date = email.date ? email.date.toISOString().split("T")[0] : "unknown";
  const attachments = email.hasAttachments ? " [HAS ATTACHMENTS]" : "";
  return `${direction} ${date}${attachments}
From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
---
${email.body.slice(0, bodyLimit)}${email.body.length > bodyLimit ? "..." : ""}
`;
}

// Truncate long threads to keep first 2 + last 3 emails
// This preserves: who initiated (first emails) and current state (last emails)
function truncateThreadEmails(emails: EmailForPrompt[]): EmailForPrompt[] {
  if (emails.length <= MAX_EMAILS_PER_THREAD) {
    return emails;
  }

  // Sort by date (should already be sorted, but ensure it)
  const sorted = [...emails].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateA - dateB;
  });

  // Keep first 2 and last 3
  const first = sorted.slice(0, 2);
  const last = sorted.slice(-3);
  const omittedCount = sorted.length - 5;

  // Create a placeholder email to indicate omission
  const placeholder: EmailForPrompt = {
    from: "---",
    to: "---",
    date: null,
    subject: `[... ${omittedCount} emails omitted for brevity ...]`,
    body: "",
    isOutbound: false,
    hasAttachments: false,
  };

  return [...first, placeholder, ...last];
}

// Input for batch categorization
export interface ThreadForBatch {
  threadKey: string;
  initialCategory: Category;
  emails: EmailForPrompt[];
}

// Batch categorization result keyed by threadKey
export interface BatchCategorizationResult {
  [threadKey: string]: CategorizationResult;
}

// Internal function to categorize a batch with a specific model
async function categorizeWithModel(
  threads: ThreadForBatch[],
  model: string
): Promise<BatchCategorizationResult> {
  if (threads.length === 0) {
    return {};
  }

  // Format threads as JSON for the prompt - use indices instead of threadKeys
  const threadsJson = threads.map((thread, index) => {
    const sorted = [...thread.emails].sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return dateA - dateB;
    });

    const truncated = truncateThreadEmails(sorted);

    return {
      index,
      initialCategory: thread.initialCategory,
      emailCount: sorted.length,
      emails: truncated.map((email) => ({
        direction: email.isOutbound ? "SENT" : "RECEIVED",
        date: email.date ? email.date.toISOString().split("T")[0] : "unknown",
        from: email.from,
        to: email.to,
        subject: email.subject,
        body: email.body.slice(0, BODY_LIMIT_BATCH) + (email.body.length > BODY_LIMIT_BATCH ? "..." : ""),
        hasAttachments: email.hasAttachments,
      })),
    };
  });

  const prompt = `You are classifying email threads for MAS Precision Parts, a precision manufacturing company.

ABOUT US:
- We are MAS Precision Parts (sales@masprecisionparts.com)
- We manufacture precision parts for CUSTOMERS (they buy from us)
- We purchase materials/equipment from VENDORS (we buy from them)
- SENT emails are from us, RECEIVED emails are from external parties

CRITICAL RULES - APPLY THESE FIRST:
1. If WE send an Invoice → ALWAYS "customer" (we bill customers, never vendors)
2. If WE send a Quotation/Quote/Estimate → ALWAYS "customer" (we quote customers, never vendors)
3. If subject contains "RFQ" or "Request for Quotation" and THEY ask US for pricing → "customer" + "quote_request"
4. If WE send a PO to them → ALWAYS "vendor" (we buy from vendors)

CLASSIFICATION:
1. CATEGORY - Who is the external party?
   - "customer": Someone we sell to or provide quotes to
     * They send us a PO or RFQ (buying from us)
     * We send them an invoice, quotation, or estimate (billing/quoting them)
     * They ask US for pricing or quotes
   - "vendor": Someone we buy from
     * We send them a PO or RFQ (we're purchasing)
     * They send us quotes/pricing IN RESPONSE to our RFQ (we're the buyer)
     * Equipment/material suppliers reaching out to sell to us
   - "other": Automated emails, newsletters, spam, internal

2. ITEM_TYPE - What kind of interaction?
   - "po_received": Customer sent us a purchase order
   - "po_sent": We sent a PO to vendor
   - "quote_request": Customer asking US for a quote/pricing (NOT when we ask vendors)
   - "general": General correspondence
   - "other": Automated/newsletters

3. NEEDS_RESPONSE - Does the LAST email need our reply?
   Set FALSE for:
   - Acknowledgments ("Thanks!", "Got it!", "Received!")
   - FYI notices, policy statements, announcements
   - Emails with "notice" in subject (price notices, policy notices, etc.)
   - Informational emails that don't ask a question or request action
   Set TRUE for: questions, requests, substantive content requiring action
   IMPORTANT: "Notice" emails should be FALSE unless they explicitly ask for a reply

4. CONTACT_NAME - External party's name/company

5. SUMMARY - 1-2 sentence summary of thread status

6. RELATED_TO - Index of related thread if this is a response (e.g., vendor quote responding to our RFQ)

THREADS TO CLASSIFY:
${JSON.stringify(threadsJson, null, 2)}

Return JSON only: {"results": [{"index": 0, "category": "...", "item_type": "...", "contact_name": "...", "summary": "...", "needs_response": true/false, "related_to": null}, ...]}`;

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4000,
      system: "You are a JSON-only classifier. Always respond with valid JSON, no explanations. Process ALL threads provided.",
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" }
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    const parsed = JSON.parse("{" + content.text) as {
      results: Array<{
        index: number;
        category: string;
        item_type: string;
        contact_name: string | null;
        summary: string;
        needs_response: boolean;
        related_to: number | null;
      }>;
    };

    const validCategories: Category[] = ["customer", "vendor", "other"];
    const validItemTypes: ItemType[] = ["po_sent", "po_received", "quote_request", "general", "other"];

    const resultMap: BatchCategorizationResult = {};
    const resultsByIndex = new Map<number, typeof parsed.results[0]>();
    for (const result of parsed.results) {
      resultsByIndex.set(result.index, result);
    }

    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      const result = resultsByIndex.get(i);

      if (result) {
        const category = validCategories.includes(result.category as Category)
          ? (result.category as Category)
          : thread.initialCategory;

        const itemType = validItemTypes.includes(result.item_type as ItemType)
          ? (result.item_type as ItemType)
          : "general";

        let relatedTo: string | null = null;
        if (result.related_to !== null && result.related_to >= 0 && result.related_to < threads.length) {
          relatedTo = threads[result.related_to].threadKey;
        }

        resultMap[thread.threadKey] = {
          category,
          itemType,
          contactName: result.contact_name,
          summary: result.summary,
          needsResponse: result.needs_response !== false,
          relatedTo,
        };
      } else {
        console.warn(`Batch response missing thread index ${i} (${thread.threadKey.slice(0, 40)}...), using defaults`);
        resultMap[thread.threadKey] = {
          category: thread.initialCategory,
          itemType: "general",
          contactName: null,
          summary: "Classification incomplete - needs review",
          needsResponse: true,
          relatedTo: null,
        };
      }
    }

    return resultMap;
  } catch (error) {
    console.error(`Batch categorization error (${model}):`, error);
    throw error;
  }
}

// Categorize multiple threads in a single API call using Sonnet
export async function categorizeThreadsBatch(
  threads: ThreadForBatch[]
): Promise<BatchCategorizationResult> {
  if (threads.length === 0) {
    return {};
  }

  console.log(`  Using Sonnet for all ${threads.length} threads`);

  try {
    return await categorizeWithModel(threads, MODEL_SONNET);
  } catch (error) {
    console.error("Batch categorization failed:", error);
    // Return defaults for all threads
    const results: BatchCategorizationResult = {};
    for (const thread of threads) {
      results[thread.threadKey] = {
        category: thread.initialCategory,
        itemType: "general",
        contactName: null,
        summary: "Classification failed - needs review",
        needsResponse: true,
        relatedTo: null,
      };
    }
    return results;
  }
}

// Categorize a thread using AI (individual fallback - uses Sonnet for reliability)
export async function categorizeThreadWithAI(
  emails: EmailForPrompt[],
  initialCategory: Category
): Promise<CategorizationResult> {
  // Sort emails by date (oldest first)
  const sorted = [...emails].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateA - dateB;
  });

  const threadFormatted = sorted.map(formatEmailForPrompt).join("\n---\n\n");

  const prompt = `You are classifying an email thread for MAS Precision Parts, a precision manufacturing company.

ABOUT US:
- We are MAS Precision Parts (sales@masprecisionparts.com)
- We manufacture precision parts for CUSTOMERS (they buy from us)
- We purchase materials/equipment from VENDORS (we buy from them)
- [SENT] emails are from us, [RECEIVED] emails are from external parties

CRITICAL RULES - APPLY THESE FIRST:
1. If WE send an Invoice → ALWAYS "customer" (we bill customers, never vendors)
2. If WE send a Quotation/Quote/Estimate → ALWAYS "customer" (we quote customers, never vendors)
3. If subject contains "RFQ" or "Request for Quotation" and THEY ask US for pricing → "customer" + "quote_request"
4. If WE send a PO to them → ALWAYS "vendor" (we buy from vendors)

THREAD (oldest first):
${threadFormatted}

CLASSIFICATION:
1. CATEGORY - Who is the external party?
   - "customer": Someone we sell to or provide quotes to
     * They send us a PO or RFQ (buying from us)
     * We send them an invoice, quotation, or estimate (billing/quoting them)
     * They ask US for pricing or quotes
   - "vendor": Someone we buy from
     * We send them a PO or RFQ (we're purchasing)
     * They send us quotes/pricing IN RESPONSE to our RFQ (we're the buyer)
   - "other": Automated emails, newsletters, spam

2. ITEM_TYPE - What kind of interaction?
   - "po_received": Customer sent us a purchase order
   - "po_sent": We sent a PO to vendor
   - "quote_request": Customer asking US for a quote/pricing (NOT when we ask vendors)
   - "general": General correspondence
   - "other": Automated/newsletters

3. NEEDS_RESPONSE - Does the LAST email need our reply?
   FALSE for: acknowledgments, FYI notices, policy statements, "notice" emails
   TRUE for: questions, requests that explicitly ask for a reply
   IMPORTANT: "Notice" emails (price notices, policy notices) = FALSE unless they ask for reply

4. CONTACT_NAME - External party's name/company

5. SUMMARY - 1-2 sentence summary

Return JSON only: {"category": "...", "item_type": "...", "contact_name": "...", "summary": "...", "needs_response": true/false}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL_SONNET,  // Use Sonnet for individual fallback - more reliable
      max_tokens: 300,
      system: "You are a JSON-only classifier. Always respond with valid JSON, no explanations.",
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" }
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    const result = JSON.parse("{" + content.text) as {
      category: string;
      item_type: string;
      contact_name: string | null;
      summary: string;
      needs_response: boolean;
    };

    // Validate and return
    const validCategories: Category[] = ["customer", "vendor", "other"];
    const validItemTypes: ItemType[] = ["po_sent", "po_received", "quote_request", "general", "other"];

    const category = validCategories.includes(result.category as Category)
      ? (result.category as Category)
      : initialCategory;

    const itemType = validItemTypes.includes(result.item_type as ItemType)
      ? (result.item_type as ItemType)
      : "general";

    return {
      category,
      itemType,
      contactName: result.contact_name,
      summary: result.summary,
      needsResponse: result.needs_response !== false,
      relatedTo: null, // Single thread can't be related to others
    };
  } catch (error) {
    console.error("AI categorization error:", error);
    return {
      category: initialCategory,
      itemType: "general",
      contactName: null,
      summary: "Classification failed - needs review",
      needsResponse: true,
      relatedTo: null,
    };
  }
}

/**
 * @deprecated Use analyzePdfWithVision() in pdf-extractor.ts instead.
 * Text extraction loses formatting and can't handle tables/charts properly.
 * This function is kept for backward compatibility but should not be used.
 */
export async function extractPoFromPdfText(pdfText: string): Promise<PoExtractionResult> {
  const prompt = `Extract purchase order details from this document text.

Document text:
${pdfText.slice(0, 8000)}${pdfText.length > 8000 ? "..." : ""}

Extract:
1. PO Number
2. Vendor/Supplier name (who we're ordering from)
3. Line items with: description, quantity, unit price, line total
4. Total amount
5. Currency (USD, EUR, etc.)

Respond with JSON only:
{
  "po_number": "string or null",
  "vendor": "string or null",
  "items": [{"description": "string", "quantity": number or null, "unit_price": number or null, "line_total": number or null}],
  "total": number or null,
  "currency": "USD"
}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
      max_tokens: 1000,
      system: "You are a JSON-only data extractor. Extract structured data from documents. Always respond with valid JSON.",
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" }
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    const result = JSON.parse("{" + content.text) as {
      po_number: string | null;
      vendor: string | null;
      items: Array<{
        description: string;
        quantity: number | null;
        unit_price: number | null;
        line_total: number | null;
      }>;
      total: number | null;
      currency: string;
    };

    return {
      poNumber: result.po_number,
      vendor: result.vendor,
      items: result.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        lineTotal: item.line_total,
      })),
      total: result.total,
      currency: result.currency || "USD",
    };
  } catch (error) {
    console.error("PO extraction error:", error);
    return {
      poNumber: null,
      vendor: null,
      items: [],
      total: null,
      currency: "USD",
    };
  }
}

// Generate a thread summary using AI
export async function generateThreadSummary(emails: EmailForPrompt[]): Promise<string> {
  const sorted = [...emails].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateA - dateB;
  });

  const threadFormatted = sorted.map(formatEmailForPrompt).join("\n---\n\n");

  const prompt = `Summarize this email thread in 1-2 sentences. Focus on: what was discussed, current status, and any pending actions.

Thread:
${threadFormatted}

Respond with just the summary text, no JSON or formatting.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    return content.text.trim();
  } catch (error) {
    console.error("Summary generation error:", error);
    return "Summary unavailable";
  }
}
