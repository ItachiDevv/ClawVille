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

---

## ROUND 2 — fresh full re-audit (2026-06-12, after the first 8 were fixed). 3 BLOCKING + 1 MAJOR + 1 MINOR. NOT partner-ready.

R2-1. [FIXED 2026-06-12] BLOCKING — public connect can overwrite Hatcher-owned rows. `/api/agent/connect` (agent-gateway.ts:167,:396) + legacy `/api/openclaw/register` (openclaw.ts:179) exclude identityType:'hatcher' but DO NOT reserve the `hatcher:` agentId NAMESPACE. Any unsigned caller POSTs agentId:"hatcher:<id>" → existing-row update path mutates the partner's row (identityType/mode/protocol/session hash/userId) → breaks partner stats/patch/delete/launch, corrupts restore, can rebind with an owned token. FIX: reject reserved prefixes (`hatcher:`, future partner namespaces) in ALL public registration paths + refuse to mutate an existing identityType==='hatcher' row unless it came through the signed partner router.

R2-2. [FIXED 2026-06-12] BLOCKING — validateLiveAgentSession ignores session_key_hash on Map hits (require-auth-or-agent.ts:121). Map+TTL only; a rotated session (new hash written by /connect or partner register) leaves the OLD in-memory bearer valid until restart, still passing real-CT gates if boundUserId matches. (Flaw in today's b453fb18 restore design — the hash invalidates restore but not live rotation.) FIX: on every Map hit require bot.sessionKeyHash === sha256Hex(sessionId); mismatch → unregister + null. (Multi-live-session = explicit session table, not one column.)

R2-3. [FIXED 2026-06-12] BLOCKING — Hatcher cognition SSRF not DNS-safe at call time (openclaw-client.ts:174,:245; hatcher-config.ts:191). Registration does DNS-aware validation; the per-call cognition path re-runs only the SYNC hostname allowlist before fetch. An allowlisted subdomain can DNS-rebind to a private IP post-registration → server POSTs the scoped bearer + ClawVille signature to it. redirect:'manual' does not stop rebind. FIX: DNS-aware validator on EVERY outbound cognition call (resolve + reject private IPs immediately before connect), or pin resolution / fixed partner endpoints. Drop wildcard subdomain steering for cognition.

R2-4. [FIXED 2026-06-12] MAJOR — Hatcher spectate can't recover the world stream after API restart (hatcher-launch-handler.tsx:115; use-world-stream.ts:202,:302). Launch sets controlMode 'explore'; explore skips position uploads, so the /position 409 recovery never fires; SSE 403 on membership loss only retries the same URL, never replays /join with the room ticket. A deploy during spectate strands the launched viewer. FIX: on SSE error run join(true) before reopening the stream; update roomId+ticket+local id from the result. SHIPPED: extracted the ticketed-rejoin into one `rejoinWithTicket()` primitive shared by `recoverFrom409` (player mode) and the SSE `onerror` handler. To protect the scarce `/join` budget (server joinRateLimiter = 3/60s/IP), onerror ESCALATES in two steps — a cheap bare same-url reopen first (heals transient blips, zero /join; `open` clears the flag), then the ticketed rejoin only if that reopen ALSO errors (the membership-loss signal). Shared `recoveryInFlight` latch + exp-backoff preserved. Auditor re-approved; `next build` exit 0.

R2-5. [FIXED 2026-06-12] MINOR — legacy /api/openclaw/unregister/:sessionId (openclaw.ts:370) expires+sweeps but leaves session_key_hash (unlike expireSession + partner DELETE). Fails closed today but violates the terminal-transition invariant. FIX: set sessionKeyHash:null there or route through expireSession().

R2-6. [FIXED 2026-06-12] MAJOR (adjacent blind SSRF, round-2 auditor) — gatewayUrl-bound cognition fetches are SSRF-unchecked. `OpenClawClient.chatOpenAI`/`chatAnthropic`/`chatCustomWebhook` (openclaw-client.ts ~:330,:362,:401) POST the agent's own token to `this.gatewayUrl` every NPC-conversation tick, validated only by `z.string().url()` at /connect → blind SSRF to 169.254.169.254 / RFC1918 / localhost. Lower severity than R2-3 (agent's own token to its own gateway) but a real internal-reachability primitive. FIX: NEW generic `validateOutboundUrlResolved` (hatcher-config.ts) — same private/loopback/link-local/reserved IP rejection (literal + resolved) as the Hatcher allowlist validator, reusing the identical `isPrivateIP` classification, but with NO host allowlist and http allowed (arbitrary public gateway). All three chat methods resolve-and-check before fetch and fail soft (return '') on reject. Tests: 8 `validateOutboundUrlResolved` unit cases (hatcher-config.test.ts) + selftest-e2e F8c (private-gateway → no outbound fetch).

