import "dotenv/config";
import postgres from "postgres";
import { ImapFlow } from "imapflow";
import Anthropic from "@anthropic-ai/sdk";

async function testSupabase() {
  console.log("\n🔌 Testing Supabase/Postgres connection...");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("❌ DATABASE_URL not set");
    return false;
  }

  try {
    const client = postgres(url);
    const result = await client`SELECT NOW() as time`;
    console.log("✅ Supabase connected! Server time:", result[0].time);
    await client.end();
    return true;
  } catch (err: any) {
    console.log("❌ Supabase connection failed:", err.message);
    return false;
  }
}

async function testImap() {
  console.log("\n📧 Testing IMAP connection...");
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;

  if (!host || !user || !pass) {
    console.log("❌ IMAP credentials not set (IMAP_HOST, IMAP_USER, IMAP_PASS)");
    return false;
  }

  const tlsReject = process.env.IMAP_TLS_REJECT_UNAUTHORIZED;
  const client = new ImapFlow({
    host,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: process.env.IMAP_SECURE !== "false",
    auth: { user, pass },
    logger: false,
    tls: tlsReject !== undefined ? { rejectUnauthorized: tlsReject !== "false" } : undefined,
  });

  try {
    await client.connect();
    const mailboxes = await client.list();
    console.log("✅ IMAP connected! Found", mailboxes.length, "mailboxes:");
    mailboxes.slice(0, 5).forEach(mb => console.log("   -", mb.path));
    if (mailboxes.length > 5) console.log("   ... and", mailboxes.length - 5, "more");
    await client.logout();
    return true;
  } catch (err: any) {
    console.log("❌ IMAP connection failed:", err.message);
    return false;
  }
}

async function testAnthropic() {
  console.log("\n🤖 Testing Anthropic connection...");
  const key = process.env.ANTHROPIC_API_KEY;

  if (!key) {
    console.log("❌ ANTHROPIC_API_KEY not set");
    return false;
  }

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
      max_tokens: 10,
      messages: [{ role: "user", content: "Say 'connected' in one word" }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    console.log("✅ Anthropic connected! Response:", text.trim());
    return true;
  } catch (err: any) {
    console.log("❌ Anthropic connection failed:", err.message);
    return false;
  }
}

async function main() {
  console.log("========================================");
  console.log("   Connection Tests for Email Fetcher");
  console.log("========================================");

  const results = {
    supabase: await testSupabase(),
    imap: await testImap(),
    anthropic: await testAnthropic(),
  };

  console.log("\n========================================");
  console.log("   Summary");
  console.log("========================================");
  console.log("Supabase:  ", results.supabase ? "✅ OK" : "❌ FAILED");
  console.log("IMAP:      ", results.imap ? "✅ OK" : "❌ FAILED");
  console.log("Anthropic: ", results.anthropic ? "✅ OK" : "❌ FAILED");

  const allPassed = Object.values(results).every(Boolean);
  console.log("\n" + (allPassed ? "🎉 All connections successful!" : "⚠️  Some connections failed"));

  process.exit(allPassed ? 0 : 1);
}

main();
