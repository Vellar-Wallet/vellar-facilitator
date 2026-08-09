import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const SECRET = "SBJP6HHFTABK2GXVVFAKY6C4B7DDNB5PIEQXKUNL2ZAOBPWFOUOSTLVNMA";

// CATALOG_OWNERSHIP_BOOTSTRAP is an ESCAPE HATCH, not a feature. It derives
// ownership bindings from a catalog file an attacker could have written, so it
// must announce itself on every boot — the same standard as the sibling repo's
// ALLOW_INMEMORY. A one-line note in a doc loses to muscle memory months later.
describe("CATALOG_OWNERSHIP_BOOTSTRAP escape hatch", () => {
  it("defaults to off", () => {
    const c = loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    expect(c.catalogOwnershipBootstrap).toBe(false);
  });

  it("warns LOUDLY at boot whenever it is set — even if never used", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({ SPONSOR_SECRET_KEY: SECRET, CATALOG_OWNERSHIP_BOOTSTRAP: "1" });
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/CATALOG_OWNERSHIP_BOOTSTRAP/);
    // The log must state exactly what trust it grants: none beyond the file.
    expect(said).toMatch(/no more trust than that file already had|grants no/i);
    // And that it is meant to be temporary.
    expect(said).toMatch(/remove|once|temporar/i);
    warn.mockRestore();
  });

  it("does not warn when unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({ SPONSOR_SECRET_KEY: SECRET });
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).not.toMatch(/CATALOG_OWNERSHIP_BOOTSTRAP/);
    warn.mockRestore();
  });

  it("treats only an explicit truthy value as enabled", () => {
    for (const v of ["0", "false", "", "no"]) {
      expect(
        loadConfig({ SPONSOR_SECRET_KEY: SECRET, CATALOG_OWNERSHIP_BOOTSTRAP: v }).catalogOwnershipBootstrap,
        `value ${JSON.stringify(v)} must not enable the hatch`,
      ).toBe(false);
    }
    for (const v of ["1", "true", "TRUE"]) {
      expect(
        loadConfig({ SPONSOR_SECRET_KEY: SECRET, CATALOG_OWNERSHIP_BOOTSTRAP: v }).catalogOwnershipBootstrap,
      ).toBe(true);
    }
  });
});
