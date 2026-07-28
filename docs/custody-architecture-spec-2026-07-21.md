# ClawVille Custody Architecture — Two-Tier Vault/Spending Model (SPEC FOR REVIEW)

> Status: DECISION SPEC, founder-approved direction 2026-07-21, submitted for independent
> design review (Codex gpt-5.6-sol, high reasoning) BEFORE any implementation. The founder
> rates this among the most important architecture decisions of the project. Reviewer: your
> job is to attack it — soundness, gaps, race conditions, economics, regulatory optics,
> Solana-specific traps, migration safety, and anything we have not thought of.

## 1. The decision under review

Adopt a **two-tier custody model** for all ClawVille money:

- **Tier 1 — SPENDING wallets (hot path, self-custodied by our backend, $0/signature):**
  every avatar/agent keeps its EXISTING custodial Solana wallet (same address, same keys,
  our AES-256-GCM + CF-KEK envelope vault, server-side signing). It holds a small,
  policy-capped working balance and signs ALL high-frequency, low-value operations —
  x402 micropayments above all.
- **Tier 2 — VAULT wallets (cold-ish path, Turnkey-custodied, per-signature billed):**
  Turnkey (TEE enclave custody, policy engine in-enclave, SOC 2, ~$99/mo Pro,
  ~$0.01/sig → ~$0.0015/sig enterprise) holds (a) platform treasury / house /
  settlement-authority keys (imported, ADDRESSES PRESERVED — Turnkey supports key import),
  and (b) per-user vault wallets holding each user's balance above the spending ceiling.
- **Automatic tiering ("the bank model"), invisible to users:** one user-visible balance =
  spending + vault. Auto top-up vault→spending when the working balance runs low (ONE
  billed signature amortized over ~100s of micropayments); auto sweep spending→vault above
  the ceiling (bounded blast radius: a compromised hot key loses only the working balance).
  Deposits keep flowing to the ONE known address (the spending wallet); sweeps tidy up.
  Withdrawals/cashouts and large transfers sign from the vault under Turnkey policies.
- **Identity anchoring:** the spending wallet address is the agent's ON-CHAIN IDENTITY —
  the SAP AgentAccount PDA derives from it, eip-8004.json cites it, attestations and
  reputation bind to it, Metaplex/1DREG identity assets point at it. It NEVER changes.
  The vault address is never user-visible and carries no identity.

### Founder rulings that CONSTRAIN this design (do not propose violating them)
- NO two-provider hybrid (Turnkey+Privy was rejected). One external custodian max: Turnkey.
- NO per-signature vendor on the micropayment path — the unit economics are dispositive
  (see §3). This killed "Privy/Turnkey for everything."
- Steward (self-hosted OSS custodian) was evaluated, stood up, and REJECTED by the founder.
  Do not re-propose it.
- Fiat on-ramp is OFF the roadmap (MoonPay parked). Do not design around fiat rails.
- No treasury SOL drips into user wallets (farming vector). Agents self-fund their on-chain
  costs from their own earnings (a USDC→SOL swap offer is a planned, separately-gated slice).
- Wallet addresses must never change for existing users/agents; nobody's play may be
  interrupted by migration; keys must remain recoverable from ≥2 independent stores (our
  existing encrypted rows are NEVER deleted — standing cold backup).

## 2. Full economy scope (every money surface; the reviewer must check the design against ALL)

**Ledger currencies (off-chain, in our Postgres):**
- **vCLAW** — the in-game dollar-tied currency (1 vCLAW = $0.01). Canonical write path
  `claw-token-ledger.transferClawTokens()`; never written directly. Earned via chat/quests/
  daily login/games; spent in shop/games/land. NOT on-chain. Guests get demo-only economy.
- **Earned-vs-purchased segregation** exists for redemption control (emission ≠ backing).

**On-chain assets (Solana mainnet on prod; devnet on staging):**
- **USDC** — the real-money medium. Custodial per-avatar ATAs.
- **$CLAWVILLE (CLV)** — the project token. First-party cosmetic-shop pricing bonus (25%
  on CLV pay), hold-tier checks via non-custodial wallet LINK (SIWS pointer, no custody).
- **SOL** — rent/fees only (SAP registration ~0.056, stake 0.1 where escrow-working).

