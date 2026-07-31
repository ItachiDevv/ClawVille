# Position uplink and agent-connection design opinion

Scope: read-only review of commit `50106259f81bc13dbf82db536169e4b9374a8b3b` on local branch `staging`. The checkout matches the founder's stated SHA. Local tracking metadata now reports six newer `origin/staging` commits; I did not pull because this review was explicitly pinned to `50106259`.

## 1. Issue 1 — world position uplink

### Verdict

Make a dedicated WebSocket the permanent world-position uplink, keep SSE as the downlink for this pass, and keep `/join` plus `/leave` as HTTP. Ship motion-gating on the current HTTP effector immediately if the WS pass is not landing the same day. During rollout, retain a motion-gated HTTP fallback behind a kill switch; do not keep unconditional HTTP as the steady-state design.

Keep the pure reducer. Keep the `(world)` layout as the lifetime owner. Extract the imperative connection/timer/recovery code from the 488-line effect into a non-React controller owned by a small hook effect. The problem is not that a long-lived connection is started and stopped in `useEffect`; that is exactly what an effect is for. The problem is that one effect currently implements lifecycle ownership, SSE, sampling, serialization, HTTP, backoff, ticketed rejoin, and UI/store effects in one closure.

### Evidence

- `use-world-stream.ts:105-592` is one lifecycle effect. Its 200 ms interval is created at `:557`; `runMachineTick` only reads refs/store at `:400-410`.
- `world-stream-machine.ts:130-131` emits `UPLOAD_ACTIVE` on every active tick. `use-world-stream.ts:319-340` computes a motion epsilon only to choose `idle` versus `walking`; it always serializes and POSTs.
- Every POST is cross-origin JSON with credentials and `keepalive` (`use-world-stream.ts:301-317`), so the browser pays a request plus a non-simple-request preflight.
- The reducer already isolates the valuable contracts: cold Cove does nothing, remote is 10 seconds, uploads suspend during bounded recovery, and supersession is terminal (`world-stream-machine.test.ts:26-136`).
- Ownership is already correct: `(world)/layout.tsx:10-14` mounts `WorldPresence` above both routes; `WorldPresence.tsx:9-17` changes policy without remounting the owner.
- The server accepts no faster than 10 Hz (`world.ts:243-247`) and removes players after 30 seconds without an accepted update (`room-registry.ts:555-565`). Remote presence already proves a 10-second application keepalive is valid.
- The repo already has the required Bun/Hono WS substrate: the singleton adapter is `bun-ws-adapter.ts:18-26`; the activity upgrade/auth/adapter pattern is `activities.ts:578-688`; its hub validates frames and maintains per-connection state (`activity-ws-hub.ts:127-169,350-404`).

### Transport design

1. Add a dedicated endpoint such as `GET /api/world/:roomId/ws`. Reuse `getBunWebSocketHelper()` and the activity route's WeakMap adapter pattern, but create a `WorldPresenceWsHub`; do not put world semantics into `ActivityWsHub`.
2. `/join` remains the membership bootstrap and recovery-ticket issuer. After a successful join, the client opens one world uplink socket bound server-side to the resolved Lucia session or guest fingerprint and the joined room.
3. Keep SSE unchanged for snapshots, land events, and its tested reconnect behavior. Combining SSE and the uplink into one bidirectional WS would enlarge the failure domain and rewrite the downlink for no benefit to this incident.
4. Keep `/position` temporarily for old clients and fallback. Exactly one effector is active per client: WS or HTTP, never both. After bounded WS connect/reconnect failures, fallback sends motion-gated HTTP; a recovered WS disables fallback before its first send.
5. Keep the `pagehide` `/leave` keepalive fetch. A WS close is not a reliable unload notification, and this one-off POST is not the reported hot path.
6. Validate `Origin` on upgrade. Resolve identity from the upgrade context/cookie and the global fingerprint middleware, never from a client-supplied session ID. Bind the socket to the room membership established by `/join`.
7. Preserve abuse bounds with a 10 Hz per-session limiter shared across reconnects/sockets, a per-IP upgrade limiter, one live socket per presence, a small maximum frame size, Zod validation, malformed-frame strikes, and a concurrent guest cap keyed by fingerprint/IP. A per-connection limiter alone is insufficient because reconnecting would reset it.

Cloudflare is not a reason to retain hot HTTP: activities already demonstrate WS through the same infrastructure. The HTTP fallback is a rollout/edge-network safety valve, not the architecture.

### Correct React/client shape

