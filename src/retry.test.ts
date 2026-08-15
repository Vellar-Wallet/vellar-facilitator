import { describe, expect, it, afterEach } from "vitest";
import { LEDGER_SKEW_REASON, withSkewRetry, __setSkewRetryDelayForTest } from "./retry.js";

describe("withSkewRetry — one reason, one retry, nothing relaxed", () => {
  afterEach(() => __setSkewRetryDelayForTest());

  it("retries the skew rejection once and returns the recovery", async () => {
    __setSkewRetryDelayForTest(async () => {});
    let n = 0;
    const out = await withSkewRetry(
      async () => (++n === 1 ? { invalidReason: LEDGER_SKEW_REASON } : { isValid: true }),
      (r) => (r as { invalidReason?: string }).invalidReason,
      () => {},
    );
    expect(n).toBe(2);
    expect((out as { isValid?: boolean }).isValid).toBe(true);
  });

  it("does NOT retry any other rejection — a real 'no' stays fast", async () => {
    let n = 0;
    const out = await withSkewRetry(
      async () => (++n, { invalidReason: "invalid_exact_stellar_payload_wrong_amount" }),
      (r) => (r as { invalidReason?: string }).invalidReason,
      () => {},
    );
    expect(n).toBe(1);
    expect((out as { invalidReason: string }).invalidReason).toContain("wrong_amount");
  });

  it("is bounded: a persistent skew stops after SKEW_RETRY_MAX", async () => {
    __setSkewRetryDelayForTest(async () => {});
    let n = 0;
    await withSkewRetry(
      async () => (++n, { invalidReason: LEDGER_SKEW_REASON }),
      (r) => (r as { invalidReason?: string }).invalidReason,
      () => {},
    );
    expect(n, "1 attempt + 1 retry").toBe(2);
  });
});
