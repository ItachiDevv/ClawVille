---
name: mock-hatcher-harness-gate
description: "The mock-Hatcher signed-wire harness (scripts/hatcher/*, run-mock-e2e.md) is THE regression gate on any protected-surface change — register→stats→401→DELETE + cognition proxy + contract-probe GREEN on staging. A green tsc/bun test is NOT a substitute. Validate vs the partner's REAL .hatcher-ref/CONTRACT.md."
category: constraint
confidence: high
date: 2026-06-22
---

# Mock-Hatcher harness — THE regression gate

**Status: LIVE gate (mandatory pre-ship).**

## Rule
ANY protected-surface change MUST drive the LIVE signed binary end-to-end on staging and assert GREEN before 'done'. A green `tsc`/`bun test` is **NOT** a substitute — only the harness exercises the real signed wire.

## What to run (`apps/api/scripts/hatcher/run-mock-e2e.md`)
1. `mock-hatcher-client.ts` — generates an ed25519 keypair, signs register/stats/delete like Hatcher; asserts: 200 + sessionId; raw agentId echoed (prefix stripped); protocol pointer present; `sessionExpiresAt`; `avatarProvisioned=true` (E5); NO token leak; **401 on a wrong-path signature**. Flags: `--identity-key` (E5 avatar path), `--no-delete`, `--delete-only`.
2. `mock-hatcher-proxy.ts` — a mock partner proxy that verifies OUR `Bearer <scopedToken>` + ed25519 issuer signature on the cognition callback and replies an `[ACTION: emote(wave)]` the sim dispatches — proving the sign-and-verify wire both directions.
3. `contract-probe.ts` — probes A–F asserting OUR register/PATCH schemas vs Hatcher's REAL `ClawVilleRegisterBody`/`ClawVillePatchBody` (PATCH `{stats}`/`{home}`/`{rotateScopedToken}`-only HARD-FAIL 400 'No mutable fields'; stats silently dropped on PATCH `{name,stats}`; our stat bounds tighter than their form).

## Prereq + cleanup
Requires `ALLOW_TEST_PARTNER_PUBKEY` set on staging via Coolify tinker (app id 3 staging-api; model setter, not raw SQL). **ALWAYS cleanup:** DELETE the agent + UNSET the var + `rm` the keyfile.

## FEATURE_GATE: automated staging contract suite
Backlogged until Hatcher is confirmed live. Until it lands, this manual harness IS the regression gate; once the suite exists it runs in CI on every push touching the protected surface and the manual harness becomes the fallback. Do not delete this gate while the manual harness is the only protection.

→ [[validate-against-hatcher-ref]] [[codex-pass-on-protected-surface]]