- `WorldPresence` in `(world)/layout.tsx` remains the sole owner. This is what preserves `/game` ↔ `/cove` continuity and cold-Cove behavior.
- `useWorldStream(policy)` becomes a thin adapter: create one `WorldPresenceController`, start/stop it in one effect, and update policy through a method/ref in a separate tiny effect. The controller owns SSE, WS, timers, reducer state, ticket refs, and effect execution.
- Do not use a module-global singleton. It would leak identity and timers across HMR/tests, complicate SSR/multiple roots, and make cold `/cove` semantics implicit. A route-layout-scoped controller gives the desired persistence without process-global lifetime.
- Do not sample in `useFrame` or add movement work to the 3D loop. `avatarPositionRef` is already the zero-render bridge. A 5 Hz sampler outside the renderer catches keyboard, joystick, warp, physics, and correction movement uniformly.
- Keep the 200 ms scheduler. It is an appropriate maximum-send clock and already drives bootstrap/recovery. Change the machine inputs/state so `decide()` emits an active upload only for changed pose, the one terminal-idle transition, or an idle keepalive. Keep those decisions in the pure machine so cadence remains deterministic and contract-tested.

The founder's distrust is warranted about the effect's size and responsibility mix, not about effect lifecycle ownership. Replacing it with a module singleton or render-loop callback would be a worse ownership model.

### Cadence and payload

| State | Cadence | Wire content |
|---|---:|---|
| Moving on `/game` | At most 5 Hz; first changed sample sends immediately | Full absolute `{x,y,dirZ,activity:'walking'}` |
| Movement stops | One final sample within 200 ms | Full absolute pose with `activity:'idle'` |
| Idle on `/game` | Every 10 seconds | Full absolute idle pose/keepalive |
| Persistent remote `/cove` | Keep existing 10 seconds | Frozen full pose with `AT_COVE_ACTIVITY` |
| Explore/autonomous/recovering | No position upload | Control/recovery only |

Compare against the last **sent** pose, not merely the previous sample. Use the existing 0.5 px positional epsilon and a small heading epsilon; a meaningful heading-only change may send. An activity transition always sends.

Suppress unchanged positions, but do not delta-encode coordinates. Full absolute frames are tiny, reconnect-safe, easy to inspect, and avoid drift/state coupling. Delta encoding saves tens of bytes after the design has already removed nearly all idle traffic; it is negative-value complexity. No agent `PROTOCOL_VERSION` change is involved.

### Recovery mapping

Use typed server control frames and private close codes together:

- `{type:'presence.error', code:'membership_lost'}` followed by close `4409` maps to the existing `POSITION_409` machine input: suspend uploads, then run the same bounded ticketed rejoin.
- `{type:'presence.error', code:'superseded'}` followed by a distinct private close maps directly to `SUPERSEDED`.
- A generic socket close first performs a bounded bare socket reopen against the same membership. Only a typed membership loss, or a reopen that confirms membership rejection, spends a scarce `/join`.
- The ticketed `/join` may still return HTTP 409 `presence_superseded`; retain the current terminal path.

The control frame is authoritative because proxies may rewrite a close to `1006` and discard its reason. The close code is a fast fallback, not the only semantic channel. Dedupe both signals through the reducer/controller so one failure cannot start two rejoins. Uploads remain suspended until `RECOVERY_OK`.

### File-level change plan

- `apps/web/src/hooks/world-stream-machine.ts`: add changed/idle/keepalive scheduling state and transport-loss inputs; preserve bootstrap, recovery cap, suspension, and supersession.
- `apps/web/src/hooks/world-stream-machine.test.ts`: expand the cadence and recovery matrix.
- New `apps/web/src/lib/world-presence-controller.ts`: own SSE, WS/HTTP effectors, timers, ticketed recovery, and unload cleanup.
- `apps/web/src/hooks/use-world-stream.ts`: reduce to route-scoped controller lifecycle plus store callbacks.
- New `apps/api/src/services/world-presence-ws-hub.ts`: auth/binding, schemas, rate limits, membership errors, duplicate-socket policy, and cleanup.
- `apps/api/src/routes/world.ts`: add the upgrade route and share the existing position schema/apply function between HTTP and WS. Keep `/position` during rollout.
- `apps/api/src/lib/bun-ws-adapter.ts`: reuse unchanged unless a generic adapter type extraction is needed; do not create a second `createBunWebSocket()` pair.
- A world-specific shared frame type may live under `packages/shared`; it must not touch the agent protocol version.
- `apps/web/scripts/world-stage-probe.mjs`: teach the route fixture to accept/count the uplink WS and assert one persistent socket, zero cold-Cove sockets, and zero route-correlated reopens.

