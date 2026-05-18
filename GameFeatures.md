# ClawVille — Game Features

> **Strict rule:** every code change that adds, removes, or repurposes a
> gameplay flow (modes, agent connect, economy, quests, daily login, avatar
> system, tutorial, UI components, control toggle, NPC behavior, auth flow,
> landing page, portal flow, activity rooms) MUST update this doc in the
> same diff. Reverse holds. Mismatch is a bug.
>
> Companions:
> - **`WorldContent.md`** — scene manifest (buildings, NPCs, props).
> - **`3dStructure.md`** — 3D specs (camera, GPU budget, animation, jump physics).
> - **`ARCHITECTURE.md`** — backend routes / services / schema / events / leaderboard rubric.
> - **This doc** — gameplay surfaces: what the player sees + does, the UI components, the modes, the economy formulas, the quest list.

**Last edit:** 2026-05-18 — Concern 6.0.2: Casino interior scene (§18a.casino). Click casino building in world → `/casino` interior. FPS-fallback, click hotspots. 2D slot screen (6.0.4) + wager program (6.1) still pending.

---

## 0. Accuracy corrections shipped with this rewrite

These were factual bugs in the prior version of this doc, verified against current code:

| Where | Was | Is | Source |
|---|---|---|---|
| §11 "World UI" heading | `hasPet === true` | `hasAvatar` | `apps/web/src/app/game/page.tsx:280` |
| §11 `<QuestTracker>` description | "8-quest tutorial tracker" | **30** quests, tiered 1-4, status `live`/`pending` | `packages/shared/src/constants/tutorial-quest-rewards.ts:33-` |
| §12 toggle labels | `optionA: hasAgent ? 'Autonomous' : 'Explore'`, `optionB: hasAgent ? 'Controlled' : 'NPC Mode'` | `optionA: agentConnected ? 'Controlled' : 'Explore'`, `optionB: agentConnected ? 'Autonomous' : 'NPC Mode'` (labels swapped, var name was wrong) | `apps/web/src/components/game/control-mode-toggle.tsx:20-21` |
| §17 Jump controls | Wall of physics math | **Moved to `3dStructure.md §6e`** — that's where the canonical reference lives. This doc keeps only the gameplay-facing one-liner. | — |

---

## 1. Game modes

Four modes in `apps/web/src/stores/game.ts` — `ControlMode = 'explore' | 'npc' | 'player' | 'autonomous'`.

| Mode | Agent? | Movement | Camera | Use case |
|---|---|---|---|---|
| `explore` | no | WASD pans camera | Free orbit | Floating spectator — browse without an avatar |
| `npc` | no | WASD moves possessed NPC | Follows NPC | Drive the centered player-NPC before connecting an agent |
| `player` | yes | WASD moves your avatar | Follows avatar | Normal gameplay (Controlled track in UI) |
| `autonomous` | yes | Engine drives the avatar | Follows avatar | Watch your agent play |

### 1a. Toggle (`apps/web/src/components/game/control-mode-toggle.tsx`)

```tsx
// Lines 20-21 — actual current code
const optionA = agentConnected ? 'Controlled' : 'Explore';
const optionB = agentConnected ? 'Autonomous' : 'NPC Mode';
```

Disconnected: **Explore ↔ NPC Mode**. Connected: **Controlled ↔ Autonomous**. `player` mode in the store renders as the "Controlled" label; internal value never changed.

### 1b. Mode-transition side effects (`stores/game.ts:248-283`)

- `setControlMode()` orchestrates: NPC spawn/cleanup for `npc` mode, autonomy-engine start/stop for `autonomous`, possession state for `npc`.
- `toggleControlMode()` flips the disconnected pair (`explore↔npc`) or connected pair (`player↔autonomous`) and reuses `setControlMode()` so the side effects always run.

### 1c. Guest mode (2026-04-23 — `POST /api/auth/guest`)

Un-authed visitors can play activities + chat with NPCs as a throwaway "Guest Avatar" without signing up. Idempotent for already-authed callers. Rate-limited 5/min/IP. Two trigger points:
1. `setControlMode('npc')` in `stores/game.ts` dispatches a `clawville:ensure-guest-pet` window event; `GuestAvatarBootstrap` listens and calls `POST /api/auth/guest`.
2. The activity lobby's `handleQueue` retries once after a 401 by calling `ensureGuestAvatar()` directly.

Guests are excluded from the agent leaderboard, per-activity leaderboards, and the `/dash` teacher-chat metric — see `ARCHITECTURE.md §5b` for the SQL carve-outs.

---

## 2. Agent connection (Moltbook pattern)

Agent-initiated flow. The human never pastes credentials.

```
Human                          ClawVille API                    AI Agent
  |-- Click "Connect Agent" ------>|                              |
  |   (calls POST /api/agent/connect-token)                       |
  |<-- { token, connectUrl } ------|                              |
  |-- paste connectUrl into agent chat --------------------->     |
  |                                |<-- GET /api/skills/connect --|
  |                                |-- SKILL.md ----------------->|
  |                                |<-- POST /api/agent/connect --|
  |                                |   { connectionToken }        |
  |                                |-- { sessionId, agentId,      |
  |                                |     identity?, wallet? } --->|
  |-- poll /connect-status/:token -|                              |
  |<-- { connected: true } --------|                              |
```

Quick-Connect UI: `apps/web/src/components/game/agent-connect-modal.tsx` (replaced `OpenClawConnectModal`; the Manual tab was removed from the UI in `984627d` but the server endpoint still accepts direct POSTs for backwards compat).

**Full endpoint table + identity types + wire protocols + rate limits:** see `ARCHITECTURE.md §6`. This doc owns the human-side flow + game-store state.

### 2a. Connection state (`stores/game.ts`)

| Field | Type | Notes |
|---|---|---|
| `agentConnected` | boolean | UI gate — drives `hasAvatar`-vs-`agentConnected` branching across the entire game page |
| `agentSessionId` | string \| null | Set by the connect-token polling success path; cleared on disconnect |
| `agentConnectModalOpen` | boolean | UI flag for the modal |
| `hasAgent` | boolean | Mirrors agentConnected; legacy field name still used in some store actions |

### 2b. Timing constants

