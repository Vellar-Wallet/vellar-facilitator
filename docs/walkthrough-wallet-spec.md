# Test-wallet spec for the end-to-end walkthrough

Hand this to whoever provisions the wallet. Everything here was read out of
`examples/buyer.mjs` and the live seller's 402, not from memory.

**This is a THROWAWAY TEST WALLET.** Constraints at the bottom are not optional —
a previous test wallet became a long-lived JSON full of cleartext secrets and had
to be burned on-chain.

---

## 1. What `buyer.mjs` requires

Three environment variables, all mandatory (`examples/buyer.mjs:46-52`):

| Var | What it is |
| --- | --- |
| `WALLET_CONTRACT_ID` | `C…` — the smart-account contract that PAYS |
| `AGENT_SECRET` | `S…` — an **ed25519** keypair registered as a signer on that wallet |
| `SIM_SOURCE_ACCOUNT` | `G…` — a funded **classic** account, used ONLY as the transaction/simulation source |

### Why `SIM_SOURCE_ACCOUNT` must be a different account from the payer

The payer's authorization must be **address credentials**
(`sorobanCredentialsAddress`), because `buyer.mjs:105` skips any auth entry that
isn't. If the payer is also the transaction source, Soroban emits
**source-account credentials** instead and the scheme rejects it with
`unsupported_credential_type`. So the simulation source must be a separate,
funded classic account. It signs nothing of consequence — the facilitator
sponsors the fee.

### Signer type, role, and the exact signature format

The agent key is **ed25519**, and the wallet's `__check_auth` must accept it as an
authorized signer. `buyer.mjs:110-116` builds the signature in the passkey-kit
shape, and nothing else will verify:

```js
scKey = SignerKey  UDT, tag "Ed25519", value = agent.rawPublicKey()   // 32 bytes
scSig = Signature  UDT, tag "Ed25519", value = agent.sign(hash(preimage.toXDR()))  // 64 bytes
creds.signature(scvVec([ scvMap([ { key: scKey, val: scSig } ]) ]))
```

Note the shape: **a vec containing a map of signer → signature.** A bare
ed25519 signature will not verify. The UDT names are resolved from the deployed
contract's own spec via `PasskeyClient(...).spec` (`buyer.mjs:67-69`), so the
wallet must be a **passkey-kit-compatible smart account** exposing `SignerKey`
and `Signature` UDTs.

`signatureExpirationLedger` is set to **latest + 12** (`buyer.mjs:100`). Do not
widen it: `+100` is rejected as
`invalid_exact_stellar_signature_expiration_too_far`.

### Policy attachment — NOT required, but if present it must permit this payment

`buyer.mjs` needs no policy; `RECIPIENT_STATUS` only prints a banner and changes
no behaviour (`buyer.mjs:55-63`).

**If a policy IS attached, it must allow this recipient and amount.** A previous
demo wallet refused every payment because a verified-recipient policy had the
recipient in a revoked state, and it presented as an opaque `__check_auth`
failure. Either attach no policy, or confirm the policy admits
`GBDZH5KZSVX67MEWPTEMSOP6FBHKYX4GYOW4RRM4JENRC4XZF5UHTKOP` before handing over.

`SignerLimits` must not exclude the SEP-41 `transfer` on the asset below.

---

## 2. Funding — read from the seller's live 402

The seller advertises this challenge right now; the wallet must satisfy it
exactly:

| Field | Value |
| --- | --- |
| resource | `https://vellar-seller-demo.onrender.com/quote` |
| network | `stellar:testnet` |
| asset | `CBIN4HTPJM2QLJ32DTRO6OCLIMM7TR7D74JDIPVQYLNYGL7SBWOXH5ND` (X402TST) |
| payTo | `GBDZH5KZSVX67MEWPTEMSOP6FBHKYX4GYOW4RRM4JENRC4XZF5UHTKOP` |
| amount | `1000000` atomic |

**Yes — the challenge names a specific asset, and it is not XLM.** The wallet must
hold that SEP-41 token.

