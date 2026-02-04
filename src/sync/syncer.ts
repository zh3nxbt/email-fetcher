import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { createImapClient } from "@/imap/client";
import { extractAttachments } from "@/imap/parsers";
import { db, schema } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import type { NewEmail } from "@/db/schema";

const MAILBOXES = ["INBOX", "Sent", "Sent Messages"];

/**
 * Extract the received date from email headers.
 * Uses the first Received header (topmost = when our mail server received it).
 * Falls back to Date header if no Received header found.
 *
 * This is important because there can be significant delays between when
 * an email is sent (Date header) and when it arrives (Received header).
 */
function getReceivedDate(parsed: ParsedMail): Date | null {
  // Try to get the Received header(s)
  const received = parsed.headers.get("received");

  if (received) {
    // Received can be a string, array, or other types - we need a string
    let firstReceived: string | null = null;

    if (Array.isArray(received)) {
      firstReceived = typeof received[0] === "string" ? received[0] : null;
    } else if (typeof received === "string") {
      firstReceived = received;
    }

    if (firstReceived) {
      // Received header format: "from ... by ... ; <date>"
      // The date is after the semicolon
      const semicolonIndex = firstReceived.lastIndexOf(";");
      if (semicolonIndex !== -1) {
        const dateStr = firstReceived.substring(semicolonIndex + 1).trim();
        const receivedDate = new Date(dateStr);

        if (!isNaN(receivedDate.getTime())) {
          return receivedDate;
        }
      }
    }
  }

  // Fall back to Date header
  return parsed.date || null;
}
// Initial sync date - only used on first run
// Jan 1, 2026 00:00 EST = Jan 1, 2026 05:00 UTC
const INITIAL_SYNC_DATE = new Date("2026-01-01T05:00:00.000Z");
// Buffer days to overlap when doing incremental sync (IMAP SINCE is date-only)
const SYNC_OVERLAP_DAYS = 1;

export interface SyncStats {
  emailsSynced: number;
  mailboxesProcessed: string[];
  errors: string[];
}

async function getLastSyncTime(mailbox: string): Promise<Date | null> {
  const result = await db
    .select({ lastSyncAt: schema.syncMetadata.lastSyncAt })
    .from(schema.syncMetadata)
    .where(eq(schema.syncMetadata.mailbox, mailbox))
    .limit(1);

  return result.length > 0 ? result[0].lastSyncAt : null;
}

async function updateLastSyncTime(mailbox: string, syncTime: Date): Promise<void> {
  await db
    .insert(schema.syncMetadata)
    .values({ mailbox, lastSyncAt: syncTime })
    .onConflictDoUpdate({
      target: schema.syncMetadata.mailbox,
      set: { lastSyncAt: syncTime },
    });
}

async function getExistingUids(mailbox: string, uids: number[]): Promise<Set<number>> {
  if (uids.length === 0) return new Set();

  const result = await db
    .select({ uid: schema.emails.uid })
    .from(schema.emails)
    .where(and(eq(schema.emails.mailbox, mailbox), inArray(schema.emails.uid, uids)));

  return new Set(result.map((r) => r.uid));
}

