---
name: ed25519-window-signing
description: "Partner writes are ed25519-verified vs PARTNER_PUBKEYS over a domain-separated ±5-min challenge of EXACT raw bytes; inbound never canonicalizes (outbound does). SEC-2 in-window replay is an accepted residual gated on idempotency."
category: security
confidence: high
date: 2026-06-22
---

# ed25519 + ±5-min windowed partner signing

**Status: FIXED + LIVE on prod.** Hatcher PROD → ClawVille PROD since 2026-06-15 — a regression here breaks a live partner.

## Invariant
Partner WRITES are ed25519 over `sha256(partnerWriteChallenge)` where `partnerWriteChallenge = 'clawville-partner-write\n<METHOD>\n<PATH>\n<UNIX_MS>\n<sha256hex(rawBody)>'` (`partner-signature.ts:287`). The GET challenge uses prefix `clawville-partner-get` — the differing domain prefix means a GET sig can NEVER replay as a write nor cross verb/path. Window ±5 min via `PARTNER_WRITE/GET_SIGNATURE_WINDOW_MS` (both `5*60_000`, `:249`/`:378`). Timestamp parse is STRICT `/^\d{1,15}$/` BEFORE `Number()` (`Number.parseInt` would accept `'123abc'`); reject NaN/fractional/negative/stale/future.

## The asymmetry trap (do NOT mix)
- **INBOUND** `verifyPartnerWriteSignature` (`:311`) / `verifyPartnerGetSignature` (`:416`) verify the **EXACT raw body bytes** — NO canonicalization. `readSignedBody` reads `c.req.text()` BEFORE `JSON.parse` (`partner-hatcher.ts`), and partner routes carry NO Lucia. Re-stringifying an inbound JSON body before verify fails on key-order/whitespace.
- **OUTBOUND** `service-issuer.ts signPayload` (`:131`) signs `ed25519(sha256(canonicalJson(sorted-keys)))`. Send `signed.body` verbatim so the partner hashes the same bytes.

Sig must decode to 64 bytes, pubkey to 32 (after `bs58.decode`); decode failure ⇒ `bad_signature_encoding`; all failures collapse to a single opaque 401 reason. `PARTNER_PUBKEYS` missing/malformed ⇒ `loadPartnerPubkeys()` returns null ⇒ every signed request 401s.

## OPEN-by-design: SEC-2 in-window replay residual (`partner-signature.ts:234-248`)
Identical signed bytes re-verify within the window (ed25519 over identical bytes verifies forever). ACCEPTED because every current write is idempotent-by-agentId (register/PATCH upsert the same row, DELETE no-ops once gone) — a replay produces no new effect, and a consumed-signature cache would falsely 401 a legit client retry after a dropped response. **A future NON-idempotent partner verb MUST add a partner-supplied nonce bound into the signed challenge, consumed delete-on-read gated on the route's DURABLE success (mirror auth-challenge `consumeNonce`).**

## When editing
Add a new outbound partner call → add its purpose string to `getPublishedIssuerInfo()` or a purpose-scoping verifier rejects it. Any change here → Codex adversarial pass + the mock-Hatcher harness GREEN. → [[allow-test-pubkey-env-guard]] [[validate-against-hatcher-ref]]
