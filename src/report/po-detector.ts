/**
 * Smart PO Detection
 *
 * Orchestrates intelligent PO detection from email attachments:
 * 1. Ranks attachments by filename to find PO candidates
 * 2. Fetches specific attachments (not all PDFs)
 * 3. Validates each document is actually a PO
 * 4. Handles multiple POs in one email
 * 5. Logs failures for review
 */

import type { Email, PoAttachment } from "@/db/schema";
import type { PoDetails } from "./types";
import { rankAttachmentsForPo, type AttachmentInfo } from "./summarizer";
import {
  fetchSpecificAttachment,
  storeAttachment,
  analyzeAndValidatePo,
  updateAttachmentAnalysis,
  getStoredAttachment,
  type FetchedPdf,
} from "@/storage/po-attachment-manager";
import { logPoDetectionFailure, type PoDetectionFailureStage } from "@/utils/logger";

// ============================================================
// Types
// ============================================================

export interface AttemptedFile {
  filename: string;
  result: "success" | "fetch_failed" | "not_a_po";
  reason?: string;
}

export interface SmartPoDetectionResult {
  success: boolean;
  poDetailsList: PoDetails[]; // All valid POs found
  primaryPo: PoDetails | null; // First valid PO (for backward compat)
  needsReclassification: boolean; // True if no valid PO found
  attemptedFiles: AttemptedFile[];
}

// ============================================================
// Attachment Parsing
// ============================================================

/**
 * Parse attachments JSON from email record
 */
function parseEmailAttachments(email: Email): AttachmentInfo[] {
  if (!email.attachments) {
    return [];
  }

  try {
    // Attachments might be a JSON array or string description
    const parsed = JSON.parse(email.attachments);

    if (Array.isArray(parsed)) {
      // Format: [{filename, contentType, size}, ...]
      return parsed.map((att: any) => ({
        filename: att.filename || att.name || "unknown",
        contentType: att.contentType || att.type || "application/octet-stream",
        size: att.size || 0,
      }));
    }

    // Fallback: try to extract filenames from string
    return [];
  } catch {
    // Not JSON - might be comma-separated or descriptive text
    // Try to extract .pdf/.doc filenames
    const filenameRegex = /[\w\-. ]+\.(pdf|docx?)/gi;
    const matches = email.attachments.match(filenameRegex);

    if (matches) {
      return matches.map((filename) => ({
        filename,
        contentType: filename.toLowerCase().endsWith(".pdf")
          ? "application/pdf"
          : "application/msword",
        size: 0, // Unknown
      }));
    }

    return [];
  }
}

// ============================================================
// Smart PO Detection
// ============================================================

/**
 * Smart PO detection from an email's attachments.
 *
 * This is the main entry point for the new PO detection flow:
 * 1. Parses attachment metadata from email
 * 2. Uses AI to rank attachments by PO likelihood
 * 3. Fetches and analyzes each candidate
 * 4. Validates that documents are actually POs
 * 5. Stores all analyzed files (valid or not) for future reference
 *
 * @param email - The email containing attachments
 * @param threadKey - Thread key for storage
 * @param threadSubject - Thread subject for AI context
 * @returns Detection result with all valid POs found
 */
