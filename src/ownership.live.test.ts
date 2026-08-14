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

  // ==========================================================================
  // THE COLD-START CASE — and it must be run against a genuinely SLEEPING host.
  //
  // A stubbed 3-second timeout is not this test. The whole finding of
  // 2026-08-14 is that the harness and production disagreed on exactly this
  // point: every unit test simulates a timeout that never resolves, whereas a
  // real free-tier host times out at 3s and then answers correctly 30-45s
  // later. Only the second shape exercises the retry doing its job.
  //
  // TO RUN IT HONESTLY: leave the seller idle for >15 minutes first, so Render
  // has spun it down. If the host is already warm this test proves nothing —
  // it will simply match on the first probe, which is why it asserts the
  // ELAPSED TIME rather than only the verdict.
  //
  // Measured when written, against vellar-seller-demo:
  //   asleep, 3s budget, no retry -> timeout       (3006ms, 4046ms)
  //   asleep, 3s budget, 1 retry  -> match         (~61s: 3s + 60s + 0.7s)
  //   warm,   3s budget           -> match         (679ms, 878ms, 718ms)
  it("recovers from a real cold start: times out, waits, then matches", async () => {
    const t0 = Date.now();
    const singleShot = await verifyResourceOwnership(LIVE_URL!, LIVE_PAYTO!, {
      coldStartRetryDelaysMs: [],
    });
    const firstMs = Date.now() - t0;

    if (singleShot === "match") {
      // The host was warm. Say so loudly rather than passing on nothing — a
      // green run here would otherwise be indistinguishable from a real one.
      console.log(
        `\n  SKIPPED IN EFFECT: host answered in ${firstMs}ms, so it was already warm.\n` +
          `  Leave it idle >15 minutes and re-run to exercise the cold-start path.\n`,
      );
      return;
    }

    // A sleeping host must be reported as `timeout`, never `unverifiable` —
    // that distinction is what earns it a retry and a 60s cooldown instead of
    // a 15-minute one.
    expect(singleShot, "a sleeping host is a timeout, not a failure").toBe("timeout");

    // Now the real thing: the same probe WITH the retry. The first attempt is
    // what wakes the host; the retry a minute later lands on a warm one.
    const t1 = Date.now();
    const withRetry = await verifyResourceOwnership(LIVE_URL!, LIVE_PAYTO!);
    const totalMs = Date.now() - t1;

    console.log(`\n  cold single-shot: ${singleShot} in ${firstMs}ms`);
    console.log(`  with retry:       ${withRetry} in ${totalMs}ms\n`);

    // WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
    //
    // Asserted: the parts we control. The retry fired (elapsed proves it), and
    // a sleeping host is reported as `timeout` — never `unverifiable` — which
    // is what earns the 60s cooldown instead of the 15-minute one.
    //
    // NOT asserted: that the host woke in time. We do not control Render's wake
    // latency, and it has a long tail. Measured 2026-08-14 on this seller:
    // 31.7s once, 42.5s and 43.7s on the facilitator, and one run where 200s of
    // requests returned nothing before it recovered. A first version of this
    // test required `match` and FAILED on the tail — correctly. Turning that
    // into a bumped constant would have been fitting the number to the test.
    //
    // So the honest statement is: no bounded retry covers that tail, and the
    // real fix is re-verification decoupled from settlement (a periodic sweep),
    // which is tracked separately. This test proves the retry mechanism works
    // and reports whether the host cooperated.
    expect(totalMs, "the retry must actually have waited, not returned immediately").toBeGreaterThan(30_000);
    expect(["match", "timeout"]).toContain(withRetry);
    if (withRetry !== "match") {
      console.log(
        `  NOTE: the host had not finished waking after the retry. That is the\n` +
          `  known long tail, not a defect in the retry — see the comment above.\n`,
      );
    }
  }, 180_000);

  it("uses undici's fetch, not the global one", async () => {
    // A version mismatch here silently disabled the whole control once before:
    // undici@8's Agent rejects Node's bundled fetch with UND_ERR_INVALID_ARG
    // before a socket opens, and the catch degraded every verdict to
    // "unverifiable" while 22 mocked tests stayed green.
    expect(defaultFetch).not.toBe(globalThis.fetch);
  });
});
