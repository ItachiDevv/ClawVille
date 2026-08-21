# Wallet Infrastructure Review — custody, lost keys, and the claim/withdraw gap (2026-07-21)

> ⛔ **PARTLY SUPERSEDED (2026-08-20, founder order): OOBE/SAP was removed as a partner** and its
> rails were deleted, so any passage below treating SAP as live infrastructure is historical. The
> custody conclusions (one unified signer under the payment rails; Turnkey vs Privy vs self-roll)
> are unaffected and still stand. Kept as a historical record.

> Founder ask (2026-07-21, during the SAP identity cost-policy decision): "a lot of people
> have probably forgotten their private keys… explore storing with Turnkey, Privy, Crossmint,
> make sure the PK is installed in the agent's runtime… people are going to lose wallets or
> don't know how to withdraw or claim earned vCLAW into ClawVille."
> This doc: (1) what our wallet stack ACTUALLY does today, (2) where the founder's concern
> is real vs already-covered, (3) provider evaluation, (4) recommendation.

## 1. What we run today (audited against code in this branch)

**Custodial avatar/agent wallets** (`wallet-service.ts`, `keypair-vault.ts`, Phase 5.1 in
`ARCHITECTURE.md §7`): server-generated Solana keypairs, AES-256-GCM encrypted at rest
(`VANITY_ENCRYPTION_KEY`; Phase 5.1 rows add CF-worker KEK envelope via `wallets.dek_wrapped`).
The SERVER can always decrypt + sign custodially (`loadAvatarWalletForSigning`) — every SAP
escrow, bounty payout, and x402 settlement already signs this way.

**The one-time secretKey** (`ensureWalletWithFirstTimeSecret`): shown to a connecting agent
EXACTLY once, never re-emitted (kill-the-build invariant). Critical nuance: **losing it does
NOT lose funds.** Funds sit in a custodial wallet the server can still sign for; account
access (email login / agent session) IS fund access. What a lost key actually costs:
- an agent that wanted to sign for itself (outside our backend) can't anymore;
- the Phase 5.1 signed-challenge reconnect path needs the identity key — an agent that lost
  it needs the account-level re-bind path instead.

**Withdraw** (`routes/wallet-withdraw.ts`): fully built (idempotency-keyed, durable states)
but **DARK — `WALLET_WITHDRAW_ENABLED` default false, zero withdrawals ever**. This is the
single biggest real gap behind "people can't withdraw": the rail exists and has never been
opened (it was gated pending adversarial review — the FEATURE_GATE block says so).

**vCLAW cash-out** (E3 earned-redemption, `earned-redemption.ts`): durable
requested→debited→bought→delivered pipeline behind `TOKENOMICS_REDEEM_ENABLED`; live per the
tokenomics rollout. Claiming INTO ClawVille (deposits) exists via the swap/on-ramp rails.

**Self-custody link** (`routes/wallet-link.ts`): non-custodial SIWS-lite pointer link for
humans (balance reads for hold-tiers); agent-path parity is the planned Phase C.

### Where the founder's concern is real
1. **UX, not custody:** nobody loses funds to a forgotten key today — but nothing TELLS
   users/agents that, and the withdraw gate has never been opened. "I lost my key so my
   money is gone" is currently a UX-truth even though it is custody-false.
2. **Agent-runtime signing:** hosted agents have no direct signing capability in their
   runtime — everything routes through our API custodially. That is arguably CORRECT
   (policy-checked, farm-resistant) but it isn't the "PK installed in the runtime" model
   the founder described. A delegated-signing model (below) gets both.
3. **Key-management blast radius:** one env symmetric key (`VANITY_ENCRYPTION_KEY`)
   decrypts every legacy-row wallet; Phase 5.1's CF-KEK envelope improved this for new
   rows. A TEE/MPC provider removes the raw-key-in-our-process risk entirely.

## 2. Provider evaluation (web research 2026-07-21; source URLs at bottom)

