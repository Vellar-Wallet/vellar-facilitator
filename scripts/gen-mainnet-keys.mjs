#!/usr/bin/env node
// Mainnet keypair generator — 1 sponsor + 50 channel accounts, in the exact
// shapes the Render dashboard and the funding step need.
//
// WHY A SCRIPT AND NOT 51 TRIPS THROUGH THE STELLAR LAB. Not convenience: the
// pool is validated at boot as EXACTLY 50 distinct secrets, none equal to the
// sponsor (src/config.ts, parseChannelAccountSecretKeys). Assembling that list
// by hand is 51 copy-pastes into one comma-separated string, where a duplicate,
// a missing key, or the sponsor pasted twice all fail at boot with an error the
// operator then has to map back to which of 51 values went wrong. Generating
// the list mechanically removes that whole class, and lets this script assert
// the pool invariants HERE — before any account is funded — rather than
// discovering them after 500 XLM has moved.
//
// WHAT IT DOES NOT DO. It does not touch the network: no funding, no
// submission, no Horizon call. It generates keys and writes them down. Funding
// is Step 3 of docs/mainnet-deployment-checklist.md and is deliberately a human
// action against real money.
//
// THE OUTPUT FILE IS THE HAZARD. scripts/.mainnet-keys-<timestamp>.json holds
// every secret in plaintext — the sponsor's and all 50 channel accounts'.
// Anyone holding it can sign as the facilitator. It is gitignored, this script
// refuses to run if that rule is missing, and the checklist's final step is to
// delete it. Treat it the way you would treat the sponsor secret itself,
// because it contains it.
//
// Run:  node scripts/gen-mainnet-keys.mjs

import { writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

/** Locked at 50 by src/config.ts's own parseChannelAccountSecretKeys, which
 *  rejects any other count rather than trimming or padding. Kept as a named
 *  constant so the mismatch is visible if that ever moves. */
const CHANNEL_POOL_SIZE = 50;

/** The rule this script's output depends on. Checked, not assumed — see the
 *  preflight below. */
const GITIGNORE_RULE = "scripts/.mainnet-keys-*.json";

// ── PREFLIGHT ───────────────────────────────────────────────────────────────
// Refuse to write secrets into a repo that would track them. This is the one
// failure that cannot be undone by noticing it afterwards: once a secrets file
// is committed and pushed, rotating all 51 accounts is the only real remedy.
try {
  const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
  if (!gitignore.includes(GITIGNORE_RULE)) {
    console.error(
      `\nREFUSING TO GENERATE KEYS.\n\n` +
        `  .gitignore does not contain "${GITIGNORE_RULE}", so the file this\n` +
        `  script is about to write — containing the sponsor secret and all 50\n` +
        `  channel secrets in plaintext — would be a tracked, committable file.\n\n` +
        `  Add this line to .gitignore, then re-run:\n\n` +
        `      ${GITIGNORE_RULE}\n`,
    );
    process.exit(1);
  }
} catch (err) {
  console.error(`\nREFUSING TO GENERATE KEYS: could not read .gitignore (${String(err)})\n`);
  process.exit(1);
}

// ── GENERATE ────────────────────────────────────────────────────────────────
const generated = new Date().toISOString();
const sponsor = Keypair.random();
const channels = Array.from({ length: CHANNEL_POOL_SIZE }, () => Keypair.random());

// Assert the invariants config.ts enforces at boot, HERE, before anything is
// funded. Keypair.random() collisions are not a realistic worry — this is a
// cheap check against a future edit that reuses a key or miscounts, which is
// the mistake that actually happens.
const secrets = channels.map((k) => k.secret());
if (secrets.length !== CHANNEL_POOL_SIZE) {
  console.error(`generated ${secrets.length} channel keys, expected ${CHANNEL_POOL_SIZE}`);
  process.exit(1);
}
if (new Set(secrets).size !== CHANNEL_POOL_SIZE) {
  console.error("duplicate channel key generated — refusing to continue");
  process.exit(1);
}
if (secrets.includes(sponsor.secret())) {
  console.error("sponsor key appears in the channel pool — refusing to continue");
  process.exit(1);
}

// ── OPERATOR SUMMARY ────────────────────────────────────────────────────────
const line = "=".repeat(64);
console.log(`\n${line}`);
console.log("=== VELLAR MAINNET KEYPAIRS ===");
console.log(`Generated: ${generated}`);
console.log(`Network:   stellar:pubnet`);
console.log(line);

console.log("\nSPONSOR ACCOUNT");
console.log(`Public:  ${sponsor.publicKey()}`);
console.log(`Secret:  ${sponsor.secret()}  ← KEEP SECRET, NEVER COMMIT`);
console.log("\nFund this account with at least 50 XLM. It pays every settlement's");
console.log("network fee and must stay above SPONSOR_HARD_FLOOR_STROOPS (10 XLM),");
console.log("below which /settle is refused.");

console.log(`\nCHANNEL ACCOUNTS (${CHANNEL_POOL_SIZE})`);
console.log("Public keys (fund each with at least 10 XLM):");
channels.forEach((k, i) => {
  console.log(`${String(i + 1).padStart(2, " ")}.  ${k.publicKey()}`);
});
console.log("\nThese need XLM ONLY — no USDC trustline, no payment asset. They");
console.log("never pay fees (the sponsor fee-bumps every settlement) and never");
console.log("hold the payment asset; funds move payer → payTo directly.");
console.log("See docs/channel-pool-design.md §5/§6.");

console.log("\nRENDER ENV VAR — paste this as CHANNEL_ACCOUNT_SECRET_KEYS:");
console.log(`\n${secrets.join(",")}\n`);

// ── MACHINE-READABLE FILE ───────────────────────────────────────────────────
const fileSafeTimestamp = generated.replace(/[:.]/g, "-");
const outPath = join(HERE, `.mainnet-keys-${fileSafeTimestamp}.json`);
const payload = {
  generated,
  network: "stellar:pubnet",
  sponsor: { publicKey: sponsor.publicKey(), secretKey: sponsor.secret() },
  channelAccounts: channels.map((k, i) => ({
    index: i + 1,
    publicKey: k.publicKey(),
    secretKey: k.secret(),
  })),
};
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
// Belt and braces: writeFileSync's mode is masked by the process umask, so set
// it explicitly. Owner-only, because every other reader on the box is one too
// many for a file holding 51 mainnet secrets.
chmodSync(outPath, 0o600);

console.log(`Written: ${outPath}`);
console.log("(mode 0600, owner-only)");

console.log(`\n${line}`);
console.log("⚠️  SECURITY WARNING");
console.log(line);
console.log("The JSON file contains all secret keys.");
console.log("  - Fund the public keys, then delete the file");
console.log("  - Never commit this file to git");
console.log("  - Never share the secret keys");
console.log(`  - ${GITIGNORE_RULE} is in .gitignore (verified before writing)`);
console.log("");
console.log("These are MAINNET keys. Funds sent to them are real. There is no");
console.log("friendbot and no undo — a lost secret is a lost account.");
console.log(`${line}\n`);
