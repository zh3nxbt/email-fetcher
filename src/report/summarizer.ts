import Anthropic from "@anthropic-ai/sdk";
import type { Category, ItemType } from "@/db/schema";
import type { EmailForPrompt, CategorizationResult, PoExtractionResult, PoLineItem } from "./types";

const anthropic = new Anthropic();

// Truncation limits
const BODY_LIMIT_SINGLE = 1500;
const BODY_LIMIT_BATCH = 500;

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

// Categorize multiple threads in a single API call
export async function categorizeThreadsBatch(
  threads: ThreadForBatch[]
): Promise<BatchCategorizationResult> {
  if (threads.length === 0) {
    return {};
  }

  // Format threads as JSON for the prompt
  const threadsJson = threads.map((thread) => {
    const sorted = [...thread.emails].sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return dateA - dateB;
    });

    return {
      threadKey: thread.threadKey,
      initialCategory: thread.initialCategory,
      emails: sorted.map((email) => ({
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

  const prompt = `You are analyzing multiple email threads for MAS Precision Parts, a precision parts manufacturing company.

CONTEXT:
- Emails with direction "SENT" are FROM us (MAS Precision Parts)
- Emails with direction "RECEIVED" are TO us (from external parties)
- Each thread includes an initialCategory guess based on first email direction

INPUT THREADS:
${JSON.stringify(threadsJson, null, 2)}

For EACH thread, determine:

1. CATEGORY - Confirm or correct the category:
   - "customer" = They are our customer. This includes:
     * They sent us an inquiry, RFQ, or PO
     * WE sent THEM an invoice, quotation, quote, or estimate (we're billing/quoting them)
   - "vendor" = They are our vendor/supplier. This ONLY applies when:
     * WE sent THEM a PO or RFQ (we're buying from them)
     * They sent us a quote/estimate in response to our RFQ
   - "other" = Newsletter, automated, internal, spam, or unrelated

2. ITEM_TYPE - What kind of interaction:
   - "po_received" = Customer sent us a purchase order
   - "po_sent" = We sent a PO to a vendor (we're buying)
   - "quote_request" = Customer asking us for a quote/pricing
   - "general" = General inquiry, conversation, OR we sent invoice/quotation to customer
   - "other" = Automated, newsletter, unrelated

3. CONTACT_NAME - The person/company name from the external party

4. SUMMARY - A 1-2 sentence summary of the thread's key content/status

5. NEEDS_RESPONSE - Does the LAST email in this thread require a response from us?
   - true = The customer asked a question, made a request, or expects action from us
   - false = The last email is a simple acknowledgment like "thanks", "thank you", "great thanks", "sounds good", "got it", "perfect", "received", or similar - NO response needed

6. RELATED_TO - If this thread is clearly a RESPONSE to another thread (e.g., a vendor quote/estimate that responds to our RFQ), provide the threadKey of that related thread. Look for:
   - Quotes/Estimates that respond to RFQs we sent (same vendor, matching part numbers, timing)
   - POs that follow quotes
   - Use null if not related to another thread

Respond with JSON only, no markdown. The response MUST include results for ALL ${threads.length} threads:
{"results": [{"threadKey": "...", "category": "customer|vendor|other", "item_type": "po_received|po_sent|quote_request|general|other", "contact_name": "name or null", "summary": "brief summary", "needs_response": true|false, "related_to": "threadKey or null"}, ...]}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
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
        threadKey: string;
        category: string;
        item_type: string;
        contact_name: string | null;
        summary: string;
        needs_response: boolean;
        related_to: string | null;
      }>;
    };

    // Validate and build result map
    const validCategories: Category[] = ["customer", "vendor", "other"];
    const validItemTypes: ItemType[] = ["po_sent", "po_received", "quote_request", "general", "other"];

    const resultMap: BatchCategorizationResult = {};

    // Build a lookup for initial categories
    const initialCategoryMap = new Map<string, Category>();
    for (const thread of threads) {
      initialCategoryMap.set(thread.threadKey, thread.initialCategory);
    }

    for (const result of parsed.results) {
      const initialCategory = initialCategoryMap.get(result.threadKey) || "other";

      const category = validCategories.includes(result.category as Category)
        ? (result.category as Category)
        : initialCategory;

      const itemType = validItemTypes.includes(result.item_type as ItemType)
        ? (result.item_type as ItemType)
        : "general";

      resultMap[result.threadKey] = {
        category,
        itemType,
        contactName: result.contact_name,
        summary: result.summary,
        needsResponse: result.needs_response !== false, // Default to true if not specified
        relatedTo: result.related_to || null,
      };
    }

    // Fill in any missing threads with defaults
    for (const thread of threads) {
      if (!resultMap[thread.threadKey]) {
        console.warn(`Batch response missing thread ${thread.threadKey}, using defaults`);
        resultMap[thread.threadKey] = {
          category: thread.initialCategory,
          itemType: "general",
          contactName: null,
          summary: "Classification incomplete - needs review",
          needsResponse: true, // Assume needs response if AI failed
          relatedTo: null,
        };
      }
    }

    return resultMap;
  } catch (error) {
    console.error("Batch categorization error:", error);
    throw error; // Let caller handle fallback
  }
}

// Categorize a thread using AI
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

  const prompt = `You are analyzing an email thread for MAS Precision Parts, a precision parts manufacturing company.

CONTEXT:
- Emails marked [SENT] are FROM us (MAS Precision Parts)
- Emails marked [RECEIVED] are TO us (from external parties)
- Initial category guess: ${initialCategory} (based on first email direction)

Thread (oldest first):
${threadFormatted}

Analyze this thread and provide:

1. CATEGORY - Confirm or correct the category:
   - "customer" = They are our customer. This includes:
     * They sent us an inquiry, RFQ, or PO
     * WE sent THEM an invoice, quotation, quote, or estimate (we're billing/quoting them)
   - "vendor" = They are our vendor/supplier. This ONLY applies when:
     * WE sent THEM a PO or RFQ (we're buying from them)
     * They sent us a quote/estimate in response to our RFQ
   - "other" = Newsletter, automated, internal, spam, or unrelated

2. ITEM_TYPE - What kind of interaction:
   - "po_received" = Customer sent us a purchase order
   - "po_sent" = We sent a PO to a vendor (we're buying)
   - "quote_request" = Customer asking us for a quote/pricing
   - "general" = General inquiry, conversation, OR we sent invoice/quotation to customer
   - "other" = Automated, newsletter, unrelated

3. CONTACT_NAME - The person/company name from the external party (customer or vendor)

4. SUMMARY - A 1-2 sentence summary of the thread's key content/status

5. NEEDS_RESPONSE - Does the LAST email in this thread require a response from us?
   - true = The customer asked a question, made a request, or expects action from us
   - false = The last email is a simple acknowledgment like "thanks", "thank you", "great thanks", "sounds good", "got it", "perfect", "received", or similar - NO response needed

Respond with JSON only, no markdown:
{"category": "customer|vendor|other", "item_type": "po_received|po_sent|quote_request|general|other", "contact_name": "name or null", "summary": "brief summary", "needs_response": true|false}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
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

// Extract PO details from PDF text using AI
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
