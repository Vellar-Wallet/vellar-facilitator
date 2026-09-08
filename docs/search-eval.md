# Search eval — ground truth queries

The regression baseline for Bazaar search ranking. Every row below was **run
against the real scorer** before being written down — this is a record of
measured behaviour, not a statement of intent.

Hand-authored against the current demo catalog (8 endpoints on
`vellar-seller-demo`). When real endpoints are added, add rows for them: an eval
set that only covers one seller's demo measures one seller's demo.

## Why these queries

The scorer drops anything scoring 0, so **a query sharing no literal token with
any listing returns nothing at all** — not a weak ranking, an empty list. That
is the failure these queries exist to catch. Each row names the mechanism it
depends on, so a regression tells you *which* mechanism broke rather than only
that something did.

## Ground truth

| Query | Expected top result | Mechanism under test |
| --- | --- | --- |
| `uuid` | `/uuid` | exact match — the control. If this fails, nothing else is meaningful. |
| `unique identifier` | `/uuid` | synonym: `identifier` → `uuid` |
| `verify content` | `/hash` | synonym: `verify` → `hash` |
| `current time` | `/timestamp` | synonym: `time` → `timestamp` |
| `stellar balance` | `/inspect` | synonym: `balance` → `inspect` |
| `encode text` | `/base64` | direct tag hit on `encode` |
| `word analysis` | `/word-count` | synonym: `analysis` → `wordcount` |
| `convert xlm` | `/stroops` | synonym: `convert`/`xlm` → `stroops` |
| `daily saying` | `/quote` | synonym: `saying` → `quote` |
| `motivation` | `/quote` | direct match on tag + description |

**Last measured: 10/10** on the implementation at the head of this branch,
against the 8-endpoint demo catalog. The baseline table further down re-measures
these same ten queries against a larger 19-entry corpus, where they score 9/10 —
the difference is the corpus, not a regression: the extra entries introduce a
competing match for `stellar balance`.

## Beyond top-1

Top-1 is the headline, but two properties matter as much and are covered by
tests rather than by this table:

- **`time converter` must reach BOTH `/timestamp` and `/stroops`** — two
  mechanisms in one query (synonym on `time`, stemming on `converter` →
  `convert`). A scorer that gets top-1 right while dropping the second result is
  worse than the table alone would show.
- **An empty query must rank by trust, not recency**, and must exclude entries
  with no settlements. Undirected browsing surfaces proven endpoints; an
  unproven one earns its place with a settlement. It stays fully findable by any
  directed query.

## The semantic set

Ten queries that share **no token** with any catalog entry. They exist to
measure the gap the lexical eval above cannot see: that table scores 9-10/10
precisely because every one of its queries has a synonym mapping or a stem that
reaches the target, and a query with neither returns an empty list rather than a
weak ranking.

| Query | Expected top result |
| --- | --- |
| `barcode for a link` | `/qr` |
| `change color format` | `/color` |
| `render documentation` | `/markdown` |
| `what changed between versions` | `/diff` |
| `find pattern in string` | `/regex` |
| `filler text for design` | `/lorem` |
| `parse spreadsheet data` | `/csv` |
| `secure login credential` | `/password` |
| `when does this job run` | `/cron` |
| `imperial to metric` | `/units` |

## Methodology

Two rank-aware metrics, both over a single relevant document per query, both
computed by the harness against the **real scorer** rather than by hand.

**MRR (Mean Reciprocal Rank).** For each query, find the rank of the expected
result in the returned list (1-based). Score `1/rank`, or `0` if it is absent
entirely. Average across the query set. MRR answers "how far down the list does
the user have to read", and it rewards moving a result from rank 3 to rank 1
(0.33 to 1.0) far more than from rank 30 to rank 10.

**NDCG@3 (Normalised Discounted Cumulative Gain, cut off at 3).** For each
query, `DCG = 1/log2(rank + 1)` when the expected result appears in the top 3,
else `0`. With exactly one relevant document the ideal ranking puts it first, so
`IDCG = 1/log2(2) = 1` and NDCG is just the DCG. Average across the set. The
cutoff at 3 is the point: an agent calling `/discovery/search` acts on the first
few results, so a correct answer at rank 8 is worth approximately nothing, and
NDCG@3 scores it as such while MRR still gives it 0.125.

