import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import { buildFacilitator } from "./facilitator.js";
import { buildServer, type AdminOptions } from "./server.js";
import { KillSwitch } from "./admin.js";
import { LibsqlCatalogStore } from "./store.js";
import { tmpStore } from "./store.testkit.js";
import { fakeChannelAccountSecretKeys } from "./testChannelPoolKeys.js";
import { VALID_TX_XDR, distinctValidTxXdr } from "./testSettleXdr.js";

// Operator Console — kill switch, admin auth, audit log. Everything here runs
// against a REAL libSQL database via tmpStore() (a temp file, survives across
// store instances so a restart is modelable), matching this repo's own
// testing convention for the store layer: "the bugs this migration can
// introduce ... are exactly the ones a hand-written fake would implement
// correctly by accident" (store.testkit.ts's own header comment).

const ADMIN_SECRET = "a-real-admin-secret-32-chars-long";

const testConfig = {
  port: 0,
  host: "127.0.0.1",
  network: "stellar:testnet" as const,
  rpcUrl: undefined,
  sponsorSecretKey: Keypair.random().secret(),
  channelAccountSecretKeys: fakeChannelAccountSecretKeys(),
  maxTransactionFeeStroops: 2_000_000,
  channelAccountMinStroops: 5_000_000,
  catalogDbUrl: undefined,
  uptoContractId: undefined,
  bondEscrowContractId: undefined,
  bondEscrowAdminSecretKey: undefined,
  catalogDbAuthToken: undefined,
  verificationApiUrl: undefined,
  spend: { rateWindowMs: 60_000, ceilingStroops: 50_000_000, windowMs: 60_000, perUrlMax: 10, perPayToMax: 100, unboundPoolMax: 10 },
  balance: { softFloorStroops: 100_000_000, hardFloorStroops: 20_000_000, intervalMs: 60_000 },
};

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND",
    amount: "1000000",
    payTo: "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A",
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements;
}

function settleBody(seed?: number) {
  return {
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "stellar:testnet",
      payload: { transaction: seed !== undefined ? distinctValidTxXdr(seed) : VALID_TX_XDR },
    },
    paymentRequirements: requirements(),
  };
}

/** Builds a server with a hydrated KillSwitch and a fresh temp-file store —
 *  the store is returned too, so a test can inspect audit_log/kill_switch
 *  rows directly, or build a SECOND store on the same url to model a restart
 *  (see store.testkit.ts's reopen()). */
async function buildAdminServer(opts: { defaultKillSwitch?: boolean } = {}) {
  const { store, url } = tmpStore();
  const catalog = await BazaarCatalog.create(store);
  const killSwitch = await KillSwitch.hydrate(store, opts.defaultKillSwitch ?? false);
  const admin: AdminOptions = { adminSecret: ADMIN_SECRET, killSwitch, store };
  const app = await buildServer(buildFacilitator(testConfig), catalog, undefined, undefined, {}, undefined, "stellar:testnet", undefined, admin);
  return { app, store, url, killSwitch };
}

