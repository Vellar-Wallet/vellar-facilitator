import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { PaymentRequirements } from "@x402/core/types";
import type {
  DiscoveredResource,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
  SearchDiscoveryResourcesResponse,
} from "@x402/extensions/bazaar";
import type { TrustedDiscoveryResource } from "./trust.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Fix 4 (F1) — description is the one discovery field extractDiscoveryInfo does
// NOT bound (serviceName/tags/iconUrl/routeTemplate are sanitized upstream), and
// the raw extensions object is passed through wholesale. We defang both on the
// way into storage, and again on load, so a crafted CATALOG_FILE cannot bypass
// it. Control chars (\p{Cc}) and Unicode bidi/format chars (\p{Cf}) are stripped
// — the latter defeats RTL-override / homoglyph impersonation in agent context.
const MAX_DESCRIPTION_LEN = 256;
const CONTROL_AND_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** Clamp + strip a free-text description; returns undefined for empty/non-string. */
function sanitizeDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_AND_FORMAT, "").slice(0, MAX_DESCRIPTION_LEN);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Allowlist the extensions object to only the `bazaar` key (the one the
 * discovery flow and search actually consume). Everything else is dropped so it
 * can never reach an agent's context. */
function sanitizeExtensions(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const src = value as Record<string, unknown>;
  if (!("bazaar" in src)) return undefined;
  return { bazaar: src.bazaar };
}

// Fix 4/F6 — load-time schema. A crafted CATALOG_FILE is a trust boundary: the
// ingestion sanitizer never ran on it. Validate each entry's structure, drop the
// malformed rather than blind-casting, and (via sanitizeStoredResource below)
// strip any forged `trust` field and re-run the description/extensions sanitizer.
// The accepts payTo binding is still enforced separately in bindLoadedEntry.
const acceptSchema = z
  .object({ scheme: z.string(), network: z.string(), asset: z.string(), amount: z.string(), payTo: z.string() })
  .passthrough();

const storedResourceSchema = z
  .object({
    resource: z.string().min(1),
    type: z.string(),
    x402Version: z.number(),
    accepts: z.array(acceptSchema),
    lastUpdated: z.string(),
    description: z.unknown().optional(),
    mimeType: z.string().optional(),
    serviceName: z.string().optional(),
    tags: z.array(z.string()).optional(),
    iconUrl: z.string().optional(),
    extensions: z.unknown().optional(),
    // `trust` is deliberately NOT in the schema; .strip() below removes it.
  })
  .passthrough();

const statsSchema = z
  .object({
    settlements: z.number(),
    payers: z.array(z.string()),
    lastSettled: z.string().optional(),
  })
  .optional();

const storedEntrySchema = z.object({
  resource: storedResourceSchema,
  stats: statsSchema,
});

/** Normalize a validated stored resource: strip any forged `trust` field (trust
 * is computed at serve time, never stored) and re-run the ingestion sanitizer on
 * description/extensions so a crafted file gets the same defanging as the wire. */
function sanitizeStoredResource(res: z.infer<typeof storedResourceSchema>): DiscoveryResource {
  const { trust: _dropTrust, description, extensions, ...rest } = res as Record<string, unknown> & {
    resource: string;
  };
  const cleanDescription = sanitizeDescription(description);
  const cleanExtensions = sanitizeExtensions(extensions);
  return {
    ...(rest as unknown as DiscoveryResource),
    ...(cleanDescription !== undefined ? { description: cleanDescription } : {}),
    ...(cleanExtensions !== undefined ? { extensions: cleanExtensions } : {}),
  };
}

/**
 * The Bazaar catalog: discovered x402 resources, fed automatically from
 * payment traffic (see bazaar.ts) and served over /discovery/*.
 *
 * Storage is in-memory with optional JSON-file persistence (CATALOG_FILE) so
 * a single-instance deployment survives restarts. The store is behind this
 * class so a database can replace the file without touching routes/ingestion.
 */
/** Per-resource settlement ground truth — data only a facilitator has. */
interface SettlementStats {
  settlements: number;
  /** Distinct payer addresses (capped; uniquePayers reports the count). */
  payers: string[];
  lastSettled?: string;
}

interface StoredEntry {
  resource: DiscoveryResource;
  stats: SettlementStats;
  /**
   * Fix 0 Layer 1 (TOFU ownership binding). The set of payTo addresses bound to
   * this canonical resourceUrl. The first settlement to catalog a URL binds its
   * payTo here; only a settlement whose payTo is already in this set may append
   * a new accepts entry or overwrite metadata. This stops resource-URL hijack
   * (F11): an attacker cannot append their own payTo to, or overwrite the
   * metadata of, a resource someone else already established.
   *
   * LIMITATION — this binding is in-memory (and, when CATALOG_FILE is set,
   * persisted to disk). On the free tier the disk is ephemeral, so the whole
   * catalog — bindings included — empties on every redeploy/restart, and every
   * URL becomes claimable again by whoever settles first afterward. Layer 1 is
   * therefore a floor, not a real control, until durable storage exists; the
   * actual control is the Layer 2 402-challenge verification, which re-derives
   * ownership from the resource itself rather than from catalog history.
   */
  boundPayTo: string[];
  /**
   * Fix 0 Layer 2. True once the resource's own 402 challenge has confirmed the
   * bound payTo owns this URL. Until then the entry is served but its accepts
   * are NOT authoritative (Layer 3 surfaces this as an unverified owner). Default
   * false; a mismatch verdict keeps it false permanently for that binding.
   */
  verifiedOwner: boolean;
}