What to fund:

1. **`WALLET_CONTRACT_ID` — X402TST balance: fund `50000000` atomic.**
   Corrected — the earlier "~15 settlements / 20000000" did not cover the plan
   in §6. Real count: 1 bind + 2 for G-3 + 11 for the F12 trigger + 2 for
   F11/G-4 + 2 after the restart ≈ **18 settles**, and `50000000` leaves room
   for retries and mistakes. F3 refusals cost nothing — `/settle` returns 503
   before any transfer.
2. **A SECOND recipient account, trustlined to X402TST.** Needed for F11/G-4:
   the attacker settle must **succeed on-chain** while the catalog refuses it,
   which is the entire point of that evidence. X402TST is a SAC, so the
   recipient needs a classic trustline or the transfer fails and the test proves
   nothing. Provide its `G…` — it receives ~2000000 atomic and holds nothing
   else.
3. **`SIM_SOURCE_ACCOUNT` — XLM.** Friendbot is sufficient; it only needs to
   exist and be a valid transaction source.
4. **The wallet contract's own reserves** — whatever deploying it costs.
5. **Settlement fees: nothing.** The facilitator sponsors them
   (`GBUCR6H2…`). The buyer holds no XLM by design — that is the property being
   demonstrated.

Also confirm: **the recipient `GBDZH5KZ…` must be trustlined to X402TST**, or the
SEP-41 `transfer` fails on-chain and nothing downstream runs. `seller.mjs`
asserts it already is; verify rather than assume.

---

## 3. What does not exist yet

- The wallet contract, deployed on testnet
- The ed25519 agent signer registered on it
- Its X402TST balance
- A funded classic account for `SIM_SOURCE_ACCOUNT`

Nothing else is missing. The facilitator and seller are both deployed and
current.

---

## 4. Key-handling constraints — written to be followable

Amended after the first attempt to follow them. The original rule was **"no
secret to disk"**, and it was unachievable: an agent's shell state does not
survive between tool calls, so a key that must persist across a provisioning wait
has nowhere in memory to live. A rule that cannot be followed gets quietly
broken instead of followed, and the quiet part is the danger. These are the
properties that actually matter, and they are all achievable:

1. **Never printed.** Not to stdout, not into a log, and above all not into a
   conversation transcript. The transcript is the worst destination available —
   it is retained, it is searchable, and it is exactly how throwaway keys
   outlived their test run last time.
2. **Never an argument.** No `node buyer.mjs --secret S…`, no
   `export AGENT_SECRET=S…` typed literally. Command lines reach shell history,
   `ps` output, and harness logs. Generate and store in ONE process so the value
   is a *result*, never an argument:

   ```sh
   node -e '
     const {Keypair}=require("@stellar/stellar-sdk"), fs=require("fs");
     const kp=Keypair.random();
     fs.writeFileSync(process.env.SCRATCH+"/agent.key", kp.secret(), {mode:0o600});
     console.log("AGENT_PUBLIC="+kp.publicKey());   // public key ONLY
   '
   ```
3. **Never across a session boundary.** Whoever generates it holds it. It is not
   handed to another person, another agent, or another repo — only the `G…`
   public key travels.
4. **If it must persist, `0600` in a `0700` directory OUTSIDE the repo.** Never
   in the working tree, where it can be committed; never in `/tmp` proper, which
   is world-readable and is where the last live secret was found. A
   session-scoped scratchpad is the right home.
5. **A deletion step tied to the run's end** — see the completion checklist in
   §7. An intention to delete is not a plan; the last cleanup found a live secret
   nobody had scheduled to remove.

### Register it as a test wallet

Add to `docs/decisions.md` when provisioned:

```
## <date> — TEST WALLET for the E2E walkthrough (BURN BY <date + 14d>)
WALLET_CONTRACT_ID : C…
agent signer (pub) : G…        # ed25519, secret never persisted
SIM_SOURCE_ACCOUNT : G…
asset              : CBIN4HTP… (X402TST)
BURN DATE          : <date + 14d> — remove the signer on-chain and confirm
                     get_signer returns null, as done for the previous wallet.
```

