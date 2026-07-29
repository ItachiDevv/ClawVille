# Codex Audit — Agent Connect/Signup Flow, Skill Install, and Controlled-Mode Handoff

**Date:** 2026-07-21
**Checkout audited:** `C:/Users/itachi/Documents/Crypto/cv-audit`, detached at prod HEAD `ac12da229934365ffa545aedbce5165dd824093a`
**Mode:** Read-only Codex trace (`gpt-5.6-sol`, `sandbox: read-only`, no files modified)
**Founder concern audited (#2):** does Connect (a) install skill/manual files for the agent, and (b) return the human owner a Controlled-play link; and what is the timing between agent connect and autonomous action vs. a human-takeover grace window?

---

Audit scope: checkout HEAD `ac12da229934365ffa545aedbce5165dd824093a`. No files were modified.

## (A) Actual flow as shipped

### 1. External agent connects

There is no `apps/api/src/routes/agent.ts` at this revision. The canonical endpoint is mounted from `agent-gateway.ts`:

- `agentGatewayRoutes` is mounted at `/api/agent`: `apps/api/src/index.ts:53`, `apps/api/src/index.ts:329`.
- The unified handler is `POST /api/agent/connect`: `apps/api/src/routes/agent-gateway.ts:331`.
- The legacy endpoint remains mounted at `/api/openclaw`: `apps/api/src/index.ts:18`, `apps/api/src/index.ts:317`.

The unified flow is:

1. Validate the request. A connection token, `agentId`, or `miladyAgentId` is sufficient; owner-proving credentials such as `identityKey` are optional: `apps/api/src/routes/agent-gateway.ts:254-329`.
2. Resolve requested autonomy mode through `resolveAutonomyMode`: `apps/api/src/routes/agent-gateway.ts:469-479`, `apps/api/src/services/agent-session-config.ts:814-831`.
3. Mint the bearer `sessionId`, create/update the `openclaw_bots` row, and apply any resolved owner binding: `apps/api/src/routes/agent-gateway.ts:481-501`, `apps/api/src/routes/agent-gateway.ts:588-749`.
4. Ensure the agent-scoped wallet, but retain only its public address here: `apps/api/src/routes/agent-gateway.ts:791-802`.
5. Immediately register the live body with `npcSimulation.registerAgentBot(...)`: `apps/api/src/routes/agent-gateway.ts:804-910`.
6. Best-effort mint the human control ticket: `apps/api/src/routes/agent-gateway.ts:945-969`. The helper is `mintSessionTicketFromConnect`: `apps/api/src/routes/agent-gateway.ts:1853-1926`.
7. Build `ownedSkills`, `gameTools`, protocol pointer, and inline orientation: `apps/api/src/routes/agent-gateway.ts:1111-1171`, `apps/api/src/routes/agent-gateway.ts:1182-1196`.

The exact top-level success shape is:

```ts
{
  agentId,
  sessionId,
  uuid,
  isReturning,
  totalSessions,
  knowledge,
  ownedSkills,
  gameTools,
  protocol,
  identityType,
  autonomyMode,
  cognition,
  walletAddress,
  sessionExpiresAt,
  orientation,
  identityMismatch?, // conditional
  sessionTicket?,    // conditional
  identity?,         // conditional
  wallet?            // conditional
}
```

Evidence: `apps/api/src/routes/agent-gateway.ts:1173-1201`.

Important variants:

- A bare `agentId` connect can succeed without a resolvable owner. In that case ticket resolution returns `ticket:null`, so `sessionTicket` is omitted: `apps/api/src/routes/agent-gateway.ts:1878-1880`, `apps/api/src/routes/agent-gateway.ts:1923-1925`.
- With a resolvable identity but no pre-existing avatar, the ticket can be minted with `avatarId:null`; the helper only looks up an existing avatar and does not provision one: `apps/api/src/routes/agent-gateway.ts:1890-1920`.
- If an existing owner/avatar is known, the ticket is bound to that user/avatar: `apps/api/src/routes/agent-gateway.ts:1870-1874`, `apps/api/src/routes/agent-gateway.ts:1907-1920`.

The human ticket shape is exactly:

```ts
{
  ticket,
  url,
  expiresAt,
  instruction
}
```

`apps/api/src/services/session-ticket-service.ts:92-97`, `apps/api/src/services/session-ticket-service.ts:158-163`.

The URL is constructed as:

```ts
`${webOrigin}/enter?t=${encodeURIComponent(ticket)}`
```

`apps/api/src/services/session-ticket-service.ts:146-147`.

Its instruction explicitly tells the agent to give it to the human for Controlled play and says the human can later toggle Autonomous: `apps/api/src/services/session-ticket-service.ts:149-156`.

Ticket redemption:

- Atomically consumes the one-use ticket: `apps/api/src/routes/auth.ts:913-938`, `apps/api/src/services/session-ticket-service.ts:189-221`.
- Creates the Lucia login session/cookie: `apps/api/src/routes/auth.ts:941-953`.
- Safely binds the external bot to the owner without overwriting a different owner: `apps/api/src/routes/auth.ts:955-996`.
- Redirects an avatar-bound owner to `/game`, but an avatarless owner to `/create-agent?from=agent-link`: `apps/api/src/routes/auth.ts:1008-1016`.

Therefore, the owner-control link is shipped, but "immediately play the same avatar" only holds when the owner already has an avatar. Fresh identity onboarding takes a creation detour while the external body has already been registered.

A live agent can request a replacement link through `POST /api/agent/:sessionId/control-link`; its exact response is:

```ts
{
  url: minted.url,
  expiresAt: minted.expiresAt
}
```

`apps/api/src/routes/agent-gateway.ts:3724-3839`.

#### Legacy OpenClaw path

`POST /api/openclaw/register` still exists: `apps/api/src/routes/openclaw.ts:133-134`.

It creates/updates an `openclaw-bot` platform agent and immediately registers the body: `apps/api/src/routes/openclaw.ts:325-398`.

Its exact response is:

```ts
{
  botId,
  agentId,
  sessionId,
  mode,
  isReturning,
  totalSessions,
  knowledge,
  sessionExpiresAt,
  elizaAgentId
}
```

The identity portion is built at `apps/api/src/routes/openclaw.ts:262-271` and `apps/api/src/routes/openclaw.ts:300-309`; the final spread response is at `apps/api/src/routes/openclaw.ts:398`.

This legacy response has no `sessionTicket`, protocol pointer, `gameTools`, `ownedSkills`, wallet, or human control URL. Searching `sessionTicket|control-link|claimUrl|loginUrl|redirectUrl|/enter?t=` within `apps/api/src/routes/openclaw.ts` returned no matches.

### 2. Human email signup

`POST /api/auth/signup` accepts:

```ts
{
  email,
  password,
  name?,
  harness?: 'milady' | 'hermes' | 'openclaw'
}
```

`apps/api/src/routes/auth.ts:283-293`.

The route:

1. Creates the user and Lucia login cookie: `apps/api/src/routes/auth.ts:330-356`.
2. Calls `provisionAvatarAgentForSignup(...)` through a fail-soft wrapper: `apps/api/src/routes/auth.ts:358-372`.
3. Inserts a `platform_agents` row with `type:'avatar-agent'`, `status:'pending'`, harness/model configuration, plus the linked avatar in one transaction: `apps/api/src/services/avatar-agent-provisioning.ts:403-417`, `apps/api/src/services/avatar-agent-provisioning.ts:459-500`.
4. Creates the avatar wallet non-fatally: `apps/api/src/services/avatar-agent-provisioning.ts:561-580`.

Successful provisioning returns exactly:

```ts
{
  success: true,
  avatar: provisioned.avatar,
  agentId: provisioned.agentId,
  wallet?: provisioned.wallet
}
```

If provisioning throws, signup still returns only:

```ts
{ success: true }
```

`apps/api/src/routes/auth.ts:413-428`.

This provisioning creates records only. It does not start the ElizaOS runtime: `apps/api/src/routes/auth.ts:358-362`. Runtime startup is lazy on first use through `ensureAgentRuntime`: `apps/api/src/services/agent-orchestrator.ts:53-105`.

Plain email/password login returns only `{success:true}` and does not provision: `apps/api/src/routes/auth.ts:437-496`.

## (B) Gaps versus intended behavior

### Skill/manual installation and consumption

The unified Connect response advertises three knowledge surfaces:

- `protocol`
- `gameTools`
- `ownedSkills`

`apps/api/src/routes/agent-gateway.ts:1111-1201`.

`PROTOCOL_VERSION` is 31: `apps/api/src/services/skill-protocol.ts:313`.

The direct protocol pointer is:

```ts
{
  version,
  contentHash,
  url,
  manifestUrl,
  auth: 'X-Clawville-Agent-Session: <sessionId>',
  ackState
}
```

`apps/api/src/services/skill-protocol.ts:1490-1517`.

The manual tells external agents to fetch/re-fetch the protocol and install `ownedSkills` plus `gameTools`: `apps/api/src/services/skill-protocol.ts:480-497`, `apps/api/src/services/skill-protocol.ts:535-547`.

But the raw `/connect` operation does not fetch or install anything on the connecting process. It only returns pointers and instructions.

Protocol acknowledgement is also informational, not an action/auth gate: `apps/api/src/services/skill-protocol.ts:790-816`, `apps/api/src/services/skill-protocol.ts:1430-1433`, `apps/api/src/services/agent-session-ack.ts:198-204`. An external client can act without fetching or acknowledging v31.

One bundled client partially consumes the response:

- Hermes pairing persists `ownedSkills`/`gameTools` and immediately calls `sync_owned`: `integrations/hermes/scripts/clawville.py:318-353`, `integrations/hermes/scripts/clawville.py:402-432`.
- `sync_owned` fetches/writes the game tools, public `clawville-play` `SKILL.md`, and owned skill files: `integrations/hermes/scripts/clawville.py:501-541`.
- It does not persist or fetch the returned `protocol` pointer. Searching `protocol.url|protocol.manifestUrl|protocol.contentHash|protocol.version|/api/skills/protocol` in `integrations/hermes` found no production-client match.
- The documented `pair --self` branch calls `_pair_self(args)`, but no `_pair_self` definition exists. The only occurrence found by `rg "_pair_self" integrations/hermes` is the call at `integrations/hermes/scripts/clawville.py:300-303`.

Hosted avatar agents do receive the full manual, but later:

- After `runtime.start()`, the orchestrator fire-and-forgets protocol injection: `apps/api/src/services/agent-orchestrator.ts:208-245`.
- It builds the current manual and calls `runtime.injectProtocolKnowledge(...)`: `apps/api/src/services/agent-orchestrator.ts:252-271`.
- Eliza creates memory rows with `subtype:'protocol-knowledge'`: `packages/agent-runtime/src/eliza-runtime.ts:1083-1150`.
- The knowledge provider later retrieves those memories for prompts: `packages/agent-runtime/src/providers/knowledge.ts:103-119`, `packages/agent-runtime/src/providers/knowledge.ts:145-225`.

Because injection is non-awaited and fail-soft, the first hosted prompt/action can run before the manual memories finish writing.

`system-npc-seeder.ts` is not the hosted-agent injection hook. Searching it for `createMemory|protocol-knowledge|injectProtocolKnowledge` returned no matches. It seeds location/system-agent configuration instead: `apps/api/src/services/system-npc-seeder.ts:169-236`, `apps/api/src/services/system-npc-seeder.ts:334-404`.

**Verdict:** the unified response advertises manuals; generic consumption is not enforced. Hermes installs the entry/tools/owned files but ignores the authoritative protocol pointer. Hosted runtimes consume the protocol asynchronously after lazy startup.

### Human-facing Controlled-play link

Yes, it exists as `sessionTicket.url`, with a ten-minute default lifetime:

- Shape and URL: `apps/api/src/services/session-ticket-service.ts:92-97`, `apps/api/src/services/session-ticket-service.ts:146-163`.
- Default TTL is 600 seconds; `AGENT_SESSION_TICKET_TTL_SECONDS` is read from the environment and clamped to 60-3600 seconds: `apps/api/src/services/session-ticket-service.ts:22-40`.
- Unified response includes it conditionally: `apps/api/src/routes/agent-gateway.ts:1173-1201`.

However:

- Bare-identity connects can successfully omit it: `apps/api/src/routes/agent-gateway.ts:1878-1880`, `apps/api/src/routes/agent-gateway.ts:1923-1925`.
- Fresh owner identities without an avatar receive a link that redirects to avatar creation, not direct same-avatar play: `apps/api/src/routes/agent-gateway.ts:1890-1900`, `apps/api/src/routes/auth.ts:1008-1016`.
- The legacy `/api/openclaw/register` response contains no human link.
- Email signup contains no URL/link field. Searching the signup/auth route for `sessionTicket|playUrl|redirectUrl|controlLink|control-link` found no signup response match.

Where the unified link already lives is correct: `mintSessionTicketFromConnect` and `session-ticket-service`. The missing contract is that `/connect` does not require or explicitly report successful owner-handoff availability.

### Wallet secret returned exactly once

The invariant holds on the traced paths:

- Agent-level Connect wallet uses `ensureWallet` and returns only `walletAddress`: `apps/api/src/routes/agent-gateway.ts:791-802`, `apps/api/src/routes/agent-gateway.ts:1186`.
- Avatar wallet uses `ensureWalletWithFirstTimeSecret`; `wallet.secretKey` is included only when `firstTimeSecretKeyBase58` is present: `apps/api/src/routes/agent-gateway.ts:1048-1083`.
- Existing-wallet fast paths return only the public key: `apps/api/src/services/wallet-service.ts:219-265`.
- Only the winning fresh insert receives the secret: `apps/api/src/services/wallet-service.ts:268-283`, `apps/api/src/services/wallet-service.ts:316-326`.
- A concurrent insert loser re-reads only the winner's public key: `apps/api/src/services/wallet-service.ts:284-313`.
- Reconnect explicitly returns no secret: `apps/api/src/routes/agent-gateway.ts:1483-1493`.
- Signup applies the same conditional disclosure: `apps/api/src/services/avatar-agent-provisioning.ts:561-580`, `apps/api/src/services/avatar-agent-provisioning.ts:598-603`.

`identity.secretKey`, when present in a first-connect response, is the identity keypair disclosure, not `wallet.secretKey`: `apps/api/src/routes/agent-gateway.ts:981-1045`.

## (C) Timing and race audit

### What starts acting after `/connect`?

`/connect` does not call `agentAutonomyDriver`, `activateAutonomyForOwner`, or `ensureAgentRuntime`. The body is registered directly into `npcSimulation`: `apps/api/src/routes/agent-gateway.ts:804-910`.

For `server-managed` mode:

- New bodies start with `behaviorCooldown:30`: `apps/api/src/services/npc-simulation.ts:1055-1079`.
- Simulation ticks every 200 ms: `apps/api/src/services/npc-simulation.ts:533-545`.
- The planner decrements that cooldown and evaluates unsuppressed server-managed agents: `apps/api/src/services/npc-simulation.ts:2412-2422`.

Therefore, a fresh server-managed body becomes eligible for its first ambient behavior after approximately six seconds. This is a generic NPC cooldown, not an owner-claim grace period.

For `self-managed` mode, the NPC planner skips it: `apps/api/src/services/npc-simulation.ts:2412-2421`. Its external client must drive it through the action endpoints.

The separate hosted Autonomous toggle is more aggressive:

- `/api/world/autonomy` invokes activation/deactivation: `apps/api/src/routes/world.ts:465-536`.
- Activation registers/enrolls the hosted agent and calls the driver kick immediately: `apps/api/src/services/agent-autonomy-activation.ts:193-233`.
- `driveAgentNow` warms the runtime and calls `runtime.decide(...)`: `apps/api/src/services/agent-autonomy-driver.ts:615-669`.
- The background interval is 30 seconds: `apps/api/src/services/agent-autonomy-driver.ts:165`, `apps/api/src/services/agent-autonomy-driver.ts:765-771`.

### Grace period before autonomy

**No owner-claim grace exists.**

Searched the Connect handler, session config, activation service, autonomy driver, NPC simulation, game store, and heartbeat hook for `grace`, `holdoff`, `defer`, `delay`, `pause` combined with claim/ticket/autonomy. No owner-handoff grace or pending-claim gate was found.

The ten-minute ticket TTL only controls how long the login URL remains redeemable: `apps/api/src/services/session-ticket-service.ts:22-40`. It does not suppress the already-registered agent body.

### Human takeover path and races

The magic-link redemption itself does not mark the agent human-controlled. It authenticates/binds and redirects: `apps/api/src/routes/auth.ts:913-1016`.

Client takeover proceeds later:

1. Zustand defaults to `controlMode:'explore'`: `apps/web/src/stores/game.ts:656-660`.
2. `/game` promotes an authenticated avatar into `player`/Controlled mode: `apps/web/src/app/game/page.tsx:503-546`.
3. The heartbeat hook detects `player` mode within its one-second poll and sends immediately, then every ten seconds: `apps/web/src/hooks/use-avatar-heartbeat.ts:19-35`, `apps/web/src/hooks/use-avatar-heartbeat.ts:50-55`, `apps/web/src/hooks/use-avatar-heartbeat.ts:76-94`.
4. The API asynchronously finds the latest live bound bot and marks it human-controlled for 15 seconds: `apps/api/src/routes/avatars.ts:1556-1580`.

Thus there is a real link-click -> hydration -> mode promotion -> heartbeat -> database lookup window before suppression takes effect.

Once marked:

- `markHumanControlledOpenClaw` sets a deadline and clears the current path/destination/walking activity: `apps/api/src/services/npc-simulation.ts:717-738`.
- The NPC planner skips human-controlled agents: `apps/api/src/services/npc-simulation.ts:2412-2421`.
- Movement integration skips them: `apps/api/src/services/npc-simulation.ts:2801-2805`.
- Hatcher action dispatch performs a late suppression check before executing generated actions: `apps/api/src/services/npc-simulation.ts:1699-1707`.

This is check-based suppression, not an atomic avatar-control lock. It does not cancel an already-running model call. Driver unregister explicitly preserves `inFlight`/warming state because underlying work is non-cancellable: `apps/api/src/services/agent-autonomy-driver.ts:531-545`.

More seriously, **the external REST action surface bypasses the suppression lease**:

- `resolveSession` validates session/body lifetime but does not call `isAgentHumanControlled`: `apps/api/src/routes/agent-gateway.ts:2221-2252`.
- `/move`, `/chat`, `/visit-building`, `/building/:buildingId/chat`, `/combat-action`, and `/emote` then mutate state: `apps/api/src/routes/agent-gateway.ts:2286-2921`.
- Searching `isAgentHumanControlled|humanControlled|human_controlled` in `agent-gateway.ts` found only status/SSE reporting at `apps/api/src/routes/agent-gateway.ts:1631`, `apps/api/src/routes/agent-gateway.ts:3519-3552`, and `apps/api/src/routes/agent-gateway.ts:3711`; no action-handler enforcement was found.

Consequently:

- Before the first human heartbeat, autonomous and human inputs can race.
- After suppression, internal NPC planning and late Hatcher dispatch are blocked.
- A self-managed or stale external client can still call the REST mutations during Controlled mode. There is no shared lock preventing it from moving, chatting, fighting, or earning concurrently with the human.

### Reverse handoff

**Controlled -> Autonomous:**

- The client starts `postAutonomy(true)` and changes local mode asynchronously: `apps/web/src/stores/game.ts:704-768`, `apps/web/src/stores/game.ts:777-800`.
- Server activation releases the human-control suppression, enrolls the agent, then kicks the driver: `apps/api/src/services/agent-autonomy-activation.ts:193-233`.

There is no intentional grace. During request latency, the browser can already stop local control while the server still holds the old suppression mark, producing a short neither-driven interval. Once activation reaches the server, it releases suppression and kicks immediately.

**Autonomous -> Controlled:**

- The client remounts the local avatar immediately and sends `postAutonomy(false)` fire-and-forget: `apps/web/src/stores/game.ts:770-785`.
- Server deactivation clears the durable flag, unregisters the driver, then marks the agent human-controlled: `apps/api/src/services/agent-autonomy-activation.ts:261-290`.

This creates a network/database-latency overlap window where the human is locally active while server autonomy can still be running. An in-flight decision is non-cancellable, although the later NPC dispatch suppression check can discard it if the mark has arrived by dispatch time.

If the human simply closes or backgrounds the Controlled tab, heartbeats stop. The suppression then lapses within 15 seconds by design: `apps/web/src/hooks/use-avatar-heartbeat.ts:19-35`, `apps/api/src/routes/avatars.ts:1437-1444`. During the remaining lease the absent human is not driving and the agent remains suppressed; afterward the agent body becomes eligible again.

**Verdict:** the handoff is neither atomic nor race-free. It relies on eventually consistent heartbeats and multiple late checks, and the direct external action API bypasses those checks entirely.

## (D) Email-signup path

Successful signup now provisions:

- A hosted-harness avatar.
- A linked `platform_agents` record.
- A custodial wallet.
- Initial orientation knowledge in the character configuration.

Evidence: `apps/api/src/services/avatar-agent-provisioning.ts:212-253`, `apps/api/src/services/avatar-agent-provisioning.ts:403-500`, `apps/api/src/services/avatar-agent-provisioning.ts:561-603`.

Default harness is Milady when omitted; the web form offers Milady, Hermes, or OpenClaw: `apps/api/src/services/avatar-agent-provisioning.ts:359-389`, `apps/web/src/app/login/page.tsx:68-71`.

Despite the database row having `status:'pending'`, normal successful signup is classified as hosted:

```ts
{
  connected: true,
  mode: 'hosted',
  agentId,
  harness,
  expiresAt: null,
  lastSeenAt: null
}
```

`apps/api/src/services/agent-session-classify.ts:30-50`, `apps/api/src/services/agent-session-classify.ts:235-240`.

It is not yet a running agent at signup time. Runtime startup is lazy, and the full protocol injection happens after runtime start: `apps/api/src/routes/auth.ts:358-362`, `apps/api/src/services/agent-orchestrator.ts:53-105`, `apps/api/src/services/agent-orchestrator.ts:208-271`.

The old transitional state still exists on failure. `runProvisioningFailSoft` catches any provisioning error and returns `null`: `apps/api/src/services/avatar-agent-provisioning.ts:300-315`. Signup still returns HTTP success without `avatar` or `agentId`, after which `/me/agent-session` can report:

```ts
{
  connected: false,
  reason: 'no_bot',
  mode: 'provisioning-pending',
  hasAvatar
}
```

`apps/api/src/routes/auth.ts:178-205`, `apps/api/src/routes/auth.ts:237-242`.

So the answer is:

- Normal successful signup implements the account/agent/avatar record model.
- It does not immediately start a hosted runtime.
- Provisioning failure still silently falls into `agent-provisioning-pending`, contradicting strict atomic `account = agent = avatar`.

The signup API response contains no play/control link or next URL. The web client hardcodes the next step:

- Store the one-time wallet disclosure in `sessionStorage`: `apps/web/src/app/login/page.tsx:160-188`.
- Navigate to `/create-agent`: `apps/web/src/app/login/page.tsx:189-196`.
- The existing provisioned avatar is customized, then the client routes to `/game`: `apps/web/src/app/create-agent/personality/page.tsx:332-364`.
- `/game` promotes an authenticated avatar to `player` mode: `apps/web/src/app/game/page.tsx:503-546`.

Thus browser signup has a clear customize -> game -> Controlled path, but programmatic signup gets no explicit `nextUrl`, `controlLink`, or `sessionTicket`.

## (E) Ranked recommendations

| Rank | Severity | Effort | Recommendation |
|---|---:|---:|---|
| 1 | Critical | Low-medium | Enforce `humanControlled` in the common external action authorization path, ideally `resolveSession`, covering move/chat/visit/building tools/combat/emote. Current routes bypass suppression: `agent-gateway.ts:2221-2921`. |
| 2 | Critical | Medium | Replace heartbeat-only takeover with an authoritative control lease acquired during `/api/auth/enter` or game-session establishment. Use the same lease in NPC planning, the autonomy driver, and external REST actions. Current first mark is delayed until `avatars.ts:1556-1580`. |
| 3 | High | Medium | Add an in-flight generation/epoch fence so a decision started before takeover cannot commit afterward. `unregisterUserAgent` currently acknowledges work is non-cancellable: `agent-autonomy-driver.ts:531-545`. |
| 4 | High | Medium | Make owner handoff a defined Connect state: require a resolvable owner credential for fresh Connect, or return an explicit `controlLinkStatus` with a recovery action. Do not silently omit `sessionTicket`: `agent-gateway.ts:945-969`, `agent-gateway.ts:1853-1926`. |
| 5 | High | Medium | For fresh identities, provision/link the avatar before registering an autonomous body, or route through the existing `/join` flow. Currently the human may land in `/create-agent` while a separate external body is already live: `agent-gateway.ts:804-910`, `auth.ts:1008-1016`. |
| 6 | High | Low | Introduce a bounded `pending-owner-claim`/manual-read gate before server-managed autonomy begins. The current ~6-second cooldown is generic behavior timing, not a grace contract: `npc-simulation.ts:533-545`, `npc-simulation.ts:1055-1079`. |
| 7 | High | Low | Make protocol readiness observable/enforced before action: require current-version ACK for external agents and await hosted protocol injection before first `processMessage`/`decide`. ACK and hosted injection are currently informational/fail-soft: `skill-protocol.ts:790-816`, `agent-orchestrator.ts:208-271`. |
| 8 | High | Very low | Repair or remove Hermes `pair --self`; it calls undefined `_pair_self`: `integrations/hermes/scripts/clawville.py:300-303`. |
| 9 | Medium | Low | Stop silently returning `{success:true}` when signup provisioning fails. Return explicit `agentProvisioning:'ready'|'pending'` plus a retry/next URL: `auth.ts:358-428`. |
| 10 | Medium | Low-medium | Retire `/api/openclaw/register` or delegate it to unified Connect. Its shipped response bypasses the protocol/tool/control-link contract: `openclaw.ts:262-309`, `openclaw.ts:398`. |

**The highest-risk shipped defect is not the absence of a control link — the unified path has one.** It is that ownership handoff is conditional and non-atomic, while external mutation endpoints do not honor the human-control suppression state.