**Money flows, one by one:**
1. **x402/PayAI micropayments — THE DOMINANT FUTURE FLOW.** Marketplace paywall + agent↔
   agent payouts (LIVE prod). Median tx ~$0.03. Payer's custodial wallet signs; PayAI
   facilitator settles. Volume goal: the majority of daily transactions. THE constraint
   that forced two tiers: at $0.01/sig a 3-cent payment loses 33% to signing.
2. **Composed USDC bounties (LIVE prod mainnet):** creator custody-at-post into SAP escrow
   vault (house agent = SAP worker) → verified completion → settle+finalize → x402 payout
   house→hunter → dust auto-reclaim. Conservation-exact, proven with real money.
3. **SAP on-chain layer:** agent identity registration (self-funded, first economic
   action), reputation writes (house attests/feedback on verified completions), escrow
   v1/v2, agent stake (0.1 SOL for escrow workers). House Coralia registered+staked on
   mainnet; settlement-authority-style keys exist for the wager program (devnet-only).
4. **Cove card games:** real-vCLAW ledger settlement (user + agent subjects; guests demo;
   no per-hand on-chain writes). NEVER a vCLAW faucet.
5. **Reef race / activities:** vCLAW rewards via activity match placement (capped,
   anti-farmed via salted fingerprints).
6. **Land economy (LIVE prod):** land purchase/upkeep in vCLAW today; rent UI + HOME-Lv2
   next. Founder direction: land stays the big-ticket surface (vault-tier candidates).
7. **Cosmetic shop:** first-party SKUs, vCLAW-priced, CLV bonus.
8. **E3 earned redemption (LIVE prod):** earned vCLAW → CLV cash-out. Durable pipeline
   (debit → CLV buy queue → delivery from the clv-swap treasury wallet), 444bps fee.
9. **CLV buy queue / swap treasury:** `treasury_wallets` purpose='clv-swap' executes DEX
   buys (clip-planned, impact-capped).
10. **Wallet withdraw (route built, DARK):** move own on-chain custody assets out —
    idempotency-keyed; the founder wants withdraw/claim UX opened as part of the custody
    truth story.
11. **Treasury wallets:** merchant supply (`treasury_wallets`, purpose-scoped: wager
    settlement authority, clv-swap, merchant); vanity keypairs; house agent wallets.
12. **Hatcher partner surface:** partner-signed agent registrations; custodial wallets for
    partner agents; real-vCLAW cove settlement for their agents (protected, ed25519 +
    harness-gated).
13. **Leaderboard economy events:** weighted, daily-capped, fingerprint-anti-farmed.
    Reputation/scoring consequences ride on the same identity wallet.

**Auth/identity plumbing that touches custody:**
- account ≡ agent ≡ avatar; one avatar per user; magic-link agent connect == account
  creation; wallet.secretKey returned EXACTLY ONCE at first connect (no re-emit, no
  recovery path server-side) — Phase 5.1 invariant.
- Phase 5.1 two-keypair split: identity ed25519 (signed-challenge reconnect) + Solana
  wallet (funds). CF-worker KEK envelope on newer rows; VANITY_ENCRYPTION_KEY AES-256-GCM
  on the vault.
- E5 HUMAN/AGENT PARITY IS MANDATORY: every economy surface must be reachable by both a
  human-driven and a hosted/connected agent, settling to the same avatar identity.

## 3. The unit-economics constraint (why two tiers is forced)

| Signer | $/sig | Share of a $0.03 x402 tx |
|---|---|---|
| Turnkey Pro | $0.01 | 33% |
| Turnkey enterprise | ~$0.0015 | 5% |
| Privy enterprise | ~$0.001 | 3.3% |
| Our own signing | ~$0 | ~0% |

At 1M micro-tx/mo ($30K volume), any per-signature vendor takes $1,000–1,500/mo = 3–5% of
flow. Payment-rail margins must be <1%. Hence: hot path on our keys, vendor only where
signatures are rare and valuable. Vault-tier signature population: top-ups, sweeps (if
vault-signed — see open question 5), cashouts, land-scale purchases, treasury ops,
escrow-funding legs. Estimated low thousands/month even at scale ⇒ Turnkey cost trivial.

