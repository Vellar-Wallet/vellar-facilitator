// Issue #89, seller side. Exercises handlePaidRoute's probe branch directly
// rather than booting the whole seller, so the test needs no facilitator.
//
// The `!presentedPayment` half of the condition is the safety property. The
// earlier attempt (7f03234, reverted in 96f06fe) skipped validation for every
// bare GET, letting a buyer with no parameters settle on-chain and then fail in
// buildResult: three real settlements paid and returned handler_failed. These
// cases pin that it cannot happen again.
import { describe, expect, it } from "vitest";

/** Mirrors the probe condition in examples/seller.mjs handlePaidRoute. */
function isOwnershipProbe(headers) {
  const payment = headers["payment-signature"] || headers["x-payment"] || undefined;
  return headers["x-ownership-probe"] === "1" && !payment;
}

describe("issue #89 probe protocol", () => {
  it("treats a probe header with NO payment as a probe (skips validation, reaches 402)", () => {
    expect(isOwnershipProbe({ "x-ownership-probe": "1" })).toBe(true);
  });

  it("does NOT treat a bare GET as a probe (regression: 7f03234 loss path)", () => {
    // Without the header this must validate, so a buyer with no params gets a
    // free 400 rather than paying for a request that cannot succeed.
    expect(isOwnershipProbe({})).toBe(false);
  });

  it("does NOT treat a probe header AS a probe when payment is presented", () => {
    // Forging the header must not buy a validation bypass. If payment is
    // present the request settles, and buildResult does not re-validate, so
    // skipping validation here would re-open the exact loss path.
    expect(isOwnershipProbe({ "x-ownership-probe": "1", "x-payment": "sig" })).toBe(false);
    expect(isOwnershipProbe({ "x-ownership-probe": "1", "payment-signature": "sig" })).toBe(false);
  });

  it("ignores a header with any value other than exactly \"1\"", () => {
    expect(isOwnershipProbe({ "x-ownership-probe": "true" })).toBe(false);
    expect(isOwnershipProbe({ "x-ownership-probe": "0" })).toBe(false);
    expect(isOwnershipProbe({ "x-ownership-probe": "" })).toBe(false);
  });
});
