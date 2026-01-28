import { NextResponse } from "next/server";
import { syncEmails } from "@/sync/syncer";

export async function POST() {
  try {
    // Sync emails from IMAP
    const syncResult = await syncEmails();

    return NextResponse.json({
      success: true,
      sync: {
        emailsSynced: syncResult.emailsSynced,
        mailboxesProcessed: syncResult.mailboxesProcessed,
        errors: syncResult.errors,
      },
    });
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json(
      { error: "Sync failed", details: String(error) },
      { status: 500 }
    );
  }
}
