# Agent-session identity hardening — DEFERRED follow-up (opened 2026-06-05)

> These are real issues surfaced by the dual review (Claude team + 3 Codex lenses) during the
> 2026-06-05 bearer-leak hardening pass, but they are a SYSTEMIC auth-model project, not part of
> "redact the raw bearer from logs/events." They share ONE root cause with the parked Milady work
> ([[milady-signed-challenge-PARKED]]): an agent's identity at `/connect` and `/register` is NOT
> cryptographically proven, so knowing an `agentId` grants liveness. Fixing them right means the
> same ed25519 signed-challenge / ownership-proof machinery the Milady fix introduces. Group them.

## Root cause
`agentId` is a public-ish identifier, but the server treats "presents a known agentId" as "is that
agent." Hatcher closed this with ed25519 signed challenges; Milady + legacy openclaw `/register` did
not. Every item below is a symptom.

## Deferred items (with the review evidence)

1. **`/api/agent/connect` TTL resurrection (HIGH, Codex auth-lens).** agent-gateway.ts ~412-439:
   `/connect` unconditionally refreshes `sessionExpiresAt` for an existing row. A non-owner who knows
   a victim `agentId` can POST agentId-only, resurrect expired DB liveness, and receive a fresh bearer
   (~888-890). Cove rejects via `ledgerCapable:false`, but the session is live for other agent routes.
   FIX (proper): require an ownership proof (signed challenge / owned connect-token / identityKey) before
   refreshing TTL or registering a session for an existing bound/expired row. This is why the parallel
   `/register` blanket gate (R5-2) was REVERTED in the 2026-06-05 ship — the gate broke legit returning
   bots; the right fix is ownership-gated, not blanket-blocked.

2. **`ledgerCapable` not enforced on building visit/chat routes (HIGH, Codex auth-lens).**
   agent-gateway.ts building visit/chat handlers (~2059, 2117, 2216, 2326) call `resolveSession()` and
   never check `ledgerCapable`, then credit the bound avatar's CT/knowledge via `bot.userId`. A
   non-ledger (resurrected/unproven) session can earn CT/knowledge. FIX: have `resolveSession()` carry
   the full `resolveAgentSession()` result and require `ledgerCapable` before any CT/owned-skill route.

3. **`/register` unauthenticated field mutation + TOCTOU (HIGH, Codex regression-lens).** openclaw.ts
   POST /register: anyone who knows an `agentId` can keep a still-live row alive and mutate
   gateway/mode/name. Also any liveness gate here is read-then-write racy. FIX: make liveness atomic in
   the `UPDATE ... WHERE id = ? AND session_expires_at > now()` branch, and don't mutate bound-agent
   fields without ownership proof. (Note: legit reconnect should move to `/connect`; UI already marks
   `/register` backwards-compat, but arena openclaw-avatar/override pages still call it — migrate them.)

4. **`milady-session-exchange` reachable by any live session (Codex auth + Claude).** auth.ts ~855-894:
   with the `miladyTrusted` partial intentionally stripped (Milady parked), any live ag-/oc-/hat- session
   can mint a `milady-${agentId}@clawville.guest` Lucia cookie (liveness + 5/min/IP only). Blast radius =
   a fresh per-agentId guest account (no real-CT/owned avatar), and it matches current PROD behavior.
   FIX: lands with the Milady signed-challenge (provenance gate), see [[milady-signed-challenge-PARKED]].

5. **`skills.ts` trusts map-membership without `validateLiveAgentSession` (MEDIUM, Codex auth-lens).**
   skills.ts ~239-255, 320-335: skill auth uses `getOpenClawBotConfig()` map membership without the TTL
   check, so an expired-in-map session is treated as a valid identity for skill reads/avatar resolution.
   FIX: route through `validateLiveAgentSession()` / `resolveAgentSession()`. (NOTE: the skills.ts raw
   `X-Clawville-Session-Id` LEAK into events was already closed by the 2026-06-05 event-logger chokepoint;
   this item is the separate TTL-trust gap.)

6. **Hatcher PATCH does not emit `agent.connected` (MEDIUM under-count, Codex money-lens).**
   partner-hatcher.ts ~932/966-975: a PATCH mints+registers a fresh live `hat-` session but returns
   without emitting `agent.connected`, so legit Hatcher reconnect/update sessions are UNDER-counted in
   the leaderboard session score. FIX: emit `agent.connected` after the PATCH live registration with
   `sessionId: sessionDigest(sessionId)`, `agentId: namespacedAgentId`, `userId: row.userId`,
   `payload.via='partner-patch'`.

7. **`ct-` connect-tokens not in the bearer-redaction regex (LOW, orchestrator note).** The 2026-06-05
   event-logger chokepoint redacts `ag-/oc-/hat-/claw-` but not `ct-${randomBytes(24)}` connect-tokens.
   The connect-token is a one-time claim credential (lower value than a session bearer) and is not known
   to be written into `events`, but if it ever is, it would land raw. FIX: add `ct` to `RAW_BEARER_RE`
   if/when a connect-token is shown to reach an event/log surface.

## Suggested sequencing
Do this AS the Milady signed-challenge project (they share the ed25519/ownership-proof machinery): land
the signed-challenge + `ledgerCapable`/ownership gate on `/connect` and `/register` (items 1-4), then the
cheap independent fixes (5, 6, 7) can ride along or ship separately.
