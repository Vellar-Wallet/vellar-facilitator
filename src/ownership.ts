import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// Fix 0 Layer 2 — resource-URL ownership verification via the resource's own
// HTTP 402 challenge. This is the actual ownership control (Layer 1 TOFU is only
// a floor that resets on restart): we re-derive ownership from the resource
// itself. On first catalog of a canonical URL, fetch it, expect a 402 whose
// PAYMENT-REQUIRED challenge advertises the settled payTo, and bind on match.
//
// This introduces the codebase's FIRST outbound fetch to an attacker-influenced
// URL (F8 confirmed none existed before). It is therefore an SSRF sink and is
// guarded accordingly (assertPublicHttpsUrl): https only; the host's address is
// range-checked by BYTES (all IPv4/IPv6 forms, incl. mapped/compatible/site-local)
// and then PINNED into the connection so DNS rebinding cannot redirect the socket;
// no redirects; bounded timeout; and the response body is cancelled unread (the
// verdict comes only from the PAYMENT-REQUIRED header, so nothing is downloaded).
// It runs off the settlement hot path (see bazaar.ts) and NEVER throws into the
// caller — settlement must not depend on it.

/** 3s is enough for an honest 402; a slower endpoint degrades to "unverifiable"
 * (unbound), never blocks. */
const FETCH_TIMEOUT_MS = 3_000;
/** A 402 challenge is tiny (the payload rides in headers); 64 KB is generous. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Documented limits, exported so their RATIONALE is assertable — see the
 * "module constants" block in src/config.thresholds.test.ts. Read-only: this is
 * not a runtime knob. */
export const OWNERSHIP_LIMITS = Object.freeze({
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
});

/**
 * `timeout` is deliberately NOT folded into `unverifiable`.
 *
 * They mean opposite things about the resource. `unverifiable` says the
 * endpoint answered and the answer was no good — wrong status, no challenge,
 * unparseable. `timeout` says it did not answer in the budget, which on
 * free-tier hosting usually means asleep rather than broken. They deserve
 * different cooldowns and only one of them deserves a retry.
 */
export type OwnershipVerdict = "match" | "mismatch" | "unverifiable" | "timeout";

/** One retry, this long after a timeout. Sized to outlast a cold start (~30-45s
 *  measured) without holding anything open — the wait is a timer, not a socket. */
const COLD_START_RETRY_DELAY_MS = 60_000;

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
/**
 * The fetch used when the caller injects none. MUST come from the same undici
 * copy as `pinnedDispatcher` (see the note in verifyResourceOwnership).
 * Exported so tests can exercise the REAL dispatch path rather than a mock —
 * mocking fetch is exactly what hid the undici-version incompatibility.
 */
export const defaultFetch = undiciFetch as unknown as typeof fetch;

/**
 * The DNS lookup that pins a connection to the guard-vetted address. Extracted
 * and exported so it can be tested as a unit: asserting a decorative label on
 * the dispatcher did NOT detect a mutation that pinned every request to
 * 127.0.0.1, which inverts the SSRF guard entirely.
 */
