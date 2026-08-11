import { describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { readOwnership, seedRows, tmpStore } from "./store.testkit.js";

// ============================================================================
// The bootstrap hatch is GONE, and this file is what stops it coming back.
//
// G-7 was: CATALOG_OWNERSHIP_BOOTSTRAP derived bindings from the catalog file
// and never wrote them, so the migration appeared to succeed, persisted nothing,
// and the next boot failed closed again.
//
// The hatch existed for ONE reason: an ownership FILE could be absent while a
// catalog FILE was present, and that state is ambiguous between "first upgrade
// from a version with no ownership store" and "someone deleted it". Fail-closed
// was correct, so the migration had to be opted into explicitly.
//
// A single database cannot be half-present. The ambiguity has nowhere to live,
// so the hatch, the flag, and G-7 with them, are deleted rather than ported.
//
// These tests assert the DELETION, because a deleted escape hatch that quietly
// comes back as a no-op is worse than one that never left: an operator would
// set it, see no error, and believe a migration ran.
// ============================================================================

const SECRET = "SBUCR6H22CZC5OYHBJIEUS2JFZBOB63AHEGTCV6UEPMD2TMLKG2ZMIW4";

describe("the ownership bootstrap hatch no longer exists", () => {
  it("CATALOG_OWNERSHIP_BOOTSTRAP is loudly ignored, never silently accepted", async () => {
    // MUTATION THAT MUST BREAK THIS: drop the warning branch in config.ts and
    // let the variable be ignored silently. The test then sees zero warnings.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({ SPONSOR_SECRET_KEY: SECRET, CATALOG_OWNERSHIP_BOOTSTRAP: "1" });
    const hits = warn.mock.calls.filter((c) => /CATALOG_OWNERSHIP_BOOTSTRAP/.test(String(c[0])));
    expect(hits.length, "a retired flag must announce itself, not vanish").toBe(1);
    expect(String(hits[0]![0]), "must say it does nothing").toMatch(/NO LONGER EXISTS|IGNORED/);
    warn.mockRestore();
  });

  it("CATALOG_FILE is loudly ignored rather than quietly migrated", async () => {
    // MUTATION: remove the CATALOG_FILE warning. An operator upgrading would
    // then point at their old file, see a healthy boot and an EMPTY catalog, and
    // have nothing telling them why.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({ SPONSOR_SECRET_KEY: SECRET, CATALOG_FILE: "/var/data/bazaar-catalog.json" });
    const hits = warn.mock.calls.filter((c) => /CATALOG_FILE/.test(String(c[0])));
    expect(hits.length).toBe(1);
    expect(String(hits[0]![0])).toMatch(/NO LONGER USED/);
    warn.mockRestore();
  });

  it("an entry with no ownership row is refused, not adopted", async () => {
    // This is the state the hatch used to paper over, and the ONLY way to reach
    // it now is to write the database directly — bindAndUpsertEntry writes both
    // rows in one transaction.
    //
    // MUTATION THAT MUST BREAK THIS: restore the old derivation in
    // bindLoadedEntry (`ownership.set(key, [accepts[0].payTo])`). The entry is
    // then adopted with an invented owner and `isBound` returns true.
    const { url } = tmpStore();
    await seedRows(url, {
      entries: [
        {
          key: "https://squat.example/quote",
          payload: {
            resource: {
              resource: "https://squat.example/quote",
              type: "http",
              x402Version: 2,
              lastUpdated: "2026-08-01T00:00:00.000Z",
              accepts: [
                {
                  scheme: "exact",
                  network: "stellar:testnet",
                  asset: "CASSET",
                  amount: "1",
                  payTo: "GATTACKER",
                },
              ],
            },
            stats: { settlements: 0, payers: [], observed: 0 },
          },
        },
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store } = { store: (await import("./store.testkit.js")).reopen(url) };
    const catalog = await BazaarCatalog.create(store);
    expect(
      catalog.isBound("https://squat.example/quote", "GATTACKER"),
      "a payTo named only by an entry row must never become the owner",
    ).toBe(false);
    expect(
      warn.mock.calls.some((c) => /NO ownership row/.test(String(c[0]))),
      "and it must say so, since this state means the store was written by something else",
    ).toBe(true);
    warn.mockRestore();
  });

  it("a first binding is durable immediately — no flush, no second call", async () => {
    // G-7's actual failure: bound in memory, never written. The binding must be
    // in the store the instant upsertFromPayment resolves.
    //
    // MUTATION THAT MUST BREAK THIS: make bindOwnership fire-and-forget (drop
    // the `await` on store.bindAndUpsertEntry). The row is then absent at the
    // moment this reads it.
    const { store, url } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(
      {
        resourceUrl: "https://api.example.com/weather",
        x402Version: 2,
        discoveryInfo: { input: { type: "http", method: "GET" } },
      } as never,
      {
        scheme: "exact",
        network: "stellar:testnet",
        asset: "CASSET",
        amount: "1",
        payTo: "GOWNER",
        maxTimeoutSeconds: 60,
      } as never,
    );
    const rows = await readOwnership(url);
    expect(rows, "the binding must be durable before anything relies on it").toMatchObject([
      { resourceKey: "https://api.example.com/weather", boundPayTo: ["GOWNER"], everVerified: false },
    ]);
  });
});
