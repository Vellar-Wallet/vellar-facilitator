import { Keypair } from "@stellar/stellar-sdk";

/**
 * A fresh set of exactly 50 valid, distinct Stellar secret keys — the
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
  return Array.from({ length: 50 }, () => Keypair.random().secret());
}
