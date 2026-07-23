# x402 Partner-Alignment Implementation Specs — 2026-07-22

## PART 0 — CUSTODY DECISIONS (RATIFIED by founder 2026-07-22)

Final. Supersedes the earlier "no vendors anywhere" draft — the founder split custody by
purpose: programs where money must be LOCKED (staking), a vendor where money is only
STORED (savings), small capped hot wallets for spending.

1. **Staking / in-play money = program custody.** SAP escrow PDAs (live) for bounties;
   an audited Anchor vault program for stakes. No private key, rules are code, no admin
   seize, upgrade authority behind founders' Squads multisig + public timelock. Only a
   program can lock funds against their own owner — no vendor wallet can.
2. **Savings / large balances = VENDOR wallets — PRIVY (Codex-audited winner,
   2026-07-22), hard cap per wallet.** Four-way audit (Codex gpt-5.6-sol high, own web
   verification; log: scratchpad `codex-savings-vendor-audit.log`, brief `.md` beside it):
   - **Privy — WINNER.** Server/agent wallets are a self-serve product documented
     SEPARATELY from the Enterprise "custodial wallets" add-on. METERING (verbatim from
     the pricing FAQ, expanded via headless browser 2026-07-22): MAU = "any
     Privy-authenticated user with at least one active session in the last 30 days" —
     dormant wallets count ZERO; a signature = "any cryptographic signature request
     from a Privy embedded wallet"; above 10K MAU or 50K sigs/mo → Volume PAYG
     "$2,000 base fee + $0.05 per MAU above 10,000". Bills (savings tier only, 5–20%
     adoption, worst case = every savings owner active every month): **today $0 ·
     10x $0–$299/mo · 100x $499/mo** (3.5K MAU sits in the 2,500–9,999 tier; savings-
     cadence signatures never approach 50K). Best case: server wallets have no
     authenticated user sessions ⇒ 0 MAU, signature-metered only ⇒ $0 until ~12K+
     savings wallets — CONFIRM in the pre-commit check. Solana policy engine +
     documented 2-of-2 / user-owned structures; on-ramp rails bundled.
   - **Turnkey — runner-up.** Best-in-class Solana policy parsing (SOL + SPL/Token-2022
     amount/mint/destination, verified at docs.turnkey.com/features/policies/examples/
     solana); ~$27/mo today, but wallet-count cliffs (PAYG 1K, Pro 2K wallets) force
     sales-gated Enterprise at 100x — fails the no-sales-call rule at scale.
   - **Crossmint — DISQUALIFIED.** Custodial wallets + policy engine sit under
     Custom/contact-sales; Solana MPC docs say "contact us"; overage pricing unpublished.
   - **Steward — DISQUALIFIED for this tier.** Self-hosted, keys under an
     OPERATOR-HELD root (= ClawVille's own custody with better tooling; its docs
     disclaim non-custodial operation); strongest policy path is EVM-centric; v0.4.2,
     no audit. Possible salvage LATER as a policy/audit layer over tier-3 hot wallets.
   **BLOCKING pre-commit check (the tier fails without it):** prove in a self-serve
   Privy account that ClawVille's app/admin credentials ALONE cannot transfer, export,
   recover, or weaken policy on a Solana SOL+USDC wallet (user or independent quorum
   must own the wallet/policy — vendor infra alone does NOT remove our unilateral
   control; only the ownership structure does).
   **Cap semantics:** policies cap OUTGOING spend only — nothing can block unsolicited
   deposits to a public address, so "cap per wallet" = outgoing policy + balance
   monitoring + sweep of excess to tier 1 / user's own wallet.
3. **Hot wallets stay pocket money only** — hard per-wallet cap, per-tx/daily limits,
   destination allowlists in one signing seam. Excess auto-routes to tier 1/2. Never
   market the cap as a hard loss ceiling (inbound race is real).
4. **Withdraw-to-own-wallet opens after hardening** (parent/child legs, durable
   reservations, broadcast-unknown reconciliation — Codex B3/B4). Ratified, sequenced.
5. **Cold treasury = founders' Squads multisig** + house key split by purpose (capped
   payout signer, zero-value crank, settlement authority, swap execution, reserve
   custody — no omnibus key).

