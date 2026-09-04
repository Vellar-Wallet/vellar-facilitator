import { describe, expect, it, vi } from "vitest";
import { ChannelPool } from "./channelPool.js";
import { CONSECUTIVE_FAILURE_LIMIT, createChannelMonitor, truncateAddress } from "./channelMonitor.js";

// Channel-account balance monitor.
//
// WHAT THESE TESTS ARE REALLY GUARDING. disable()/enable() were implemented,
// exported and unit-tested from the day the pool shipped, and had zero
// production callers — so the pool's own tests passed while the behaviour they
// describe never once happened in production. These tests assert the CALLER:
// that a real balance reading actually moves an account in and out of rotation.
//
// The fail-open posture is the subtle half. BalanceGuard fails open because
// refusing settlement on a flaky read is self-inflicted downtime. Here the risk
// inverts — disabling on an unreadable balance would let one Horizon outage
// empty all 50 lanes — so a failed check changes nothing until a per-account run
// of CONSECUTIVE_FAILURE_LIMIT failures. Tests 5-8 pin that boundary exactly.

const ADDRS = ["GAAAA1111111111111111111111111111111111111111111111111111", "GBBBB2222222222222222222222222222222222222222222222222222"];
const FLOOR = 5_000_000; // 5 XLM

/** Captures every line the monitor logs, so a test can assert on content
 *  (truncation) rather than only on behaviour. */
function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
}

/** A monitor over a REAL ChannelPool — the pool is the thing under test as much
 *  as the monitor is, so it is never mocked. `balances` maps address -> either a
 *  stroop reading or an Error to throw. */
function build(balances: Map<string, number | Error>, addresses: readonly string[] = ADDRS) {
  const pool = new ChannelPool([...addresses]);
  const logger = recordingLogger();
  const fetchBalanceStroops = vi.fn(async (address: string) => {
    const v = balances.get(address);
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error("no reading configured");
    return v;
  });
  const monitor = createChannelMonitor({
    pool,
    addresses,
    fetchBalanceStroops,
    floorStroops: FLOOR,
    intervalMs: 60_000,
    logger,
  });
  return { pool, monitor, logger, fetchBalanceStroops };
}

/** Disabled count, read off the pool's own status — the pool never exposes
 *  WHICH addresses are disabled, so behaviour is asserted through acquire(). */
const disabledCount = (pool: ChannelPool) => pool.status().disabled;

describe("channel monitor — disable / enable transitions", () => {
  it("1. disables an account whose balance is below the floor", async () => {
    const { pool, monitor } = build(new Map<string, number | Error>([[ADDRS[0]!, 1_000_000], [ADDRS[1]!, 50_000_000]]));
    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });

    await monitor.checkAll();

    expect(pool.status()).toEqual({ available: 1, inUse: 0, disabled: 1 });
    // And the disabled one is genuinely unacquirable: the only address acquire()
    // can return is the healthy one, twice over would exhaust the pool.
    expect(pool.acquire()).toBe(ADDRS[1]);
    expect(() => pool.acquire()).toThrow();
  });

  it("2. re-enables an account once its balance recovers above the floor", async () => {
    const balances = new Map<string, number | Error>([[ADDRS[0]!, 1_000_000], [ADDRS[1]!, 50_000_000]]);
    const { pool, monitor } = build(balances);

    await monitor.checkAll();
    expect(disabledCount(pool)).toBe(1);

    balances.set(ADDRS[0]!, 9_000_000); // re-funded
    await monitor.checkAll();

    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });
  });

  it("3. does not call disable() again for an already-disabled account", async () => {
    const { pool, monitor, logger } = build(new Map<string, number | Error>([[ADDRS[0]!, 1_000_000], [ADDRS[1]!, 50_000_000]]));
    const spy = vi.spyOn(pool, "disable");

    await monitor.checkAll();
    await monitor.checkAll();
    await monitor.checkAll();

    // MUTATION: drop the `!isDisabled` guard. disable() is idempotent so the
    // pool state stays right, but the operator gets one alarming DISABLED line
    // per account per tick — a log nobody reads is a control nobody has.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(logger.lines.filter((l) => l.includes("DISABLED"))).toHaveLength(1);
  });

  it("4. does not call enable() for an account that was never disabled", async () => {
    const { pool, monitor } = build(new Map<string, number | Error>([[ADDRS[0]!, 50_000_000], [ADDRS[1]!, 50_000_000]]));
    const spy = vi.spyOn(pool, "enable");

    await monitor.checkAll();
    await monitor.checkAll();

    expect(spy).not.toHaveBeenCalled();
    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });
  });

  it("a balance exactly AT the floor is healthy — the comparison is strict", async () => {
    // Boundary stated explicitly: `stroops < floor` disables, so == floor does
    // not. Left implicit, a later refactor to <= would silently disable a
    // correctly-funded account.
    const { pool, monitor } = build(new Map<string, number | Error>([[ADDRS[0]!, FLOOR], [ADDRS[1]!, FLOOR]]));
    await monitor.checkAll();
    expect(disabledCount(pool)).toBe(0);
  });
});

