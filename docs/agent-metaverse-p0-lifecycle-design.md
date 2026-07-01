# P0 — Lifecycle Truth: design + build spec

> Phase P0 of `docs/agent-metaverse-model.md §9`. The **smallest correct first diff**: make ONE lifecycle authority so `session-status`, the bearer gate, boot-rehydration, `/disconnect`, and the sweeper all AGREE — fixing the restart-desync at the source. **No autonomy engine, no substrate rename, no `[ACTION:]` generalization, no `PROTOCOL_VERSION` bump.**
>
> Runs in worktree `cv-agent-metaverse` on branch `feat/agent-metaverse-build`. Touches the PROTECTED Hatcher surface (session/bearer/`registerOpenClaw`/`openclaw_bots`) → full backend team + Codex adversarial review + mock-Hatcher harness stays green.

## Ground truth (verified in code, 2026-07-01)

| Surface | File | Reads from | Problem |
|---|---|---|---|
| `GET /api/agent/session-status` | `agent-gateway.ts:1114` | **DB row TTL only** (`openclaw_bots.session_expires_at`) | Returns `connected:true` on a live TTL even when RAM is empty → LIES after restart |
| Bearer gate `validateLiveAgentSession` | `require-auth-or-agent.ts:91` | **RAM** (`isValidAgentSession` = `openClawBots.has(sessionId)`) + DB TTL | 401s after restart because RAM is empty |
| In-memory registry | `npc-simulation.ts` `openClawBots` Map (`:456` register, `:528` unregister, `:776` isValid) | RAM only | Populated ONLY at `/connect` + `/reconnect`. **No boot rehydration.** |
| session→eliza map | `session-agent-map.ts` | RAM `Map` | Same — RAM only, no rehydration |
| Sweeper | `openclaw-session-sweeper.ts` `sweepExpiredSessions` / `expireSession` | DB | Stops the Eliza runtime but **never calls `unregisterOpenClaw`** → zombie in-world body after expiry |
| `/disconnect` | `agent-gateway.ts:1264` | DB + `unregisterOpenClaw` (in-request) | OK for live-process disconnect; irrelevant after restart |

**Critical fact — the bearer `sessionId` is NOT persisted.** It is minted fresh per connect: `agent-gateway.ts:345` `ag-${randomBytes(24).base64url}` and `openclaw.ts:133` `oc-${randomBytes(24).base64url}`. `openclaw_bots` (schema `packages/database/src/schema/claws.ts`) has **no sessionId column** — only `agentId` (stable public handle), `mode`, `targetNpcId`, `name`/`species`/`color`, `protocol`, `identityType`, `gatewayUrl`, `cognitionBackend`, `proxyUrl` + encrypted `proxyToken{Enc,Iv,Tag}`, `userId`, `knowledge`, `metadata` (`homeX/Y`, `lastX/lastY`, `stats`, `patrolRadius`), TTL fields. **Body position already survives restart via `metadata.lastX/lastY`; the bearer does not.** `/reconnect` (`agent-gateway.ts:945`, signed-challenge) already re-mints a fresh sessionId and restores position — it is the intended restart-recovery path for remote brains.

## Design decision — DO NOT persist the bearer sessionId

Persisting the random bearer credential at rest would be a **security regression** on a partner-load-bearing surface (it is the real-CT bearer). Instead we lean on the fact the architecture already chose: **the sessionId is ephemeral; `/reconnect` re-mints it.** So the two halves of "restart survival" are handled differently:

1. **Body / world / server-driven continuity → boot-rehydration.** On boot, re-create the in-world BODY + registry entry from live-TTL rows (fresh server-minted sessionId, position from `metadata.lastX/lastY`). This is what a hosted/server-driven agent (fleet, provisioned) needs — the server holds the brain, no external bearer required.
2. **Remote bearer continuity → truthful `session-status` + existing `/reconnect`.** A remote/BYO/Hatcher agent's stored sessionId is unavoidably dead post-restart (never persisted). `session-status` must STOP lying so the remote's retry loop falls into `/reconnect` (cheap, signed, position-restoring). We do NOT try to revive the remote's old bearer.

> **Open fork surfaced to founder (non-blocking):** if we later want a remote agent's *exact* bearer to survive a deploy with zero reconnect, that needs persisting a sessionId **hash** + an async `isValidAgentSession`. Deferred — reconnect is the existing, safe path; revisit only if reconnect latency proves unacceptable for a specific partner.

## P0 deliverables

