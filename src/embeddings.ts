// Vector embeddings for semantic catalog search.
//
// WHY THIS EXISTS: the lexical scorer in catalog.ts scores 10/10 on
// docs/search-eval.md and is not being replaced. What it cannot do is bridge a
// query that shares NO token with any listing — "barcode for a link" against a
// `/qr` endpoint returns an EMPTY list, not a weak ranking, because
// scoreResource() returns 0 and search() drops zeros entirely. That is the gap
// this file closes, and it closes it ALONGSIDE the lexical path rather than in
// place of it: see the RRF fusion in catalog.ts.
//
// EVERY EXPORT HERE IS OPTIONAL AT RUNTIME. With VOYAGE_API_KEY unset the
// catalog is lexical-only and byte-identical to what shipped before, which is
// what makes this safe to deploy before the backfill has run.

import { VoyageAIClient } from "voyageai";

/** voyage-code-3. Chosen over voyage-3 because catalog entries are API
 *  endpoints, tags and developer-facing descriptions, which is the distribution
 *  this model is tuned for. */
export const EMBEDDING_MODEL = "voyage-code-3";

/** Native output width of voyage-code-3. Asserted on every vector we store, so
 *  a model swap that silently changes the width fails loudly at ingest instead
 *  of producing a cosine similarity against mismatched dimensions. */
export const EMBEDDING_DIMENSION = 1024;

/** Voyage caps a single embed request at 128 inputs. The backfill batches at 10,
 *  well inside this, but the guard belongs with the API it constrains. */
const MAX_BATCH = 128;

let client: VoyageAIClient | undefined;

/**
 * The key is read at CALL time, not at module load. Reading it at load would
 * bake in whatever the environment looked like when the module first got
 * imported, which breaks tests that set the variable per-case and makes the
 * unset-key path depend on import order.
 */
function getClient(): VoyageAIClient {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set — semantic search is unavailable. Set it to enable embeddings, " +
        "or leave it unset to run lexical-only search.",
    );
  }
  if (!client) client = new VoyageAIClient({ apiKey });
  return client;
}

/** Whether semantic search can run at all. Callers use this to stay on the
 *  lexical-only path rather than catching a throw per query. */
export function embeddingsEnabled(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

/** The subset of a catalog resource the embedding text is built from. Structural
 *  rather than importing DiscoveryResource, so this module stays independent of
 *  the catalog's wire types and is trivially testable. */
export interface EmbeddableResource {
  resource: string;
  serviceName?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * Flatten a resource into the text that gets embedded.
 *
 * FIELDS ARE REPEATED, NOT CONCATENATED ONCE, and the repetition counts mirror
 * the lexical scorer's field weights exactly (serviceName 4, tags 3,
 * description 2, url 1 — see scoreResource() in catalog.ts). Repetition is how
 * you express field weighting to a bag-of-text embedding model, which has no
 * notion of fields: a term appearing four times pulls the document vector
 * further toward that term's region than one appearing once.
 *
 * Keeping the two weightings identical is deliberate. If lexical and vector
 * disagreed about which field matters most, the RRF fusion would be blending
 * two rankings built on different notions of relevance, and a regression in one
 * would be untraceable from the other.
 */
export function buildEmbeddingText(resource: EmbeddableResource): string {
  const serviceName = resource.serviceName?.trim() ?? "";
  const tags = (resource.tags ?? []).join(" ").trim();
  const description = resource.description?.trim() ?? "";
  const url = resource.resource.trim();

  const parts: string[] = [];
  const repeat = (text: string, times: number) => {
    if (!text) return;
    for (let i = 0; i < times; i++) parts.push(text);
  };
  repeat(serviceName, 4);
  repeat(tags, 3);
  repeat(description, 2);
  repeat(url, 1);
  return parts.join("\n");
}

/**
 * Pull the vectors out of a Voyage response.
 *
 * EVERY FIELD ON THE RESPONSE IS OPTIONAL in the SDK's own types — `data`,
 * `embedding` and `index` are all `?`. So this validates rather than asserts:
 * a truncated or reshaped response becomes a clear throw at the boundary
 * instead of `undefined` propagating into a cosine similarity and returning
 * NaN, which would silently rank every resource identically.
 *
 * Ordered by `index` rather than trusting array order, because the API
 * documents the field precisely so that order need not be relied on.
 */
function extractEmbeddings(data: Array<{ embedding?: number[]; index?: number }> | undefined, expected: number): number[][] {
  if (!data || data.length !== expected) {
    throw new Error(
      `voyage returned ${data?.length ?? 0} embeddings for ${expected} inputs`,
    );
  }
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((item, i) => {
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`voyage returned no embedding for input ${i}`);
    }
    if (vector.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `voyage returned a ${vector.length}-dimension embedding, expected ${EMBEDDING_DIMENSION} ` +
          `(model ${EMBEDDING_MODEL}) — a stored vector of the wrong width cannot be compared`,
      );
    }
    return vector;
  });
}

/**
 * Embed catalog documents. `inputType: "document"` is not cosmetic: Voyage
 * embeds documents and queries into deliberately asymmetric positions, and
 * embedding a document as a query measurably degrades retrieval.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > MAX_BATCH) {
    throw new Error(`embedTexts received ${texts.length} inputs, the API maximum is ${MAX_BATCH}`);
  }
  const response = await getClient().embed({
    input: texts,
    model: EMBEDDING_MODEL,
    inputType: "document",
  });
  return extractEmbeddings(response.data, texts.length);
}

/** Embed a search query. `inputType: "query"` — see embedTexts() for why the
 *  asymmetry matters. */
export async function embedQuery(query: string): Promise<number[]> {
  const response = await getClient().embed({
    input: [query],
    model: EMBEDDING_MODEL,
    inputType: "query",
  });
  const [vector] = extractEmbeddings(response.data, 1);
  if (!vector) throw new Error("voyage returned no embedding for the query");
  return vector;
}

/**
 * Cosine similarity, computed in ONE pass rather than three.
 *
 * Voyage returns L2-normalised vectors, so the denominator is ~1 and a plain
 * dot product would very nearly do. It is computed properly anyway: the
 * normalisation is a property of the current model, not a guarantee of the
 * interface, and a model swap that dropped it would otherwise turn every score
 * into an unnormalised magnitude with no error to trace it by.
 *
 * Mismatched lengths return 0 rather than throwing. A stored vector of the
 * wrong width is a stale row from a previous model, and one bad row must not
 * take down every search that touches it — it simply ranks last.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