describe("Operator Console — admin auth boundary", () => {
  const ADMIN_ROUTES: Array<{ method: "GET" | "POST"; url: string }> = [
    { method: "GET", url: "/admin/kill-switch" },
    { method: "POST", url: "/admin/kill-switch" },
    { method: "GET", url: "/admin/dashboard" },
    { method: "GET", url: "/admin/audit-log" },
  ];

  it.each(ADMIN_ROUTES)("$method $url rejects a missing token with 401", async ({ method, url }) => {
    const { app } = await buildAdminServer();
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it.each(ADMIN_ROUTES)("$method $url rejects a wrong token with 401", async ({ method, url }) => {
    const { app } = await buildAdminServer();
    const res = await app.inject({ method, url, headers: { "x-admin-token": "wrong-token-entirely" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it.each(ADMIN_ROUTES)("$method $url succeeds with the correct token", async ({ method, url }) => {
    const { app } = await buildAdminServer();
    // POST /admin/kill-switch needs a valid body to reach past its own 400
    // validation — this test only cares that auth itself passed (never a
    // 401), so `enabled: false` (no reason required) keeps it simple and
    // orthogonal to the auth check.
    const res =
      method === "POST"
        ? await app.inject({ method, url, headers: { "x-admin-token": ADMIN_SECRET }, payload: { enabled: false } })
        : await app.inject({ method, url, headers: { "x-admin-token": ADMIN_SECRET } });
    expect(res.statusCode, res.body).not.toBe(401);
    await app.close();
  });

  it("a wrong or missing admin token never affects non-admin routes", async () => {
    const { app } = await buildAdminServer();
    const noToken = await app.inject({ method: "GET", url: "/health" });
    const wrongToken = await app.inject({ method: "GET", url: "/health", headers: { "x-admin-token": "nope" } });
    expect(noToken.statusCode).toBe(200);
    expect(wrongToken.statusCode).toBe(200);
    await app.close();
  });

  it("GET /admin with no credential serves a login page, not a 401", async () => {
    const { app } = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Sign in");
    await app.close();
  });

  it("a server built with no admin option registers no /admin/* route at all", async () => {
    const catalog = await BazaarCatalog.create();
    const app = await buildServer(buildFacilitator(testConfig), catalog);
    const res = await app.inject({ method: "GET", url: "/admin/dashboard" });
    // 404, not 401 — the route genuinely does not exist, confirming the
    // console adds zero surface when disabled (see buildServer's own
    // AdminOptions doc comment).
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("Operator Console — kill switch", () => {
  // Case 1: off → /settle proceeds normally.
  it("off: /settle proceeds normally", async () => {
    const { app } = await buildAdminServer();
    const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody(1) });
    expect(res.statusCode).not.toBe(503);
    await app.close();
  });

  // Case 2: on → /settle returns 503 with the exact spec'd body shape.
  it("on: /settle returns 503 { error: service_paused, reason }", async () => {
    const { app } = await buildAdminServer({ defaultKillSwitch: true });
    // hydrate() seeds a synthetic reason when defaulting true from the env —
    // set an operator-chosen one explicitly via the real toggle path instead,
    // so this test asserts the reason an operator would actually see.
    await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: true, reason: "scheduled maintenance" },
    });
    const res = await app.inject({ method: "POST", url: "/settle", payload: settleBody(2) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "service_paused", reason: "scheduled maintenance" });
    await app.close();
  });

  // Case 3: on → /verify, /health, /metrics, /discovery still work.
  it("on: every non-/settle route is unaffected", async () => {
    const { app } = await buildAdminServer({ defaultKillSwitch: true });
    const health = await app.inject({ method: "GET", url: "/health" });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    const discovery = await app.inject({ method: "GET", url: "/discovery/resources" });
    const verify = await app.inject({
      method: "POST",
      url: "/verify",
      payload: { paymentPayload: settleBody(3).paymentPayload, paymentRequirements: requirements() },
    });
    expect(health.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
    expect(discovery.statusCode).toBe(200);
    expect(verify.statusCode).not.toBe(503);
    await app.close();
  });

  // Case 4: on → off → /settle resumes.
  it("toggling off after on lets /settle resume", async () => {
    const { app } = await buildAdminServer();
    await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: true, reason: "testing" },
    });
    const paused = await app.inject({ method: "POST", url: "/settle", payload: settleBody(4) });
    expect(paused.statusCode).toBe(503);
    await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: false },
    });
    const resumed = await app.inject({ method: "POST", url: "/settle", payload: settleBody(5) });
    expect(resumed.statusCode).not.toBe(503);
    await app.close();
  });

  // Case 5: state survives a simulated restart — a NEW server built against
  // the SAME Turso url reads the persisted "on" state via a fresh hydrate().
  it("survives a restart: a fresh server against the same database reads the persisted state", async () => {
    const { app, url } = await buildAdminServer();
    await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: true, reason: "before restart" },
    });
    await app.close();

    // A genuinely SEPARATE client onto the same database file — the restart.
    const reopenedStore = new LibsqlCatalogStore(url, undefined);
    const rehydratedSwitch = await KillSwitch.hydrate(reopenedStore, false);
    expect(rehydratedSwitch.get()).toMatchObject({ enabled: true, reason: "before restart" });
    await reopenedStore.close();
  });

  // Case 6: Turso unreachable at boot → fail closed (refuse to hydrate,
  // never silently default to "not killed").
  it("fails closed: a store read failure during hydrate() propagates rather than defaulting to disabled", async () => {
    const brokenStore = new LibsqlCatalogStore("libsql://nonexistent-host-for-this-test.invalid", undefined);
    await expect(KillSwitch.hydrate(brokenStore, false)).rejects.toThrow();
  });

  // Case 7: a rejected auth attempt never mutates state.
  it("a rejected (wrong-token) toggle attempt leaves state unchanged", async () => {
    const { app } = await buildAdminServer();
    const before = await app.inject({
      method: "GET",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
    });
    const attempt = await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": "wrong-token" },
      payload: { enabled: true, reason: "should never apply" },
    });
    const after = await app.inject({
      method: "GET",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
    });
    expect(attempt.statusCode).toBe(401);
    expect(after.json()).toEqual(before.json());
    await app.close();
  });

  it("enabling with no reason is refused with 400, and does not mutate state", async () => {
    const { app } = await buildAdminServer();
    const res = await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
    const state = await app.inject({
      method: "GET",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
    });
    expect(state.json().enabled).toBe(false);
    await app.close();
  });
});

