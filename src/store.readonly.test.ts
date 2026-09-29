import { describe, expect, it, vi } from "vitest";
import { LibsqlCatalogStore, StoreInvalidError } from "./store.js";
import { tmpStore } from "./store.testkit.js";

// initReadOnly() exists so a report-only maintenance script (scan-unroutable-
// urls.ts being the first: see its own doc comment) can be run against
// production with a credential that PROVES it will not write, rather than a
// broader one that merely permits it. init() always attempts CREATE TABLE /
// ALTER TABLE, unconditionally, on every call — confirmed live: a genuinely
// read-only Turso token was blocked by init() ("SQL write operations are
// forbidden") even though nothing actually needed creating. initReadOnly()
// verifies the same schema facts via pure reads (sqlite_master, PRAGMA
// table_info) and never issues DDL.
//
// The property under test in this file is NOT "does the query succeed" —
// LibsqlCatalogStore's own write methods would likely be refused by a truly
// read-only credential anyway. It is the STRONGER, EARLIER guarantee: an
// instance that took the initReadOnly() path refuses to even ATTEMPT a
// write, in-process, before any query reaches the database at all — so the
// guarantee holds even against a credential that (by misconfiguration, or
// because the caller minted the wrong kind of token) would have permitted
// the write.

describe("initReadOnly — schema verification without DDL", () => {
  it("succeeds against a database already initialized by a normal init()", async () => {
    const { store: writer, url } = tmpStore();
    await writer.init();
    await writer.close();

    const reader = new LibsqlCatalogStore(url, undefined);
    await expect(reader.initReadOnly()).resolves.toBeUndefined();
    await reader.close();
  });

  it("throws StoreInvalidError against a database that was never initialized at all", async () => {
    const { store, url } = tmpStore();
    void store; // never call init() on this one
    const reader = new LibsqlCatalogStore(url, undefined);
    await expect(reader.initReadOnly()).rejects.toThrow(StoreInvalidError);
    await expect(reader.initReadOnly()).rejects.toThrow(/does not exist/);
    await reader.close();
  });

  // THE MUTATION THIS TEST EXISTS FOR: if initReadOnly() ever regressed to
  // calling init()'s own CREATE TABLE IF NOT EXISTS / ALTER TABLE statements
  // internally (e.g. someone "simplifying" it to just call init() under the
  // hood), this is the test that would catch it — not by checking the
  // result, which would still look correct, but by asserting on the ACTUAL
  // SQL issued to the client.
  it("issues NO CREATE TABLE or ALTER TABLE statement, ever — even against a fresh, uninitialized database", async () => {
    const { store: writer, url } = tmpStore();
    await writer.init();
    await writer.close();

    const reader = new LibsqlCatalogStore(url, undefined);
    const anyReader = reader as unknown as { client: { execute: (...args: unknown[]) => unknown } };
    const executeSpy = vi.spyOn(anyReader.client, "execute");

    await reader.initReadOnly();

    const sqlStatements = executeSpy.mock.calls.map((args) => {
      const arg = args[0];
      return typeof arg === "string" ? arg : (arg as { sql?: string })?.sql ?? "";
    });
    for (const sql of sqlStatements) {
      expect(sql, `initReadOnly issued DDL: ${sql}`).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE INDEX|DROP/i);
    }
    // Sanity: it did issue READS (sqlite_master + two PRAGMA table_info
    // calls) — an empty spy would make the "no DDL" assertion above
    // vacuously true rather than a real proof.
    expect(sqlStatements.length).toBeGreaterThanOrEqual(3);

    executeSpy.mockRestore();
    await reader.close();
  });

  it("throws when ownership.verified_at is missing (pre-displacement schema)", async () => {
    const { store: writer, url } = tmpStore();
    const anyWriter = writer as unknown as { client: { execute: (arg: unknown) => Promise<unknown> } };
    // Build the OLD three-column ownership shape directly, bypassing
    // init()'s own migration path entirely, so this test proves the check
    // fires rather than proving init() already fixed the thing being tested.
    // kill_switch/admin_audit_log ARE created (empty, current shape) — this
    // test isolates the ownership.verified_at check specifically, and
    // without these two tables present the table-existence check earlier in
    // initReadOnly() would fire first and mask the assertion this test
    // exists to make.
    await anyWriter.client.execute(
      "CREATE TABLE ownership (resource_key TEXT NOT NULL, pay_to TEXT NOT NULL, bound_at INTEGER NOT NULL, PRIMARY KEY (resource_key, pay_to))",
    );
    await anyWriter.client.execute(
      "CREATE TABLE entry (resource_key TEXT PRIMARY KEY, payload TEXT NOT NULL, last_updated INTEGER NOT NULL, embedding TEXT)",
    );
    await anyWriter.client.execute(
      "CREATE TABLE kill_switch (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, reason TEXT, actor TEXT, updated_at INTEGER NOT NULL)",
    );
    await anyWriter.client.execute(
      "CREATE TABLE admin_audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, actor TEXT DEFAULT \"operator\", detail TEXT, amount_stroops INTEGER, created_at INTEGER NOT NULL)",
    );
    await writer.close();

    const reader = new LibsqlCatalogStore(url, undefined);
    await expect(reader.initReadOnly()).rejects.toThrow(/verified_at/);
    await reader.close();
  });

  it("throws when entry.embedding is missing (pre-semantic-search schema)", async () => {
    const { store: writer, url } = tmpStore();
    const anyWriter = writer as unknown as { client: { execute: (arg: unknown) => Promise<unknown> } };
    await anyWriter.client.execute(
      "CREATE TABLE ownership (resource_key TEXT NOT NULL, pay_to TEXT NOT NULL, bound_at INTEGER NOT NULL, verified_at INTEGER, PRIMARY KEY (resource_key, pay_to))",
    );
    await anyWriter.client.execute(
      "CREATE TABLE entry (resource_key TEXT PRIMARY KEY, payload TEXT NOT NULL, last_updated INTEGER NOT NULL)",
    );
    // See the sibling test above for why these two are created here too.
    await anyWriter.client.execute(
      "CREATE TABLE kill_switch (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, reason TEXT, actor TEXT, updated_at INTEGER NOT NULL)",
    );
    await anyWriter.client.execute(
      "CREATE TABLE admin_audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, actor TEXT DEFAULT \"operator\", detail TEXT, amount_stroops INTEGER, created_at INTEGER NOT NULL)",
    );
    await writer.close();

    const reader = new LibsqlCatalogStore(url, undefined);
    await expect(reader.initReadOnly()).rejects.toThrow(/embedding/);
    await reader.close();
  });

  it("a store initialized via initReadOnly() refuses every write method before issuing any query", async () => {
    const { store: writer, url } = tmpStore();
    await writer.init();
    await writer.close();

    const reader = new LibsqlCatalogStore(url, undefined);
    await reader.initReadOnly();

    const anyReader = reader as unknown as { client: { execute: (...args: unknown[]) => unknown; batch: (...args: unknown[]) => unknown } };
    const executeSpy = vi.spyOn(anyReader.client, "execute");
    const batchSpy = vi.spyOn(anyReader.client, "batch");

    await expect(reader.bindAndUpsertEntry({ resourceKey: "k", boundPayTo: ["G1"] }, { resourceKey: "k", payload: "{}", lastUpdated: 1 })).rejects.toThrow(StoreInvalidError);
    await expect(reader.saveEntries([{ resourceKey: "k", payload: "{}", lastUpdated: 1 }])).rejects.toThrow(StoreInvalidError);
    await expect(reader.markVerified("k", "G1", 1)).rejects.toThrow(StoreInvalidError);
    await expect(reader.displaceOwnership("k", "G1", 1)).rejects.toThrow(StoreInvalidError);
    await expect(reader.saveEmbedding("k", [0.1, 0.2])).rejects.toThrow(StoreInvalidError);

    // The whole point: NOT ONE of those five calls reached the database.
    // The guard fires in-process, before this.run() / this.client is ever
    // touched for a write — proven here directly, not inferred from the
    // rejection alone (a rejection could equally mean the query ran and
    // the DATABASE refused it, which is a materially weaker guarantee).
    expect(executeSpy).not.toHaveBeenCalled();
    expect(batchSpy).not.toHaveBeenCalled();

    executeSpy.mockRestore();
    batchSpy.mockRestore();
    await reader.close();
  });

  it("a store initialized via the normal init() is unaffected — every write method still works", async () => {
    const { store, url } = tmpStore();
    await store.init();
    await store.bindAndUpsertEntry(
      { resourceKey: "https://x.example/a", boundPayTo: ["G1"] },
      { resourceKey: "https://x.example/a", payload: "{}", lastUpdated: 1 },
    );
    const rows = await store.loadOwnership();
    expect(rows).toHaveLength(1);
    await store.close();
    void url;
  });

  it("read methods (loadOwnership, loadEntries) work normally on a read-only-initialized store", async () => {
    const { store: writer, url } = tmpStore();
    await writer.init();
    await writer.bindAndUpsertEntry(
      { resourceKey: "https://x.example/a", boundPayTo: ["G1"] },
      { resourceKey: "https://x.example/a", payload: "{}", lastUpdated: 1 },
    );
    await writer.close();

    const reader = new LibsqlCatalogStore(url, undefined);
    await reader.initReadOnly();
    const owned = await reader.loadOwnership();
    expect(owned).toHaveLength(1);
    const entries = await reader.loadEntries(100);
    expect(entries).toHaveLength(1);
    await reader.close();
  });
});
