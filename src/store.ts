// Durable catalog storage (libSQL / Turso).
//
// Replaces the JSON-file store. The same code path serves local development
// (`file:` or `file::memory:`) and production (`libsql://…` + auth token), so
// the thing under test is the thing that ships.
//
// WHY THIS EXISTS: the hosted instance has no persistent disk, so every restart
// and every idle spin-down erased the catalog. That is the defect developers
// actually hit. A disk was rejected — it costs money AND activates three dormant
// findings (G-5, G-6, G-7) that a real store closes instead.
//
// THE COST, STATED HERE TOO because this file is what creates it: durable
// bindings mean a squatted URL NO LONGER SELF-HEALS on the next restart. Until
// the displacement variant ships, recovery is the manual operator procedure in
// docs/operator-runbook.md §1. Demonstrated live on 2026-08-11 — see
// docs/brief-turso-migration.md.
//
// ── Two failure classes, deliberately NOT collapsed ────────────────────────
// A file that will not read has been tampered with or deleted: a security event.
// A network store that will not answer is a vendor having a bad ten minutes:
// not one. The old code rendered both as `ownership-unreadable`, which told an
// operator nothing about whether to investigate or wait. They are separate types
// here, and they get different handling: unreachable retries with backoff before
// freezing; invalid freezes immediately.

import { createClient, type Client, type InArgs } from "@libsql/client";

/** The store could not be reached: timeout, DNS, connection reset, 5xx. Transient
 *  by assumption — retried with backoff before the catalog freezes. */
export class StoreUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`catalog store unreachable: ${String((cause as Error)?.message ?? cause)}`);
    this.name = "StoreUnreachableError";
  }
}

/** The store answered, and what came back is not usable: schema missing, a row
 *  that will not parse, a constraint violated. NEVER retried — a second identical
 *  query returns the same bad answer, and the delay only postpones the freeze. */
export class StoreInvalidError extends Error {
  constructor(cause: unknown) {
    super(`catalog store returned something invalid: ${String((cause as Error)?.message ?? cause)}`);
    this.name = "StoreInvalidError";
  }
}

export interface StoredOwnership {
  /** Canonical resource key: origin + pathname, no query (G-3). */
  resourceKey: string;
  boundPayTo: string[];
}

export interface StoredEntryRow {
  resourceKey: string;
  /** The StoredEntry as JSON. Parsed and validated by the catalog's own schema —
   *  a row from the database gets EXACTLY the treatment a wire payload gets, the
   *  F6 trust-boundary rule, which does not weaken just because the bytes now
   *  arrive over a connection instead of from a file. */
  payload: string;
  lastUpdated: number;
}

export interface CatalogStore {
  /** Create tables if absent. Safe to call on every boot. */
  init(): Promise<void>;
  /** Every binding. Throws StoreUnreachableError / StoreInvalidError. */
  loadOwnership(): Promise<StoredOwnership[]>;
  /** Most-recently-updated entries, capped. The LIMIT is what closes G-6 — the
   *  file store enforced MAX_ENTRIES on write but not on load, so a large file
   *  was an unbounded startup memory load. */
  loadEntries(limit: number): Promise<StoredEntryRow[]>;
  /**
   * Establish a binding AND write its entry in ONE transaction.
   *
   * This is the operation the file store could not express. Two files meant a
   * window where a binding existed without its entry, or an entry without its
   * binding — the second being G-5's shape, a URL permanently unclaimable.
   * Inside a transaction neither state is representable rather than merely
   * handled.
   *
   * Rejects on failure; the caller MUST treat a rejection as "not bound".
   */
  bindAndUpsertEntry(binding: StoredOwnership, entry: StoredEntryRow): Promise<void>;
  /** Debounced bulk entry write. Entries are reconstructible from settlement
   *  traffic, so coalescing is safe here and is NOT safe for ownership. */
  saveEntries(rows: StoredEntryRow[]): Promise<void>;
  close(): Promise<void>;
}