VERDICT: NOT partner-ready. Biggest risk: the hatcher: namespace is not globally reserved — a public unsigned endpoint can mutate partner-owned rows.

ROUND-2 STATUS (2026-06-12): R2-1, R2-2 (present-and-mismatch carve-out), R2-3, R2-5, R2-6 all FIXED + tested (tsc clean, selftest-e2e 82/82, hatcher-config 33/33, reserved-agent-namespaces 10/10). R2-4 (web spectate stream recovery) owned by impl-web.

---

## ROUND 4 — Codex FOURTH independent pass (2026-06-12). 1 BLOCKING + 2 MAJOR. The integration embarrassed us with a live partner; looping Codex to ZERO blocking.

P4-1. [FIXED 2026-06-12] BLOCKING — Hatcher register/PATCH not serialized per agent. Two concurrent POST `/api/partner/hatcher/agents` (or PATCH) for the SAME agentId both cleaned stale sessions, both minted different `hat-*` bearers, both wrote a different `session_key_hash`, both `registerOpenClaw`d — the later DB write won the hash, so the earlier 200-OK bearer immediately failed `validateLiveAgentSession` (present-and-mismatch), and avatar mode spawned DUPLICATE bodies (`registerOpenClaw` keys the sim Map by sessionId, not agentId). New-agent path also had a check-then-insert duplicate race.
FIX: serialize the WHOLE critical section per `namespacedAgentId` with BOTH (a) an in-process async mutex (`apps/api/src/services/keyed-mutex.ts` `withKeyedMutex`, keyed by namespacedAgentId — covers the post-commit in-memory stale-cleanup + spawn a DB lock can't) AND (b) a transaction-scoped `pg_advisory_xact_lock(agentCriticalSectionLockKey(namespacedAgentId))` (cross-process) that RE-READS the row after acquiring. Both POST register and PATCH are wrapped. The upsert + bearer-hash now commit in ONE transaction (atomic — no separate post-write window). DEADLOCK SAFETY: the agent lock is acquired FIRST and the per-(partner, UTC-day) cap lock only NESTED inside it on the insert branch, so the order is always agent → cap and the two locks can never be taken in opposite orders (the cap path never takes cap before agent). Key namespace `hatcher-agent:<id>` can't collide with the cap key (`hatcher:<epochMs>`). TESTS: keyed-mutex.test.ts (6 cases: serialize / concurrent-different-key / throw-release / map-drain); selftest H11 (two concurrent same-agent registers → exactly ONE body + ONE live bearer via the real withKeyedMutex + real npcSimulation).

P4-2. [FIXED 2026-06-12] MAJOR — register returned `ok:true` + a raw sessionId even when the pre-register `session_key_hash` persist FAILED (a dead credential in a success response — neither live nor restorable). FIX: the upsert + atomic hash are ONE transaction; on its failure the handler returns `503 { error: 'session_persist_failed' }` and NO sessionId/ok:true. The PATCH mint branch already only set `rotatedSessionId` AFTER a successful hash persist, so it never surfaces a minted id whose hash didn't commit (verified + commented). TEST: selftest H9 (signed register, DB-tx fails → 503 session_persist_failed, no sessionId, no live body).

P4-3. [FIXED 2026-06-12] MAJOR — legacy `/api/openclaw/register` had an 'ephemeral-only if DB fails' fallback then still called `registerOpenClaw`, leaving a live Map body with no surviving row/hash (unusable under the shared `validateLiveAgentSession` contract — chat/location/cove re-read the row and fail closed → an unauthenticatable body). FIX: removed the fallback; the catch now returns `500 { code: 'registration_failed' }` BEFORE `registerOpenClaw` runs, so no live session is created without its DB row + bearer hash. TEST: selftest H10 (legacy register, DB-fail → 500, no in-memory session).

ROUND-4 STATUS (2026-06-12): P4-1, P4-2, P4-3 all FIXED + tested — `bunx tsc --noEmit apps/api` exit 0; selftest-e2e 86/86 (added H9/H10/H11); keyed-mutex 6/6. An independent Codex pass-5 follows; our own green is not the gate.