/** Cap on tracked distinct payers per resource — bounds memory and the
 * persistence file; the count saturates at the cap. */
const MAX_TRACKED_PAYERS = 10_000;

export class BazaarCatalog {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly persistPath: string | undefined;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath) this.load(persistPath);
  }

  /** Number of cataloged resources. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether `payTo` is bound to `resourceUrl` under the TOFU rule (Layer 1).
   * A settlement whose payTo is not bound may not append accepts or overwrite
   * metadata for that URL. */
  isBound(resourceUrl: string, payTo: string): boolean {
    return this.entries.get(resourceUrl)?.boundPayTo.includes(payTo) ?? false;
  }

  /** Whether the resource's own 402 challenge has confirmed its bound owner
   * (Fix 0 Layer 2). Consumers should treat an entry's accepts as authoritative
   * only when this is true. */
  isVerifiedOwner(resourceUrl: string): boolean {
    return this.entries.get(resourceUrl)?.verifiedOwner ?? false;
  }

  /** Record the Layer 2 402-challenge verdict for a URL. `match` marks the
   * bound owner verified; `mismatch`/`unverifiable` leave it unverified. No-op
   * if the entry vanished (e.g. restart) between settle and verification. */
  setVerifiedOwner(resourceUrl: string, verified: boolean): void {
    const entry = this.entries.get(resourceUrl);
    if (!entry) return;
    if (entry.verifiedOwner === verified) return;
    entry.verifiedOwner = verified;
    this.save();
  }

  /**
   * Insert or update a resource from a settled payment's discovery info.
   * `accepts` accumulates distinct payment requirements seen for the resource.
   *
   * Ownership rule (Fix 0 Layer 1): the FIRST settlement for a canonical URL
   * binds it to that payment's payTo. Any later settlement for the same URL is
   * honored only if its payTo is already bound; otherwise it is rejected and
   * logged, and the existing entry (accepts, metadata, and stats) is left
   * exactly as it was. This is what blocks the F11 hijack.
   *
   * Returns `true` when this call FIRST catalogs the URL (a new binding was
   * created), so the caller can trigger Layer 2 402-challenge verification. A
   * rejected or already-existing upsert returns `false`.
   */
  upsertFromPayment(discovered: DiscoveredResource, requirements: PaymentRequirements): boolean {
    const key = discovered.resourceUrl;
    const existing = this.entries.get(key);

    if (existing && !existing.boundPayTo.includes(requirements.payTo)) {
      // Unbound payTo for an already-established URL: reject the whole write.
      // Do not append accepts, do not overwrite metadata, do not touch stats.
      console.warn(
        `[catalog] rejected upsert for ${key}: payTo ${requirements.payTo} is not bound ` +
          `(bound: ${existing.boundPayTo.join(", ")}) — possible resource-URL hijack (F11)`,
      );
      return false;
    }

    const accepts = existing ? [...existing.resource.accepts] : [];
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

    // Fix 4: sanitize the two unbounded/passthrough fields on the way in.
    const description = sanitizeDescription(discovered.description);
    const extensions = sanitizeExtensions(discovered.extensions);
    const entry: DiscoveryResource = {
      resource: discovered.resourceUrl,
      type: discovered.discoveryInfo.input.type,
      x402Version: discovered.x402Version,
      accepts,
      lastUpdated: new Date().toISOString(),
      ...(description !== undefined ? { description } : {}),
      ...(discovered.mimeType !== undefined ? { mimeType: discovered.mimeType } : {}),
      ...(discovered.serviceName !== undefined ? { serviceName: discovered.serviceName } : {}),
      ...(discovered.tags !== undefined ? { tags: discovered.tags } : {}),
      ...(discovered.iconUrl !== undefined ? { iconUrl: discovered.iconUrl } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
    };
    // Bind the payTo on first settlement (TOFU); a bound update keeps the set.
    const isFirstCatalog = existing === undefined;
    const boundPayTo = existing ? existing.boundPayTo : [requirements.payTo];
    this.entries.set(key, {
      resource: entry,
      stats: existing?.stats ?? { settlements: 0, payers: [] },
      boundPayTo,
      verifiedOwner: existing?.verifiedOwner ?? false,
    });
    this.save();
    return isFirstCatalog;
  }

  /**
   * Record one settled payment against a cataloged resource (no-op for
   * unknown resources — stats exist only for catalog entries). Unique payers
   * are deduped and capped; the settlement count is unbounded.
   */
  recordSettlement(resourceUrl: string, payer?: string): void {
    const entry = this.entries.get(resourceUrl);
    if (!entry) return;
    entry.stats.settlements += 1;
    entry.stats.lastSettled = new Date().toISOString();
    if (
      payer &&
      entry.stats.payers.length < MAX_TRACKED_PAYERS &&
      !entry.stats.payers.includes(payer)
    ) {
      entry.stats.payers.push(payer);
    }
    this.save();
  }

  /** GET /discovery/resources — filtered, offset-paginated listing. Items are
   * the wire DiscoveryResource plus an additive `trust` stats block. */
  list(params: ListDiscoveryResourcesParams = {}): DiscoveryResourcesResponse {
    const limit = clampLimit(params.limit);
    const offset = Math.max(0, params.offset ?? 0);
    const matched = this.filter(params).map((entry) => toItem(entry));
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
      .map((entry) => ({ entry, score: scoreResource(entry.resource, tokens) }))
      .filter((s) => s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.resource.lastUpdated.localeCompare(a.entry.resource.lastUpdated),
      )
      .map((s) => toItem(s.entry));

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
  ): StoredEntry[] {
    return [...this.entries.values()].filter(({ resource: r }) => {
      if (params.type && r.type !== params.type) return false;
      if (params.payTo && !r.accepts.some((a) => a.payTo === params.payTo)) return false;
      if (params.scheme && !r.accepts.some((a) => a.scheme === params.scheme)) return false;
      if (params.network && !r.accepts.some((a) => a.network === params.network)) return false;
      if (params.extensions && !(r.extensions && params.extensions in r.extensions)) return false;
      return true;
    });
  }

  private load(path: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Missing or unreadable file: start empty. Corrupt persistence must
      // never prevent the facilitator from starting.
      return;
    }
    if (!Array.isArray(raw)) return;

    for (const item of raw) {
      // Accept both the current { resource, stats } shape and the pre-binding
      // bare-DiscoveryResource shape; validate, drop the malformed, sanitize.
      const candidate =
        item && typeof item === "object" && "stats" in item ? item : { resource: item };
      const parsed = storedEntrySchema.safeParse(candidate);
      if (!parsed.success) {
        console.warn(`[catalog] load: dropped a malformed entry (${parsed.error.issues[0]?.message ?? "invalid"})`);
        continue;
      }
      const parsedStats = parsed.data.stats;
      const stats: SettlementStats = parsedStats
        ? {
            settlements: parsedStats.settlements,
            payers: parsedStats.payers,
            ...(parsedStats.lastSettled !== undefined ? { lastSettled: parsedStats.lastSettled } : {}),
          }
        : { settlements: 0, payers: [] };
      const stored: StoredEntry = {
        resource: sanitizeStoredResource(parsed.data.resource),
        stats,
        boundPayTo: [],
        verifiedOwner: false,
      };
      this.entries.set(stored.resource.resource, this.bindLoadedEntry(stored));
    }
  }

  /**
   * Fix 0 Layer 1 enforcement at load time: a crafted CATALOG_FILE must not be
   * able to plant a hijacked entry the ingestion path would have rejected. The
   * owner is the payTo of the FIRST accepts entry (the TOFU winner); any later
   * accepts entry whose payTo differs is quarantined (dropped) rather than
   * served as authoritative. `boundPayTo` is re-derived from the surviving
   * accepts, never trusted from the file.
   */
  private bindLoadedEntry(stored: StoredEntry): StoredEntry {
    const accepts = stored.resource.accepts ?? [];
    const ownerPayTo = accepts[0]?.payTo;
    if (ownerPayTo === undefined) {
      return {
        ...stored,
        resource: { ...stored.resource, accepts: [] },
        boundPayTo: [],
        verifiedOwner: false,
      };
    }
    const kept = accepts.filter((a) => a.payTo === ownerPayTo);
    if (kept.length !== accepts.length) {
      console.warn(
        `[catalog] load: quarantined ${accepts.length - kept.length} accepts entry(ies) for ` +
          `${stored.resource.resource} with a payTo other than the bound owner ${ownerPayTo} (F11)`,
      );
    }
    return {
      resource: { ...stored.resource, accepts: kept },
      stats: stored.stats ?? { settlements: 0, payers: [] },
      boundPayTo: [ownerPayTo],
      // Never trust a stored verified flag — a crafted file could forge it.
      // Layer 2 re-verifies from the resource on the next settlement.
      verifiedOwner: false,
    };
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

/** Wire item: the resource plus its additive trust-stats block. Verification
 * verdicts are added later by the trust annotator (trust.ts). */
function toItem(entry: StoredEntry): TrustedDiscoveryResource {
  return {
    ...entry.resource,
    trust: {
      settlements: entry.stats.settlements,
      uniquePayers: entry.stats.payers.length,
      ...(entry.stats.lastSettled ? { lastSettled: entry.stats.lastSettled } : {}),
    },
  };
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
