import { createHash } from "node:crypto";
import { z } from "zod";
import {
  loadWithRetry,
  StoreInvalidError,
  type CatalogStore,
  type StoredEntryRow,
} from "./store.js";
import type { PaymentRequirements } from "@x402/core/types";
import type {
  DiscoveredResource,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
  SearchDiscoveryResourcesResponse,
} from "@x402/extensions/bazaar";
import { isIP } from "node:net";
import { isBlockedAddress } from "./ownership.js";
import type { OwnershipVerdict } from "./ownership.js";
import type { TrustedDiscoveryResource } from "./trust.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Cap on tracked distinct payers per resource — bounds memory and the
 * persistence file; the count saturates at the cap. Declared here because both
 * the write path and the load-time schema enforce it. */
const MAX_TRACKED_PAYERS = 10_000;

// F3 — bounds. Entry count and per-entry accepts were unbounded, and every
// settlement wrote the whole catalog synchronously (O(n) per settle, O(n^2) to
// fill). Measured stringify cost alone: ~72ms at 10k entries, ~316ms at 50k.
/** Max cataloged resources. LRU by lastUpdated beyond this. */
const MAX_ENTRIES = 10_000;
/** Max payment options stored per resource. */
const MAX_ACCEPTS = 20;
/** Max ownership tombstones. At this cap the catalog FREEZES new bindings
 * rather than forgetting ownership — see `frozen`. */
const MAX_TOMBSTONES = 100_000;
/** Longest string that can be a payTo identity. Shared by the catalog and the
 *  spend policy — see BazaarCatalog.canonicalPayTo. */
export const MAX_PAYTO_LEN = 128;
/** G-1 retry floors. A `mismatch` is a DEFINITE answer, so retrying it buys
 * nothing but outbound traffic — 24h makes it effectively terminal while still
 * self-healing after a legitimate operator rotation. An `unverifiable` is
 * UNCERTAIN (endpoint down, timeout, non-402), so it recovers far sooner. They
 * deliberately do not share a floor. These are the brake on amplification. */
const REVERIFY_COOLDOWN_MISMATCH_MS = 24 * 60 * 60 * 1000;
const REVERIFY_COOLDOWN_UNVERIFIABLE_MS = 15 * 60 * 1000;
const REVERIFY_COOLDOWN_TIMEOUT_MS = 60 * 1000;

/**
 * G-11 — path normalisation for the canonical key.
 *
 * THE PROBLEM. Two spellings of one resource are two catalog identities, and a
 * squatter only has to take the spelling its owner never settled against. Found
 * live on 2026-08-11: `…/quote` and `…/quote/` were separately bindable, and the
 * seller served a 402 at both. G-3 fixed the query-string instance of this; this
 * is the rest of the family.
 *
 * WHAT `new URL()` ALREADY DOES, measured rather than assumed — scheme case,
 * host case, default port (`:443` dropped), IDN → punycode, dot segments
 * (`/a/../b` → `/b`), userinfo, and the fragment. None of that is repeated here.
 *
 * WHAT THIS ADDS:
 *   1. trailing slash stripped (except root)   `/quote/`   -> `/quote`
 *   2. duplicate slashes collapsed             `//quote`   -> `/quote`
 *   3. percent-escapes uppercased              `%2f`       -> `%2F`
 *   4. unreserved escapes decoded              `/qu%6Fte`  -> `/quote`
 *
 * (3) and (4) are RFC 3986 §6.2.2 syntax-based normalisation: those spellings
 * are *defined* to be equivalent, so treating them as one key is not a policy
 * choice.
 *
 * (1) IS a policy choice, and a deliberate deviation. RFC 3986 says `/a` and
 * `/a/` are different resources. We merge them anyway, because the two failure
 * modes are not symmetric:
 *
 *   - Not merging lets a STRANGER hold the variant of someone else's URL. That
 *     is cross-party, and it is what was found live.
 *   - Merging can collide two genuinely distinct resources — but only within a
 *     single origin, so only ever a merchant colliding with themselves.
 *
 * A cross-party squat is worse than an intra-origin collision, and the second is
 * something one operator can fix in their own routing.
 *
 * THE COST, since it is not free: the canonical key is also the URL Layer 2
 * fetches. A server that serves ONLY `…/quote/` and 404s on `…/quote` becomes
 * unverifiable. `/health` reports `unverifiableEntries` for exactly this and
 * runbook §6 covers it — visible, not silent.
 *
 * WHAT IS DELIBERATELY *NOT* NORMALISED, because over-normalising merges
 * distinct resources and that is the same bug pointing the other way:
 *   - PATH CASE. Servers are case-sensitive; `/Quote` and `/quote` can be
 *     different endpoints. Merging them would let one merchant's binding cover
 *     another's URL.
 *   - INDEX FILES. `/docs/` and `/docs/index.html` are the same only on servers
 *     configured that way. We cannot know from here.
 *   - `www.` vs apex, and http vs https. Genuinely different origins — and http
 *     can never verify anyway (the SSRF guard rejects it before the socket).
 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export function normalizePath(pathname: string): string {
  // Percent-escapes: uppercase the hex, then decode the ones RFC 3986 says are
  // equivalent to their literal character. Decoding is limited to UNRESERVED —
  // decoding a reserved octet such as %2F would invent a path separator and turn
  // one segment into two.
  let out = pathname.replace(/%([0-9a-fA-F]{2})/g, (whole, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
  out = out.replace(/\/{2,}/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out === "" ? "/" : out;
}

/**
 * How long before this (url, claimant) may be probed again.
 *
 * The three verdicts are not the same event and must not share a cooldown:
 *
 *   mismatch      24h — the endpoint ANSWERED and named someone else. That is a
 *                       real claim about ownership and reads as a possible
 *                       takeover, so back off hard.
 *   unverifiable  15m — the endpoint answered badly. A real fault; give it time.
 *   timeout       60s — the endpoint did not answer in 3s, which on free-tier
 *                       hosting usually means asleep, not broken. Sharing the
 *                       15-minute cooldown is precisely why the demo's second
 *                       settlement 80 seconds later was silent: the first probe
 *                       timed out against a cold service and the retry was
 *                       locked out. 60s outlasts a cold start and still bounds
 *                       a permanently-dead endpoint to ~2 probes a minute, and
 *                       only while someone is paying to trigger them.
 */
function cooldownFor(verdict: OwnershipVerdict): number {
  if (verdict === "mismatch") return REVERIFY_COOLDOWN_MISMATCH_MS;
  if (verdict === "timeout") return REVERIFY_COOLDOWN_TIMEOUT_MS;
  return REVERIFY_COOLDOWN_UNVERIFIABLE_MS;
}

/** A catalog key derived from a client-declared routeTemplate, e.g.
 * `https://h/quote/:symbol`. Such a key is not a fetchable URL. */
function isTemplatedKey(key: string): boolean {
  try {
    const p = new URL(key).pathname;
    return p.includes(":") || p.includes("{");
  } catch {
    return false;
  }
}

/**
 * A catalog key Layer 2 can NEVER verify, decidable without DNS: the guard is
 * https-only, refuses loopback/private literals, and a routeTemplate key is not
 * a fetchable URL at all.
 *
 * This is deliberately distinct from "not verified yet". With
 * VERIFICATION_API_URL unset every entry already reads unverified, so that flag
 * carries no information — whereas this says the entry can never become
 * verified however long you wait. examples/seller.mjs advertising
 * `http://localhost:<port>` made ownership verification vacuous in production
 * for its entire life, and nothing surfaced it.
 */