The two are reported together because they disagree usefully. MRR rewards deep
recall; NDCG@3 measures whether the answer is actually *usable*. A change that
improves MRR while leaving NDCG@3 flat has moved results up the list without
getting them onto the first screen.

## Baseline vs hybrid

Measured against a 19-entry catalog on the same shape of data, with the same
scorer, changing only whether `VOYAGE_API_KEY` is set.

| Query set | Metric | Lexical (baseline) | Hybrid (RRF) | Change |
| --- | --- | --- | --- | --- |
| Original 10 | top-1 | 9/10 | 9/10 | unchanged |
| Original 10 | MRR | 0.950 | 0.950 | unchanged |
| Original 10 | NDCG@3 | 0.963 | 0.963 | unchanged |
| Semantic 10 | top-1 | 2/10 | **5/10** | +3 |
| Semantic 10 | MRR | 0.264 | **0.717** | +0.453 |
| Semantic 10 | NDCG@3 | 0.263 | **0.789** | +0.526 |

**The original set does not move, and that is the first thing to check.** The
whole risk of adding a second ranking signal is that it degrades the queries the
first one already answers. It does not: all three metrics are identical to the
baseline, and the one query that was not top-1 before (`stellar balance`, which
ranks `/stroops` above `/inspect`) is not top-1 after either. RRF's flat top
(k=60) is what buys this, and the fusion is only consulted at all when a query
vector is available.

**The semantic set is the whole point of the comparison.** Lexical search gets
2/10 top-1 on queries that share no vocabulary with the catalog, and four of the
ten (`secure login credential`, `when does this job run`, `filler text for
design`, `imperial to metric`) return results that do not contain the answer
anywhere in the top 10 — an empty or wrong list, not a weak ranking. The two it
does get are accidents of vocabulary rather than understanding: `change color
format` hits `/color`'s tag `convert`, and `render documentation` hits
`/markdown`'s tag `render`. Several of the misses return a confidently wrong
first result (`barcode for a link` returns `/weather`), which is worse for an
agent than returning nothing.

Under hybrid ranking **every one of the ten reaches the top 3**, which is why
NDCG@3 roughly triples while top-1 only goes from 2 to 5. That gap between the
two metrics is the honest read of this change: it reliably gets the right answer
onto the first screen, and it does not yet reliably get it into first place.
`find pattern in string` still puts `/cron` above `/regex`, and `parse
spreadsheet data` still puts `/weather` above `/csv`. Closing that is a
reranking problem, not a retrieval one.

Caveat on the corpus: these were measured against a 19-entry catalog whose
descriptions were authored for this eval. The relative movement is the
meaningful part; the absolute numbers will shift as real endpoints are added,
and the table should be re-measured when they are.

## Hybrid architecture

Lexical search is **not replaced**. It scores 9/10 on the original set, and
replacing it would risk regressing exactly the queries it already answers well.
The vector ranking is fused alongside it with Reciprocal Rank Fusion:

```
rrf(d) = 1/(k + lexicalRank(d)) + 1/(k + vectorRank(d)),  k = 60
```

Ranks are 1-based, and a document missing from one list is given a penalty rank
of `len(list) + 1` so a purely-semantic hit can still surface. RRF fuses *ranks*
rather than *scores* deliberately: a lexical score is an unbounded sum of field
weights while a cosine similarity is bounded and tightly clustered, so summing
the two raw numbers would let whichever has the larger spread silently dominate.

With `VOYAGE_API_KEY` unset the vector path is skipped entirely and results are
byte-identical to the lexical baseline. That is also true for an empty query,
which is ranked by trust rather than by text and has nothing meaningful to
embed.

**One honest caveat.** `search()` is synchronous, and a query's vector cannot be
fetched without blocking. The first search for a novel query therefore returns
the lexical ranking and warms the vector in the background; the next identical
query is hybrid. The alternative was making `search()` async and paying a Voyage
round trip on every request, which turns a vendor outage into a hung discovery
endpoint instead of a degraded ranking. The numbers above are measured with the
query cache warm.

## How to run it

```sh
npm test
```

The lexical cases are covered by `src/catalog.test.ts` → *"search quality —
synonyms, stemming, trust ranking"*. **A failing test there is a search-quality
regression**, not a flaky test — each one carries the mutation that would break
it, so the failure names its own cause.

Embeddings are backfilled separately, and the job is idempotent (entries that
already carry a vector are not re-embedded):

```sh
npm run backfill-embeddings
```