describe("Operator Console — audit log", () => {
  it("empty audit log returns an empty array, not an error", async () => {
    const { app } = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/admin/audit-log", headers: { "x-admin-token": ADMIN_SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ entries: [], total: 0 });
    await app.close();
  });

  it("limit/offset paginate correctly and total reflects the full count", async () => {
    const { app } = await buildAdminServer();
    // 3 real kill-switch toggles produce 3 real audit rows via the actual
    // route, not a hand-inserted fixture — proving pagination against
    // genuine writes.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/admin/kill-switch",
        headers: { "x-admin-token": ADMIN_SECRET },
        payload: { enabled: true, reason: `toggle ${i}` },
      });
      await app.inject({
        method: "POST",
        url: "/admin/kill-switch",
        headers: { "x-admin-token": ADMIN_SECRET },
        payload: { enabled: false },
      });
    }
    const page1 = await app.inject({
      method: "GET",
      url: "/admin/audit-log?limit=2&offset=0",
      headers: { "x-admin-token": ADMIN_SECRET },
    });
    const page2 = await app.inject({
      method: "GET",
      url: "/admin/audit-log?limit=2&offset=2",
      headers: { "x-admin-token": ADMIN_SECRET },
    });
    expect(page1.json().entries).toHaveLength(2);
    expect(page1.json().total).toBe(6);
    expect(page2.json().entries).toHaveLength(2);
    // No overlap between the two pages.
    const ids1 = page1.json().entries.map((e: { id: number }) => e.id);
    const ids2 = page2.json().entries.map((e: { id: number }) => e.id);
    expect(ids1.some((id: number) => ids2.includes(id))).toBe(false);
    await app.close();
  });

  it("the action filter returns only matching rows", async () => {
    const { app } = await buildAdminServer();
    await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: true, reason: "x" },
    });
    await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: false },
    });
    const res = await app.inject({
      method: "GET",
      url: "/admin/audit-log?action=kill_switch_enabled",
      headers: { "x-admin-token": ADMIN_SECRET },
    });
    const entries = res.json().entries as Array<{ action: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.action === "kill_switch_enabled")).toBe(true);
    await app.close();
  });

  // END-TO-END: a REAL /settle failure (kill switch enabled) produces a
  // correct audit row — proves the wrapped call site in runSettlePipeline's
  // audit-logging wrapper is actually wired in, not just that the audit-log
  // store methods and read endpoint each work in isolation.
  it("a real /settle failure (kill-switch refusal) writes a settlement_failure row", async () => {
    const { app } = await buildAdminServer();
    await app.inject({
      method: "POST",
      url: "/admin/kill-switch",
      headers: { "x-admin-token": ADMIN_SECRET },
      payload: { enabled: true, reason: "e2e audit test" },
    });
    const settleRes = await app.inject({ method: "POST", url: "/settle", payload: settleBody(6) });
    expect(settleRes.statusCode).toBe(503);

    const auditRes = await app.inject({
      method: "GET",
      url: "/admin/audit-log?action=settlement_failure",
      headers: { "x-admin-token": ADMIN_SECRET },
    });
    const entries = auditRes.json().entries as Array<{ action: string; detail: { reason?: string } }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.detail.reason).toContain("e2e audit test");
    await app.close();
  });
});

describe("Operator Console — dashboard", () => {
  it("returns the documented top-level shape with an empty database", async () => {
    const { app } = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/admin/dashboard", headers: { "x-admin-token": ADMIN_SECRET } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      killSwitch: { enabled: false },
      settlements: { total: 0, last24h: 0, last7d: 0, successRate: 0 },
      errors: { last24h: 0, byReason: {} },
      catalog: { total: 0 },
      channelPool: { available: expect.any(Number), inUse: 0, disabled: 0 },
    });
    expect(typeof body.uptime).toBe("number");
    await app.close();
  });
});
