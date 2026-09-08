// Unit tests for the pure half of semantic search.
//
// NOTHING HERE CALLS THE VOYAGE API. Every function under test is
// deterministic, which is the point of keeping the text construction, the
// similarity maths and the rank fusion separate from the client: the parts that
// decide RANKING are testable without a network, a key, or a bill, and the part
// that cannot be tested offline is a thin wrapper over one HTTP call.

import { describe, expect, it } from "vitest";
import {
  buildEmbeddingText,
  cosineSimilarity,
  embeddingsEnabled,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
} from "./embeddings.js";
import { rrfScore } from "./catalog.js";

describe("buildEmbeddingText", () => {
  const resource = {
    resource: "https://example.test/qr",
    serviceName: "QR Generator",
    description: "Make a QR code",
    tags: ["qr", "barcode"],
  };

  it("repeats each field at the lexical scorer's weight", () => {
    const text = buildEmbeddingText(resource);
    const occurrences = (needle: string) => text.split(needle).length - 1;
    // The counts are the contract: they mirror scoreResource()'s field weights
    // (serviceName 4, tags 3, description 2, url 1). If the scorer's weights
    // change and these do not, the two halves of the hybrid ranking start
    // disagreeing about which field matters, and RRF fuses two different
    // notions of relevance.
    expect(occurrences("QR Generator")).toBe(4);
    expect(occurrences("qr barcode")).toBe(3);
    expect(occurrences("Make a QR code")).toBe(2);
    expect(occurrences("https://example.test/qr")).toBe(1);
  });

  it("omits absent fields entirely rather than embedding blank lines", () => {
    // A resource with only a url is the minimum the catalog can hold. Padding
    // the text with empty lines for the missing fields would embed structure
    // that carries no meaning and dilute the one field that does.
    const text = buildEmbeddingText({ resource: "https://example.test/bare" });
    expect(text).toBe("https://example.test/bare");
  });

  it("ignores an empty tag array", () => {
    const text = buildEmbeddingText({ ...resource, tags: [] });
    expect(text).not.toContain("\n\n");
    expect(buildEmbeddingText({ ...resource, tags: [] })).not.toBe(buildEmbeddingText(resource));
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is -1 for opposed vectors", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it("ignores magnitude, measuring direction only", () => {
    // The property the ranking depends on: a longer document must not outrank a
    // shorter one merely for being longer.
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1);
  });

  it("returns 0 rather than throwing on mismatched widths", () => {
    // A stored vector of the wrong width is a stale row from a previous model.
    // It must cost that ONE resource its place in the vector ranking, not take
    // down every search that touches it.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 for empty or zero vectors instead of NaN", () => {
    // A zero vector would divide by zero. NaN is the dangerous outcome here:
    // it compares false against everything, so it would sort unpredictably
    // rather than ranking last.
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(Number.isNaN(cosineSimilarity([0, 0], [0, 0]))).toBe(false);
  });
});

describe("rrfScore", () => {
  it("ranks a document better when it appears higher in either list", () => {
    expect(rrfScore(1, 1)).toBeGreaterThan(rrfScore(1, 2));
    expect(rrfScore(1, 5)).toBeGreaterThan(rrfScore(3, 5));
  });

  it("lets a document strong in both lists beat one first in only one", () => {
    // THE DEFINING PROPERTY OF THE FUSION. With k=60 the top of each list is
    // deliberately flat, so a resource ranked 2nd and 2nd beats one ranked 1st
    // and 20th. That is what stops a confident-but-wrong vector hit from
    // displacing a solid lexical result on the strength of a single first
    // place.
    expect(rrfScore(2, 2)).toBeGreaterThan(rrfScore(1, 20));
  });

  it("still surfaces a purely semantic hit carrying a lexical penalty rank", () => {
    // A resource with no lexical match at all (penalty rank 11 in a 10-item
    // list) but ranked 1st by vector must still outscore one that is mediocre
    // in both. This is the case the whole feature exists for: a query sharing
    // no vocabulary with the catalog.
    expect(rrfScore(11, 1)).toBeGreaterThan(rrfScore(9, 9));
  });

  it("is symmetric between the two lists", () => {
    // Neither ranking is privileged over the other by the formula itself.
    expect(rrfScore(3, 7)).toBeCloseTo(rrfScore(7, 3));
  });

  it("honours an explicit k", () => {
    // Smaller k sharpens the top of the list; the default is the paper's 60.
    expect(rrfScore(1, 1, 1)).toBeGreaterThan(rrfScore(1, 1, 60));
  });
});

describe("configuration", () => {
  it("pins the model and its dimension together", () => {
    // These two travel as a pair: a stored vector's width is only meaningful
    // against the model that produced it, and a silent model swap would make
    // every stored embedding incomparable.
    expect(EMBEDDING_MODEL).toBe("voyage-code-3");
    expect(EMBEDDING_DIMENSION).toBe(1024);
  });

  it("reports semantic search as unavailable without a key", () => {
    const previous = process.env.VOYAGE_API_KEY;
    try {
      delete process.env.VOYAGE_API_KEY;
      expect(embeddingsEnabled()).toBe(false);
      process.env.VOYAGE_API_KEY = "test-key";
      expect(embeddingsEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = previous;
    }
  });
});