### Tests and rollout gates

Unit/contract gates:

- Machine: still avatar produces no 5 Hz sends; movement sends immediately then ≤5 Hz; stopping sends exactly one idle transition; idle and remote keepalive at 10 seconds; heading/activity changes send; explore/autonomous/recovery suppress sends.
- Preserve the existing cold-Cove, remote cadence, `POSITION_409`, three-attempt recovery cap, suspension, and terminal `SUPERSEDED` tests byte-for-byte in intent.
- Hub: Lucia and guest identity, origin rejection, room membership, one socket/session, 10 Hz cap across reconnects, schema/size rejection, membership-lost and superseded signals, and cleanup.
- Controller with fake timers/socket: no send before open, no WS+HTTP overlap, bare reconnect before ticketed rejoin, close/control dedupe, policy changes without recreation, and `pagehide` leave.

End-to-end gates:

- Run P1c `routes`, `soak` crossings, `soak --dwell=game`, `soak --dwell=cove`, and `retry-adoption`. Existing critical assertions are cold Cove zero joins, first game one join/stream, and no route-correlated reopen (`world-stage-probe.mjs:1769-1785`); add the equivalent socket assertions.
- Two-browser staging tests: movement replication, idle animation transition, 3+ minute idle survival, `/game` ↔ `/cove`, API restart with sticky-room recovery, transient network loss without `/join` churn, and newer-tab supersession.
- Network acceptance: idle `/game` has zero `/position` POST/OPTIONS and one WS; movement is ≤5 position frames/sec; Cove is ≤1 application update/10 sec; 60 crossings create no extra WS/SSE.
- Iris Xe gate: unchanged 3D frame work/allocation profile and no new `useFrame` subscriber. Soak listener/socket counts plateau.

Roll out behind `world_position_ws`: server accepts both first; enable a small staging cohort; promote with HTTP fallback; then disable automatic fallback after soak. Watch WS upgrade failures, abnormal closes, membership-loss rate, `/join` rate, stale kicks, duplicate sockets, fallback activations, and position frame rate.

Most likely regressions are dual effectors, socket recreation on route changes, guest identity drift at upgrade, proxy-lost close semantics, transient disconnects exhausting `/join`, missing terminal-idle animation, background-tab timer clamping causing a stale kick, and an unload path that omits `/leave`.

### What I would not do

- I would not leave unconditional 5 Hz HTTP in place. Even if preflight caching improves, per-request HTTP remains the wrong hot-path shape.
- I would not make motion-gated HTTP the permanent answer. It fixes idle spam but moving players still pay repeated cross-origin requests.
- I would not move sampling into the render loop or input handlers. The former violates the Iris budget; the latter misses warp/physics/non-keyboard movement.
- I would not replace the route-scoped owner with a module singleton.
- I would not merge SSE downlink into WS in this pass.
- I would not use deltas, binary frames, or compression for this payload.
- I would not rely only on a WS close reason for the 409-equivalent.

## 2. Issue 2 — “Connect Your Agent” for a logged-in bound account

### Verdict

Choose **(c): correct the surfaces now, then split the classifier contract in a focused follow-up**. Do not collapse `external-active`, `external-idle`, and `external-expired` server-side. Those are runtime-liveness states; the founder's law is an account-binding state. The current defect is using one axis as the other.

For an authenticated non-guest with an avatar and an external bot row, `external-idle` and `external-expired` are **bound/connected** for account UI. They must never produce first-time “Connect Your Agent” language. `none` and `provisioning-pending` remain unbound/incomplete; `dismissed` remains a presentation suppression.

Same-day surface fix:

- Add one pure web selector for “bound account agent”: `hosted | external-active | external-idle | external-expired`.
- `game/page.tsx` uses that selector in `NanoClawBanner`; idle/expired render the connected treatment, not the reconnect CTA.
- `agent-connect-modal.tsx` uses the same selector for its top-level connected/manage surface. Otherwise clicking the newly green banner would still open the connect flow because the Zustand `agentConnected` flag was cleared.
- Preserve runtime detail inside the manage surface: “idle” or “external credential expired” may be shown diagnostically, but there is no reconnect CTA for the logged-in human.

Follow-up contract:

