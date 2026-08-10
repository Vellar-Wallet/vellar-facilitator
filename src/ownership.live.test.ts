import tls from "node:tls";
import { describe, expect, it } from "vitest";
import {
  assertPublicHttpsUrl,
  defaultFetch,
  isBlockedAddress,
  pinnedLookup,
  verifyResourceOwnership,
} from "./ownership.js";

// ============================================================================
// LIVE — F11 Layer 2 against a real public HTTPS endpoint, SSRF guard armed.
//
// WHAT THIS EXISTS FOR. Until 2026-08-10, `verifyResourceOwnership` had NEVER
// returned "match" over a real network path — not in tests, not in production:
//
//   - every match-asserting unit test either relaxes the guard
//     (__insecureTestTransport, permitting http + 127.0.0.1) or stubs BOTH
//     fetchFn and lookupFn, so no real DNS or TLS is involved;
//   - the fully-armed real-socket tests only ever assert REJECTION (hits === 0);
//   - and production could not have covered it, because examples/seller.mjs
//     hardcoded `http://localhost:<port>` as its own resource URL, which the
//     guard rejects as non-https before opening a socket.
//
// So the control was unproven on the one path it exists for. This test is the
// proof, and it is deliberately honest about its cost.
//
// WHY IT IS OPT-IN, AND WHY CI DOES NOT COVER THIS.
// It needs a live public endpoint, real DNS, and a valid certificate. In CI that
// would be: a network dependency on every push, a free-tier instance that sleeps
// (so the first run pays a ~60s cold start), an external hostname that can
// change, and a red build whenever someone else's service is down. A recorded
// fixture would defeat the purpose entirely — the whole point is that the bytes
// traverse real DNS and real TLS, which a fixture cannot reproduce.
//
// So: CI does NOT cover this, and pretending otherwise would be worse than the
// gap. It is a MANUAL gate, run against a live seller before a release that
// touches ownership.ts. The procedure lives in docs/operator-runbook.md §4.
//
//   LIVE_SELLER_URL=https://vellar-seller-demo.onrender.com/quote \
//   LIVE_SELLER_PAYTO=G... \
//   npx vitest run src/ownership.live.test.ts
//
// Unset, it SKIPS rather than passes — a skipped test reads as "not run", while
// a vacuous pass reads as "covered", and that difference is the whole lesson of
// RA-12.
// ============================================================================

const LIVE_URL = process.env.LIVE_SELLER_URL;
const LIVE_PAYTO = process.env.LIVE_SELLER_PAYTO;
const enabled = Boolean(LIVE_URL && LIVE_PAYTO);

describe.skipIf(!enabled)("LIVE — Layer 2 over a real network path (manual gate)", () => {
  it("resolves, pins, validates TLS, fetches, and matches — every stage armed", async () => {
    const url = new URL(LIVE_URL!);
    const evidence: string[] = [];

    // Stages 1–3: https-only, REAL DNS resolution, post-resolution range check.
    // No lookupFn is passed, so this uses the platform resolver.
    const vetted = await assertPublicHttpsUrl(LIVE_URL!, undefined as never, false);
    expect(vetted.address, "must resolve to a real address").toBeTruthy();
    expect(isBlockedAddress(vetted.address), "a public host must not be blocked").toBe(false);
    evidence.push(`DNS      ${url.hostname} -> ${vetted.address} (family ${vetted.family})`);

    // Stage 4: the pin the guard applies to the socket must be the address the
    // guard itself vetted — this is what closes the DNS-rebinding TOCTOU (RA-2).
    const lookup = pinnedLookup(vetted) as unknown as (
      h: string,
      o: unknown,
      cb: (e: unknown, a: string) => void,
    ) => void;
    const pinned = await new Promise<string>((res) => lookup(url.hostname, {}, (_e, a) => res(a)));
    expect(pinned, "the pin must be the vetted address, not a re-resolution").toBe(vetted.address);
    evidence.push(`PIN      lookup() -> ${pinned}`);

    // Stage 5: real TLS to the PINNED address, certificate validated against the
    // hostname via SNI. rejectUnauthorized proves a real chain, not a bypass.
    const cert = await new Promise<{ authorized: boolean; cn: string; issuer: string }>(
      (res, rej) => {
        const s = tls.connect(
          { host: vetted.address, port: 443, servername: url.hostname, rejectUnauthorized: true },
          () => {
            const c = s.getPeerCertificate();
            const one = (v: string | string[] | undefined): string =>
              (Array.isArray(v) ? v[0] : v) ?? "(none)";
            res({ authorized: s.authorized, cn: one(c.subject?.CN), issuer: one(c.issuer?.O) });
            s.end();
          },
        );
        s.on("error", rej);
      },
    );
    expect(cert.authorized, "certificate must validate against the hostname").toBe(true);
    evidence.push(`TLS      authorized=${cert.authorized} CN=${cert.cn} issuer=${cert.issuer}`);

    // Stages 6–7: the real call. No __insecureTestTransport, no fetchFn, no
    // lookupFn — the guard is fully armed and the 402 is the seller's own.
    const verdict = await verifyResourceOwnership(LIVE_URL!, LIVE_PAYTO!);
    evidence.push(`VERDICT  ${verdict} (fetch impl: undici, not global)`);

    // The control that makes the match meaningful: a payTo the challenge does
    // NOT name must come back "mismatch". Without this, "match" could just mean
    // "returns match unconditionally".
    const negative = await verifyResourceOwnership(
      LIVE_URL!,
      "GNOTTHEOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    evidence.push(`CONTROL  wrong payTo -> ${negative}`);

    console.log("\n" + evidence.join("\n") + "\n");
    expect(verdict, "the live seller must verify its own bound payTo").toBe("match");
    expect(negative, "an unrelated payTo must be refused").toBe("mismatch");
  }, 180_000);

  it("refuses the same live host over http, without contacting it", async () => {
    // The guard must reject on scheme before any socket opens, even for a host
    // it would otherwise accept. This is the check that made every recorded
    // production run unverifiable, so it is worth pinning against a real host.
    const httpUrl = LIVE_URL!.replace(/^https:/, "http:");
    const verdict = await verifyResourceOwnership(httpUrl, LIVE_PAYTO!);
    expect(verdict, "http must be unverifiable regardless of the host").toBe("unverifiable");
  }, 60_000);

  it("uses undici's fetch, not the global one", () => {
    // A version mismatch here silently disabled the whole control once before:
    // undici@8's Agent rejects Node's bundled fetch with UND_ERR_INVALID_ARG
    // before a socket opens, and the catch degraded every verdict to
    // "unverifiable" while 22 mocked tests stayed green.
    expect(defaultFetch).not.toBe(globalThis.fetch);
  });
});
