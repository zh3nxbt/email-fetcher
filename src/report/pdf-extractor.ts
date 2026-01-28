import { createImapClient, fetchBodyPart } from "@/imap/client";
import { flattenBodyStructure, type AttachmentInfo } from "@/imap/parsers";
import type { Email } from "@/db/schema";
import type { CategorizedThread, PoDetails } from "./types";
import { extractPoFromPdfText } from "./summarizer";
import pdfParse from "pdf-parse";

interface PdfAttachment {
  email: Email;
  filename: string;
  partId: string;
}

// Find PDF attachments in an email's bodyStructure
function findPdfAttachments(email: Email): { filename: string; partId: string }[] {
  if (!email.attachments) return [];

  try {
    const attachments = JSON.parse(email.attachments) as AttachmentInfo[];
    const pdfs: { filename: string; partId: string }[] = [];

    for (const att of attachments) {
      if (
        att.contentType?.toLowerCase().includes("pdf") ||
        att.filename?.toLowerCase().endsWith(".pdf")
      ) {
        // We need to find the part ID - this is tricky since we only store filename/contentType
        // For now, we'll need to re-fetch the bodyStructure to get the part ID
        pdfs.push({
          filename: att.filename,
          partId: "", // Will need to be resolved
        });
      }
    }

    return pdfs;
  } catch {
    return [];
  }
}

// Extract PDF content from IMAP
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
    const msg = await client.fetchOne(
      uid,
      { bodyStructure: true },
      { uid: true }
    );

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

      if (
        (contentType.includes("pdf") || filename?.toLowerCase().endsWith(".pdf")) &&
        node.part
      ) {
        try {
          const content = await fetchBodyPart(client, uid, node.part);
          if (content) {
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

// Parse PDF content to text
async function parsePdfToText(pdfBuffer: Buffer): Promise<string> {
  try {
    const data = await pdfParse(pdfBuffer);
    return data.text;
  } catch (error) {
    console.error("PDF parsing error:", error);
    return "";
  }
}

// Extract PO details from a thread's PDF attachments
export async function extractPoDetailsFromThread(
  thread: CategorizedThread
): Promise<PoDetails | null> {
  // Only process vendor threads with po_sent item type
  if (thread.category !== "vendor" || thread.itemType !== "po_sent") {
    return null;
  }

  // Find emails with PDF attachments
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
        const text = await parsePdfToText(pdf.content);

        if (text.length > 100) {
          // Has enough content to analyze
          const poDetails = await extractPoFromPdfText(text);

          if (poDetails.poNumber || poDetails.items.length > 0) {
            return poDetails;
          }
        }
      }
    } catch (error) {
      console.error(`Error extracting PDF from email ${email.uid}:`, error);
    }
  }

  return null;
}

// Process all vendor threads to extract PO details
export async function enrichThreadsWithPoDetails(
  threads: CategorizedThread[]
): Promise<CategorizedThread[]> {
  const enriched: CategorizedThread[] = [];

  for (const thread of threads) {
    if (thread.category === "vendor" && thread.itemType === "po_sent") {
      console.log(`Extracting PO details for thread: ${thread.subject}`);
      const poDetails = await extractPoDetailsFromThread(thread);
      enriched.push({ ...thread, poDetails });
    } else {
      enriched.push(thread);
    }
  }

  return enriched;
}