function isStructurallyUnverifiable(key: string): boolean {
  try {
    const u = new URL(key);
    if (u.protocol !== "https:") return true;
    if (isTemplatedKey(key)) return true;
    if (u.hostname === "localhost") return true;
    // Bare IP literals only. isBlockedAddress fails CLOSED on anything that is
    // not a parseable IP, which is right where it guards a resolved address but
    // would flag every healthy hostname here — so gate it on isIP first.
    // Hostnames need DNS and are left to the live check, making this count a
    // LOWER BOUND: it never over-reports.
    if (isIP(u.hostname) !== 0 && isBlockedAddress(u.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

/** Debounce window for the (reconstructible) entry file. Ownership is never
 * debounced. */
const PERSIST_DEBOUNCE_MS = 250;

// writeFileAtomic (temp + fsync + rename) and ownershipPathFor are GONE. The
// atomicity they hand-rolled across two files is now a transaction across two
// tables, which is strictly stronger: the file version could still leave a
// binding written and its entry not, because "atomic per file" is not "atomic
// across files". See store.ts bindAndUpsertEntry.

/** Ownership file shape: validated on load exactly like the catalog file, so a
 * crafted file cannot inject a malformed or forged binding. NOTE: absence is
 * indistinguishable from deletion, so a file-writer can still CLEAR a tombstone
 * — see docs/security-audit.md (F6/RA-13). Forging is prevented; clearing is a
 * documented accepted risk pending the HMAC/DB fix. */
const ownershipFileSchema = z.array(
  z.object({ resource: z.string().min(1), boundPayTo: z.array(z.string().min(1)).min(1) }),
);

// Fix 4 (F1) — description is the one discovery field extractDiscoveryInfo does
// NOT bound (serviceName/tags/iconUrl/routeTemplate are sanitized upstream), and
// the raw extensions object is passed through wholesale. We defang both on the
// way into storage, and again on load, so a crafted CATALOG_FILE cannot bypass
// it. Control chars (\p{Cc}) and Unicode bidi/format chars (\p{Cf}) are stripped
// — the latter defeats RTL-override / homoglyph impersonation in agent context.
const MAX_DESCRIPTION_LEN = 256;
const CONTROL_AND_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** Keep only the known payment-requirement fields from a client-supplied
 * requirements object, so unknown keys never enter the catalog (ingest-side
 * counterpart of acceptSchema, which guards the load path). */
function pickAcceptFields(r: PaymentRequirements): PaymentRequirements {
  const src = r as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {
    scheme: src.scheme,
    network: src.network,
    asset: src.asset,
    amount: src.amount,
    payTo: src.payTo,
  };
  if (src.maxTimeoutSeconds !== undefined) out.maxTimeoutSeconds = src.maxTimeoutSeconds;
  if (src.extra !== undefined) out.extra = src.extra;
  return out as unknown as PaymentRequirements;
}

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

// Audit D5 — on the INGEST path the upstream extractor sanitizes serviceName /
// tags / iconUrl, but a crafted CATALOG_FILE bypasses the extractor entirely.
// Re-sanitize these on LOAD so stored prompt injection through them can't land.
const MAX_SERVICE_NAME_LEN = 64;
const MAX_TAG_LEN = 32;
const MAX_TAGS = 8;
const MAX_MIME_TYPE_LEN = 128;
/** The only protocol types the discovery model defines. `type` arrives from
 * attacker-controlled discoveryInfo and is both served to agents and used as a
 * filter key, so anything else is refused rather than stored as free text. */
const KNOWN_TYPES = new Set(["http", "mcp"]);
function sanitizeType(value: unknown): "http" | "mcp" | undefined {
  return typeof value === "string" && KNOWN_TYPES.has(value) ? (value as "http" | "mcp") : undefined;
}
/** Printable ASCII only — mirrors the upstream ingest validator. Anything else
 * (incl. Cyrillic/Greek homoglyphs used for brand impersonation) is rejected
 * outright rather than "cleaned", so the load path is not weaker than the wire. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** Documented limits, exported so their RATIONALE is assertable — see the
 * "module constants" block in src/config.thresholds.test.ts. Read-only. */
export const CATALOG_LIMITS = Object.freeze({
  maxEntries: MAX_ENTRIES,
  maxAccepts: MAX_ACCEPTS,
  maxTombstones: MAX_TOMBSTONES,
  maxTrackedPayers: MAX_TRACKED_PAYERS,
  persistDebounceMs: PERSIST_DEBOUNCE_MS,
  reverifyCooldownMismatchMs: REVERIFY_COOLDOWN_MISMATCH_MS,
  reverifyCooldownUnverifiableMs: REVERIFY_COOLDOWN_UNVERIFIABLE_MS,
  maxDescriptionLen: MAX_DESCRIPTION_LEN,
  maxServiceNameLen: MAX_SERVICE_NAME_LEN,
  maxTagLen: MAX_TAG_LEN,
  maxTags: MAX_TAGS,
  maxMimeTypeLen: MAX_MIME_TYPE_LEN,
  defaultLimit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
});


/**
 * Strip control/bidi chars, clamp, and require printable ASCII. Returns
 * undefined (field dropped) rather than a mangled string when the input isn't
 * clean — matching @x402/extensions' isValidServiceName/sanitizeTags behaviour,
 * so a crafted CATALOG_FILE gets exactly the treatment a wire payload gets.
 */
function sanitizeShortText(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_AND_FORMAT, "").slice(0, maxLen);
  if (cleaned.length === 0) return undefined;
  return PRINTABLE_ASCII.test(cleaned) ? cleaned : undefined;
}

function sanitizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const t of value) {
    const clean = sanitizeShortText(t, MAX_TAG_LEN);
    if (clean) out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Keep an iconUrl only if it is a well-formed http(s) URL — drops javascript:,
 * data:, and other schemes that could execute or exfiltrate in a consumer UI. */
function sanitizeIconUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  // Note: use a fresh non-global regex — CONTROL_AND_FORMAT has the /g flag and
  // .test() on a /g regex is stateful (advances lastIndex).
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    // Match the upstream ingest validator: no embedded credentials, and no
    // loopback / bare-IP / private hosts (an iconUrl is rendered by consumers,
    // so it must not point at internal infrastructure).
    if (u.username !== "" || u.password !== "") return undefined;
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // Same loopback set the upstream ingest validator rejects.
    const LOOPBACK_HOSTS = new Set([
      "localhost",
      "localhost.localdomain",
      "ip6-localhost",
      "ip6-loopback",
    ]);
    if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return undefined;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
      return undefined;
    }
    if (host.includes(":")) return undefined; // bare IPv6 literal
    return value;
  } catch {
    return undefined;
  }
}

// Fix 4/F6 — load-time schema. A crafted CATALOG_FILE is a trust boundary: the
// ingestion sanitizer never ran on it. Validate each entry's structure, drop the
// malformed rather than blind-casting, and (via sanitizeStoredResource below)
// strip any forged `trust` field and re-run the description/extensions sanitizer.
// The accepts payTo binding is still enforced separately in bindLoadedEntry.
// NOT .passthrough(): `accepts` entries come straight from the client-supplied
// /settle body, so arbitrary attacker-named keys inside a payment requirement
// would otherwise be stored and served to agents — the same injection channel as
// the resource-level passthrough, one level down. Zod strips unknown keys by
// default. `extra` is kept because the x402 scheme legitimately uses it.
const acceptSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().optional(),
  extra: z.unknown().optional(),
});

// NOT .passthrough(): zod strips unknown keys by default, which is exactly what
// we need. With passthrough, arbitrary attacker-named keys in a crafted
// CATALOG_FILE survived the schema and rode the rest-spread straight into the
// served entry (and into an agent's MCP context), bypassing every sanitizer.
// Stripping also removes any forged `trust` field for free.
const storedResourceSchema = z.object({
  resource: z.string().min(1),
  type: z.enum(["http", "mcp"]),
  x402Version: z.number(),
  accepts: z.array(acceptSchema),
  lastUpdated: z.string(),
  description: z.unknown().optional(),
  mimeType: z.unknown().optional(),
  serviceName: z.unknown().optional(),
  tags: z.unknown().optional(),
  iconUrl: z.unknown().optional(),
  extensions: z.unknown().optional(),
});

