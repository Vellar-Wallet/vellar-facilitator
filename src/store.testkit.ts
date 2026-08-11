// Test-only helpers for the durable catalog store.
//
// Everything here runs against a REAL libSQL database (a temp file, or
// `file::memory:`), not a mock. That is deliberate: the bugs this migration can
// introduce — a transaction that does not roll back, a write that is not awaited,
// a LIMIT that does not apply — are exactly the ones a hand-written fake would
// implement correctly by accident.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LibsqlCatalogStore,
  StoreUnreachableError,
  type CatalogStore,
  type StoredEntryRow,
  type StoredOwnership,
} from "./store.js";

/** A store on a fresh temp file. Survives across BazaarCatalog instances, so it
 *  can model a RESTART — which `file::memory:` cannot, because the database dies
 *  with the client. */
export function tmpStore(): { store: LibsqlCatalogStore; url: string } {
  const url = `file:${join(mkdtempSync(join(tmpdir(), "catalog-store-")), "catalog.db")}`;
  return { store: new LibsqlCatalogStore(url, undefined), url };
}

/** A second client onto the SAME database — the restart. */
export function reopen(url: string): LibsqlCatalogStore {
  return new LibsqlCatalogStore(url, undefined);
}

/**
 * Wraps a real store and fails the chosen operation. Used for failure injection:
 * the point is to prove the CALLER's behaviour when a write does not commit, so
 * everything else must stay real.
 */
export class FailingStore implements CatalogStore {
  constructor(
    private readonly inner: CatalogStore,
    private readonly failOn: {
      bind?: boolean;
      loadOwnership?: () => unknown;
      loadEntries?: boolean;
    },
  ) {}
  /** Bind attempts that reached the store, whether or not they were allowed. */
  bindAttempts = 0;

  init(): Promise<void> {
    return this.inner.init();
  }
  loadOwnership(): Promise<StoredOwnership[]> {
    if (this.failOn.loadOwnership) return Promise.reject(this.failOn.loadOwnership());
    return this.inner.loadOwnership();
  }
  loadEntries(limit: number): Promise<StoredEntryRow[]> {
    if (this.failOn.loadEntries) return Promise.reject(new StoreUnreachableError(new Error("entries down")));
    return this.inner.loadEntries(limit);
  }
  bindAndUpsertEntry(binding: StoredOwnership, entry: StoredEntryRow): Promise<void> {
    this.bindAttempts++;
    if (this.failOn.bind) return Promise.reject(new StoreUnreachableError(new Error("write refused")));
    return this.inner.bindAndUpsertEntry(binding, entry);
  }
  saveEntries(rows: StoredEntryRow[]): Promise<void> {
    return this.inner.saveEntries(rows);
  }
  markVerified(resourceKey: string, payTo: string, at: number): Promise<void> {
    return this.inner.markVerified(resourceKey, payTo, at);
  }
  displaceOwnership(resourceKey: string, newPayTo: string, at: number): Promise<void> {
    return this.inner.displaceOwnership(resourceKey, newPayTo, at);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Write rows DIRECTLY, bypassing the catalog — the crafted-data equivalent of
 * the old crafted-CATALOG_FILE tests. The F6 trust boundary did not disappear
 * when storage moved: a row someone else wrote gets exactly the treatment a wire
 * payload gets, and that has to be provable.
 */
export async function seedRows(
  url: string,
  rows: { ownership?: { key: string; payTo: string }[]; entries?: { key: string; payload: unknown }[] },
): Promise<void> {
  const s = new LibsqlCatalogStore(url, undefined);
  await s.init();
  const anyStore = s as unknown as { client: import("@libsql/client").Client };
  for (const o of rows.ownership ?? []) {
    await anyStore.client.execute({
      sql: "INSERT OR REPLACE INTO ownership (resource_key, pay_to, bound_at) VALUES (?, ?, ?)",
      args: [o.key, o.payTo, 1],
    });
  }
  for (const e of rows.entries ?? []) {
    await anyStore.client.execute({
      sql: "INSERT OR REPLACE INTO entry (resource_key, payload, last_updated) VALUES (?, ?, ?)",
      args: [e.key, typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload), 1],
    });
  }
  await s.close();
}

/** Read ownership rows back, for "the write actually committed" assertions. */
export async function readOwnership(url: string): Promise<StoredOwnership[]> {
  const s = new LibsqlCatalogStore(url, undefined);
  await s.init();
  const rows = await s.loadOwnership();
  await s.close();
  return rows;
}
