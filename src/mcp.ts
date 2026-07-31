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
};

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
  async (params) => {
    const result = await bazaar.listResources(compact(params));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
  async (params) => {
    const result = await bazaar.search(compact(params) as { query: string });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp] vellar-facilitator discovery server connected (facilitator: ${FACILITATOR_URL})`);
