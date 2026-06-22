---
name: allow-test-pubkey-env-guard
description: "ALLOW_TEST_PARTNER_PUBKEY is an additive STAGING-ONLY mock-Hatcher signer gated by CLAWVILLE_ENV==='staging' with a module-load throw that crashes boot if set off-staging. NODE_ENV can't discriminate. FIXED."
category: security
confidence: high
date: 2026-06-22
---

# ALLOW_TEST_PARTNER_PUBKEY env guard (crash-loud off-staging)

**Status: FIXED + LIVE.** Mirrors the `FINGERPRINT_SECRET` crash-loud pattern.

## Invariant
`ALLOW_TEST_PARTNER_PUBKEY` is an **ADDITIVE** ed25519 signer for partner `'hatcher'` ONLY (never replaces `PARTNER_PUBKEYS.hatcher`), honored ONLY when `CLAWVILLE_ENV==='staging'`.
- `isStagingEnv()` = `process.env.CLAWVILLE_ENV === 'staging'` literal equality (`partner-signature.ts:81-82`) — NO substring/comma parsing.
- **MODULE-LOAD THROW (`:97-103`):** if the var is set (non-empty) while `CLAWVILLE_ENV !== 'staging'`, the module throws AT IMPORT — a prod box carrying it **refuses to boot**.
- `loadTestPartnerPubkey()` re-checks `isStagingEnv()` at use-time + validates 32-byte ed25519 (`:117-149`) as defense-in-depth; logs a loud staging-only warning (`:149`).

## Why NODE_ENV can't be the discriminator
`NODE_ENV` is `'production'` on BOTH Coolify boxes (staging AND prod). Only `CLAWVILLE_ENV` (set per-box in Coolify, immutable deploy signal) distinguishes them. **The staging box MUST set `CLAWVILLE_ENV=staging` alongside the var or staging ALSO fails boot.**

## Traps
- NEVER reintroduce CORS_ORIGIN inference (the old bug — a comma-list/unset/mis-set value could re-open the test signer on prod).
- The test key inherits the FULL hatcher power set (no per-power scoping) — residual risk; keep it staging-only.
- The harness sets it via Coolify **tinker** (model setter `$row->value=...; $row->save()`, NEVER raw `DB::update()` + `Crypt::encryptString` — that breaks decrypt). ALWAYS UNSET after a harness run; never commit the keyfile (`chmod 600`).

→ [[ed25519-window-signing]] [[mock-hatcher-harness-gate]]