## 4. Proposed mechanics (review these hard)

- **Working-balance ceiling:** per-wallet policy cap (initial: $10 equivalent USDC + small
  SOL float; auto-tunable per usage). Above ceiling ⇒ sweep candidate.
- **Auto top-up:** payment preflight detects shortfall ⇒ enqueue vault→spending transfer
  (Turnkey-signed, policy: only to the OWNED spending address, amount-capped, rate-limited)
  ⇒ retry payment. Async with the same durable-ledger discipline as our escrow gate
  (idempotency keys, claim-first, broadcast-unknown reconcile).
- **Sweep:** scheduled scan; spending balance − ceiling > dust threshold ⇒ transfer excess
  spending→vault. SIGNED BY THE SPENDING KEY (ours, free). Destination fixed to the user's
  vault address (allowlisted).
- **Balance display:** one number (spending + vault + in-escrow attribution as today).
  Deposits → spending address (the known address); oversized deposits swept next cycle.
- **Withdraw/cashout:** drains spending first, then vault (Turnkey policy: destination =
  user-provided address, human approval/limits configurable). This is where the founder's
  "people can't withdraw" gap gets opened, on the strongest custody.
- **Turnkey policies:** per-wallet spend caps, destination allowlists (top-ups only to the
  bound spending address), co-approval thresholds for large cashouts, quorum on treasury.
- **Lazy vault creation:** a user gets a vault wallet only when first crossing the ceiling.
  Most casual users never do; vault population stays small.
- **Migration:** Phase T1 import treasury/house/settlement-authority keys into Turnkey
  (addresses preserved; existing rows retained as cold backup). Phase T2 vault tier +
  tiering rules. Phase T3 open withdraw + summed-balance UI. No user-visible change at any
  phase; no address changes ever.

## 5. Open questions for the reviewer (in addition to attacking everything above)

1. **Per-user vault wallets vs pooled omnibus vault** (per-user segregation on-chain,
   negligible cost, cleaner "your funds" story) vs (one pooled vault + DB attribution,
   exchange-style commingling optics). Our lean: per-user, lazily created. Verdict?
2. **Where should SAP escrow funding legs sign from?** Today: creator's custodial wallet
   funds escrow at bounty post. Escrow amounts (≥$1 today, micro-denominated future) sit
   between micro and vault scale. Keep on spending tier (free, capped) or route through
   vault above a threshold?
3. **House/settlement keys in Turnkey:** the composed-bounty rail has the house signing
   settle/finalize legs at bounty cadence. If bounty volume grows, house signatures scale
   with bounties (billed). Is the house a hot-path key that should STAY self-custodied,
   with only treasury/cashout keys in Turnkey? Where exactly is the house/treasury line?
4. **SOL float management:** spending wallets need SOL for fees/rent; agents self-fund
   (no drips). Does the two-tier model change the planned USDC→SOL swap slice?
5. **Sweep signing:** sweeps signed by the hot key (free, but a compromised hot key could
   redirect sweeps if allowlist enforcement lives only in our backend) vs vault-side pulls
   (impossible — Solana can't pull) vs Turnkey-policy-verified destinations. How do we make
   sweep destinations tamper-evident?
6. **Failure modes:** Turnkey outage during top-ups (payments degrade to working balance
   only — acceptable?); our backend compromise (what does the attacker get at each tier?);
   key-import operational risk during T1.
7. **Regulatory/custody optics:** does per-user vault segregation + published custody-truth
   UX materially improve our posture vs today's single commingled-custody story?
8. **Anything the two-tier model breaks** in: E5 agent parity, Hatcher partner flows,
   guest demo economy, leaderboard anti-farm, E3 redemption, the wager program, Phase 5.1
   secretKey-once invariant, eip-8004/SAP identity docs.

## 6. What success looks like

Users/agents keep exactly today's experience (one address, one balance, instant micro-
payments) while: treasury-grade keys move into enclave custody with policies and recovery;
per-user funds above pocket-money live behind Turnkey policy enforcement; hot-key blast
radius is capped at the working balance; withdraw finally opens; and the whole thing costs
~$99–150/mo until real scale. The micropayment economy pays $0 in per-signature vendor tax.
