import { afterEach, describe, expect, it } from "vitest";
import { __setRotationBusyRetryDelayForTest } from "./store.js";
import { reopen, tmpStore } from "./store.testkit.js";

afterEach(() => {
  __setRotationBusyRetryDelayForTest(undefined);
});

// ============================================================================
// consumeRotationAuthorizationAndDisplace — the one store method that has to
// branch on an intermediate row count, which is why it is an interactive
// transaction rather than this file's usual batch(). Every test here is
// pinned to one of the three outcomes its own doc comment names: marker dead
// on arrival, binding moved out from under a live marker, or both succeed.
// ============================================================================

const KEY = "https://api.merchant.example/quote";
const OLD = "GOLDOWNER00000000000000000000000000000000000";
const NEW = "GNEWOWNER00000000000000000000000000000000000";
const OTHER = "GOTHEROWNER0000000000000000000000000000000000";
const NONCE = "nonce-1";

async function seedOwnership(store: Awaited<ReturnType<typeof tmpStore>>["store"], payTo: string, at = 1) {
  await store.displaceOwnership(KEY, payTo, at);
}

describe("recordRotationAuthorization", () => {
  it("INSERT OR IGNORE: replaying an identical marker does not reset consumed_at", async () => {
    const { store } = tmpStore();
    await store.init();
    const auth = { resourceKey: KEY, oldPayTo: OLD, newPayTo: NEW, nonce: NONCE, settledAt: 1, expiresAt: 1_000_000 };
    await store.recordRotationAuthorization(auth);

    await seedOwnership(store, OLD);
    const consumed = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10);
    expect(consumed).toBe(true);

    // A replayed settlement of the SAME marker must not re-arm it.
    await store.recordRotationAuthorization(auth);
    const row = await store.lookupRotationAuthorization(KEY, OLD, NEW);
    expect(row?.consumedAt, "replay must not clear consumed_at").toBeDefined();

    await store.close();
  });
});

