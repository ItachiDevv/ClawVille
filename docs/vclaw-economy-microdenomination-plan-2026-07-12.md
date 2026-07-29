# vCLAW economy + bounty micro-denomination — decision doc (2026-07-12)

> Written at the founder's request so we can compact and then go through it **one thread at a time**.
> Each thread: the problem, my analysis/recommendation, and the **OPEN DECISION** that needs the founder.
> Nothing here is built yet. Recommendations are marked `REC →`. Founder decisions are marked `⬥ DECIDE`.

---

## Context: where we are right now (so nothing is lost on compaction)

- **Prod is LIVE on the mainnet SAP rail** (`api.clawville.world/api/sap/status` = enabled / mainnet / dry-run false). The composed bounty rail (SAP escrow custody-at-post → x402/PayAI payout) is mainnet-proven end-to-end (staging smoke: real 1-USDC bounty paid, conservation exact, ~3¢ true burn).
- **Prod house wallet `ESpnsVdj2HkxPQgS3UVUvs2d5egUCDBwvMbpwPEhsm3m` is funded (0.16 mainnet SOL) and READY to provision** (register + 0.1 stake). Keypair backed up (Desktop + brain `.enc`). NOT yet provisioned — paused for this economy discussion.
- **The first prod bounty should be the REAL target ($0.05), not a $1 placeholder** — which is why we're settling denomination BEFORE the prod bounty smoke.

---

## THE CORE INSIGHT (the knot the founder identified)

vCLAW must be **one consistent value across the whole economy** AND we want to **credit it freely** for game rewards. Those look contradictory (pegged + freely-emitted = real-money liability faucet). They resolve cleanly by separating three things people usually conflate:

1. **Denomination** (unit of account) — what one vCLAW is *worth*, for pricing/display. ONE fixed rate everywhere.
2. **Emission** (how vCLAW enters circulation) — game rewards, purchases. Can be free.
3. **Backing / Redemption** (can vCLAW leave as real USDC) — the off-ramp. This is where faucet-safety lives.

**A currency can have a fixed nominal value, be freely granted, and still be safe — as long as REDEMPTION is controlled, not emission.** (This is how Robux, airline miles, casino chips, and our own existing earn→cashout model already work.) So "credit more vCLAW where needed" is fine; the discipline is at cash-out, not at the mint.

`1 vCLAW = $1` breaks on BOTH axes: (a) too coarse — a $0.05 bounty = 0.05 vCLAW (fractional, ugly, and the current code is integer-only), and (b) every emitted vCLAW is a $1 liability, so any game faucet is enormous. `1 vCLAW = $0.01` fixes both.

---

## THREAD 1 — the vCLAW ↔ USDC rate  ✅ (a) confirmed by founder

**Problem:** what is one vCLAW worth, in a single rate used everywhere?

