import { describe, expect, it } from "vitest";
import { tmpStore } from "./store.testkit.js";

// ============================================================================
// G-10 — spend_reservation persistence. The three raw store methods, in
// isolation from SpendPolicy's own accounting: saveSpendReservation (upsert,
// written up to three times per settlement's life), loadOpenSpendReservations
// (the boot-time re-seed, window-filtered), deleteElapsedSpendReservations
// (the cleanup that keeps the table from growing unboundedly).
// ============================================================================

describe("saveSpendReservation — upsert, not append", () => {
  it("writing the same id twice REPLACES the row — the second write wins, not a duplicate", async () => {
    // The real sequence this mirrors: reserve at the flat estimate, then
    // adjustReservation down to the real submitted fee. Both writes carry
    // the SAME id; the second must overwrite, not add a second row.
    const { store } = tmpStore();
    await store.init();
    await store.saveSpendReservation({ id: 1, at: 1000, stroops: 500_000, status: "open" });
    await store.saveSpendReservation({ id: 1, at: 1000, stroops: 23_565, status: "open" });

    const loaded = await store.loadOpenSpendReservations(0);
    expect(loaded).toEqual([{ id: 1, at: 1000, stroops: 23_565, status: "open" }]);

    await store.close();
  });

  it("a third write (status change to reconciled) is also a replace, not an add", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.saveSpendReservation({ id: 1, at: 1000, stroops: 500_000, status: "open" });
    await store.saveSpendReservation({ id: 1, at: 1000, stroops: 23_565, status: "open" });
    await store.saveSpendReservation({ id: 1, at: 1000, stroops: 23_000, status: "reconciled" });

    // If the write above had added a row instead of replacing, there would
    // be two rows for id 1 here instead of one.
    const loaded = await store.loadOpenSpendReservations(0);
    expect(loaded).toEqual([{ id: 1, at: 1000, stroops: 23_000, status: "reconciled" }]);

    await store.close();
  });
});

describe("loadOpenSpendReservations — window-filtered, NOT status-filtered", () => {
  it("returns reservations of EVERY status still inside the window — reconciled counts too", async () => {
    // A 'reconciled' row is the SAME real sponsor spend as an 'open' one,
    // just with a more precise number attached — it must keep counting
    // against the ceiling for the rest of its window. Filtering by status
    // would silently stop counting real spend the moment it finishes
    // reconciling, which is backwards.
    const { store } = tmpStore();
    await store.init();
    await store.saveSpendReservation({ id: 1, at: 1000, stroops: 100, status: "open" });
    await store.saveSpendReservation({ id: 2, at: 1000, stroops: 200, status: "reconciled" });
    await store.saveSpendReservation({ id: 3, at: 1000, stroops: 300, status: "unreconcilable" });

    const loaded = await store.loadOpenSpendReservations(0);
    expect(loaded.map((r) => r.id).sort()).toEqual([1, 2, 3]);

    await store.close();
  });

  it("excludes a reservation whose window has already elapsed, even if still open", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.saveSpendReservation({ id: 1, at: 500, stroops: 100, status: "open" }); // old
    await store.saveSpendReservation({ id: 2, at: 2000, stroops: 200, status: "open" }); // recent

    // sinceAt = 1000: only reservations with at > 1000 are "still open".
    const loaded = await store.loadOpenSpendReservations(1000);
    expect(loaded.map((r) => r.id)).toEqual([2]);

    await store.close();
  });

  it("preserves the original window-start time across a restart (does not refresh it)", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await store.saveSpendReservation({ id: 1, at: 1234, stroops: 100, status: "open" });
    await store.close();

    const { reopen } = await import("./store.testkit.js");
    const reopened = reopen(url);
    const loaded = await reopened.loadOpenSpendReservations(0);
    expect(loaded).toEqual([{ id: 1, at: 1234, stroops: 100, status: "open" }]);
    await reopened.close();
  });
});

describe("deleteElapsedSpendReservations — cleanup, not accumulation", () => {
  it("deletes only rows whose window has elapsed, regardless of status", async () => {
    const { store } = tmpStore();
    await store.init();
    await store.saveSpendReservation({ id: 1, at: 500, stroops: 100, status: "open" }); // elapsed
    await store.saveSpendReservation({ id: 2, at: 500, stroops: 200, status: "reconciled" }); // elapsed
    await store.saveSpendReservation({ id: 3, at: 2000, stroops: 300, status: "open" }); // still live

    await store.deleteElapsedSpendReservations(1000);

    // Confirm via loadOpenSpendReservations(0) — only the live one, id 3,
    // should be visible at all (both elapsed rows should be gone, not just
    // filtered by status).
    const remaining = await store.loadOpenSpendReservations(0);
    expect(remaining.map((r) => r.id)).toEqual([3]);

    await store.close();
  });

  it("does not grow unboundedly: repeated save+delete cycles leave the table empty", async () => {
    const { store } = tmpStore();
    await store.init();
    for (let i = 0; i < 50; i++) {
      await store.saveSpendReservation({ id: i, at: 100, stroops: 100, status: "open" });
    }
    await store.deleteElapsedSpendReservations(200);
    const remaining = await store.loadOpenSpendReservations(0);
    expect(remaining).toEqual([]);
    await store.close();
  });
});