describe("consumeRotationAuthorizationAndDisplace — the three outcomes", () => {
  it("succeeds: marker consumed, ownership moved, in one transaction", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 1_000_000,
    });
    await seedOwnership(store, OLD);

    const result = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10);
    expect(result).toBe(true);

    const owners = await store.loadOwnership();
    const row = owners.find((o) => o.resourceKey === KEY);
    expect(row?.boundPayTo).toEqual([NEW]);

    const marker = await store.lookupRotationAuthorization(KEY, OLD, NEW);
    expect(marker?.consumedAt).toBe(10);

    await store.close();
  });

  it("refuses: marker already consumed — second attempt is a no-op, ownership unchanged", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 1_000_000,
    });
    await seedOwnership(store, OLD);

    const first = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10);
    expect(first).toBe(true);

    // Binding is now NEW. Simulate a second, racing caller that still thinks
    // the marker is live (e.g. it read it before the first call committed).
    const second = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 20);
    expect(second, "an already-consumed marker must refuse, not double-spend").toBe(false);

    const owners = await store.loadOwnership();
    expect(owners.find((o) => o.resourceKey === KEY)?.boundPayTo).toEqual([NEW]);

    await store.close();
  });

  it("refuses: marker expired by the time of consume, even though it was live when looked up", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 100, // expires at t=100
    });
    await seedOwnership(store, OLD);

    const live = await store.lookupRotationAuthorization(KEY, OLD, NEW);
    expect(live && !live.consumedAt && live.expiresAt > 50, "valid at t=50").toBe(true);

    // Consume attempted at t=200 — past expiry.
    const result = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 200);
    expect(result, "expired at consume time must refuse even if valid earlier").toBe(false);

    const owners = await store.loadOwnership();
    expect(owners.find((o) => o.resourceKey === KEY)?.boundPayTo).toEqual([OLD]);

    await store.close();
  });

  it("refuses: no marker ever recorded for this (resourceKey, oldPayTo, newPayTo, nonce)", async () => {
    const { store } = tmpStore();
    await store.init();
    await seedOwnership(store, OLD);

    const result = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10);
    expect(result).toBe(false);

    const owners = await store.loadOwnership();
    expect(owners.find((o) => o.resourceKey === KEY)?.boundPayTo).toEqual([OLD]);

    await store.close();
  });

  it("refuses: a marker for A->B does not consume or displace when probed as A->C", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 1_000_000,
    });
    await seedOwnership(store, OLD);

    const result = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, OTHER, NONCE, 10);
    expect(result, "a marker scoped to NEW must not authorize a different successor").toBe(false);

    const owners = await store.loadOwnership();
    expect(owners.find((o) => o.resourceKey === KEY)?.boundPayTo).toEqual([OLD]);
    // The original marker is untouched — still consumable by its real successor.
    const marker = await store.lookupRotationAuthorization(KEY, OLD, NEW);
    expect(marker?.consumedAt).toBeUndefined();

    await store.close();
  });

  it("refuses and rolls back: the binding changed to a THIRD party between lookup and consume", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 1_000_000,
    });
    await seedOwnership(store, OLD);

    // Something else (a concurrent re-verify, or a separate displacement)
    // moves the binding to OTHER before this marker is consumed.
    await store.displaceOwnership(KEY, OTHER, 5);

    const result = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10);
    expect(result, "the owner-row check must read the CURRENT binding, not a stale snapshot").toBe(false);

    const owners = await store.loadOwnership();
    expect(owners.find((o) => o.resourceKey === KEY)?.boundPayTo, "nothing should have moved").toEqual([OTHER]);

    // The WHOLE transaction rolls back, including the consume: the marker
    // stays live. A snapshot that no longer holds might itself be transient
    // (e.g. a concurrent re-verify that could still fail), so burning the
    // marker here would be fail-open — discarding a legitimate rotation's
    // only proof over a race it did not cause.
    const marker = await store.lookupRotationAuthorization(KEY, OLD, NEW);
    expect(marker?.consumedAt, "rollback must restore the marker, not burn it").toBeUndefined();

    await store.close();
  });

  it("concurrent rotations on one marker: exactly one of two simultaneous calls succeeds", async () => {
    __setRotationBusyRetryDelayForTest((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))));
    const { store } = tmpStore();
    await store.init();
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 1_000_000,
    });
    await seedOwnership(store, OLD);

    const [a, b] = await Promise.all([
      store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10),
      store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 11),
    ]);
    const successes = [a, b].filter(Boolean).length;
    expect(successes, "exactly one concurrent consumer may win one marker").toBe(1);

    const owners = await store.loadOwnership();
    expect(owners.find((o) => o.resourceKey === KEY)?.boundPayTo).toEqual([NEW]);

    await store.close();
  });

  it("survives a restart: a consumed marker and the moved binding are both durable", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 1_000_000,
    });
    await seedOwnership(store, OLD);
    await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10);
    await store.close();

    const reopened = reopen(url);
    const owners = await reopened.loadOwnership();
    expect(owners.find((o) => o.resourceKey === KEY)?.boundPayTo).toEqual([NEW]);
    const marker = await reopened.lookupRotationAuthorization(KEY, OLD, NEW);
    expect(marker?.consumedAt).toBe(10);
    await reopened.close();
  });

  it("a verified entry with a runbook-§1 secondary address is fully replaced, not left with a stale row", async () => {
    const { store } = tmpStore();
    await store.init();
    // Simulate §1: operator-added NEW as a second address alongside OLD.
    await store.displaceOwnership(KEY, OLD, 1); // seeds [OLD]
    // displaceOwnership replaces wholesale, so insert the second row directly
    // the way the real §1 procedure (an INSERT, not a displace) would.
    const anyStore = store as unknown as { client: { execute: (q: unknown) => Promise<unknown> } };
    await anyStore.client.execute({
      sql: "INSERT INTO ownership (resource_key, pay_to, bound_at) VALUES (?, ?, ?)",
      args: [KEY, "GSECONDARY000000000000000000000000000000000", 2],
    });
    await store.recordRotationAuthorization({
      resourceKey: KEY,
      oldPayTo: OLD,
      newPayTo: NEW,
      nonce: NONCE,
      settledAt: 1,
      expiresAt: 1_000_000,
    });

    const result = await store.consumeRotationAuthorizationAndDisplace(KEY, OLD, NEW, NONCE, 10);
    expect(result).toBe(true);

    const owners = await store.loadOwnership();
    expect(
      owners.find((o) => o.resourceKey === KEY)?.boundPayTo,
      "the stale secondary address must not survive the rotation",
    ).toEqual([NEW]);

    await store.close();
  });
});
