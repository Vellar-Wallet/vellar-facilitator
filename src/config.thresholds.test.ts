import { describe, expect, it, vi } from "vitest";
import { CATALOG_LIMITS } from "./catalog.js";
import { loadConfig } from "./config.js";
import { OWNERSHIP_LIMITS } from "./ownership.js";
import { SERVER_LIMITS } from "./server.js";
import { TRUST_LIMITS } from "./trust.js";

const SECRET = "SBJP6HHFTABK2GXVVFAKY6C4B7DDNB5PIEQXKUNL2ZAOBPWFOUOSTLVNMA";
const base = { SPONSOR_SECRET_KEY: SECRET };

// Threshold review. Two defects and one standing rule.
//
// DEFECT 1 — `SETTLE_RATE_MAX` (30) and `SETTLE_PER_PAYTO_MAX` (100) were two
// budgets on the SAME key over the SAME window, so the tighter one shadowed the
// looser one and F12's per-payTo dimension never ran. Consolidated to ONE
// budget at 50 — half the global capacity, so it is a real ratchet rather than
// an unreachable one, while a merchant can still run 5 URLs at their full rate.
//
// DEFECT 3 — a hard floor at or below the spend ceiling means the floor cannot
// hold: one window can drain through it before the next balance poll. That used
// to warn and boot anyway.
//
// STANDING RULE — numeric rationale must live with the value AND a test.
// Three comments in this repo have now asserted something untrue (bindLoadedEntry's
// re-verify claim, the "Layer 2 survives a restart" inversion, and this file's
// "1 XLM / ~20 settles per minute"). Prose beside a number rots because nothing
// checks it. The `documented rationale` block below is the antidote: it makes the
// arithmetic executable, so changing a value without revisiting its reasoning
// fails the build.

describe("threshold review — one per-payTo budget, one name", () => {
  it("defaults to a single per-payTo budget of 50", async () => {
    const c = loadConfig(base);
    expect(c.spend.perPayToMax).toBe(50);
  });

  it("no second per-payTo budget survives on the config object", async () => {
    // A retired knob that still parses is the next dead control.
    const c = loadConfig(base);
    expect(Object.keys(c.spend)).not.toContain("rateMax");
  });

  it("announces SETTLE_RATE_MAX as retired instead of silently ignoring it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = loadConfig({ ...base, SETTLE_RATE_MAX: "30" });
    const said = warn.mock.calls.map((x) => String(x[0])).join("\n");
    expect(said, "a retired var must announce itself").toMatch(/SETTLE_RATE_MAX/);
    expect(said).toMatch(/retired|ignored|no longer/i);
    expect(said, "must name the replacement").toMatch(/SETTLE_PER_PAYTO_MAX/);
    // And it must NOT quietly take effect.
    expect(c.spend.perPayToMax).toBe(50);
    warn.mockRestore();
  });

  it("still honours SETTLE_PER_PAYTO_MAX", async () => {
    expect(loadConfig({ ...base, SETTLE_PER_PAYTO_MAX: "7" }).spend.perPayToMax).toBe(7);
  });
});

describe("threshold review — the sponsor floor must be able to hold", () => {
  const bad = { SPEND_CEILING_STROOPS: "50000000", SPONSOR_HARD_FLOOR_STROOPS: "50000000" };

  it("REFUSES to boot on pubnet when the hard floor cannot hold", async () => {
    expect(() => loadConfig({ ...base, ...bad, STELLAR_NETWORK: "pubnet" })).toThrow(
      /hard floor|CANNOT HOLD/i,
    );
  });

  it("warns but boots on testnet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = loadConfig({ ...base, ...bad, STELLAR_NETWORK: "testnet" });
    expect(c.spend.ceilingStroops).toBe(50_000_000);
    expect(warn.mock.calls.map((x) => String(x[0])).join("\n")).toMatch(/CANNOT HOLD/i);
    warn.mockRestore();
  });

  it("accepts a floor that does exceed the ceiling, on pubnet", async () => {
    expect(() =>
      loadConfig({
        ...base,
        STELLAR_NETWORK: "pubnet",
        SPEND_CEILING_STROOPS: "50000000",
        SPONSOR_HARD_FLOOR_STROOPS: "100000000",
      }),
    ).not.toThrow();
  });

  it("the shipped defaults satisfy the invariant on pubnet", async () => {
    // The defaults must not be a configuration the code refuses to run.
    expect(() => loadConfig({ ...base, STELLAR_NETWORK: "pubnet" })).not.toThrow();
  });
});

