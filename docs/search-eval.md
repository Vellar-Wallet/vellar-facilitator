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

**Last measured: 10/10** on the implementation at the head of this branch.

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

## How to run it

```sh
npm test
```

The cases above are covered by `src/catalog.test.ts` → *"search quality —
synonyms, stemming, trust ranking"*. **A failing test there is a search-quality
regression**, not a flaky test — each one carries the mutation that would break
it, so the failure names its own cause.

## What this is not

This is a **lexical** eval: synonyms and stemming, hand-tuned to one catalog. It
is not semantic search, and passing 10/10 here does not mean the RFP's search
requirement is met. A query using none of the mapped terms — "something to stop
my agent replaying a request" — still returns nothing, because no token matches
and no embedding exists to bridge the gap.

Semantic ranking with embeddings, a vector index, and NDCG/MRR over a much
larger query set remains item 3 on the pre-mainnet checklist
(`technical-doc.md` §9). This table is the baseline that change will be measured
against — the point of writing it down now is that the comparison exists later.
