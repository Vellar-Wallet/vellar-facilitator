import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

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
  it("defaults to a single per-payTo budget of 50", () => {
    const c = loadConfig(base);
    expect(c.spend.perPayToMax).toBe(50);
  });

  it("no second per-payTo budget survives on the config object", () => {
    // A retired knob that still parses is the next dead control.
    const c = loadConfig(base);
    expect(Object.keys(c.spend)).not.toContain("rateMax");
  });

  it("announces SETTLE_RATE_MAX as retired instead of silently ignoring it", () => {
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

  it("still honours SETTLE_PER_PAYTO_MAX", () => {
    expect(loadConfig({ ...base, SETTLE_PER_PAYTO_MAX: "7" }).spend.perPayToMax).toBe(7);
  });
});

describe("threshold review — the sponsor floor must be able to hold", () => {
  const bad = { SPEND_CEILING_STROOPS: "50000000", SPONSOR_HARD_FLOOR_STROOPS: "50000000" };

  it("REFUSES to boot on pubnet when the hard floor cannot hold", () => {
    expect(() => loadConfig({ ...base, ...bad, STELLAR_NETWORK: "pubnet" })).toThrow(
      /hard floor|CANNOT HOLD/i,
    );
  });

  it("warns but boots on testnet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = loadConfig({ ...base, ...bad, STELLAR_NETWORK: "testnet" });
    expect(c.spend.ceilingStroops).toBe(50_000_000);
    expect(warn.mock.calls.map((x) => String(x[0])).join("\n")).toMatch(/CANNOT HOLD/i);
    warn.mockRestore();
  });

  it("accepts a floor that does exceed the ceiling, on pubnet", () => {
    expect(() =>
      loadConfig({
        ...base,
        STELLAR_NETWORK: "pubnet",
        SPEND_CEILING_STROOPS: "50000000",
        SPONSOR_HARD_FLOOR_STROOPS: "100000000",
      }),
    ).not.toThrow();
  });

  it("the shipped defaults satisfy the invariant on pubnet", () => {
    // The defaults must not be a configuration the code refuses to run.
    expect(() => loadConfig({ ...base, STELLAR_NETWORK: "pubnet" })).not.toThrow();
  });
});

describe("threshold review — documented rationale, made executable", () => {
  // Each assertion below is a sentence that used to live only in a comment.
  const c = loadConfig(base);
  const perWindow = Math.floor(c.spend.ceilingStroops / c.maxTransactionFeeStroops);

  it("the global ceiling admits 100 settlements per window", () => {
    // 5 XLM at a 500,000-stroop worst-case fee. If either value moves, this
    // fails and the comment claiming "~N settles/min" gets revisited.
    expect(perWindow).toBe(100);
  });

  it("per-payTo is exactly half the global capacity (the ratchet)", () => {
    // The point of the ratchet: no single payTo may consume the whole service,
    // and it must be REACHABLE — the shadowed 100 never was.
    expect(c.spend.perPayToMax).toBe(perWindow / 2);
    expect(c.spend.perPayToMax).toBeLessThan(perWindow);
  });

  it("a merchant's single URL cannot exhaust their own payTo budget", () => {
    expect(c.spend.perUrlMax).toBeLessThan(c.spend.perPayToMax);
  });

  it("the unbound pool equals ONE bound URL's budget (the deliberate 1:1)", () => {
    // A spray across many unverified URLs gets what one honest merchant gets.
    expect(c.spend.unboundPoolMax).toBe(c.spend.perUrlMax);
  });

  it("the hard floor exceeds one full window of spend", () => {
    expect(c.balance.hardFloorStroops).toBeGreaterThan(c.spend.ceilingStroops);
  });

  it("the soft floor sits above the hard floor by at least one window", () => {
    // Otherwise the warning and the refusal arrive at effectively the same time.
    expect(c.balance.softFloorStroops - c.balance.hardFloorStroops).toBeGreaterThanOrEqual(
      c.spend.ceilingStroops,
    );
  });

  it("the fee ceiling stays above the worst settlement actually measured", () => {
    // Worst real settle observed from this sponsor's history: 127,808 stroops.
    expect(c.maxTransactionFeeStroops).toBeGreaterThan(127_808);
  });
});
