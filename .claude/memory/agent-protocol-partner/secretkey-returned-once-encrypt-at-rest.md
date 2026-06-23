---
name: secretkey-returned-once-encrypt-at-rest
description: "wallet.secretKey + identity secret are returned EXACTLY ONCE on first-mint (omitted on reconnect/join/race-loser, no recovery path); the scoped token + custodial secrets are AES-256-GCM envelope-v2 at rest (per-row DEK wrapped by CF KEK), decrypted in-memory only, never echoed/logged. FIXED."
category: security
confidence: high
date: 2026-06-22
---

# secretKey-once + encrypt-at-rest, never-log

**Status: FIXED + LIVE.** A kill-the-build invariant.

## secretKey returned EXACTLY ONCE
`wallet.secretKey` is populated ONLY when the keypair was just minted: `firstTimeSecretKeyBase58` only when `alreadyExisted===false` (`wallet-service.ts:325`). Reconnect (`agent-gateway.ts:1156-1165`), `/join`, and the **23505 race-loser** (`:287`) all OMIT it — spread the field conditionally. The identity ed25519 secret obeys the identical rule: only on `isFirstTime===true` via an atomic `WHERE identity_pubkey IS NULL` UPDATE (`identity-service.ts:232`); race-loser → `needsHumanReauth`, empty secret (`:255`). **No recovery path** — the server never re-emits.

## Encrypt-at-rest (keypair-vault envelope v2)
- AES-256-GCM (`keypair-vault.ts:6`). Envelope v2 = fresh per-row DEK wrapped by the CF Worker KEK (`:261`/`:296`) — a VPS-only dump yields ciphertext + wrapped-DEK but NOT the KEK. v1-legacy under `VANITY_ENCRYPTION_KEY`; `decryptWalletRow` version-dispatches (`:332`).
- The Hatcher **scoped cognition token** uses the same envelope (`encryptToken` `:62`), stored `proxyTokenEnc/Iv/Tag`, decrypted in-memory ONLY at spawn/cognition time.

## Never log / echo
JSDoc `:62`: 'NEVER store plaintext token; NEVER log the return of `decryptToken()`'. `publicAgentRecord` echoes `proxyUrl` (the partner's own URL, safe) but NEVER the token. Persist/log only the one-way hash — `sessionDigest` (16-hex) for `events.session_id`, full `sha256Hex` for the row `sessionKeyHash`; NEVER the raw `hat-` bearer. `scrubEventPayload` + `SENSITIVE_KEY_RE` strip secret-ish keys from the stats response (only JSON scalars pass; nested objects dropped). `openclaw-client` fails soft logging WITHOUT the token.

## When editing
Adding a field to `publicAgentRecord`, a new `console.log`, or a new event payload key on the register/patch/cognition path → re-verify no decrypt return / raw bearer leaks. The harness asserts 'response leaks NO token fields'. Any custodial/token write change → Codex adversarial pass.

→ [[ssrf-allowlist-signed-outbound]]