---

## 5. What I will do with it

Only these three, exported in one session:

```sh
export WALLET_CONTRACT_ID=C…
export SIM_SOURCE_ACCOUNT=G…
export AGENT_SECRET=…            # generated as above, never typed
export RESOURCE_URL=https://vellar-seller-demo.onrender.com/quote
node examples/buyer.mjs
```

---

## 6. What counts as proven — agreed in advance

For each of the six controls that today have **unit tests only**, this is the
observable evidence I will capture. Three are strongly observable from outside;
three are not, and saying so now is the point of writing this down first.

### Strongly observable — no logs, no config changes

| Control | Evidence |
| --- | --- |
| **F11 Layer 1** (TOFU binding) | Settle #1 from payTo **A** → `/discovery/resources` shows the entry with `accepts[].payTo == A`. Settle #2 declaring the **same** resource URL with payTo **B** → the entry is **unchanged** (still only A). Critically, settle #2 must **succeed on-chain** — captured as a tx hash — so this is the catalog refusing, not the payment failing. That distinction is what made the original F11 repro credible. |
| **G-3** (canonical key) | Settle against `…/quote?topic=x`, then `…/quote?topic=y`. The catalog must hold **exactly one** entry keyed `https://…/quote` with **no query string**, and `catalogSize` on `/health` must be 1, not 2. |
| **G-4** (stats gate) | Capture `trust.settlements` and `trust.uniquePayers` immediately before and after the rejected settle #2 above. Both must be **unchanged**, and `observedSettlements` must not move. A rejected upsert must not credit the victim. |

### Observable only in the service log

| Control | Evidence, and the caveat |
| --- | --- |
| **F12** (spend budgets) | **`rate_limited_url` only.** The policy is LOG-ONLY on testnet (`enforced` is false off pubnet, `src/policy.ts:111-112`), so there is **no 503** — the evidence is `[policy] settle would be refused on pubnet` carrying `wouldReject: "rate_limited_url"`, from an 11th settle for the same bound URL inside 60s. **Requires pulling the Render logs.** |

#### Why the other two F12 triggers stay unit-tested

Worked out rather than assumed, after the funding question exposed it. The seller
serves exactly **one** path, so every stock-buyer settle canonicalizes to the same
key and is bound after settle #1. Budgets are checked payTo-first, then per-URL:

- `rate_limited_payto` trips at settle **51**, `rate_limited_url` at **11**. The
  URL limit always fires first, so **the payTo limit is unreachable** with one
  URL. Reaching it needs ≥5 distinct *bound* URLs under one payTo (5 × 10 = 60 ≥
  51), and the seller has one path.
- `unbound_pool_exhausted` needs 10+ settles where `bound=false` — resource URLs
  *not* bound to the settling payTo. Every stock settle is for the seller's URL,
  bound after the first.

Both could be forced by fabricating resource URLs in the payload, but that means
**a bespoke client**, and a control demonstrated only by bespoke tooling proves
less than one demonstrated on the real path. They keep their unit tests, which
are mutation-verified, and this is recorded as the reason rather than an
omission.

**One honest exception:** F11 Layer 1 and G-4 *do* need a modified buyer, because
the stock client only echoes the seller's own challenge and cannot declare
someone else's URL with its own payTo — which is precisely the attack. That
mirrors the original F11 repro, which `docs/decisions.md` records as using "a
throwaway copy of the spike payer". The attacker tooling is bespoke by necessity;
the **facilitator side under test is the real deployed code**, which is what the
evidence is about.

### Not observable on this deployment, and why

