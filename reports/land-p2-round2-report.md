# Land P2 round 2 implementation report

Date: 2026-08-08  
Branch: `feat/land-p2-tenure`  
Worktree: `C:\Users\itachi\Documents\Crypto\cv-land-p1`  
Commit created: no

## Per-part status

### 1. Agent action verbs and protected partner surface — complete

- Added `claim_parcel`, `prepay_rent`, and `release_parcel` to the canonical
  shared executor whitelist and autonomy menu.
- Added strict, server-owned parameter validation in `executeHatcherAction`.
- Reused the existing autonomous-Cove live-session resolver, including its
  server-owned house-agent binding behavior. Every admitted Land action requires
  a ledger-capable live session, non-null user/avatar binding, and an unchanged
  captured agent/avatar binding.
- Passed `expectedAgentId`, `expectedAvatarId`, and `expectedUserId` into the
  round-1 shared settlement service. The executor contains no debit, credit, CLV
  read, tenancy write, or refund implementation.
- Added a synchronous 60-second `(avatar, verb, parcelCode)` reservation before
  the settlement await. The durable backstop is a SHA-256 idempotency key over
  the avatar plus the complete semantic operation and a 60-second bucket.
- Wired `autonomous: true` into shared settlement, activating round 1's atomic
  autonomous daily-spend admission. Hold claims request zero spend; rent claims
  count all selected weeks and prepay counts every selected week.
- Added fresh-only cache, event, and world-broadcast effects after shared
  settlement. Replays do not repeat effects.
- Added a bounded, closed-field, render-backed Land target reader. The deciding
  model sees up to five nearest claimable parcels and up to five owned parcels,
  including copyable parcel codes, tier, tenure, rent/prepaid state, hold
  threshold, grace state, and claim distance.
- Expanded agent status from a bare Land count to `{ count, parcels[] }`, with
  the same bounded closed-field tenure projection.
- Updated the mock-Hatcher parity gate to read the canonical 11-verb tuple and
  prove every executor verb is documented in the served manual.

### Exact verb contracts implemented

1. `claim_parcel(parcelCode=<rendered code>, door=<hold|rent>, weeks=<1..26; rent only>)`
   - Only exact `parcelCode`, `door`, and optional `weeks` keys are accepted.
   - `parcelCode` must be a member of the shared rendered `LAND_PARCELS` set.
   - `door=hold` forbids `weeks` and spends no vCLAW.
   - `door=rent` requires an integer `weeks` in `1..26`.
   - Settlement calls `settleTenureClaim`; the server chooses the tier ladder,
     verifies the declared CLV wallet for hold, or charges week one and escrows
     later weeks for rent.

2. `prepay_rent(parcelCode=<owned rendered code>, weeks=<1..26>)`
   - Only exact `parcelCode` and `weeks` keys are accepted.
   - `weeks` must be an integer in `1..26`.
   - Settlement calls `settleRentPrepay`; inside the locked shared service the
     amount is derived as the tenancy's server-stamped weekly price times weeks.

3. `release_parcel(parcelCode=<owned rendered code>)`
   - Only exact `parcelCode` is accepted.
   - Settlement calls `settleTenureRelease` with the same acquisition-bound
     release fingerprint used by REST. Rent returns remaining escrow only; hold
     has no deposit refund.

For all three: invalid/unbound/non-ledger/drifted identities are dropped without
guest fallback; a duplicate semantic action inside the 60-second reservation is
not dispatched; a cross-process/restart replay inside the current durable bucket
returns the stored settlement result.

### 2. Protocol v46 — complete

- Bumped `PROTOCOL_VERSION` from 45 to 46 with the standard dated bump note.
- Documented all three exact action calls and the 60-second replay tradeoff.
- Documented Hold thresholds: Starter 100,000 CLV, C 250,000 CLV, Founder
  10,000,000 CLV; requirements stack and Founder remains auction-allocated.
- Documented Rent prices: Starter 1,000 vCLAW/week and C 2,500 vCLAW/week,
  1..26 weeks, irrevocable first week, refundable later whole-week escrow, and
  three-day grace.
- Documented `POST /api/land/hold-wallet`, parity-open first declaration,
  human-only changes, `wallet_change_requires_human`, and
  `wallet_locked_by_hold`.
- Documented release idempotency, acquisition fingerprinting, stale-key conflict,
  and refund consequences.
- Kept the existing decoration-kit subsection intact.
- Updated protocol pin tests and Hatcher manual/executor parity coverage.

### 3. Land Office two-door UI — complete

- Available rendered parcel cards now show:
  - Hold door: stacked tier minimum, declared wallet, fresh live balance state,
    and a plain-language disabled reason when undeclared, unavailable, or short.
  - Rent door for Starter/C: weekly vCLAW price, 1..26 week selector, total, and
    explicit first-week non-refundable copy.
  - Founder: Hold only plus auction-allocation notice.
- Added declare/change hold-wallet UI. The first declaration can originate from
  any real ledger-capable session; typed 409s are rendered as plain language.
- Owned cards show Hold wallet and last check, or Rent paid-through/grace state.
  Rent cards include a 1..26 week prepay selector and computed total.
- Release uses a DOM `alertdialog`, never `window.confirm`, and states escrow,
  first-week, hold, and structure-archive consequences.
- Claim, prepay, and release requests carry retry-stable idempotency keys. A
  failed/ambiguous attempt retains its semantic key; success clears it.
