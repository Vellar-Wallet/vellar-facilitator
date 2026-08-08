import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

// Fix 0 Layer 2 — resource-URL ownership verification via the resource's own
// HTTP 402 challenge. This is the actual ownership control (Layer 1 TOFU is only
// a floor that resets on restart): we re-derive ownership from the resource
// itself. On first catalog of a canonical URL, fetch it, expect a 402 whose
// PAYMENT-REQUIRED challenge advertises the settled payTo, and bind on match.
//
// This introduces the codebase's FIRST outbound fetch to an attacker-influenced
// URL (F8 confirmed none existed before). It is therefore an SSRF sink and is
// guarded accordingly (assertPublicHttpsUrl): https only, DNS-resolved host must
// be public (no private/loopback/link-local/metadata ranges), no redirects,
// bounded timeout, bounded response size. It runs off the settlement hot path
// (see bazaar.ts) and NEVER throws into the caller — settlement must not depend
// on it.

/** 3s is enough for an honest 402; a slower endpoint degrades to "unverifiable"
 * (unbound), never blocks. */
const FETCH_TIMEOUT_MS = 3_000;
/** A 402 challenge is tiny (the payload rides in headers); 64 KB is generous. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type OwnershipVerdict = "match" | "mismatch" | "unverifiable";

interface LookupResult {
  address: string;
  family: number;
}
type LookupFn = (hostname: string) => Promise<LookupResult>;

/** The single address the SSRF guard vetted, pinned into the connection (D2). */
export interface VettedAddress {
  address: string;
  family: number;
}

/**
 * Audit D2 — close the DNS-rebinding TOCTOU. Previously the guard resolved the
 * host, range-checked the IP, then DISCARDED it while `fetch` performed its own
 * independent resolution — so attacker-controlled DNS could answer a public IP
 * to the guard and 127.0.0.1 / 169.254.169.254 to the actual connection.
 *
 * This dispatcher overrides the connection's DNS lookup to return ONLY the
 * address the guard already vetted, so the socket cannot land anywhere else.
 * TLS still validates against the original hostname (SNI/cert are unchanged —
 * we override resolution, not identity), so pinning costs no certificate safety.
 */
function pinnedDispatcher(vetted: VettedAddress): Agent {
  const family = vetted.family === 6 ? 6 : 4;
  // Node calls the lookup with all:true (expects an array) or all:false/absent
  // (expects address+family). Handle both so the pin holds either way. Cast at
  // the boundary: undici's LookupFunction overloads don't model both shapes.
  const lookup = (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    if (options?.all) {
      callback(null, [{ address: vetted.address, family }]);
      return;
    }
    callback(null, vetted.address, family);
  };
  // Single cast at the undici boundary: its LookupFunction type models only one
  // of the two callback shapes Node actually uses.
  return new Agent({ connect: { lookup } } as unknown as ConstructorParameters<typeof Agent>[0]);
}

