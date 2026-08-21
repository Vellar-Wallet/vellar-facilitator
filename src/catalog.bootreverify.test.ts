import { rmSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { BazaarCatalog } from "./catalog.js";
import type { OwnershipVerdict } from "./ownership.js";
import { reopen, seedRows, tmpStore } from "./store.testkit.js";

// Boot-time re-proof of durable latches (reverifyLatchedAtBoot).
//
// The badge (`verifiedOwner`) is per-process; the latch (`everVerified`) is
// durable. Before this pass, every restart served proven-unconfirmed for a
// latched entry until its owner's next settlement — on the free tier, every
// 15-minute spin-down grayed the flagship listing (runbook §1, "Standing
// caveat"). The pass re-probes ONLY entries admitted by the durable latch, so
// it can re-display a proof but never grant one: the "settle-triggered ONLY"
// decision in catalog.reverify.test.ts stands for first-time verification.
//
// What must hold, each asserted below:
//  - match flips the badge, WITHOUT a durable write (the latch already exists);
//  - mismatch / timeout / unverifiable leave the honest proven-unconfirmed;
//  - entries without the latch are never probed (no granting);
//  - templated keys and already-badged entries are never probed;
//  - outbound concurrency is bounded;
//  - reverifyPending counts down to 0, resolved or failed alike.

const OWNER = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";

const urls: string[] = [];
afterEach(() => {
  while (urls.length) {
    const u = urls.pop()!;
    if (u.startsWith("file:")) rmSync(u.slice(5), { recursive: true, force: true });
  }
});

function entryPayload(key: string) {
  return {
    resource: {
      resource: key,
      type: "http",
      x402Version: 2,
      lastUpdated: "2026-08-01T00:00:00.000Z",
      accepts: [
        { scheme: "exact", network: "stellar:testnet", asset: ASSET, amount: "1", payTo: OWNER },
      ],
    },
    stats: { settlements: 1, payers: [OWNER], observed: 0 },
  };
}

/** A store holding `keys`, each bound to OWNER; those in `latched` also carry
 *  the durable verified latch — the state a restart wakes up to. */
async function seededCatalog(keys: string[], latched: string[]) {
  const { store, url } = tmpStore();
  urls.push(url);
  await store.init();
  await seedRows(url, {
    ownership: keys.map((key) => ({ key, payTo: OWNER })),
    entries: keys.map((key) => ({ key, payload: entryPayload(key) })),
  });
  const latcher = reopen(url);
  await latcher.init();
  for (const key of latched) await latcher.markVerified(key, OWNER, 1);
  await latcher.close();
  await store.close();
  const restarted = reopen(url);
  const catalog = await BazaarCatalog.create(restarted);
  return { catalog, url };
}

describe("reverifyLatchedAtBoot — re-displays earned proof, never grants it", () => {
  it("match flips the badge; the durable latch is NOT re-written", async () => {
    const KEY = "https://api.a.example/quote";
    const { catalog } = await seededCatalog([KEY], [KEY]);
    expect(catalog.isVerifiedOwner(KEY), "RA-9: badge must rebuild false").toBe(false);
    expect(catalog.isEverVerified(KEY), "latch must load durable").toBe(true);

    // Spy on the store the catalog now holds: a re-latch would call markVerified.
    const anyCat = catalog as unknown as { store?: { markVerified: (...a: unknown[]) => Promise<void> } };
    expect(anyCat.store, "test reaches through to the live store").toBeDefined();
    const latchSpy = vi.spyOn(anyCat.store!, "markVerified");

    const verifier = vi.fn(async (_url: string, payTos: string[]): Promise<OwnershipVerdict> => {
      expect(payTos).toContain(OWNER);
      return "match";
    });
    await catalog.reverifyLatchedAtBoot(verifier);

    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith(KEY, [OWNER]);
    expect(catalog.isVerifiedOwner(KEY), "badge restored").toBe(true);
    expect(latchSpy, "no durable re-latch on every restart").not.toHaveBeenCalled();
    expect(catalog.reverifyPending).toBe(0);
  });

  it.each(["mismatch", "timeout", "unverifiable"] as const)(
    "%s leaves the honest proven-unconfirmed state",
    async (verdict) => {
      const KEY = "https://api.b.example/quote";
      const { catalog } = await seededCatalog([KEY], [KEY]);
      await catalog.reverifyLatchedAtBoot(async () => verdict);
      expect(catalog.isVerifiedOwner(KEY)).toBe(false);
      expect(catalog.isEverVerified(KEY), "latch untouched by a failed probe").toBe(true);
      expect(catalog.reverifyPending).toBe(0);
    },
  );

  it("a throwing verifier is contained: badge stays false, pending reaches 0", async () => {
    const KEY = "https://api.c.example/quote";
    const { catalog } = await seededCatalog([KEY], [KEY]);
    await catalog.reverifyLatchedAtBoot(async () => {
      throw new Error("prober exploded");
    });
    expect(catalog.isVerifiedOwner(KEY)).toBe(false);
    expect(catalog.reverifyPending).toBe(0);
  });

  it("never probes an entry without the durable latch — re-display, not granting", async () => {
    const LATCHED = "https://api.d.example/quote";
    const UNPROVEN = "https://api.e.example/quote";
    const { catalog } = await seededCatalog([LATCHED, UNPROVEN], [LATCHED]);
    const verifier = vi.fn(async (): Promise<OwnershipVerdict> => "match");
    await catalog.reverifyLatchedAtBoot(verifier);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith(LATCHED, [OWNER]);
    expect(catalog.isVerifiedOwner(UNPROVEN), "TOFU-only entry must not gain a badge").toBe(false);
  });

  it("skips a latched entry whose badge is already up", async () => {
    const KEY = "https://api.f.example/quote";
    const { catalog } = await seededCatalog([KEY], [KEY]);
    catalog.setVerifiedOwner(KEY, true);
    const verifier = vi.fn(async (): Promise<OwnershipVerdict> => "match");
    await catalog.reverifyLatchedAtBoot(verifier);
    expect(verifier).not.toHaveBeenCalled();
    expect(catalog.reverifyPending).toBe(0);
  });

  it("bounds outbound concurrency", async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `https://api.c${i}.example/quote`);
    const { catalog } = await seededCatalog(keys, keys);
    let inFlight = 0;
    let maxInFlight = 0;
    const verifier = async (): Promise<OwnershipVerdict> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return "match";
    };
    await catalog.reverifyLatchedAtBoot(verifier, 2);
    expect(maxInFlight, "at most `concurrency` probes outbound at once").toBeLessThanOrEqual(2);
    for (const k of keys) expect(catalog.isVerifiedOwner(k)).toBe(true);
  });

  it("reverifyPending is observable mid-pass and 0 after", async () => {
    const KEY = "https://api.g.example/quote";
    const { catalog } = await seededCatalog([KEY], [KEY]);
    let release!: (v: OwnershipVerdict) => void;
    const gate = new Promise<OwnershipVerdict>((r) => (release = r));
    const pass = catalog.reverifyLatchedAtBoot(() => gate);
    expect(catalog.reverifyPending, "visible while the probe is in flight").toBe(1);
    release("match");
    await pass;
    expect(catalog.reverifyPending).toBe(0);
    expect(catalog.isVerifiedOwner(KEY)).toBe(true);
  });
});