### Turnkey — TEE signing infrastructure (closest drop-in)
- Keys generated/stored/used inside hardware secure enclaves; Turnkey never sees raw keys;
  **user key export supported** (so no lock-in, and a real recovery/export story).
- Solana is first-class: in-enclave transaction parsing for policy evaluation, SPL +
  Token-2022 transfer policies, transaction management (blockhash/priority fees), **gas
  sponsorship** (agents never need SOL for fees — note: registration RENT is still real SOL).
- Non-interactive server/agent signing via API keys, sub-100ms; dedicated AI-agent product.
- Policy engine at the signing layer: per-wallet spend limits, allowlists, co-approval for
  high-value actions. Enforcement is off-chain ("refuses to sign").
- Pricing: free 100 wallets/25 tx·mo → PAYG **$0.10/signature** → Pro $99/mo at
  $0.01/sig (2,000 wallets) → enterprise to $0.0015/sig. Signature volume is the cost axis.
- SOC 2 Type II. No public breach/outage found.

### Privy (a Stripe company since 2025) — embedded + server wallets
- EOAs secured by TEE + Shamir secret sharing; custodial or user-controlled; key export
  supported. **Server Wallets** = the agent product (policies attached at creation).
- Solana supported but as plain EOAs (their smart-wallet abstractions are EVM-only) — on
  Solana it's conceptually closest to what we run today, with enclave custody + policies.
- Ecosystem: Coinbase AgentKit + SendAI integrations; an OpenClaw agentic-wallets skill.
  Stripe ownership brings Bridge fiat/stablecoin rails.
- Pricing is **MAU-based**: free <500 MAU / 50K sigs → $299–$499/mo tiers → enterprise
  ~$0.001/sig. MAU billing maps poorly to a big fleet of mostly-idle agent wallets.
- SOC 2 Type II. No public breach/outage found.

### Crossmint — smart-contract agent wallets (biggest shift, strongest guarantees)
- Solana **smart-contract wallets** with a dual-signer design: agent key sealed in a TEE +
  owner signer; signers rotatable **without migrating assets** (native recovery story).
- Policies (per-tx limits, rolling caps, allowlists) enforced **ON-CHAIN by the wallet
  contract** — a materially harder anti-farming guarantee than off-chain signing refusal.
- Payments-native: x402/MPP, card networks via lobster.cash (Visa/Circle), built-in fiat
  onramp — overlaps our PayAI x402 rail rather than just custody.
- Pricing: free tier **1,000 monthly-active wallets** (best free fit for a fleet).
- Strongest compliance posture: SOC 2 + MiCA CASP licenses across the EU.

### Steward (steward.fi, Steward-Fi/steward) — the open-source, self-hosted option (added same-day per founder pointer; evaluated from the repo + the waifu.fun session logs where it ran in production)
- **What it is:** MIT-licensed, self-hostable agent-wallet platform: encrypted vault + per-agent
  policy engine + approval queue + audit trail + credential proxy. Docker compose (API :3200,
  proxy :8080, Postgres, Redis) — fits our Hetzner boxes as-is. Multi-tenant. ~40-package
  monorepo, 645 commits since 2026-03, 403 test files incl. red-team suites.
- **ElizaOS-native (the strategic edge):** `@stwd/eliza-plugin` peer-deps on `@elizaos/core`
  2.0.0-alpha (our exact substrate); Shaw is the #2 committer (75 commits); Eliza Cloud
  provisions Steward tenants on login; waifu.fun runs every agent on it. This is effectively
  the ElizaOS ecosystem's wallet layer — an alignment Turnkey/Privy/Crossmint cannot offer.
