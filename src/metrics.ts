// Operational telemetry — Tranche 1 deliverable 1.2
// (scf-form-response.md: "metrics + structured logging, 10+ named metrics",
// success criterion "10+ metrics live-verified"). Design: this is the
// registry + metric-definition module; src/server.ts's own /metrics route
// (a later step) is the only thing that reads from it, via the exported
// functions below — server.ts never imports prom-client directly, so every
// place a metric is touched is a readable, named function call, not a raw
// prom-client method call scattered through route handlers.
//
// EXPLICIT REGISTRY, NOT prom-client's GLOBAL DEFAULT: prom-client ships a
// module-level singleton (`client.register`) that every metric registers
// into unless told otherwise. Using it here would mean any test that
// imports this module — even indirectly, even just to typecheck a type —
// registers real metrics into a process-wide singleton that outlives the
// test and collides with the next test's own metric registration attempt
// (prom-client throws on a duplicate metric name in the same registry).
// A `new Registry()` instance owned entirely by this module is a page from
// src/rpcstatus.ts and src/channelPool.ts's own book: state that a test can
// construct fresh and throw away, never a shared global two unrelated test
// files could stomp on.
//
// prom-client@15.1.3 IS DEPRECATED BY ITS OWN MAINTAINERS in favor of
// @prometheus-io/client — a deliberate, reviewed decision to still build on
// it for Tranche 1 (see BUILD-PLAN.md's own follow-up item): the
// replacement was pre-1.0 (v0.16.1, 4 published versions) at the time this
// was written, too immature to build a grant deliverable on with
// confidence, while prom-client itself has 0 known vulnerabilities and
// remains the de facto standard in production Node.js code. Migration is a
// tracked post-Tranche-1 item, not forgotten.

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

/** Owned entirely by this module — see the file-level comment above for why
 *  this is a fresh instance, never prom-client's own global default
 *  registry. Exported so src/server.ts's /metrics route can call
 *  `registry.metrics()` to render the Prometheus text-format response —
 *  the one place outside this file that legitimately needs the registry
 *  object itself, everything else uses the named functions below. */
export const registry = new Registry();

// Node.js process metrics (event loop lag, heap, GC pauses, CPU, file
// descriptors, etc.) — a near-zero-effort addition once the registry
// exists, and the convention every Prometheus-consuming tool (Grafana
// Cloud included) expects a real Node.js service to expose. Confirmed
// deliberate, not incidental: named separately from the 11 metrics below,
// which are what the grant's "10+ named metrics" criterion is actually
// counted against.
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// 1. vellar_settle_total — counter, label: outcome (success|failure)
// ---------------------------------------------------------------------------
const settleTotal = new Counter({
  name: "vellar_settle_total",
  help: "Total /settle requests, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export function incrementSettleTotal(outcome: "success" | "failure"): void {
  settleTotal.inc({ outcome });
}

// ---------------------------------------------------------------------------
// 2. vellar_settle_errors_total — counter, label: reason
// ---------------------------------------------------------------------------
const settleErrorsTotal = new Counter({
  name: "vellar_settle_errors_total",
  help: "Total /settle failures, by real error classification.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export function incrementSettleErrorsTotal(
  reason: "txBadSeq" | "TRY_AGAIN_LATER" | "pool_exhausted" | "other",
): void {
  settleErrorsTotal.inc({ reason });
}

// ---------------------------------------------------------------------------
// 3. vellar_verify_total — counter, label: outcome (success|failure)
// ---------------------------------------------------------------------------
const verifyTotal = new Counter({
  name: "vellar_verify_total",
  help: "Total /verify requests, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export function incrementVerifyTotal(outcome: "success" | "failure"): void {
  verifyTotal.inc({ outcome });
}

// ---------------------------------------------------------------------------
// 4. vellar_settle_duration_seconds — histogram
// Buckets: observed p50 ~11s, p95 ~12s from the channel-pool load test
// (docs/channel-pool-design.md's own Run 2 result). A bucket boundary at 15
// makes the grant's own "p95 <= 15s" success criterion directly readable
// off the histogram's cumulative counts, without computing a percentile by
// hand.
// ---------------------------------------------------------------------------
const settleDurationSeconds = new Histogram({
  name: "vellar_settle_duration_seconds",
  help: "Wall-clock duration of a /settle request, in seconds.",
  buckets: [0.5, 1, 2, 3, 5, 7, 10, 12, 15, 20, 30],
  registers: [registry],
});

export function observeSettleDurationSeconds(seconds: number): void {
  settleDurationSeconds.observe(seconds);
}

// ---------------------------------------------------------------------------
// 5-7. Channel-account pool gauges — mirror /health's own channelPool
// field (src/server.ts, docs/channel-pool-design.md §5). Set at SCRAPE TIME
// from pool.status(), not incremented — see setPoolGauges' own doc comment.
// ---------------------------------------------------------------------------
const poolAvailable = new Gauge({
  name: "vellar_pool_available",
  help: "Channel accounts currently available for acquisition.",
  registers: [registry],
});
const poolInUse = new Gauge({
  name: "vellar_pool_in_use",
  help: "Channel accounts currently acquired by an in-flight settlement.",
  registers: [registry],
});
const poolDisabled = new Gauge({
  name: "vellar_pool_disabled",
  help: "Channel accounts currently disabled (e.g. low balance) and excluded from acquisition.",
  registers: [registry],
});

/**
 * Sets all three pool gauges at once from a single ChannelPool.status()
 * read. Deliberately one function, not three — the three counts are only
 * ever meaningful read together (this mirrors /health's own channelPool
 * field, which always reports all three from one status() call), and a
 * caller reaching for "just set poolInUse" independently of the other two
 * would produce a scrape whose three pool gauges came from two different
 * moments in time.
 */
export function setPoolGauges(status: { available: number; inUse: number; disabled: number }): void {
  poolAvailable.set(status.available);
  poolInUse.set(status.inUse);
  poolDisabled.set(status.disabled);
}

// ---------------------------------------------------------------------------
// 8. vellar_catalog_size — gauge, set at scrape time
// ---------------------------------------------------------------------------
const catalogSize = new Gauge({
  name: "vellar_catalog_size",
  help: "Number of resources currently in the Bazaar catalog.",
  registers: [registry],
});

export function setCatalogSize(size: number): void {
  catalogSize.set(size);
}

// ---------------------------------------------------------------------------
// 9. vellar_rate_limit_rejections_total — counter
// ---------------------------------------------------------------------------
const rateLimitRejectionsTotal = new Counter({
  name: "vellar_rate_limit_rejections_total",
  help: "Total requests rejected for exceeding the per-IP rate limit.",
  registers: [registry],
});

export function incrementRateLimitRejectionsTotal(): void {
  rateLimitRejectionsTotal.inc();
}

// ---------------------------------------------------------------------------
// 10. vellar_uptime_seconds — gauge, set at scrape time
// ---------------------------------------------------------------------------
const uptimeSeconds = new Gauge({
  name: "vellar_uptime_seconds",
  help: "Process uptime in seconds (matches /health's own uptimeSeconds field).",
  registers: [registry],
});

export function setUptimeSeconds(seconds: number): void {
  uptimeSeconds.set(seconds);
}

// ---------------------------------------------------------------------------
// 11. vellar_reverify_pending — gauge, set at scrape time
// ---------------------------------------------------------------------------
const reverifyPending = new Gauge({
  name: "vellar_reverify_pending",
  help: "Boot-time re-proof probes still in flight (matches /health's own reverifyPending field).",
  registers: [registry],
});

export function setReverifyPending(count: number): void {
  reverifyPending.set(count);
}