describe("threshold review — documented rationale, made executable", () => {
  // Each assertion below is a sentence that used to live only in a comment.
  const c = loadConfig(base);
  const perWindow = Math.floor(c.spend.ceilingStroops / c.maxTransactionFeeStroops);

  it("the global ceiling admits 100 settlements per window", async () => {
    // 5 XLM at a 500,000-stroop worst-case fee. If either value moves, this
    // fails and the comment claiming "~N settles/min" gets revisited.
    expect(perWindow).toBe(100);
  });

  it("per-payTo is exactly half the global capacity (the ratchet)", async () => {
    // The point of the ratchet: no single payTo may consume the whole service,
    // and it must be REACHABLE — the shadowed 100 never was.
    expect(c.spend.perPayToMax).toBe(perWindow / 2);
    expect(c.spend.perPayToMax).toBeLessThan(perWindow);
  });

  it("a merchant's single URL cannot exhaust their own payTo budget", async () => {
    expect(c.spend.perUrlMax).toBeLessThan(c.spend.perPayToMax);
  });

  it("the unbound pool equals ONE bound URL's budget (the deliberate 1:1)", async () => {
    // A spray across many unverified URLs gets what one honest merchant gets.
    expect(c.spend.unboundPoolMax).toBe(c.spend.perUrlMax);
  });

  it("the hard floor exceeds one full window of spend", async () => {
    expect(c.balance.hardFloorStroops).toBeGreaterThan(c.spend.ceilingStroops);
  });

  it("the soft floor sits above the hard floor by at least one window", async () => {
    // Otherwise the warning and the refusal arrive at effectively the same time.
    expect(c.balance.softFloorStroops - c.balance.hardFloorStroops).toBeGreaterThanOrEqual(
      c.spend.ceilingStroops,
    );
  });

  it("the fee ceiling stays above both bids — the measured one and the cited one", async () => {
    // NAME THE QUANTITY. This ceiling gates the BID (minResourceFee + BASE_FEE,
    // pre-submission), never the CHARGED fee. 22,579 is the charged figure and
    // is the wrong number for this assertion, however many hashes it carries.
    expect(c.maxTransactionFeeStroops).toBeGreaterThan(32_655); // measured bid, 2 sims
    expect(c.maxTransactionFeeStroops).toBeGreaterThan(127_808); // cited worst case, NO hash
  });

  it("the charged fee is not what this ceiling is sized against", async () => {
    // Pins the distinction that produced two separate errors: the 127,808
    // confusion, and an instruction to re-size everything onto the charged fee.
    // If someone ever "corrects" the ceiling down onto 22,579, this fails.
    const CHARGED = 22_579; // Horizon fee_charged, four settlements, 2026-08-10
    const MEASURED_BID = 32_655; // two independent simulations
    expect(MEASURED_BID).toBeGreaterThan(CHARGED); // simulation over-reserves — normal
    expect(c.maxTransactionFeeStroops).toBeGreaterThan(MEASURED_BID * 10);
  });
});