- Removed the unreachable legacy Starter-claim, buy, and rent UI/client methods
  and types. The parcel pill, sidebar, empty state, and Land Office CTAs now all
  route to the two-door chooser.
- Uses light-on-dark tokens, `useIsMobile()` layout gating, and 44px minimum
  targets for the new/select/tab/owned-card controls.
- React quality pass found no hook-order, nested-component, global-listener, or
  new request-waterfall issue. Independent post-settlement refreshes are grouped.

### 4. Knowledge and architecture surfaces — complete

- Rewrote Nori's Land tenure paragraph to the two-door model and agent parity;
  the decorate-yard entry is unchanged.
- Added two-door tenure, wallet guards, and the v46 verbs pointer to hosted
  orientation knowledge.
- Added current Land P2 round-2 entries to `GameFeatures.md` and
  `ARCHITECTURE.md`, including settlement/adaptor boundaries and parity.

## Files touched by round 2

Agent/protocol/API:

- `packages/shared/src/constants/hatcher-actions.ts`
- `apps/api/src/services/npc-simulation.ts`
- `apps/api/src/services/agent-autonomy-driver.ts`
- `apps/api/src/services/autonomous-land-targets.ts` (new)
- `apps/api/src/services/agent-owner-binding.ts`
- `apps/api/src/routes/agent-gateway.ts`
- `apps/api/src/routes/land.ts`
- `apps/api/src/services/land-tenure-settlement.ts` (protected seam; see deviations)
- `apps/api/src/services/skill-protocol.ts`
- `apps/api/scripts/hatcher/selftest-e2e.ts`

Tests:

- `apps/api/src/routes/__tests__/agent-paid-surface.test.ts`
- `apps/api/src/routes/__tests__/land-tenure-p2-structural.test.ts`
- `apps/api/src/services/__tests__/agent-action-covenant.test.ts`
- `apps/api/src/services/__tests__/agent-autonomy-round1.test.ts`
- `apps/api/src/services/__tests__/agent-control-handback.test.ts`
- `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts`

Web:

- `apps/web/src/components/game/land/tenure-office-panels.tsx` (new)
- `apps/web/src/components/game/land/land-office-modal.tsx`
- `apps/web/src/components/game/land-options-pill.tsx`
- `apps/web/src/components/game/sidebar-menu.tsx`
- `apps/web/src/components/game/land/types.ts`
- `apps/web/src/lib/api.ts`

Knowledge/docs/report:

- `packages/agent-templates/src/locations/town-guide.ts`
- `packages/shared/src/constants/orientation-skill.ts`
- `GameFeatures.md`
- `ARCHITECTURE.md`
- `reports/land-p2-round2-report.md` (new)

The cumulative working tree also contains the user's pre-existing uncommitted
round-1 files and edits; this list identifies the round-2 surface, not ownership
of the entire cumulative diff.

## Gate results

| Gate | Result |
|---|---|
| `bunx tsc --noEmit -p apps/api` | PASS |
| `bun run --filter @clawville/web typecheck` | PASS |
| `bun run build` | PASS — 9/9 packages |
| Protocol pins/manual tests | PASS — included in 38/38 targeted tests |
| Executor covenant + three Land verbs | PASS — claim/prepay/release, duplicate reservation, malformed and non-ledger drops |
| Autonomy prompt target test | PASS — closed owned/claimable blocks and all three verbs |
| Migrated staging P2 DB contract | PASS — 4/4 |
| Broad land/tenure/guard run | PASS — 224 passed, 0 failed, 38 suite-owned opt-in skips |
| Mock-Hatcher isolated self-test | PASS — 86/86; G4 proves all 11 verbs and v46 manual parity |
| `git diff --check` | PASS (line-ending conversion warnings only) |

The staging P2 DB test specifically proved irrevocable week-one charging,
claim/release replay, stale release rejection after reacquisition, agent first
wallet declaration plus both repoint guards, autonomous daily admission, the
five-parcel cap, and both new database constraints.

## Deviations and operational notes

1. **Protected-file seam change, intentional and necessary:**
   `land-tenure-settlement.ts` was extended so `settleRentPrepay` accepts either
   the existing REST `{ amountCt }` input or the agent verb's `{ weeks }` input.
   For `{ weeks }`, it derives `amountCt` from the locked tenancy's server-stamped
   weekly price inside the shared service. This was the smallest safe seam that
   preserves the frozen `prepay_rent(parcelCode, weeks)` contract while keeping
   all money math out of the executor. No round-2 changes were made to
   `land-rent-sweeper.ts` or either migration.

2. The first mock-Hatcher invocation inherited the reachable `.env.local`
   staging `DATABASE_URL`, violating that harness's internal assumption that its
   dummy URL wins; only H9/H10 failed under that invalid setup. It may have left
   timestamped self-test rows (`p4-persist-fail-1786191224284` and
   `p4-legacy-fail-1786191224758`) in staging. No destructive cleanup was
   attempted without explicit authorization. The gate was rerun with an explicit
   unreachable local DB URL and passed 86/86.

3. The broad legacy Land suite owns several opt-in DB groups separate from the
   executed P2 staging contract; 38 were reported as skipped by those files.
   The dedicated migrated-staging P2 suite ran all four cases and passed.

4. `git pull --ff-only` was attempted before work as required by repository
   policy, but this local branch has no upstream configured. No fetch/merge or
   worktree mutation occurred.
