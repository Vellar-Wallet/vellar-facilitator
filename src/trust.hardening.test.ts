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

  // D7 (audit) — the cap must bound the actual DOWNLOAD, not just check the size
  // after buffering. A hostile API can omit/lie about Content-Length or use
  // chunked encoding, so the streaming read has to stop at the cap itself.
  it("stops reading and returns unknown when a chunked body exceeds the cap without Content-Length", async () => {
    let chunksServed = 0;
    const makeBody = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksServed++;
          if (chunksServed > 1000) return controller.close();
          controller.enqueue(new Uint8Array(1024)); // 1 KB per pull, unbounded
        },
      });
    const fetchFn = vi.fn(async () => {
      const body = makeBody();
      return {
        ok: true,
        headers: { get: () => null }, // no Content-Length at all
        body,
        // A real Response.text() DRAINS the stream — model that, so a
        // buffer-then-check implementation would pull every chunk.
        text: async () => {
          const reader = body.getReader();
          let out = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            out += Buffer.from(value!).toString("utf8");
          }
          return out;
        },
      } as unknown as Response;
    });
    const resolver = createTrustResolver({
      verificationApiUrl: "https://v/verification",
      fetchFn,
      maxResponseBytes: 4096, // 4 KB cap
    });
    expect(await resolver.assetStatus("CASSET")).toBe("unknown");
    // Proves we stopped early rather than draining the whole stream.
    expect(chunksServed).toBeLessThan(50);
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

  // Prompt (Fix 5): "out-of-order records selecting the true latest". newestRecord()
  // sorts by timestamp only when EVERY record carries one, and otherwise falls
  // back to records[0]. Both branches were shipped untested.
  it("selects the true latest when records are out of order and all carry timestamps", async () => {
    const body = {
      records: [
        { status: "failed", timestamp: "2026-08-01T00:00:00Z" }, // older, listed first
        { status: "verified", timestamp: "2026-08-05T00:00:00Z" }, // newest
      ],
    };
    const resolver = createTrustResolver({
      verificationApiUrl: "https://v/verification",
      fetchFn: vi.fn(async () => jsonResponse(body)),
    });
    expect(await resolver.assetStatus("CASSET")).toBe("verified");
  });

  it("falls back to records[0] when no record carries a timestamp", async () => {
    const resolver = createTrustResolver({
      verificationApiUrl: "https://v/verification",
      fetchFn: vi.fn(async () => jsonResponse({ records: [{ status: "verified" }, { status: "failed" }] })),
    });
    expect(await resolver.assetStatus("CB")).toBe("verified");
  });

  it("falls back to records[0] when only SOME records carry a timestamp", async () => {
    // Partial timestamps must not be trusted for ordering.
    const body = {
      records: [{ status: "verified" }, { status: "failed", timestamp: "2026-08-09T00:00:00Z" }],
    };
    const resolver = createTrustResolver({
      verificationApiUrl: "https://v/verification",
      fetchFn: vi.fn(async () => jsonResponse(body)),
    });
    expect(await resolver.assetStatus("CC")).toBe("verified");
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
