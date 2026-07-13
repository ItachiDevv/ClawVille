# FROZEN SPEC — Thread 3: bounty micro-denomination + kill "CT" from the bounty surface (2026-07-12)

> Author: Fable (orchestrator). Implementer: GPT-5.6-sol via codex-first.
> Review + adversarial money audit + staging verify + deploy: Fable. Do NOT deploy from the implementer.
> Repo: `cv-sap-sdk`. Money path — every rule in CLAUDE.md (ledger-only, integer base units, staging-first) binds.

## Why (grounded in the 2026-07-12 prod audit)
- The whole economy already runs on the **A3 ¢-peg: 1 vCLAW = $0.01 = 1 US cent** (migration `0011`, applied prod 2026-07-07; canonical rate `CT_PER_USDC = 100` in `x402-payai.ts`).
- The bounty reward field `bounties.token_reward` is the **only** surface still stuck at pre-A3 whole-dollars on the USDC funding path: it converts `× 10^6` (whole USDC). So the SAME number means $0.10 on the in-game path but $10.00 on the on-chain USDC path — a 100× inconsistency. Fixing it enables $0.05 bounties AND removes the inconsistency.
- Prod has **0 USDC-funded bounties** and 2 in-game bounties already at the ¢-peg (`token_reward=500` = $5). So this change touches **no existing prod money rows**.

