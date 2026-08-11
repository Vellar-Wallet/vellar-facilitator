import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { BazaarCatalog } from "./catalog.js";
import {
  classifyStoreError,
  loadWithRetry,
  StoreInvalidError,
  StoreUnreachableError,
  PROPOSED_TIMINGS,
} from "./store.js";
import { FailingStore, readOwnership, reopen, seedRows, tmpStore } from "./store.testkit.js";

// ============================================================================
// The durable-catalog guarantees, each with the MUTATION that must break it.
//
// This repo's history is the argument for that discipline: Layer 2 was
// decorative for its entire life while 22 mocked tests stayed green; F12's
// per-payTo budget never ran because a second limit shadowed it; RA-12 found
// eight tests passing against deliberately broken code; and the first attempt at
// a shadowing test here did not catch the shadow.
//
// A fail-closed path that silently fails OPEN is the exact failure this
// migration exists to prevent, so those tests carry the heaviest mutations.
// ============================================================================

const URL_A = "https://api.merchant.example/quote";

function disc(url = URL_A): DiscoveredResource {
  return {
    resourceUrl: url,
    x402Version: 2,
    discoveryInfo: { input: { type: "http", method: "GET" } },
  } as unknown as DiscoveredResource;
}
function reqs(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CASSET",
    amount: "1",
    payTo,
    maxTimeoutSeconds: 60,
  } as unknown as PaymentRequirements;
}

describe("durable-before-relied-upon (the G-7 guarantee, over a network)", () => {
  it("a binding that failed to persist is NOT established, and the upsert is refused", async () => {
    // THE mutation this whole file exists for:
    //
    //   MUTATION — make the write fire-and-forget in catalog.bindOwnership:
    //     `void this.store.bindAndUpsertEntry(...)` instead of `await`, and
    //     drop the try/catch so failures are ignored.
    //
    //   Under that mutation upsertFromPayment returns TRUE and the URL is bound
    //   in memory with nothing durable behind it. On the next restart the
    //   binding is gone and the URL is open to first-writer claim — G-7 exactly,
    //   with a network in the middle making the window longer, not shorter.
    const { store, url } = tmpStore();
    await store.init();
    const failing = new FailingStore(reopen(url), { bind: true });
    const catalog = await BazaarCatalog.create(failing);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await catalog.upsertFromPayment(disc(), reqs("GOWNER"));

    expect(result, "a refused write must refuse the upsert").toBe(false);
    expect(failing.bindAttempts, "the write was genuinely attempted").toBe(1);
    expect(catalog.isBound(URL_A, "GOWNER"), "nothing may be bound in memory either").toBe(false);
    expect(catalog.size, "and no entry may be served").toBe(0);
    expect(await readOwnership(url), "nothing durable was written").toEqual([]);
    expect(
      err.mock.calls.some((c) => /ownership write FAILED/.test(String(c[0]))),
      "and it must be loud — a silently dropped binding is unobservable",
    ).toBe(true);
    err.mockRestore();
  });

  it("a successful binding is readable from a SECOND client before anything else runs", async () => {
    // MUTATION — move the store write after `this.ownership.set(...)`, or debounce
    // it like entries. The row is then absent at the moment a restart would read
    // it, which is precisely the window that has to not exist.
    //
    // A second client is the point: asserting through the same instance would
    // pass against an in-memory-only implementation.
    const { store, url } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs("GOWNER"));

    const restarted = await BazaarCatalog.create(reopen(url));
    expect(restarted.isBound(URL_A, "GOWNER"), "the binding survived a restart").toBe(true);
  });

  it("entry writes ARE debounced while ownership is not — the asymmetry, asserted", async () => {
    // MUTATION — make save() write immediately (drop the debounce timer). This
    // test then finds the entry row already present and fails.
    //
    // The asymmetry is deliberate: entries are RECONSTRUCTIBLE from settlement
    // traffic, bindings are not. Losing a debounced entry costs a listing until
    // the next settlement; losing a binding reopens the URL to first-writer
    // claim and nothing rebuilds it.
    const { store, url } = tmpStore();
    const catalog = await BazaarCatalog.create(store);
    await catalog.upsertFromPayment(disc(), reqs("GOWNER"));
    // The first catalog writes its entry inside the binding transaction, so use
    // a SECOND upsert — the debounced path — to observe the delay.
    await catalog.upsertFromPayment(
      { ...disc(), description: "changed" } as unknown as DiscoveredResource,
      reqs("GOWNER"),
    );

    const rowsNow = await new (class {
      async read() {
        const s = reopen(url);
        const r = await s.loadEntries(10);
        await s.close();
        return r;
      }
    })().read();
    const persisted = JSON.parse(rowsNow[0]!.payload) as { resource: { description?: string } };
    expect(persisted.resource.description, "the update is still only in memory").not.toBe("changed");

    await catalog.flush();
    const after = await new (class {
      async read() {
        const s = reopen(url);
        const r = await s.loadEntries(10);
        await s.close();
        return r;
      }
    })().read();
    expect(
      (JSON.parse(after[0]!.payload) as { resource: { description?: string } }).resource.description,
      "and lands on flush",
    ).toBe("changed");
  });
});