// ── Numbers ────────────────────────────────────────────────────────────────
// PROPOSED, pending sign-off (docs/brief-turso-migration.md §7). Collected here
// rather than scattered so the review is one diff, and so nothing acquires a
// second, quietly-different value the way SETTLE_RATE_MAX once shadowed
// SETTLE_PER_PAYTO_MAX.
export interface StoreTimings {
  /** Per-query deadline. */
  timeoutMs: number;
  /** Attempts for an UNREACHABLE store before the catalog freezes. Invalid is
   *  never retried. */
  retryAttempts: number;
  /** Backoff before attempt n (1-indexed from the first retry). */
  retryBackoffMs: number[];
}

export const PROPOSED_TIMINGS: StoreTimings = {
  timeoutMs: 2_000,
  retryAttempts: 3,
  retryBackoffMs: [200, 600, 1_800],
};

/** Anything that is not clearly a bad answer is treated as unreachable, because
 *  the two get different handling and the SAFE misclassification is the one that
 *  retries: retrying a genuinely invalid store costs ~2.6s and then freezes
 *  anyway, while freezing instantly on a transient blip takes discovery down for
 *  a vendor hiccup. */
function classify(err: unknown): StoreUnreachableError | StoreInvalidError {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const invalid =
    msg.includes("no such table") ||
    msg.includes("syntax error") ||
    msg.includes("constraint") ||
    msg.includes("datatype mismatch") ||
    msg.includes("malformed");
  return invalid ? new StoreInvalidError(err) : new StoreUnreachableError(err);
}

const SCHEMA = [
  // Ownership. The security-critical table: a row is the claim that `pay_to`
  // owns `resource_key`.
  //
  // This table IS the tombstone record — see the note in loadOwnership().
  // ONE ROW PER BOUND payTo, not one per URL.
  //
  // Caught by catalog.reverify.test.ts during the migration, and it would have
  // been a serious defect: `boundPayTo` is an ARRAY because the operator
  // rotation procedure (runbook §1) adds the merchant's new address ALONGSIDE
  // the old one — `[OLD, NEW]`. A single `pay_to` column cannot represent that,
  // so the schema would have silently broken the ONLY recovery route a squat
  // has until displacement ships. The composite key is what makes rotation
  // expressible.
  //
  // `bound_at` orders them: the first row is the TOFU winner, later rows are
  // operator-added, and load order must be stable because boundPayTo[0] is
  // treated as the owner.
  `CREATE TABLE IF NOT EXISTS ownership (
     resource_key TEXT NOT NULL,
     pay_to       TEXT NOT NULL,
     bound_at     INTEGER NOT NULL,
     PRIMARY KEY (resource_key, pay_to)
   )`,
  // Catalog entries. Reconstructible from settlement traffic, hence the weaker
  // durability guarantee.
  `CREATE TABLE IF NOT EXISTS entry (
     resource_key TEXT PRIMARY KEY,
     payload      TEXT NOT NULL,
     last_updated INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS entry_last_updated ON entry (last_updated DESC)`,
];

export class LibsqlCatalogStore implements CatalogStore {
  private readonly client: Client;
  private readonly timings: StoreTimings;

  constructor(url: string, authToken: string | undefined, timings: StoreTimings = PROPOSED_TIMINGS) {
    this.client = createClient(authToken ? { url, authToken } : { url });
    this.timings = timings;
  }

