/**
 * Test PDF Vision Analysis
 *
 * Tests sending PDF attachments directly to Claude API for visual analysis.
 * Run: npx tsx src/report/test-pdf-vision.ts
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createImapClient } from "@/imap/client";
import { flattenBodyStructure } from "@/imap/parsers";
import { db } from "@/db";
import { emails } from "@/db/schema";
import { desc, isNotNull } from "drizzle-orm";

const anthropic = new Anthropic();

interface PdfAnalysisResult {
  poNumber: string | null;
  vendor: string | null;
  customer: string | null;
  items: Array<{
    description: string;
    quantity: number | null;
    unitPrice: number | null;
    lineTotal: number | null;
  }>;
  total: number | null;
  currency: string;
  documentType: string;
  rawResponse?: string;
}

/**
 * Fetch a PDF attachment from IMAP by UID and mailbox
 */
async function fetchPdfFromEmail(
  uid: number,
  mailbox: string
): Promise<{ filename: string; content: Buffer } | null> {
  const client = createImapClient();

  try {
    await client.connect();
    await client.mailboxOpen(mailbox, { readOnly: true });

    // Fetch body structure
    const msg = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });

    if (!msg || !(msg as any).bodyStructure) {
      console.log("No body structure found");
      return null;
    }

    // Find PDF parts
    const nodes = flattenBodyStructure((msg as any).bodyStructure);

    for (const node of nodes) {
      const contentType = `${node.type || ""}/${node.subtype || ""}`.toLowerCase();
      const params = node.params || node.parameters || {};
      const disposition = node.disposition;
      const dispParams =
        typeof disposition === "object" ? disposition?.params || disposition?.parameters : {};
      const filename = dispParams?.filename || params.name || params.filename;

      const isPdf =
        contentType.includes("pdf") || filename?.toLowerCase().endsWith(".pdf");

      if (isPdf && node.part) {
        console.log(`Found PDF: ${filename} (part ${node.part})`);

        // Fetch the part content
        const partData = await client.fetchOne(
          uid,
          { bodyParts: [node.part] },
          { uid: true }
        );

        if (partData && (partData as any).bodyParts) {
          const partContent = (partData as any).bodyParts.get(node.part);
          if (partContent) {
            return {
              filename: filename || "attachment.pdf",
              content: Buffer.from(partContent),
            };
          }
        }
      }
    }

    console.log("No PDF attachment found in this email");
    return null;
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors
    }
  }
}

/**
 * Send PDF to Claude for visual analysis
 */