describe("channel monitor — fail open, with a staleness bound", () => {
  it("5. a failed check does NOT disable, and increments the failure count", async () => {
    const { pool, monitor } = build(new Map<string, number | Error>([[ADDRS[0]!, new Error("Horizon HTTP 503")], [ADDRS[1]!, 50_000_000]]));

    for (let i = 1; i < CONSECUTIVE_FAILURE_LIMIT; i++) {
      await monitor.checkAll();
      expect(monitor.failureCount(ADDRS[0]!), `after ${i} failure(s)`).toBe(i);
      expect(disabledCount(pool), `still in rotation after ${i} failure(s)`).toBe(0);
    }
  });

  it("6. disables after EXACTLY the limit — not before, not after", async () => {
    const { pool, monitor } = build(new Map<string, number | Error>([[ADDRS[0]!, new Error("boom")], [ADDRS[1]!, 50_000_000]]));

    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT - 1; i++) await monitor.checkAll();
    expect(disabledCount(pool), "one short of the limit").toBe(0);

    await monitor.checkAll(); // the Nth failure
    expect(disabledCount(pool), "at the limit").toBe(1);
    expect(monitor.failureCount(ADDRS[0]!)).toBe(CONSECUTIVE_FAILURE_LIMIT);
  });

  it("7. a successful check resets the failure count to zero", async () => {
    const balances = new Map<string, number | Error>([[ADDRS[0]!, new Error("boom")], [ADDRS[1]!, 50_000_000]]);
    const { monitor } = build(balances);

    await monitor.checkAll();
    await monitor.checkAll();
    expect(monitor.failureCount(ADDRS[0]!)).toBe(2);

    balances.set(ADDRS[0]!, 50_000_000);
    await monitor.checkAll();

    // MUTATION: drop the reset. Two failures a week apart then eventually
    // accumulate to the limit and disable a perfectly healthy account.
    expect(monitor.failureCount(ADDRS[0]!)).toBe(0);
  });

  it("8. an account disabled for staleness is re-enabled once it answers healthily", async () => {
    const balances = new Map<string, number | Error>([[ADDRS[0]!, new Error("boom")], [ADDRS[1]!, 50_000_000]]);
    const { pool, monitor } = build(balances);

    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT; i++) await monitor.checkAll();
    expect(disabledCount(pool)).toBe(1);

    balances.set(ADDRS[0]!, 50_000_000);
    await monitor.checkAll();

    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });
    expect(monitor.failureCount(ADDRS[0]!)).toBe(0);
  });

  it("a stale-disabled account stays disabled while it keeps failing, logged once", async () => {
    const { pool, monitor, logger } = build(new Map<string, number | Error>([[ADDRS[0]!, new Error("boom")], [ADDRS[1]!, 50_000_000]]));

    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT + 4; i++) await monitor.checkAll();

    expect(disabledCount(pool)).toBe(1);
    expect(logger.lines.filter((l) => l.includes("consecutive failed balance"))).toHaveLength(1);
  });
});

