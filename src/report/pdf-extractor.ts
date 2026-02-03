/**
 * PDF Attachment Extractor
 *
 * Fetches PDF attachments from IMAP and analyzes them using Claude's
 * visual PDF analysis (sends PDF as base64, Claude "sees" the document).
 *
 * This replaced the old text-extraction approach (pdf-parse) which lost
 * formatting and couldn't handle tables/charts properly.
 *
 * TODO: Add DOCX support - Claude doesn't support DOCX directly, so we'd need
 * to either convert to PDF first or use a library like 'mammoth' to extract
 * content. For now, only PDF attachments are processed.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createImapClient, fetchBodyPart } from "@/imap/client";
import { flattenBodyStructure } from "@/imap/parsers";
import type { Email } from "@/db/schema";
import type { CategorizedThread, PoDetails } from "./types";

const anthropic = new Anthropic();

// ============================================================
// IMAP PDF Fetching
// ============================================================

function normalizeDisposition(disposition: any): {
  type?: string;
  params?: Record<string, string>;
} {
  if (!disposition) return {};
  if (typeof disposition === "string") {
    return { type: disposition };
  }
  return {
    type: disposition.type || disposition.disposition || disposition.value,
    params: disposition.params || disposition.parameters || disposition.params,
  };
}

/**
 * Fetch PDF attachments from an email via IMAP
 *
 * Note: IMAP returns content with its original encoding (base64, quoted-printable, etc.)
 * We need to decode based on the Content-Transfer-Encoding header.
 */
async function fetchPdfContent(
  uid: number,
  mailbox: string
): Promise<{ filename: string; content: Buffer }[]> {
  const client = createImapClient();
  const results: { filename: string; content: Buffer }[] = [];

  try {
    await client.connect();
    await client.mailboxOpen(mailbox, { readOnly: true });

    // Fetch the message with body structure
    const msg = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });

    if (!msg || !(msg as any).bodyStructure) {
      return results;
    }

    // Find PDF parts
    const nodes = flattenBodyStructure((msg as any).bodyStructure);

    for (const node of nodes) {
      const contentType = `${node.type || ""}/${node.subtype || ""}`.toLowerCase();
      const params = node.params || node.parameters || {};
      const disposition = normalizeDisposition(node.disposition);
      const filename = disposition.params?.filename || params.name || params.filename;
      const encoding = (node.encoding || "").toLowerCase();

      if (
        (contentType.includes("pdf") || filename?.toLowerCase().endsWith(".pdf")) &&
        node.part
      ) {
        try {
          const rawContent = await fetchBodyPart(client, uid, node.part);
          if (rawContent) {
            // Decode content based on Content-Transfer-Encoding
            let content = rawContent;

            // Check if content needs base64 decoding
            // PDF magic number is %PDF (0x25 0x50 0x44 0x46)
            const first4 = rawContent.slice(0, 4).toString("ascii");
            const isPdfMagic = first4 === "%PDF";

            if (!isPdfMagic && encoding === "base64") {
              // Content is base64 encoded - decode it
              content = Buffer.from(rawContent.toString("ascii"), "base64");
            } else if (!isPdfMagic) {
              // Try base64 decode anyway as a fallback
              try {
                const decoded = Buffer.from(rawContent.toString("ascii"), "base64");
                if (decoded.slice(0, 4).toString("ascii") === "%PDF") {
                  content = decoded;
                }
              } catch {
                // Keep original content
              }
            }

            results.push({
              filename: filename || "attachment.pdf",
              content,
            });
          }
        } catch (error) {
          console.error(`Failed to fetch PDF part ${node.part}:`, error);
        }
      }
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors
    }
  }

  return results;
}

// ============================================================
// Claude Vision PDF Analysis
// ============================================================

/**
 * Analyze a PDF using Claude's visual document understanding
 *
 * Sends the PDF as base64 to Claude, which can "see" the document
 * including tables, formatting, logos, and handwritten notes.
 */
async function analyzePdfWithVision(pdfBuffer: Buffer): Promise<PoDetails | null> {
  const pdfBase64 = pdfBuffer.toString("base64");

  // Check size limit (32MB max for API, but be conservative)
  const sizeMB = pdfBuffer.length / (1024 * 1024);
  if (sizeMB > 25) {
    console.warn(`PDF too large for vision analysis: ${sizeMB.toFixed(1)}MB`);
    return null;
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
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
              text: `Extract purchase order details from this document.

Return JSON only:
{
  "poNumber": "string or null",
  "vendor": "vendor/supplier name or null",
  "items": [{"description": "string", "quantity": number or null, "unitPrice": number or null, "lineTotal": number or null}],
  "total": number or null,
  "currency": "USD"
}

If this is not a PO/invoice/quote, return: {"poNumber": null, "vendor": null, "items": [], "total": null, "currency": "USD"}`,
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      return null;
    }

    // Parse JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("No JSON found in Claude response");
      return null;
    }

    const result = JSON.parse(jsonMatch[0]) as {
      poNumber?: string | null;
      vendor?: string | null;
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
      poNumber: result.poNumber || null,
      vendor: result.vendor || null,
      items: (result.items || []).map((item) => ({
        description: item.description,
        quantity: item.quantity ?? null,
        unitPrice: item.unitPrice ?? null,
        lineTotal: item.lineTotal ?? null,
      })),
      total: result.total ?? null,
      currency: result.currency || "USD",
    };
  } catch (error) {
    console.error("PDF vision analysis failed:", error);
    return null;
  }
}

// ============================================================
// Thread Processing
// ============================================================

/**
 * Extract PO details from a thread's PDF attachments using vision
 */
export async function extractPoDetailsFromThread(
  thread: CategorizedThread
): Promise<PoDetails | null> {
  // Only process vendor threads with po_sent item type
  if (thread.category !== "vendor" || thread.itemType !== "po_sent") {
    return null;
  }

  // Find emails with PDF attachments
  // TODO: Also check for DOCX attachments when support is added
  const emailsWithPdfs = thread.emails.filter(
    (email) => email.hasAttachments && email.attachments?.toLowerCase().includes("pdf")
  );

  if (emailsWithPdfs.length === 0) {
    return null;
  }

  // Try to extract from the first PDF we find
  for (const email of emailsWithPdfs) {
    try {
      const pdfs = await fetchPdfContent(email.uid, email.mailbox);

      for (const pdf of pdfs) {
        console.log(`  Analyzing PDF: ${pdf.filename} (${(pdf.content.length / 1024).toFixed(0)} KB)`);

        const poDetails = await analyzePdfWithVision(pdf.content);

        if (poDetails && (poDetails.poNumber || poDetails.items.length > 0)) {
          return poDetails;
        }
      }
    } catch (error) {
      console.error(`Error extracting PDF from email ${email.uid}:`, error);
    }
  }

  return null;
}


/**
 * Standalone function to analyze a PDF buffer
 * Useful for testing or one-off analysis
 */
export async function analyzePdf(pdfBuffer: Buffer): Promise<PoDetails | null> {
  return analyzePdfWithVision(pdfBuffer);
}

/**
 * Fetch and analyze PDFs from a specific email
 * Returns all successfully analyzed PDFs
 */
export async function analyzeEmailPdfs(
  uid: number,
  mailbox: string
): Promise<Array<{ filename: string; details: PoDetails }>> {
  const results: Array<{ filename: string; details: PoDetails }> = [];

  const pdfs = await fetchPdfContent(uid, mailbox);

  for (const pdf of pdfs) {
    const details = await analyzePdfWithVision(pdf.content);
    if (details) {
      results.push({ filename: pdf.filename, details });
    }
  }

  return results;
}