| Control | Why not, and the honest alternative |
| --- | --- |
| **G-1** (re-verify on settle) | G-1's specific path is *a **restored** entry recovering `verifiedOwner`*. Entries never survive a restart here — there is no persistent disk — so after any restart the next settle is a **first** catalog, which would have verified anyway. **G-1 cannot be distinguished from first-catalog verification on this deployment.** What I *can* prove, and what has never happened, is `trust.ownerVerified: true` arriving through the settle path end-to-end. I will report that as what it is, and leave G-1 itself unproven until durable storage exists. |
| **F3** (balance guard) | Refusing below the hard floor requires the sponsor below 10 XLM. I will **not** drain it. The only honest alternative is a deliberate config flip: temporarily set `SPONSOR_HARD_FLOOR_STROOPS` above the sponsor's current balance, confirm `/settle` returns `503 settlement_refused` with `reason: sponsor_balance_low`, then revert. That needs your approval and a dashboard change — I will not do it unasked. |

### The restart test

After the settles above:

1. Capture `/health` — `catalogSize`, `commit`, `uptimeSeconds`.
2. Force a restart (redeploy, or wait out the 15-minute spin-down).
3. Confirm `uptimeSeconds` reset, `catalogSize: 0`, and `/discovery/resources`
   empty — **entries and bindings both gone**.
4. Settle once more; confirm the entry returns and the URL re-binds.
5. Confirm the previously-refused payTo **B** can now claim the URL — because
   with no persistence the TOFU race genuinely reopens. That is the documented
   weakness, and demonstrating it is more useful than asserting it.

### What this walkthrough will NOT establish

Concurrency, sustained load, sequence-number behaviour under bursts, or anything
about pubnet. It is one payer, one merchant, on testnet — the same boundary
`docs/decisions.md` states for the original smoke, and it does not move.

---

## 7. Completion checklist — the run is not done until every box is ticked

Written here, at the end of the procedure, because the previous cleanup found a
live secret in world-readable `/tmp` that **nobody had scheduled to remove**. It
was not forgotten through carelessness; it was never written down as a step. An
intention to clean up is not a plan.

### Secret material

- [ ] **Delete the agent key file** and confirm it is gone:
      ```sh
      rm -f "$SCRATCH/agent.key" && ls -l "$SCRATCH/agent.key" 2>&1 | grep -q 'No such file' \
        && echo "agent.key deleted"
      ```
- [ ] **Sweep for any other secret material** left by the run — the last sweep is
      the reason this line exists:
      ```sh
      grep -rlE 'S[A-Z2-7]{55}' "$SCRATCH" /tmp 2>/dev/null | head
      ```
      Any hit must be checked with `Keypair.fromSecret` — a string of the right
      *shape* is not necessarily a key, and the repo's own test fixture fails
      checksum validation. Delete anything that parses.
- [ ] **Confirm no secret entered the repo:**
      ```sh
      git status --short && git grep -lE 'S[A-Z2-7]{55}' -- . | grep -v test
      ```

### On-chain

- [ ] **Remove the agent signer from the wallet**, and confirm `get_signer`
      returns `null` on-chain — the same confirmation used for the previous
      wallet. Do not treat the removal transaction as proof; read the state back.
- [ ] The signer entry **remains visible in history afterwards**. That is
      expected — the CC5ZSTLT precedent — and is not an incomplete burn. Removal
      is proven by `get_signer` returning null, not by absence from history.

### Configuration left behind

- [ ] **`SPONSOR_HARD_FLOOR_STROOPS` reverted to `100000000`** if the F3 flip was
      run. Nothing reconciles a dashboard variable and nothing warns about it —
      see the sibling-trap box in `docs/operator-runbook.md` §2. Confirm a settle
      succeeds afterwards, rather than assuming the revert took.
- [ ] **`CATALOG_OWNERSHIP_BOOTSTRAP` unset**, if it was ever set.
- [ ] **The demo seller can be left running** — it holds no secret and sleeps on
      its own. Only its instance hours matter, and they are pooled per workspace.

### Record

- [ ] **Append the wallet to `docs/decisions.md`** with public values only and a
      **burn date**, per §4.
- [ ] **Record the walkthrough results against §6's pre-agreed evidence** —
      including the controls that came back unproven. A result that only lists
      what passed is the failure mode this whole exercise exists to avoid.