describe("atomicity — the thing two files could not express", () => {
  it("a failed transaction leaves NEITHER the binding nor the entry", async () => {
    // MUTATION — split bindAndUpsertEntry into two separate execute() calls
    // outside a transaction, and fail the second. The ownership row is then
    // committed without its entry, which is a URL bound to an owner with no
    // listing: unclaimable forever, and invisible.
    const { store, url } = tmpStore();
    await store.init();
    const failing = new FailingStore(reopen(url), { bind: true });
    const catalog = await BazaarCatalog.create(failing);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await catalog.upsertFromPayment(disc(), reqs("GOWNER"));

    const ownership = await readOwnership(url);
    const entries = await (async () => {
      const s = reopen(url);
      const r = await s.loadEntries(10);
      await s.close();
      return r;
    })();
    expect(ownership, "no half-written binding").toEqual([]);
    expect(entries, "and no orphaned entry").toEqual([]);
    vi.restoreAllMocks();
  });

  it("rotation is representable: a URL may carry several bound payTos, in order", async () => {
    // MUTATION — revert the ownership table to `resource_key TEXT PRIMARY KEY`
    // with one pay_to column. The second row cannot be inserted, and the ONLY
    // recovery a squat has before displacement (runbook §1) stops working.
    //
    // Order matters too: boundPayTo[0] is treated as the owner downstream, so a
    // load that reordered them would hand ownership to the operator-added
    // address.
    const { url } = tmpStore();
    await seedRows(url, {
      ownership: [
        { key: URL_A, payTo: "GOLD" },
        { key: URL_A, payTo: "GNEW" },
      ],
    });
    const rows = await readOwnership(url);
    // everVerified false: neither row has been proven, so this binding is still
    // displaceable — an operator rotation is not evidence of ownership.
    expect(rows).toMatchObject([
      { resourceKey: URL_A, boundPayTo: ["GOLD", "GNEW"], everVerified: false },
    ]);
  });
});

