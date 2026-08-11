import { describe, expect, it, vi } from "vitest";
import { BalanceGuard } from "./balance.js";

// Fix 3 — sponsor balance guard. Periodically checks the sponsor account's XLM
// balance: warn-log below a soft floor, refuse /settle (503) below a hard floor.
// Must not block startup, must not take the service down if the check fails, and
// must keep serving discovery even when settle is refused.

const XLM = 10_000_000; // stroops per XLM (7 decimals)

function guard(opts: {
  balances: Array<string | Error>;
  softFloorStroops?: number;
  hardFloorStroops?: number;
}) {
  let i = 0;
  const fetchBalance = vi.fn(async () => {
    const v = opts.balances[Math.min(i++, opts.balances.length - 1)];
    if (v instanceof Error) throw v;
    return v as string;
  });
  const g = new BalanceGuard({
    fetchBalanceStroops: fetchBalance,
    softFloorStroops: opts.softFloorStroops ?? 10 * XLM,
    hardFloorStroops: opts.hardFloorStroops ?? 2 * XLM,
    intervalMs: 60_000,
  });
  return { g, fetchBalance };
}

describe("BalanceGuard", () => {
  it("allows settle when balance is above the hard floor", async () => {
    const { g } = guard({ balances: [String(50 * XLM)] });
    await g.refresh();
    expect(g.settleAllowed()).toBe(true);
    expect(g.status()).toBe("ok");
  });

  it("still allows settle but reports 'low' below the soft floor", async () => {
    const { g } = guard({ balances: [String(5 * XLM)] });
    await g.refresh();
    expect(g.settleAllowed()).toBe(true);
    expect(g.status()).toBe("low");
  });

  it("refuses settle below the hard floor", async () => {
    const { g } = guard({ balances: [String(1 * XLM)] });
    await g.refresh();
    expect(g.settleAllowed()).toBe(false);
    expect(g.status()).toBe("critical");
  });

  it("fails OPEN (allows settle) when the balance check errors — no self-inflicted outage", async () => {
    const { g } = guard({ balances: [new Error("horizon down")] });
    await g.refresh(); // must not throw
    expect(g.settleAllowed()).toBe(true);
    expect(g.status()).toBe("unknown");
  });

  it("starts in an allow/unknown state before the first check (does not block startup)", async () => {
    const { g, fetchBalance } = guard({ balances: [String(1 * XLM)] });
    // No refresh() called yet.
    expect(g.settleAllowed()).toBe(true);
    expect(g.status()).toBe("unknown");
    expect(fetchBalance).not.toHaveBeenCalled();
  });

  it("recovers to allowed after balance is refilled", async () => {
    const { g } = guard({ balances: [String(1 * XLM), String(50 * XLM)] });
    await g.refresh();
    expect(g.settleAllowed()).toBe(false);
    await g.refresh();
    expect(g.settleAllowed()).toBe(true);
  });
});
