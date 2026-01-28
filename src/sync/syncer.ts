import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createImapClient } from "@/imap/client";
import { extractAttachments } from "@/imap/parsers";
import { db, schema } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import type { NewEmail } from "@/db/schema";

const MAILBOXES = ["INBOX", "Sent", "Sent Messages"];
// Jan 26, 2026 00:00 EST = Jan 26, 2026 05:00 UTC
const SYNC_SINCE = new Date("2026-01-26T05:00:00.000Z");

export interface SyncStats {
  emailsSynced: number;
  mailboxesProcessed: string[];
  errors: string[];
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

    // Search for messages since cutoff date
    const sinceDate = SYNC_SINCE;

    // Search for messages in date range
    const searchResult = await client.search({ since: sinceDate }, { uid: true });
    const uids = Array.isArray(searchResult) ? searchResult : [];
    console.log(`Found ${uids.length} messages since ${sinceDate.toDateString()}`);

    if (uids.length === 0) {
      return { synced: 0 };
    }

    // Check which UIDs already exist in DB (single query)
    const existingUids = await getExistingUids(mailbox, uids);
    const uidsToSync = uids.filter((uid) => !existingUids.has(uid));
    console.log(`${uidsToSync.length} new emails to sync`);

    if (uidsToSync.length === 0) {
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
          date: parsed.date || null,
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
