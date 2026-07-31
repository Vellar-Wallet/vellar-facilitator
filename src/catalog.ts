import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import type {
  DiscoveredResource,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
  SearchDiscoveryResourcesResponse,
} from "@x402/extensions/bazaar";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * The Bazaar catalog: discovered x402 resources, fed automatically from
 * payment traffic (see bazaar.ts) and served over /discovery/*.
 *
 * Storage is in-memory with optional JSON-file persistence (CATALOG_FILE) so
 * a single-instance deployment survives restarts. The store is behind this
 * class so a database can replace the file without touching routes/ingestion.
 */
export class BazaarCatalog {
  private readonly entries = new Map<string, DiscoveryResource>();
  private readonly persistPath: string | undefined;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath) this.load(persistPath);
  }

  /** Number of cataloged resources. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Insert or update a resource from a settled payment's discovery info.
   * `accepts` accumulates distinct payment requirements seen for the resource.
   */
  upsertFromPayment(discovered: DiscoveredResource, requirements: PaymentRequirements): void {
    const key = discovered.resourceUrl;
    const existing = this.entries.get(key);

    const accepts = existing ? [...existing.accepts] : [];
    const reqKey = JSON.stringify({
      scheme: requirements.scheme,
      network: requirements.network,
      asset: requirements.asset,
      payTo: requirements.payTo,
      amount: requirements.amount,
    });
    const seen = accepts.some(
      (r) =>
        JSON.stringify({
          scheme: r.scheme,
          network: r.network,
          asset: r.asset,
          payTo: r.payTo,
          amount: r.amount,
        }) === reqKey,
    );
    if (!seen) accepts.push(requirements);

    const entry: DiscoveryResource = {
      resource: discovered.resourceUrl,
      type: discovered.discoveryInfo.input.type,
      x402Version: discovered.x402Version,
      accepts,
      lastUpdated: new Date().toISOString(),
      ...(discovered.description !== undefined ? { description: discovered.description } : {}),
      ...(discovered.mimeType !== undefined ? { mimeType: discovered.mimeType } : {}),
      ...(discovered.serviceName !== undefined ? { serviceName: discovered.serviceName } : {}),
      ...(discovered.tags !== undefined ? { tags: discovered.tags } : {}),
      ...(discovered.iconUrl !== undefined ? { iconUrl: discovered.iconUrl } : {}),
      ...(discovered.extensions !== undefined ? { extensions: discovered.extensions } : {}),
    };
    this.entries.set(key, entry);
    this.save();
  }

  /** GET /discovery/resources — filtered, offset-paginated listing. */
  list(params: ListDiscoveryResourcesParams = {}): DiscoveryResourcesResponse {
    const limit = clampLimit(params.limit);
    const offset = Math.max(0, params.offset ?? 0);
    const matched = this.filter(params);
    return {
      x402Version: 2,
      items: matched.slice(offset, offset + limit),
      pagination: { limit, offset, total: matched.length },
    };
  }

  /**
   * GET /discovery/search — token-scored relevance ranking over serviceName
   * (weight 4), tags (3), description (2), and the resource URL / MCP tool
   * name (1). Exact token hits score double a substring hit. Deterministic,
   * in-process, no external search service. Cursor pagination is advisory
   * per the spec: the cursor encodes {offset, query-hash} and is ignored if
   * the query/filters changed.
   */
  search(params: SearchDiscoveryResourcesParams): SearchDiscoveryResourcesResponse {
    const limit = clampLimit(params.limit);
    const tokens = tokenize(params.query);
    const filterKey = hashKey(params);

    let offset = 0;
    if (params.cursor) {
      const decoded = decodeCursor(params.cursor);
      if (decoded && decoded.k === filterKey) offset = decoded.o;
    }

    const scored = this.filter(params)
      .map((resource) => ({ resource, score: scoreResource(resource, tokens) }))
      .filter((s) => s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.resource.lastUpdated.localeCompare(a.resource.lastUpdated),
      )
      .map((s) => s.resource);

    const page = scored.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < scored.length;

    return {
      x402Version: 2,
      resources: page,
      partialResults: hasMore,
      pagination: {
        limit,
        cursor: hasMore ? encodeCursor({ o: nextOffset, k: filterKey }) : null,
      },
    };
  }

  private filter(
    params: Pick<
      ListDiscoveryResourcesParams,
      "type" | "payTo" | "scheme" | "network" | "extensions"
    >,
  ): DiscoveryResource[] {
    return [...this.entries.values()].filter((r) => {
      if (params.type && r.type !== params.type) return false;
      if (params.payTo && !r.accepts.some((a) => a.payTo === params.payTo)) return false;
      if (params.scheme && !r.accepts.some((a) => a.scheme === params.scheme)) return false;
      if (params.network && !r.accepts.some((a) => a.network === params.network)) return false;
      if (params.extensions && !(r.extensions && params.extensions in r.extensions)) return false;
      return true;
    });
  }

  private load(path: string): void {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as DiscoveryResource[];
      for (const entry of raw) this.entries.set(entry.resource, entry);
    } catch {
      // Missing or unreadable file: start empty. Corrupt persistence must
      // never prevent the facilitator from starting.
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify([...this.entries.values()], null, 2));
    } catch (err) {
      // Persistence is best-effort; the in-memory catalog stays authoritative.
      console.error("[catalog] persist failed:", err);
    }
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function scoreResource(resource: DiscoveryResource, tokens: string[]): number {
  if (tokens.length === 0) return 1; // empty query matches everything, unranked
  const fields: Array<[string, number]> = [
    [resource.serviceName ?? "", 4],
    [(resource.tags ?? []).join(" "), 3],
    [resource.description ?? "", 2],
    [resource.resource, 1],
  ];
  const mcpToolName =
    resource.type === "mcp" && typeof resource.extensions?.bazaar === "object"
      ? JSON.stringify(resource.extensions.bazaar)
      : "";
  if (mcpToolName) fields.push([mcpToolName, 1]);

  let score = 0;
  for (const [field, weight] of fields) {
    const haystack = field.toLowerCase();
    const words = new Set(tokenize(haystack));
    for (const token of tokens) {
      if (words.has(token)) score += weight * 2;
      else if (haystack.includes(token)) score += weight;
    }
  }
  return score;
}

function hashKey(params: SearchDiscoveryResourcesParams): string {
  const { query, type, payTo, scheme, network, extensions } = params;
  return createHash("sha256")
    .update(JSON.stringify({ query, type, payTo, scheme, network, extensions }))
    .digest("hex")
    .slice(0, 16);
}

function encodeCursor(cursor: { o: number; k: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): { o: number; k: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.o === "number" && typeof parsed?.k === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}