### D-1 — `rehydrateAgentSessions()` (new) called at boot
- New fn (e.g. in `openclaw-session-sweeper.ts` or a new `agent-session-rehydrator.ts`), invoked from `apps/api/src/index.ts` boot (alongside `startSessionSweeper`, after seeders).
- Query `openclaw_bots` WHERE `session_expires_at > now()` AND not swept. For each row, **per-row try/catch (never crash boot)**:
  - Reconstruct an `OpenClawRegistration` config from the row (mode, targetNpcId|avatar, name, species, color, protocol, cognitionBackend, userId, knowledge, `metadata` → homeX/Y + lastX/lastY, patrolRadius, stats). Derive `ledgerCapable`/`boundUserId` the same way `/connect` does for a bound row.
  - Mint a **fresh server-side sessionId** (same `ag-`/`oc-` scheme) and reconstruct an appropriate `OpenClawClient`: for `cognitionBackend='hatcher-proxy'` rebuild with `proxyUrl` + decrypted proxy token (reuse the existing decrypt seam); for gateway protocols rebuild from `gatewayUrl`/`protocol`; for nanoclaw/anonymous/milady with no outbound, a **dormant/perception-only** client is acceptable (body present, cognition resumes on next drive/reconnect). **Prefer restoring a dormant body over a broken cognition client.**
  - `registerOpenClaw(config, client, { lastX, lastY, knowledge })` + `setSessionAgent(sessionId, elizaAgentId)` when the Eliza agent is resolvable.
  - Log a digest-only count (`[Rehydrate] restored N bodies …`) — never log raw sessionId (auth-lens rule).
- **Reconnect coexistence:** a rehydrated session for `agentId` X MUST be evicted when the remote later reconnects/re-registers X (no double body). Integrate with the existing evict-by-agentId path (`findActiveSessionsByAgentIds` → `unregisterOpenClaw`) used in `/connect`/`/reconnect`. Verify no duplicate body after: boot-rehydrate → remote `/reconnect`.

### D-2 — `session-status` reflects true liveness (the LIE fix)
- `GET /api/agent/session-status` (`agent-gateway.ts:1114`) must not return bare `connected:true` when no live in-RAM session exists for the `agentId`. Add a RAM-liveness check (`npcSimulation.findActiveSessionsByAgentIds([agentId]).length > 0`).
- States: **row missing → 404** (unchanged); **TTL expired/NULL → 410** (unchanged); **TTL live AND RAM live → `connected:true`** (unchanged); **TTL live but RAM absent → NEW**: a truthful "reconnect needed" response that drives the agent into `/reconnect` (e.g. `200 {connected:false, needsReconnect:true, reason:'session_not_live', hint:'…/reconnect…'}` — pick a shape that the existing agent retry loop + Hatcher contract handle; do NOT silently 410 if that changes partner semantics — **check `.hatcher-ref/CONTRACT.md` + keep the harness green**).
- After D-1 rehydration, at steady state most live-TTL rows WILL have a RAM session, so this mainly triggers in the narrow window before rehydration completes or for rows that failed to rehydrate.

### D-3 — sweeper + `expireSession` remove the zombie body
- `sweepExpiredSessions` and `expireSession` (`openclaw-session-sweeper.ts`) currently stop the Eliza runtime but leave the in-world body. For every expired agentId, resolve its live in-RAM session(s) (`findActiveSessionsByAgentIds`) and `unregisterOpenClaw(sessionId)` so the body is removed the same tick the session dies. Keep it non-fatal.

### D-4 — scoped constants (dead-path cleanup, low risk)
- `packages/agent-runtime/src/simulation/movement.ts:15` — `MAP_WIDTH` 5120 → 18432 (+ height if present) to match the canonical world (`npc-simulation.ts:40` already 18432; canonical dim in `3dStructure.md`).
- `apps/api/src/routes/avatars.ts` heartbeat `positionSchema` cap 5120 → 18432 (dead heartbeat path per audit VC1).
- Pathfinding grid 360 → 576 IF and only if it is genuinely inconsistent with the web tilemap (`tilemap-data.ts:16` = 576) AND changing it is safe/needed — **confirm before touching; if it risks the live NPC sim, split it out and leave a note.** Constants that are dead-path-only are the priority; do not destabilize the live sim for cosmetic consistency.

### Non-goals (explicitly OUT of P0)
- No autonomy perceive→decide→act loop (that is P1).
- No neutral-substrate rename, no `OpenClawClient`→`AgentClient` rename (P3, protected).
- No `[ACTION:]` generalization beyond `hatcher-proxy`; **no `PROTOCOL_VERSION` change**.
- No identity migration / Path-B provisioning (P2).

## Gates (before "compiled/rendering — needs your eyes")
- `tsc` clean (api + agent-runtime) + `bun test` green for touched areas.
- **Mock-Hatcher harness green** (`apps/api/scripts/hatcher/run-mock-e2e.md`): register → stats → 401 → DELETE + `contract-probe`, before AND after. Session/bearer is the protected surface.
- **Restart-survival proof (the actual P0 success criterion):** on staging (or local prod bundle) — connect an agent, restart the API, then assert: `session-status` no longer lies (RAM+DB agree), a rehydrated body is present in `/api/npc/state` / `/api/openclaw/active`, a bearer route behaves consistently with what `session-status` reports, and `/reconnect` cleanly replaces the rehydrated session with no double body.
- **Codex adversarial review** of the rehydration + session-status + sweeper changes (auth/bearer/restart semantics on a partner surface).
- Same-diff docs: `ARCHITECTURE.md` (§6/§13 — boot-rehydration + one lifecycle authority + sweeper-removes-body), tick the P0 box in `docs/agent-metaverse-model.md §9`.