**REC → `1 vCLAW = $0.01` (i.e. `100 vCLAW = 1 USDC`).** Founder confirmed the direction ("A"). This makes:
- $0.05 minimum bounty = **5 vCLAW** (clean whole integer).
- Game rewards granular + sane: win a game = 10–50 vCLAW = $0.10–$0.50 nominal.
- Integer base-unit math, no floating-point money: `1 vCLAW = 10,000 USDC base units` (since $0.01 = 1e4 of USDC's 1e6). So `usdcBaseUnits = vclawAmount × 10_000n`.

**⬥ DECIDE 1a:** confirm `1 vCLAW = $0.01` as the SINGLE, economy-wide rate (not just for bounties).
**⬥ DECIDE 1b:** is the rate **pegged/fixed** (stable, our chosen resolution) or ever **floating**? If it ever floats, the float lives at the settlement-conversion layer only; the ledger stays integer vCLAW. REC → fixed peg for now.
**⚠️ BEFORE we lock the rate:** audit current vCLAW usage — existing `avatars.clawTokens` balances, shop prices, quest/login/game reward amounts. Whatever value those *implicitly assumed* per vCLAW determines whether `$0.01` silently reprices the live economy (e.g. if a shop hat costs 500 vCLAW and that was meant to feel like "$5", then $0.01 makes it $5 — consistent; but if it was meant to feel like "$50", we have drift). **This audit gates Thread 2.**

---

## THREAD 2 — is vCLAW soft (in-game only) or hard (redeemable)?  ⬥ THE BIG ONE

This is the consistency question. Two coherent models:

**Model A — vCLAW is SOFT (in-game unit); USDC is the real-money rail.**
- vCLAW: earned by play (freely creditable, zero liability), spent in-game (shop, entry fees, tips). Its `$0.01` value is a **pricing/display convention**, not a redemption promise.
- Real-money bounties/services are **USDC-denominated directly** (sub-dollar cents) on the x402/SAP rail we already shipped.
- On-ramp (buy vCLAW with USDC/fiat/SOL) exists; **off-ramp is limited or absent** (or only for a segregated "purchased/earned-real" bucket).
- **Pros:** simplest, safest, no faucet-liability, matches "credit freely." **Cons:** vCLAW and USDC are two separate worlds; a "vCLAW bounty" is a different thing from a "USDC bounty."

**Model B — vCLAW is HARD (USDC-backed, redeemable at 100:1).**
- Every bounty/service is priced in vCLAW; settlement converts vCLAW→USDC at the fixed rate on the real rail.
- **Emission must be controlled** or segregated: game-reward vCLAW goes to a **non-redeemable "bonus" bucket**; only purchased or real-contribution vCLAW is cash-outable. Otherwise the game is a real-USDC faucet (violates the standing "never let a game be a CT faucet" rule).
- **Pros:** one currency for everything, cleanest UX (users think in vCLAW). **Cons:** real liability management; needs a segregated-bucket ledger + off-ramp controls + rake/limits.

**REC →** Start with **Model A discipline** (vCLAW soft/display + USDC-direct real bounties) because it's shippable now and faucet-safe, but design the vCLAW unit so it can graduate to Model B later (integer cents, one rate) without a re-migration. i.e. **denominate bounties in the same integer cent-unit whether they're "vCLAW" or "USDC" — 5 = $0.05 either way** — and defer the redeemability decision.

**⬥ DECIDE 2:** Model A (soft vCLAW + USDC-direct bounties) vs Model B (hard redeemable vCLAW). This decides whether real bounties are USDC-denominated or vCLAW-denominated-settled-USDC. Everything downstream depends on it.

---

## THREAD 3 — bounty denomination + the code change

**Problem (confirmed in code):** `tokenReward` is a whole-dollar integer (`z.number().int()` + `usdcRewardBaseUnits` throws on non-integers, multiplies by 1e6). **$0.05 is impossible today.** The staging `USDC_BOUNTY_REWARD_MIN=1` override only lowered the floor to $1 whole — it does NOT enable sub-dollar.

**REC → the slice:**
- Change the reward unit from "whole USDC" to an **integer cent-unit = vCLAW** (1 unit = $0.01). Field `tokenReward` becomes "reward in vCLAW/cents", floor **5** (= $0.05), ceiling re-derived.
- `usdcRewardBaseUnits(units) = BigInt(units) × 10_000n` (was `× 1_000_000n`). Still integer, still u64-safe.
- Per-rail floors: USDC rail min 5 vCLAW ($0.05); the CT/vCLAW soft rail keeps its own min (TBD by Thread 2).
- Migration: existing bounties store whole USDC; back-convert or grandfather. (Prod has ~0 real bounties, so low-risk.)
- Same-diff: `deposit headroom` / `bountyVaultDeposit` / coverage math re-checked at the new unit; Nori knowledge + SKILL.md if any user-facing number changes.

**⬥ DECIDE 3:** confirm the reward field becomes integer vCLAW (1 = $0.01, floor 5). Depends on Thread 2's A/B.

---

## THREAD 4 — services listings (agents advertising to sell work)

**Problem/feature:** an agent posts "I'll do this research for $0.05" (5 vCLAW). Buyers accept → escrow → deliver → settle. It's the **mirror of a bounty** (seller posts capability+price; buyer accepts) and rides the **exact same SAP-escrow→x402 rail** — money plumbing already works.

**New surface needed:** a `service_listings` table (agent, capability/desc, price, active), browse/discovery, and an "accept listing → create escrow" flow (buyer = depositor, agent = worker — note this flips the house-as-worker pattern; here the *listing agent* is the real worker, so per-agent worker onboarding/stake may apply → ties to Thread 2 + the SAP stake model).

**⚠️ FLAG:** this revives **peer commerce**, which is currently **PAUSED** (`marketplace-trade`: bazaar/auctions/published-skills are 503-gated for the free-leaderboard pivot). Your x402 services rail is a *new, deliberate* real-money direction, not the old CT bazaar — so this is a conscious policy call to un-pause a scoped services lane, not an accident. Must reconcile before building.

**⬥ DECIDE 4:** greenlight scoping the services-listings feature? (And confirm it's OK to open a scoped real-money services lane while the old CT peer-marketplace stays paused.)

---

## THREAD 5 — operating mode: Fable orchestrates, GPT-5.6-sol executes

Token budget is tight; GPT limits are high. Decided in principle, writing it down:

- **codex-first skill = the discipline** (Claude specs+reviews+verifies, Codex implements from frozen specs; token-cost is its explicit rationale). Pattern: `mktemp` spec file → `codex exec --yolo -m gpt-5.6-sol -c model_reasoning_effort=high`.
- **Codex plugin = the runtime** underneath (background runs, `codex exec resume`, the proven detached runner). We drove the whole SAP build through it this session.
- **Not either/or — use the skill's pattern on the plugin's runtime.**

**REC → operating split (esp. for money paths):** GPT-5.6-sol (high) implements from *my frozen spec* → **I (Fable) do the adversarial money review + live verification** → I own all deploy / secrets / git / on-chain signing. This is both the skill's own rule ("all review + verification stays in Claude") and our money-path rule, and it's what cuts the token burn (the expensive Claude fleet stops doing mechanical implementation).

**⬥ DECIDE 5:** confirm this split. (No real disagreement expected — recording it as the standing mode.)

---

## THREAD 6 — prod house provisioning + first prod bounty (sequencing)

- **Provision the prod house NOW** — independent of all the above, already funded, proves prod-mainnet register/stake works. `docker exec -w /app/apps/api <ebnatux-container> -e HOUSE_STAKE_LAMPORTS=100000000 bun scripts/sap/provision-house-sap.ts` on the prod box (`5.78.129.176`, key `~/.ssh/clawville_ci_prod`).
- **Defer the first prod BOUNTY** until the micro-denomination (Thread 3) ships, so the first real prod bounty is a genuine **$0.05 (5 vCLAW)**, not a placeholder.
- **⚠️ prod-USDC for the smoke:** founder mainnet USDC is ~2 total. A $0.05 bounty needs only 0.05 USDC in a creator wallet — trivially fundable from rescue's 0.98 USDC. So once micro-denomination ships, the prod smoke costs pennies.

**⬥ DECIDE 6:** provision the prod house now (yes/hold)?

---

## Suggested order to go through after compaction

1. **Thread 1 audit** — pull current vCLAW balances / shop prices / reward amounts, confirm `$0.01` doesn't silently reprice the live economy. *(This gates everything.)*
2. **Thread 2** — soft vs hard vCLAW (Model A/B). The pivotal decision.
3. **Thread 3** — lock the reward-field change; spec it; hand to GPT via codex-first.
4. **Thread 6** — provision prod house (can happen in parallel, anytime).
5. **Thread 4** — spec services-listings.
6. Ship micro-denomination → staging → prove $0.05 bounty → promote → first real prod $0.05 bounty.

---

## Standing money-safety invariants (do not regress while doing any of the above)

- Never let a game/reward path be a real-USDC faucet — emission free only where redemption is gated (Thread 2).
- Integer base units for all money — no floating-point.
- vCLAW ledger writes only via `claw-token-ledger` (credit/debit/transfer); never write `avatars.clawTokens` directly.
- Bounty escrow: custody-at-post, conservation exact, x402 payout gasless for the payee.
- One vCLAW rate everywhere (Thread 1) — no per-context valuations.
