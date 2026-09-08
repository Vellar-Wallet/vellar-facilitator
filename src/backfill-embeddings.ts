// One-shot backfill: embed every catalog entry that has no vector yet.
//
// WHY A SCRIPT AND NOT A BOOT STEP. Embedding the whole catalog is a paid API
// call per entry and takes as long as it takes. Doing it at boot would put an
// unbounded external dependency in front of the server accepting traffic, for a
// feature that is additive to a lexical ranking that already works. So it is
// run deliberately, and it is idempotent: entries that already carry a vector
// are not selected, so re-running it after a partial failure costs only the
// entries that actually still need one.
//
// Safe to run against production while the server is live. Every write is an
// UPDATE of a single nullable column that nothing reads synchronously; a
// running server picks the vectors up on its next restart.

import { LibsqlCatalogStore } from "./store.js";
import { buildEmbeddingText, embeddingsEnabled, embedTexts } from "./embeddings.js";

/** Voyage allows 128 inputs per request; 10 keeps each request small enough
 *  that one failure re-costs almost nothing, and keeps the progress log
 *  meaningful on a catalog of a few dozen entries. */
const BATCH_SIZE = 10;

/**
 * The stored payload is a StoredEntry as JSON — the same bytes the catalog
 * re-validates on load. Only the four fields the embedding text is built from
 * are pulled out here, and each is checked rather than asserted: this is the F6
 * trust boundary, and a row someone else wrote gets the treatment a wire
 * payload gets even though all we do with it is build a string.
 */
function resourceFromPayload(payload: string):
  | { resource: string; serviceName?: string; description?: string; tags?: string[] }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const outer = parsed as Record<string, unknown>;
  // Entries are stored either as a bare DiscoveryResource or wrapped in a
  // StoredEntry with the resource under `resource`. Both shapes are in the
  // database, so both are handled rather than guessed at.
  const inner =
    typeof outer.resource === "object" && outer.resource !== null
      ? (outer.resource as Record<string, unknown>)
      : outer;
  const url = inner.resource;
  if (typeof url !== "string" || url.length === 0) return undefined;
  const tags = Array.isArray(inner.tags)
    ? inner.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  return {
    resource: url,
    ...(typeof inner.serviceName === "string" ? { serviceName: inner.serviceName } : {}),
    ...(typeof inner.description === "string" ? { description: inner.description } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Retry a batch through a 429.
 *
 * MEASURED, NOT ANTICIPATED: a Voyage account without a payment method is
 * limited to 3 requests per minute, and a first run of this script against 19
 * entries hit it on the second batch. Without this the operator's recourse is
 * to keep re-running the script until it happens to fit inside the window,
 * which the idempotence makes safe but tedious and easy to mistake for a
 * permanent failure.
 *
 * Only 429 is retried. A 401 is a bad key, a 400 is a bad request, and both
 * return the same answer on the second attempt — the same reasoning
 * classifyStoreError() applies in store.ts, which retries the transient class
 * and fails fast on the deterministic one.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  // ~21s covers the 3 RPM window with margin. Four attempts is a little over a
  // minute per batch, which is slow but finishes.
  const backoffMs = [21_000, 21_000, 42_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      const rateLimited = message.includes("429");
      const wait = backoffMs[attempt];
      if (!rateLimited || wait === undefined) throw err;
      console.warn(`[backfill] rate limited, waiting ${wait / 1000}s before retrying`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function main(): Promise<void> {
  if (!embeddingsEnabled()) {
    console.error(
      "[backfill] VOYAGE_API_KEY is not set. Set it in .env (the key itself is never logged) and re-run.",
    );
    process.exit(1);
  }

  // CATALOG_DB_URL / CATALOG_DB_AUTH_TOKEN are read DIRECTLY rather than through
  // loadConfig(), and that is a deliberate departure from how server.ts builds
  // the same store.
  //
  // loadConfig() validates the whole SETTLEMENT config: it throws unless
  // SPONSOR_SECRET_KEY and fifty funded CHANNEL_ACCOUNT_SECRET_KEYS are present,
  // because a facilitator that cannot settle should not boot. None of that is
  // true of a backfill. Routing this through loadConfig() would mean an operator
  // needs PRODUCTION SIGNING KEYS in their environment to run a read-mostly
  // catalog maintenance job — handing out settlement credentials for a task that
  // only ever writes one nullable text column. The narrower dependency is the
  // safer one, and it is the same two variables server.ts ultimately passes.
  const catalogDbUrl = process.env.CATALOG_DB_URL;
  const catalogDbAuthToken = process.env.CATALOG_DB_AUTH_TOKEN;
  if (!catalogDbUrl) {
    console.error(
      "[backfill] CATALOG_DB_URL is not set — there is no durable catalog to backfill. " +
        "An in-memory catalog has nothing to write to.",
    );
    process.exit(1);
  }

  const store = new LibsqlCatalogStore(catalogDbUrl, catalogDbAuthToken);
  // init() FIRST: it is what runs the `entry.embedding` migration. Without it a
  // database that predates semantic search has no such column and every query
  // below fails with a diagnosis that points at the wrong thing.
  await store.init();

  try {
    const pending = await store.getEntriesWithoutEmbeddings();
    console.log(`[backfill] ${pending.length} entries without embeddings`);
    if (pending.length === 0) return;

    let embedded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      // Rows whose payload will not yield a resource url are dropped BEFORE the
      // API call, not after: they would otherwise misalign the response array
      // against the batch and attach one entry's vector to another's key.
      const usable: Array<{
        key: string;
        resource: NonNullable<ReturnType<typeof resourceFromPayload>>;
      }> = [];
      for (const row of batch) {
        const resource = resourceFromPayload(row.payload);
        if (resource) {
          usable.push({ key: row.resource_key, resource });
        } else {
          skipped++;
          console.warn(`[backfill] skipping ${row.resource_key}: payload has no usable resource url`);
        }
      }
      if (usable.length === 0) continue;

      try {
        const vectors = await withRateLimitRetry(() =>
          embedTexts(usable.map((u) => buildEmbeddingText(u.resource))),
        );
        // Written one at a time rather than as a batch so a single failing row
        // does not cost the other nine their vectors.
        for (let j = 0; j < usable.length; j++) {
          const vector = vectors[j];
          const key = usable[j]!.key;
          if (!vector) {
            failed++;
            continue;
          }
          await store.saveEmbedding(key, vector);
          embedded++;
        }
        console.log(
          `[backfill] ${Math.min(i + BATCH_SIZE, pending.length)}/${pending.length} processed`,
        );
      } catch (err) {
        failed += usable.length;
        console.error(
          `[backfill] batch starting at ${i} failed (${String((err as Error)?.message ?? err)}) — ` +
            `those entries keep no embedding and will be retried on the next run`,
        );
      }
    }

    console.log(`[backfill] done: ${embedded} embedded, ${skipped} skipped, ${failed} failed`);
    // A non-zero exit on failure so a CI or cron invocation notices. Skipped
    // rows are not a failure: they are entries whose payload genuinely carries
    // nothing to embed.
    if (failed > 0) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(`[backfill] fatal: ${String((err as Error)?.message ?? err)}`);
  process.exit(1);
});