async function analyzePdfWithVision(
  pdfBuffer: Buffer,
  filename: string
): Promise<PdfAnalysisResult> {
  const pdfBase64 = pdfBuffer.toString("base64");

  console.log(`Sending PDF to Claude (${(pdfBuffer.length / 1024).toFixed(1)} KB)...`);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64,
            },
          },
          {
            type: "text",
            text: `Analyze this document and extract the following information.

1. Document type (Purchase Order, Invoice, Quote/Estimate, Packing Slip, Other)
2. PO Number or Invoice Number or Quote Number
3. Vendor/Supplier name (who is selling)
4. Customer/Buyer name (who is buying)
5. Line items with: description, quantity, unit price, line total
6. Total amount
7. Currency (USD, CAD, EUR, etc.)

Respond with JSON only:
{
  "documentType": "Purchase Order" | "Invoice" | "Quote" | "Packing Slip" | "Other",
  "poNumber": "string or null",
  "vendor": "string or null",
  "customer": "string or null",
  "items": [{"description": "string", "quantity": number or null, "unitPrice": number or null, "lineTotal": number or null}],
  "total": number or null,
  "currency": "USD"
}`,
          },
        ],
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type");
  }

  console.log("Claude response received");

  // Parse JSON from response
  try {
    // Try to extract JSON from the response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const result = JSON.parse(jsonMatch[0]) as {
      documentType?: string;
      poNumber?: string | null;
      vendor?: string | null;
      customer?: string | null;
      items?: Array<{
        description: string;
        quantity: number | null;
        unitPrice: number | null;
        lineTotal: number | null;
      }>;
      total?: number | null;
      currency?: string;
    };

    return {
      documentType: result.documentType || "Unknown",
      poNumber: result.poNumber || null,
      vendor: result.vendor || null,
      customer: result.customer || null,
      items: result.items || [],
      total: result.total || null,
      currency: result.currency || "USD",
    };
  } catch (parseError) {
    console.error("Failed to parse JSON:", parseError);
    return {
      documentType: "Unknown",
      poNumber: null,
      vendor: null,
      customer: null,
      items: [],
      total: null,
      currency: "USD",
      rawResponse: content.text,
    };
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("PDF Vision Analysis Test");
  console.log("=".repeat(60));
  console.log("");

  // Find an email with PDF attachment in the database
  console.log("[1] Finding email with PDF attachment...");

  const emailsWithPdf = await db
    .select()
    .from(emails)
    .where(isNotNull(emails.attachments))
    .orderBy(desc(emails.date))
    .limit(20);

  // Find one that has a PDF
  let targetEmail = null;
  for (const email of emailsWithPdf) {
    if (email.attachments?.toLowerCase().includes("pdf")) {
      targetEmail = email;
      break;
    }
  }

  if (!targetEmail) {
    console.log("No emails with PDF attachments found in database.");
    console.log("Try running 'npm run sync' first to fetch emails.");
    process.exit(1);
  }

  console.log(`Found email: "${targetEmail.subject}"`);
  console.log(`  From: ${targetEmail.fromAddress}`);
  console.log(`  Date: ${targetEmail.date}`);
  console.log(`  Attachments: ${targetEmail.attachments}`);
  console.log("");

  // Fetch PDF from IMAP
  console.log("[2] Fetching PDF from IMAP...");
  const pdf = await fetchPdfFromEmail(targetEmail.uid, targetEmail.mailbox);

  if (!pdf) {
    console.log("Could not fetch PDF from IMAP.");
    process.exit(1);
  }

  console.log(`Fetched: ${pdf.filename} (${(pdf.content.length / 1024).toFixed(1)} KB)`);

  // Debug: Check if this is actually a PDF or still base64 encoded
  const first20 = pdf.content.slice(0, 20).toString("ascii");
  console.log(`First 20 chars: "${first20}"`);
  const isPdfMagic = first20.startsWith("%PDF");
  console.log(`Valid PDF header: ${isPdfMagic}`);

  if (!isPdfMagic) {
    // The content might still be base64 encoded - try decoding
    console.log("Content is not a valid PDF - attempting base64 decode...");
    const decoded = Buffer.from(pdf.content.toString("ascii"), "base64");
    const decodedFirst20 = decoded.slice(0, 20).toString("ascii");
    console.log(`Decoded first 20 chars: "${decodedFirst20}"`);
    if (decodedFirst20.startsWith("%PDF")) {
      console.log("Base64 decode successful!");
      pdf.content = decoded;
      console.log(`Decoded size: ${(pdf.content.length / 1024).toFixed(1)} KB`);
    } else {
      console.log("WARNING: Could not decode PDF - data may be corrupted");
    }
  }
  console.log("");

  // Analyze with Claude Vision
  console.log("[3] Analyzing PDF with Claude Vision...");
  const result = await analyzePdfWithVision(pdf.content, pdf.filename);

  console.log("");
  console.log("=".repeat(60));
  console.log("Analysis Result:");
  console.log("=".repeat(60));
  console.log(`Document Type: ${result.documentType}`);
  console.log(`PO/Invoice #:  ${result.poNumber || "N/A"}`);
  console.log(`Vendor:        ${result.vendor || "N/A"}`);
  console.log(`Customer:      ${result.customer || "N/A"}`);
  console.log(`Total:         ${result.total ? `$${result.total} ${result.currency}` : "N/A"}`);

  if (result.items.length > 0) {
    console.log("");
    console.log("Line Items:");
    for (const item of result.items.slice(0, 5)) {
      console.log(
        `  - ${item.description} | Qty: ${item.quantity ?? "?"} | $${item.unitPrice ?? "?"} | Total: $${item.lineTotal ?? "?"}`
      );
    }
    if (result.items.length > 5) {
      console.log(`  ... and ${result.items.length - 5} more items`);
    }
  }

  if (result.rawResponse) {
    console.log("");
    console.log("Raw response (JSON parse failed):");
    console.log(result.rawResponse);
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("Test completed successfully!");
  console.log("=".repeat(60));

  process.exit(0);
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