// Stats come from the persistence file, which is a trust boundary (F6): whoever
// can write CATALOG_FILE controls them, and we cannot re-derive settlement
// history from anywhere else — that is inherent to file-backed persistence and
// is documented as such. What we CAN do is refuse implausible values so a
// crafted file cannot exhaust memory or render nonsense: settlements must be a
// non-negative integer, and the payer list is capped at the same bound the write
// path enforces.
const statsSchema = z
  .object({
    settlements: z.number().int().nonnegative(),
    payers: z.array(z.string()).max(MAX_TRACKED_PAYERS),
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
  const {
    trust: _dropTrust,
    description,
    extensions,
    serviceName,
    tags,
    iconUrl,
    mimeType,
    ...rest
  } = res as Record<string, unknown> & { resource: string };
  // Audit D5: every free-text/URL field a crafted file could carry is
  // re-sanitized here, not just description/extensions.
  const cleanDescription = sanitizeDescription(description);
  const cleanExtensions = sanitizeExtensions(extensions);
  const cleanServiceName = sanitizeShortText(serviceName, MAX_SERVICE_NAME_LEN);
  const cleanTags = sanitizeTags(tags);
  const cleanIconUrl = sanitizeIconUrl(iconUrl);
  const cleanMimeType = sanitizeShortText(mimeType, MAX_MIME_TYPE_LEN);
  return {
    ...(rest as unknown as DiscoveryResource),
    ...(cleanDescription !== undefined ? { description: cleanDescription } : {}),
    ...(cleanExtensions !== undefined ? { extensions: cleanExtensions } : {}),
    ...(cleanServiceName !== undefined ? { serviceName: cleanServiceName } : {}),
    ...(cleanTags !== undefined ? { tags: cleanTags } : {}),
    ...(cleanIconUrl !== undefined ? { iconUrl: cleanIconUrl } : {}),
    ...(cleanMimeType !== undefined ? { mimeType: cleanMimeType } : {}),
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
  /**
   * Settlements this PROCESS actually witnessed. Deliberately NOT loaded from
   * CATALOG_FILE — it starts at zero on every load, so a tampered file cannot
   * inflate it. `settlements` may include a persisted base that no longer has
   * any independent source of truth; this number always has one.
   */
  observed: number;
  /** Distinct payer addresses (capped; uniquePayers reports the count). */
  payers: string[];
  lastSettled?: string;
}

interface StoredEntry {
  resource: DiscoveryResource;
  stats: SettlementStats;
  /**
   * O-7 — did these stats come from a previous process?
   *
   * Set on every load and never cleared, because a restored entry's baseline was
   * witnessed by nobody currently running, and no later settlement makes that
   * untrue. `statsSource` is derived from THIS rather than from
   * `settlements === observed`, which is the arithmetic it used to use.
   *
   * That arithmetic answered "was the inherited portion zero?", which is a
   * different question and gives the wrong answer in the case you actually meet:
   * a restored entry whose stored count is 0 satisfies `0 === 0` and was
   * therefore labelled "observed" — asserting this process witnessed every
   * settlement in the count, about an entry it had never seen. An entry reaches
   * a stored 0 while plainly having settled whenever the G-4 gate refuses stats
   * for an unbound payTo, so this is the live case, not a corner one.
   *
   * Deliberately conservative in one direction: a restored entry that inherited
   * 0 and then witnesses new settlements keeps reporting "persisted", even
   * though every settlement in that count was in fact observed. Under-claiming
   * provenance is the safe error; `observedSettlements` still carries the exact
   * number this process saw.
   *
   * It survives `flush()` as a field but is meaningless on disk: the load path
   * sets it unconditionally, so a crafted CATALOG_FILE cannot forge "observed".
   *
   * REQUIRED, not optional, on purpose. `bindLoadedEntry` rebuilds the entry
   * field by field rather than spreading it, and an optional flag there was
   * silently dropped — a loaded entry went straight back to reporting
   * "observed". Making it required turns that omission into a type error.
   */
  restored: boolean;
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


export class BazaarCatalog {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly store: CatalogStore | undefined;

  /**
   * F3 — ownership tombstones: `resourceUrl -> boundPayTo[]`, the record that
   * survives an entry being evicted. Without this, evicting an entry to enforce
   * the cap would DROP its ownership binding and reopen that URL to first-writer
   * claim — turning cache pressure into a way to re-run the F11 hijack.
   *
   * Written when the binding is ESTABLISHED, not when the entry is evicted, so
   * ownership is durable from the moment it exists rather than at the mercy of
   * whether an eviction write completed.
   */
  private readonly ownership = new Map<string, string[]>();

  /**
   * F3 fail-closed state. Set when the ownership store is unusable (missing or
   * unparseable while a catalog file loaded fine — the state a crafted file or a
   * half-finished deploy produces) or when the tombstone cap is reached. While
   * frozen, NO new URL may be bound; existing bindings keep working so
   * settlement is unaffected. Refusing new entries is a visible availability
   * problem; forgetting ownership is a silent security one.
   */
  private frozen: false | "ownership-unreachable" | "ownership-invalid" | "tombstone-cap" = false;
  /** G-1 verification scheduling state. In-memory ONLY: never persisted (RA-9)
   * and never on the wire (no attacker-forceable signal for consumers). */
  private readonly verifyState = new Map<string, { verdict: OwnershipVerdict; at: number }>();
  private readonly verifyInFlight = new Set<string>();
  /**
   * Keys whose binding has EVER been proven by Layer 2. Loaded from the durable
   * `ownership.verified_at`, not from the entry — see the schema note in
   * store.ts. This is the one-way latch that makes displacement safe: a binding
   * in this set can never be displaced, by anyone, ever.
   *
   * NOT `entry.verifiedOwner`. That flag is ephemeral by design (RA-9) and is
   * rebuilt as `false` after an eviction or a restart, so reading it here would
   * make eviction a downgrade primitive.
   */
  private readonly everVerified = new Set<string>();
  /** bound_at per key as loaded, used only to break ties when two stored keys
   *  normalise onto the same one. Not consulted after load. */
  private readonly loadedBoundAt = new Map<string, number>();
  /**
   * Displacement cooldowns, keyed by (url, payTo) rather than url.
   *
   * A per-URL key would let an attacker's failed attempt park the URL and block
   * the REAL owner's legitimate attempt for the whole cooldown — a cheap denial
   * of the recovery path, mounted by the same party the recovery exists to undo.
   * Per-claimant means an attacker can only ever rate-limit themselves.
   */
  private readonly displaceState = new Map<string, { verdict: OwnershipVerdict; at: number }>();
  private readonly displaceInFlight = new Set<string>();
  // G-7's `ownershipSeededDuringLoad` flag is GONE along with the bootstrap
  // hatch. The hatch existed only because an ownership FILE could be absent
  // while a catalog FILE was present — an ambiguity between "first upgrade" and
  // "someone deleted it". One database cannot be half-present, so the ambiguity,
  // the hatch, and CATALOG_OWNERSHIP_BOOTSTRAP all cease to exist.
  /** URLs already warned about, so the log fires once per resource rather than
   * once per settlement. */
  private readonly warnedUnverifiable = new Set<string>();

  constructor(store?: CatalogStore) {
    this.store = store;
  }

  /**
   * Build a catalog, loading durable state first. Async because the store is a
   * network call; `buildServer` is already async and there is one production
   * call site.
   *
   * FAIL-CLOSED, KEPT. If ownership cannot be loaded the catalog stays EMPTY and
   * frozen. Serving entries whose bindings did not load means serving entries
   * with no enforceable ownership — every URL open to first-writer claim, which
   * is F11 disabled at exactly the moment nobody is watching. Discovery going
   * quiet is recoverable; discovery serving attacker-claimable entries is not.
   *
   * What changed from the file store is the DIAGNOSIS, not the default:
   * unreachable is retried with backoff and reported as retryable; invalid
   * freezes immediately and says so.
   */
  static async create(store?: CatalogStore, opts: { maxEntries?: number } = {}): Promise<BazaarCatalog> {
    const catalog = new BazaarCatalog(store);
    if (!store) return catalog;
    await store.init();
    // Ownership loads FIRST: if it is unusable we must not serve a catalog whose
    // bindings are missing.
    let bindings;
    try {
      bindings = await loadWithRetry(() => store.loadOwnership());
    } catch (err) {
      catalog.frozen = err instanceof StoreInvalidError ? "ownership-invalid" : "ownership-unreachable";
      console.error(
        `[catalog] ownership could not be loaded (${catalog.frozen}) — refusing to load the catalog and ` +
          `freezing new bindings. Serving entries whose ownership did not load would reopen every URL to ` +
          `first-writer claim. ${
            catalog.frozen === "ownership-unreachable"
              ? "The store was unreachable after retries: this is usually transient, and a restart once it " +
                "answers is the whole fix."
              : "The store ANSWERED with something unusable: do not restart in a loop, investigate the data."
          } Cause: ${String((err as Error)?.message ?? err)}`,
      );
      return catalog; // empty + frozen
    }
    // RE-CANONICALISE ON LOAD. The stored `resource_key` is whatever the
    // canonicaliser produced when the row was written, and that function has now
    // changed twice (G-3 stripped the query string, G-11 the rest of the family).
    // A row written under an older scheme would otherwise keep a key nothing can
    // ever produce again — and the danger is not that it looks empty, it is that
    // the key it collapses TO may be unbound, leaving a real merchant's URL
    // claimable by the next settler.
    //
    // Doing it here rather than as a one-off SQL migration means the same is true
    // for the NEXT change to the function: there is no version to remember.
    for (const b of bindings) {
      const key = BazaarCatalog.canonicalResourceKey(b.resourceKey);
      const existing = catalog.ownership.get(key);
      if (!existing) {
        catalog.ownership.set(key, b.boundPayTo);
        catalog.loadedBoundAt.set(key, b.boundAt ?? 0);
        if (b.everVerified) catalog.everVerified.add(key);
        continue;
      }
      // Two stored keys collapsed onto one. Pick a winner — NEVER union the
      // payTos, which would hand a squatter a claim on the survivor's key.
      //
      //   1. proof wins. Never downgrade a binding that was verified.
      //   2. then the row already stored under the canonical spelling.
      //   3. then the earliest bound_at — the TOFU winner under the old scheme.
      const incomingVerified = b.everVerified === true;
      const existingVerified = catalog.everVerified.has(key);
      const incomingWins =
        incomingVerified !== existingVerified
          ? incomingVerified
          : b.resourceKey === key
            ? true
            : (b.boundAt ?? 0) < (catalog.loadedBoundAt.get(key) ?? 0);
      console.warn(
        `[catalog] load: "${b.resourceKey}" normalises to "${key}", which is already bound. Keeping ` +
          `${incomingWins ? b.boundPayTo.join(",") : (existing ?? []).join(",")} ` +
          `(${incomingVerified || existingVerified ? "verified binding wins" : "earliest/canonical wins"}). ` +
          `The other binding is DROPPED — it was a second spelling of one resource (G-11).`,
      );
      if (incomingWins) {
        catalog.ownership.set(key, b.boundPayTo);
        catalog.loadedBoundAt.set(key, b.boundAt ?? 0);
      }
      if (incomingVerified || existingVerified) catalog.everVerified.add(key);
    }
    await catalog.load(opts.maxEntries ?? MAX_ENTRIES);
    return catalog;
  }

  /** Whether new URL bindings are currently refused, and why (see /health). */
  get catalogFrozen(): false | "ownership-unreachable" | "ownership-invalid" | "tombstone-cap" {
    return this.frozen;
  }

  /** Number of cataloged resources. */
  /** Entries whose URL can NEVER pass Layer 2 (see isStructurallyUnverifiable).
   * Surfaced on /health: a non-zero value means those sellers are advertising an
   * address the facilitator cannot reach, not that verification is pending. */
  get unverifiableCount(): number {
    let n = 0;
    for (const key of this.entries.keys()) if (isStructurallyUnverifiable(key)) n++;
    return n;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Whether `payTo` is bound to `resourceUrl` under the TOFU rule (Layer 1).
   * A settlement whose payTo is not bound may not append accepts or overwrite
   * metadata for that URL. */
  isBound(resourceUrl: string, payTo: string): boolean {
    return this.entries.get(BazaarCatalog.canonicalResourceKey(resourceUrl))?.boundPayTo.includes(payTo) ?? false;
  }

  /**
   * G-3: the catalog is keyed on the CANONICAL resource url that
   * `extractDiscoveryInfo` derives — `origin + pathname`, query and fragment
   * stripped. Callers holding a RAW payload url (notably `/settle`, which reads
   * `paymentPayload.resource.url`) must go through this, or a merchant whose
   * resource carries a query string reads as unbound on every settle.
   *
   * Kept here rather than in the route on purpose: the route re-deriving the key
   * is precisely how the two drifted apart.
   *
   * Degrades to the raw string on an unparseable url — this is client-supplied,
   * so it must not throw, and a non-url simply cannot match a binding.
   */
  /**
   * The ONE derivation of a payTo identity.
   *
   * G-11's real finding was not the trailing slash, it was that one identity had
   * two derivations that agreed only by luck. payTo was the same shape: the
   * spend policy trimmed it and capped it at 128 chars (`policyBucketKey`, added
   * to stop attacker-minted buckets), while the catalog compared the raw string
   * — so `"G… "` and `"G…"` were ONE rate-limit bucket and TWO catalog
   * identities.
   *
   * That is a hijack variant, not a curiosity: a padded copy of a victim's
   * address binds a URL to something that renders identically in
   * `/discovery/resources` while the victim's own clean address is "not bound"
   * and locked out forever.
   *
   * Returns undefined for anything that cannot be an identity. Callers decide
   * what that means — the policy collapses it into one shared bucket, the
   * catalog refuses the upsert — but they no longer decide what the identity IS.
   */
  static canonicalPayTo(payTo: unknown): string | undefined {
    if (typeof payTo !== "string") return undefined;
    const trimmed = payTo.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PAYTO_LEN) return undefined;
    return trimmed;
  }

  static canonicalResourceKey(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      return `${u.origin}${normalizePath(u.pathname)}`;
    } catch {
      return rawUrl;
    }
  }

  /** `isBound`, but accepting a raw payload url. Prefer this at trust
   * boundaries; `isBound` assumes the caller already holds a canonical key. */
  isBoundResource(rawResourceUrl: string, payTo: string): boolean {
    return this.isBound(BazaarCatalog.canonicalResourceKey(rawResourceUrl), payTo);
  }

  /**
   * G-1: re-run Layer 2 for an already-cataloged resource.
   *
   * `verifiedOwner` is never trusted from disk (RA-9), and Layer 2 used to fire
   * only on first catalog, so a restored entry stayed unverified forever and
   * `verified_only=true` served an empty catalog. This is the path
   * `bindLoadedEntry` always claimed existed.
   *
   * The catalog owns this rather than exposing the binding, because
   * `entry.boundPayTo` IS the ownership tombstone array — handing it out would
   * put a durable rebinding primitive one `.push()` away. The verifier receives
   * a COPY.
   *
   * Every gate below exists to bound outbound traffic. The settling payTo must
   * already be bound, so a stranger cannot make the facilitator fetch a URL;
   * note this is 1:1, not zero — under TOFU the bound owner is the first
   * settler, not necessarily whoever controls the endpoint — which is exactly
   * why the cooldowns, not the gate, are the real brake.
   *
   * Verdicts: `match` verifies; `mismatch` is a DEFINITE denial and parks the
   * URL for 24h; `unverifiable` is UNCERTAIN and never downgrades an existing
   * verification, retrying after 15min. No verdict ever touches a binding.
   *
   * State is in-memory only — never persisted (RA-9 stays closed) and never on
   * the wire (nothing an attacker can force onto a victim's entry).
   */
  async reverify(
    rawResourceUrl: string,
    settlingPayTo: string,
    verify: (url: string, payTos: string[]) => Promise<OwnershipVerdict>,
    now: number = Date.now(),
  ): Promise<OwnershipVerdict | "skipped"> {
    const key = BazaarCatalog.canonicalResourceKey(rawResourceUrl);
    const entry = this.entries.get(key);

    /** Same contract as tryDisplace's: a silent skip is an undiagnosable one.
     *  This is the path that flips `ownerVerified`, so "the badge did not
     *  change and nothing said why" is the exact question an operator arrives
     *  with. The two benign, per-settlement cases stay quiet — see below. */
    const skip = (reason: string): "skipped" => {
      console.warn(`[catalog] reverify skipped for ${key} (settler ${settlingPayTo || "<empty>"}): ${reason}`);
      return "skipped";
    };

    if (!entry) return skip("no catalog entry for this key");
    // Already verified: nothing to re-establish, and re-probing a good entry is
    // pure outbound traffic. This is also what makes an existing verification
    // undowngradable — the verifier is never consulted again — so the
    // match-only write below can only ever act on an unverified entry.
    //
    // NOT LOGGED: fires on every settlement for every healthy entry, which is
    // the steady state we want, and a line per payment would drown the rest.
    if (entry.verifiedOwner) return "skipped";
    // An entry that binds to nothing (bindLoadedEntry's empty-accepts branch)
    // has no claim to test — asking would read back a false mismatch. Checked
    // BEFORE the bound-owner gate: that gate would reject an empty binding too,
    // which would make this line dead code that merely looks load-bearing.
    if (entry.boundPayTo.length === 0)
      return skip("binding is empty — tampered or unbound state, nothing to test");
    // Only the bound owner's own settlement may trigger a probe. Note this is
    // 1:1, not zero: under TOFU the bound owner is the FIRST SETTLER, not
    // necessarily whoever controls the endpoint, so a stranger who bound a
    // victim's URL can still cause one probe per settlement. The cooldowns
    // below, not this gate, are the actual brake.
    //
    // NOT LOGGED: this is the mirror of tryDisplace's already-bound skip. An
    // unbound settler lands here on every claim attempt, and tryDisplace
    // already logs that same event with more detail.
    if (!settlingPayTo || !entry.boundPayTo.includes(settlingPayTo)) return "skipped";
    // A routeTemplate key is `origin + /quote/:symbol`; fetching it would GET a
    // literal `:symbol`. Structurally unverifiable, so never probe it.
    if (isTemplatedKey(key)) return skip("templated key — structurally unverifiable, never probed");
    if (this.verifyInFlight.has(key)) return skip("a probe for this key is already in flight");

    const last = this.verifyState.get(key);
    if (last && now - last.at < cooldownFor(last.verdict)) {
      const remainingMs = cooldownFor(last.verdict) - (now - last.at);
      return skip(
        `cooling down after a previous "${last.verdict}" verdict — ${Math.ceil(remainingMs / 1000)}s remaining`,
      );
    }

    this.verifyInFlight.add(key);
    try {
      // Copy: the verifier must never receive the tombstone array itself.
      const verdict = await verify(key, [...entry.boundPayTo]);
      this.verifyState.set(key, { verdict, at: now });
      if (verdict === "match") {
        this.setVerifiedOwner(key, true);
        // Latch it DURABLY too. The badge above is ephemeral by design; this is
        // what stops the binding being displaced after the next eviction or
        // restart, when the badge will read false again.
        await this.latchVerified(key, settlingPayTo);
      } else if (verdict === "mismatch") {
        console.warn(
          `[catalog] ownership MISMATCH on re-verify for ${key}: the resource's 402 challenge no longer ` +
            `names its bound owner. Left UNVERIFIED; binding unchanged. This reads the same as a merchant ` +
            `who rotated and as a domain that changed hands — see docs/operator-runbook.md §1 (G-1/G-2).`,
        );
      }
      return verdict;
    } catch {
      // A hostile or broken verifier is uncertainty, not a denial.
      this.verifyState.set(key, { verdict: "unverifiable", at: now });
      return "unverifiable";
    } finally {
      this.verifyInFlight.delete(key);
    }
  }

  /** Boot-time re-proof probes still unresolved. Surfaced on /health so the
   *  post-restart proven-unconfirmed window is observable rather than
   *  mysterious — a reviewer who sees a gray badge and checks /health can see
   *  a probe is in flight instead of wondering what is broken. 0 whenever no
   *  boot pass is running. */
  private bootReverifyPending = 0;

  get reverifyPending(): number {
    return this.bootReverifyPending;
  }

  /**
   * Boot-time re-proof of durable latches.
   *
   * The badge (`verifiedOwner`) is per-process BY DESIGN and rebuilds as false
   * on every restart; only the latch (`everVerified`) is durable. On the free
   * tier that turned every spin-down into a gray badge until the owner's next
   * settlement (runbook §1, "Standing caveat — the badge resets on every
   * restart"). This pass runs the SAME probe reverify() runs — same SSRF
   * guards, same ownership.ts path — for every entry that HAS the durable
   * latch but not the badge, and flips the badge on a match.
   *
   * Relationship to "settle-triggered ONLY, no prober" (the design recorded in
   * catalog.reverify.test.ts): that decision refuses to GRANT verification
   * without a contemporaneous payment, and it stands untouched — this pass
   * cannot verify anything for the first time, because `everVerified` is only
   * ever set by a settlement-triggered proof. It re-establishes the DISPLAY of
   * a proof that was already earned, and the resource can still refuse it (a
   * mismatch leaves the honest proven-unconfirmed state). RA-9 also stands:
   * nothing here trusts a stored badge — the probe re-fetches the live 402.
   *
   * Deliberately NOT awaited by boot: the prober's cold-start retry ladder can
   * run minutes against a sleeping seller, and a reviewer's first request must
   * never wait on it — which is the whole reason this fires after listen().
   * The durable re-latch is SKIPPED on match: `everVerified` already holds for
   * every candidate (it is the admission criterion), so the write would be a
   * pointless store update on every restart.
   */
  async reverifyLatchedAtBoot(
    verify: (url: string, payTos: string[]) => Promise<OwnershipVerdict>,
    concurrency = 3,
    nowFn: () => number = Date.now,
  ): Promise<void> {
    const candidates: string[] = [];
    for (const [key, entry] of this.entries) {
      if (!this.everVerified.has(key)) continue; // never proven — out of scope, see above
      if (entry.verifiedOwner) continue; // badge already up in this process
      if (entry.boundPayTo.length === 0) continue; // nothing to test
      if (isTemplatedKey(key)) continue; // would GET a literal `:param`
      if (this.verifyInFlight.has(key)) continue;
      candidates.push(key);
    }
    if (candidates.length === 0) return;
    this.bootReverifyPending = candidates.length;
    console.warn(
      `[boot] re-proving ${candidates.length} latched binding(s) — the badge is per-process, the latch is durable`,
    );

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= candidates.length) return;
        const key = candidates[i]!;
        try {
          const entry = this.entries.get(key);
          if (!entry || entry.verifiedOwner || this.verifyInFlight.has(key)) continue;
          this.verifyInFlight.add(key);
          try {
            const verdict = await verify(key, [...entry.boundPayTo]);
            this.verifyState.set(key, { verdict, at: nowFn() });
            if (verdict === "match") {
              this.setVerifiedOwner(key, true);
              console.warn(`[boot] re-proved ${key} — badge restored to verified`);
            } else {
              console.warn(
                `[boot] re-proof for ${key} returned "${verdict}" — left proven-unconfirmed (honest)`,
              );
            }
          } finally {
            this.verifyInFlight.delete(key);
          }
        } catch (err) {
          console.warn(
            `[boot] re-proof for ${key} failed: ${String((err as Error)?.message ?? err)} — left proven-unconfirmed`,
          );
        } finally {
          this.bootReverifyPending--;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(concurrency, candidates.length)) }, worker),
    );
  }

  /** Whether the resource's own 402 challenge has confirmed its bound owner
   * (Fix 0 Layer 2). Consumers should treat an entry's accepts as authoritative
   * only when this is true. */
  isVerifiedOwner(resourceUrl: string): boolean {
    return this.entries.get(BazaarCatalog.canonicalResourceKey(resourceUrl))?.verifiedOwner ?? false;
  }

  /** TEST ONLY — drop an entry the way evictToCap does, keeping ownership. The
   *  eviction path is otherwise only reachable by filling the catalog to
   *  MAX_ENTRIES, which a unit test cannot afford, and the interaction between
   *  eviction and displaceability is exactly what must be asserted. */
  evictForTest(resourceUrl: string): void {
    this.entries.delete(BazaarCatalog.canonicalResourceKey(resourceUrl));
  }

  /** True when this URL's binding has ever been proven, and is therefore not
   *  displaceable. Durable; survives eviction and restart. */
  isEverVerified(resourceUrl: string): boolean {
    return this.everVerified.has(BazaarCatalog.canonicalResourceKey(resourceUrl));
  }

  /** Latch a proven binding as permanently non-displaceable. In-memory first so
   *  the guarantee holds even if the store write fails — the failure mode we
   *  accept here is a binding that is MORE protected than the row says, never
   *  less. (bindOwnership takes the opposite trade for the opposite reason: an
   *  unpersisted binding must not be treated as established.) */
  private async latchVerified(key: string, payTo: string): Promise<void> {
    this.everVerified.add(key);
    if (!this.store) return;
    try {
      await this.store.markVerified(key, payTo, Date.now());
    } catch (err) {
      console.error(
        `[catalog] could not persist the verified latch for ${key} — it holds for this process, but a ` +
          `restart will reopen the binding to displacement until the owner settles again: ${String(
            (err as Error)?.message ?? err,
          )}`,
      );
    }
  }

  /**
   * G-2 displacement — the ONLY path by which a bound URL changes hands without
   * an operator.
   *
   * THE RULE: a claimant who PROVES ownership (their payTo appears in the
   * resource's own 402 challenge) displaces a binding that was never proven.
   * Unverified → verified only.
   *
   * This is proof-beats-no-proof, NOT proof-beats-proof. An unverified binding
   * is arrival order — whoever settled first — which is not evidence of
   * anything. A verified binding IS evidence, and stays put: the takeover case
   * refused as 2C is still refused, because no amount of proof displaces proof.
   *
   * Fires from onAfterSettle, fire-and-forget, for the same reason G-1 does:
   * settlement must never wait on, nor fail because of, a merchant's endpoint.
   * So the settle that TRIGGERS a displacement is still refused by
   * upsertFromPayment (the claimant is not yet bound); the rebinding lands
   * moments later and their next settlement is accepted normally. Displacement
   * recovers the URL, it does not retroactively accept the payment that
   * revealed the problem.
   */
  async tryDisplace(
    rawResourceUrl: string,
    claimant: string,
    requirements: PaymentRequirements,
    discovered: DiscoveredResource,
    verify: (url: string, payTos: string[]) => Promise<OwnershipVerdict>,
    now: number = Date.now(),
  ): Promise<"displaced" | "refused" | "skipped"> {
    const key = BazaarCatalog.canonicalResourceKey(rawResourceUrl);
    const entry = this.entries.get(key);
    /**
     * EVERY EXIT SAYS WHY.
     *
     * Eight guards used to return a bare "skipped", which made a displacement
     * that silently did not happen undiagnosable from outside the process. That
     * is the same defect as `settle` collapsing every submission failure into
     * one constant `errorReason` (docs/diagnosis-settle-failures.md) — and it
     * bit us inside the control built to prevent squatting: two live
     * settlements against a real stale binding recovered nothing, and every
     * candidate cause had to be excluded by reading source rather than a log.
     * See docs/diagnosis-demo-listing.md.
     */
    const outcome = (result: "skipped" | "refused", reason: string): "skipped" | "refused" => {
      console.warn(
        `[catalog] displacement ${result} for ${key} (claimant ${claimant || "<empty>"}): ${reason}`,
      );
      return result;
    };

    // No entry: this is a first catalog, which TOFU handles. Nothing to displace.
    if (!entry) return outcome("skipped", "no catalog entry for this key — first catalog, TOFU handles it");
    if (!claimant) return outcome("skipped", "settlement carried no payTo to claim with");
    // Already bound: an ordinary settlement, not a claim. DELIBERATELY NOT
    // LOGGED — bazaar.ts calls this on every settle, so the bound owner's own
    // payments arrive here every time. A line per payment would bury the
    // outcomes that matter under the one that never does.
    if (entry.boundPayTo.includes(claimant)) return "skipped";
    // THE ONE-WAY GATE. Read from the durable latch, never from the badge.
    if (this.everVerified.has(key))
      return outcome("skipped", "binding was PROVEN once and is permanently non-displaceable (one-way latch)");
    // An empty binding has no claimant to displace and no proof to weigh; it is
    // the tampered state bindLoadedEntry warns about, not a live URL.
    if (entry.boundPayTo.length === 0)
      return outcome("skipped", "binding is empty — tampered or unbound state, not a live URL");
    // A templated key would GET a literal `:symbol`. Never probe it.
    if (isTemplatedKey(key)) return outcome("skipped", "templated key — never probed");
    // A frozen catalog must not rebind anything.
    if (this.frozen === "ownership-unreachable" || this.frozen === "ownership-invalid")
      return outcome("skipped", `catalog is frozen (${this.frozen}) — rebinding refused`);

    const cooldownKey = `${key}\u0000${claimant}`;
    if (this.displaceInFlight.has(cooldownKey))
      return outcome("skipped", "a probe for this (url, claimant) is already in flight");
    const last = this.displaceState.get(cooldownKey);
    if (last && now - last.at < cooldownFor(last.verdict)) {
      const remainingMs = cooldownFor(last.verdict) - (now - last.at);
      return outcome(
        "skipped",
        `cooling down after a previous "${last.verdict}" verdict — ${Math.ceil(remainingMs / 1000)}s remaining`,
      );
    }

    this.displaceInFlight.add(cooldownKey);
    let verdict: OwnershipVerdict;
    try {
      // Probe for the CLAIMANT's address alone. Passing the bound set would ask
      // "does this endpoint name anyone we know", which a squatter's own
      // endpoint could answer yes to.
      verdict = await verify(key, [claimant]);
    } catch (err) {
      this.displaceState.set(cooldownKey, { verdict: "unverifiable", at: now });
      return outcome(
        "refused",
        `the ownership probe threw — ${String((err as Error)?.message ?? err)}`,
      );
    } finally {
      this.displaceInFlight.delete(cooldownKey);
    }
    this.displaceState.set(cooldownKey, { verdict, at: now });
    if (verdict !== "match")
      return outcome(
        "refused",
        `the resource's own 402 challenge did not name the claimant (verdict "${verdict}")`,
      );

    // Re-check the latch: the probe was awaited, and a concurrent re-verify may
    // have proven the incumbent while we were off the CPU. Losing that race
    // would displace a binding that had become non-displaceable mid-flight.
    if (this.everVerified.has(key))
      return outcome("skipped", "incumbent was proven by a concurrent re-verify while the probe was in flight");

    const displaced = [...entry.boundPayTo];
    if (this.store) {
      try {
        await this.store.displaceOwnership(key, claimant, now);
      } catch (err) {
        console.error(
          `[catalog] displacement write FAILED for ${key} — binding UNCHANGED: ${String(
            (err as Error)?.message ?? err,
          )}`,
        );
        return "refused";
      }
    }
    this.ownership.set(key, [claimant]);
    this.everVerified.add(key);

    // STATS ARE RESET, not inherited.
    //
    // The trust block answers "what is this merchant's history", and after a
    // displacement the merchant is a DIFFERENT PARTY. Carrying the squatter's
    // counters over would hand the real owner a reputation they did not earn
    // and consumers a number that describes someone else's activity — the exact
    // dishonesty RA-13 exists to avoid, except self-inflicted rather than
    // merely unverifiable. Dropping the entry and re-ingesting through the
    // normal validated path is what performs the reset: stats start at zero,
    // and `accepts` is rebuilt from the claimant's own requirements instead of
    // being filtered out of the squatter's.
    this.entries.delete(key);
    await this.upsertFromPayment(discovered, requirements);
    this.setVerifiedOwner(key, true);
    console.warn(
      `[catalog] DISPLACED ${key}: ${displaced.join(", ")} -> ${claimant}. The previous binding was never ` +
        `verified; the new one proved ownership through the resource's own 402 challenge and is now ` +
        `permanently non-displaceable. Settlement stats were RESET — they described the previous binding.`,
    );
    return "displaced";
  }

  /** Record the Layer 2 402-challenge verdict for a URL. `match` marks the
   * bound owner verified; `mismatch`/`unverifiable` leave it unverified. No-op
   * if the entry vanished (e.g. restart) between settle and verification. */
  setVerifiedOwner(resourceUrl: string, verified: boolean): void {
    const entry = this.entries.get(BazaarCatalog.canonicalResourceKey(resourceUrl));
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
  async upsertFromPayment(
    discovered: DiscoveredResource,
    requirements: PaymentRequirements,
  ): Promise<boolean> {
    // CANONICAL, not raw. This line keyed the entry map on the merchant's
    // ADVERTISED spelling while recordSettlement, isBoundResource and the spend
    // policy all keyed on the canonical form — so they agreed only while the two
    // happened to be identical, which is exactly what the demo seller made true
    // by reporting one stable URL. G-3 fixed the policy side of that split and
    // this side was left behind; G-11 is what surfaced it, because a second
    // spelling is precisely when raw and canonical diverge.
    const key = BazaarCatalog.canonicalResourceKey(discovered.resourceUrl);
    const existing = this.entries.get(key);

    // One derivation, shared with the spend policy. An unusable payTo is refused
    // outright rather than bound: a binding nobody can ever match is a URL
    // permanently removed from its owner.
    const payTo = BazaarCatalog.canonicalPayTo(requirements.payTo);
    if (payTo === undefined) {
      console.warn(
        `[catalog] rejected upsert for ${key}: payTo is not a usable identity ` +
          `(non-string, empty, or over ${MAX_PAYTO_LEN} chars)`,
      );
      return false;
    }
    requirements = { ...requirements, payTo };

    // F3: an evicted entry leaves its ownership tombstone behind, so a URL that
    // was cached out cannot be reclaimed by a different payTo. This is what stops
    // cache pressure from becoming a way to re-run the F11 hijack.
    const tomb = this.ownership.get(key);
    if (!existing && tomb && !tomb.includes(requirements.payTo)) {
      console.warn(
        `[catalog] rejected upsert for ${key}: payTo ${requirements.payTo} does not match the ` +
          `ownership tombstone (${tomb.join(", ")}) — evicted-entry reclaim refused (F3/F11)`,
      );
      return false;
    }
    if (existing && !existing.boundPayTo.includes(requirements.payTo)) {
      // Unbound payTo for an already-established URL: reject the whole write.
      // Do not append accepts, do not overwrite metadata, do not touch stats.
      // WORDING MATTERS HERE. This said "possible resource-URL hijack" alone,
      // which is accurate about the mechanism and misleading about the
      // situation: the same line fires for the LEGITIMATE owner, because the
      // settle that triggers a displacement is refused by design while the
      // rebinding lands behind it. An operator meeting this line first
      // concludes they are under attack, when the real event may be that
      // displacement did not run. Observed 2026-08-14 — this line appeared
      // twice for the demo's own merchant.
      console.warn(
        `[catalog] rejected upsert for ${key}: payTo ${requirements.payTo} is not bound ` +
          `(bound: ${existing.boundPayTo.join(", ")}). This is EXPECTED for the settle that ` +
          `triggers a displacement, and is also what a hijack attempt looks like — the two are ` +
          `indistinguishable here. Read the "[catalog] displacement …" line for this key to tell ` +
          `them apart before treating it as an attack (F11)`,
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
    // Store only the known payment-requirement fields. `requirements` is the
    // client-supplied /settle body, so pushing it whole would carry arbitrary
    // attacker-named keys into the catalog and out to agents.
    if (!seen && accepts.length >= MAX_ACCEPTS) {
      console.warn(`[catalog] ${key}: accepts cap (${MAX_ACCEPTS}) reached — new payment option dropped`);
    } else if (!seen) {
      accepts.push(pickAcceptFields(requirements));
    }

    // Fix 4: ONE funnel for both doors. Rather than re-implement the sanitizers
    // inline (which drifted from the load path three times — mimeType, then
    // serviceName/tags, then type), build the raw entry and push it through the
    // SAME storedResourceSchema + sanitizeStoredResource that load() uses. Drift
    // is now structurally impossible: there is only one implementation.
    const rawEntry = {
      resource: discovered.resourceUrl,
      type: discovered.discoveryInfo?.input?.type,
      x402Version: discovered.x402Version,
      accepts,
      lastUpdated: new Date().toISOString(),
      description: discovered.description,
      mimeType: discovered.mimeType,
      serviceName: discovered.serviceName,
      tags: discovered.tags,
      iconUrl: discovered.iconUrl,
      extensions: discovered.extensions,
    };
    const parsed = storedResourceSchema.safeParse(rawEntry);
    if (!parsed.success) {
      console.warn(
        `[catalog] rejected upsert for ${key}: ${parsed.error.issues[0]?.message ?? "failed schema validation"}`,
      );
      return false;
    }
    const entry: DiscoveryResource = sanitizeStoredResource(parsed.data);

    // Bind the payTo on first settlement (TOFU); a bound update keeps the set.
    const isFirstCatalog = existing === undefined;
    const candidate: StoredEntry = {
      resource: entry,
      stats: existing?.stats ?? { settlements: 0, payers: [], observed: 0 },
      boundPayTo: existing ? existing.boundPayTo : [requirements.payTo],
      verifiedOwner: existing?.verifiedOwner ?? false,
      // Carried, not recomputed: updating a restored entry does not make this
      // process the witness of the baseline it inherited.
      restored: existing?.restored ?? false,
    };
    if (isFirstCatalog) {
      // Ownership is recorded when the binding is ESTABLISHED (not at eviction),
      // so it is durable from the moment it exists. Refused when frozen for ANY
      // ownership reason — unreachable and invalid are different diagnoses but
      // the same answer here: do not bind.
      const frozenOnOwnership =
        this.frozen === "ownership-unreachable" || this.frozen === "ownership-invalid";
      if (frozenOnOwnership || !(await this.bindOwnership(key, requirements.payTo, candidate))) {
        return false;
      }
    }
    const boundPayTo = existing ? existing.boundPayTo : (this.ownership.get(key) ?? [requirements.payTo]);
    this.entries.set(key, { ...candidate, boundPayTo });
    // Active half of the signal: /health carries a standing count, but nothing
    // polls it now that the keep-alive is off, so say it once per URL in the log.
    if (isStructurallyUnverifiable(key) && !this.warnedUnverifiable.has(key)) {
      this.warnedUnverifiable.add(key);
      console.warn(
        `[catalog] ${key} can never be ownership-verified: the resource advertises an address the ` +
          `facilitator cannot fetch (https-only, no loopback/private literals, no route templates). ` +
          `The entry is served but permanently unverified. If this is your seller, set PUBLIC_BASE_URL ` +
          `to the address it is actually reachable at — see docs/operator-runbook.md §4.`,
      );
    }
    this.evictToCap();
    this.save();
    return isFirstCatalog;
  }

  /**
   * Record one settled payment against a cataloged resource. Unique payers are
   * deduped and capped; the settlement count is unbounded. Returns whether the
   * settlement was counted.
   *
   * G-4: `settledPayTo` is REQUIRED and must be bound to the resource. Without
   * it, any payer could move any entry's stats: `recordSettlement` ran
   * unconditionally in bazaar.ts *after* `upsertFromPayment`, so a payment the
   * catalog had just refused as an F11 hijack still incremented the victim's
   * settlements, uniquePayers and lastSettled — while `statsSource` continued to
   * read "observed", asserting a provenance the data did not have.
   *
   * The gate lives here rather than at the call site on purpose: a caller
   * forgetting to check is exactly how this happened.
   *
   * What this does NOT prevent: a bound owner inflating their own stats by
   * paying themselves. That is indistinguishable from real custom at this layer
   * — see G-4 in docs/security-audit.md for the cost bound on it.
   */
  recordSettlement(resourceUrl: string, payer: string | undefined, settledPayTo: string): boolean {
    const key = BazaarCatalog.canonicalResourceKey(resourceUrl);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (!settledPayTo || !entry.boundPayTo.includes(settledPayTo)) {
      console.warn(
        `[catalog] refused settlement stat for ${key}: payTo ${settledPayTo || "(absent)"} is not bound ` +
          `(bound: ${entry.boundPayTo.join(", ")}) — stats may only be moved by the resource's bound owner (G-4)`,
      );
      return false;
    }
    entry.stats.settlements += 1;
    entry.stats.observed += 1;
    entry.stats.lastSettled = new Date().toISOString();
    if (
      payer &&
      entry.stats.payers.length < MAX_TRACKED_PAYERS &&
      !entry.stats.payers.includes(payer)
    ) {
      entry.stats.payers.push(payer);
    }
    this.save();
    return true;
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

  /**
   * Load entries from the store. Ownership is already in memory by the time this
   * runs (see create) — which is what lets bindLoadedEntry take the owner from
   * the BINDING instead of re-deriving it from accepts[0]. That derivation was
   * G-5, and it is gone.
   *
   * The `limit` is applied by the query (store.loadEntries), not here: that is
   * G-6, where the file store enforced MAX_ENTRIES on write but not on load and
   * a large file became an unbounded startup allocation.
   */
  private async load(limit: number): Promise<void> {
    let rows: StoredEntryRow[];
    try {
      rows = await loadWithRetry(() => this.store!.loadEntries(limit));
    } catch (err) {
      // Entries are RECONSTRUCTIBLE from settlement traffic, so failing to load
      // them is an availability dent, not a security event — unlike ownership,
      // which has already succeeded by this point. Start empty and repopulate.
      console.error(`[catalog] entries could not be loaded, starting empty: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    for (const row of rows) {
      let item: unknown;
      try {
        item = JSON.parse(row.payload);
      } catch {
        console.warn(`[catalog] load: dropped an entry whose payload is not JSON (${row.resourceKey})`);
        continue;
      }
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
            // Never read from the file: this counts only what we witness.
            observed: 0,
            ...(parsedStats.lastSettled !== undefined ? { lastSettled: parsedStats.lastSettled } : {}),
          }
        : { settlements: 0, payers: [], observed: 0 };
      const stored: StoredEntry = {
        resource: sanitizeStoredResource(parsed.data.resource),
        stats,
        boundPayTo: [],
        verifiedOwner: false,
        // Set here and nowhere else on this path: anything reaching this loop
        // came off disk, including a stored count of 0.
        restored: true,
      };
      // Keyed by the CANONICAL form, for the same reason as ownership above: the
      // stored `resource.resource` is the merchant's advertised spelling, and
      // two spellings must not become two entries. On collision the newer
      // lastUpdated wins — entries are reconstructible, so this only decides
      // which stale copy is served until the next settlement.
      const entryKey = BazaarCatalog.canonicalResourceKey(stored.resource.resource);
      const prior = this.entries.get(entryKey);
      if (prior && prior.resource.lastUpdated >= stored.resource.lastUpdated) continue;
      this.entries.set(entryKey, this.bindLoadedEntry(stored, entryKey));
    }
  }

  /**
   * Fix 0 Layer 1 enforcement at load time: a crafted store must not be able
   * to plant a hijacked entry the ingestion path would have rejected. An
   * accepts entry survives load only when its payTo is in the OWNERSHIP
   * TABLE's bound set for the URL — the same rule upsertFromPayment enforces
   * on the write path. The whole set, not just `[0]`: the operator rotation
   * (runbook §1) APPENDS a second bound address, and filtering load to the
   * first address alone quarantined the rotated merchant's only real payment
   * option on every restart while the write path had accepted it — a listing
   * that served `accepts: []` until the owner's next settlement. Found live
   * 2026-08-21, first restart after the demo rotation. An unbound payTo is
   * still dropped (F11 holds).
   */
  private bindLoadedEntry(stored: StoredEntry, key = stored.resource.resource): StoredEntry {
    const accepts = stored.resource.accepts ?? [];
    // G-5 CLOSES HERE. The owner comes from the OWNERSHIP TABLE, never from the
    // entry. The old code took `accepts[0].payTo` and seeded a binding from it,
    // which meant an entry with an EMPTY accepts array loaded with no binding
    // and no tombstone — and was then permanently unclaimable, because binding
    // is refused once an entry exists. The derivation that produced that state
    // no longer exists: an entry with no binding is now dropped, because a row
    // in `entry` without a row in `ownership` cannot be produced by
    // bindAndUpsertEntry and therefore means the data was tampered with.
    const authoritative = this.ownership.get(key);
    if (!authoritative || authoritative.length === 0) {
      console.warn(
        `[catalog] load: dropped ${stored.resource.resource} — it has an entry but NO ownership row. ` +
          `One transaction writes both, so this state is not reachable through the code; it means the ` +
          `store was written by something else.`,
      );
      return {
        ...stored,
        resource: { ...stored.resource, accepts: [] },
        boundPayTo: [],
        verifiedOwner: false,
      };
    }
    // The WHOLE bound set, matching upsertFromPayment — see the doc comment.
    const kept = accepts.filter((a) => authoritative.includes(a.payTo));
    if (kept.length !== accepts.length) {
      console.warn(
        `[catalog] load: quarantined ${accepts.length - kept.length} accepts entry(ies) for ` +
          `${stored.resource.resource} with a payTo outside the bound owner set ` +
          `[${authoritative.join(", ")}] (F11)`,
      );
    }
    return {
      resource: { ...stored.resource, accepts: kept },
      stats: stored.stats ?? { settlements: 0, payers: [], observed: 0 },
      boundPayTo: authoritative,
      // Rebuilt field by field rather than spread, so provenance must be carried
      // explicitly or a loaded entry silently reports itself as observed (O-7).
      restored: stored.restored,
      // Never trust a stored verified flag — a crafted file could forge it (RA-9).
      // Layer 2 re-verifies from the resource on the bound owner's next
      // settlement, via `reverify` (G-1).
      //
      // That sentence was in this file for a long time before it was true: Layer 2
      // fired only on first catalog, which is never the case for a loaded entry, so
      // a restored entry stayed unverified forever and `verified_only=true` served
      // an empty catalog. It is now asserted end-to-end in
      // src/catalog.reverify.test.ts — if the path is removed, that test fails and
      // this comment stops being a claim nobody checks.
      verifiedOwner: false,
    };
  }

  /**
   * Establish ownership for a URL, DURABLY, before anything relies on it.
   *
   * This is the guarantee the whole migration turns on, and the reason
   * saveOwnership was synchronous in the file store. G-7 was precisely the bug
   * where a binding lived in memory and never reached disk; an async write
   * reintroduces that window with a network in the middle unless the caller
   * waits for the commit and treats a failure as "not bound".
   *
   * So: the in-memory map is populated ONLY after the write commits. On failure
   * nothing is recorded and `false` is returned, which refuses the upsert — the
   * same fail-closed path already used at the tombstone cap. It must never
   * optimistically bind and hope the write lands.
   *
   * The entry is written in the SAME transaction (store.bindAndUpsertEntry), so
   * a binding without its entry, or an entry without its binding, is not a state
   * this code can produce.
   */
  private async bindOwnership(resourceUrl: string, payTo: string, entry: StoredEntry): Promise<boolean> {
    if (this.ownership.has(resourceUrl)) return true; // already bound
    if (this.ownership.size >= MAX_TOMBSTONES) {
      if (this.frozen !== "tombstone-cap") {
        this.frozen = "tombstone-cap";
      }
      // Warn on EVERY rejection, not just the transition: an operator reading
      // logs a week later must see this is still happening.
      console.warn(
        `[catalog] tombstone cap (${MAX_TOMBSTONES}) reached — REFUSING new binding for ${resourceUrl}. ` +
          `Existing bindings still work and settlement is unaffected. Forgetting ownership would be a ` +
          `silent security regression, so new URLs are refused instead.`,
      );
      return false;
    }
    if (this.store) {
      try {
        await this.store.bindAndUpsertEntry(
          { resourceKey: resourceUrl, boundPayTo: [payTo] },
          { resourceKey: resourceUrl, payload: JSON.stringify(entry), lastUpdated: Date.now() },
        );
      } catch (err) {
        // NOT bound. Refusing the upsert loses a catalog listing, which the next
        // settlement rebuilds. Binding in memory only would lose the BINDING on
        // the next restart and reopen the URL to first-writer claim, which
        // nothing rebuilds.
        console.error(
          `[catalog] ownership write FAILED for ${resourceUrl} — the binding is NOT established and the ` +
            `upsert is refused: ${String((err as Error)?.message ?? err)}`,
        );
        return false;
      }
    }
    this.ownership.set(resourceUrl, [payTo]);
    return true;
  }

  /** Evict least-recently-updated entries down to MAX_ENTRIES. Ownership is NOT
   * dropped — the tombstone outlives the entry, so an evicted URL cannot be
   * reclaimed by a different payTo. */
  private evictToCap(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const byAge = [...this.entries.entries()].sort((a, b) =>
      a[1].resource.lastUpdated.localeCompare(b[1].resource.lastUpdated),
    );
    let toDrop = this.entries.size - MAX_ENTRIES;
    for (const [key] of byAge) {
      if (toDrop-- <= 0) break;
      this.entries.delete(key);
    }
  }

  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Debounced entry persistence. Entries are RECONSTRUCTIBLE from settlement
   * traffic, so coalescing writes is safe and a lost write costs a listing until
   * the next settlement. Ownership is never debounced — losing a binding
   * silently reopens that URL to first-writer claim, and nothing rebuilds it.
   *
   * That asymmetry is the existing design and it survives the move unchanged.
   */
  private save(): void {
    if (!this.store) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Write entries now (also used by tests and shutdown). */
  async flush(): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.saveEntries(
        [...this.entries.entries()].map(([key, e]) => ({
          resourceKey: key,
          payload: JSON.stringify(e),
          lastUpdated: Date.now(),
        })),
      );
    } catch (err) {
      // Best-effort by design; the in-memory catalog stays authoritative and the
      // next settlement rewrites the row.
      console.error("[catalog] entry persist failed:", err);
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
      // Forged stats cannot be *rejected* — settlement history has no
      // independent source — so they are DISCLOSED instead. observedSettlements
      // counts only what this process saw; statsSource says whether these
      // numbers were inherited from a previous process and are therefore
      // unverifiable.
      //
      // O-7: this was `settlements === observed`, which claimed "observed" for a
      // restored entry whose stored count was 0 — a provenance assertion about
      // an entry this process had never seen. Read the flag, not the arithmetic.
      observedSettlements: entry.stats.observed,
      statsSource: entry.restored ? ("persisted" as const) : ("observed" as const),
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