async function syncMailbox(
  client: ImapFlow,
  mailbox: string
): Promise<{ synced: number; error?: string }> {
  try {
    // Try to open the mailbox
    let mailboxInfo;
    try {
      mailboxInfo = await client.mailboxOpen(mailbox, { readOnly: true });
    } catch (error: any) {
      if (error.message?.includes("not exist") || error.message?.includes("doesn't exist")) {
        console.log(`Mailbox "${mailbox}" does not exist, skipping`);
        return { synced: 0 };
      }
      throw error;
    }

    console.log(`Syncing mailbox: ${mailbox} (${mailboxInfo.exists} messages)`);

    // Get last sync time for incremental sync
    const lastSync = await getLastSyncTime(mailbox);
    let sinceDate: Date;

    if (lastSync) {
      // Incremental sync: go back SYNC_OVERLAP_DAYS to catch any late arrivals
      sinceDate = new Date(lastSync);
      sinceDate.setDate(sinceDate.getDate() - SYNC_OVERLAP_DAYS);
      console.log(`Incremental sync from ${sinceDate.toDateString()} (last sync: ${lastSync.toDateString()})`);
    } else {
      // First sync: use initial date
      sinceDate = INITIAL_SYNC_DATE;
      console.log(`Initial sync from ${sinceDate.toDateString()}`);
    }

    // Search for messages since the cutoff date
    const searchResult = await client.search({ since: sinceDate }, { uid: true });
    const uids = Array.isArray(searchResult) ? searchResult : [];
    console.log(`Found ${uids.length} messages since ${sinceDate.toDateString()}`);

    if (uids.length === 0) {
      // Still update last sync time even if no messages
      await updateLastSyncTime(mailbox, new Date());
      return { synced: 0 };
    }

    // Check which UIDs already exist in DB (single query)
    const existingUids = await getExistingUids(mailbox, uids);
    const uidsToSync = uids.filter((uid) => !existingUids.has(uid));
    console.log(`${uidsToSync.length} new emails to sync`);

    if (uidsToSync.length === 0) {
      await updateLastSyncTime(mailbox, new Date());
      return { synced: 0 };
    }

    let synced = 0;

    // Fetch each email individually with full source
    for (const uid of uidsToSync) {
      try {
        const msg = await client.fetchOne(uid, { source: true, bodyStructure: true }, { uid: true });

        if (!msg || !(msg as any).source) {
          console.log(`  UID ${uid}: no source, skipping`);
          continue;
        }

        // Parse with mailparser
        const parsed = await simpleParser((msg as any).source);

        // Extract attachments from bodyStructure
        const attachments = extractAttachments((msg as any).bodyStructure);

        // Get body text (prefer plain text, fall back to html-to-text conversion would happen in parsed.text)
        const bodyText = parsed.text || "";

        // Get the received date (when email arrived at our server, not when it was sent)
        const emailDate = getReceivedDate(parsed);

        // Prepare email record
        const newEmail: NewEmail = {
          uid,
          messageId: parsed.messageId || null,
          fromAddress: parsed.from?.value?.[0]?.address || null,
          fromName: parsed.from?.value?.[0]?.name || null,
          toAddresses: JSON.stringify(
            (Array.isArray(parsed.to) ? parsed.to : parsed.to?.value)?.map((a: any) => a.address).filter(Boolean) || []
          ),
          subject: parsed.subject || null,
          bodyText: bodyText.slice(0, 50000),
          date: emailDate,
          inReplyTo: parsed.inReplyTo || null,
          references: Array.isArray(parsed.references)
            ? parsed.references.join(" ")
            : parsed.references || null,
          mailbox,
          hasAttachments: attachments.length > 0,
          attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
          syncedAt: new Date(),
        };

        await db.insert(schema.emails).values(newEmail);
        synced++;

        if (synced % 10 === 0) {
          console.log(`  Synced ${synced} emails...`);
        }
      } catch (error) {
        console.error(`  Error syncing UID ${uid}:`, error);
      }
    }

    // Update last sync time after successful sync
    await updateLastSyncTime(mailbox, new Date());

    return { synced };
  } catch (error: any) {
    console.error(`Error syncing mailbox ${mailbox}:`, error);
    return { synced: 0, error: error.message };
  }
}

export async function syncEmails(): Promise<SyncStats> {
  const stats: SyncStats = {
    emailsSynced: 0,
    mailboxesProcessed: [],
    errors: [],
  };

  const client = createImapClient();

  try {
    await client.connect();
    console.log("Connected to IMAP server");

    for (const mailbox of MAILBOXES) {
      const result = await syncMailbox(client, mailbox);
      stats.emailsSynced += result.synced;
      stats.mailboxesProcessed.push(mailbox);

      if (result.error) {
        stats.errors.push(`${mailbox}: ${result.error}`);
      }

      console.log(`Mailbox ${mailbox}: synced ${result.synced} emails`);
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors
    }
  }

  return stats;
}