describe("channel monitor — logging discipline", () => {
  it("9. never writes a full address — only first4…last4", async () => {
    const balances = new Map<string, number | Error>([[ADDRS[0]!, 1_000_000], [ADDRS[1]!, new Error("boom")]]);
    const { monitor, logger } = build(balances);

    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT; i++) await monitor.checkAll();
    balances.set(ADDRS[0]!, 50_000_000);
    await monitor.checkAll(); // produce a re-enable line too

    expect(logger.lines.length, "precondition: something was logged").toBeGreaterThan(0);
    for (const line of logger.lines) {
      for (const addr of ADDRS) {
        expect(line, `full address leaked: ${line}`).not.toContain(addr);
      }
    }
    expect(logger.lines.some((l) => l.includes(truncateAddress(ADDRS[0]!)))).toBe(true);
  });

  it("truncateAddress keeps a short string intact rather than mangling it", async () => {
    expect(truncateAddress("GABC")).toBe("GABC");
    expect(truncateAddress(ADDRS[0]!)).toBe(`${ADDRS[0]!.slice(0, 4)}…${ADDRS[0]!.slice(-4)}`);
  });

  it("logs balances in XLM, not raw stroops", async () => {
    // 1_000_000 stroops is 0.1 XLM. An operator reading "1000000 is below
    // 5000000" has to do the conversion themselves at exactly the moment they
    // are least inclined to.
    const { monitor, logger } = build(new Map<string, number | Error>([[ADDRS[0]!, 1_000_000], [ADDRS[1]!, 50_000_000]]));
    await monitor.checkAll();
    const line = logger.lines.find((l) => l.includes("DISABLED"))!;
    expect(line).toContain("0.1000 XLM");
    expect(line).not.toContain("1000000 stroops");
  });
});

describe("channel monitor — lifecycle", () => {
  it("10. stop() prevents further checks", async () => {
    vi.useFakeTimers();
    try {
      const { monitor, fetchBalanceStroops } = build(new Map<string, number | Error>([[ADDRS[0]!, 50_000_000], [ADDRS[1]!, 50_000_000]]));
      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // let the immediate first pass run
      const afterFirst = fetchBalanceStroops.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(fetchBalanceStroops.mock.calls.length, "no checks after stop()").toBe(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent — a second call does not double the interval", async () => {
    vi.useFakeTimers();
    try {
      const { monitor, fetchBalanceStroops } = build(new Map<string, number | Error>([[ADDRS[0]!, 50_000_000], [ADDRS[1]!, 50_000_000]]));
      monitor.start();
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      const afterStart = fetchBalanceStroops.mock.calls.length;

      await vi.advanceTimersByTimeAsync(60_000);
      // One tick's worth of checks (2 accounts), not two ticks' worth.
      expect(fetchBalanceStroops.mock.calls.length - afterStart).toBe(ADDRS.length);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("channel monitor — hostile and malformed readings", () => {
  it("11. a malformed reading (NaN) is treated as a failure, not as healthy", async () => {
    // THE TRAP: NaN < floor is FALSE, so an unguarded comparison reads a
    // malformed response as "above the floor" and leaves a possibly-empty
    // account in rotation. It must count as a failed check instead.
    const { pool, monitor } = build(new Map<string, number | Error>([[ADDRS[0]!, Number.NaN], [ADDRS[1]!, 50_000_000]]));

    await monitor.checkAll();
    expect(monitor.failureCount(ADDRS[0]!), "counted as a failure").toBe(1);
    expect(disabledCount(pool), "not disabled yet — fail open").toBe(0);
    expect(monitor.lastKnownBalance(ADDRS[0]!), "no balance recorded").toBeUndefined();

    for (let i = 1; i < CONSECUTIVE_FAILURE_LIMIT; i++) await monitor.checkAll();
    expect(disabledCount(pool), "disabled once the run reaches the limit").toBe(1);
  });

  it("12. a negative balance is below the floor and disables the account", async () => {
    const { pool, monitor } = build(new Map<string, number | Error>([[ADDRS[0]!, -1], [ADDRS[1]!, 50_000_000]]));
    await monitor.checkAll();
    expect(disabledCount(pool)).toBe(1);
  });

  it("one account's failure does not stop the others being checked", async () => {
    // Sequential iteration must not let a thrown reading abort the pass — the
    // other 49 accounts would silently stop being monitored.
    const { pool, monitor, fetchBalanceStroops } = build(
      new Map<string, number | Error>([[ADDRS[0]!, new Error("boom")], [ADDRS[1]!, 1_000_000]]),
    );
    await monitor.checkAll();
    expect(fetchBalanceStroops).toHaveBeenCalledTimes(2);
    expect(disabledCount(pool), "the healthy-path account was still evaluated").toBe(1);
  });
});