describe("threshold review — the retired knob announces itself like an escape hatch", () => {
  it("fires on EVERY boot, not once per process", async () => {
    // Same standard as CATALOG_OWNERSHIP_BOOTSTRAP: a warning that fires once
    // and then goes quiet is indistinguishable from a fixed problem. loadConfig
    // must hold no "already warned" state.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) loadConfig({ ...base, SETTLE_RATE_MAX: "30" });
    const hits = warn.mock.calls.filter((x) => /SETTLE_RATE_MAX/.test(String(x[0]))).length;
    expect(hits, "every boot must re-announce it").toBe(3);
    warn.mockRestore();
  });

  it("names the value you set AND the effective limit, not a generic deprecation", async () => {
    // An operator with this in a Render dashboard should read "you set 30, the
    // effective limit is 50" and be able to act without reading the source.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({ ...base, SETTLE_RATE_MAX: "30" });
    const said = warn.mock.calls.map((x) => String(x[0])).join("\n");
    expect(said, "must quote the value they set").toMatch(/\b30\b/);
    expect(said, "must state the EFFECTIVE limit numerically").toMatch(/\b50\b/);
    expect(said, "must name the surviving knob").toMatch(/SETTLE_PER_PAYTO_MAX/);
    warn.mockRestore();
  });
});

