# Grafana Cloud dashboard setup — Tranche 1 deliverable 1.3

Public status dashboard, live and updating. This document is the reproducibility
record: how the pipeline was built, why each piece exists, and how to rebuild
it from scratch if the account, the dashboard, or the Alloy service is ever
lost.

**Public dashboard URL:**
https://steadycelery1546.grafana.net/public-dashboards/43b100b2f72045afa52694954f62350b

No login required — this is Grafana Cloud's own public-dashboard share feature,
not a custom-built page. Live-verified: returns `200 OK` to an unauthenticated
request.

## Why this needed a separate agent, not just "point Grafana at /metrics"

`src/server.ts`'s `/metrics` route (deliverable 1.2) is already public and
unauthenticated — Prometheus text format, 11 named metrics, no per-transaction
detail (counts, gauges, a duration histogram only; see `src/metrics.ts`'s own
comments for what is deliberately excluded and why).

The one thing that endpoint cannot do on its own is get its data into Grafana
Cloud: **Grafana Cloud's Prometheus service is push-based (remote_write), not
pull-based.** It cannot reach out and scrape an arbitrary public URL itself,
even one with zero auth in front of it. Something has to sit in between,
scrape `/metrics` on an interval, and push the samples to Grafana Cloud —
that something is [Grafana Alloy](https://grafana.com/docs/alloy/), Grafana's
own agent for exactly this job.

Two other paths were considered and rejected during account setup:

- **"Prometheus Remote Write" onboarding path** (Grafana Cloud's UI offers
  this alongside Alloy) — assumes you already run a standalone Prometheus
  server with its own `remote_write` config. We don't; we only ever had a
  scrape target, never a Prometheus server of our own.
- **A self-run Prometheus instance** shipping a copy of its data to Grafana
  Cloud — same problem, and an unnecessary extra moving part on top of Alloy
  when Alloy scrapes directly.

## Architecture

```
vellar-facilitator (Render)          vellar-alloy (Render)              Grafana Cloud
┌──────────────────────┐             ┌──────────────────────┐          ┌─────────────────────┐
│ GET /metrics          │  scrape    │ prometheus.scrape     │  push    │ Hosted Prometheus   │
│ (public, unauth,      │◄───────────│   "facilitator"       │─────────►│ (steadycelery1546-   │
│  60 req/min ceiling)  │  15s       │ prometheus.remote_write│ remote_ │  prom)               │
└──────────────────────┘   interval  │   "grafana_cloud"     │  write   └─────────┬────────────┘
                                      └──────────────────────┘                    │
                                                                                    ▼
                                                                     Public dashboard (Share →
                                                                     Public dashboard), 8 panels
```

`vellar-alloy` is its own Render service (`render.yaml`), separate from the
facilitator process — Alloy is a standalone Go binary/agent, not an npm
package, and mixing an unrelated telemetry agent into the facilitator's own
process would widen that process's blast radius for no benefit. A crash in
the scrape loop has no business taking `/settle` down with it.

## Grafana Cloud stack

- **Stack URL:** https://steadycelery1546.grafana.net
- **Region:** Switzerland (`prod-eu-central-0`) — chosen during account
  creation; not consequential to this deliverable (the scrape target is a
  public HTTPS URL regardless of region, and 15s-interval traffic is
  latency-insensitive at this scale).
- **Prometheus instance:** `steadycelery1546-prom`
  - Query endpoint: `https://prometheus-prod-58-prod-eu-central-0.grafana.net/api/prom`
  - Remote write endpoint: `https://prometheus-prod-58-prod-eu-central-0.grafana.net/api/prom/push`
  - Username / Instance ID: `3551448`
- **API token:** named `vellar-facilitator-alloy`, scope `set:alloy-data-write`
  (write-only metrics ingestion — cannot read anything back, cannot reach any
  other Grafana Cloud stack). Generated from Connections → Add new connection
  → Prometheus → Via Grafana Alloy → Create a new token. **Not recorded here**
  — treat it like `SPONSOR_SECRET_KEY` or `CATALOG_DB_AUTH_TOKEN`: it lives
  only in the `vellar-alloy` Render service's environment variables
  (`GRAFANA_API_TOKEN`, `sync: false` in `render.yaml`).

## The scrape target

- **URL:** `https://vellar-facilitator.onrender.com/metrics`
- **Scrape interval:** 15s
- **Auth:** none (the endpoint is intentionally public)

Configured in `alloy/config.alloy`:

```alloy
prometheus.scrape "facilitator" {
  targets = [{
    __address__ = "vellar-facilitator.onrender.com",
  }]
  scheme          = "https"
  metrics_path    = "/metrics"
  scrape_interval = "15s"
  forward_to      = [prometheus.remote_write.grafana_cloud.receiver]
}

prometheus.remote_write "grafana_cloud" {
  endpoint {
    url = sys.env("GRAFANA_REMOTE_WRITE_URL")
    basic_auth {
      username = sys.env("GRAFANA_INSTANCE_ID")
      password = sys.env("GRAFANA_API_TOKEN")
    }
  }
}
```

**Important constraint this places on `/metrics`:** the scraper needs
`/metrics` to stay publicly reachable and to tolerate at least one request
every 15 seconds indefinitely. `/metrics`'s own rate limit
(`{ max: 60, timeWindow: 60_000 }` in `src/server.ts`) allows roughly 15x this
scraper's actual request volume (~4 req/min), so the scraper is nowhere near
that ceiling — but if that ceiling is ever tightened, check this constraint
first, or the dashboard silently starts losing scrape cycles to 429s.

## The Alloy service (`vellar-alloy`)

Deployed as a second Render web service alongside `vellar-facilitator` and
`vellar-seller-demo` — see `render.yaml`. Docker-based (`alloy/Dockerfile`,
`FROM grafana/alloy:v1.5.1`, pinned deliberately, not `:latest`).

Because this service was created directly through Render's "New Web
Service" UI (not a Blueprint sync — this workspace's existing services were
never connected as a Blueprint instance, confirmed during setup), the
`render.yaml` block is the source of truth for what the service *should* be
configured as, but Render's own dashboard settings for the live
`vellar-alloy` service are what's actually running. The two settings that
matter and are easy to get wrong when recreating this by hand:

- **Root Directory:** `alloy`
- **Dockerfile Path:** `Dockerfile` (relative to Root Directory, not the repo
  root — setting this to `alloy/Dockerfile` while Root Directory is also
  `alloy` produces a doubled path and fails the build with
  `lstat .../alloy/alloy: no such file or directory`; setting Root Directory
  blank while keeping `alloy/Dockerfile` fails differently, with `COPY
  config.alloy` unable to find the file because the build context defaults to
  the repo root)

Environment variables (three, matching `render.yaml`):

| Key | Value | Secret? |
|---|---|---|
| `GRAFANA_REMOTE_WRITE_URL` | `https://prometheus-prod-58-prod-eu-central-0.grafana.net/api/prom/push` | No — identifies a stack, authorizes nothing alone |
| `GRAFANA_INSTANCE_ID` | `3551448` | No — same as above |
| `GRAFANA_API_TOKEN` | *(the real token)* | **Yes** — set manually in the Render dashboard, never in git |

No `healthCheckPath` is set: Alloy's own built-in HTTP server (bound to
`0.0.0.0:$PORT` via the Dockerfile's `--server.http.listen-addr` flag —
Alloy's upstream default is loopback-only `127.0.0.1:12345`, which Render
cannot reach) satisfies Render's port-binding detection, the same
"no healthCheckPath, port-binding is what we want" precedent already used by
`vellar-seller-demo`.

## The dashboard

Title: **Vellar Facilitator — Status**. Built via Import dashboard (JSON
model), data source `grafanacloud-steadycelery1546-prom`, refresh interval
30s, default time range 1h.

| # | Panel | Query | Type |
|---|---|---|---|
| 1 | Settle success rate | `rate(vellar_settle_total{outcome="success"}[5m])` | Time series |
| 2 | Settle error breakdown | `sum by (reason) (rate(vellar_settle_errors_total[5m]))` | Time series |
| 3 | Settle latency p95 | `histogram_quantile(0.95, rate(vellar_settle_duration_seconds_bucket[5m]))` | Time series, threshold line at 15 (the grant's own p95 ≤ 15s criterion, deliverable 1.4) |
| 4 | Settle latency p50 / p99 | `histogram_quantile(0.50, ...)` and `histogram_quantile(0.99, ...)` over the same bucket metric | Time series, two queries |
| 5 | Channel pool health | `vellar_pool_available`, `vellar_pool_in_use`, `vellar_pool_disabled` | Stat (3 values) |
| 6 | Verify volume | `sum by (outcome) (rate(vellar_verify_total[5m]))` | Time series |
| 7 | Catalog size | `vellar_catalog_size` | Stat |
| 8 | Rate limit rejections | `rate(vellar_rate_limit_rejections_total[5m])` | Time series |

**Expected "No data" on first boot, and why that is correct, not broken:**
panels 1, 2, 3, 4, and 6 read counters/histograms that only receive
observations when a real `/settle` or `/verify` call completes
(`src/server.ts`'s instrumentation — see 1.2's own design). Immediately after
a fresh deploy with zero transaction traffic, `histogram_quantile()` over zero
observations returns genuinely empty, not zero — this is expected Prometheus
behavior, confirmed live during this dashboard's own first build (5 of 8
panels showed "No data", 3 showed live values: pool health, catalog size,
rate limit rejections — all of which are gauges/counters with a well-defined
value even at zero traffic).

## Rebuilding the dashboard from scratch

If the dashboard is ever lost, the panel list above is sufficient to rebuild
it by hand (Dashboards → New → New dashboard → Add visualization, one panel
at a time), or re-import the JSON model this dashboard was originally created
from — reconstructable directly from the table above (`uid` values will
differ if reassigned, which is fine; only the `title` and per-panel `expr`
queries matter for the dashboard to be equivalent).

To re-enable public sharing on a rebuilt dashboard: **Dashboard settings →
Share → Public dashboard → Enable public access**. This generates a new URL
each time — update the link at the top of this document if that ever
happens.

## What "public" and "unauthenticated" mean here, stated plainly

The dashboard is intentionally publicly viewable with no login, matching the
grant's own "public status dashboard, live, updating" wording. Every metric
it displays is already public via `/metrics` directly (confirmed in 1.2's own
design review: counts, gauges, a duration histogram — never an address, a
key, or per-transaction detail). Publishing the dashboard adds no new
exposure beyond what `/metrics` already exposes; it only makes that data
legible without hand-writing PromQL.