**PART 0b — TRADING TIER + CLAWPUMP VERDICT (added 2026-07-22 after 3-Opus-researcher
fleet + Codex gpt-5.6-sol synthesis; logs: scratchpad codex-pump-synthesis.{md,log}).**
Founder direction: agentic trading is the next big step; "we just migrated to Claw Pump"
— scope their agent tools.

- **Fourth wallet tier — TRADING (architecture accepted by both AIs):** every trading
  agent gets a SEPARATE, REPLACEABLE trading keypair — cryptographically distinct from
  the SAP identity wallet (trading on the identity wallet is UNACCEPTABLE: it is
  non-rotatable by SAP design, so compromise burns identity + funds together). Bounded
  float only; key lives outside the LLM runtime in an isolated ClawVille signer with an
  in-house pre-sign policy gate: resolve ALTs + semantically inspect every instruction
  (programs, writable accounts, authority/delegate/close ops, balance deltas), per-trade
  + rolling caps, token/program/route allowlists, rug/liquidity checks, simulation,
  idempotency, slippage + priority-fee ceilings, Jito bundling, circuit breakers, and
  AUTO-SWEEP of profits/excess to the savings vendor or Anchor vault. Honesty notes:
  program allowlists alone don't kill account-parameter abuse; wallet caps are
  monitored steady-state ceilings, not on-chain invariants. NO per-sig vendor on the
  trade path — verified: no serious Solana trading stack meters trade signing through
  one (solana-agent-kit, ElizaOS plugin-solana, Trojan, BonkBot, Photon all sign
  locally; Turnkey PAYG at trading cadence = $300/agent/mo overhead). Per-sig vendors
  MAY later gate unusually large trades and the sweep/withdrawal legs only.
