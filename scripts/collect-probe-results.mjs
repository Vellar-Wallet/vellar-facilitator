#!/usr/bin/env node
// Aggregates settle-probe artifacts across runs into one honest table.
// Usage: node scripts/collect-probe-results.mjs [--limit 30]
// Needs: gh CLI authenticated. Downloads artifacts to a temp dir.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const limit = process.argv.includes("--limit") ? process.argv[process.argv.indexOf("--limit") + 1] : "30";
const runs = JSON.parse(execFileSync("gh", ["run", "list", "--workflow", "settle-probe.yml", "--limit", limit,
  "--json", "databaseId,conclusion,createdAt"], { encoding: "utf8" }));
const all = [];
for (const run of runs.filter((r) => r.conclusion === "success")) {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  try {
    execFileSync("gh", ["run", "download", String(run.databaseId), "--dir", dir], { stdio: "ignore" });
    for (const sub of readdirSync(dir)) {
      const f = join(dir, sub, "probe-results.jsonl");
      try {
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const o = JSON.parse(line);
          if (o.probe === "settle") all.push({ ...o, runAt: run.createdAt });
        }
      } catch { /* artifact without results */ }
    }
  } catch { /* expired or empty artifact */ }
}
// Group by variant: "retries-on" vs "retries-off" is the controlled A/B.
const variants = {};
for (const a of all) (variants[a.variant ?? "default"] ??= []).push(a);
const table = {};
for (const [v, rows] of Object.entries(variants)) {
  const okV = rows.filter((r) => r.ok).length;
  const br = {};
  for (const r of rows.filter((r) => !r.ok)) {
    const k = `${r.stage}:${r.reason}${r.rpcStatus ? ":" + r.rpcStatus : ""}`;
    br[k] = (br[k] ?? 0) + 1;
  }
  const lv = rows.filter((r) => r.ok).map((r) => r.ms).sort((x, y) => x - y);
  const pv = (p) => (lv.length ? lv[Math.min(lv.length - 1, Math.floor((p / 100) * lv.length))] : null);
  table[v] = { attempts: rows.length, settled: okV, failed: rows.length - okV,
    failureRate: rows.length ? +((rows.length - okV) / rows.length).toFixed(3) : null,
    byReason: br, latencyMs: { min: lv[0] ?? null, p50: pv(50), p95: pv(95), max: lv[lv.length - 1] ?? null } };
}
const ok = all.filter((a) => a.ok).length;
const byReason = {};
for (const a of all.filter((a) => !a.ok)) {
  const k = `${a.stage}:${a.reason}${a.rpcStatus ? ":" + a.rpcStatus : ""}`;
  byReason[k] = (byReason[k] ?? 0) + 1;
}
const lat = all.filter((a) => a.ok).map((a) => a.ms).sort((x, y) => x - y);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);
console.log(JSON.stringify({
  provenance:
    "Single-instrument A/B: retries-on vs retries-off run CONCURRENTLY each cycle on the same " +
    "crons and RPC conditions, retries-off being pre-retry behaviour (the true 'before'). Any " +
    "earlier figures (docs/diagnosis-settle-failures.md, the '1 in 3') are a DIFFERENT " +
    "instrument on different infrastructure — one machine, burst access. Acceptable baseline, " +
    "not a controlled comparison; only the variants table below is.",
  byVariant: table,
  runsSampled: runs.length, attempts: all.length, settled: ok, failed: all.length - ok,
  failureRate: all.length ? +((all.length - ok) / all.length).toFixed(3) : null,
  byReason, latencyMs: { min: lat[0] ?? null, p50: pct(50), p95: pct(95), max: lat[lat.length - 1] ?? null },
}, null, 2));
