# FEATURE_GATE: wallet-unification-full-surface-hardening

- Rule: E6 tracked deferral
- Owner: ClawVille Agent Protocol + Token Economy domain owner
- Status: DEFERRED by founder ruling on 2026-07-29
- Review deadline: 2026-09-30
- Tracking: [GitHub issue #257](https://github.com/ItachiDevv/ClawVille/issues/257)
- Repository index: [Open work item in TODO.md](../TODO.md#wallet-unification-full-surface-hardening)
- Specification: frozen wallet-unification spec rev 5, sections 1.8, DEFERRED HARDENING, and 5
- Review artifact: `wallet-unification-spec-rev5.md`, session `996dc187-0e97-49b0-9a80-0a17e7d1964e`

## Scope

- F1: bind custody health to current ciphertext and add a periodic health job.
- F2: convert remaining mirror consumers to the pure settlement resolver and remove mirror-equality signer preconditions.
- F3: add append-only custody address history.
- F5: add auditable backfill run and incident records plus a promotion gate.

## Immediate trigger

Promote and execute this milestone immediately, without waiting for the deadline, if either condition occurs:

1. Any F2 custody consumer is edited: `land.ts`, `market-listings.ts`, `land-rent-sweeper.ts`, `partner-covenant.ts`, the reef leaderboard wallet reader, `wallet-withdraw-executor.ts`, or `earned-redemption.ts`.
2. Any custody-material, re-encrypt, or KEK-rotation write path is added for `wallets.encrypted_secret_key`, IV, tag, encryption version, or wrapped DEK.

An F2 consumer must not be edited without converting it to the resolver. A custody-material writer must not land before or without F1 invalidation and current-material health.

## Graduation

All F1, F2, F3, and F5 work is complete, the wallet-unification rev 5 section 1.8 invariant is green, and the branch-3/5 preflight count has been re-run.

## Cutover gate from frozen spec section 5

Production promotion order remains: this tracked gate is present, protected Hatcher Slice 0 is signed off, migration `0046_wallet_custody_verified.sql` is applied, the per-environment avatar promotion script succeeds, Slice 1 deploys, and Hatcher is confirmed to advertise the avatar settlement wallet. No step writes or repoints the bot mirror.
