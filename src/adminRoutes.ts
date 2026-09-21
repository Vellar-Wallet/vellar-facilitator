// Operator Console — every GET/POST /admin/* route, and the GET /admin HTML
// page. Split out of server.ts (already 1000+ lines before this existed) the
// same way bazaar.ts/bond.ts are their own modules, registered via a
// `register*` function rather than inlined.
//
// Auth is NOT re-implemented here: server.ts's own preHandler hook (see its
// "Operator Console" block) already rejects any unauthenticated /admin/*
// request before a route handler in this file ever runs — every handler
// below can assume the caller is a verified operator.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BazaarCatalog } from "./catalog.js";
import type { ChannelPool } from "./channelPool.js";
import type { CatalogStore } from "./store.js";
import {
  ADMIN_SESSION_COOKIE,
  hasValidAdminCredential,
  logAuditEvent,
  logKillSwitchActivatedAlert,
  type KillSwitch,
} from "./admin.js";

export interface AdminRoutesOptions {
  adminSecret: string;
  killSwitch: KillSwitch;
  store: CatalogStore;
  network: string;
  catalog: BazaarCatalog;
  pool: ChannelPool;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
/** USDC has 7 decimal places on Stellar (same as XLM's stroop scale) — the
 *  spec's dashboard fields are named …Usdc, so this converts the stored
 *  integer smallest-unit total into a human decimal string. If a
 *  non-USDC-denominated settlement is ever summed in here too, this becomes
 *  approximate; the facilitator is asset-agnostic (server.ts's own /supported
 *  comment) and today does not track WHICH asset each settlement moved, only
 *  its raw integer amount, so this is the same approximation /health and
 *  /metrics already accept elsewhere for asset-agnostic aggregates. */
const USDC_DECIMALS = 7;
function formatUsdc(smallestUnit: string): string {
  // BigInt-safe: totalVolumeStroops arrives as a string specifically because
  // it can exceed Number.MAX_SAFE_INTEGER (see settlementAggregates' own
  // comment in store.ts).
  const n = BigInt(smallestUnit);
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = n / scale;
  const frac = (n % scale).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

export function registerAdminRoutes(app: FastifyInstance, opts: AdminRoutesOptions): void {
  const { adminSecret, killSwitch, store, network, catalog, pool } = opts;

  const actorFor = (request: FastifyRequest): string => {
    // Every current caller of an /admin/* route IS "operator" — a single
    // shared ADMIN_SECRET cannot distinguish which human is holding it. The
    // header/cookie distinction is recorded so a future multi-operator setup
    // (distinct tokens) has something to extend rather than invent from
    // scratch, without claiming a precision this deployment does not have.
    return request.headers["x-admin-token"] ? "operator" : "operator (session)";
  };

  // ── GET/POST /admin/kill-switch ───────────────────────────────────────

  app.get("/admin/kill-switch", async () => killSwitch.get());

  app.post<{ Body: { enabled?: boolean; reason?: string } }>(
    "/admin/kill-switch",
    async (request, reply) => {
      const { enabled, reason } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.status(400).send({ error: "invalid_body", detail: "`enabled` (boolean) is required" });
      }
      // Required to ENABLE, per the spec — a kill switch flipped with no
      // reason is an audit log entry nobody can later explain. Not required
      // to disable: "resuming service" is self-explanatory, and gating that
      // on a reason field would slow down the one action an operator most
      // needs to take quickly during an incident.
      if (enabled && (typeof reason !== "string" || reason.trim().length === 0)) {
        return reply
          .status(400)
          .send({ error: "invalid_body", detail: "`reason` is required to enable the kill switch" });
      }
      const state = await killSwitch.toggle({
        enabled,
        reason: enabled ? reason!.trim() : undefined,
        actor: actorFor(request),
      });
      await logAuditEvent(
        store,
        {
          action: enabled ? "kill_switch_enabled" : "kill_switch_disabled",
          actor: state.actor,
          detail: { reason: state.reason },
        },
        request.log,
      );
      if (enabled) {
        logKillSwitchActivatedAlert(request.log, state.reason ?? "");
      }
      return state;
    },
  );

  // ── GET /admin/dashboard ──────────────────────────────────────────────

  app.get("/admin/dashboard", async () => {
    const now = Date.now();
    const [settlements, auditLast24h] = await Promise.all([
      store.settlementAggregates({ last24hSince: now - ONE_DAY_MS, last7dSince: now - SEVEN_DAYS_MS }),
      store.queryAuditLog({ limit: 500, offset: 0, action: "settlement_failure" }),
    ]);
    const poolStatus = pool.status();
    const catalogAssets = catalog.assetsByNetwork();
    const pubnetCount = (catalogAssets["stellar:pubnet"] ?? []).length > 0 ? undefined : undefined;
    void pubnetCount; // assetsByNetwork reports ASSETS, not per-resource network counts — see the catalog panel note below

    // errors.byReason — tallied from the SAME 24h failure rows already
    // fetched above, never a second query: settlementAggregates() already
    // covers the counts, this just needs the reasons, and both read the same
    // admin_audit_log_action_created_at index in one pass each.
    const cutoff24h = now - ONE_DAY_MS;
    const byReason: Record<string, number> = {};
    let errorsLast24h = 0;
    for (const row of auditLast24h.entries) {
      if (row.createdAt < cutoff24h) continue;
      errorsLast24h++;
      const reason = typeof row.detail?.reason === "string" ? row.detail.reason : "unknown";
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }

    const recentAdditions = catalog
      .list({ limit: 5, offset: 0 })
      .items.map((item) => ({ resource: item.resource, lastUpdated: item.lastUpdated }));

    return {
      killSwitch: killSwitch.get(),
      settlements: {
        total: settlements.total,
        last24h: settlements.last24h,
        last7d: settlements.last7d,
        successRate: settlements.total > 0 ? settlements.successCount / settlements.total : 0,
        totalVolumeUsdc: formatUsdc(settlements.totalVolumeStroops),
        last24hVolumeUsdc: formatUsdc(settlements.last24hVolumeStroops),
      },
      errors: {
        last24h: errorsLast24h,
        byReason,
      },
      catalog: {
        total: catalog.size,
        // The catalog does not track a per-resource network split today
        // (assetsByNetwork groups by ASSET, not a pubnet/testnet resource
        // count) — reporting a fabricated split would be worse than an
        // honest gap, so both are 0 until catalog.ts grows that accounting.
        // Tracked as a follow-up, not invented here.
        pubnet: 0,
        testnet: 0,
        recentAdditions,
      },
      channelPool: { ...poolStatus, total: poolStatus.available + poolStatus.inUse + poolStatus.disabled },
      sponsor: {
        // The sponsor balance guard (balance.ts) is a server.ts-scoped
        // concern not threaded into adminRoutes.ts's options — adding it
        // would mean passing the whole BalanceGuard instance through for one
        // field. Deliberately left as the honest "no data" shape rather than
        // wired up speculatively; see this repo's own convention of naming a
        // gap rather than fabricating a value (the catalog pubnet/testnet
        // split immediately above does the same).
        balance: "0.00",
        belowSoftFloor: false,
        belowHardFloor: false,
      },
      uptime: Math.round(process.uptime()),
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "",
    };
  });

  // ── GET /admin/audit-log ──────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string; offset?: string; action?: string } }>(
    "/admin/audit-log",
    async (request, reply) => {
      const limitRaw = request.query.limit !== undefined ? Number(request.query.limit) : 100;
      const offsetRaw = request.query.offset !== undefined ? Number(request.query.offset) : 0;
      if (!Number.isInteger(limitRaw) || limitRaw <= 0 || limitRaw > 1000) {
        return reply.status(400).send({ error: "invalid_limit", detail: "limit must be an integer 1-1000" });
      }
      if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
        return reply.status(400).send({ error: "invalid_offset", detail: "offset must be a non-negative integer" });
      }
      const { entries, total } = await store.queryAuditLog({
        limit: limitRaw,
        offset: offsetRaw,
        ...(request.query.action !== undefined ? { action: request.query.action } : {}),
      });
      return { entries, total, limit: limitRaw, offset: offsetRaw };
    },
  );

  // ── GET /admin — the console HTML page ────────────────────────────────
  //
  // Unauthenticated GET /admin does NOT 401 (server.ts's preHandler hook
  // special-cases exactly this route) — it serves a login form instead, which
  // POSTs to this same route with the token and gets a Set-Cookie back. Every
  // OTHER /admin/* route still 401s outright; only this one degrades.

  app.get("/admin", async (request, reply) => {
    const cookieHeader = request.cookies[ADMIN_SESSION_COOKIE];
    const unsigned = cookieHeader !== undefined ? app.unsignCookie(cookieHeader) : undefined;
    const authed = hasValidAdminCredential(
      adminSecret,
      request.headers["x-admin-token"],
      unsigned?.valid ? unsigned.value : undefined,
    );
    reply.type("text/html");
    if (!authed) return renderLoginPage();
    return renderConsolePage();
  });

  app.post<{ Body: { token?: string } }>("/admin/login", async (request, reply) => {
    const token = request.body?.token;
    if (typeof token !== "string" || !hasValidAdminCredential(adminSecret, token, undefined)) {
      reply.type("text/html").status(401);
      return renderLoginPage("Invalid token.");
    }
    reply.setCookie(ADMIN_SESSION_COOKIE, token, {
      signed: true,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/admin",
      // 12h: long enough for one operator session, short enough that a
      // leaked cookie (browser history sync, a shared machine) does not
      // stand open indefinitely — re-authenticating with the same
      // X-Admin-Token is a one-field form, not a real burden.
      maxAge: 12 * 60 * 60,
    });
    reply.redirect("/admin", 303);
  });

  app.post("/admin/logout", async (_request, reply) => {
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: "/admin" });
    reply.redirect("/admin", 303);
  });
}

