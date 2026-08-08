import { describe, expect, it, vi } from "vitest";
import { createTrustResolver } from "./trust.js";

// Fix 5 (F4) — trust resolver hardening. The verification API is a trust root:
// validate its response with zod (unexpected shapes → "unknown"), bound it with
// an AbortController timeout and a response-size cap, and never let a malformed
// or hostile response forge a verdict or hang discovery.
//
// KNOWN GAP (flagged, not fixed): the response has no timestamp field, so
// records[0] is still assumed newest. Raising a timestamp field with the API
// owner is required to close this; see the report.

const VERIFIED_HASH = "ab".repeat(32);

function jsonResponse(body: unknown, contentLength?: number): Response {
  return {
    ok: true,
    headers: {
      get: (k: string) => (k.toLowerCase() === "content-length" ? String(contentLength ?? "") : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("Fix 5 — trust resolver hardening", () => {
  it("returns unknown for a non-JSON body instead of throwing", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
      text: async () => "<html>not json</html>",
    }) as unknown as Response);
    const resolver = createTrustResolver({ verificationApiUrl: "https://v/verification", fetchFn });
    expect(await resolver.assetStatus("CASSET")).toBe("unknown");
  });

  it("returns unknown when the response shape is unexpected (schema reject)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ totally: "wrong", shape: 42 }));
    const resolver = createTrustResolver({ verificationApiUrl: "https://v/verification", fetchFn });
    expect(await resolver.assetStatus("CASSET")).toBe("unknown");
  });

  it("returns unknown when the response exceeds the size cap", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ records: [{ status: "verified" }] }, 10 * 1024 * 1024),
    );
    const resolver = createTrustResolver({
      verificationApiUrl: "https://v/verification",
      fetchFn,
      maxResponseBytes: 1024,
    });
    expect(await resolver.assetStatus("CASSET")).toBe("unknown");
  });

  it("aborts and returns unknown when the response is slower than the timeout", async () => {
    const fetchFn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const resolver = createTrustResolver({
      verificationApiUrl: "https://v/verification",
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect(await resolver.assetStatus("CASSET")).toBe("unknown");
  });

  it("still maps a well-formed verified record to verified", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ records: [{ status: "verified", outputHash: VERIFIED_HASH }] }));
    const resolver = createTrustResolver({ verificationApiUrl: "https://v/verification", fetchFn });
    expect(await resolver.assetStatus("CASSET")).toBe("verified");
  });

  it("passes an AbortSignal to fetch (timeout is wired)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ records: [{ status: "failed" }] }));
    const resolver = createTrustResolver({ verificationApiUrl: "https://v/verification", fetchFn });
    await resolver.assetStatus("CASSET");
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.anything() }));
  });
});
