#!/usr/bin/env bash
# One command: clean clone → settled testnet payment, hash printed.
#
#   ./demo.sh              # throwaway token (self-contained)
#   USE_USDC=1 ./demo.sh   # canonical testnet USDC, bought on the DEX
#
# Each preflight below names the real failure it prevents (pattern credit:
# Turnpike's demo.sh, Apache-2.0).
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1mCannot start:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js is not installed (need >=20)."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node $(node -v) too old — @x402 packages fail at RUNTIME below 20, not at install."
for port in 4100 4031; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && die "Port $port is in use. A stack from another clone would pay the WRONG seller and fail confusingly. Stop it first."
done

say "1/5  Installing (root + examples)"
[ -d node_modules ] || npm install --no-audit --no-fund
[ -d examples/node_modules ] || (cd examples && npm install --no-audit --no-fund)

say "2/5  Provisioning testnet accounts (friendbot — no secrets needed)"
PROV=$(cd examples && node provision-testnet.mjs)
PAYTO=$(grep -oE '^PAYTO=\S+' <<<"$PROV" | cut -d= -f2)
ASSET=$(grep -oE '^ASSET=\S+' <<<"$PROV" | cut -d= -f2)
PAYER_SECRET=$(grep -oE '^PAYER_SECRET=\S+' <<<"$PROV" | cut -d= -f2)
[ -n "$PAYTO" ] && [ -n "$ASSET" ] && [ -n "$PAYER_SECRET" ] || die "provisioning did not print the expected env block"
SPONSOR=$(node -e 'const{Keypair}=require("@stellar/stellar-sdk");const k=Keypair.random();console.log(k.secret()+" "+k.publicKey())')
curl -fsS "https://friendbot.stellar.org/?addr=${SPONSOR#* }" >/dev/null

# The settlement pool. src/config.ts requires EXACTLY 50 distinct funded
# classic secrets, none of them the sponsor's, and there is no
# "pool disabled" fallback: settling every payment from one signer under
# concurrency is the txBadSeq bug the pool exists to close
# (docs/channel-pool-design.md §1). Before this block existed the facilitator
# exited at boot and demo.sh reported "seller did not come up", which is the
# seller failing to reach a facilitator that was already dead (issue #90).
#
# Keys live in a shell variable and are never written to disk. They are
# throwaway testnet accounts good for one demo run, so a file would be a
# gitignore liability for no benefit.
say "2b/5  Provisioning 50 channel accounts (friendbot, ~5 at a time)"
CHANNEL_KEYS=$(node -e '
const { Keypair } = require("@stellar/stellar-sdk");
const N = 50, CONCURRENCY = 5;
const pairs = Array.from({ length: N }, () => Keypair.random());
let done = 0;
async function fund(kp) {
  // Friendbot occasionally 503s or times out under burst. Retry a few times
  // rather than failing the whole demo on one flaky request.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
      if (res.ok) { process.stderr.write(`\r  funded ${++done}/${N}`); return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw new Error(`friendbot failed for ${kp.publicKey()} after 4 attempts`);
}
(async () => {
  const queue = [...pairs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await fund(queue.shift());
    }),
  );
  process.stderr.write("\n");
  console.log(pairs.map((k) => k.secret()).join(","));
})().catch((e) => { console.error(e.message); process.exit(1); });
') || die "could not fund the 50 channel accounts (friendbot may be rate-limiting; re-run once)"
[ "$(tr -cd , <<<"$CHANNEL_KEYS" | wc -c)" -eq 49 ] || die "expected 50 channel keys, got $(( $(tr -cd , <<<"$CHANNEL_KEYS" | wc -c) + 1 ))"

say "3/5  Booting facilitator (:4100) + seller (:4031)"
mkdir -p data
SPONSOR_SECRET_KEY="${SPONSOR%% *}" CHANNEL_ACCOUNT_SECRET_KEYS="$CHANNEL_KEYS" \
  PORT=4100 CATALOG_DB_URL=file:./data/catalog.db npm start >demo-facilitator.log 2>&1 &
FAC_PID=$!
for i in $(seq 1 60); do curl -fsS localhost:4100/health >/dev/null 2>&1 && break; sleep 2; done
(cd examples && FACILITATOR_URL=http://localhost:4100 SELLER_PORT=4031 PAYTO="$PAYTO" ASSET="$ASSET" node seller.mjs >../demo-seller.log 2>&1) &
SEL_PID=$!
trap 'kill $FAC_PID $SEL_PID 2>/dev/null || true' EXIT
for i in $(seq 1 90); do curl -fsS localhost:4031/whoami >/dev/null 2>&1 && break; sleep 2; done
curl -fsS localhost:4100/health >/dev/null 2>&1 || die "the FACILITATOR did not come up — see demo-facilitator.log (it exits at boot on a config error, and the seller then has nothing to reach)"
curl -fsS localhost:4031/whoami >/dev/null || die "seller did not come up — see demo-seller.log"

say "4/5  Paying (official x402 client; submission retries are internal now)"
PAID=$(cd examples && RESOURCE_URL=http://127.0.0.1:4031/quote PAYER_SECRET="$PAYER_SECRET" node buyer-classic.mjs 2>/dev/null) || die "payment failed — see demo-facilitator.log (testnet RPC has bad days; re-run once)"
TX=$(node -e 'const o=JSON.parse(process.argv[1]);console.log(o.settlement?.transaction??"")' "$PAID")

say "5/5  Done — settled on Stellar testnet"
echo "  tx:        $TX"
echo "  explorer:  https://stellar.expert/explorer/testnet/tx/$TX"
echo "  catalog:   $(curl -fsS 'localhost:4100/discovery/resources' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.items.length+" resource(s), first: "+(j.items[0]?.resource??"none"))})')"
echo
echo "  Stack still running for exploration (Ctrl-C or kill $FAC_PID $SEL_PID to stop)."
echo "  Logs: demo-facilitator.log, demo-seller.log. State: ./data (safe to delete)."
wait
