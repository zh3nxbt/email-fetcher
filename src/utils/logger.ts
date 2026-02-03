import fs from "fs";
import path from "path";

const LOGS_DIR = path.join(process.cwd(), "logs");

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Log AI classification mismatches for monitoring
export function logAiMismatch(type: "po_pattern" | "rfq_pattern" | "category", details: {
  subject: string;
  aiResult: string;
  expectedResult: string;
  threadKey?: string;
}) {
  const timestamp = new Date().toISOString();
  const logFile = path.join(LOGS_DIR, "ai-mismatches.log");

  const logEntry = JSON.stringify({
    timestamp,
    type,
    ...details,
  }) + "\n";

  fs.appendFileSync(logFile, logEntry);
}

// Get recent AI mismatches for review
export function getRecentMismatches(limit: number = 50): Array<{
  timestamp: string;
  type: string;
  subject: string;
  aiResult: string;
  expectedResult: string;
}> {
  const logFile = path.join(LOGS_DIR, "ai-mismatches.log");

  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines
    .slice(-limit)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ============================================================
// PO Detection Failure Logging
// ============================================================

export type PoDetectionFailureStage =
  | "no_attachments"     // Thread marked po_received but no attachments
  | "no_po_candidate"    // Attachments found but none look like POs
  | "fetch_failed"       // IMAP fetch failed
  | "analysis_failed"    // Claude analysis failed
  | "not_a_po";          // AI determined document is not a PO

export interface PoDetectionFailure {
  stage: PoDetectionFailureStage;
  threadKey: string;
  subject: string;
  contactEmail: string | null;
  filename?: string;
  reason?: string;
  attemptedFiles?: Array<{
    filename: string;
    result: "success" | "fetch_failed" | "not_a_po";
    reason?: string;
  }>;
}

// Log PO detection failure to /logs/po-detection-failures.log
export function logPoDetectionFailure(failure: PoDetectionFailure): void {
  const timestamp = new Date().toISOString();
  const logFile = path.join(LOGS_DIR, "po-detection-failures.log");

  const logEntry = JSON.stringify({
    timestamp,
    ...failure,
  }) + "\n";

  fs.appendFileSync(logFile, logEntry);
}

// Get recent PO detection failures for review
export function getRecentPoFailures(limit: number = 50): Array<PoDetectionFailure & { timestamp: string }> {
  const logFile = path.join(LOGS_DIR, "po-detection-failures.log");

  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines
    .slice(-limit)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
