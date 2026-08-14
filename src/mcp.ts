// MCP discovery server: exposes the facilitator's Bazaar catalog to AI agents
// as MCP tools over stdio. A thin shim over the HTTP discovery API, using the
// OFFICIAL bazaar client (withBazaar) — so anything this server can do, any
// canonical x402 client can do against the same endpoints.
//
// Run:  FACILITATOR_URL=https://<facilitator> npx tsx src/mcp.ts
// (or add it to an MCP client config, e.g. Claude Desktop / Claude Code.)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions/bazaar";
import { z } from "zod";
import { fenceUntrusted } from "./fence.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL || "http://localhost:4100";
const bazaar = withBazaar(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).extensions.bazaar;

const server = new McpServer({ name: "vellar-facilitator-discovery", version: "0.1.0" });

/** Strip undefined values so optional zod outputs satisfy exact-optional param types. */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: NonNullable<T[K]> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: NonNullable<T[K]>;
  };
}

const sharedFilters = {
  type: z.enum(["http", "mcp"]).optional().describe("Filter by protocol type"),
  payTo: z.string().optional().describe("Filter by payment recipient address"),
  network: z.string().optional().describe("Filter by network, e.g. stellar:testnet"),
  limit: z.number().int().min(1).max(100).optional().describe("Max results per page"),
  verified_only: z
    .boolean()
    .optional()
    .describe(
      "Only return resources whose payment assets have VERIFIED source provenance " +
        "(reproducible-build verification; verified means provenance, not audited/safe)",
    ),
};

/** Trust-layer client-side filter: keeps wire compatibility with the canonical
 * bazaar client (which has no verified_only param) by filtering on the
 * additive `trust.verification` field the facilitator annotates. */
function applyVerifiedOnly<T extends { trust?: { verification?: string } }>(
  items: T[],
  verifiedOnly: boolean | undefined,
): T[] {
  if (!verifiedOnly) return items;
  return items.filter((item) => item.trust?.verification === "verified");
}

/**
 * Fix 4 (F1): a resource `description` is seller-supplied free text that reaches
 * the consuming agent's context. Even after server-side sanitization (control/
 * bidi chars stripped, length clamped), it is untrusted DATA, not instructions.
 *
 * UPDATED 2026-08-13: this used to prefix the description with a marker and
 * nothing else. A prefix announces hostile text without BOUNDING it — there is
 * no terminator, so the seller can assert authority inline and nothing says
 * where their text stops. Replaced with the nonce-delimited fence in `fence.ts`,
 * which is the same format vellar-sdk's mcp-x402-payer emits, so an agent
 * connected to both servers sees one convention rather than two.
 */
function frameDescriptions<T extends { description?: unknown }>(items: T[]): T[] {
  return items.map((item) => {
    if (typeof item.description !== "string") return item;
    return { ...item, description: fenceUntrusted(item.description, "a resource description") };
  });
}

server.registerTool(
  "x402_list_resources",
  {
    description:
      "List x402 payable resources cataloged by the facilitator's Bazaar. " +
      "Each entry includes the resource URL, how to call it, and the accepted payment requirements " +
      "(asset, amount, payTo, network) an agent needs to pay for it.",
    inputSchema: {
      ...sharedFilters,
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
  },
  async ({ verified_only, ...params }) => {
    const result = await bazaar.listResources(compact(params));
    const items = frameDescriptions(
      applyVerifiedOnly(
        result.items as Array<(typeof result.items)[number] & { trust?: { verification?: string } }>,
        verified_only,
      ),
    );
    return { content: [{ type: "text", text: JSON.stringify({ ...result, items }, null, 2) }] };
  },
);

server.registerTool(
  "x402_search_resources",
  {
    description:
      "Search the facilitator's Bazaar catalog of x402 payable resources with a natural-language query " +
      "(e.g. 'weather data API' or 'stellar price feed'). Returns relevance-ranked resources with the " +
      "payment requirements needed to pay for them.",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language search query"),
      ...sharedFilters,
      cursor: z.string().optional().describe("Continuation cursor from a previous search"),
    },
  },
  async ({ verified_only, ...params }) => {
    const result = await bazaar.search(compact(params) as { query: string });
    const resources = frameDescriptions(
      applyVerifiedOnly(
        result.resources as Array<
          (typeof result.resources)[number] & { trust?: { verification?: string } }
        >,
        verified_only,
      ),
    );
    return {
      content: [{ type: "text", text: JSON.stringify({ ...result, resources }, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp] vellar-facilitator discovery server connected (facilitator: ${FACILITATOR_URL})`);