// Sweep of every numeric rationale stated in prose elsewhere in the repo. The
// three false comments we found were the ones somebody happened to check; these
// are the rest, pulled in so nothing is load-bearing prose alone.
describe("documented rationale — module constants", () => {
  it("the body limit is DERIVED from the largest real envelope, with ~9.6x margin", async () => {
    // docs/security-audit.md states "3,400 base64 chars (~2.5 KB), ~9.6x margin".
    const ratio = SERVER_LIMITS.defaultBodyLimitBytes / SERVER_LIMITS.measuredMaxEnvelopeChars;
    expect(ratio).toBeGreaterThan(9);
    expect(ratio).toBeLessThan(11);
  });

  it("tombstones outlive entries: the tombstone cap MUST exceed the entry cap", async () => {
    // A tombstone deliberately survives its evicted entry (F3/F11). If the caps
    // were equal, eviction-driven rebinding would freeze bindings before the
    // entry cap was ever reached — the freeze is one-way (G-8), so this is a
    // real invariant, not a preference.
    expect(CATALOG_LIMITS.maxTombstones).toBeGreaterThan(CATALOG_LIMITS.maxEntries);
  });

  it("a DEFINITE re-verify answer is parked far longer than an UNCERTAIN one", async () => {
    // mismatch (24h) vs unverifiable (15min). They must not converge: retrying a
    // definite denial buys nothing but outbound traffic, and it is the brake on
    // the 1:1 amplification the bound-owner gate does not remove (G-1).
    expect(CATALOG_LIMITS.reverifyCooldownMismatchMs).toBeGreaterThanOrEqual(
      CATALOG_LIMITS.reverifyCooldownUnverifiableMs * 24,
    );
  });

  it("the ownership fetch is bounded well inside its own retry floor", async () => {
    // A probe must finish long before the next one is due, or attempts overlap.
    expect(OWNERSHIP_LIMITS.fetchTimeoutMs).toBeLessThan(
      CATALOG_LIMITS.reverifyCooldownUnverifiableMs / 10,
    );
  });

  it("the 402 response cap is generous for a header-borne challenge", async () => {
    // The verdict comes entirely from the PAYMENT-REQUIRED header; the body is
    // cancelled unread. 64 KB must still clear a large multi-accepts challenge.
    expect(OWNERSHIP_LIMITS.maxResponseBytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  it("an asset verdict goes stale far sooner than an ownership verdict", async () => {
    // They answer different questions about different parties: the asset cache
    // (5 min) tracks upstream re-verification, the ownership cooldowns bound
    // outbound probes. If the asset TTL ever exceeded them, a revoked asset
    // would outlive a refuted owner.
    expect(TRUST_LIMITS.defaultCacheTtlMs).toBeLessThan(
      CATALOG_LIMITS.reverifyCooldownMismatchMs,
    );
  });

  it("the persistence debounce stays well under one spend window", async () => {
    // Debounced writes must not let a crash lose a whole window of settlements.
    expect(CATALOG_LIMITS.persistDebounceMs).toBeLessThan(loadConfig(base).spend.windowMs / 100);
  });

  it("per-resource accepts stay far below the entry cap", async () => {
    // MAX_ACCEPTS bounds a single entry's fan-out; it must not approach the
    // catalog-wide cap or one resource could dominate the served payload.
    expect(CATALOG_LIMITS.maxAccepts).toBeLessThan(CATALOG_LIMITS.maxEntries / 100);
  });

  it("a discovery page cannot request the whole catalog", async () => {
    expect(CATALOG_LIMITS.defaultLimit).toBeLessThanOrEqual(CATALOG_LIMITS.maxLimit);
    expect(CATALOG_LIMITS.maxLimit).toBeLessThan(CATALOG_LIMITS.maxEntries);
  });

  it("free-text caps stay ordered: description > serviceName > tag", async () => {
    // These bound what reaches an LLM agent's context (F1). The ordering is the
    // claim: a description is prose, a serviceName is a label, a tag is a word.
    expect(CATALOG_LIMITS.maxDescriptionLen).toBeGreaterThan(CATALOG_LIMITS.maxServiceNameLen);
    expect(CATALOG_LIMITS.maxServiceNameLen).toBeGreaterThan(CATALOG_LIMITS.maxTagLen);
    expect(CATALOG_LIMITS.maxTags * CATALOG_LIMITS.maxTagLen).toBeLessThan(
      CATALOG_LIMITS.maxDescriptionLen * 2,
    );
  });

  it("the per-IP HTTP limit is not looser than the global settle capacity", async () => {
    // Otherwise one IP could saturate the sponsor's whole window on its own.
    const c = loadConfig(base);
    const globalPerWindow = Math.floor(c.spend.ceilingStroops / c.maxTransactionFeeStroops);
    expect(SERVER_LIMITS.defaultRateMaxPerMinute).toBeLessThanOrEqual(globalPerWindow);
  });
});

// G-8's verdict ("stays a policy item, not a Turso prerequisite") rests on a
// numeric argument, so it lives here rather than only in prose. The argument:
// filling MAX_TOMBSTONES requires ~100,000 settlements of NEW urls, each gated
// by the unbound pool and each costing the sponsor a fee — and /settle refuses
// below the hard floor long before the cap is reachable. The sponsor balance,
// not the tombstone cap, is what bounds tombstone growth.
//
// Raise the unbound pool, or drop the hard floor, and that stops being true.
// These assertions fail if either happens, which is the point.
describe("documented rationale — G-8 stays bounded by the sponsor balance", () => {
  const c = loadConfig(base);

  it("filling the tombstone cap is not on a realistic schedule", async () => {
    // THE argument, in one line: new urls are gated by the unbound pool, so the
    // cap is days of SUSTAINED maximum away — and those days cost the sponsor
    // ~1,278 XLM, which the hard floor refuses long before. Widen the pool and
    // the cap comes within reach; that is when G-8 becomes a prerequisite.
    const newUrlsPerDay = c.spend.unboundPoolMax * 60 * 24;
    const daysToFillCap = CATALOG_LIMITS.maxTombstones / newUrlsPerDay;
    expect(daysToFillCap, "cap reachable in under 5 days of max rate — redo the G-8 arithmetic").toBeGreaterThan(5);
  });

  it("new URLs stay gated by the unbound pool, well below global capacity", async () => {
    // Every brand-new url is unbound at settle time, so this pool is the rate
    // limiter on tombstone creation. Widening it toward the global ceiling
    // removes the constraint the G-8 arithmetic depends on.
    const globalPerWindow = Math.floor(c.spend.ceilingStroops / c.maxTransactionFeeStroops);
    expect(c.spend.unboundPoolMax).toBeLessThan(globalPerWindow / 5);
  });

  it("a hard floor is actually set — a zero floor removes the bound entirely", async () => {
    expect(c.balance.hardFloorStroops).toBeGreaterThan(0);
  });
});
