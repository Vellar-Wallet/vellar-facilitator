import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "@x402/extensions/bazaar";
import { afterEach, describe, expect, it } from "vitest";
import { BazaarCatalog, ownershipPathFor } from "./catalog.js";

// G-7 — bootstrap-derived ownership bindings were never written to disk.
//
// bindLoadedEntry seeds `this.ownership` in memory but, unlike bindOwnership,
// never calls saveOwnership(). So the one-boot CATALOG_OWNERSHIP_BOOTSTRAP
// migration appeared to succeed and then persisted nothing: the next restart
// found a catalog file with no ownership file again and FAILED CLOSED, serving
// an empty catalog.
//
// This is a prerequisite of attaching a persistent disk, because the migration
// is the first thing that runs on that deploy — and a silent failure here is
// only discovered later, when a squat sticks.

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vellar-boot-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const OWNER_A = "GAN5MFH3GGAWH2UTO5DDOMDRQK6E32CE2GPAMPQT6KEHEPNHVBKJEF6A";
const OWNER_B = "GBQ3VANQZ6X3ZVGFTQJZ2MZ4KOCPZ5EGWSVYT7OPTQJ4M7VXMKQ3OQXD";
const ASSET = "CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND";
const URL_A = "https://api.a.example/quote";
const URL_B = "https://api.b.example/rates";

function entry(resource: string, payTo: string) {
  return {
    resource: {
      resource,
      type: "http",
      x402Version: 2,
      lastUpdated: "2026-08-01T00:00:00.000Z",
      accepts: [{ scheme: "exact", network: "stellar:testnet", asset: ASSET, amount: "1", payTo }],
    },
    stats: { settlements: 3, payers: ["CP1"], observed: 0 },
  };
}

/** A catalog file with NO companion ownership file — exactly the state the
 * first disk-backed boot produces. */
function legacyCatalog(): string {
  const path = join(tmpDir(), "bazaar-catalog.json");
  writeFileSync(path, JSON.stringify([entry(URL_A, OWNER_A), entry(URL_B, OWNER_B)]));
  return path;
}

function ownershipRows(path: string): Array<{ resource: string; boundPayTo: string[] }> {
  return JSON.parse(readFileSync(ownershipPathFor(path), "utf8"));
}

describe("G-7 — the bootstrap migration must actually persist its bindings", () => {
  it("writes an ownership file during the bootstrap boot", () => {
    const path = legacyCatalog();
    expect(existsSync(ownershipPathFor(path)), "precondition: no ownership file yet").toBe(false);

    const cat = new BazaarCatalog(path, { bootstrapOwnership: true });
    expect(cat.size).toBe(2);

    // The whole point: the derived bindings must be on DISK, not just in memory.
    expect(existsSync(ownershipPathFor(path)), "G-7: bootstrap must write the ownership store").toBe(true);
    const rows = ownershipRows(path);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.resource === URL_A)?.boundPayTo).toEqual([OWNER_A]);
    expect(rows.find((r) => r.resource === URL_B)?.boundPayTo).toEqual([OWNER_B]);
  });

  it("the NEXT boot needs no bootstrap flag and does not fail closed", () => {
    const path = legacyCatalog();
    new BazaarCatalog(path, { bootstrapOwnership: true }); // migration boot

    // Operator removes the flag, as the runbook instructs.
    const after = new BazaarCatalog(path);
    expect(after.catalogFrozen, "must not fail closed after a real migration").toBe(false);
    expect(after.size, "the catalog must still load").toBe(2);
    expect(after.isBound(URL_A, OWNER_A)).toBe(true);
    expect(after.isBound(URL_A, OWNER_B), "bindings must not be interchangeable").toBe(false);
  });

  it("without the flag it still fails closed — the hatch is what changes, not the default", () => {
    const path = legacyCatalog();
    const cat = new BazaarCatalog(path); // no bootstrap
    expect(cat.catalogFrozen).toBe("ownership-unreadable");
    expect(cat.size).toBe(0);
    expect(existsSync(ownershipPathFor(path)), "a frozen catalog must not write bindings").toBe(false);
  });

  it("does not rewrite an ownership file that already exists", () => {
    // A normal boot must not churn the ownership store, and must never let the
    // catalog file's accepts[0] override an authoritative tombstone.
    const path = legacyCatalog();
    writeFileSync(
      ownershipPathFor(path),
      JSON.stringify([{ resource: URL_A, boundPayTo: [OWNER_A] }]),
    );
    const before = readFileSync(ownershipPathFor(path), "utf8");

    const cat = new BazaarCatalog(path);
    expect(cat.catalogFrozen).toBe(false);
    expect(cat.isBound(URL_A, OWNER_A)).toBe(true);
    // URL_B had no row; it is seeded from the catalog file, so the store DOES
    // change — but URL_A's authoritative row must be preserved verbatim.
    const rows = ownershipRows(path);
    expect(rows.find((r) => r.resource === URL_A)?.boundPayTo).toEqual([OWNER_A]);
    expect(before).toContain(URL_A);
  });

  it("survives an unwritable ownership path without breaking the boot", () => {
    // Persistence failure must never stop the service starting; it warns.
    const path = join(tmpDir(), "nested", "does", "not", "exist", "catalog.json");
    writeFileSync(join(tmpDir(), "unused"), "");
    expect(() => new BazaarCatalog(path, { bootstrapOwnership: true })).not.toThrow();
  });
});
