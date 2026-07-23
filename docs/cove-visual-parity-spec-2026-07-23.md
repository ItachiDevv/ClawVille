# Cove visual-parity operations — 2026-07-23

The authoritative contract is [`specs/spec-parity.md`](../specs/spec-parity.md), revision 4. This note is an operational index, not a duplicate specification.

## Build-only Wave W-E1

- `scripts/parity/` supplies the Bun runner, recorded-payload assertion engine, scenario catalog, matrix emitter, screenshot plumbing, recovery-aware fixture lifecycle, and wrong-card self-test.
- The harness derives correlation only from immutable fields already visible to the application. Publishers and `window.__CV_READ_PARITY` gain no harness-only sequence field.
- Staged felt is tray-first ordered replay; felt is asserted only at states where the application renders it.
- `scripts/parity/atlas-fixture/normalize-atlas.ts` and `contact-sheet.ts` provide the deterministic 53-cell atlas comparison flow.
- BA-2 is staging-only and crash-loud. Tokens are show-once, stored only as SHA-256 hashes, scoped to one owner and arm, one-shot consumed, and budgeted in atomic vCLAW.
- Migration `packages/database/migrations/0026_test_fixture_runs.sql` is authored only. It must not be applied during this build-only wave.

## Recovery and provenance safety

Fixture foreign keys are restrictive. Replacement creation is serialized by owner and scans only linked open/unsettled resources. Safe blackjack/baccarat state is revealed and closed; cash must use normal Walk Away and retains a commit/reveal tombstone. Unsafe hard-death state rotates the stale token hash and returns a show-once `409 fixture_recovery_required` credential; the harness keeps it in page memory only, reconciles, deletes the stale run, and retries. The fixture is unreachable outside literal `CLAWVILLE_ENV=staging`.

## Offline gates

Offline gates cover typechecking/builds, recorded correct-card PASS, injected wrong-card FAIL, fixture gate/token/one-shot/budget behavior, baccarat threshold replay, cash deterministic-seed behavior, matrix generation, and atlas normalization/contact-sheet determinism. No server, browser, database connection, migration apply, or live scenario belongs to this phase.

## Founder-gated live plan

Every required row in the revision-4 scenario×tier×surface matrix must be exercised live. Required `UNPROVEN` or `BLOCKED` rows fail the gate. Live work includes staging fixture issuance/recovery, human and agent tiers, 2D and 3D surfaces, screenshot evidence, 53-cell visual comparison approval, and final matrix emission. Exact scenarios, asserted states, visible-surface probes, teardown order, and evidence paths remain defined only in `specs/spec-parity.md`.

PARITY: human+agent path: the harness certifies rendered cards == wire truth for every surface both subjects see; fixture is staging-only crash-loud; no runtime wire change.