describe("fail closed, with the right diagnosis", () => {
  it("an UNREACHABLE store is retried, then freezes as retryable", async () => {
    // MUTATION — freeze on the first error (delete the retry loop). A vendor
    // blip then takes discovery down until someone restarts, which is the
    // self-inflicted outage the retry exists to avoid.
    let attempts = 0;
    const sleeps: number[] = [];
    await expect(
      loadWithRetry(
        () => {
          attempts++;
          return Promise.reject(new StoreUnreachableError(new Error("down")));
        },
        PROPOSED_TIMINGS,
        async (ms) => {
          sleeps.push(ms);
        },
      ),
    ).rejects.toBeInstanceOf(StoreUnreachableError);

    expect(attempts, "first attempt plus the approved 3 retries").toBe(4);
    // Pinned deliberately. The first step is 500ms, not 200ms, because the
    // baseline round trip to Tokyo is ~250ms and a 200ms backoff retried before
    // a merely-slow network could have answered.
    expect(sleeps, "the approved backoff, in order").toEqual([500, 1000, 2000]);
  });

  it("an INVALID store is never retried — the same query returns the same bad answer", async () => {
    // MUTATION — retry StoreInvalidError alongside unreachable. Attempts go to 4
    // and the freeze is delayed ~2.6s while the catalog is already known to be
    // unusable. Worse, it reads as a transient to whoever is watching.
    let attempts = 0;
    await expect(
      loadWithRetry(
        () => {
          attempts++;
          return Promise.reject(new StoreInvalidError(new Error("no such table: ownership")));
        },
        PROPOSED_TIMINGS,
        async () => {},
      ),
    ).rejects.toBeInstanceOf(StoreInvalidError);
    expect(attempts, "exactly once").toBe(1);
  });

  it("an EXPIRED or revoked token is not misdiagnosed as a transient outage", async () => {
    // MUTATION — remove the auth terms from classifyStoreError in store.ts. An
    // expired token becomes StoreUnreachableError: retried three times (useless
    // — it fails identically every time) and then reported as
    // `ownership-unreachable`, whose operator instruction is "usually transient,
    // restart once it answers". That instruction is WRONG, and it would be read
    // during an outage. The fix is to mint a new token, not to wait.
    //
    // Turso issues database tokens with optional expirations, so this is a real
    // state rather than a hypothetical. Tested at classifyStoreError because
    // that is the unit that makes the decision — asserting it through a stubbed
    // store would only prove the stub returns what it was told to.
    for (const msg of [
      "Unauthorized: token expired",
      "401 authentication required",
      "403 Forbidden",
    ]) {
      expect(classifyStoreError(new Error(msg)), msg).toBeInstanceOf(StoreInvalidError);
    }
    // ...and the genuinely transient ones must stay retryable, or the retry that
    // exists to survive a vendor blip stops running.
    for (const msg of ["connect ETIMEDOUT", "socket hang up", "ECONNRESET", "502 Bad Gateway"]) {
      expect(classifyStoreError(new Error(msg)), msg).toBeInstanceOf(StoreUnreachableError);
    }
  });

  it("a frozen catalog still lets settlement proceed — it refuses CATALOGING, not payments", async () => {
    // MUTATION — make the freeze check throw instead of returning false from
    // upsertFromPayment. The throw escapes onAfterSettle and a store outage
    // starts failing PAYMENTS, converting a discovery problem into a money
    // problem. That inversion is the reason fail-closed is survivable at all.
    const { store, url } = tmpStore();
    await store.init();
    const failing = new FailingStore(reopen(url), {
      loadOwnership: () => new StoreUnreachableError(new Error("down")),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const catalog = await BazaarCatalog.create(failing);
    expect(catalog.catalogFrozen).toBe("ownership-unreachable");

    await expect(catalog.upsertFromPayment(disc(), reqs("GANY"))).resolves.toBe(false);
    // recordSettlement is the settlement-side call; it must not throw either.
    expect(() => catalog.recordSettlement(URL_A, "CPAYER", "GANY")).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe("round trips — the cost that only shows up across an ocean", () => {
  it("a first binding costs exactly ONE request, not an interactive transaction", async () => {
    // MUTATION — restore the interactive form: `client.transaction("write")`,
    // two execute()s, commit(). This test then counts 4 calls instead of 1, and
    // sees a transaction() opened.
    //
    // Why a test and not a comment: the difference is invisible locally, where
    // four round trips cost microseconds. It is only expensive at distance, and
    // an in-datacenter test run would never notice a regression back to the
    // chatty form. With the database in Tokyo and the service in Oregon
    // (~250ms), four round trips is ~1s of a 2s timeout spent on protocol.
    const { store, url } = tmpStore();
    await store.init();
    const inner = reopen(url) as unknown as { client: Record<string, unknown> };
    const calls: string[] = [];
    const real = inner.client;
    inner.client = new Proxy(real, {
      get(target, prop: string) {
        const v = (target as Record<string, unknown>)[prop];
        if (typeof v === "function" && ["batch", "execute", "transaction"].includes(prop)) {
          return (...args: unknown[]) => {
            calls.push(prop);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return v;
      },
    }) as Record<string, unknown>;

    await (inner as unknown as { bindAndUpsertEntry: typeof store.bindAndUpsertEntry }).bindAndUpsertEntry(
      { resourceKey: URL_A, boundPayTo: ["GOWNER"] },
      { resourceKey: URL_A, payload: "{}", lastUpdated: 1 },
    );

    expect(calls, "one batch, no interactive transaction").toEqual(["batch"]);
    // ...and it is still atomic: the batch really wrote both rows.
    expect(await readOwnership(url)).toMatchObject([
      { resourceKey: URL_A, boundPayTo: ["GOWNER"], everVerified: false },
    ]);
  });
});

describe("G-6 — the entry cap is enforced on the LOAD path", () => {
  it("loads at most `limit` entries, newest first", async () => {
    // MUTATION — drop the `LIMIT ?` from loadEntries. All rows load, which is
    // the unbounded startup allocation G-6 describes: the file store enforced
    // MAX_ENTRIES on write and never on read, so a large store was a boot-time
    // memory problem nobody had bounded.
    const { url } = tmpStore();
    const keys = Array.from({ length: 12 }, (_, i) => `https://m${i}.example/quote`);
    await seedRows(url, {
      ownership: keys.map((k) => ({ key: k, payTo: "GOWNER" })),
      entries: keys.map((k) => ({
        key: k,
        payload: {
          resource: {
            resource: k,
            type: "http",
            x402Version: 2,
            lastUpdated: "2026-08-01T00:00:00.000Z",
            accepts: [
              { scheme: "exact", network: "stellar:testnet", asset: "CASSET", amount: "1", payTo: "GOWNER" },
            ],
          },
          stats: { settlements: 0, payers: [], observed: 0 },
        },
      })),
    });
    const store = reopen(url);
    const rows = await store.loadEntries(5);
    await store.close();
    expect(rows.length, "the query caps it, not the caller").toBe(5);

    const catalog = await BazaarCatalog.create(reopen(url), { maxEntries: 5 });
    expect(catalog.size).toBe(5);
  });
});
