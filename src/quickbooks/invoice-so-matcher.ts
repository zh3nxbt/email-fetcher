/**
 * Invoice-Sales Order Matcher
 *
 * Uses Claude to compare invoice and sales order line items to determine
 * if an invoice matches a sales order and if the SO is fully invoiced.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { QBSalesOrder, QBInvoice } from "./types.js";

export interface InvoiceSoMatch {
  salesOrder: QBSalesOrder;
  invoice: QBInvoice;
  isMatch: boolean;
  isFullyInvoiced: boolean;
  matchConfidence: "high" | "medium" | "low";
  reasoning: string;
}

interface LineItemSummary {
  description: string;
  quantity?: number;
  amount?: string;
}

function summarizeLines(lines: Array<{ description?: string; quantity?: number; amount?: string }> | undefined): LineItemSummary[] {
  if (!lines) return [];
  return lines
    .filter((l) => l.description || l.amount)
    .map((l) => ({
      description: l.description || "(no description)",
      quantity: l.quantity,
      amount: l.amount,
    }));
}

/**
 * Match invoices to sales orders using LLM analysis
 *
 * Compares line items, descriptions, and amounts to determine matches.
 * Returns only confirmed matches with invoicing status.
 */
export async function matchInvoicesToSalesOrders(
  salesOrders: QBSalesOrder[],
  invoices: QBInvoice[]
): Promise<InvoiceSoMatch[]> {
  if (salesOrders.length === 0 || invoices.length === 0) {
    return [];
  }

  const client = new Anthropic();
  const matches: InvoiceSoMatch[] = [];

  // Process each SO against each invoice
  for (const so of salesOrders) {
    for (const invoice of invoices) {
      const match = await analyzeMatch(client, so, invoice);
      if (match.isMatch) {
        matches.push(match);
      }
    }
  }

  return matches;
}

async function analyzeMatch(
  client: Anthropic,
  so: QBSalesOrder,
  invoice: QBInvoice
): Promise<InvoiceSoMatch> {
  const soLines = summarizeLines(so.lines);
  const invLines = summarizeLines(invoice.lines);

  const prompt = `Compare this Sales Order and Invoice to determine if they are for the same job.

SALES ORDER (Ref: ${so.refNumber || so.id})
Date: ${so.transactionDate}
Total: ${so.totalAmount}
Customer: ${so.customer.fullName || so.customer.name}
Lines:
${soLines.map((l) => `- ${l.description} (qty: ${l.quantity ?? "?"}, amt: ${l.amount ?? "?"})`).join("\n") || "(no lines)"}

INVOICE (Ref: ${invoice.refNumber || invoice.id})
Date: ${invoice.transactionDate}
Total: ${invoice.totalAmount}
Customer: ${invoice.customer.fullName || invoice.customer.name}
Lines:
${invLines.map((l) => `- ${l.description} (qty: ${l.quantity ?? "?"}, amt: ${l.amount ?? "?"})`).join("\n") || "(no lines)"}

Determine:
1. Is this invoice for the same job as this sales order? (compare line items, part numbers, descriptions)
2. If yes, is the sales order fully invoiced (invoice covers all items) or partially invoiced?

Respond in JSON format:
{
  "isMatch": true/false,
  "isFullyInvoiced": true/false (only if isMatch is true),
  "matchConfidence": "high" | "medium" | "low",
  "reasoning": "brief explanation"
}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    // Extract JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const result = JSON.parse(jsonMatch[0]);

    return {
      salesOrder: so,
      invoice: invoice,
      isMatch: result.isMatch === true,
      isFullyInvoiced: result.isFullyInvoiced === true,
      matchConfidence: result.matchConfidence || "low",
      reasoning: result.reasoning || "",
    };
  } catch (error) {
    console.warn(`Failed to analyze SO ${so.refNumber} vs Invoice ${invoice.refNumber}:`, error);
    return {
      salesOrder: so,
      invoice: invoice,
      isMatch: false,
      isFullyInvoiced: false,
      matchConfidence: "low",
      reasoning: "Analysis failed",
    };
  }
}

/**
 * Find sales orders that should be closed based on invoice matching
 *
 * Returns SOs where:
 * - SO is open (not manually closed, not marked fully invoiced)
 * - A matching invoice exists that covers the full SO amount
 */
export async function findSosShouldBeClosed(
  salesOrders: QBSalesOrder[],
  invoices: QBInvoice[]
): Promise<InvoiceSoMatch[]> {
  // Only check open sales orders
  const openSOs = salesOrders.filter((so) => !so.isManuallyClosed && !so.isFullyInvoiced);

  if (openSOs.length === 0) {
    return [];
  }

  const allMatches = await matchInvoicesToSalesOrders(openSOs, invoices);

  // Return only matches where SO is fully invoiced but still open
  return allMatches.filter((m) => m.isMatch && m.isFullyInvoiced);
}
