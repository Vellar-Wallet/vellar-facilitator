import { Keypair } from "@stellar/stellar-sdk";

/**
 * A fresh set of valid, distinct Stellar secret keys sized to the configured
 * pool — the
 * shape `FacilitatorConfig.channelAccountSecretKeys` requires
 * (docs/channel-pool-design.md §2) — for tests that construct a
 * `FacilitatorConfig` object literal directly rather than going through
 * `loadConfig()` (which has its own dedicated coverage in
 * config.channelpool.test.ts). These tests don't exercise channel-pool
 * behavior themselves; they just need a config object that type-checks and
 * satisfies loadConfig's own invariants, so a fresh Keypair.random() per
 * call is simplest — no fixed fixture to accidentally collide with a
 * sponsor key some other test picks.
 */
export function fakeChannelAccountSecretKeys(): string[] {
  // Reads the same env var loadConfig() does, so a test run with
  // CHANNEL_POOL_SIZE set still produces a config that satisfies the exact-count
  // check. Hardcoding 50 here would make every one of these tests fail under a
  // non-default pool size, for a reason that has nothing to do with what they
  // are testing.
  const raw = process.env.CHANNEL_POOL_SIZE;
  const n = raw ? Number(raw) : 50;
  const size = Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50;
  return Array.from({ length: size }, () => Keypair.random().secret());
}