- Add two orthogonal, non-breaking fields to `/me/agent-session`, e.g. `binding: 'bound'|'unbound'|'provisioning'` and `runtime: 'hosted'|'active'|'idle'|'expired'|'unknown'`. Keep the current `mode` during migration.
- Split Zustand's ambiguous `agentConnected` into durable `agentBound` and operational `runtimeReachable`; retain `agentSessionId` as the only bearer capability.
- Banner, sidebar, control-mode labels, progression, and ownership UI read `agentBound`.
- Chat-as-agent reads `agentSessionId`. Hosted chat reads `runtime==='hosted'`.
- Cove's browser-driven autonomous relay reads `runtimeReachable` and remains server-enforced. Account binding must not promise that an external process can answer a relay.

### Consumer inventory

| Consumer | Current dependency | Required treatment |
|---|---|---|
| `game/page.tsx:415-470` | `connected` hydrates/clears global paired state | Ambiguous and high-impact. Migrate to binding vs reachability; do not blindly flip it in the hotfix. |
| `game/page.tsx:241-286` | Direct `mode` drives banner | Immediate fix: external idle/expired are bound-connected. |
| `agent-connect-modal.tsx:36-46,391-452` | Queries mode but top-level state uses global `agentConnected` | Immediate fix with the same bound selector; retain mode for runtime details/actions. |
| `avatar-chat-bar.tsx:71-104` | Requires the `hosted` distinction and a real bearer | Keep. It correctly separates hosted chat from “chat as external agent.” |
| `sidebar-menu.tsx:709-717,922-935` | Direct mode only for provisioning; global `agentConnected` for status | Migrate status to `agentBound`; keep provisioning mode. |
| `control-mode-toggle.tsx:13-43` | Already treats resolved non-guest + avatar as provisioned | This already implements the founder's account ≡ agent model and is evidence for the split. |
| `cove/blackjack/BlackjackModal.tsx:604-614,1762-1783` | Global `agentConnected` gates an actually reachable decision relay | This consumer relies on liveness. It must move to `runtimeReachable`, not durable binding. |
| `create-agent/personality/page.tsx` and `lib/auth-transition.ts` | Only invalidate `['agent-session']` | No semantic dependency. |
| `lib/api.ts:404-440` | Declares the mixed response | Add explicit fields and deprecate the overloaded meaning of `connected`/`mode`. |
| `agent-session-classify.ts:112-206` and its tests | Correctly distinguishes hosted, active, idle, expired | Preserve the distinctions; extend the output rather than collapsing it. |

Server-side reclassification based on “a live Lucia session exists” is structurally wrong because `/me/agent-session` already requires Lucia auth (`auth.ts:125`). That condition is true for every successful call and would erase runtime information from every consumer.

Test the full matrix: logged-out, guest, non-guest/no avatar, provisioning pending, hosted, external active, external idle (>300 seconds), external expired, and dismissed. Assert that every authenticated bound case has no connect/reconnect CTA; idle/expired runtime labels remain available; hosted chat never asks for a bearer; and the Cove relay remains disabled or degrades truthfully when an external runtime is unreachable.

## 3. Sizing and ship split

| Piece | Rough change size | Risk | Ship timing |
|---|---:|---|---|
| HTTP motion gate + terminal idle + machine tests | 40–70 production LOC, 70–120 test LOC | Low–medium | Same day; immediate containment |
| Issue 2 banner + modal bound selector/tests | 25–50 production LOC, 50–90 test LOC | Low | Same day |
| Issue 2 API/store two-axis migration | 90–160 production LOC, 100–180 test LOC across consumers | Medium | Focused follow-up; can follow the surface fix immediately |
| World WS server hub/route/shared frames | 220–350 production LOC, 180–300 test LOC | Medium–high | Own pass |
| Client presence controller + WS/fallback integration | 180–300 new/moved production LOC, 180–300 test LOC | Medium–high | Same WS pass |
| P1c WS fixture/instrumentation and staging probes | 60–120 LOC plus soak artifacts | Medium | Required before WS promotion |

Same-day recommendation: land the Issue 2 surface correction and the HTTP motion gate. The durable WS/controller work is roughly 700–1,100 touched/new lines including tests and probe support; it deserves its own gated pass because it carries P1c recovery and route-persistence risk. Do not rush that pass by deleting SSE, recovery tickets, HTTP fallback, or the pure machine.

## Execution ledger (2026-07-31)

Both waves implemented on branch `feat/world-presence-ws` (local only; staging frozen for founder testing at execution time). Pipeline: two Opus-5-MAX frozen specs (server 2.1, client rev 2) -> two Codex gpt-5.6-sol adversarial critiques (both REJECT; 13 blockers total, all repo-evidenced) -> revision -> orchestrator seam ledger D1-D18 -> Codex implementation, orchestrator re-ran every gate personally.

