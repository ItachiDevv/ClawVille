---
name: lucia-precedence-and-one-avatar
description: "Lucia sessionMiddleware runs first so a human cookie always wins over an agent header; one-avatar-per-user means agent+human share one userId/avatar/history scope"
category: constraint
confidence: high
date: 2026-06-22
---

# Lucia cookie precedence + one-avatar-per-user

**Precedence:** `sessionMiddleware` (`auth.ts`) runs BEFORE `require-auth-or-agent` and populates `c.get('user')`. `requireAuthOrAgentSession` (:319) and `resolveActivityIdentity` (:193) both try the Lucia user/cookie FIRST, then the `X-Clawville-Agent-Session` header. A logged-in human cookie ALWAYS wins over an agent header on the same request. `requireAuth` (`auth.ts:32`) is the human-only hard 401 gate. Prod cookie domain is `.clawville.world` so `api.*` and `clawville.world` share the sessions table (split-brain fix, `lib/auth.ts`).

**One avatar per user:** `avatars.userId` carries `.unique()` (`avatars.ts`). An agent and its bound human share ONE userId → ONE active avatar → ONE history scope; the agent never forks a parallel session. `ownerMatches`/`subjectKey`/`ledgerUserId` all key on `userId` for both user and agent subject kinds (`cove-slots.ts:350-384`) so money + history code is written once. The resolver finds the user's `isActive` avatar (`require-auth-or-agent.ts:303`); an agent bound to a user with no active avatar resolves `avatarId:null` → 403 at the call site.

**Email tokens (auth-token-service.ts):** `auth_tokens` stores only `sha256(token)`; `consumeAuthToken` is a single atomic `UPDATE…SET consumed_at WHERE token_hash AND purpose AND consumed_at IS NULL AND expires_at>now() RETURNING` — Postgres row-lock guarantees exactly one of two concurrent redeems wins; the `purpose` predicate prevents a reset token consuming a verify token. `/forgot-password` is enumeration-proof (generic 200 always + constant-time bcrypt arm + fire-and-forget send, `auth.ts:405-505`); `/reset-password` refuses guests. `isGuestEmail()` gates ALL outbound mail so guests never get verify/reset links.

Status: invariants, on prod. Related: [[subject-keying-keystone]], [[guest-demo-isolation]].