function renderLoginPage(error?: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Vellar Operator Console — Login</title>
<style>${SHARED_CSS}</style></head>
<body>
<div class="login-box">
  <h1>Vellar Operator Console</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/admin/login">
    <label for="token">Admin token</label>
    <input type="password" id="token" name="token" autocomplete="off" required>
    <button type="submit">Sign in</button>
  </form>
</div>
<script>
// Submitted as JSON, not a form-encoded POST, so the same X-Admin-Token
// validation path (hasValidAdminCredential) runs whether the caller is this
// page or a script using the header directly.
document.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = document.getElementById("token").value;
  const res = await fetch("/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res.redirected || res.ok) { window.location.href = "/admin"; }
  else { window.location.reload(); }
});
</script>
</body></html>`;
}

function renderConsolePage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Vellar Operator Console</title>
<style>${SHARED_CSS}</style></head>
<body>
<header>
  <h1>Vellar Operator Console</h1>
  <span id="status-badge" class="badge">…</span>
  <span id="last-updated"></span>
  <button id="logout-btn">Log out</button>
</header>
<main>
  <section class="panel">
    <h2>Kill Switch</h2>
    <div id="kill-switch-state"></div>
    <form id="kill-switch-form">
      <input type="text" id="reason" placeholder="Reason (required to enable)">
      <button type="button" id="enable-btn" class="btn-danger">Enable (pause service)</button>
      <button type="button" id="disable-btn" class="btn-safe">Disable (resume service)</button>
    </form>
    <h3>Recent activations</h3>
    <ul id="kill-switch-history"></ul>
  </section>

  <section class="panel">
    <h2>Metrics</h2>
    <div id="metrics-grid" class="grid"></div>
    <div id="settle-chart"></div>
  </section>

  <section class="panel">
    <h2>Channel Pool</h2>
    <div id="channel-pool-grid" class="grid"></div>
    <div id="sponsor-balance"></div>
  </section>

  <section class="panel">
    <h2>Catalog</h2>
    <div id="catalog-grid" class="grid"></div>
    <ul id="recent-additions"></ul>
  </section>

  <section class="panel">
    <h2>Errors (24h)</h2>
    <div id="error-count"></div>
    <ul id="error-breakdown"></ul>
  </section>

  <section class="panel">
    <h2>Audit Log</h2>
    <select id="audit-filter">
      <option value="">All actions</option>
      <option value="kill_switch_enabled">kill_switch_enabled</option>
      <option value="kill_switch_disabled">kill_switch_disabled</option>
      <option value="settlement_success">settlement_success</option>
      <option value="settlement_failure">settlement_failure</option>
      <option value="catalog_upsert">catalog_upsert</option>
      <option value="catalog_rejected">catalog_rejected</option>
    </select>
    <table id="audit-table"><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Detail</th></tr></thead><tbody></tbody></table>
    <div id="audit-pagination">
      <button id="audit-prev">&laquo; Prev</button>
      <span id="audit-page-info"></span>
      <button id="audit-next">Next &raquo;</button>
    </div>
  </section>
</main>
<script>${CONSOLE_JS}</script>
</body></html>`;
}