- **Server wave (`75c89275` + shared-type fix `5d70aff9`):** hub/route/shared-wire/guest-cookie/identity-resolver/position-apply/smoke-harness. Gates: shared build 0 - api tsc 0 - 56/56 new tests (6 files) - isolated runner failures byte-identical to clean HEAD (stash comparison). DEFERRED: live localhost smoke (`apps/api/scripts/world-ws-smoke.ts`) — needs a real API+DB boot; local boot would side-effect the staging DB mid-freeze. Runs at freeze-lift, before promotion.
- **Client wave:** controller extraction (1,019 LOC + 733 test), machine transport states, hook adapter, probe uplink fixture. Gates: web tsc 0 (492 files) - 50/50 new machine+controller tests - existing 10 machine tests byte-identical (zero removed lines) - web prod build 0. DEFERRED: P1c probe lanes (routes http/ws, refuse soak) — double-blocked environmentally at execution time: fixture port :4000 contended by a concurrent session's P4 probes, AND headless world boot failing box-wide (baseline control at HEAD without this diff fails identically, so not a regression of this diff). Lanes are REQUIRED before staging promotion; run on a quiet box at freeze-lift.

### Amended-seam record (binding wire deltas vs the design above)

- **`socket_replaced` replaces scope-discriminated `superseded` (ledger D3-REVISED, critique B1):** same-session socket replacement is `{type:'presence.error', code:'socket_replaced'}` + close 4410 — NOT terminal, no rejoin; the client latches to HTTP with the advertisement cleared. `superseded` (close 4411) is RESERVED for terminal presence takeover and is never emitted this pass; the real terminal path stays ticketed `/join` HTTP 409 `presence_superseded`. The client's transport-loss type structurally cannot map a socket signal to terminal SUPERSEDED.
- **Two-way ping/pong with pong-refreshed liveness (ledger D7-REVERSED, critique B5):** `presence.ping` every 25s; the client MUST answer `presence.pong` from `onmessage` (not timer-throttled in background tabs); the hub reaps sockets missing a 70s pong deadline and refreshes registry membership via `touchPresence` (pose untouched). HTTP-fallback clients keep the 30s pose-staleness kick.
- **Guest binding cookie (ledger D9/D15):** `/join` mints a SESSION-SCOPED (no maxAge) HttpOnly cookie; `/join`, `/position`, `/leave`, and the upgrade resolve guests through it (browser WS handshakes cannot carry `X-CV-Fingerprint`).
- **Membership-class upgrade failures complete the upgrade and signal via control frame + 4409 (ledger D10):** browsers cannot read handshake bodies; HTTP-level rejection only for origin/rate/flag-off/IP-cap. `room_mismatch` is cut from the wire.
- **No live flag drain (ledger D11):** env flips reach the process only via restart; rollback = restart -> 4413 drain -> reopen 503 -> fallback ladder. 4412 reserved (FU-4).

## Follow-ups

- **FU-1 — Hatcher controlled-launch suppression TTL.** `refreshHumanControlledOpenClawForUser` defaults to 3,000ms and assumes the owner's former 5 Hz `/api/world/position` cadence. Motion-gated idle uploads run every 10s, so suppression can lapse between uploads. Deliberately unchanged in the WS diff: no smuggled Hatcher behavior change. Owner: world-presence + agent-protocol-partner. Review by 2026-08-31.
- **FU-2 — Automatic browser HTTP fallback graduation.** The `/position` endpoint remains indefinitely for old/headless clients and connected agents. Only the browser's automatic fallback is rollout-scoped. Disable it only after seven production days with the flag ON, abnormal closes below 2%, `/join` no higher than flag-OFF baseline, pong-timeout reaps below 1%, and WS-capable browser `/position` volume near zero. Review by 2026-09-15.
- **FU-3 — Recovery exhausted leaves uploads dead for the mount.** The existing client stops after three ticketed recovery attempts. This predates the WS transport and remains out of scope, but needs a focused recovery-policy fix.
- **FU-4 — Runtime-reloadable transport config.** `transport_disabled` and close 4412 are reserved but never emitted because env changes reach the process only through restart. Emitting them requires a runtime-reloadable config source. Review by 2026-09-15.
- **FU-5 — Single-pod assumption.** One-socket-per-session, the shared 10 Hz map, and per-IP reservations are process-local, like `RoomRegistry` and `ActivityWsHub`. Horizontal API scaling requires moving all three to shared state.
