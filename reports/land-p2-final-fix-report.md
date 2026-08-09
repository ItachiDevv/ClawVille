# Land P2 final fix report

Date: 2026-08-08  
Branch: `feat/land-p2-tenure`  
Worktree: `C:\Users\itachi\Documents\Crypto\cv-land-p1`  
Commit created: no

No literal `-o` pathname was included in the frozen brief, so this per-item
report is written to the repository `reports/` directory.

## Per-item result

### B1 — live status compatibility: complete

- Restored `ownership.landParcels` on
  `GET /api/agent/:sessionId/status` to its original numeric count.
- Added `ownership.landParcelDetail` as an additive sibling containing
  `{ count, parcels }`; the bounded parcel projection itself is unchanged.
- Updated the TypeScript response contract, status construction, served protocol
  manual, Hatcher integration spec, and status-shape tests.
- The detail query is now deterministic: `ORDER BY parcel_code` precedes
  `.limit(5)`. The numeric field remains the full count.

### M1 — Hatcher integration spec: complete

- Updated `docs/hatcher-integration-spec.md` to protocol v46.
- Documented `claim_parcel`, `prepay_rent`, and `release_parcel` with their exact
  parameters, bounds, settlement behavior, and replay semantics.
- Documented the backward-compatible numeric `ownership.landParcels` plus the
  additive `ownership.landParcelDetail` response field.

### M2 — hold-wallet read cost/freshness: complete

- `GET /api/land/hold-wallet` now uses the default five-minute cached
  `getWalletClvBalance(wallet)` read.
- Added a dedicated 60/minute limiter keyed by the resolved `identity.userId`.
- Forced-fresh `{ maxAgeMs: 0, maxStaleAgeMs: 0 }` remains on hold claim and the
  elapsed-grace eviction decision only.

### M3 — Founder auction claim: complete

- Removed the unsupported auction-allocation statement from the served manual
  and `CLAWVILLE_ORIENTATION_KNOWLEDGE`.
- Founder remains accurately documented as hold-only at 10,000,000 CLV.
- Added a source-only manual comment marking a real auction settlement gate as
  future work; the unsupported claim is not served to agents.

### Minor — REST/web prepay amount: complete

- The Land Office now sends `{ weeks, idempotencyKey }`, not a client-computed
  `amountCt`.
- The API passes weeks into `settleRentPrepay`, which derives `amountCt` from the
  locked parcel row's `rent_ct_weekly`.
- The previous bounded `{ amountCt, idempotencyKey }` request remains accepted
  as an additive compatibility branch for existing callers; mixed forms fail
  strict validation.

### Minor — deterministic status parcel list: complete

- Added `ORDER BY parcel_code` before the five-row status detail limit.

### Minor — autonomy Land target index: no migration justified

- No index and no `0053` migration were added. Rendered supply is frozen at 56
  rows, the owned branch already has `land_parcels_owner_idx`, and the available
  branch commonly selects most of the tiny table, where a sequential scan is the
  appropriate plan.
- Added a source comment requiring the OR query to be split and a new forward
  migration if supply grows materially.
- Because no schema change was needed, there was no staging DDL to apply.
  Migrations `0051` and `0052` were not edited.

### Minor — house-fleet scope: recorded

- Deliberate current scope: the server-owned house/hosted fleet remains excluded
  from Land tenure actions because its local sessions are non-ledger-capable.
  Human-owned and connected/hosted ledger-capable agents retain full Land parity.
  Extending house-agent Land ownership needs a separate server-owned binding and
  policy pass; this fix round does not silently widen that authority.

## Gate results

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit -p apps/api` | PASS |
| `bun run --filter @clawville/web typecheck` | PASS |
| `bun run build` | PASS — 9/9 packages |
| Land/tenure/guard + related protocol/action suites | PASS — 298 passed, 0 failed; 38 expected DB-only skips |
| Dedicated staging Land P2 DB contract | PASS — 4/4 |
| Mock-Hatcher local self-test | PASS — 86/86; G4 proves all 11 verbs are in the v46 manual |
| `git diff --check` | PASS; line-ending conversion warnings only |

## Operational notes

- `git pull --ff-only` was attempted before work, but this local branch has no
  upstream configured. It made no change.
- The worktree remains uncommitted as required.