export interface VerifyOptions {
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Reject a URL that is not a public https endpoint. Resolves DNS via `lookupFn`
 * and checks the resolved address against private/loopback/link-local/metadata
 * ranges — closing the DNS-rebinding gap that a string check alone would leave.
 * Throws on any violation; the caller converts a throw into "unverifiable".
 */
export async function assertPublicHttpsUrl(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<VettedAddress> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`ownership: malformed URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ownership: refusing non-https URL (${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // If the host is a literal IP, check it directly; otherwise resolve and check.
  const literal = isIP(host);
  const resolved = literal ? { address: host, family: literal } : await lookupFn(host);
  if (isBlockedAddress(resolved.address)) {
    throw new Error(
      `ownership: host resolves to a blocked (private/loopback/link-local) address: ${resolved.address}`,
    );
  }
  // Returned so the caller can PIN the connection to exactly this address (D2).
  return { address: resolved.address, family: resolved.family || (isIP(resolved.address) as 4 | 6) };
}

/**
 * Fetch the resource's 402 challenge and decide whether `settledPayTo` owns it.
 * Returns a verdict; never throws. "unverifiable" covers SSRF-block, network
 * failure, non-402 status, any redirect, missing/oversized/undecodable
 * challenge — everything short of a clean match or a clean mismatch.
 */
export async function verifyResourceOwnership(
  resourceUrl: string,
  settledPayTo: string,
  opts: VerifyOptions = {},
): Promise<OwnershipVerdict> {
  const fetchFn = opts.fetchFn ?? fetch;
  const lookupFn = opts.lookupFn ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;

  let vetted: VettedAddress;
  try {
    vetted = await assertPublicHttpsUrl(resourceUrl, lookupFn);
  } catch {
    return "unverifiable";
  }

  // D2: pin the connection to the address the guard vetted, so fetch cannot
  // re-resolve the hostname to an internal target between check and connect.
  const dispatcher = pinnedDispatcher(vetted);
  // Surfaced for tests/observability: which address this request is pinned to.
  (dispatcher as Agent & { pinnedAddress?: string }).pinnedAddress = vetted.address;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(resourceUrl, {
      method: "GET",
      redirect: "manual", // never follow a redirect into a blocked range
      signal: controller.signal,
      headers: { accept: "application/json" },
      dispatcher,
    } as unknown as RequestInit);

    // A redirect (or anything that isn't the payment challenge) is unverifiable.
    if (res.status !== 402) return "unverifiable";

    const header = res.headers.get("PAYMENT-REQUIRED");
    if (!header) return "unverifiable";
    // Guard the decode size too (header is bounded by the platform, but be safe).
    if (header.length > maxBytes) return "unverifiable";

    const challenge = decodeChallenge(header);
    if (!challenge) return "unverifiable";

    const payTos = new Set(
      challenge.accepts
        .map((a) => a.payTo)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    );
    if (payTos.size === 0) return "unverifiable";
    return payTos.has(settledPayTo) ? "match" : "mismatch";
  } catch {
    // Abort (timeout), network error, DNS failure — all degrade to unverifiable.
    return "unverifiable";
  } finally {
    clearTimeout(timer);
    // The pinned dispatcher owns a connection pool; close it so a per-request
    // agent cannot accumulate sockets. Never let cleanup surface an error.
    void (dispatcher as Agent & { close?: () => Promise<void> }).close?.().catch(() => {});
  }
}

interface Challenge {
  accepts: Array<{ payTo?: unknown }>;
}

function decodeChallenge(header: string): Challenge | null {
  try {
    const json = Buffer.from(header, "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { accepts?: unknown }).accepts)
    ) {
      return parsed as Challenge;
    }
    return null;
  } catch {
    return null;
  }
}

async function defaultLookup(hostname: string): Promise<LookupResult> {
  // Resolve to a single address; the range check runs on that address. (A host
  // with multiple A/AAAA records could rebind, but node fetch connects to the
  // resolver's answer; verification staying conservative here — one lookup —
  // errs toward "unverifiable", which is the safe/unbound direction.)
  const { address, family } = await dnsLookup(hostname);
  return { address, family };
}

/**
 * True if `address` is in a range we must never fetch: RFC1918 private, loopback,
 * link-local (incl. the 169.254.169.254 cloud-metadata IP), unspecified, and
 * their IPv6 equivalents (::1, fc00::/7 ULA, fe80::/10 link-local).
 */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isBlockedIpv4(address);
  if (kind === 6) return isBlockedIpv6(address);
  return true; // not a parseable IP → refuse
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * Range-check an IPv6 address by its 16 BYTES, not by string form — a textual
 * regex (the previous approach) missed the hex-normalized forms Node's URL
 * parser emits (::ffff:7f00:1 for [::ffff:127.0.0.1]), IPv4-compatible (::a.b.c.d),
 * fully-expanded, and site-local variants. Parsing to bytes classifies every
 * form uniformly. (Audit D1 critical / D12.)
 */
function isBlockedIpv6(ip: string): boolean {
  const bytes = parseIpv6ToBytes(ip);
  if (!bytes) return true; // unparseable → refuse

  // Loopback ::1 and unspecified ::
  const allZeroExceptLast = bytes.slice(0, 15).every((b) => b === 0);
  if (allZeroExceptLast && (bytes[15] === 1 || bytes[15] === 0)) return true;

  // Link-local fe80::/10 and site-local fec0::/10 → high 10 bits 1111 1110 11/10.
  // fe80::/10 covers 0xfe80–0xfebf; fec0::/10 covers 0xfec0–0xfeff.
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true; // fec0::/10 (deprecated, still blocked)

  // Unique-local fc00::/7 (fc00–fdff).
  if ((bytes[0]! & 0xfe) === 0xfc) return true;

  // IPv4-mapped ::ffff:a.b.c.d  → bytes 10,11 == 0xff, first 10 zero.
  const mappedPrefix = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  // IPv4-compatible ::a.b.c.d (deprecated) → first 12 bytes zero, last 4 non-trivial.
  const compatPrefix = bytes.slice(0, 12).every((b) => b === 0) && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15]! <= 1);
  if (mappedPrefix || compatPrefix) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isBlockedIpv4(v4);
  }
  return false;
}

/** Parse an IPv6 string (including ::ffff:1.2.3.4 mixed form) into 16 bytes, or
 * null if it isn't a valid IPv6 literal. */
function parseIpv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase().trim();
  // Strip an IPv6 zone id (fe80::1%eth0) — the scope never changes the range.
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);

  // Expand a trailing embedded IPv4 (::ffff:1.2.3.4 or ::1.2.3.4) into two hextets.
  const v4match = s.match(/(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4match) {
    const octs = v4match[2]!.split(".").map(Number);
    if (octs.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const h1 = ((octs[0]! << 8) | octs[1]!).toString(16);
    const h2 = ((octs[2]! << 8) | octs[3]!).toString(16);
    s = `${v4match[1]}${h1}:${h2}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const hextets: string[] =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
      : head;
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const n = parseInt(h, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}
