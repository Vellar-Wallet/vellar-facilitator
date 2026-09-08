// The embedding column: migration, round trip, and the degradation behaviour
// that keeps a bad vector from taking down search.
//
// These use a real libSQL file store rather than a mock, for the same reason
// the rest of store.durability.test.ts does: the thing under test is the SQL
// and the migration, and a mock of the store would assert only that the mock
// was called.

import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { tmpStore, reopen } from "./store.testkit.js";

const KEY = "https://api.merchant.example/quote";

async function seedEntry(url: string, key = KEY): Promise<void> {
  const client = createClient({ url });
  await client.execute({
    sql: "INSERT INTO entry (resource_key, payload, last_updated) VALUES (?, ?, ?)",
    args: [key, JSON.stringify({ resource: { resource: key } }), Date.now()],
  });
  client.close();
}

describe("entry.embedding", () => {
  it("round-trips a vector through the store", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await seedEntry(url);

    const vector = [0.1, -0.25, 0.5];
    await store.saveEmbedding(KEY, vector);

    // Reopened, so this proves the value is DURABLE rather than cached in the
    // client that wrote it.
    const fresh = reopen(url);
    const loaded = await fresh.loadEmbeddings();
    expect(loaded).toEqual([{ resource_key: KEY, embedding: vector }]);
    await store.close();
    await fresh.close();
  });

  it("adds the column to a database created before semantic search shipped", async () => {
    const { url } = tmpStore();
    // The pre-migration shape, created WITHOUT init() so the column genuinely
    // does not exist. This is the state every existing deployment is in.
    const client = createClient({ url });
    await client.execute(
      `CREATE TABLE entry (resource_key TEXT PRIMARY KEY, payload TEXT NOT NULL, last_updated INTEGER NOT NULL)`,
    );
    await client.execute({
      sql: "INSERT INTO entry (resource_key, payload, last_updated) VALUES (?, ?, ?)",
      args: [KEY, "{}", Date.now()],
    });
    client.close();

    const store = reopen(url);
    await store.init();

    // MUTATION THIS CATCHES: dropping the PRAGMA check in init(). Without the
    // migration this call fails with "no such column: embedding", which
    // classifyStoreError treats as DETERMINISTIC and therefore never retries —
    // so the catalog freezes rather than degrading to lexical-only.
    await expect(store.getEntriesWithoutEmbeddings()).resolves.toEqual([
      { resource_key: KEY, payload: "{}" },
    ]);
    await store.close();
  });

  it("is idempotent across repeated init calls", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await store.init();
    await seedEntry(url);
    await expect(store.getEntriesWithoutEmbeddings()).resolves.toHaveLength(1);
    await store.close();
  });

  it("excludes an entry once it has a vector, so the backfill is idempotent", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await seedEntry(url);

    expect(await store.getEntriesWithoutEmbeddings()).toHaveLength(1);
    await store.saveEmbedding(KEY, [1, 2, 3]);
    // Re-running the backfill must cost nothing. If this regressed, every run
    // would re-embed the whole catalog and be billed for it.
    expect(await store.getEntriesWithoutEmbeddings()).toHaveLength(0);
    await store.close();
  });

  it("is a no-op for a resource with no entry row", async () => {
    const { store } = tmpStore();
    await store.init();
    // The fire-and-forget ingest writer races evictToCap() by construction.
    // Losing that race must not throw and must not create a partial row.
    await expect(store.saveEmbedding("https://gone.example/x", [1, 2])).resolves.toBeUndefined();
    expect(await store.loadEmbeddings()).toEqual([]);
    await store.close();
  });

  it("skips an unparseable vector instead of failing the whole load", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await seedEntry(url, KEY);
    await seedEntry(url, "https://api.merchant.example/other");
    await store.saveEmbedding(KEY, [1, 2, 3]);

    // A row written by something else, or by an older build. Deliberately
    // different from how loadEntries() treats a bad row: an unparseable ENTRY
    // is a resource we would serve wrongly, so it fails closed. An unparseable
    // EMBEDDING costs only that resource its place in the vector ranking, and
    // it is still findable lexically. Failing the load would take semantic
    // search down for every resource because of one bad row.
    const client = createClient({ url });
    await client.execute({
      sql: "UPDATE entry SET embedding = ? WHERE resource_key = ?",
      args: ["not json at all", "https://api.merchant.example/other"],
    });
    client.close();

    const loaded = await store.loadEmbeddings();
    expect(loaded).toEqual([{ resource_key: KEY, embedding: [1, 2, 3] }]);
    await store.close();
  });

  it("rejects a vector whose contents are not finite numbers", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await seedEntry(url);

    const client = createClient({ url });
    // Valid JSON, wrong contents. NaN and nulls would propagate into
    // cosineSimilarity and produce a NaN score, which sorts unpredictably
    // rather than ranking last — a silently corrupt ordering is worse than a
    // missing one.
    await client.execute({
      sql: "UPDATE entry SET embedding = ? WHERE resource_key = ?",
      args: ['[1, null, "x"]', KEY],
    });
    client.close();

    expect(await store.loadEmbeddings()).toEqual([]);
    await store.close();
  });
});
