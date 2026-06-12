# Codex full-diff review findings — 2026-06-12 (origin/master..staging)

Independent Codex static review of the day's entire diff. 8 findings; 2 BLOCKING. Verdict: NOT safe to promote staging→master until the blockers + the partner/user-facing MAJORs are fixed. Two of these (#2, #5) are continuations of work the in-house multi-agent teams already touched and missed.

## 1. BLOCKING — test-pubkey prod gate is fragile (`apps/api/src/services/partner-signature.ts:96`)
The `ALLOW_TEST_PARTNER_PUBKEY` kill-switch relies on substring-matching `CORS_ORIGIN` for "is prod". A comma-list containing both prod+staging, or an unset/mis-set `CORS_ORIGIN`, makes the test key a full Hatcher signer on prod (can register/delete agents, mint real-CT avatars).
FIX: gate on an explicit immutable deploy env (e.g. `CLAWVILLE_ENV === 'staging'`), and FAIL BOOT if `ALLOW_TEST_PARTNER_PUBKEY` is set when not staging. (Note: this env must be set on the staging Coolify box when adopted — coordinate with orchestrator, since ALLOW_TEST_PARTNER_PUBKEY is already set on staging.)

## 2. BLOCKING — agentId hydrated as the session bearer (`apps/web/src/app/game/page.tsx:313`)
`agentSession.agentId` is passed to `setAgentConnection()` which expects the bearer `sessionId`. Next avatar chat sends `agentId` as `sessionId` (`avatar-chat-bar.tsx:168`) → 404 → connection clears. Reload lands in a false "connected" state that breaks on first chat. THIS IS PART OF THE PARTNER'S ONGOING SYMPTOM.
ARCHITECTURAL CONSTRAINT: the server never re-emits the session bearer after first connect (security invariant), so `/me/agent-session` cannot return a real bearer. Therefore the browser genuinely cannot hold a live agent-session bearer after reload.
FIX: split UI "paired/active" state from "holds-a-live-agent-bearer". On reload show paired status WITHOUT enabling the agent-bearer chat path; the agent-bearer chat path is only available in the same session that performed the connect (and holds the bearer in memory). Do NOT fabricate a bearer from agentId. If owner-driven agent chat after reload is desired, it needs a real owner-safe re-acquire channel (separate scoped task, not this fix). Coordinate with whatever D2 stale-clear logic shipped today (avatar-chat-bar.tsx + stores/game.ts) so the two are consistent.

## 3. MAJOR — launch token in URL query leaks (`apps/web/src/components/game/hatcher-launch-handler.tsx:66`)
`hatcher_launch` (bearer-style) sits in the `/game?` query, stripped only after mount (`:75-82`) — already captured in CDN/web access logs + early-asset `Referer` headers before stripping.
FIX: move the grant off the query string — fragment (`#`, never sent to server/logs), or a short server-side opaque code, or a POST handoff that redirects to clean `/game` after consuming the token. (Note: this is the launch-exchange flow still pending Hatcher's answers — coordinate; a fragment is the lowest-friction fix and doesn't change their contract.)

## 4. MAJOR — PATCH silently orphans the partner's session (`apps/api/src/routes/partner-hatcher.ts:1017`)
PATCH tears down the live session, mints a new `sessionId`, persists its hash (`:1069-1072`), but the response (`:1082`) returns only `{ ok, propagated, agent }`. The partner holding the prior sessionId is silently orphaned (especially after restart, where only the new hash restores).
FIX: either preserve/reuse the existing live sessionId on PATCH, OR return the new `sessionId` + `sessionExpiresAt` whenever PATCH rotates it.

## 5. MAJOR — remote players freeze after mount (`apps/web/src/lib/three/remote-players.tsx:109`)
Entries are `memo`ized by `player` object identity, but `stores/players.ts:116-127` MUTATES player objects in place and only replaces the array. Moving Suspense outside (today's D3a fix) cured the load deadlock, but steady-state position/activity updates no longer re-render the entry → remotes mount once then FREEZE. The D3 fix was incomplete.
FIX: pass scalar props / a version key, remove `memo`, or make `updateFromSnapshot` replace changed player objects (immutable update). Verify with the two-presence synthetic-player gate (held SSE stream + heartbeat) that a remote VISIBLY moves, not just mounts.

## 6. MAJOR — restore fallthrough for malformed legacy rows (`apps/api/src/services/openclaw-session-restore.ts:231`)
Restore refuses real-gateway agents only when `gatewayUrl` is present + non-localhost. A malformed/legacy `openclaw`/`custom` row with `protocol='openai-compat'` and null `gatewayUrl` falls through, builds a dummy `http://localhost:0` client → reintroduces the restored-mute-body class (the D1 bug's cousin).
FIX: after hatcher + no-gateway identities, return `null` for ALL real-gateway identity types (authToken is never persisted, so they cannot be faithfully restored — reconnect is the correct behavior).

## 7. MAJOR — registration cap read-then-insert race (`apps/api/src/routes/partner-hatcher.ts:689`)
Daily cap is count-then-insert, no lock/constraint. Concurrent new-agent requests all read below cap and insert → cap bypassed.
FIX: atomic per-partner/day counter row, serializable transaction, or advisory lock around count+insert.

## 8. MINOR — DELETE leaves stale session hash (`apps/api/src/routes/partner-hatcher.ts:1136`)
DELETE tombstones + scrubs proxy creds but leaves `sessionKeyHash` intact. Restore still fails closed (TTL/swept/proxy), so not an immediate bypass, but terminal lifecycle shouldn't retain a stale bearer hash.
FIX: set `sessionKeyHash: null` on DELETE + explicit-disconnect expiry paths.

## ALSO FOLD IN (auditor drift note, sticky-rooms)
Export `resolveRecoveryRoomId(ticket, liveSessionId)` from `room-ticket.ts` and have `world.ts` (the join recovery guard) DELEGATE to it, so the unit test exercises the LITERAL route code instead of a mirror that could drift. ARCHITECTURE.md §13 sticky-rooms entry already describes this as done — the doc was reverted to match the un-refactored code; this fix makes the (better) doc true. Re-add that doc wording when the code lands.