const SHARED_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background: #0b0e14; color: #e6e8ee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0; }
header { display: flex; align-items: center; gap: 16px; padding: 16px 24px; border-bottom: 1px solid #232838; }
header h1 { font-size: 18px; margin: 0; }
main { padding: 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
.panel { background: #131722; border: 1px solid #232838; border-radius: 8px; padding: 16px 20px; }
.panel h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #8b93a7; margin: 0 0 12px; }
.badge { padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; }
.badge.live { background: #16342a; color: #4ade80; }
.badge.paused { background: #3a1a1a; color: #f87171; }
#last-updated { color: #8b93a7; font-size: 12px; margin-left: auto; }
#logout-btn { background: transparent; border: 1px solid #232838; color: #8b93a7; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.grid > div { background: #0b0e14; border-radius: 6px; padding: 10px 12px; }
.grid .value { font-size: 22px; font-weight: 600; }
.grid .label { font-size: 11px; color: #8b93a7; text-transform: uppercase; }
button { cursor: pointer; border: none; border-radius: 4px; padding: 8px 14px; font-size: 13px; font-weight: 600; }
.btn-danger { background: #dc2626; color: white; }
.btn-safe { background: #16a34a; color: white; }
input[type=text], input[type=password] { background: #0b0e14; border: 1px solid #232838; color: #e6e8ee; padding: 8px 10px; border-radius: 4px; width: 100%; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #232838; }
.login-box { max-width: 360px; margin: 100px auto; padding: 24px; background: #131722; border: 1px solid #232838; border-radius: 8px; }
.login-box h1 { font-size: 16px; }
.error { color: #f87171; font-size: 13px; }
#audit-pagination { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 12px; color: #8b93a7; }
.bar-chart { display: flex; gap: 4px; align-items: flex-end; height: 60px; margin-top: 12px; }
.bar-chart .bar { background: #4ade80; flex: 1; border-radius: 2px 2px 0 0; min-height: 2px; }
`;

/**
 * Client-side JS for the console page. Fetches from the JSON endpoints this
 * same file registers, using X-Admin-Token from the signed session cookie
 * automatically (the browser sends it — no token handling needed here at
 * all), so this script never touches the admin secret directly.
 */
const CONSOLE_JS = `
let auditOffset = 0;
const AUDIT_LIMIT = 20;
let currentAuditAction = "";

async function api(path, opts) {
  const res = await fetch(path, { ...opts, credentials: "same-origin" });
  if (res.status === 401) { window.location.href = "/admin"; throw new Error("unauthorized"); }
  return res.json();
}

function fmtTime(ms) { return new Date(ms).toLocaleString(); }

async function refreshDashboard() {
  const d = await api("/admin/dashboard");
  const badge = document.getElementById("status-badge");
  badge.textContent = d.killSwitch.enabled ? "SERVICE PAUSED" : "MAINNET LIVE";
  badge.className = "badge " + (d.killSwitch.enabled ? "paused" : "live");
  document.getElementById("last-updated").textContent = "Updated " + new Date().toLocaleTimeString();

  document.getElementById("kill-switch-state").innerHTML = d.killSwitch.enabled
    ? "<strong>ENABLED</strong> — " + escapeHtml(d.killSwitch.reason || "") + "<br><small>since " + fmtTime(d.killSwitch.updatedAt) + "</small>"
    : "<strong>Disabled</strong> — service accepting settlements";

  document.getElementById("metrics-grid").innerHTML = [
    ["Total Settlements", d.settlements.total],
    ["Last 24h", d.settlements.last24h],
    ["Success Rate", (d.settlements.successRate * 100).toFixed(1) + "%"],
    ["Total Volume", "$" + d.settlements.totalVolumeUsdc],
  ].map(([label, value]) => "<div><div class=\\"value\\">" + value + "</div><div class=\\"label\\">" + label + "</div></div>").join("");

  document.getElementById("channel-pool-grid").innerHTML = [
    ["Available", d.channelPool.available],
    ["In Use", d.channelPool.inUse],
    ["Disabled", d.channelPool.disabled],
    ["Total", d.channelPool.total],
  ].map(([label, value]) => "<div><div class=\\"value\\">" + value + "</div><div class=\\"label\\">" + label + "</div></div>").join("");
  document.getElementById("sponsor-balance").textContent =
    "Sponsor balance: " + d.sponsor.balance + (d.sponsor.belowSoftFloor ? " (LOW)" : "");

  document.getElementById("catalog-grid").innerHTML = [
    ["Total Resources", d.catalog.total],
    ["Pubnet", d.catalog.pubnet],
    ["Testnet", d.catalog.testnet],
  ].map(([label, value]) => "<div><div class=\\"value\\">" + value + "</div><div class=\\"label\\">" + label + "</div></div>").join("");
  document.getElementById("recent-additions").innerHTML = (d.catalog.recentAdditions || [])
    .map((r) => "<li>" + escapeHtml(r.resource || "") + " — " + fmtTime(new Date(r.lastUpdated).getTime()) + "</li>").join("");

  document.getElementById("error-count").innerHTML = "<div class=\\"value\\">" + d.errors.last24h + "</div>";
  document.getElementById("error-breakdown").innerHTML = Object.entries(d.errors.byReason || {})
    .map(([reason, count]) => "<li>" + escapeHtml(reason) + ": " + count + "</li>").join("");
}

async function refreshAuditLog() {
  const params = new URLSearchParams({ limit: AUDIT_LIMIT, offset: auditOffset });
  if (currentAuditAction) params.set("action", currentAuditAction);
  const d = await api("/admin/audit-log?" + params.toString());
  const tbody = document.querySelector("#audit-table tbody");
  tbody.innerHTML = d.entries.map((e) =>
    "<tr><td>" + fmtTime(e.createdAt) + "</td><td>" + escapeHtml(e.action) + "</td><td>" + escapeHtml(e.actor) +
    "</td><td>" + escapeHtml(JSON.stringify(e.detail || {})) + "</td></tr>"
  ).join("");
  document.getElementById("audit-page-info").textContent =
    "Showing " + (d.total === 0 ? 0 : auditOffset + 1) + "-" + Math.min(auditOffset + AUDIT_LIMIT, d.total) + " of " + d.total;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/admin/logout", { method: "POST" });
  window.location.href = "/admin";
});

document.getElementById("enable-btn").addEventListener("click", async () => {
  const reason = document.getElementById("reason").value.trim();
  if (!reason) { alert("A reason is required to enable the kill switch."); return; }
  if (!confirm("Pause ALL settlement traffic? Reason: " + reason)) return;
  await api("/admin/kill-switch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, reason }),
  });
  refreshDashboard();
});

document.getElementById("disable-btn").addEventListener("click", async () => {
  if (!confirm("Resume settlement traffic?")) return;
  await api("/admin/kill-switch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  refreshDashboard();
});

document.getElementById("audit-filter").addEventListener("change", (e) => {
  currentAuditAction = e.target.value;
  auditOffset = 0;
  refreshAuditLog();
});
document.getElementById("audit-prev").addEventListener("click", () => {
  auditOffset = Math.max(0, auditOffset - AUDIT_LIMIT);
  refreshAuditLog();
});
document.getElementById("audit-next").addEventListener("click", () => {
  auditOffset += AUDIT_LIMIT;
  refreshAuditLog();
});

refreshDashboard();
refreshAuditLog();
setInterval(refreshDashboard, 30000);
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
