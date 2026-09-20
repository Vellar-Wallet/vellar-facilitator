// One-shot, report-only scan: apply assertRoutableResourceUrl (the
// registration-time gate added to stop new unroutable URLs entering the
// catalog) to every ALREADY-cataloged entry, and report which ones would be
// refused if they tried to register today.
//
// WHY THIS EXISTS. The registration gate only protects future writes. It
// says nothing about what is already sitting in the catalog from before it
// existed — and the incident that motivated it (a vela-wallet service
// registering http://localhost:4002/lifecycle/execute) was found by
// accident, during unrelated debugging. This script is the deliberate
// answer to "are there others we haven't noticed yet."
//
// REPORT ONLY. This script never deletes, updates, or touches a single row.
// Purging a bad entry is a separate, explicit, confirmed action (the
// operator runbook's own posture throughout this codebase: never let an
// automated sweep delete on its first run). This prints what it found;
// acting on the findings is a deliberate follow-up.
//
// Uses the SAME BazaarCatalog class the live server runs, not a hand-rolled
// re-parse of the raw payload column — that is the only way to be certain
// this sees resource URLs in EXACTLY the shape they are served in
// (canonicalization, accepts[] merging, MCP-key splitting, everything
// BazaarCatalog.create already does on every real boot), rather than a
// second, subtly-different reader that could disagree with production about
// what is actually cataloged.

import { BazaarCatalog } from "./catalog.js";
import { LibsqlCatalogStore, PROPOSED_TIMINGS, type StoreTimings } from "./store.js";
import { assertRoutableResourceUrl } from "./ownership.js";

/**
 * PROPOSED_TIMINGS' 2s timeoutMs is sized for the SETTLE hot path (2026-08's
 * measured ~250ms Oregon<->Tokyo round trip, 8x headroom) — this script is
 * neither hot-path nor latency-sensitive, it is a one-off maintenance read
 * run manually from wherever an operator happens to be, which can add real
 * first-connection/TLS overhead PROPOSED_TIMINGS was never meant to absorb.
 * A generous, script-appropriate deadline instead of forcing a tight
 * production budget onto an offline read.
 */
const SCAN_TIMINGS: StoreTimings = { ...PROPOSED_TIMINGS, timeoutMs: 15_000 };

const PAGE_SIZE = 100; // catalog.ts's own MAX_LIMIT — list() clamps to this regardless.

interface Finding {
  resourceUrl: string;
  network: string;
  reason: string;
  detail: string;
}

async function main(): Promise<void> {
  // Same narrower-dependency reasoning as src/backfill-embeddings.ts: read
  // CATALOG_DB_URL directly rather than through loadConfig(), which would
  // otherwise demand production signing keys (SPONSOR_SECRET_KEY, 50 funded
  // channel accounts) for a read-only catalog maintenance script that needs
  // neither.
  const catalogDbUrl = process.env.CATALOG_DB_URL;
  const catalogDbAuthToken = process.env.CATALOG_DB_AUTH_TOKEN;
  if (!catalogDbUrl) {
    console.error(
      "[scan] CATALOG_DB_URL is not set — there is no durable catalog to scan. " +
        "An in-memory catalog has nothing to read.",
    );
    process.exit(1);
  }

  const store = new LibsqlCatalogStore(catalogDbUrl, catalogDbAuthToken, SCAN_TIMINGS);

  try {
    // readOnly: true makes BazaarCatalog.create() call store.initReadOnly()
    // internally instead of store.init() — this script never writes
    // anything (see its own header comment), so it should be runnable with
    // a credential that PROVES that, not one that merely permits it.
    // init() always attempts CREATE TABLE / ALTER TABLE regardless of
    // whether anything needs creating, which a genuinely read-only database
    // credential correctly refuses — see store.ts's own doc comment on
    // initReadOnly() for the full account, including the live failure that
    // motivated it, and catalog.ts's doc comment on this option.
    const catalog = await BazaarCatalog.create(store, { readOnly: true });
    if (catalog.catalogFrozen) {
      console.error(
        `[scan] catalog is frozen (${catalog.catalogFrozen}) — ownership could not be loaded. ` +
          `Refusing to scan a catalog whose bindings are unreliable; fix the underlying store issue first.`,
      );
      process.exit(1);
    }

    console.log(`[scan] catalog loaded, ${catalog.size} total entries`);

    const findings: Finding[] = [];
    let scanned = 0;
    let offset = 0;
    for (;;) {
      const page = catalog.list({ limit: PAGE_SIZE, offset });
      for (const item of page.items) {
        scanned++;
        // A resource can advertise MORE THAN ONE network in its accepts[]
        // (the seller demo entry seen live in this catalog carries both
        // stellar:testnet and stellar:pubnet) — check EVERY distinct
        // network the entry actually claims, not just one, since
        // assertRoutableResourceUrl's https-on-pubnet rule is
        // network-specific and a resource could be fine on testnet while
        // unroutable for the pubnet accept sitting right next to it.
        const networks = new Set(item.accepts.map((a) => a.network));
        if (networks.size === 0) networks.add("stellar:testnet"); // no accepts at all — check under the more permissive default
        for (const network of networks) {
          const verdict = assertRoutableResourceUrl(item.resource, network);
          if (!verdict.ok) {
            findings.push({
              resourceUrl: item.resource,
              network,
              reason: verdict.reason,
              detail: verdict.detail,
            });
          }
        }
      }
      if (page.items.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    console.log(`[scan] ${scanned} entries checked, ${findings.length} unroutable finding(s)`);
    if (findings.length > 0) {
      console.log("");
      console.log("[scan] UNROUTABLE ENTRIES — none of these were touched, this is a report only:");
      for (const f of findings) {
        console.log(`  ${f.resourceUrl}`);
        console.log(`    network: ${f.network}`);
        console.log(`    reason:  ${f.reason}`);
        console.log(`    detail:  ${f.detail}`);
      }
      console.log("");
      console.log(
        "[scan] To act on a finding, use operator-runbook.md's own manual procedures " +
          "(direct Turso access) — this script deliberately does not delete anything itself.",
      );
      process.exitCode = 1; // non-zero so a CI/cron invocation notices findings exist
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(`[scan] fatal: ${String((err as Error)?.message ?? err)}`);
  process.exit(1);
});
