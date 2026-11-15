// The demo seller runs in two places: as a long-lived process (Railway, the local
// walkthrough) and as a Vercel function. The only difference is the last lines of
// seller.mjs: on Vercel it must NOT bind a port and must export the Express app;
// everywhere else it must listen exactly as before. These cases pin both sides.
//
// Hermetic: a stub facilitator answers /health and /supported (all the seller needs
// to boot), the trustline check is skipped, and app.listen is spied on rather than
// bound, so nothing here touches the network or a real port.
import { createServer } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const SELLER_URL = new URL("./seller.mjs", import.meta.url).href;
const ENTRY_URL = new URL("./api/seller.mjs", import.meta.url).href;

let facilitator;

beforeAll(async () => {
  facilitator = createServer((req, res) => {
    if (req.url === "/health") return void res.end("ok");
    if (req.url === "/supported") {
      res.setHeader("content-type", "application/json");
      return void res.end(
        JSON.stringify({
          kinds: [
            { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
          ],
          extensions: [],
          signers: {},
        }),
      );
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("FACILITATOR_URL", `http://127.0.0.1:${facilitator.address().port}`);
  vi.stubEnv("PUBLIC_BASE_URL", "https://seller.example");
  vi.stubEnv("SKIP_TRUSTLINE_CHECK", "1");
  vi.stubEnv("PORT", "4999");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => facilitator.close(resolve));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Import a fresh copy of the seller (it boots at import time) with listen observed, not bound. */
async function bootSeller({ onVercel, url = SELLER_URL }) {
  vi.stubEnv("VERCEL", onVercel ? "1" : "");
  const listen = vi.spyOn(express.application, "listen").mockImplementation(function (_port, callback) {
    callback?.();
    return { close() {} };
  });
  const mod = await import(`${url}?boot=${Math.random()}`);
  return { app: mod.default, listen };
}

/** Serve the exported app on an ephemeral port so a real request goes through it. */
async function request(app, path) {
  // Restore the listen spy first so this helper can really bind.
  vi.restoreAllMocks();
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("on Vercel", () => {
  it("does not bind a port and exports the Express app", async () => {
    const { app, listen } = await bootSeller({ onVercel: true });

    expect(listen).not.toHaveBeenCalled();
    expect(typeof app).toBe("function");
  });

  it("the api/ entry re-exports the same app Vercel will invoke", async () => {
    const { app, listen } = await bootSeller({ onVercel: true, url: ENTRY_URL });

    expect(listen).not.toHaveBeenCalled();
    expect(typeof app).toBe("function");
  });

  it("serves requests through the exported app and advertises the public URL", async () => {
    const { app } = await bootSeller({ onVercel: true });

    const res = await request(app, "/whoami");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe("vellar-seller-demo");
    expect(body.resourceUrl).toBe("https://seller.example/quote");
  });
});

describe("off Vercel (Railway, local walkthrough)", () => {
  it("listens on PORT exactly as before", async () => {
    const { listen } = await bootSeller({ onVercel: false });

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0][0]).toBe(4999);
  });
});
