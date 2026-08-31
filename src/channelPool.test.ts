import { describe, expect, it } from "vitest";
import { ChannelPool, isPoolExhaustedError } from "./channelPool.js";

function addresses(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `GADDR${i}`);
}

describe("ChannelPool", () => {
  it("acquire succeeds when the pool has addresses", () => {
    const pool = new ChannelPool(addresses(3));
    const a = pool.acquire();
    expect(addresses(3)).toContain(a);
    expect(pool.status()).toEqual({ available: 2, inUse: 1, disabled: 0 });
  });

  it("acquire on an empty pool throws pool_exhausted with retryable: true", () => {
    const pool = new ChannelPool(addresses(1));
    pool.acquire();
    expect(() => pool.acquire()).toThrowError();
    try {
      pool.acquire();
      expect.unreachable("acquire() should have thrown on an exhausted pool");
    } catch (err) {
      expect(isPoolExhaustedError(err)).toBe(true);
      if (isPoolExhaustedError(err)) {
        expect(err.code).toBe("pool_exhausted");
        expect(err.retryable).toBe(true);
      }
    }
  });

  it("release returns an address to available", () => {
    const pool = new ChannelPool(addresses(2));
    const a = pool.acquire();
    expect(pool.status()).toEqual({ available: 1, inUse: 1, disabled: 0 });
    pool.release(a);
    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });
  });

  it("release is idempotent on an already-available address", () => {
    const pool = new ChannelPool(addresses(2));
    // Never acquired at all — releasing it anyway must not throw or corrupt state.
    expect(() => pool.release("GADDR0")).not.toThrow();
    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });

    // Acquire-then-release-twice: the second release is a no-op, not an error.
    const a = pool.acquire();
    pool.release(a);
    expect(() => pool.release(a)).not.toThrow();
    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });
  });

  it("release() with a string that was never a pool member does nothing", () => {
    // Security regression test: release() used to admit ANY string into
    // `available` unconditionally, silently growing the pool past its
    // configured size. "GNOTAMEMBER" is not one of the 50 addresses this
    // pool was constructed with.
    const pool = new ChannelPool(addresses(50));
    expect(() => pool.release("GNOTAMEMBER")).not.toThrow();

    // Pool size stays exactly 50 — not 51.
    const status = pool.status();
    expect(status.available + status.inUse + status.disabled).toBe(50);
    expect(status).toEqual({ available: 50, inUse: 0, disabled: 0 });

    // The bogus address must never become acquirable — acquiring all 50
    // real addresses must exhaust the pool, never yielding the bogus one.
    const acquired = new Set<string>();
    for (let i = 0; i < 50; i++) acquired.add(pool.acquire());
    expect(acquired.has("GNOTAMEMBER")).toBe(false);
    expect(acquired.size).toBe(50);
    expect(() => pool.acquire()).toThrowError();
  });

  it("disable moves an address to disabled, and acquire never returns it", () => {
    const pool = new ChannelPool(addresses(2));
    pool.disable("GADDR0");
    expect(pool.status()).toEqual({ available: 1, inUse: 0, disabled: 1 });

    // Only one address left to give out — acquiring it must never be the
    // disabled one, no matter how many times we ask.
    for (let i = 0; i < 5; i++) {
      const a = pool.acquire();
      expect(a).toBe("GADDR1");
      pool.release(a);
    }
  });

  it("disable on an in-use address moves it straight to disabled", () => {
    const pool = new ChannelPool(addresses(2));
    const a = pool.acquire();
    pool.disable(a);
    expect(pool.status()).toEqual({ available: 1, inUse: 0, disabled: 1 });
    // Releasing a disabled address must not silently re-enable it.
    pool.release(a);
    expect(pool.status()).toEqual({ available: 1, inUse: 0, disabled: 1 });
  });

  it("enable moves a disabled address back to available", () => {
    const pool = new ChannelPool(addresses(2));
    pool.disable("GADDR0");
    pool.enable("GADDR0");
    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });
  });

  it("enable on an address that was never disabled is a no-op", () => {
    const pool = new ChannelPool(addresses(2));
    expect(() => pool.enable("GADDR0")).not.toThrow();
    expect(pool.status()).toEqual({ available: 2, inUse: 0, disabled: 0 });
  });

  it("50 simultaneous acquire() calls each get a distinct address", async () => {
    const pool = new ChannelPool(addresses(50));

    // acquire() itself is synchronous, so there is no real "await" boundary
    // inside it to race across — but driving all 50 through Promise.all,
    // each wrapped in its own resolved-microtask hop, is the closest
    // simulation of "50 concurrent callers all calling acquire() around the
    // same instant" available without a real thread pool, and exercises the
    // exact call pattern the settle() call sites will use (await something,
    // then acquire()). The correctness property under test is not timing —
    // it's that acquire()'s synchronous pop-mark-return body can never be
    // observed half-done by another call, which Promise.all-of-synchronous-
    // calls is sufficient to demonstrate: every one of the 50 results must
    // be unique with none dropped or duplicated.
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => {
        await Promise.resolve();
        return pool.acquire();
      }),
    );

    expect(results).toHaveLength(50);
    expect(new Set(results).size).toBe(50);
    expect(pool.status()).toEqual({ available: 0, inUse: 50, disabled: 0 });

    // And the 51st, with nothing released yet, must reject-fast.
    expect(() => pool.acquire()).toThrowError();
    try {
      pool.acquire();
    } catch (err) {
      expect(isPoolExhaustedError(err)).toBe(true);
    }
  });
});