## Terminology (MANDATORY — the founder has removed "CT")
- The token is **vCLAW**. Never emit "CT" or "ClawToken" in any bounty-facing string, response field, error message, or NEW comment.
- The two funding paths are **`vclaw`** (in-game, paid from the poster's vCLAW balance, settled on the vCLAW ledger) and **`usdc`** (on-chain, SAP escrow, real money).
- OUT OF SCOPE for this slice (do NOT touch): the repo-wide ledger primitive names `avatars.clawTokens`, `creditClawTokens/debitClawTokens/transferClawTokens`, `claw-token-ledger.ts`, `claw_token_transactions`. Those belong to the separate in-progress CT→vCLAW rename workstream; renaming them piecemeal here would create a half-renamed inconsistency. Leave them exactly as-is.

## Change set (exhaustive — implement ALL, same diff)

### 1. `apps/api/src/services/bounty-escrow-link.ts`
- `usdcRewardBaseUnits(units)`: change the conversion from `BigInt(units) * 10n ** 6n` to **`BigInt(units) * 10_000n`** (1 vCLAW = $0.01 = 10^4 USDC base units). Keep the positive-integer guard. Prefer importing/reusing the existing canonical `ctToUsdcAtomic`/cents→base-units helper in `x402-payai.ts` rather than a fresh literal, IF it produces the identical integer for a vCLAW count (i.e. `vclaw → base units = vclaw * 10^4`); otherwise keep the explicit `* 10_000n`. Do NOT introduce floats.
- Rewrite the doc comment block (currently "whole-USDC reward → base-unit"): the reward is **vCLAW** (1 vCLAW = $0.01); on-chain escrow moves `tokenReward × 10^4` base units. No "CT".

### 2. `apps/api/src/routes/bounties.ts`
- Zod `tokenReward`: keep `z.number().int().min(1)` at the field, floors enforced in `superRefine`.
- `superRefine` floors — set BOTH paths to **5 vCLAW ($0.05)**:
  - in-game (`paymentRail === 'vclaw'`): `< 5` → issue.
  - on-chain (`paymentRail === 'usdc'`): `< resolveUsdcBountyRewardMin(env)` where the **default becomes 5** (see item 4).
- `USDC_BOUNTY_REWARD_MAX = 1_000_000`: keep the number; it now means **1,000,000 vCLAW = $10,000 cap**. Re-comment (u64 headroom: 1e6 × 1e4 = 1e10 ≪ 2^63). Update the ">... USDC" error message to vCLAW/$.
- **`payment_rail` enum value rename `'ct'` → `'vclaw'`** (kills the dead name):
  - Zod enum `['ct','usdc']` → `['vclaw','usdc']`, `.default('ct')` → `.default('vclaw')`.
  - Every `paymentRail === 'ct'` / `=== 'ct'` branch → `=== 'vclaw'`. `isUsdc` (`=== 'usdc'`) is unaffected — verify each `isUsdc ? … : …` still means "usdc vs in-game".
  - Update the two "CT or WHOLE USDC" disambiguation comments (L1830, L2478) to "vclaw (in-game, 1 vCLAW=$0.01) or usdc (on-chain)".
- Response fields on `/attempts/:id/review` (2 sites) and `/settle` (1 site) — replace the mislabeled `usdcReward: bounty.tokenReward` with an honest pair:
  - `rewardVclaw: bounty.tokenReward` (canonical amount, vCLAW),
  - `rewardUsdcBaseUnits: usdcRewardBaseUnits(bounty.tokenReward).toString()` (exact on-chain amount; only meaningful when usdc-funded — emit `"0"` / omit for in-game),
  - drop the `usdcReward` name. (No external consumer: not in `skill-protocol.ts`, not in `packages/shared` openclaw types, not read by web — grep-confirmed 2026-07-12.)
- The in-game creator-balance check (`avatar.clawTokens < data.tokenReward`) stays INSIDE the in-game branch only (it already is via `isUsdc ? … : avatar.clawTokens - data.tokenReward`). Do NOT gate the usdc path on vCLAW balance.

### 3. Tests (update the hardcoded expectations to ×10^4; keep structure)
- `apps/api/src/services/sap/__tests__/bounty-escrow-link.test.ts`: `usdcRewardBaseUnits(1)=10_000n`, `(10)=100_000n`, `(250)=2_500_000n`, `(1_000_000)=10_000_000_000n`; reject cases (0, -5, 1.5) unchanged. Add explicit cases: `(5)=50_000n` (the $0.05 floor).
- `apps/api/src/services/sap/__tests__/bounty-composition.test.ts`: fix the hardcoded `expect(usdcRewardBaseUnits(REWARD)).toBe(100_000_000n)` (L107) and the "100_000_000 for a $100 bounty" comment (L203) to the ×10^4 values for whatever `REWARD` is; the symbolic `usdcRewardBaseUnits(REWARD)` assertions auto-track.
- Add/extend a create-route test proving a `usdc` bounty at `tokenReward=5` PASSES the floor and a `tokenReward=4` FAILS, and an in-game `tokenReward=4` FAILS / `5` PASSES.

### 4. Env / floor helper
- `resolveUsdcBountyRewardMin` default: **10 → 5**. Staging's `USDC_BOUNTY_REWARD_MIN=1` override still works (allows 1-cent on the smoke box). Update the comment (no "$1 whole" language).

### 5. Prod/staging data migration (guarded, idempotent) — Fable applies, NOT the implementer
- New migration file `packages/database/migrations/00XX_bounty_rail_ct_to_vclaw.sql`:
  `UPDATE bounties SET payment_rail = 'vclaw' WHERE payment_rail = 'ct';` (idempotent; wrap in the same marker-table pattern as 0011 if the enum is a check-constraint rather than a text col — verify the column type first and adjust the constraint if needed).
- Applied EXPLICITLY to prod `:5432` and staging by Fable — never `db:push`.

### 6. Docs (same diff)
- `docs/sap-integration.md` (~L733) — the `usdcRewardBaseUnits` reference → ×10^4 / vCLAW.
- Confirm Nori town-guide `knowledge[]` (`packages/agent-templates/src/locations/town-guide.ts`) and the SKILL.md/protocol emitters (`skill-protocol.ts`) state NO bounty USD minimum today; if any bounty min/reward wording exists, update to "5 vCLAW ($0.05) minimum" — three-surface sync. (Grep found none in `skill-protocol.ts`; verify Nori.) If a user-facing number changes, `PROTOCOL_VERSION` bump per the whitelist-parity rule; if not, no bump.
- `CLAUDE.md` / `ARCHITECTURE.md`: note the bounty reward field is vCLAW (1 vCLAW=$0.01), on-chain escrow = `× 10^4`, floors 5 vCLAW.

## Acceptance (Fable verifies before "done" — none of these are the implementer's to declare)
1. `bun test` green (both bounty test files + create-route floor tests).
2. `tsc` clean.
3. Grep proves zero "CT"/"ClawToken" left in bounty-facing strings, response fields, `payment_rail` values, and NEW comments (ledger-primitive names exempted per scope).
4. Staging smoke: create a `usdc` bounty at `tokenReward=5`, confirm the SAP vault opens with `50000` base units ($0.05), the house pricing tier price == `50000` (no 6148), settle to a hunter, conservation exact. Then a real prod $0.05 smoke (funded from rescue USDC) — Fable, after sign-off.
5. Migration applied to staging + prod `:5432`; `SELECT DISTINCT payment_rail FROM bounties` shows no `'ct'`.

## Invariants (never regress)
- Integer base units only; no float money. u64-safe.
- In-game settlement stays ledger-only via the existing vCLAW ledger (unchanged).
- On-chain escrow amount == house pricing-tier `price_per_call` (both derive from `usdcRewardBaseUnits`) — the 6148 guard.
- Custody-at-post, conservation exact, gasless payout for the payee.