export function pinnedLookup(vetted: VettedAddress) {
  const family = vetted.family === 6 ? 6 : 4;
  // Node calls this with all:true (expects an array) or all:false/absent
  // (expects address+family). Handle both so the pin holds either way.
  return (
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
}

/** Exported for tests: builds the IP-pinning dispatcher. */
export function pinnedDispatcher(vetted: VettedAddress): Agent {
  // Single cast at the undici boundary: its LookupFunction type models only one
  // of the two callback shapes Node actually uses.
  return new Agent({ connect: { lookup: pinnedLookup(vetted) } } as unknown as ConstructorParameters<typeof Agent>[0]);
}

export interface VerifyOptions {
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Delay before the single cold-start retry. Defaults to
   * COLD_START_RETRY_DELAY_MS; set 0 to disable retrying entirely (tests that
   * assert single-shot behaviour, and any caller that cannot wait a minute).
   */
  coldStartRetryDelayMs?: number;
  /**
   * TEST TRANSPORT ONLY — never set this in production.
   *
   * Relaxes the https-only requirement and the private-address block so the
   * REAL path (default fetch -> pinned dispatcher -> socket -> 402 parse ->
   * verdict) can be exercised against a local server. Without it, Layer 2 can
   * only ever be tested with a mocked fetch — which is exactly how an undici
   * incompatibility once left this control inert in production while 22 tests
   * passed. The two checks it skips are covered directly by their own unit
   * tests (see assertPublicHttpsUrl / isBlockedAddress).
   */
  __insecureTestTransport?: boolean;
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
  insecureTestTransport = false,
): Promise<VettedAddress> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`ownership: malformed URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && !insecureTestTransport) {
    throw new Error(`ownership: refusing non-https URL (${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // If the host is a literal IP, check it directly; otherwise resolve and check.
  const literal = isIP(host);
  const resolved = literal ? { address: host, family: literal } : await lookupFn(host);
  if (isBlockedAddress(resolved.address) && !insecureTestTransport) {
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
  settledPayTo: string | readonly string[],
  opts: VerifyOptions = {},
): Promise<OwnershipVerdict> {
  // G-1: a resource may have more than one bound address — the operator rotation
  // procedure (runbook §1) appends rather than replaces. Match if the challenge
  // names ANY of them, in ONE fetch.
  //
  // An empty or all-blank claim set is UNVERIFIABLE, never "mismatch": asking
  // "does this resource claim <nothing>?" has no answer, and the old single-arg
  // form returned "mismatch" for undefined — reading a missing claim as a
  // refuted one. bindLoadedEntry can produce exactly that (an entry with no
  // accepts binds to nothing).
  const claims = (Array.isArray(settledPayTo) ? settledPayTo : [settledPayTo as string]).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (claims.length === 0) return "unverifiable";

  const first = await probeOnce(resourceUrl, claims, opts);
  if (first !== "timeout") return first;

  // COLD-START RETRY — exactly one, and only for a timeout.
  //
  // A timeout is not evidence about ownership. It is usually evidence that the
  // resource is asleep: free-tier hosts spin down after ~15 minutes idle and
  // take 30-45s to come back, against a 3s probe budget. Measured 2026-08-14 on
  // vellar-seller-demo — asleep it returns "unverifiable" at 3006ms; warm it
  // returns "match" in 679ms. The verifier was right and the resource was
  // simply not there yet.
  //
  // The first probe is also what WAKES the host, so a single retry a minute
  // later lands on a warm service. That is why this is a retry rather than a
  // longer budget: raising the budget to 10s would still lose to a 31s cold
  // start while weakening the DoS bound on every probe, including hostile ones.
  //
  // WHAT STOPS AN ENDPOINT THAT ALWAYS TIMES OUT FROM GETTING INFINITE RETRIES:
  //   1. One retry per call. Never a loop, so a trigger costs at most 2 probes.
  //   2. Each probe is still bounded by `timeoutMs`, so the worst case is two
  //      3-second waits plus the delay — nothing is held open longer.
  //   3. The caller cools down on the verdict (catalog.cooldownFor), so a
  //      repeatedly-timing-out URL is re-probed at most once per cooldown.
  //   4. Triggers are settlements, which cost the payer money.
  // Worst case is therefore ~2 probes per cooldown window per URL, and only
  // while somebody is paying for it.
  const delayMs = opts.coldStartRetryDelayMs ?? COLD_START_RETRY_DELAY_MS;
  if (delayMs <= 0) return first;
  await new Promise((r) => setTimeout(r, delayMs));
  return probeOnce(resourceUrl, claims, opts);
}

/** One probe, one budget, one verdict. All retry policy lives in the caller. */
async function probeOnce(
  resourceUrl: string,
  claims: string[],
  opts: VerifyOptions,
): Promise<OwnershipVerdict> {
  // MUST be undici's own fetch, not the global one. The pinned dispatcher is an
  // undici@8 Agent; Node's global fetch is a DIFFERENT bundled undici (6.x on
  // Node 22, 7.x on Node 25) whose handler interface undici@8 rejects with
  // UND_ERR_INVALID_ARG ("invalid onRequestStart method") before any socket is
  // opened. Mixing them made every verification throw and degrade to
  // "unverifiable" — silently disabling the entire Layer 2 control. Dispatcher
  // and fetch must come from the same undici copy.
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const lookupFn = opts.lookupFn ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;

  let vetted: VettedAddress;
  try {
    vetted = await assertPublicHttpsUrl(resourceUrl, lookupFn, opts.__insecureTestTransport === true);
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

    // Audit D11: the verdict is derived ENTIRELY from the PAYMENT-REQUIRED
    // header, so the body is never needed. Cancel it immediately — that frees
    // the socket instead of leaving it open until GC, and means no response
    // body is ever downloaded (the only truly bounded outcome).
    void res.body?.cancel?.().catch(() => {});

    // A redirect (or anything that isn't the payment challenge) is unverifiable.
    if (res.status !== 402) return "unverifiable";

    const header = res.headers.get("PAYMENT-REQUIRED");
    if (!header) return "unverifiable";
    // Bound the header we will actually decode.
    if (header.length > maxBytes) return "unverifiable";

    const challenge = decodeChallenge(header);
    if (!challenge) return "unverifiable";

    const payTos = new Set(
      challenge.accepts
        .map((a) => a.payTo)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    );
    if (payTos.size === 0) return "unverifiable";
    return claims.some((c) => payTos.has(c)) ? "match" : "mismatch";
  } catch {
    // A TIMEOUT IS NOT THE SAME AS A FAILURE, and collapsing the two is what
    // this repo keeps finding. Previously "abort (timeout), network error, DNS
    // failure — all degrade to unverifiable", which meant a sleeping resource
    // and a genuinely broken one were indistinguishable, shared a 15-minute
    // cooldown, and neither was ever retried in time to catch a cold start.
    //
    // `controller.signal.aborted` is true only when OUR timer fired, so this
    // separates "did not answer in time" from "answered badly / not at all".
    if (controller.signal.aborted) return "timeout";
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
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF
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

  // Standard IPv4-in-IPv6 transition prefixes all carry a routable IPv4 that a
  // gateway will translate to, so each must be decoded and range-checked:
  //   NAT64/DNS64  64:ff9b::/96      (and 64:ff9b:1::/48 local-use)
  //   6to4         2002::/16         (IPv4 in bytes 2..5)
  //   IPv4-translated ::ffff:0:0/96  (bytes 8..9 == 0xffff)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isBlockedIpv4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
  }
  if (bytes.slice(0, 8).every((b) => b === 0) && bytes[8] === 0xff && bytes[9] === 0xff) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

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
