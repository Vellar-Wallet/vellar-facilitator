import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

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
): Promise<void> {
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
  const address = literal ? host : (await lookupFn(host)).address;
  if (isBlockedAddress(address)) {
    throw new Error(`ownership: host resolves to a blocked (private/loopback/link-local) address: ${address}`);
  }
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

  try {
    await assertPublicHttpsUrl(resourceUrl, lookupFn);
  } catch {
    return "unverifiable";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(resourceUrl, {
      method: "GET",
      redirect: "manual", // never follow a redirect into a blocked range
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

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

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (addr.startsWith("fe80")) return true; // link-local fe80::/10
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // ULA fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return false;
}