- **Battle evidence from our own waifu sessions:** Steward auth was explicitly CLEARED in the
  June regression hunt (bug was Eliza Cloud's; Steward inbound auth byte-identical throughout).
  Policy audit sweeps reported zero anomalies since launch. Known gotchas captured: cross-tenant
  agents need a short-TTL HS256 bearer (tenant key 403s), `STEWARD_JWT_SECRET` is triple-duty.
- **Solana:** REAL at the vault/API layer — Ed25519, SPL + Token-2022 TransferChecked, v0
  versioned txs, adaptive priority fees, and a spoof-resistant `sign-solana` route that decodes
  the tx bytes to derive authoritative policy fields (fail-closed on undecodable instructions).
  GAP: the ElizaOS plugin's transfer ACTION is EVM-only today — Solana via the SDK call, so
  runtime wiring is on us. (waifu never exercised Solana signing; custody yes, signing no.)
- **Policy engine:** per-agent `spending-limit` (per-tx/day/week), `approved-addresses`
  (mint+recipient for SPL), auto-approve thresholds → approval queue, rate limits, quiet hours,
  fail-closed composition. "Agent may spend ≤ X USDC/day" is directly expressible — the
  farm-resistance our self-roll lacks.
- **Custody honesty (the trade-off):** SOFTWARE custody — AES-256-GCM with scrypt KDF domain
  separation + AAD context binding (strictly better than our single-env-key scheme), optional
  AWS-KMS/PKCS#11 envelope, and an external-custody interface. But the key is plaintext
  in-process at sign time in every mode except external custody; no TEE/MPC (their docs say so
  plainly, which is itself a good sign). NO external audit yet; core team is small (Sol + Shaw).
- **Migration friction:** no first-class raw-keypair import (generate or mnemonic-restore only)
  — adopting it for EXISTING wallets means a custom import script on vault primitives (needs an
  adversarial pass) or fresh wallets + balance sweep.
- **Cost:** $0 license; the price is ops (we run/patch/back up it) + owning the risk.

### Also-rans (checked, not shortlisted)
Fireblocks+Dynamic (enterprise MPC, overkill/pricier), Coinbase CDP Agentic Wallets
(overlaps Privy), thirdweb (EVM-centric), Phantom (no server-custody product), Para (no fit
surfaced).

| | Turnkey | Privy | Crossmint |
|---|---|---|---|
| Model | TEE signing service, EOA | TEE+SSS EOA | on-chain smart wallet, 2-signer |
| Policy enforcement | off-chain | off-chain | **on-chain** |
| Recovery | key export | key export | signer rotation, no migration |
| Cost axis | per-signature | per-MAU | free ≤1,000 active wallets |
| Rearchitecture cost | LOW (swap signer) | LOW-MED | HIGH (wallet addresses change) |

## 3. Recommendation

**Near-term (no provider needed — do regardless):**
1. **Open the withdraw gate** after its pending adversarial review — the rail is built; the
   founder's "people can't withdraw" is literally this env flag.
2. **Ship the custody truth in the UI**: a wallet panel stating funds are custodial and
   recoverable via account login (lost one-time keys ≠ lost funds), with the withdraw +
   vCLAW claim/redemption paths surfaced. Cheapest fix for the biggest perceived problem.
3. **Do NOT inject raw PKs into hosted-agent runtimes.** Delegated signing (server-side or
   provider policy engine) gives the agent the capability without the exfiltration risk.

**SUPERSEDED same-day — FOUNDER REJECTED STEWARD (2026-07-21 evening): "we're not going to
do Steward."** The Steward evaluation above stays for the record; the staging stack was torn
down and the import-bridge work reverted. Final direction below in "FINAL STATE".

**FINAL STATE 2026-07-21 (after Meridian/PayAI/Privy research rounds, two Opus agents each):**
1. **Layer map is settled: custody is ADDITIVE-UNDERNEATH, partners ride on top.** PayAI does
   NOT provision or custody wallets (docs explicit: facilitation only, payer wallet always
   client-side, never holds keys). Meridian ($MRDN, mrdn.finance) is an x402 FACILITATOR like
   PayAI — non-custodial for keys (it escrows receiver BALANCES with withdrawal controls,
   1% withdrawal fee), live on Base+USDC only today ("all chains" is roadmap). Integrating
   Meridian = a second payment rail beside PayAI (and its balance-escrow overlaps SAP
   escrow), NOT wallet infrastructure. SAP/OOBE also holds no keys. ⇒ The ONLY custody
   decision is Turnkey vs Privy vs keep-self-rolling, and it should be ONE unified signer
   under all rails — fragmenting custody across partner systems splinters policy enforcement
   and cross-feature settlement.
2. **Privy findings (the fear was wrong):** Server Wallets are signature/volume-metered, NOT
   MAU-metered (free tier = 50K signatures + $1M volume/mo — covers us until real scale;
   enterprise floor ~$0.001/sig ⇒ even 100K sigs/mo ≈ $50). Solana server signing is
   first-class (versioned txs, SPL, <20ms, 4-nines SLA); the policy engine explicitly covers
   SVM (spend limits, recipient/program allowlists, default-deny) with one caveat:
   simulation-based limits evaluate at the API layer, not fully in-enclave. **Key IMPORT
   preserves addresses** (base58 secret key via HPKE flow → same TEE protection) and EXPORT
   exists ⇒ migration in AND out with zero address churn. Ships an OpenClaw agentic-wallets
   skill (mirrors our agent-onboarding pattern); AgentKit provider; Stripe/Bridge fiat↔USDC
   ramps bundled (NOTE: founder has fiat on-ramp OFF the roadmap 2026-07-21, so this is a
   later-option, not a deciding factor). DILIGENCE ITEM before committing: written
   confirmation from Privy that backend-only server wallets accrue no MAU charges and the
   per-signature floor applies to Solana server-wallet volume.
3. **Decision frame (founder to pick):** Privy = bundled product (fleet + human-side embedded
   UX + agent-skill ecosystem + optional fiat rails; ~free at our volume). Turnkey = cleanest
   signing boundary (policy enforced inside the key-holding enclave, pure per-signature,
   $99/mo Pro; the conservative treasury-grade pick). Defensible hybrid: Turnkey for
   treasury/settlement-authority keys, Privy for the agent fleet. Both make idle wallets
   ~free; neither costs real money until scale. Steward wins on strategy (ElizaOS-native, the same
wallet layer Eliza Cloud + waifu.fun run, $0 license, self-hosted on boxes we already operate,
policy engine at least as expressive as Turnkey's) and loses on custody hardness (software
custody, key in-process at sign time, no external audit). Per our own money-path rules that
means: Steward may take the NON-money pilot (hosted-agent runtime signing with tight spend
policies) immediately; the CUSTODIAL money paths stay on our current vault until either
Steward's KMS/external-custody mode + a Codex adversarial pass clears it, or we choose Turnkey
TEE for that layer specifically. Hybrid end-state (Steward policy layer + hardened key backend)
is explicitly on the table.

**Turnkey (fallback for custody hardness)**, scoped to hosted-agent runtime signing:
- Least rearchitecture: it's a signer swap — wallet addresses can even be imported/exported,
  and our `loadAvatarWalletForSigning` seam is the single integration point.
- Solves the founder's three concerns at once: raw-key liability leaves our process (TEE),
  recovery/export exists, and per-wallet spend policies + co-approval give agents
  self-serve signing WITHOUT the farming exposure that killed treasury SOL drips.
- Cost gate before committing: measure our real signatures/month (SAP registrations,
  bounty settles, x402 payouts) — at PAYG $0.10/sig this dies; at Pro/enterprise
  ($0.01–$0.0015/sig) it's viable. Model first.

**Track Crossmint** for the LATER milestone where on-chain-enforced agent spend limits and
card/x402 agentic payments become product surface (it overlaps PayAI — a partnership-shape
question, not a pure custody swap). Privy only if Stripe rails become strategic.

Sources: turnkey.com/pricing · turnkey.com/blog/introducing-solana-policy-engine ·
docs.turnkey.com/ecosystems/solana · privy.io/pricing · privy.io/ai ·
docs.privy.io/wallets/using-wallets/solana/sign-a-transaction ·
blog.crossmint.com/solana-embedded-smart-wallets ·
docs.crossmint.com/solutions/ai-agents/agent-wallets/overview ·
crossmint.com/learn/agent-wallets-compared · fireblocks.com/blog/agents-next-wave-wallet-users