- **pump.fun facts (verified from their org/npm):** NO wallet custody anywhere — all
  SDKs/APIs build unsigned txs the caller signs. Trading surface: @pump-fun/pump-sdk
  1.36.0 (bonding curve V1/V2, USDC pairs via *_v2) + @pump-fun/pump-swap-sdk 1.19.0
  (post-graduation AMM) + agent HTTP API (fun-block.pump.fun /agents/* — undocumented
  rate limits/stability). @pump-fun/agent-payments-sdk = agent MONETIZATION (on-chain
  invoices in USDC/wSOL + tokenized-agent buyback/burn, default 50% of revenue) — a
  future economy primitive, NOT custody. Protocol fees ~1.25% low-mcap → ~0.30%.
- **$CLAWVILLE ground truth:** mint Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA,
  GRADUATED to PumpSwap (~2026-04-16), mcap ~$57K, liq ~$19K. ClawPump's own $CLAW
  token (~$4M) is UNRELATED — never conflate.
- **ClawPump (clawpump.tech) is a ClawVille PARTNER — founder correction 2026-07-22:
  we migrated to their launchpad and partnered with them.** The Codex "research-only /
  more competitor than partner" verdict was rendered from PUBLIC docs without
  knowledge of the partnership — SUPERSEDED as a relationship call. The surviving
  technical questions, to be answered from the PARTNER/logged-in docs (founder
  provides login), before our agents' money touches their tools:
  (a) custody/signing semantics — their public pages conflict (non-custodial wallets
  vs hosted autonomous execution vs API-key-funded trades vs a `privateKey` tool
  param); the integration goal is THEIR tools decide, OUR wallets sign (our tier-4
  trading signer + policy gate) — confirm their MCP/REST supports an external-signer
  flow that never receives key material;
  (b) partner fee terms as they actually apply to us (public pages: 35% platform share
  of creator fees, 30% LLM markup, 10–85bps swap);
  (c) versioned API/MCP schemas, rate limits, SLA for the endpoints we'd depend on.
  Domain hygiene stands: clawpump.tech is canonical (their GitHub org links to it);
  clawpump.net / clawpumpsol.com remain untrusted until the partner confirms them.
- **Savings-vendor convergence:** Codex's cost-agnostic final call = TURNKEY (matches
  my recommendation; instruction-aware Solana/Jupiter policies, enclave evaluation,
  quorums, attestation). Codex correction to R2: Privy server-side trading + Solana
  policies DO exist — Privy remains a sound runner-up. FOUNDER CALL STILL PENDING:
  Turnkey vs Privy.
- **One-line architecture:** staking in audited programs · identity/everyday spend in
  the small immutable SAP wallet · savings capped behind the vendor · trading in its
  own aggressively capped, replaceable hot wallet that sweeps profits upward.

**NEW REQUIREMENT (founder 2026-07-22) — BYO-wallet detection at magic-link connect.**
A wallet's existence can't be sniffed; the agent must present it. Add an OPTIONAL wallet
proof to the connect handshake: agent supplies pubkey + signs a server challenge with it.
Present + valid ⇒ bind that wallet as the agent's money wallet, SKIP custodial
provisioning (SAP-registered agents always have one — AgentAccount PDA is derived from
the wallet, so a SAP identity lookup can pre-fill this). Absent ⇒ provision the capped
custodial hot wallet as today. Zero added human steps (one-step magic-link rule holds).
This changes the /connect wire contract ⇒ protected partner surface: PROTOCOL_VERSION
bump + mock-Hatcher harness green + skill-manual update, same diff.

One real cost unchanged: professional audit of the vault program before it holds real
money. Trail: memory `project_custody_architecture_converged.md`; Codex review in
cv-sap-identity (`docs/custody-architecture-review-codex-2026-07-21.md`).

---

Two founder-approved slices from the custody/partner research round (2026-07-21/22).
Independent of each other and of the custody decision list; implement in any order.
Workflow per repo rules: **Codex implements (gpt-5.6-sol high), Fable plans/reviews.**
Both are money-path work ⇒ staging-first, adversarial review, PARITY note, same-diff docs.

Research ground truth backing these specs (verified from source, 2026-07-22):
- PayAI ships NO wallet daemon (all 31 github.com/PayAINetwork repos + docs read). It
  ships MIT TS SDKs: `x402-solana` v2.0.4 (static since Feb 2026) + `agentic-payments`.
  No policy engine (optional per-call max only). Imports existing ed25519 keys.
- Meridian IS LIVE on Solana mainnet: facilitator program
  `Ro6hz1smrm5zDh73849eDqKna9dE1EkPsWekAB5rBWm`, USDC only (mainnet
  `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet `4zMMC9...ncDU`), ATOMIC
  payer→recipient settlement via up to three `transfer_checked` CPIs (platform fee,
  treasury fee, recipient net; each fee capped `MAX_FEE_BPS = 1000` = 10%). Payer signs;
  Meridian backend co-signs as fee payer and submits. NO balance escrow on Solana (the
  receiver proxy-balance model is EVM-only). NO key custody/provisioning anywhere.
  16+ EVM mainnets also live (Base, Arbitrum, Optimism, Polygon, BSC, ...). Sources:
  docs.mrdn.finance/payments/solana-program.md, /api-reference/supported-networks.md.

---

## SPEC 1 — PayAI payer-plumbing conformance pass (SMALL — est. half a day of Codex)

### Ground truth (origin/master)
- `apps/api/src/services/custodial-x402.ts` — payer plumbing ALREADY uses the official
  x402 standard packages: `@x402/core/client` (`x402Client`), `@x402/svm/exact/client`
  (`ExactSvmScheme`), `createKeyPairSignerFromBytes` (`@solana/kit`). Header: "no
  proprietary PayAI SDK" — deliberate.
- `apps/api/src/services/x402-payai.ts` — PayAI facilitator over plain HTTP
  verify→settle. Module contract: never throws on facilitator errors; settle only after
  `isValid:true`; `settled:true` only with non-empty tx signature.
- `apps/api/package.json` — `@x402/core|hono|svm ^2.9.0` (newer than PayAI's own SDK).

### Decision encoded (do not relitigate)
KEEP the standard `@x402/*` packages. Do NOT swap to PayAI's `x402-solana` package —
same API family, ours newer + vendor-neutral. "Partner alignment" = proven wire
conformance, not importing their package.

### Work items
1. **Contract-conformance tests** (the substance):
   `apps/api/src/services/__tests__/x402-payai-conformance.test.ts`
   - Golden-vector: build a payload via `prepareCustodialExactPayment`, assert decoded
     shape (scheme `exact`, CAIP-2 network, amount/asset/payTo, feePayer in `extra`)
     against the documented PayAI facilitator wire contract (docs.payai.network
     exact-SVM pages; snapshot contract JSON as fixtures, source URLs in comments).
   - Assert verify→settle sequencing invariants from the `x402-payai.ts` module doc
     (never-throw mapping, settle-gated-on-verify, empty-signature ⇒ unsettled) against
     a mock facilitator (extend `x402-mock-facilitator.ts` if needed).
2. **Version pin:** pin `@x402/*` to exact versions (drop `^`) — money-path deps upgrade
   deliberately, gated by the conformance tests. One-line `ARCHITECTURE.md` note.
3. **Policy-seam assertion test:** payment above the per-tx cap is refused BEFORE any
   signer is constructed (admission in `agent-pay.ts` precedes
   `prepareCustodialExactPayment`). Encodes "our seam is authoritative; the SDK has no
   policy engine" as a regression test.
4. **Adapter note (no code):** `ARCHITECTURE.md` records that PayAI's `x402-solana`
   exposes `registerExactSvmScheme`/`wrapFetchWithPayment` over the same primitives —
   future swap is a thin adapter; nobody re-researches this.

### Out of scope
Signer/custody changes · new dependencies · outbound behavior changes · Meridian · EVM.

### Mandates + acceptance
Worktree off `staging` (suggest `cv-x402conform`). No PROTOCOL_VERSION bump (wire
unchanged). PARITY note: no behavior change, human/agent identical by identity.
Accept: `bun test` green incl. new tests; `tsc` clean; staging deploy; existing live
paid-marketplace smoke still settles.

---

## SPEC 2 — Meridian as second x402 facilitator (MEDIUM — phased; Phase A ~1 day, B ~2-3 days, C gated)

### Why (founder direction 2026-07-22)
Reach: Meridian gives ClawVille inbound payments from agents on 16+ EVM chains plus a
second live Solana facilitator (redundancy + their fee-split model lets US take a
platform fee on inbound payments). It is facilitation only — custody architecture
unchanged. Outbound agent payments STAY on PayAI (free tier, sponsored gas).

### Phase A — ✅ RECON COMPLETE 2026-07-22 (capture doc: `docs/meridian-contract-capture-2026-07-22.md`); devnet smoke still pending
Results that bind Phase B/C:
- **2a:** shared x402 envelope but a MERIDIAN-SPECIFIC Solana transaction — their
  facilitator requires the signed tx to call THEIR program's `transfer_with_authorization`
  (custom discriminator, 9-account layout, 3-way transfer_checked fee split; structural
  proof: a plain SPL transfer can't carry their on-chain treasury fee). Also x402Version 1
  (we emit 2) + plain "solana"/"solana-devnet" network strings (we use CAIP-2). Phase B
  therefore includes a Meridian-specific tx builder assembled from `/v1/solana/facilitator`;
  the verifyAndSettle-shaped module contract still holds.
- **2b:** fully SELF-SERVE (SIWE wallet sign-in → /dev/api-keys; org creation needs an EVM
  SIWE even for Solana-only — one-time human step). OUR platform fee = per-payment
  `paymentRequirements.extra.platformFeeBps` (cap 1000 = 10%); Meridian treasury fee =
  100 bps (1%), live-verified both clusters. Fee guard: at $0.03 median, 1% = $0.0003 <
  PayAI $0.001 flat — SATISFIED, but it INVERTS above ~$0.10/tx ⇒ enforce routing by tx
  size, not as a one-time check.
- **2c:** **NO** EVM payer → Solana recipient routing (Across is EVM→EVM only; no
  CCTP/Circle Gateway path documented). Phase C = EVM inbound requires an EVM recipient
  we own (new Base custody surface) ⇒ decision-memo path only, do NOT build by default.

**PHASE B.1 CORRECTIONS (live devnet findings, 2026-07-22 — supersede parts of the
capture doc; discovered by driving the REAL facilitator with the shipped builder):**
1. `description` is REQUIRED in paymentRequirements (omission ⇒
   `invalid_payment_requirements`). Builder fixed to always emit.
2. Their validator parses **LEGACY transactions only** — a v0 VersionedTransaction is
   rejected as `invalid_exact_svm_payload_transaction`. Builder fixed to legacy +
   `partialSign(payer)` + `serialize({requireAllSignatures:false})`.
3. **ORG-PINNED RECIPIENT (architectural):** llms-full.txt: `payTo` "must match the
   Solana recipient on your Meridian organization" (dashboard-configured, no API).
   ⇒ Meridian Solana is a SELLER-SIDE rail: it settles ONLY to the org's one
   configured wallet. It CANNOT serve the OUTBOUND agent→agent fallback as shipped
   (arbitrary recipients get "recipient token account does not match expected
   recipient" — live-verified). RETARGET: Meridian fallback belongs on the INBOUND
   rails (ct_topup / checkout / partner storefront, where payTo is ALWAYS our merchant
   wallet = the org recipient), which is also where prod's live 100% PayAI settle
   failures hurt. The outbound seam should be disabled/removed in B.1.
4. All USDC ATAs (payer, recipient, platform, treasury) must PRE-EXIST — settlement
   never creates accounts (their docs, confirmed).
FOUNDER STEPS for the smoke + go-live: (a) mrdn.finance dashboard → configure the
org's Solana recipient wallet (devnet smoke: our devnet test pubkey; prod: the
ClawVille merchant wallet — likely wants a DEDICATED ClawVille org rather than the
swarms org); (b) then the devnet smoke completes with no further code.
**ACTIVATION RECORD (2026-07-23):** B.1 shipped (staging `42e5c037` → prod via PR #235);
founder configured mrdn.finance org (Solana recipient = merchant wallet
`79sH9jtT…ViLLE`, same address both envs) and delivered per-env keys (laptop file
`C:\Users\newma\.clawville-meridian-keys.env`; `sk_` secrets never staged into runtime
env). Ladder green: devnet settle `n4AoJr…P8r` + mainnet settle `5Z7SBwvU…iwnR` (~5¢,
exact 1% split), both via the shipped service. `MERIDIAN_*` env live + container-verified
on BOTH api apps. OPEN OPS: (a) rotate the STAGING `pk_` key (echoed once into a session
log); (b) the 6,315-row outage backlog CANNOT be cleared by the per-row `probe_merchant`
apply (merchant signature history exceeds per-row lookback ⇒ "probe indeterminate",
~1 row/5min) — Spec 4 below is the replacement; backlog parked safely in `reconcile`.

**SPEC 4 (IMPLEMENTED LOCALLY 2026-07-23 — pending Fable/operator review) — bulk
outage reconciler + recurring auto-sweep.** One
merchant-wallet `getSignaturesForAddress` sweep over the outage window (paginated,
anchored), parse txs in batch, match reconcile rows in memory by (payer, amount,
window), then: matched → existing `claimVerifiedCapture` path; unmatched past grace →
no-money terminal. Plus a bounded recurring auto-sweep (cron ~15min, per-run cap,
auto-applies ONLY on-chain-verified capture + grace-elapsed no-money, Telegram summary
via itachi-debug) so a backlog can never silently build again. Local evidence:
`bun test bulk-reconcile x402-auto-reconcile x402-reconcile agent-pay-resume` =
43 pass / 0 fail; workspace `bun run typecheck` = pass. The operator CLI remains
dry-run unless both `RECONCILE_APPLY=true` and `--apply` are present; the recurring
worker remains OFF unless `X402_AUTO_RECONCILE=true`. Fable review and the production
operator dry-run/apply remain outstanding.

AUDIT FIXES QUEUED for the same B.1 round (interaction audit 2026-07-22): (i)
free_tier_exhausted must trigger the Meridian fallback (it trips the breaker but not
the fallback predicate — the exact redundancy scenario, HIGH); (ii) the circuit
breaker gates the whole executor including the Meridian leg — gate only the PayAI
leg; (iii) tighten net>0 in assertSettlementAmountsConserved (DB CHECK is strict,
JS assert allows 0); (iv) reconcile capture path must repopulate fee columns or a
reconciled Meridian payment credits GROSS vCLAW for NET USDC received; (v) pin
legacy-tx + required-description in the conformance fixtures.

### Phase A — original tasks (for reference; capture doc supersedes)
Per the live-route READ-ONLY probe rule (project_finish_unfinished_money_paths):
1. Probe Meridian's public API (docs.mrdn.finance/api-reference): `Get Supported Payment
   Kinds`, `Get Gateway Status`, quote bounds, and the `Settle x402 Payment` request/
   response schema. Capture as fixtures in `docs/meridian-contract-capture-<date>.md`
   (or fixtures dir) with verbatim JSON.
2. Answer with evidence, in the same capture doc:
   a. Does their Solana facilitator accept a standard `@x402/svm` exact-scheme payload
      (same wire as PayAI) or a Meridian-specific variant? (Their AI-skills "Solana
      payments" page is the reference.)
   b. API key onboarding: self-serve or gated? Fee bps configuration — where is OUR
      platform-fee bps set, what does Meridian's treasury fee actually cost per tx?
   c. Cross-chain: can an EVM payer settle to a SOLANA recipient (Across/Circle Gateway
      routing), or does EVM inbound require an EVM recipient address we'd have to own?
      This single answer decides Phase C's shape.
3. Devnet smoke: one $-cents settle on `solana-devnet` against their facilitator from a
   staging test wallet. On-chain sig or it didn't happen.

### Phase B — Solana facilitator redundancy (ship after A passes)
1. `apps/api/src/services/x402-meridian.ts` — sibling of `x402-payai.ts`, SAME exported
   contract (`verifyAndSettle`-shaped, never-throw mapping, settle-gated-on-verify,
   non-empty-signature rule). Env: `MERIDIAN_FACILITATOR_URL`, `MERIDIAN_API_KEY`,
   `MERIDIAN_PLATFORM_FEE_BPS` (default 0 initially), all optional — unset ⇒ Meridian
   disabled, zero behavior change.
2. Facilitator selection seam in the settle path (config-ordered: PayAI primary,
   Meridian fallback on facilitator-outage class errors ONLY — never on payment-invalid
   class; a payment rejected by verify is rejected, full stop).
3. Fee accounting: Meridian's atomic split means recipient-net ≠ gross. The settlement
   receipt path (`x402-settlement-receipts.ts`) must record gross, platform fee,
   treasury fee, net — and the vCLAW credit math must use NET. Adversarial reviewer:
   check conservation here hardest.
4. Tests mirroring spec 1's conformance suite against the captured Meridian fixtures +
   mock. Staging devnet smoke via the real facilitator before PR.

### Phase C — EVM inbound reach (GATED on Phase A finding 2c; separate founder go)
- If EVM-payer → Solana-recipient routing EXISTS: extend the marketplace paywall 402
  `accepts[]` to advertise Meridian EVM networks; settlement still lands in our existing
  Solana custody; moderate work.
- If NOT (EVM recipient required): this becomes an EVM treasury question (new custody
  surface on Base — conflicts with "no third-party balance custody" unless auto-swept;
  Meridian's EVM receiver-proxy holds balances until withdrawal). Write the one-page
  decision memo, take it to the founder, do NOT build by default. (Memory: EVM/Base NOT
  implemented today — this is a deliberate new surface, not a patch.)

### Mandates + acceptance (both phases)
- Worktree off `staging` (suggest `cv-meridian`). Codex implements, Fable reviews,
  adversarial pass on the fee-split/conservation math (money path).
- If agents can SEE new payment options (402 `accepts[]` change): protocol manual +
  `PROTOCOL_VERSION` bump + three-surface sync, same diff. Phase B alone (facilitator
  fallback, same wire) needs NO bump.
- Same-diff `ARCHITECTURE.md`: new service, env vars, facilitator-selection seam.
- PARITY note: inbound payments settle to the same avatar-bound recipient regardless of
  payer being human-driven or agent; guests stay demo (no real settlement).
- NEVER route outbound agent micropayments through Meridian while their treasury-fee bps
  exceeds PayAI's $0.001 flat equivalent at our median tx (~$0.03) — check in Phase A 2b.
- Accept: Phase A capture doc + devnet sig; Phase B `bun test` green, staging smoke
  settles via Meridian with correct net accounting, PayAI path regression-clean.