  /** One query with a deadline. The deadline matters because libSQL's own
   *  timeout is not guaranteed to be shorter than the settle response we are
   *  holding open. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`store query exceeded ${this.timings.timeoutMs}ms`)),
            this.timings.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      throw classify(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async init(): Promise<void> {
    for (const stmt of SCHEMA) await this.run(() => this.client.execute(stmt));
  }

  /**
   * G-5 CLOSES HERE. The file store had no ownership rows: it re-derived the
   * owner from `accepts[0]` of the loaded entry, so an entry whose accepts array
   * was empty loaded with NO binding and no tombstone — and was then permanently
   * unclaimable, because binding is refused for a URL that already has an entry.
   * Bindings now load from their own table and the derivation stops existing.
   *
   * This table is also the tombstone record. A binding is never deleted, so
   * "has this URL ever been bound" is exactly "is there a row here" — a separate
   * tombstone table would carry the same information under a second name. See
   * the brief for why that stays true when displacement lands.
   */
  async loadOwnership(): Promise<StoredOwnership[]> {
    const res = await this.run(() =>
      this.client.execute("SELECT resource_key, pay_to FROM ownership ORDER BY resource_key, bound_at, rowid"),
    );
    // Grouped, ORDER preserved: boundPayTo[0] is the TOFU winner and is treated
    // as the owner everywhere downstream, so a load that reordered them would
    // silently hand ownership to an operator-added address.
    const byKey = new Map<string, string[]>();
    for (const r of res.rows) {
      const key = r.resource_key;
      const payTo = r.pay_to;
      if (typeof key !== "string" || typeof payTo !== "string") {
        // A row that is not what the schema promises is a bad ANSWER, not an
        // unreachable store: retrying returns the same row.
        throw new StoreInvalidError(new Error("ownership row has a non-string resource_key/pay_to"));
      }
      const list = byKey.get(key);
      if (list) list.push(payTo);
      else byKey.set(key, [payTo]);
    }
    return [...byKey.entries()].map(([resourceKey, boundPayTo]) => ({ resourceKey, boundPayTo }));
  }

  /** G-6 CLOSES HERE: the cap is enforced on the LOAD path by the query itself. */
  async loadEntries(limit: number): Promise<StoredEntryRow[]> {
    const res = await this.run(() =>
      this.client.execute({
        sql: "SELECT resource_key, payload, last_updated FROM entry ORDER BY last_updated DESC LIMIT ?",
        args: [limit],
      }),
    );
    return res.rows.map((r) => {
      const key = r.resource_key;
      const payload = r.payload;
      if (typeof key !== "string" || typeof payload !== "string") {
        throw new StoreInvalidError(new Error("entry row has a non-string resource_key/payload"));
      }
      return { resourceKey: key, payload, lastUpdated: Number(r.last_updated ?? 0) };
    });
  }

  async bindAndUpsertEntry(binding: StoredOwnership, entry: StoredEntryRow): Promise<void> {
    await this.run(async () => {
      const tx = await this.client.transaction("write");
      try {
        await tx.execute({
          sql: "INSERT INTO ownership (resource_key, pay_to, bound_at) VALUES (?, ?, ?)",
          args: [binding.resourceKey, binding.boundPayTo[0] ?? "", Date.now()] as InArgs,
        });
        await tx.execute({
          sql: `INSERT INTO entry (resource_key, payload, last_updated) VALUES (?, ?, ?)
                ON CONFLICT(resource_key) DO UPDATE SET payload = excluded.payload,
                                                        last_updated = excluded.last_updated`,
          args: [entry.resourceKey, entry.payload, entry.lastUpdated] as InArgs,
        });
        await tx.commit();
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }
    });
  }

  async saveEntries(rows: StoredEntryRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.run(() =>
      this.client.batch(
        rows.map((r) => ({
          sql: `INSERT INTO entry (resource_key, payload, last_updated) VALUES (?, ?, ?)
                ON CONFLICT(resource_key) DO UPDATE SET payload = excluded.payload,
                                                        last_updated = excluded.last_updated`,
          args: [r.resourceKey, r.payload, r.lastUpdated] as InArgs,
        })),
        "write",
      ),
    );
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

/**
 * Load with retry — UNREACHABLE only.
 *
 * A file read fails once and stays failed; a network read deserves attempts.
 * But an invalid answer is deterministic, so retrying it just delays the freeze
 * while the catalog is already known to be unusable.
 */
export async function loadWithRetry<T>(
  fn: () => Promise<T>,
  timings: StoreTimings = PROPOSED_TIMINGS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= timings.retryAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err instanceof StoreInvalidError) throw err; // deterministic — do not retry
      if (attempt === timings.retryAttempts) break;
      const backoff = timings.retryBackoffMs[attempt] ?? timings.retryBackoffMs.at(-1) ?? 0;
      console.warn(
        `[store] load attempt ${attempt + 1}/${timings.retryAttempts + 1} failed (${String(
          (err as Error)?.message ?? err,
        )}) — retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw last;
}