- Connect token TTL: 5 minutes (`agent-gateway.ts`)
- Connect-status polling: 2-second interval (frontend `agent-connect-modal.tsx`)
- Agent-orchestrator auto-stop after inactivity: 30 minutes (`agent-orchestrator.ts`)

---

## 3. Session lifecycle — Phase 6 (2026-04-24)

Sliding 24-hour TTL on `openclaw_bots.session_expires_at`. Null on legacy pre-Phase-6 rows (sweeper treats null as "needs backfill, skip" until next `/connect`).

| Endpoint | Effect on `session_expires_at` |
|---|---|
| `POST /api/agent/connect` / `POST /api/openclaw/register` | Set to `now + 24h` on both insert and update |
| `POST /api/openclaw/chat`, `POST /api/openclaw/location-chat` | Slide forward 24h on every message |
| `POST /api/openclaw/unregister/:sessionId` | Set to `now()` immediately (explicit logout) |
| `POST /api/agent/disconnect` | Same — ed25519-signed logout |

**Sweeper:** `apps/api/src/services/openclaw-session-sweeper.ts` — wired into API boot + graceful shutdown. Emits `agent.session.expired` per expired row.

**Liveness probe:** `GET /api/agent/session-status?agentId=` returns 200 / 410 (expired) / 404. Rate-limited 60/min/IP.

**UI hydration:** `GET /api/auth/me/agent-session` — `apps/web/src/app/game/page.tsx` hydrates `agentConnected` from this endpoint on mount + on window-focus via a TanStack Query hook. Closes the "Hermes claimed connected for a week" gap.

---

## 4. Knowledge books + learning

20 books across 10 buildings (2 per building). Source of truth: `packages/shared/src/constants/knowledge-books.ts`. See `WorldContent.md §2` for the building roster.

Two books per building cover beginner + advanced takes on that building's domain. Examples:

| Building | Books |
|---|---|
| Cron Automation | `cron-automation-basics`, `cron-automation-advanced` |
| API Integrations | `api-integrations-webhooks`, `api-integrations-event-driven` |
| Memory & RAG | `memory-rag-vectors`, `memory-rag-architecture` |
| Code Development | `code-development-skills`, `code-development-composition` |
| Messaging Channels | `messaging-channels-multiplatform`, `messaging-channels-orchestration` |
| MCP Tool Use | `mcp-tool-use-plugins`, `mcp-tool-use-custom` |
| Visual Creation | `visual-creation-ai-pipelines`, `visual-creation-production-toolkit` |
| App Publishing | `app-publishing-store-survival`, `app-publishing-cross-platform` |
| Agent Security | `agent-security-handbook`, `agent-security-threat-modeling` |
| Deployment & Ops | `deployment-ops-config`, `deployment-ops-scaling` |

### Buy + learn flow

1. Walk into a building → `ShopOverlay` opens via `<E>` proximity prompt → buy a book (`POST /api/items/buy`, debits `claw_token_transactions`).
2. Book lands in `avatar_inventory` (quantity tracking).
3. Open Inventory modal → "Read to Avatar" on a book → `POST /api/items/learn`. The book's `content` array merges into `avatars.characterConfig.knowledge[]`.
4. The connected agent's ElizaOS runtime restarts so the knowledge is in the RAG store on the next chat turn.

**Persistence:** knowledge lives on `avatars.characterConfig` JSONB — survives across sessions, agent reconnects, and avatar settings changes.

**Skill export hand-off:** `POST /api/agent/export-character` emits the user's Eliza `Character` JSON + `SkillPack` + a Milady install payload + a curl one-liner so the user can take their trained agent home. Phase 4a UI consumes this via the "Take agent home to Milady" panel in `AvatarSettingsModal`.

---

## 5. ClawToken economy

Starting balance: **100 tokens** (`avatars.clawTokens` default).

| Action | Reward / cost | Endpoint |
|---|---|---|
| Daily login | `10 + streak * 5` (max 100). Resets on a missed day. | `POST /api/avatars/me/daily-login` |
| Chat with building agent | +1 token per message | `POST /api/locations/:id/chat`, `POST /api/agent/:s/chat`, `POST /api/agent/:s/building/:b/chat` |
| Chat with own avatar | +1 token per message | `POST /api/avatars/me/chat` (via `AvatarChatBar`) |
| Chat with town guide (system agent) | +1 token, **rate-limited 1/60s per (userId, slug)** | `POST /api/chat/system/town-guide` |
| Visit a building | +1 token + knowledge extraction | `POST /api/agent/:s/visit-building` |
| Buy knowledge book | Varies (10–30 tokens) | `POST /api/items/buy` |
| Win an activity (Bumper Shells / Reef Race) | Placement tokens via reward pipeline | Server-side, on `match_ended` |

**Heartbeat:** `POST /api/avatars/me/heartbeat` — fire-and-forget position + activity ping, updates `avatars.lastActiveAt`.

**Canonical write path:** every credit and debit goes through `claw-token-ledger.transferClawTokens()` → atomic insert into `claw_token_transactions` + `tokens.settled` event emit. **Never write `avatars.clawTokens` directly.**

**x402 middleware hook-in points:** ledger writes that involve external on-chain settlement go through the Phase 4 x402 merchant wallet — see `ARCHITECTURE.md` "Phase 4" references.

---

## 6. Quests + bounties

### 6a. Quest board (`/api/quests/*` — `apps/api/src/routes/quests.ts`)

Admin-created quest definitions. Player submissions land in `quest_submissions` and payouts in `quest_rewards` (linked to the ClawToken ledger). UI: `<QuestBoardModal>` in the sidebar menu.

### 6b. Bounty board (`/api/bounties/*` — `apps/api/src/routes/bounties.ts`)

Community-posted bounties with reputation tracking. Tables: `bounties`, `bounty_attempts`, `bounty_rewards`, `bounty_reputation`. UI: `<BountyBoardModal>`.

### 6c. NPC integration

Quest-giver NPC at world center (`<QuestNpc>`) plus the Bounty Board object (`<BountyBoardObject>`) anchor the boards in 3D space. Either opens the corresponding modal on click.

---

## 7. Leaderboard

User-facing surface: `apps/web/src/app/leaderboard/page.tsx` rendering `<LeaderboardModal>` and the public `/leaderboard` page. Two boards:

1. **Free Agent Leaderboard** — public, no auth, the canonical Priority #3 surface. Event-weighted scoring with per-day caps. **Full rubric in `ARCHITECTURE.md §5b`.**
2. **Reef Race Lobster of the Day** — top-10 daily best laps, 60s server cache. `GET /api/leaderboard/reef-race/daily-best-lap`.

Filter chips on the agent board: `All / Players / Trainers`. Players are avatar-only entries (no agent), Trainers have a connected agent. Same scoring engine, two `subject_type` tags — see `ARCHITECTURE.md §5b` for the Avatar-keyed UNION.

Window options: `24h / 7d / 30d / all`. 60-second in-memory cache per window — rank changes mid-window are visible within 60s.

---

## 8. Daily login streak

Modal: `apps/web/src/components/game/daily-login-modal.tsx`. Pops on first `POST /api/avatars/me/daily-login` of the calendar day. Shows:

- Today's reward (`10 + streak * 5`, max 100)
- Current streak count
- Milestone unlocks: ✨ Day 3 / 🌊 Day 7 / 🔱 Day 14 / 👑 Day 30 (visual flair only — no separate reward bump)

Streak resets to 1 if a calendar day is missed.

---

## 9. Avatar system

### 9a. 14 archetypes

Source: `packages/shared/src/constants/avatar-archetypes.ts`. 14 personality archetypes with starter stats + flavor text. Examples:

- The Strategist · The Trickster · The Builder · The Diplomat · The Lone Wolf · The Caretaker · The Scholar · The Hustler · The Trailblazer · The Showrunner · The Sage · The Architect · The Daredevil · The Mystic

Stats schema: `STR / DEF / SPD` (each 0–10), summed to a fixed pool that varies by archetype. `avatars.archetype` varchar; the resolved values + traits land in `avatars.characterConfig` JSONB.

### 9b. Creation flow

`/create-agent` (species/color/name) → `/create-agent/personality` (archetype + traits + habitat + hobby + greeting) → `/game`. Server endpoint `POST /api/avatars` creates the row.

Tested end-to-end 2026-04-12 — sign-up → create avatar → enter game works. The legacy `/select-agent` 6-slot page exists but is no longer the primary onboarding path.

### 9c. Species + color

7 sea-creature GLBs + 8 Milady Official VRMs + 2 Hermes VRMs = 17 picker entries (`SelectAgentCanvas.tsx`). See `3dStructure.md §11` for the picker scene constraints. The picker's tabs are **Milady AI · Hermes · OpenClaw · Custom**, both Milady and Hermes flagged `hosted: true` ("Hosted by ClawVille") and starting unlocked for any visitor (no agent gate). Hermes is the second hosted runtime peer to Milady (added 2026-05-12); a third Hermes avatar slot is reserved.

| Type | Models | Color tinting |
|---|---|---|
| Sea creature GLB | lobster, sweet_crab, hermitcrab, jellyfish, octopus_toy, lobster_plush, sea_horse | Per-instance via `applyColorTint` — clones `MeshStandardMaterial`, sets `color` + `emissive` |
| Milady VRM | `milady-official-1..8.vrm` | **No color tint** — MToon's toon-uniform system breaks under `.clone()`. Color customization disabled for VRM avatars. |
| Hermes VRM | `hermes-female.vrm` ("Hermes"), `hermes-male.vrm` ("Tekk") | **No color tint** (same MToon constraint). Mixamo-style humanoid normalization; uses dedicated animation folders at `/avatars/animations/{hermes-female,tekk-male}/*.glb` rather than the generic Milady Mixamo set. |

### 9d. Agent avatar picker (`/create-agent`)

Rotating pedestal in front of the player; click an avatar → confirm. Warm-preloads all 17 avatars at mount via `useGLTF.preload` (GLBs) + `preloadVRM` (VRMs). Never run simultaneously with the open-world Canvas on Iris Xe.

**Render-frame tuning (2026-05-12):** picker VRM scale is `reg.scale * 1.2` (≈15.6wu) — the previous 1.6× variant overflowed the camera frame, clipping the head. Ember particles spawn in an annulus `9 ≤ r ≤ 18` around the pedestal instead of `0 ≤ r ≤ 8`; the old inner-radius range sprayed orange points through the avatar's silhouette where they rendered as opaque squares (the "orange cubes" bug).

### 9e. One avatar per user

Unique DB constraint on `avatars.userId`. The Avatar Settings modal lets the user customize without creating a new row.

### 9f. Heartbeat

`POST /api/avatars/me/heartbeat` — fire-and-forget position + activity ping, updates `avatars.lastActiveAt`. Fires from a 30-second interval while the game tab is foregrounded.

---

## 10. Milady App Store integration

Two-track ship per the brand identity in CLAUDE.md.

### 10a. Sideload (LIVE 2026-04-12)

`@clawville/app-clawville@0.1.0` on npm. Installs via `POST /api/plugins/install` on the user's local Milady HTTP API. Registers a `LAUNCH_CLAWVILLE` chat action. Repo: `github.com/ItachiDevv/clawville-milady-plugin`.

### 10b. Curated app grid (PR `milady-ai/milady#1839` MERGED)

ClawVille is in `MILADY_CURATED_APP_DEFINITIONS`. See `docs/milady-integration-plan.md`.

### 10c. `LAUNCH_CLAWVILLE` ElizaOS action

When the user's Milady agent invokes it, the action opens `https://clawville.world/enter?t=<ticket>` in the user's browser. The ticket is minted via Phase 5 magic-link.

### 10d. `miladyAgentId` identity resolution

`POST /api/agent/connect` accepts a `miladyAgentId` parameter as a stable identity anchor. On first call: server generates Phase 5.1 identity + wallet keypairs, records `miladyAgentId` on the agent row. Subsequent calls match by `miladyAgentId` and skip the keypair generation.

### 10e. Milady session exchange

`POST /api/auth/milady-session-exchange` — when a logged-in Milady user lands on ClawVille via the sideload plugin, this exchanges their Milady cookie for a Lucia session in one round-trip.

### 10f. Smoke test fixture

Persistent test avatar `clawville-plugin-smoketest-v1` on prod. Run `npm run smoke` in the `clawville-milady-plugin` repo to verify the sideload path is healthy end-to-end.

---

## 11. Game UI components

All composed in `apps/web/src/app/game/page.tsx`. The component matrix is gated three ways:

### 11a. Always visible (regardless of mode)