export async function smartPoDetection(
  email: Email,
  threadKey: string,
  threadSubject: string
): Promise<SmartPoDetectionResult> {
  const attemptedFiles: AttemptedFile[] = [];
  const validPoDetails: PoDetails[] = [];

  const sender = email.fromName || email.fromAddress || "Unknown";

  // Step 1: Parse attachments from email
  const attachments = parseEmailAttachments(email);

  if (attachments.length === 0) {
    // No attachments - log failure
    logPoDetectionFailure({
      stage: "no_attachments",
      threadKey,
      subject: threadSubject,
      contactEmail: email.fromAddress,
    });

    return {
      success: false,
      poDetailsList: [],
      primaryPo: null,
      needsReclassification: true,
      attemptedFiles: [],
    };
  }

  console.log(`  Smart PO detection: ${attachments.length} attachment(s) in email ${email.uid}`);

  // Step 2: Rank attachments by PO likelihood
  const rankedAttachments = await rankAttachmentsForPo(attachments, threadSubject, sender);
  const candidates = rankedAttachments.filter((r) => r.isPoCandidate);

  if (candidates.length === 0) {
    // No PO candidates found
    logPoDetectionFailure({
      stage: "no_po_candidate",
      threadKey,
      subject: threadSubject,
      contactEmail: email.fromAddress,
      reason: `${attachments.length} attachment(s) but none identified as potential POs`,
    });

    return {
      success: false,
      poDetailsList: [],
      primaryPo: null,
      needsReclassification: true,
      attemptedFiles: rankedAttachments.map((r) => ({
        filename: r.filename,
        result: "not_a_po" as const,
        reason: r.reason,
      })),
    };
  }

  console.log(`  Found ${candidates.length} PO candidate(s): ${candidates.map((c) => c.filename).join(", ")}`);

  // Step 3: Process each candidate (in rank order)
  for (const candidate of candidates) {
    console.log(`  Processing candidate: ${candidate.filename}`);

    // Check if already stored and analyzed
    const existing = await getStoredAttachment(email.id, candidate.filename);
    if (existing && existing.analyzedAt) {
      // Already analyzed - check result
      if (existing.isValidPo === true && existing.analysisJson) {
        console.log(`    Using cached valid PO: ${candidate.filename}`);
        validPoDetails.push(existing.analysisJson as PoDetails);
        attemptedFiles.push({
          filename: candidate.filename,
          result: "success",
        });
        continue;
      } else if (existing.isValidPo === false) {
        console.log(`    Cached as not-PO: ${candidate.filename} (${existing.notPoReason})`);
        attemptedFiles.push({
          filename: candidate.filename,
          result: "not_a_po",
          reason: existing.notPoReason || "Previously determined not a PO",
        });
        continue;
      }
      // isValidPo is null - needs re-analysis
    }

    // Fetch the specific attachment
    let fetchedPdf: FetchedPdf | null = null;
    try {
      fetchedPdf = await fetchSpecificAttachment(email.uid, email.mailbox, candidate.filename);
    } catch (error) {
      console.error(`    Fetch failed for ${candidate.filename}:`, error);
      attemptedFiles.push({
        filename: candidate.filename,
        result: "fetch_failed",
        reason: String(error),
      });
      continue;
    }

    if (!fetchedPdf) {
      console.warn(`    Not found: ${candidate.filename}`);
      attemptedFiles.push({
        filename: candidate.filename,
        result: "fetch_failed",
        reason: "Attachment not found in email",
      });
      continue;
    }

    // Store the PDF (for future reference)
    const stored = await storeAttachment(email, threadKey, fetchedPdf);
    if (!stored) {
      console.warn(`    Failed to store: ${candidate.filename}`);
      attemptedFiles.push({
        filename: candidate.filename,
        result: "fetch_failed",
        reason: "Failed to store attachment",
      });
      continue;
    }

    // Analyze and validate
    console.log(`    Analyzing: ${fetchedPdf.filename} (${(fetchedPdf.content.length / 1024).toFixed(0)} KB)`);
    const validationResult = await analyzeAndValidatePo(fetchedPdf.content, {
      subject: threadSubject,
      sender,
    });

    // Update the stored attachment with analysis results
    await updateAttachmentAnalysis(stored.id, {
      poNumber: validationResult.details?.poNumber || null,
      poTotal: validationResult.details?.total
        ? Math.round(validationResult.details.total * 100)
        : null,
      analysisJson: validationResult.details,
      isValidPo: validationResult.isValidPo,
      notPoReason: validationResult.notPoReason,
    });

    if (validationResult.isValidPo && validationResult.details) {
      console.log(`    Valid PO: ${validationResult.details.poNumber || "(no number)"} $${validationResult.details.total || "?"}`);
      validPoDetails.push(validationResult.details);
      attemptedFiles.push({
        filename: candidate.filename,
        result: "success",
      });
    } else {
      console.log(`    Not a PO: ${validationResult.notPoReason}`);
      attemptedFiles.push({
        filename: candidate.filename,
        result: "not_a_po",
        reason: validationResult.notPoReason || "Document is not a purchase order",
      });
    }
  }

  // Step 4: Determine final result
  const success = validPoDetails.length > 0;

  if (!success) {
    // No valid POs found - log failure
    logPoDetectionFailure({
      stage: "not_a_po",
      threadKey,
      subject: threadSubject,
      contactEmail: email.fromAddress,
      attemptedFiles,
      reason: `Analyzed ${attemptedFiles.length} file(s), none were valid POs`,
    });
  }

  return {
    success,
    poDetailsList: validPoDetails,
    primaryPo: validPoDetails[0] || null,
    needsReclassification: !success,
    attemptedFiles,
  };
}

/**
 * Format PO details for display (handles multiple POs)
 */
export function formatPoDetailsDisplay(poDetailsList: PoDetails[]): string {
  if (poDetailsList.length === 0) {
    return "";
  }

  if (poDetailsList.length === 1) {
    const po = poDetailsList[0];
    const number = po.poNumber || "(no number)";
    const total = po.total ? `$${po.total.toLocaleString()}` : "";
    return total ? `${number} ${total}` : number;
  }

  // Multiple POs
  const parts = poDetailsList.map((po) => {
    const number = po.poNumber || "(no number)";
    const total = po.total ? `$${po.total.toLocaleString()}` : "";
    return total ? `${number} (${total})` : number;
  });

  return parts.join(", ");
}