| Component | Purpose |
|---|---|
| `<World3DCanvas>` | Three.js 3D world. See `3dStructure.md` + `WorldContent.md`. |
| `<SeaLoadingScreen>` | Fade-out overlay until `window.__W3D` is set |
| `<BuildingTooltip>` | Hover tooltip for buildings |
| `<NanoClawBanner>` (inline component, `page.tsx:86-138`) | Three states: (a) green "Bot Training Active" pill when `agentConnected`. (b) **"Create Agent" + "Connect Your Agent" pair** when no avatar AND no agent — covers NPC-mode visitors so both onramps are in view (matches landing-page CTAs; added 2026-05-12). (c) "Connect Your Agent" alone when avatar exists but agent not connected. The Create Agent button routes to `/create-agent`; the Connect button opens `<AgentConnectModal>`. |
| `<AgentConnectModal>` | Quick-Connect modal — Manual tab removed in `984627d` |
| `<SidebarMenu>` | Right-edge RPG sidebar (WORLD / AGENT / ECONOMY / QUESTS / SYSTEM). Gear FAB on mobile. |
| `<Minimap>` | Top-left underwater sonar (radial cyan gradient + per-building accent dots). Click-to-path dispatches `setClickPath(path, hitZone?.id)`. Blip fed by `MinimapPositionTracker` at ~5 Hz. |
| `<ControlModeToggle>` | Two-state mode switch — see §1a |
| `<MobileControls>` | Virtual joysticks (auto-detect touch) |
| `<PerfHud>` | FPS / draws / pipes / backend at 2 Hz. See `3dStructure.md §5b`. |
| `<ToastNotifications>` | Floating toast queue |
| `<AutonomyHUD>` | Thought log + goal + session stats — only when `controlMode === 'autonomous' && isActive` |
| `<ThoughtLog>` | World-wide research stream via `useResearchStream` |
| `<SkillBuilderModal>` | Author custom SKILL.md |
| `<MarketplaceModal>`, `<BazaarModal>`, `<AuctionModal>` | Per-surface modals — note bazaar/marketplace/auctions all **write-paused** server-side |
| `<QuestBoardModal>`, `<BountyBoardModal>`, `<LeaderboardModal>` | Modal versions of the corresponding pages |
| `<DeferredTerrainPreloads>` / `<DeferredNpcPreloads>` | Invisible — fire `useGLTF.preload` after first paint |

### 11b. World UI (visible when `hasAvatar === true`, includes guests)

Rendered for any avatar-bearing visitor — guest auto-create included. None of these imply a connected agent.

| Component | Purpose |
|---|---|
| `<LocationHUD>` | "Press E to enter {buildingName}" proximity tooltip |
| `<TutorialOverlay>` | 6-step welcome tutorial + `?` button. On mobile, lifted above the joystick zone with `bottom-[14.5rem] md:bottom-4`. |
| `<ActivityFeed>` | Live world signals (chat events, building visits, etc.) |

### 11c. Player UI (visible when `agentConnected === true`)

Gated on `agentConnected` after the **2026-04-24 fix** that re-gated from `hasAvatar` — collapsing NPC mode + guest flow into full player chrome was eating ~75% of mobile real estate with UI a guest couldn't use. Phase-5 magic-link concern is preserved by the NanoClawBanner CTA in the avatar-but-no-agent state.

| Component | Purpose |
|---|---|
| `<ChatPanel>` | Location-agent chat (right drawer). Cyan theme. Header has **Claim Skill** (downloads `/api/skills/:b/skill.md` as a blob hand-off — commit `e790c64`) + **Shop** button when current building is a shop. |
| `<AvatarStatusBar>` | Level / ClawTokens / STR-DEF-SPD bars / MAP progress / knowledge count / Inventory button |
| `<QuestTracker>` | **30-quest tutorial tracker** (was incorrectly described as "8-quest" — see §0 accuracy fix). Reads `QUEST_DEFINITIONS` derived from `TUTORIAL_QUESTS`. Tier-grouped (tiers 1-4 + pending). Active quest is highlighted. |
| `<AvatarSettingsModal>` | Four sections: (1) stats/archetype/personality, (2) **Edit Appearance** (Phase 4c Layer 1 — harness-filtered avatar grid, MToon-aware color, gender radio; `PATCH /api/avatars/me/appearance` regenerates `characterConfig.system` + mirrors into `agents.config` atomically), (3) **Cross-world accounts** (Phase 5.1 'scape link-code — see §18), (4) **Take agent home to Milady** (Phase 4a — calls `POST /api/agent/export-character`, shows curl install). Footer: **Powered by ElizaOS**. |
| `<LocationConfigModal>` | Per-location agent configuration |
| `<AvatarChatBar>` | Chat with own avatar (bottom-center pill). Icon: hard-coded 🦞. Routes through the connected agent gateway. |
| `<ShopOverlay>` | Buy books at buildings |
| `<InventoryModal>` | View / learn books |
| `<DailyLoginModal>` | Streak reward popup (§8) |

### 11d. Removed legacy

- `<SpectatorBanner>` and the original `<OpenClawConnectModal>` component files were deleted (orphaned post-`<AgentConnectModal>` rename). The `// SpectatorBanner removed — /game is always game mode` sentinel comment lives in `game/page.tsx` so a future reader doesn't try to re-add it on the assumption that spectator state needs a separate banner — it doesn't, the toggle and `<NanoClawBanner>` already cover those states.

---

## 12. NPC simulation

See `WorldContent.md §3` for the canonical NPC roster + counts. This section covers the gameplay-facing behavior.

### 12a. Wandering NPCs

Server tick (`apps/api/src/services/npc-simulation.ts`) streams positions/directions/conversations to clients via SSE (`/api/npc/*`). Client smooths positions via lerp — see `3dStructure.md §6a`.

When disconnected from SSE, `stores/npc.ts` runs a client-side wander loop at 10 Hz so the world doesn't go static. Server connection takes over via `setConnected(true)`.

### 12b. NPC ↔ NPC conversations

NPCs talk to each other via `npc-conversation-engine.ts` (Gemini, direct — bypasses ElizaOS). Chat bubbles appear above the speaker for 6 seconds.

### 12c. Activities + intent descriptions

Per-NPC `activity` + `intentDescription` fields surface as the `<ActivityIndicators>` icons above NPCs (pulsing sphere for `inCombat`/`inConversation`/`isDead`).

### 12d. Possession (NPC mode)

In `controlMode === 'npc'`, WASD drives a single dedicated player-NPC (`PLAYER_NPC_ID = '__player-npc__'`). Server doesn't know about it — `updateFromSnapshot` skips that ID, and it's spawned/cleaned on mode-change via `spawnPlayerNpc()` / `removePlayerNpc()`.

### 12e. Talk-to-character (commit `4222de6`)

Each building has a resident character standing outside the building (Gary outside Squidward's, Karen outside Plankton's bucket, etc. — see `WorldContent.md §3b`). When the player is within `TALK_RADIUS_WORLD` of the character, `<ChatPanel>` opens with that character as the chat target. **No proximity to the building zone itself is required** — `enterBuilding(locationId, characterName?)` is a misnomer kept for backwards compat; nobody actually enters anything, it just opens the chat panel.

### 12f. Per-user memory isolation (Phase 6 — commit `51e97cb`)

Every user gets an isolated memory partition with each building character. One ElizaOS runtime per character; rooms partitioned per `(userId, locationId)` via `characterRoomId(locationId, userId) → UUIDv5`. Namespace `8f3b1b27-5f2a-4a8d-9c1d-2e7b4d1f6a9c`. **Details in `ARCHITECTURE.md §7 Phase 6`.**

---

## 13. Tutorial system

### 13a. Welcome overlay

`<TutorialOverlay>` — 6-step welcome modal that gates first-time players. Triggered by `localStorage` key `clawville-tutorial-seen`. Can be re-opened from the `?` button.

### 13b. Tutorial quest tracker — **30 quests, not 8**

`<QuestTracker>` (`apps/web/src/components/game/quest-tracker.tsx`) reads `QUEST_DEFINITIONS` derived from `TUTORIAL_QUESTS` in `packages/shared/src/constants/tutorial-quest-rewards.ts` (30 entries).

Tier structure:

| Tier | Examples | Reward range |
|---|---|---|
| 1 | Say Hi to Nori · Meet Your Agent · First Steps | 5–10 |
| 2 | Town Briefing · Bonded · Door Knocker | 15–20 |
| 3 | Town Tour · Star Pupil · Cartographer | 30–60 |
| 4 | Shop & Study · Library Card · Polymath | 25–75 |
| pending | Style Statement · Big Spender | 30–50 (status `pending` — not yet wired up) |

Each quest has `id`, `tier`, `status` (`live` / `pending`), `icon`, `title`, `reward`, `description`. The tracker groups by tier in the expanded view; the collapsed pill shows progress as `completedCount / totalCount`.

---

## 14. Authentication

Lucia 3.x sessions backed by `users` + `sessions` tables.

### 14a. Standard auth

- `POST /api/auth/signup` — email + password (Argon2id), creates `users` + `avatars` row in one transaction
- `POST /api/auth/login` — sets `clawville_session` cookie
- `POST /api/auth/logout` — invalidates the session

### 14a.bis. Username / identity layer (2026-05-19)

ClawVille separates two human-readable identifiers:

| Field | Where | Uniqueness | Mutability |
|---|---|---|---|
| `users.username` | One per account, case-insensitive UNIQUE | platform-wide | editable via `PATCH /api/users/me/username` |
| `avatars.name` | Per character, UNIQUE | per-avatar | only on avatar creation |

**Initialization rule:** on first avatar creation (`POST /api/avatars`), the server copies `avatar.name` into `users.username` if that column is `NULL`. From then on the two values are independent — swapping or renaming the avatar does NOT touch the username.

**Edit endpoint:** `PATCH /api/users/me/username` (Lucia-authed, 5/min/IP). Body: `{ username: string }`. 409 on collision, 400 on format violation, 429 on rate-limit. Allowed format: `^[a-zA-Z0-9_]{3,20}$` (DB-enforced via `users_username_format` check constraint).

**Availability probe:** `GET /api/users/check-username/:name` (public). Returns `{ available: boolean, reason?: string }`. Case-insensitive lookup.

**Create-agent name check:** `GET /api/avatars/check-name/:name` now validates against **both** `avatars.name` AND `users.username` since the create flow copies one into the other. A name that's already someone else's username will be rejected at probe time, not at insert.

**Legacy rows:** users created before this column existed get `username = NULL` until backfill (`bun run scripts/backfill-usernames.ts`) — that script picks the oldest avatar's name per user, skipping format-incompatible legacy names so the user can pick a fresh handle from Avatar Settings.

**UI:** Avatar Settings modal renders a "Username" section with debounced availability check + Save. Out-of-flow change — does not invalidate avatar.name or restart the runtime.

### 14b. Phase 5 — agent-issued magic link (`b527636`)

A connected agent can mint a one-time login URL for its human operator without exchanging passwords or OAuth.

```
Agent                        ClawVille API                  Human browser
  |-- POST /api/agent/:s/issue ->|                              |
  |<-- { url: /api/auth/enter?t=}|                              |
  |-- DM url to human -----------------------------------------|
  |                              |<-- GET /api/auth/enter?t=xxx |
  |                              | mint Lucia session cookie    |
  |                              |-- 302 Location: /game ----->|
```

Table: `agent_session_tickets` (32-byte token, 5-min TTL, `consumed_at`). Service: `session-ticket-service.ts`. Expired/consumed → 302 with `?error=expired-link` → `<ExpiredLinkBanner>` on landing.

### 14c. Phase 5.1 — first-connect response

`POST /api/agent/connect` and `POST /api/agent/join` return Phase 5.1 `identity` + `wallet` blocks on the **fresh-generation** call only. Subsequent calls omit `secretKey` (server never returns again — only safe disclosure path).

Full Phase 5.1 architecture (keypair roles, envelope encryption, signed-challenge reconnect, 'scape portal) lives in **`ARCHITECTURE.md §7`**.

### 14d. Spectate mode

`isSpectator` in the game store reserves screen real estate at the top — the toggle position offsets via `top-[8rem]` vs `top-[3.5rem]`. Currently unused in production (spectator banner is dead code per §11d).

---

## 15. Landing page (`apps/web/src/app/page.tsx`)

| Section | Purpose | Source |
|---|---|---|
| `<HeroSection>` | Tagline + "Enter ClawVille" + "Explore World" CTAs | `page.tsx:97-216` |
| `<SiteHeader>` (sticky) | Top-bar nav for landing flows | `page.tsx:800-916` (commit `c235fb1`) |
| `<ExpiredLinkBanner>` | Surfaces `?error=expired-link` query param from a stale magic-link | `page.tsx:21-56` |
| `<AgentPlatformsGrid>` | Logos of supported agent platforms (OpenClaw / Ironclaw / Nanoclaw / Milady / Hermes) | `page.tsx:215-293` (commit `fef1a3c`) |
| `<HowItWorksModal>` | Trigger from "How it works" button | `apps/web/src/components/landing/how-it-works-modal.tsx` |
| `<CollaborationAxes>` | The three brand-identity axes (Agent↔Agent · Human-Agent↔Agent · Human↔Agent) | `apps/web/src/components/landing/collaboration-axes.tsx` |
| `<LiveDemoStrip>` | Live demo carousel | `apps/web/src/components/landing/live-demo-strip.tsx` |
| `<GameplayShowcase>` | Gameplay clip strip | `apps/web/src/components/landing/gameplay-showcase.tsx` |
| `<MiladyAvatarShowcase>` | Rotating Milady VRMs | `apps/web/src/components/landing/MiladyAvatarShowcase.tsx` |
| `<LandingScene>` | Underwater 3D background scene (dynamic import, SSR disabled) | `apps/web/src/components/three/LandingScene.tsx` |
| Token launch + tokenomics + roadmap + skill categories + footer + tech badges | Scroll body | `page.tsx` |

---

## 16. Jump controls

The full state machine, physics constants, and per-frame integration math live in **`3dStructure.md §6e`** (it's a 3D-rendering / physics concern, not a gameplay surface).

Gameplay-facing summary:
- **SPACE** triggers `charging` (avatar stays on ground while holding); release < 200 ms → quick tap (small hop), release ≥ 200 ms → scaled launch (peak altitude linear in charge); `holdMs ≥ 1500 ms` auto-launches at max.
- **Mid-air SPACE** triggers quicksink (fast controlled descent at −600 wu/s).
- Active in `controlMode === 'player'` and `controlMode === 'npc'`. Ignored in `explore` and `autonomous`.
- Hard reset on `enterBuilding()` (movement freeze) and all four control-mode mutation paths.
- Charge bar at the bottom-center reads `chargeProgress` (0–1) directly from `jumpState`.

---

## 17. 'scape cross-world portal

ClawVille ↔ `github.com/Dexploarer/scape`. Bidirectional, signature-authed both sides. Full architecture (keypair roles, envelope encryption, signing math) in **`ARCHITECTURE.md §7 Phase 5.1`**.

### 17a. Outbound — "Cross to 'scape" button

Located in the WORLDS sidebar group. Lucia-authed user clicks → `POST /api/portal/scape` → server builds a canonical-JSON payload (kind, principalId, worldCharacterId, displayName, agentId, ttlMs), signs `sha256(body)` with the service issuer private key, POSTs to `SCAPE_HOSTED_SESSION_URL` with `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature` headers, emits `portal.scape.crossed`, returns `{ redirectUrl }`. Frontend opens in a new tab.

### 17b. First crossing — auto-provisioned 'scape character

On the first outbound crossing, `users.scape_principal_id` is populated with `principal:clawville:<user.id>` and `users.scape_world_character_id` with `cv-<avatar.id>`. Auto-provisioned characters are minimal — no inventory, no level history.

### 17c. Linking an existing 'scape account — Avatar Settings flow

Avatar Settings → Cross-world accounts → "Link existing 'scape account":
1. Click "Generate link code" → `POST /api/portal/scape-link-code` → user copies the 8-char code.
2. User pastes the code into 'scape's "Link External Account" UI.
3. 'scape posts `{ code, signedPayload }` to `POST /api/portal/accept-scape-link`.
4. Server verifies signature against `PARTNER_PUBKEYS.scape`, consumes the `pending_account_links` row atomically, sets `users.linked_scape_*` columns.

Linked accounts win over auto-provisioned in the portal-minter priority order.

### 17d. Reverse — 'scape → ClawVille

'scape posts to `/api/portal/mint-for-scape` with their signature → we verify against `PARTNER_PUBKEYS.scape` → mint a Phase 5 magic-link ticket → return `{ redirectUrl: https://clawville.world/enter?t=... }`.

### 17e. State columns on `users`

| Column | Set by |
|---|---|
| `scape_principal_id` | First outbound crossing |
| `scape_world_character_id` | First outbound crossing |
| `linked_scape_principal_id` | `POST /api/portal/accept-scape-link` (linked, takes priority) |
| `linked_scape_world_character_id` | Same |
| `linked_scape_display_name`, `linked_scape_at` | Same |

---

## 18. Activity portals (Q2)

Bumper Shells (launch title) + Reef Race. Server-authoritative simulation + WebSocket frame stream + per-activity 3D scene that takes over the route when active.

### 18a. Routes

| Route | Purpose |
|---|---|
| `/activity/[activityId]/[roomId]` | Match render — Bumper Shells or Reef Race scene |
| `POST /api/activities/:id/queue` | Join queue |
| `POST /api/activities/:id/leave-queue` | Cancel |
| `GET /api/activities/:id/queue-status` | Poll status while queued |
| `GET /api/activities/:id/leaderboard?window=daily\|weekly\|all\|season&limit=N` | Per-activity leaderboard |
| `GET /api/leaderboard/reef-race/daily-best-lap?limit=10` | Lobster of the Day public board (public, no auth, 60/min/IP, 60s cache) |
| Activity WS hub | Inputs in + delta/keyframe/event frames out |

### 18b. Portal entry — `?quickQueue=` deep-link

`apps/web/src/app/game/page.tsx` reads `window.location.search` for `?quickQueue=<activityId>` and auto-fires the queue join. Direct `window.location.search` (not `useSearchParams()`) because the page is `'use client'` and uses other window-only APIs — `useSearchParams()` would force a Suspense boundary under Next 16's prerender pass.

### 18c. Bumper Shells — game design (LOCKED)

| Spec | Value |
|---|---|
| Players per match | 4–8 (queue cap 8) |
| Arena | 500 wu radius circle |
| Win condition | Last shell standing OR most knockouts at 90s timeout |
| Sim rate | 60 Hz server-authoritative |
| Frame cadence | 15 Hz deltas + 1 Hz keyframes |
| Power-ups | 6 in catalog (turbo / shield / pull-magnet / etc.) |
| Anti-cheat | `MAX_SPEED=350`, `MAX_ACCEL=MAX_SPEED·4`, `KNOCKBACK_VELOCITY_THRESHOLD=80`. 5-flag forfeit. |

### 18d. Reef Race — game design (LOCKED)

| Spec | Value |
|---|---|
| Players per match | 4–8 |
| Track | Bespoke oval, half-axes `A=1100, B=700` |
| Laps | 3 |
| Checkpoints | 12 in fixed sequence — out-of-order = silent reject |
| Sim rate | 30 Hz |
| Frame cadence | 5 Hz deltas + 1 Hz keyframes |
| Anti-cheat | `REEF_MAX_SPEED=500`, `MIN_LAP_MS=15000` discard + flag, `REEF_SKIP_PATTERN_THRESHOLD=3` skips/5s flag. 5-flag forfeit. |
| Timeout | 90 s soft + 30 s straggler grace; hard 120 s. |
| Personal best | `reef_race_personal_bests` table (one row per `(avatarId, activityId)`). Awaited in reward pipeline so `dailyRank` is deterministic in the match-end frame. |
| Streak counter | `event.streak_milestone` at `[5, 10, 20, 30, 36]`. Tier-keyed glow on the HUD chip. |
| Perfect race bonus | +25 tokens when `bestStreakThisMatch >= 36` |

### 18e. HUD + spectator

| File | Purpose |
|---|---|
| `apps/web/src/components/game/activity/BumperShellsHud.tsx` | Per-activity HUD composition |
| `.../ActivityTutorialCard.tsx` | First-time intro (Nori-voiced, localStorage gate) |
| `.../SpectatorCamSelector.tsx` | Spectator cam mode selector (chunk #11) |
| `apps/web/src/components/game/activity-mobile-controls.tsx` | Touch A/B + joystick replacing open-world `mobile-controls.tsx` mid-match |
| `apps/web/src/stores/activity.ts` | `selfStreak`, `lastMatchPbDelta`, `lastMatchStreakBest`, `lastMatchDailyRank`, `lastMatchPerfectLapBonus`, `selfBestGhostPath`, `errorBanner` |

### 18f. Reward pipeline

Tracked in `ARCHITECTURE.md §4` as service `activity/reward-pipeline`. Placement tokens + first-play-of-day + Reef PB + +25% focus-aligned bonus, all in one DB transaction. Bots get `tokensAwarded=0`. Emits one `activity.match.placed` per participant.

### 18g. Reef Race riders

| SPEC | What | Shipped |
|---|---|---|
| SPEC 1 | Multi-species GLB rider — any sea-creature on the racing shell | post-Q2 |
| SPEC 2 | Milady VRM rider with `surf_idle / wipeout / victory` Mixamo clips | 2026-04-29 |
| SPEC 3 | Ramp launch volumes — AABB collision in tangent/normal basis, 500 ms per-body cooldown, `event.ramp_launch` payload `{type, avatarId, rampId, launchVel}` | 2026-04-29 |

---

## 18z. Wager lobbies (Bumper Shells + Reef Race, 2026-05-12)

Every activity that runs a winner-take-most match is now wrapped by a wager lobby. The same UI component (`apps/web/src/components/game/lobby-landing.tsx`) is rendered as a gate by `apps/web/src/app/activity/[activityId]/[roomId]/page.tsx` — the 3D scene only mounts after the lobby transitions to `locked`.

### 18z.a. Flow

1. **Mount** — page renders `<LobbyLanding>` (3D scene unmounted). Component fetches `GET /api/wager/lobbies?activityId=X&roomId=Y&state=open`. If a lobby exists, jumps to "waiting"; else "create".
2. **Create** — user picks: `Mode = Multiplayer | Solo vs Bots`; if multiplayer: wager (Free / 0.01 / 0.05 / 0.1 / 0.5 / 1 SOL), visibility (Public / Private invite-link / Friends-only), max players (2-16, default 4). Submit → `POST /api/wager/lobbies` → server inserts off-chain row + signs on-chain `create_lobby_sol` (creator deposits + becomes Player PDA).
3. **Waiting** — component polls `GET /api/wager/lobbies/:id` every 3 s. Renders the depositor list, share-invite link (if creator + private/friends), `LEAVE LOBBY` button (cancels for creator, refund-request for non-creator).
4. **Locking** — when the match-server transitions `room → LIVE`, the wager-lobby bridge calls `lock_lobby` on chain in lockstep. Component sees `state='locked'` on the next poll, calls `onLobbyLocked` → parent unmounts `<LobbyLanding>` + mounts `<BumperShellsScene>` or `<ReefRaceScene>`.
5. **Settle** — when the match-server transitions `room → RESULTS`, the bridge calls `settle_lobby_sol` with the first-placed avatar from the sim's `computeResults()`. If the placement-1 entry is a bot or no-show, the bridge logs a failed-settle event; an operator must then call `POST /api/wager/lobbies/:id/cancel` to unlock per-player refunds via `POST /api/wager/lobbies/:id/refund`.

### 18z.b. Modes

- **Multiplayer** — real on-chain escrow via the deployed `clawville_wager` Anchor program (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG` on devnet). 5 % rake snapshot at create-time goes to the treasury (currently the deployer pubkey). Free-play (`wager=0`) is supported and routes through the same SOL instructions; rake on zero pot is zero.
- **Solo vs Bots** — no escrow, no on-chain footprint. The lobby row exists purely for FE state continuity + leaderboard credit. The lobby is auto-locked on FE submit so the 3D scene mounts immediately.

Visibility:
- `public` — shows up in `GET /api/wager/lobbies`, anyone can join.
- `private` — generates a ~12-char URL-safe `invite_code`. Only visible to creator in the list response. Shared via the in-component "Invite link" button.
- `friends` — same shape as private; future work adds a friend-list whitelist check.

### 18z.c. Cancel / Refund

- Creator can cancel while `state='open'`. Authority (admin) can cancel while `state in ('open','locked')` — emergency drain path.
- After cancel, every depositor can call `POST /api/wager/lobbies/:id/refund` (single tx per player; idempotent — second call returns 200 with `idempotent: true`). The on-chain instruction `claim_refund_sol` closes the player's PDA + returns their deposit + rent residual.
- Solo-bots cancels are a no-op on chain — the off-chain row flips to `cancelled` and the FE bails.

### 18z.d. Feature gates

- `wager-spl-lobbies` — the `wager_mint` column + `create_lobby_spl` instruction exist; routes refuse `wagerMint != null` with 503 until a merchant requests it. Review deadline 2026-07-01.
- `wager-mainnet-paid` — the API hard-codes devnet RPC; mainnet wiring requires a code change, not just an env flip. Review deadline 2026-09-01.
- `treasury-envelope-encryption` — settlement-authority key is encrypted with the legacy `VANITY_ENCRYPTION_KEY` (matches the other treasury keys), not envelope-encrypted via CF KEK. Review deadline 2026-07-01.

---

## 18a. Casino — Predictive Gaming Cove (Phase 6, Concern 6.0.x)

Accessible by clicking the casino building (slot 9, W ring, `casino-exterior.glb` pyramid) in the open world. The building onClick in `arena-buildings.tsx` navigates via `window.location.href = '/casino'`.

### 18a.a. Interior scene (Concern 6.0.2 — SHIPPED)

Route `/casino` mounts a route-isolated R3F Canvas (`key="casino-interior"`) with a separate WebGPU context. Scene shows the casino interior GLB (Predictive Gaming Cove theme). Slot machine hotspots are invisible click boxes — cursor: pointer on hover; click fires `console.info('[slot-screen pending — Concern 6.0.4]')`.

| Asset | Detail |
|---|---|
| `casino-interior.glb` | Gameready, Draco-compressed, 4.2MB, ~211k tris |
| `casino-interior-fallback.glb` | Cartoon, no Draco, 58KB, 449 tris — Object_8+Object_9 = slot cluster |

**FPS auto-fallback:** if avg FPS < 40 over the first 5 seconds, the scene silently reloads the fallback GLB. Force fallback: `?fallback=1`. Back to World button top-left → `router.push('/game')`.

### 18a.b. 2D slot screen (Concern 6.0.4 — PENDING)

Clicking a slot machine hotspot will open a 2D UI overlay with the actual slot game. Not yet implemented — current click handler is a `console.info` placeholder.

### 18a.c. Backend / RNG / wager program (Concern 6.1+ — PENDING)

On-chain slot RNG, SOL/USDC wagering, settlement via `clawville_wager` Anchor program. Out of scope for Concerns 6.0.x. See `.claude/plans/phase6-casino-slots.md`.

---

## 19. Map layout

Source: `packages/shared/src/constants/map-locations.ts`. 160×160 tile grid, 32 px/tile = 5120×5120 world units. Village center tile `(80, 80)` → world `(0, 0)`. Building ring at radius 68 tiles = 2176 wu, 10 slots at 36° spacing.

See **`3dStructure.md §1`** for the full coordinate system + axis conventions, and **`WorldContent.md §2`** for the building roster.

---

## 20. Recent material changes

Compact log. The audit-history wall at the top of the prior version of this doc has been replaced with this. Entries are gameplay-facing — backend/service changes belong in `ARCHITECTURE.md §13`, 3D-render changes in `3dStructure.md §13`.

- 2026-05-18 — Concern 6.0.2: Casino interior scene shipped. New §18a (casino). Click casino building → `/casino`. Route-isolated Canvas, gameready GLB + cartoon fallback, FPS-fallback gate, invisible slot hotspots, Back to World button. 2D slot screen (6.0.4) + RNG/wager (6.1) pending.
- 2026-05-12 — Wager lobbies vertical slice. New §18z covers the reusable `<LobbyLanding>` gate on every activity match page, the 4 lobby flows (create / wait / lock / cancel-refund), the 3 modes (multiplayer / solo-bots / free-play), and the 3 visibility levels (public / private / friends). On-chain settlement via the deployed `clawville_wager` Anchor program on devnet. Match-server auto-locks on `room → LIVE` and auto-settles to placement-1 avatar on `room → RESULTS`.
- 2026-05-12 — `40e7ed4` — new canonical `WorldContent.md` + bidirectional sync rule across all four docs. This doc's tight-manifest rewrite landed under `c2be3e0`-equivalent same series.
- 2026-05-08 — Pets → Avatars rename pass. UI components `PetStatusBar` → `AvatarStatusBar`, `PetChatBar` → `AvatarChatBar`; routes `/api/pets/*` → `/api/avatars/*`; game-store fields `petPosition`/`petSpeed` → `avatarPosition`/`avatarSpeed`. `avatar_type` / `avatar_url` columns kept (those describe the render asset format, not the table name).
- 2026-04-29 — Reef Race SPEC 3 ramps + SPEC 2 Milady VRM riders shipped.
- 2026-04-28 — Free agent leaderboard Q3 rebalance. Weights retuned, daily caps, Player tier groundwork.
- 2026-04-25 — Reef Race Phase 4: PB persistence, streak counter, Lobster of the Day, match-end summary.
- 2026-04-24 — Phase 6 session liveness + ClawVille Orientation Skill in town-guide template. New endpoints `GET /api/agent/session-status`, `POST /api/agent/disconnect`, `GET /api/auth/me/agent-session`. Game UI re-gated from `hasAvatar` → `agentConnected` (the major fix mentioned in §11c).
- 2026-04-23 — Guest avatar auto-create. `POST /api/auth/guest`, `users.is_guest`, `avatars.is_guest`. Brand carve-outs in leaderboard.
- 2026-04-22 — Town Guide NPC + commerce anchors (Bazaar / Marketplace / Auction stalls) shipped at world center.
- 2026-04-21 — Phase 5.1 wallet identity + 'scape portal. Free agent leaderboard public surface live at `/leaderboard`.
- 2026-04-21 — Metrics spine (`events` + `event_write_failures` + dashboard route at `/api/dashboard`).
- 2026-04-21 — Bazaar / Marketplace / Auctions write handlers paused (503) pending skill-marketplace rework.
- 2026-04-12 — Milady App Store sideload live (`@clawville/app-clawville@0.1.0`).
- 2026-04-10 — Ultrathink decommission: `plugin-anthropic` + `plugin-openai` removed. Gemini only.

Older history: `git log apps/web/src/ apps/api/src/`.
