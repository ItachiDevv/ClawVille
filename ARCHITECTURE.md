# ClawVille Architecture

> **Last Audited:** 2026-05-12 (Wager lobbies + escrow vertical slice — `clawville_wager` Anchor program (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG` on devnet, rake_bps=500, config PDA `AbvtPhFtbQNQ9oT8vQumPEWDowRXibtPeLpmDvTz5i2a`) goes live for Bumper Shells + Reef Race. New workspace package `@clawville/wager-program` (PROGRAM_ID + IDL + PDA helpers — `findConfigPda` / `findLobbyPda` / `findVaultPda` / `findPlayerPda`). New DB tables `lobbies` / `lobby_players` / `lobby_events` + sequence `wager_lobby_id_seq` + `treasury_purpose` enum value `'wager-settlement-authority'` (migration `packages/database/drizzle/wager-lobbies.sql`). New API service `wager-program-client.ts` (loads settlement-authority Keypair from `treasury_wallets`, signs `lock_lobby` / `settle_lobby_sol` / authority-cancel, persists Anchor logs into `lobby_events`) + match-server bridge `activity/wager-lobby-bridge.ts` (hooks into `setLiveTransitionFn` for auto-lock + `setEndedFn` for auto-settle on the winner avatar). New routes module `wager.ts` mounted at `/api/wager/*` (create / list / detail / join / lock / settle / cancel / refund). New FE component `apps/web/src/components/game/lobby-landing.tsx` rendered as a gate in `app/activity/[activityId]/[roomId]/page.tsx` — 3D scene mount waits for `state='locked'`. New env vars: `WAGER_SETTLEMENT_AUTHORITY_PUBKEY`, `WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH`, `SOLANA_RPC_URL`, `WAGER_PROGRAM_CLUSTER`. Feature gates: `wager-spl-lobbies` (SPL routes refuse — schema-ready), `wager-mainnet-paid` (devnet-only), `treasury-envelope-encryption` (treasury_wallets stays on v1 VANITY_ENCRYPTION_KEY until next rotation). Seeded settlement-authority row via `scripts/seed-wager-settlement-authority.ts` (pubkey `G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy` = deployer = treasury). Migration applied via `bun packages/database/scripts/apply-wager-migration.ts`. Prior: 2026-05-08 (Avatars→Avatars rename — concerns 1a–1h. The `avatars` table is now `avatars`, `avatar_inventory` → `avatar_inventory`, `avatar_id` → `avatar_id` everywhere, `wallet_subject_type` enum value `'avatar'` → `'avatar'`, route `apps/api/src/routes/avatars.ts` → `routes/avatars.ts`, all `/api/avatars/*` HTTP paths → `/api/avatars/*`, frontend `player-avatar.tsx` → `player-avatar.tsx`, archetype constants `avatar-archetypes.ts` → `avatar-archetypes.ts`, `avatar_species`/`avatar_color`/`avatar_gender` enums → `avatar_species`/`avatar_color`/`avatar_gender`, CHECK constraint `pets_agent_category_valid` → `avatars_agent_category_valid`, store fields `avatarPosition`/`petSpeed` → `avatarPosition`/`avatarSpeed`, `cv-<avatar.id>` portal world-character id → `cv-<avatar.id>`. The `avatar_type`/`avatar_url` columns on the avatar table — which describe the renderable model format (`glb`/`vrm`) — keep their names, since "avatar" there refers to the visual asset, not the table-name. **Note:** historical "Last Audited" entries below describe the schema state AT THE TIME of those audits; do not retroactively rewrite them. The body sections below describe current post-rename state.) Prior: 2026-04-29 (SPEC 3 Ramps — `event.ramp_launch { type, avatarId, rampId, launchVel }` added to `ServerFrame` discriminated union in `@clawville/shared/src/activities/protocol.ts`. Server: `resolveRamps()` in `reef-race-spline-sim.ts` step 5d — AABB collision in tangent/normal basis, 500ms per-body cooldown, broadcasts `event.ramp_launch`. Client store: `lastRampLaunchEvent` slice in `useActivityStore`. No DB schema changes.) Prior: 2026-04-25 (Reef Race Phase 4 client surface ship — `activity-results-modal.tsx` now activity-aware (subtitle/tagline/CTAs key off `activityId` prop — no more "BUMPER SHELLS" on Reef Race match-ends) + 3 conditional Reef Race callout sections (PB delta `🏆 NEW PERSONAL BEST: 12.34s (was 12.89s)`, perfect-line streak `⚡ N CHECKPOINTS` / `🌟 PERFECT LAP × 36`, Lobster-of-the-day rank `🦞 #N`) + perfect-race bonus reward row (when `lastMatchPerfectLapBonus > 0`); `formatLapMs` + `formatLapDeltaMs` helpers added. **New component:** `apps/web/src/components/game/reef-race-streak-counter.tsx` — small chip mounted in `reef-race-hud.tsx` (between PlacementTile + BestLapTile) reading the primitive `selfStreak` store field; tier-keyed glow indexed by SHARED `streakMilestoneKind` (no client-side milestone re-derivation); 200ms reset-flash CSS keyframe + milestone-pulse animation when streak hits 5/10/20/30/36; auto-hides outside live matches. **New `/leaderboard` board mode:** Lobster of the Day tab (`apps/web/src/app/leaderboard/page.tsx`) — `useQuery` against `GET /api/leaderboard/reef-race/daily-best-lap?limit=10` with 60s `staleTime` matching server cache; renders ranked top-10 (gold-tinted #1 row, recorded-at relative time, lap times via `formatBestLapMs`); empty state copy "No laps in last 24h yet"; tab toggle preserves the existing Agents board untouched. **S-IMPL-1 fix (double-emit suppression):** `reef-race-sim.ts → endRound` now skips its preview `event.match_ended` when `state.activityId === 'reef-race'` — the reward pipeline's `emitPerRecipientMatchEnd` owns the authoritative broadcast (with real tokens / pbDelta / streakBest / perfectLapBonus); other activities still get the preview broadcast as before. Test `ReefRaceSim — race-end` updated to assert match_ended is NOT emitted from the sim for reef-race rooms (authoritative emit comes from pipeline). **S-IMPL-3 fix:** `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` `GHOST_SAMPLE_HZ` 10 → 5 + comment updated to match server. **C-IMPL-4 fix:** `packages/database/drizzle/meta/_journal.json` backfilled with idx 3/4/5 entries for `0003_activity_results_acknowledged_at`, `0004_guest_pet_columns`, `0005_reef_race_personal_bests` so `drizzle-kit migrate` correctly registers all migrations as part of the chain (snapshot files for 0002–0005 still missing — pre-existing breakage that requires a `bun run db:generate` against a fresh schema-aligned DB to backfill; documented as deferred). 221 pass / 7 pre-existing fails (bumper-shells-bot — unchanged baseline). Web + API tsc clean.)
>
> Prior audit 2026-04-25 (Reef Race Phase 4 — PB persistence + streak counter + Lobster of the Day + match-end summary. **New table:** `reef_race_personal_bests` (one row per `(avatarId, activityId)`, `bestLapMs`, `bestLapRecordedAt`, `sourceRoomId`, `ghostReplayData jsonb`) with unique index on `(avatar_id, activity_id)` + composite index `(best_lap_recorded_at DESC, best_lap_ms ASC) WHERE activity_id = 'reef-race'`. Migration `0005_reef_race_personal_bests.sql` is purely additive; also adds `activity_results.match_best_streak` + `activity_results.match_pb_daily_rank` int nullable columns. **New services:** `apps/api/src/services/activity/reef-race-personal-best-service.ts` (atomic compare-and-set upsert via `INSERT ... ON CONFLICT DO UPDATE WHERE EXCLUDED.best_lap_ms < existing`, follow-up indexed scan for `dailyRank` in the same async chain — C2 fix, no cache race; 5-min in-memory PB-ghost cache invalidated on every successful write — S4 fix); `apps/api/src/services/activity/reef-race-daily-best-service.ts` (60s in-memory cache for the public daily-best-lap leaderboard, invalidated on every PB upsert). **New route:** `GET /api/leaderboard/reef-race/daily-best-lap` (public, no auth, 60/min/IP via separate `dailyBestLapLimiter` — S5 fix, NOT shared with `/agents`). **Sim changes:** `reef-race-sim.ts` `ReefBody` gains `currentLapFrames`, `bestLapFrames`, `bestLapMsSoFar`, `currentStreak`, `bestStreakThisMatch`, `lastApexVerdictByHairpin: Map<\`${lap}-${cpIdx}\`, 'clean' \| 'wide'>` (S1 fix — keyed by lap+cp). Frame capture at `GHOST_CAPTURE_HZ=5` Hz (every 6th tick at 30 Hz sim) with `MAX_GHOST_FRAMES_PER_LAP=250` FIFO cap. Lap-up SUCCESS branch snapshots `currentLapFrames.slice()` into `bestLapFrames` if `lapMs < bestLapMsSoFar`, then clears `currentLapFrames` + re-anchors with synthetic `{t:0,x,z,rot}` (S6 fix). Lap-up DISCARD branch (sub-`MIN_LAP_MS`) ALSO clears + re-anchors (C1 fix). Apex verdict map cleared on both branches. Streak update fires inside `resolveCheckpoints` BEFORE lap-up branching; non-hairpin = auto-clean, hairpin requires `lastApexVerdictByHairpin.get(\`${lap}-${cpIdx}\`) === 'clean'`. Edge-broadcasts `event.streak_milestone` at `STREAK_MILESTONES = [5, 10, 20, 30, 36]` (S2 fix — 5 milestones matching the 5-tier `streakMilestoneKind` union). `computeResults()` embeds per-avatar `reefRace: { bestLapMs, ghostReplayFrames, bestStreakThisMatch, currentStreakAtMatchEnd }` into each `SimResultRow` BEFORE sim teardown — C3 fix, reward pipeline operates on plain JS, no live-state accessor. New `reefRaceSim.getFlagCount(roomId, avatarId)` for the anti-cheat PB skip. **Reward pipeline changes:** `issueRewardsForRoom` runs `Promise.all(maybeUpdatePersonalBest(...))` AWAITED per non-bot Reef Race participant before opening the credit transaction — C2 fix, dailyRank embedded in match-end frame is deterministic on the just-set PB; avatars with `getFlagCount > 0` skip PB write (anti-cheat carve-out §4.4); `computeBreakdown` adds `perfectStreakBonus` (rewardConfig.perfectStreakBonusTokens=25 when bestStreakThisMatch >= 36); `activity_results` insert sets `matchBestStreak` + `matchPbDailyRank`. Per-recipient `event.match_ended` dispatch via `activityWsHub.sendToAvatar(...)` — S7 fix, only the PB-setter receives `pbDelta.newGhostFrames` (~5 KB); rivals get `pbDelta` minus `newGhostFrames` (~50 bytes). **WS hub:** `sendInit` now async; loads self avatar's PB ghost frames via `loadPersonalBestGhostFrames(avatarId)` and attaches to `RoomMeta.selfBestLapGhost` (per-recipient by construction — gates on `ws.data.identity.avatarId`). **Shared protocol:** `GhostFrame` interface relocated from client-only `reef-race-types.ts` to `@clawville/shared/activities/protocol`; new `PbDelta` block carries `newMs`, `oldMs`, optional `newGhostFrames`, `dailyRank`; `RewardPreview` extended with `pbDelta`, `streakBest`, `perfectLapBonus`; `RoomMeta` extended with `selfBestLapGhost?: GhostFrame[]`; new `event.streak_milestone` server frame; `EntityDelta.changed.streak: number` for per-tick HUD updates. New shared module `@clawville/shared/activities/reef-race-streak` exports `STREAK_MILESTONES`, `streakMilestoneKind`, `TOTAL_CHECKPOINTS_PER_RACE = 36`. **Activity reward config:** `perfectStreakBonusTokens: 25` added to `REEF_RACE_REWARD_CONFIG`. **Town Guide:** 4 new substantive `knowledge[]` entries covering PB ghost, streak counter, Lobster of the Day, and match-end summary — S8 fix. **Frontend store:** `useActivityStore` gains `selfStreak`, `selfBestStreakThisMatch`, `lastMatchPbDelta`, `lastMatchStreakBest`, `lastMatchDailyRank`, `lastMatchPerfectLapBonus`; snapshot.init populates `reefRace.selfBestGhostPath` from `RoomMeta.selfBestLapGhost`; snapshot.delta tracks `selfStreak` from `EntityDelta.changed.streak`; match_ended swaps in fresh ghost frames from `pbDelta.newGhostFrames`. New tests: `reef-race-personal-best-service.test.ts` (6), `reef-race-daily-best-service.test.ts` (5), Phase 4 cases in `reef-race-sim.test.ts` (10) covering frame capture, C1 discard fix, C3 lifecycle, S1 lap-keyed verdict, S2 milestone tier mapping, getFlagCount accessor.)
>
> Prior audit 2026-04-24 (Reef Race Phase 3 — stat-driven body multipliers wire from `avatars.level + avatars.archetype` through the sim's first tick. **New service:** `apps/api/src/services/activity/avatar-profile-loader.ts` with `loadRacingProfiles(humanAvatarIds, botAvatarIds)` — single Drizzle SELECT against `avatars`, bots short-circuit to neutral, DB error falls back to all-neutral so a race never black-holes. **Sim signature:** `reefRaceSim.startRoom` accepts `opts.petProfiles?: Map<string, PetRacingProfile>`; missing entries default to neutral mults — bit-identical to pre-Phase-3 behavior. **Shared protocol:** `RoomMeta.reefRacingProfiles?: Record<avatarId, { class, level }>` — sent ONCE in `snapshot.init` (~50 bytes × ≤8 avatars = ≤400 bytes), HUD client filters by self avatarId. **Widened callback:** `setLiveTransitionFn` now `(room) => Promise<void> | void` — `persistLiveTransition` `await`s it so the matchmaker pre-loads profiles BEFORE `startRoom` (no async IIFE, no tick-0 race). Bumper-shells + arena handlers unchanged — sync `void` returns are awaited as no-ops. **Anti-cheat tolerance** `REEF_KINEMATIC_TOLERANCE` bumped 2.0 → 2.1 to absorb the per-tick acceleration step boosted by `max(accelMult=1.25, 1/turnRadiusMult=1.176) = 1.25×` during corner entry — worst-case position step 33.6 wu vs 35.0 wu validator allowance (1.4 wu headroom). Pre-existing N1 no-op fix at `reef-race-sim.ts` `integrateMotion` — `validateReefVelocityDelta(prevV, prevV, ...)` rewritten to `(prevV, currV, ...)` so the velocity validator now actually fires (allowance 140 wu/s vs legit max 83.3 wu/s — 56.7 wu/s headroom catches synthetic jumps). **New telemetry event:** `reef_race.bot_winrate.by_level_bucket` emitted from `reward-pipeline.ts` after every reef-race transaction commits — payload `{roomId, humanLevelBucket: '1-10'|'11-25'|'26-49'|'50', humanFinished, humanFinishedFirst, botCount, botFinishedAhead}`. Phase 3.5 graduation gate: if bot win-rate vs 26-49 / 50 humans crosses 5% sustained 7d, lift bots to level-matched. **No DB schema changes** — racing class derived purely from existing `avatars.archetype` via 14→4 lookup; `avatars.level` is already a column.)
>
> Prior audit 2026-04-24 (Phase 6 — Agent Session Liveness + ClawVille Orientation Skill. **Schema:** `openclaw_bots.session_expires_at` (nullable `timestamp`) added via `packages/database/src/schema/claws.ts` — sliding 24h TTL, null on legacy pre-Phase-6 rows (sweeper treats null as "needs backfill, skip" until next `/connect`). **New service:** `apps/api/src/services/openclaw-session-sweeper.ts` — `computeSessionExpiresAt()`, `extendSessionTtl()`, `expireSession()`, `sweepExpiredSessions()`, `startSessionSweeper()` / `stopSessionSweeper()`. Wired into `apps/api/src/index.ts` boot + `gracefulShutdown`. **New endpoints:** `GET /api/agent/session-status?agentId=` (liveness probe — 200 / 410 / 404, rate-limited 60/min/IP), `POST /api/agent/disconnect` (ed25519-signed logout, same pattern as `/reconnect`), `GET /api/auth/me/agent-session` (UI hydration — authoritative server-side connection state). **Existing route changes:** `/api/agent/connect` + `/api/openclaw/register` upsert paths now set `sessionExpiresAt = computeSessionExpiresAt()` on both insert and update; `/api/openclaw/chat` + `/api/openclaw/location-chat` slide TTL forward on every message; `/api/openclaw/unregister/:sessionId` flips `sessionExpiresAt = now()` immediately. SKILL.md at `/api/agent/connect-skill` teaches verify-liveness-first + signed-disconnect. **New shared constant:** `packages/shared/src/constants/orientation-skill.ts` — `CLAWVILLE_ORIENTATION_KNOWLEDGE` + `CLAWVILLE_ORIENTATION_SKILL` — consumed by town-guide template, `avatars.ts:buildCharacterConfig`, `agent-export.ts:buildSkillPack`. `packages/agent-templates` now depends on `@clawville/shared`. **New event type:** `agent.session.expired` emitted by sweeper + `agent.session.disconnected` emitted by `/disconnect`. **Frontend:** `apps/web/src/app/game/page.tsx` hydrates `agentConnected` from `/api/auth/me/agent-session` on mount + window-focus via new TanStack Query hook. Closes the "Hermes claimed connected for a week" gap. See `GameFeatures.md` §2.1 Session Lifecycle for user-facing details.)
>
> Prior audit 2026-04-23 (Guest avatar auto-create — un-authed visitors can play activity games + chat with NPCs as a throwaway "Guest Avatar" without signing up. New endpoint `POST /api/auth/guest` (idempotent for already-authed callers, rate-limited 5/min/IP). New schema columns `users.is_guest` + `users.guest_expires_at` + `avatars.is_guest` (additive migration `0004_guest_pet_columns.sql` — no destructive change). Frontend hooks at two trigger points: `setControlMode('npc')` in `apps/web/src/stores/game.ts` dispatches a `clawville:ensure-guest-avatar` window event that the new `GuestAvatarBootstrap` component listens for and calls `POST /api/auth/guest` + invalidates the avatar query; the activity lobby's `handleQueue` retries once after a 401 by calling `ensureGuestPet()` directly. Brand carve-outs (mirroring the chunk #10 bot pattern): per-activity leaderboards exclude guests via `NOT EXISTS (SELECT 1 FROM avatars WHERE avatars.id = activity_results.avatar_id AND avatars.is_guest = true)`; reward pipeline still credits ClawTokens but sets `leaderboardPoints = 0` for guests; `activity.match.placed` event payload gains `isGuest` flag; agent leaderboard SQL filters `payload->>'isGuest' <> 'true'` (defense in depth — guests have no `agent_id` so they're already excluded by the `agent_id IS NOT NULL` clause); `/dash` teacher-chat metric filters guest events. Town Guide knowledge updated. Cleanup cron deferred — see `scripts/TODO-prune-guest-avatars.md`.)
> Prior audit 2026-04-24 (Q2 Activity Portals chunk #12 — final polish: tutorial card + sound design + mobile B-button + spectator camera wiring. No new backend routes, no new DB tables, no schema changes. New frontend module `apps/web/src/lib/activity-audio.ts` (shared single-AudioContext SFX bus — iOS-friendly prime-on-gesture pattern, prefers-reduced-motion respected, mute toggle); new component `apps/web/src/components/game/activity/ActivityTutorialCard.tsx` (Nori-voiced first-time intro, localStorage gate); new component `apps/web/src/components/game/activity-mobile-controls.tsx` (touch A/B thumb buttons + left joystick for the activity route, replacing the open-world `mobile-controls.tsx` E-button surface mid-match). Placeholder silent WAVs at `apps/web/public/sounds/activity/*.wav` (11 files) — real CC0 assets need a separate licensing pass. SpectatorCamSelector (chunk #11) now feeds spectatorCamMode + targetPetId props to BumperShellsScene via lifted state on the activity route page.)
> Prior audit 2026-04-24 (Q2 Activity Portals chunk #8 — frontend portal + lobby UX shipped. No new routes, no new DB tables. New game-store fields + actions documented in `GameFeatures.md` §19.14. The chunk uses existing endpoints unchanged: `POST /api/activities/:id/queue`, `POST /:id/leave-queue`, `GET /:id/queue-status`, `GET /:id/leaderboard?window=daily|weekly&limit=N`. Tech-stack note: `apps/web/src/app/game/page.tsx` reads `window.location.search` directly for `?quickQueue=` because `useSearchParams()` would force the page into a Suspense boundary under Next 16's prerender pass — the page is `'use client'` and uses other window-only APIs throughout, so this stays consistent and avoids a build break.)
> Prior audit 2026-04-24 (Q2 Activity Portals chunk #5 — Reef Race sim + anti-cheat + bot live. New `activity/sim/reef-race-sim.ts` (30Hz tick, bespoke ~6000wu oval, 3 laps, 12 checkpoints in fixed sequence — out-of-order silently rejected; `MIN_LAP_MS=15s` discards + flags fast laps; emits `event.lap_completed` per lap and `event.match_ended` on finish). New `activity/sim/reef-race-config.ts` (track centerline + checkpoint AABBs + 6-power-up catalog: turbo-bubble/ink-slick/bubble-shield/seeker-jelly/tide-wave/whirlpool). New `activity/anti-cheat/reef-race.ts` reuses `BumperFlagCounter` for the 5-flag forfeit ceiling and adds `validateLapTime` + `validateCheckpointSequence` + `ReefCheckpointSkipTracker` (3+ skips in 5s → flag). New `activity/bots/reef-race-bot.ts` (registered under `'reef-race'` in `BOT_CONTROLLERS`). `index.ts` boot registers the Reef sim alongside Bumper for `setLiveTransitionFn` + `setComputeResultsFn` + WS hub broadcast/ended/integrity dispatch. `activity-ws-hub.ts` `handleInput` + `notifyForfeit` + `sendInit` dispatch on `room.activityId === 'reef-race'`. `activities.ts` REST `/state` route returns Reef sim snapshots when LIVE.)
> Prior audit 2026-04-24 (Q2 Activity Portals chunk #11 — spectator mode shipped on the frontend. Additive protocol changes only: `clientChatFrameSchema` + `clientEmoteFrameSchema` gain optional `spectator?: boolean`, and the server `chat` frame gains optional `spectator?: boolean` + `emote?: { emoteId: string }`. No new routes, no new tables, no DB migration. `activity-ws-hub.ts` already routes both frame types untouched; server-side spectator-channel fan-out + 15s rate-limit deferred to a future chunk. Frontend `useActivityStore` gains `chatLog: ActivityChatMessage[]` ring buffer + `pushChatLocal` action + `selectSpectatorChat`/`selectAliveEntities` selectors. See `GameFeatures.md` §19.15 for the user-facing surface.)
> Prior audit 2026-04-23 (Q2 Activity Portals chunk #7 — reward pipeline + per-activity leaderboards live. New service `reward-pipeline.ts` issues placement tokens + first-play-of-day bonus + Reef PB bonus + +25% focus-aligned bonus inside ONE composed DB transaction; bot filter (`subjectType==='bot'` → `tokensAwarded=0`, `leaderboardPoints=0`, no `creditClawTokens` call) lives in the pipeline per the chunk #10 carve-out. `persistResultsTransition` in `activity-room-manager.ts` invokes the pipeline via the new `setComputeResultsFn` callback (registered in `index.ts`, dispatches per-activity to `bumperShellsSim.computeResults`). New `activity-season-service.ts` auto-creates `2026-Q2-S1` (30-day) on first call. New `activity-leaderboard-service.ts` aggregates `activity_results` per `(activityId, window)` with 60s in-memory cache, bots excluded via `subject_type != 'bot'`. Six REST stubs in `activities.ts` replaced with real handlers (`/results`, `/recent-results`, `/acknowledge`, `/leaderboard`, `/leaderboard/me`, `/seasons`). Free-agent `AGENT_SCORE_WEIGHTS` extended with `activityPlacement: {1:30, 2:15, 3:8, default:2}` — `leaderboard.ts` SQL now sums `activity.match.placed` events per placement tier (bots excluded via `payload->>'subjectType' <> 'bot'`). New `activity_results.acknowledged_at` column applied via additive migration `0003_activity_results_acknowledged_at.sql`. Prior audit same-day chunk #10 — bot backfill controllers wired.)
> Prior audit 2026-04-21 (free agent leaderboard — Priority #3 public surface live at `/leaderboard` + `GET /api/leaderboard/agents`; new event-weighted scoring rubric documented under Observability; `leaderboard.ts` route module description rewritten to reflect the dual-surface mount pattern. Prior audit same day: Phase 5.1 — wallet identity + scape portal: 4 new event types (`identity.issued`, `identity.reconnected`, `portal.scape.crossed`, `portal.scape.linked`), new `/api/portal/*` + `/api/agent/{challenge,reconnect}` + `/.well-known/clawville-issuer.json` routes, new `pending_account_links` schema, new `users.identity_*` + `users.scape_*` + `users.linked_scape_*` columns, `wallets` table envelope-encryption columns (`dek_wrapped` + `encryption_version`), Cloudflare Secrets Store for crypto root-of-trust, new `service-issuer` + `auth-challenge` services. Previous same-day 2026-04-21 audit: metrics spine jump — added Observability section; new `events` + `event_write_failures` schemas; new `dashboard.ts` route mounted at `/api/dashboard`; Hono onError middleware now fires Telegram alerts via `alertError()`; new `event-logger.ts`, `alert-error.ts`, `admin-only.ts`; 6 event types emitted at 7 sites; `bazaar.ts`/`marketplace.ts`/`auctions.ts` write handlers stubbed to 503 pending post-overhaul skill-marketplace rework; FEATURE_GATE blocks on `x402-config.ts`, `agent-setup.ts`, and the three marketplace files. Previous 2026-04-17 audit: drift sweep — 7 missing route modules, 13 missing schema tables, Phase 5/6 sections, Service Layer catalog, ultrathink decommission noted.)

## System Overview

```
Browser (Next.js)                         Hetzner CCX13 + Coolify
+--------------------------+              +--------------------------+
|  Next.js App Router      |              |  Hono API (Bun :4000)   |
|  +--------------------+  |   REST/SSE   |  +--------------------+ |
|  | World3DCanvas (R3F) |  | <---------> |  | Auth (Lucia)       | |
|  | Three.js WebGPU     |  |             |  | Agent Orchestrator | |
|  +--------------------+  |              |  | NPC Simulation     | |
|  +--------------------+  |              |  +--------------------+ |
|  | Zustand Stores      |  |              |  | ElizaOS Runtime    | |
|  | (game, npc)         |  |              |  | (Gemini)           | |
|  +--------------------+  |              |  +--------------------+ |
|  +--------------------+  |              |          |              |
|  | React UI Overlays   |  |              |  +--------------------+ |
|  | (chat, shop, HUD)  |  |              |  | PostgreSQL         | |
|  +--------------------+  |              |  | (Drizzle ORM)      | |
+--------------------------+              +--------------------------+
```

## Frontend Architecture

**Framework**: Next.js 16 (App Router) with React 19. Note that in Next.js 15+, `cookies()`, `headers()`, and dynamic-route `params` are async — always `await` them. Server components that use `cookies().toString()` synchronously silently stringify to `"[object Promise]"` and forward garbage to downstream APIs (bit /dash once — see commit `6ac5da1`).

**Entry point**: `apps/web/src/app/game/page.tsx` -- dynamically imports `World3DCanvas` (SSR disabled) and mounts all game UI overlays as React components.

**Key layers**:
- **3D Renderer**: `World3DCanvas.tsx` -- Three.js WebGPU via React Three Fiber 9
- **3D Agent Picker**: `SelectAgentCanvas.tsx` -- rotating pedestal + 15 avatars for `/create-agent` (7 sea-creature GLBs + 8 Milady Official VRMs, added 2026-04-21). Replaces `LandingScene` on that page (never run both simultaneously on Iris Xe). Warm-preloads all 15 avatars at mount via `useGLTF.preload` (GLBs) and `preloadVRM` (VRMs). TSL node materials only for GLBs; VRMs use MToon pipeline unchanged (no color-tint clone — toon uniform system breaks when `.clone()`'d).
- **VRM loader**: `apps/web/src/lib/three/vrm-loader.ts` — Suspense-compatible module-cached loader. Registers `VRMLoaderPlugin` from `@pixiv/three-vrm@3.5.2` on a shared GLTFLoader, runs `VRMUtils.removeUnnecessaryVertices` + `combineSkeletons` + `rotateVRM0` after load. VRMs face -Z per VRM 1.0 spec (flipped opposite of GLB lobster +Z facing); DIR_ROTATION constants forked per avatar_type.
- **VRM animator**: `apps/web/src/lib/three/vrm-character-animator.ts` + `mixamo-retarget.ts` — loads 3 Mixamo clips once at module level (`/avatars/animations/{idle,walk,run}.glb`), retargets `mixamorig:*` bone tracks onto each VRM's VRMHumanBoneName via a canonical map, drives an AnimationMixer per VRM with 0.3s idle↔walk crossfade. Calls `vrm.update(dt)` each frame for spring-bone + look-at.
- **2D Fallback**: `PixiCanvas.tsx` -- PixiJS 8 for devices without WebGPU/WebGL2
- **UI Overlays**: Chat panel, shop, inventory, minimap, HUD, quest tracker, daily login
- **Agent connect modal**: `AgentConnectModal` (was `OpenClawConnectModal`) -- supports all agent types
- **State**: Zustand stores bridge the 3D scene and React UI

## 3D Rendering Pipeline

**Renderer**: Three.js r182 imported from `three/webgpu` with WebGL2 fallback.

**Avatar asset layout**:
- `apps/web/public/models/` — 7 sea-creature GLBs (lobster, sweet_crab, lobster_plush, hermitcrab, jellyfish, octopus_toy, sea_horse) + building/environment GLBs. Scale 10 via `MODEL_REGISTRY`. Color-tinted via `applyColorTint` (MeshStandardMaterial clone + emissive).
- `apps/web/public/avatars/` — 8 Milady Official VRMs (`milady-official-{1..8}.vrm`, ~12MB total), `previews/milady-official-{1..8}.png` thumbnails (~950KB), `animations/idle.glb`/`walk.glb`/`run.glb` Mixamo clips (~330KB). Total ~13.3MB. Source: `github.com/milady-ai/avatars`. Scale 13 via registry (VRMs are ~1.6m native → ~21 world units tall). Feet-at-origin per VRM spec — no pivot-offset hack.
- `@pixiv/three-vrm@3.5.2` + `@pixiv/three-vrm-animation@3.5.2` are the only non-three.js rendering deps. Peer-compatible with `three@0.182.0` (peer constraint `>=0.137`).

**R3F 9 integration**: WebGPU elements registered via `extend(THREE)` with custom JSX type declarations.

**Scene graph** (`World3DCanvas.tsx`):
1. `ArenaTerrain` -- Bikini Bottom GLB terrain + TSL sand material (ripples, grain, height roughness)
2. `ArenaBuildings` -- 10 GLB building models (SpongeBob-style) placed at building zone positions
3. `ArenaNpcs` -- GLB lobster NPCs with species color tinting, terrain following
4. `ArenaLocationNpcs` -- Dedicated NPC per building entrance, faces camera
5. `PlayerAvatar` -- Player's GLB lobster with WASD movement + terrain raycasting (Layer 1)
6. `MergedSeaweed` -- 3000 blades, 3 variants, TSL wind animation (merged geometry)
7. `UnderwaterAtmosphere` -- Caustics, depth backdrop, dust particles
8. `UnderwaterLightRays` -- 7 pulsing god ray shafts from surface
9. `QuestNpc`, `BountyBoardObject`, `BazaarPedestals`, `AuctionPodium` -- Gameify world anchors

**Materials**: TSL (Three.js Shading Language) only -- node-based materials compatible with WebGPU renderer.

**Camera**: OrbitControls with WASD pan (Explore mode) or character follow (Player/NPC modes). Arrow keys rotate orbit azimuth/polar in all modes.

## GPU Constraints

Target hardware: **Intel Iris Xe** (integrated GPU).

Hard rules:
- No `InstancedMesh` + `ShaderMaterial` -- crashes WebGPU silently with no console errors
- No drei `Text` or `Billboard` -- crashes Intel Iris Xe, requires PC restart
- No per-frame `Object3D` allocation
- Max 3 lights (hemisphere + ambient + 1 directional)
- Keep draw calls under 100 (currently ~50)
- Use merged geometry instead of instancing for repeated objects
- TSL-only materials (no raw GLSL ShaderMaterial)
- GLB models preferred (1-2 draw calls each vs many for primitive meshes)

## Backend Architecture

**Runtime**: Bun with Hono 4.x HTTP framework.

**Route modules** (`apps/api/src/routes/`):
| Route | Purpose |
|-------|---------|
| `auth.ts` | Login, signup, logout (Lucia sessions) + `GET /api/auth/enter?t=ticket` (Phase 5 magic-link exchanger) + `POST /api/auth/milady-session-exchange` + `POST /api/auth/guest` (un-authed visitor bootstrap — mints throwaway user + avatar so the play-now flow works without signup; idempotent for already-authed callers, rate-limited 5/min/IP) |
| `avatars.ts` | Avatar CRUD, avatar chat, heartbeat (`POST /api/avatars/me/heartbeat`), daily login (`POST /api/avatars/me/daily-login`) |
| `locations.ts` | Location data |
| `chat.ts` | Two surfaces: `POST /api/locations/:id/chat` (per-building location agent chat w/ dynamic context injection) + `POST /api/chat/system/:slug` (world-wide system-agent chat — today `town-guide`; future arena host / quest giver / etc.). System-agent route 503s with `Retry-After: 3` during boot-race, rate-limits rewards to one per `(userId, slug)` per 60s via `systemAgentRewardLimiter`, and logs events with `chatType='system-agent'` (deliberately excluded from `/dash` teacher-chat metric). |
| `items.ts` | Shop browse, inventory, buy, learn |
| `agent-gateway.ts` | Universal agent connection (connect-token, polling, SKILL.md, SSE events). Phase 5.1 adds `POST /api/agent/challenge` (issue nonce for signed-challenge reconnect) and `POST /api/agent/reconnect` (signed-challenge auth, mints session ticket). `POST /api/agent/connect` + `POST /api/agent/join` also gain an `identity` block + a `wallet` block in the first-time response (see Phase 5.1 section below). |
| `portal.ts` | Phase 5.1 cross-world portal. `POST /api/portal/scape` (ClawVille → 'scape, Lucia-authed, signs the outbound request with the service issuer keypair). `POST /api/portal/mint-for-scape` ('scape → ClawVille reverse portal, partner-signature-authed, mints a magic-link ticket). `POST /api/portal/accept-scape-link` ('scape → ClawVille, link existing 'scape account to existing ClawVille user — consumes a `pending_account_links` code). `POST /api/portal/scape-link-code` (Lucia-authed, ClawVille user generates a one-time code to paste in 'scape). `GET /.well-known/clawville-issuer.json` publishes the service issuer pubkey (served as a Hono route on the API — NOT a Next.js route — to avoid Next's special-case handling of `.well-known/*`). |
| `admin/identity-recover.ts` | `POST /api/admin/identity-recover` — admin-gated stub. Returns 501 Not Implemented behind `FEATURE_GATE: admin_identity_recovery`. Support-chat identity-recovery workflow not launched; graduates when `support.identity_recovery_requests > 5/week` on the events table AND support-chat service is live. Review deadline 2026-07-01. |
| `agent-export.ts` | `POST /api/agent/export-character` — emits Eliza `Character` JSON + `SkillPack` + Milady install payload + curl one-liner (Phase 3 of the create-agent rollout; Phase 4a UI consumes this) |
| `agent-setup.ts` | Multi-agent roster + loadout + import/export (`MAX_AGENTS = 1` currently enforced) |
| `agent-v2.ts` | `/api/v2/agent` — experimental alternate agent gateway surface (new shape under review) |
| `openclaw.ts` | Legacy OpenClaw bot registration (kept for backwards compat — the Manual tab was removed from the UI in commit `984627d` but this endpoint still accepts direct POSTs) |
| `npc-sse.ts` | Server-Sent Events for NPC simulation state |
| `activity.ts` | Activity feed backing the sidebar Activity Log |
| `research.ts` | Research article fetch / scrape (powers the thought-log research stream) |
| `research-sse.ts` | `/api/research` SSE stream feeding `ThoughtLog` component |
| `claws.ts` | ClawToken ledger + balance surface (reads `claw_token_transactions`) |
| `bazaar.ts` | Skill marketplace (browse, list, buy). **⏸ WRITES PAUSED (2026-04-21)** — a file-level middleware returns 503 for POST/PUT/PATCH/DELETE pending skill-marketplace rework. GET reads still work. See Brand Identity §3 + improvements.md §7. |
| `marketplace.ts` | Published-skills marketplace w/ upvotes — distinct from `bazaar.ts` (bazaar = fixed-price listings, marketplace = free publish+upvote tier). **⏸ WRITES PAUSED (2026-04-21)** — same gate as bazaar. |
| `auctions.ts` | Skill auction house (timed auctions + bidding). **⏸ WRITES PAUSED (2026-04-21)** — same gate as bazaar. The 10s resolution interval still runs but has nothing to resolve since no new auctions can be created. |
| `quests.ts` | Quest board |
| `bounties.ts` | Bounty board |
| `leaderboard.ts` | Two surfaces on one mount: (a) `GET /api/leaderboard` — legacy composite economy board (auth'd, consumed by the in-game `leaderboard-modal.tsx`); (b) **`GET /api/leaderboard/agents`** — public free agent leaderboard (no auth, rate-limited 60/min/IP, 60s in-memory cache per window). The `/agents` path is the canonical Priority #3 surface and is consumed by `apps/web/src/app/leaderboard/page.tsx`. See Observability §"Free Agent Leaderboard" below for the scoring rubric + query plan. |
| `skills.ts` | `GET /api/skills`, `GET /api/skills/:buildingId`, `GET /api/skills/:buildingId/skill.md` — served from cached `building_skills` table, NOT re-generated on every hit. Emits `skill_md.fetched` on every `.md` fetch (agent id + session from `x-clawville-agent-id` / `x-clawville-session-id` headers when present). |
| `dashboard.ts` | `/api/dashboard/*` — admin-gated (`ADMIN_USER_IDS` env allowlist) via `adminOnly` middleware. `GET /overview` returns DAU + Milady-origin %, connect→engagement funnel, returning-day rate, agent↔agent collaboration count, teacher-chat count, and buildings-by-visits chart data. `POST /__test-alert` fires a Telegram alert via `alertError()` for channel verification. Consumed by `apps/web/src/app/dash/page.tsx`. |
| `wager.ts` | **Wager lobbies + escrow** (2026-05-12). Wraps the deployed `clawville_wager` Anchor program (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG` on devnet). Surfaces: `POST /api/wager/lobbies` (create — Lucia auth), `GET /api/wager/lobbies` (list — public, filter on `activityId`, `roomId`, `state`, `mine`), `GET /api/wager/lobbies/:idOrInviteCode` (single + players list), `POST /api/wager/lobbies/:id/join` (deposit + join), `POST /api/wager/lobbies/:id/lock` (admin/match-server), `POST /api/wager/lobbies/:id/settle` (admin/match-server — body `{winnerAvatarId}`), `POST /api/wager/lobbies/:id/cancel` (creator if `state='open'`, admin if `state in ('open','locked')`), `POST /api/wager/lobbies/:id/refund` (per-player after cancel). Three modes: `multiplayer` (real on-chain escrow), `solo-bots` (no escrow, no on-chain footprint), and visibility `public`/`private`/`friends` (latter two require an invite code). Rake hard-coded to 500 bps (5%) snapshot at create time. Feature gates: `wager-spl-lobbies` (SPL routes refuse today; schema-ready), `wager-mainnet-paid` (devnet-only RPC). |

**Write handlers paused (2026-04-21, pivot to free agent leaderboard):** `bazaar.ts`, `marketplace.ts`, `auctions.ts` now return 503 on `POST`/`PUT`/`PATCH`/`DELETE` via a file-level middleware gate. GET reads still work; the 3D bazaar/auction/pedestal surfaces render without inventory. See Brand Identity §3 + `improvements.md` §7.

## Observability

All meaningful app actions write a row into the `events` table via `logEvent()` (`apps/api/src/services/event-logger.ts`). Three-tier fallback — primary insert → `event_write_failures` row on failure → `alertError()` Telegram ping on double failure. The `/dash` admin surface queries `events` exclusively.

**Emitted event types (6):**

| Event | Source site | Payload highlights |
|---|---|---|
| `agent.connected` | `POST /api/agent/connect` (`agent-gateway.ts`) | `identityType`, `protocol`, `isReturning`, `miladyAgentId`, `hasGateway` |
| `skill_md.fetched` | `GET /api/skills/:buildingId/skill.md` (`skills.ts`) | `userAgent`, `referer`, `skillName`, `generatorVersion` |
| `building.visited` | `POST /api/agent/:sessionId/visit-building` (`agent-gateway.ts`) | `tokenAwarded`, `activity`, `knowledgeGained` |
| `agent.chat.turn` | `chat.ts` (location + system-agent), `avatars.ts` (avatar), `agent-gateway.ts` (`:sessionId/chat`, `:sessionId/building/:buildingId/chat`) | `chatType: 'avatar' \| 'location' \| 'character' \| 'building' \| 'system-agent'`, `messageLength`, `tokenAwarded`, optional `agentSlug` when `chatType='system-agent'`. Dashboard teacher-chat query filters to `chatType IN ('building','location')` only. |
| `agent.collaboration.turn` | `agent-collaboration.ts` (one per consulted expert) | `sourceBuildingId`, `targetBuildingId`, `kind: 'cross-building-consultation'` — Brand Identity §3 axis #1 |
| `tokens.settled` | Inside `transferClawTokens()` in `claw-token-ledger.ts`, after the atomic transfer | `amount`, `fromAvatarId`, `toAvatarId`, `reason` — off-dashboard telemetry |
| `identity.issued` | `POST /api/agent/connect`, `POST /api/agent/join` (`agent-gateway.ts`) | `identityType`, `identityPubkey`, `via: 'connect' \| 'join'` — `userId` + `avatarId` + `agentId` + `sessionId` live on the top-level event columns, not the payload |
| `identity.reconnected` | `POST /api/agent/reconnect` (`agent-gateway.ts`) | `via: 'signed-challenge'` |
| `portal.scape.crossed` | `POST /api/portal/scape`, `POST /api/portal/mint-for-scape` (`portal.ts`) | Outbound: `direction: 'clawville_to_scape'`, `principalId`, `worldCharacterId`, `ticketRefHash`, `ttlMs`. Inbound: `direction: 'scape_to_clawville'`, `principalId`, `ticketRefHash`, `requestingScapePrefix` (16-char prefix). Companion `portal.scape.cross_failed` fires on fetch error / partner 4xx–5xx / bad JSON. |
| `portal.scape.linked` | `POST /api/portal/accept-scape-link` (`portal.ts`) | `scapePrincipalPrefix` (16-char prefix), `scapeDisplayName`, `linkCodeHash` |

**Alert system (`apps/api/src/services/alert-error.ts`):** rate-limited Telegram pings via the itachi-debug bot. Same `source::message` combo collapses to one alert per 60s with a suppressed-count suffix. Required env vars: `ITACHI_DEBUG_BOT_TOKEN`, `ITACHI_DEBUG_CHAT_ID`. Called from `event-logger.ts` on double failure, from the Hono `onError` middleware on uncaught exceptions, and from any business-critical code path that wants to page the admin.

**Deferred telemetry (Tier 2 in `improvements.md` §7):** `agent.memory.persisted` (Eliza memory substrate health), `agent.mode_change` (human takeover moments), progression cards. Tier 3: outcome linkage + behavior-change detection for true agentic RLM.

### Free Agent Leaderboard (CLAUDE.md Priority #3)

The public leaderboard at `GET /api/leaderboard/agents` consumes the same `events` spine that `/dash` uses, but without the admin gate. It is the user-facing answer to "who is contributing the most to ClawVille right now?". No auth, rate-limited 60 req/min per IP, 60s in-memory cache per window.

**Q3 2026-04-28 rebalance + Player tier groundwork — `.claude/plans/gamification-economy-and-shop-q3.md` §2.4-§2.5.** Weights retuned to make agent↔agent collaboration (40 pts) the highest-scoring event, daily caps added per `(subject, day)` for anti-farm, and an avatar-keyed UNION added so solo Players (no agent) rank on the same board as Trainers. Same scoring engine, two `subject_type` tags (`'agent'` / `'avatar'`).

**Scoring rubric** (must stay in sync with `apps/api/src/routes/leaderboard.ts` `AGENT_SCORE_WEIGHTS` + `DAILY_CAPS` and the landing UI `WEIGHTS`):

| Event | Weight | Daily cap | Rationale |
|---|---|---|---|
| `building.visited` | 3 pts | 10 | One-shot, easy to script — was 10 pts pre-rebalance, lowered |
| `agent.chat.turn` | 10 pts | 50 | MiladyAI teacher chat — THE learning event. Was 5; promoted because Brand Identity says learning is load-bearing |
| `agent.collaboration.turn` | 40 pts | 50 | Agent↔agent consultations — Priority #3 signal; highest single event |
| `skill_md.fetched` | 1 pt | 11 | A curl is not engagement. Was 3; lowered |
| Unique `agent.connected` session | 1 pt | none | Counted via `COUNT(DISTINCT session_id)`. No cap — sessions are inherently rare |
| `identity.issued` | 5 pts | n/a | One-time per agent, wrapped in `MAX(...) * 5` |
| `activity.match.placed` (1st) | 12 pts | 10 total | Was 30; lowered so a single race < 1.2 teacher chats |
| `activity.match.placed` (2nd) | 6 pts | 10 total | Was 15 |
| `activity.match.placed` (3rd) | 3 pts | 10 total | Was 8 |
| `activity.match.placed` (other) | 1 pt | 10 total | Was 2 — participation tier |

**Daily-cap implementation:** the SQL aggregates per `(subject_id, date_trunc('day', ts))` first via inner CTE, applies `LEAST(count, cap)` per event_type per day, then sums capped daily counts × weights across the window. Activity placements share a single per-day cap of 10 total; per-tier weighting is preserved by scaling `(wins×12 + silver×6 + bronze×3 + other×1)` proportionally by `LEAST(total, 10) / total` when total > 10. See `apps/api/src/routes/leaderboard.ts:agent_daily` / `avatar_daily` CTEs.

**Avatar-keyed UNION (Player tier groundwork):** separate `avatar_daily` CTE pulls events where `agent_id IS NULL AND avatar_id IS NOT NULL` (a Player's events). Same scoring math, tagged `subject_type = 'avatar'`. Disjoint event sets — Trainer events (with both agent_id and avatar_id populated) only count under the agent path, never double-counted. Frontend Phase 2 adds filter chips (`All` / `Players` / `Trainers`); the API returns `subjectType` on every entry from day one.

**Anti-farm fingerprint:** every event row carries `fp_hash` and `ip_prefix_hash` populated by `apps/api/src/middleware/fingerprint.ts` from a sha256 of `FINGERPRINT_SECRET || raw_browser_fingerprint` (and `FINGERPRINT_SECRET || ip_first_3_octets`). Non-portable (server secret never leaves DB), permanent (no daily rotation, so multi-day farms are detectable). Fallback chain when the `X-CV-Fingerprint` header is missing: hash of `UA + IP`, then sentinel `no-fp:<ipPrefix>`. Future iterations can squash via `(fp_hash, ip_prefix_hash, day)` cap correlation; the daily-count caps above are the current first-line defense.

**Bot filter for activity placements:** `payload->>'subjectType' <> 'bot'`. Bot rows DO emit `activity.match.placed` for telemetry (chunk #10), but their agentId is null + subjectType='bot', so SQL filtering excludes them from the leaderboard. Per chunk #10 carve-out documented inline at `apps/api/src/routes/leaderboard.ts:ACTIVITY_PLACEMENT_WEIGHTS`.

**Query plan:** two filtered scans (agent_id partial, avatar_id partial) feeding hash aggregates per (subject, day), then a UNION ALL of `agent_scores` + `avatar_scores`. PostgreSQL backs this with `idx_events_agent_ts` / `idx_events_avatar_ts` / `idx_events_type_ts`. A `WHERE score > 0` filter on the outer SELECT drops zero-score subjects so the `totalRanked` count reflects the true qualifying population.

**After-pass batch joins:** for `subject_type = 'agent'` rows, two `inArray` round-trips — `openclaw_bots` (for `name` + `userId` + `walletAddress`) then `avatars` for the bound human's avatar. For `subject_type = 'avatar'` rows, one `inArray` against `avatars` directly using the avatar UUID. Never a cartesian.

**Window parameter:** whitelisted enum (`24h` / `7d` / `30d` / `all`) — the string is mapped to a fixed interval literal via `sql.raw` AFTER the whitelist check, never user-interpolated.

**Empty DB / transient error:** returns `{ agents: [], totalRanked: 0 }` instead of 500. The page renders an empty-state card with the "Enter ClawVille" CTA so a fresh deployment still has a valid public URL to link.

**Cache invalidation:** 60s TTL keyed on `window`. No manual bust — a ranked change that happens mid-window is visible at most 60s later to viewers. Acceptable because (a) rank changes are slow in absolute terms and (b) the staleness is bounded, not indefinite.

**What's NOT counted:** ClawToken balance, skills sold, auctions won, quest completions. Those belong to the paused paid-marketplace surfaces (CLAUDE.md Priority #3 pivot note). When/if quests/bounties are re-anchored as contribution events, they land here via new event types, not by joining against domain tables.

## Agent Connection Architecture (Moltbook Pattern)

External agents connect via an **agent-initiated flow** — no credentials are pasted by the human.

```
Human                          ClawVille API                    AI Agent
  |                                 |                              |
  |-- Generate Connect Link ------->|                              |
  |<-- {token, connectUrl} ---------|                              |
  |                                 |                              |
  |-- Paste connectUrl into agent chat --------------------------->|
  |                                 |                              |
  |                                 |<-- GET /api/skills/connect --|
  |                                 |-- SKILL.md with instructions->|
  |                                 |                              |
  |                                 |<-- POST /api/agent/connect --|
  |                                 |    {connectionToken: "ct-..."}|
  |                                 |-- {sessionId, agentId} ----->|
  |                                 |                              |
  |-- Poll /connect-status/:token ->|                              |
  |<-- {connected: true} -----------|                              |
```

**Endpoints** (all under `/api/agent`):

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/connect-token` | Generate 5-min connection token | `clawville_session` cookie |
| GET | `/connect-status/:token` | Frontend polls for connection status | none |
| GET | `/connect-skill?token=xxx` | Machine-readable SKILL.md for agents (aliased at `/api/skills/connect`) | none |
| POST | `/connect` | Universal agent registration — accepts `connectionToken`, `agentId`, or `miladyAgentId` | token or identity |
| GET | `/:sessionId/perception` | Current world perception (self + nearby NPCs/buildings + conversations + combats) | session-resolved |
| POST | `/:sessionId/move` | Move NPC to `{targetX, targetY}` or `{buildingId}` | session-resolved |
| POST | `/:sessionId/chat` | Speak as NPC + route via ElizaOS | session-resolved |
| POST | `/:sessionId/visit-building` | Enter a building, award +1 ClawToken + trigger knowledge extraction | session-resolved |
| POST | `/:sessionId/building/:buildingId/chat` | Initiate a teaching conversation with the building's resident character (Gary/Patrick/etc.). Routes through the system NPC's ElizaRuntime — grounded in the compiled SKILL.md. Awards +1 ClawToken + persists the exchange into `openclaw_bots.knowledge[]`. Requires proximity (<2000px). | session-resolved |
| POST | `/:sessionId/combat-action` | Pick a combat action | session-resolved, must be `inCombat` |
| POST | `/:sessionId/emote` | Set activity emoji | session-resolved |
| GET | `/:sessionId/knowledge` | Export learned knowledge for the agent's NPC | session-resolved |
| GET | `/:sessionId/stats` | Session stats (HP, tokens, visits, etc.) | session-resolved |
| GET | `/:sessionId/events` | SSE stream (world state + chat + combat events) | session-resolved |

**Identity types**: `openclaw`, `ironclaw`, `nanoclaw`, `milady`, `custom`, `anonymous`

**Wire protocols**: `openai-compat`, `anthropic`, `custom-webhook`, `nanoclaw` (pull-based SSE)

**Rate limits**: `POST /connect` — 10/min per IP. `POST /connect-token` requires auth cookie; tokens have 5-min TTL.

**Agent Orchestrator** (`apps/api/src/services/agent-orchestrator.ts`):
- Lazy-starts ElizaOS agents on first chat message
- Auto-stops after 30 minutes of inactivity
- Uses `createElizaRuntime` from `@clawville/agent-runtime`
- LLM backend: **Gemini only**. `plugin-anthropic` and `plugin-openai` were fully
  removed in the ultrathink decommission on 2026-04-10 — `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY` are no longer read anywhere. `gemini-text-provider` (priority
  95) handles `TEXT_SMALL` / `TEXT_LARGE`, `gemini-embedding-provider` (priority
  100) handles `TEXT_EMBEDDING`. Runtime plugins: `plugin-sql` + these two Gemini
  providers. See `docs/ultrathink-migration-decision.md`.

**System NPC Seeder** (`apps/api/src/services/system-npc-seeder.ts`):

Two seeders run on boot, both idempotent, both owned by the
`openclaw-system@clawville.internal` user:

1. **`ensureSystemAgents()`** — world-wide NPCs not tied to a building.
   Today: Town Guide (slug `town-guide`). Future: arena host, quest giver,
   etc. Each template is registered under its slug in `SYSTEM_AGENT_TEMPLATES`
   (`packages/agent-templates/src/index.ts`). Rows go into `platform_agents`
   as `type='system-agent'` with `customization.slug=<slug>`. Uniqueness is
   enforced by the partial index `platform_agents_system_singleton` on
   `(user_id, type, customization->>'slug') WHERE type='system-agent'`.
   Lookups use `getSystemAgent(slug)` — NEVER by name. Chat surface is
   `POST /api/chat/system/:slug`. On boot we run this seeder FIRST, then
   eager-warmup each runtime via `agentOrchestrator.ensureAgentRuntime()` so
   the first visitor doesn't eat lazy-start latency. The inactivity sweep
   in `agent-orchestrator.ts` SKIPS system agents — they are singletons the
   world depends on, stopping one would 503 the next visitor until boot.
   **Adding a new system agent**: write a template file, register the slug
   in `SYSTEM_AGENT_TEMPLATES`, ship — the seeder handles upsert + index
   maintenance + warmup automatically on the next boot.
2. **`ensureSystemNpcs()`** — ensures every one of the 10 buildings has a
   system-owned ElizaOS character loaded with its compiled SKILL.md as RAG
   knowledge. 10 SpongeBob-canon characters from `@clawville/agent-templates`
   → merged with `building_skills.content` chunks → written to
   `platform_agents.customization.knowledge`. Paired with a `location_agents`
   row keyed by `(systemUserId, locationId)`.
- Chat handlers (`chat.ts`, agent-gateway building-chat) fall through to these
  rows when the caller has no personal override, so every user and every
  autonomous agent can chat with Gary/Patrick/Sandy/etc. without any setup

**NPC Simulation** (`apps/api/src/services/npc-simulation.ts`):
- Autonomous NPCs with pathfinding, conversations, and activities
- State streamed to clients via SSE

## Phase 5 — Agent-Issued Magic-Link Login (commit `b527636`)

Lets a connected agent mint a one-time login URL for its human operator
without exchanging passwords or OAuth.

```
Agent                        ClawVille API                  Human browser
  |                               |                             |
  |-- POST /api/agent/:s/issue ->|                             |
  |                               | insert agent_session_tickets|
  |<-- {url: /api/auth/enter?t=} -|                             |
  |-- DM url to human -------------------------------------->   |
  |                               |<-- GET /api/auth/enter?t=xxx|
  |                               | ticket valid? consumed?      |
  |                               | mint Lucia session cookie    |
  |                               |-- 302 Location: /game ---->  |
```

- **Table**: `agent_session_tickets` (random 32-byte token, 5-min TTL, `consumed_at`).
- **Service**: `apps/api/src/services/session-ticket-service.ts`.
- **Exchanger**: `GET /api/auth/enter?t=<ticket>` (`auth.ts:188-229`) — validates, marks consumed, mints cookie, redirects.
- **Failure path**: expired/consumed ticket → redirect with `?error=expired-link` → `ExpiredLinkBanner` on landing (`app/page.tsx:21-56`).

## Phase 6 — Per-User Building-Character Memory Isolation (commit `51e97cb`)

Every user who talks to the same building-resident agent gets an isolated
memory partition. One ElizaOS runtime per character, partitioned rooms per
(userId, locationId).

- **Primitive**: `characterRoomId(locationId, userId) → UUIDv5` in
  `packages/agent-runtime/src/room-scoping.ts`. Namespace
  `8f3b1b27-5f2a-4a8d-9c1d-2e7b4d1f6a9c`.
- **Read/write gate**: `processMessage` inside `@clawville/agent-runtime` keys
  every memory lookup on the derived `roomId`. Legacy string `roomId`s are
  ignored.
- **Terminology**: the 10 building residents are called **characters**
  (SpongeBob, Squidward, Mrs. Puff, Larry, Mr. Krabs, Plankton, Sandy,
  Patrick, Karen-as-assistant, Gary-as-assistant); wandering NPCs stay NPCs.

## Phase 5.1 — Wallet Identity + 'scape Portal (plan `.claude/plans/phase5.1-wallet-identity-and-scape-portal.md`)

Replaces the Phase 5 string-based `identity_fingerprint` anchor with an
ed25519 keypair the user's agent owns, splits identity from wallet so agent
config leakage cannot drain $CLAWVILLE, and wires a signed cross-world
portal to 'scape (`github.com/Dexploarer/scape`).

**Three keypair roles, per user:**

```
users.id (UUID PK, stable)                  ← identity handle; never rotates
├── identity keypair (ed25519)
│    pub: users.identity_pubkey             ← rotatable; may change without breaking users.id
│    priv (primary): agent config           under `clawville:identity:<userId>`
│    priv (backup):  users.identity_encrypted_sk  ← envelope-encrypted, support-recovery only
│    purpose: sign reconnect challenges;
│             derives portal principalId `principal:clawville:<user.id>`
│
└── avatar wallet keypair (Solana ed25519)
     row: wallets{subject_type='avatar', subject_id=avatar.id}
     pub: wallets.public_key                ← mirrored to avatars.walletAddress
     priv (server): wallets.encrypted_secret_key  ← envelope-encrypted under Cloudflare KEK
     priv (human):  disclosed ONCE in first-connect response (only approved export channel)
     priv (agent):  does NOT hold
     purpose: holds $CLAWVILLE; server signs transactions custodially;
              human keeps a backup copy for eventual self-custody
```

Plus a **service issuer keypair** (ed25519 singleton, not per-user) whose
private key lives in Cloudflare Secrets Store and whose public key is
published at `GET /.well-known/clawville-issuer.json`. Used to sign outbound
partner API calls (e.g. 'scape's `/hosted-session/issue`). The inbound
mirror is `PARTNER_PUBKEYS` — a JSON allowlist env var — verified against
incoming `X-Scape-Issuer-Pubkey` + `X-Scape-Signature` headers on
`/api/portal/mint-for-scape` and `/api/portal/accept-scape-link`.

**Reconnect (signed-challenge):**

```
Agent                              ClawVille API
  |-- POST /api/agent/challenge -->|
  |<-- { nonce, expiresAt } -------|   60 s TTL, single-use, in-memory Map
  |                                |
  |-- POST /api/agent/reconnect -->|
  |   { userId, nonce,             |
  |     signature: ed25519.sign(   |
  |       nonce, identityPrivKey)} |
  |                                |   Verify sig against users.identity_pubkey
  |                                |   Mint Lucia session ticket (reuses Phase 5 pipeline)
  |<-- { sessionTicket.url, ... }--|
```

The wallet private key is not involved in reconnect. It only ever signs
on-chain transactions, which the server still does custodially.

**Atomic identity bootstrap** handles the concurrent-first-connect race with
a conditional update — `UPDATE users SET identity_pubkey = $1, ... WHERE
id = $2 AND identity_pubkey IS NULL RETURNING`. Race losers get
`needsHumanReauth: true` and don't overwrite their agent config.

**Envelope encryption (`apps/api/src/services/keypair-vault.ts`):** every
encrypted secret (identity sk, wallet sk) gets a random 32-byte DEK. The
DEK is wrapped by the master KEK held exclusively in Cloudflare Secrets
Store; wrapping happens via a tiny Cloudflare Worker at
`CLOUDFLARE_WORKER_URL` (POST `/wrap`, `/unwrap`, bearer-authed against
`CLOUDFLARE_WORKER_BEARER`). Hetzner never sees plaintext KEK. DB dump
alone is non-decryptable; attacker needs KEK unwrap access too. Read path
dispatches on `encryption_version` so v1 and v2 rows coexist cleanly.

**Portal (ClawVille → 'scape):** authenticated ClawVille user clicks "Cross
to 'scape" → `POST /api/portal/scape` → server builds a canonical-JSON
payload (kind, principalId, worldCharacterId, displayName, agentId, ttlMs),
signs `sha256(body)` with the service issuer private key, POSTs it to
`SCAPE_HOSTED_SESSION_URL` with `X-Clawville-Issuer-Pubkey` +
`X-Clawville-Signature` headers, emits `portal.scape.crossed`, and returns
`{ redirectUrl }`. First crossing backfills `users.scape_principal_id` +
`users.scape_world_character_id`. Frontend opens the redirect in a new tab.

**Portal ('scape → ClawVille, reverse):** symmetric. 'scape POSTs to
`/api/portal/mint-for-scape` with their signature; we verify against
`PARTNER_PUBKEYS.scape`, mint a Phase 5 magic-link ticket, return
`{ redirectUrl: "https://clawville.world/enter?t=..." }`.

**Account linking (plan §15):** users with an existing 'scape account
generate a one-time link code via `POST /api/portal/scape-link-code`
(Lucia-authed). They paste it into 'scape's "Link External Account" UI;
'scape posts the code + their signed payload to
`/api/portal/accept-scape-link`. We consume the `pending_account_links`
row atomically and set `users.linked_scape_principal_id /
linked_scape_world_character_id / linked_scape_display_name /
linked_scape_at`. Portal-minter priority: linked wins over auto-provisioned.

**Migration from Phase 5 users.** Phase 5 users keep working. On their next
`/api/agent/connect` call, if `users.identity_pubkey IS NULL`, the server
generates + envelope-stores a fresh ed25519 keypair, returns it in the
response, and the agent updates its config. Legacy `identityKey` string
calls still resolve the same user via fingerprint fallback — no forced
cutover.

See also: `infra/cf-secrets-worker/README.md` (Worker deployment + KEK +
bearer rotation runbook) and `scripts/generate-service-issuer-keypair.ts`
(service issuer keypair generator — rotation procedure is documented in
that script's JSDoc: generate fresh pair, paste into Coolify env,
publish new pubkey via `/.well-known/clawville-issuer.json`, notify each
partner so they hot-reload their allowlist).

## Middleware (`apps/api/src/middleware/`)

| File | Applied | Purpose |
|---|---|---|
| `auth.ts` | Global `sessionMiddleware` via `.use('*', ...)` on `app.ts` + per-route `requireAuth` | Resolves Lucia session cookie → `c.get('user')` / `c.get('session')`. `requireAuth` variant throws HTTPException(401) if no session. |
| `rate-limit.ts` | `/connect` (10/min/IP), `/export-character` (Cloudflare-safe IP via `cf-connecting-ip` preferred over LAST XFF token) | Shared `createRateLimiter` + `getClientIp` helpers. Rate limiting is IP-based with periodic cleanup. |
| `admin-only.ts` | `/api/dashboard/*` (via `dashboardRoutes.use` + `adminOnly` per route) | Reads `ADMIN_USER_IDS` env var at module load. Returns 401 when no user, 403 when user not on allowlist. Must run AFTER `sessionMiddleware` so `c.get('user')` is populated. |

## Service Layer (`apps/api/src/services/`)

The service catalog (alphabetical — these are the production dependencies the
route layer composes against, not the route files themselves):

| Service | Purpose |
|---|---|
| `agent-collaboration` | Helper for agent-to-agent co-op (used by autonomy). Emits `agent.collaboration.turn` event per consulted expert — see Observability. |
| `agent-orchestrator` | Lazy-start / auto-stop Eliza runtimes (see above) |
| `alert-error` | Immediate Telegram alerts via the itachi-debug bot. Rate-limited by `${source}::${message}` (1/60s with suppressed-count suffix). Called from `event-logger` (tier-3 DB down), Hono `onError` (uncaught exceptions), and any business-critical code path. Required env: `ITACHI_DEBUG_BOT_TOKEN`, `ITACHI_DEBUG_CHAT_ID`. Degrades to `console.warn` when creds missing. |
| `article-scraper` | Pulls + normalizes external research articles into `research_articles` |
| `claw-token-ledger` | Canonical write path for `claw_token_transactions` — never bypass. `transferClawTokens()` wraps the atomic 2-avatar transfer + emits `tokens.settled` on success. |
| `eliza-migrator` | Pre-migrates ElizaOS internal schema at API boot (fixes v2 schema drift) |
| `event-logger` | Fire-and-forget analytics writer — `logEvent({...})` is the single entry for every emitted event. Three-tier fallback: `events` table → `event_write_failures` safety-net table → console + Telegram alert. Never throws. Sanitizes payload keys that look sensitive (word-list + danger-substring detector, verified against 43 edge cases). See Observability. |
| `hermes-client` | Outbound bridge to a user-hosted Hermes agent (OpenAI-compat gateway) |
| `auth-challenge` | Phase 5.1 in-memory nonce store (`apps/api/src/services/auth-challenge.ts`) for the signed-challenge reconnect path. `issueChallenge()` returns `{ nonce, expiresAt }` (32-byte random nonce, 60 s TTL). `consumeNonce()` atomically deletes-on-read so every nonce is single-use. Periodic cleanup via `setInterval`; 10 k-entry spam cap. Same pattern as the existing `pendingConnections` Map in `agent-gateway.ts`. Migrate to Redis when we go multi-node. |
| `identity-service` | Maps `sha256('{type}:{key}')` to a `users` row via the `identity_fingerprint` column. Phase 5.1 extends it with `generateIdentityKeypairForUser(userId)` — generates an ed25519 keypair, envelope-encrypts the secret via `keypair-vault.encryptSecretKeyEnveloped`, and writes it atomically to `users.identity_pubkey` using a conditional `UPDATE ... WHERE identity_pubkey IS NULL RETURNING` pattern. Race losers (concurrent first-connect) get `needsHumanReauth: true` so their agent doesn't overwrite its config with a losing keypair. |
| `keypair-vault` | AES-256-GCM wrap/unwrap for `wallets` + `vanity_keypairs`. Phase 5.1 adds envelope-encryption helpers: `encryptSecretKeyEnveloped(sk)` → `{ encryptedSecretKey, encryptionIv, encryptionTag, dekWrapped, encryptionVersion: 2 }`, `decryptSecretKeyEnveloped(row)` → `Keypair`, and a `decryptWalletRow(row)` dispatcher that picks v1 vs v2 off `row.encryptionVersion`. Per-row DEKs are wrapped by a Cloudflare-held KEK via the Cloudflare Worker (`/wrap` + `/unwrap`, see Cloudflare integration below); plaintext KEK is never present on the Hetzner box. |
| `service-issuer` | Phase 5.1 singleton service keypair at `apps/api/src/services/service-issuer.ts`. `signPayload(body)` signs outbound partner API calls (e.g. 'scape's `/hosted-session/issue`) with the ClawVille service issuer ed25519 private key — loaded from the `CLAWVILLE_SERVICE_ISSUER_SK` env on boot and cached in memory. `getPublishedIssuerInfo()` returns the pubkey for the `GET /.well-known/clawville-issuer.json` route. |
| `memory-service` | RAG + embeddings helper for Eliza characters |
| `milady-gateway` | Inbound dispatcher for Milady plugin traffic |
| `npc-conversation-engine` | NPC ↔ NPC banter generator (Gemini, direct call bypassing Eliza) |
| `npc-simulation` | Authoritative NPC-world tick + SSE fan-out |
| `openclaw-client` | Outbound bridge to a user-hosted OpenClaw gateway |
| `pathfinding` | A* grid pathfinding over `BUILDING_EXCLUSION_PAD`-aware tilemap |
| `avatar-simulation-bridge` | Wires avatar state into the NPC-simulation world tick |
| `research-service` | Owns the research stream (article fetch → Gemini summary → SSE) |
| `session-agent-map` | In-memory `sessionId → agentId` resolver |
| `session-ticket-service` | Phase 5 magic-link CRUD |
| `skill-generator` | Builds `building_skills.content` (SKILL.md) from templates + character data |
| `system-npc-seeder` | On boot, seeds each building with a system-owned character + compiled SKILL.md (`ensureSystemNpcs()`) AND seeds every world-wide system agent from `SYSTEM_AGENT_TEMPLATES` (`ensureSystemAgents()`, lookups via `getSystemAgent(slug)`). System agents use `type='system-agent' + customization.slug=<slug>` and are protected from the orchestrator inactivity sweep. |
| `activity/bots/bot-pool` | **Q2 chunk #10.** Reserved bot avatarId pool (`BOT_POOL_CAPACITY=64`). Hydrates from DB at boot; reads `avatars` joined to `users WHERE email LIKE 'bot-%@bots.clawville.internal'`. Per-room `reserve(roomId, count) → string[]` allocates avatarIds (returns `[]` if pool would over-allocate); `releaseRoom(roomId)` is fired by the room manager's `evictionFn` on every terminal transition. `rebindReservation(avatarIds, fromRoomId, toRoomId)` swaps the placeholder `pending-room` key for the actual roomId atomically once `createRoom` succeeds. Pre-seeded by `scripts/seed-bot-avatars.ts`. |
| `activity/bots/bot-controller` | **Q2 chunk #10.** `BotController` interface — `computeInput(roomState, dt) → BotInput`. `BOT_CONTROLLERS: Record<activityId, factory>` registry resolves per-activity factories (today: `'bumper-shells' → createBumperShellsBot`). `BotRoomView` is a trimmed snapshot of room state safe to pass to controllers — no WS handles, no DB refs. |
| `activity/bots/bumper-shells-bot` | **Q2 chunk #10.** Heuristic Bumper bot. Tracks nearest alive opponent; rams within 80wu; turns away from arena edge within 100wu of `arenaRadius=500`; fires off-cooldown power-ups at ~30%/tick; small dir jitter so bots don't track perfectly. Stateless beyond `avatarId`. |
| `activity/bots/reef-race-bot` | **Q2 chunk #5.** Heuristic Reef bot. Aims at the next-checkpoint center with small per-tick jitter; 0.85 cruise thrust, drops to 0.6 on sharp heading mismatch; full thrust when off-track (perpendicular distance > `REEF_TRACK_HALF_WIDTH * 1.5`); fires off-cooldown power-ups at ~30%/tick. Stateless beyond `avatarId`. Registered as `'reef-race' → createReefRaceBot` in `BOT_CONTROLLERS`. |
| `activity/sim/bumper-shells-sim` | **Q2 chunk #3.** 60Hz server-authoritative Bumper Shells simulation. 8-body O(n²) collision, knockback above `KNOCKBACK_VELOCITY_THRESHOLD`, 6-power-up catalog. 15Hz delta + 1Hz keyframe broadcast cadence. Anti-cheat flags routed through `BumperFlagCounter` → forfeit at 5. Bot intents fed through the same `applyInput()` validators as humans. |
| `activity/sim/reef-race-sim` | **Q2 chunk #5.** 30Hz server-authoritative Reef Race simulation. Bespoke ~6000wu oval centerline with 12 checkpoint AABBs in fixed sequence — out-of-order crossings silently rejected (kills teleport-to-finish exploits). 3 laps default; lap-time discard + flag below `MIN_LAP_MS=15s`. Soft 90s timeout + 30s straggler grace; hard 120s. 5Hz delta + 1Hz keyframe broadcast cadence. 6-power-up catalog (turbo-bubble/ink-slick/bubble-shield/seeker-jelly/tide-wave/whirlpool). Emits `event.lap_completed` per lap with server-stamped `splitMs`/`totalMs`. `computeResults()` returns finishers ordered by `totalTimeMs` ASC + DNFers by laps DESC; `scoreMs` populated for finishers (drives the personal-best detection in `reward-pipeline.ts`). |
| `activity/sim/reef-race-config` | **Q2 chunk #5.** Track + sim constants — `REEF_LAPS=3`, `REEF_CHECKPOINT_COUNT=12`, `REEF_TICK_HZ=30`, `MIN_LAP_MS=15000`, `REEF_MAX_SPEED=500`, `REEF_BOOST_MULT=1.4`, oval half-axes `REEF_TRACK_A=1100` × `REEF_TRACK_B=700`. Pure helpers `reefCenterlineAt(t)`, `reefTangentAt(t)`, `buildReefCheckpoints()`, `isInsideCheckpoint(body, cp)`. 6-power-up def table with weighted spawn rolls. Imported by both the sim and (future chunk #6) the 3D scene for visual gate placement. |
| `activity/anti-cheat/shared` | **Q2 chunk #3.** Game-agnostic validators reused by every activity sim — `validateInputBounds`, `validateChatBounds`, `clampToTolerance`, `clampVectorMagnitude`, `InputRateTracker` (60Hz rolling-window cap). `ValidationVerdict<T>` union shape used by all per-activity validators. |
| `activity/anti-cheat/bumper-shells` | **Q2 chunk #3.** Bumper-specific validators — `validatePositionDelta`, `validateVelocityDelta`, `validatePowerUpUse`, `BumperFlagCounter`. `MAX_SPEED=350`, `MAX_ACCEL=MAX_SPEED*4`, `KNOCKBACK_VELOCITY_THRESHOLD=80`, `MAX_POWER_UP_SLOTS=2`, `FLAG_FORFEIT_THRESHOLD=5`. |
| `activity/anti-cheat/reef-race` | **Q2 chunk #5.** Reef-specific validators — `validateReefPositionDelta`/`validateReefVelocityDelta` (use `REEF_MAX_SPEED=500` + `REEF_MAX_ACCEL`), `validateLapTime` (flags + drops sub-`MIN_LAP_MS` laps), `validateCheckpointSequence` (silent reject on single out-of-order; tracker escalates to flag at `REEF_SKIP_PATTERN_THRESHOLD=3` skips in 5s), `validateReefPowerUpUse`, `ReefCheckpointSkipTracker`, `ReefFlagCounter` (extends `BumperFlagCounter` — same 5-flag forfeit ceiling). |
| `activity/reward-pipeline` | **Q2 chunk #7.** `issueRewardsForRoom({room, simResults})` is the LIVE→RESULTS settlement entry point. Computes per-participant placement tokens (`computePlacementBase`) + first-play-of-day bonus + Reef PB bonus + +25% focus-aligned bonus (`isFocusAligned` checks `avatars.flags.learningFocus` against `activity.skillBuildingMatches[]`), then writes the `activity_results` row + `creditClawTokens` ledger entry inside ONE composed `db.transaction(tx)`. Bots (`subjectType === 'bot'`) get `tokensAwarded=0`, `leaderboardPoints=0`, no credit call. Emits one `activity.match.placed` event per participant after the tx commits. Pure-logic helpers (`computePlacementBase`, `computeBreakdown`, `computeLeaderboardPoints`) exported for testing. |
| `activity/activity-leaderboard-service` | **Q2 chunk #7.** `getLeaderboardSnapshot(activityId, window, limit, offset)` aggregates `activity_results` per-avatar over `daily | weekly | all | season` windows; `getLeaderboardForAvatar(activityId, window, avatarId, context)` returns caller's row + N above/below for the include-me UX. Bots excluded via `subject_type != 'bot'`. Reef Race entries include `bestTimeMs` (min `score_ms`); other activities omit it. 60s in-memory cache keyed on `(activityId, window, seasonId?)`. |
| `activity/activity-season-service` | **Q2 chunk #7.** `ensureFirstSeason()` lazy-creates `2026-Q2-S1` (30-day duration, `activity_ids=['bumper-shells','reef-race']`) if no row exists — race-safe via the `activity_seasons.name` UNIQUE constraint. `getSeasonsCatalog()` returns `{active, past}` with a 60s in-memory cache. Backs `GET /api/activities/seasons` and the `season` window on per-activity leaderboards. |
| `system-agent-reward-limiter` | In-memory 60s cooldown per `(userId, slug)` for system-agent chat rewards. LRU-capped at 1000 entries, swept every 10 min. Single-pod only — promote to Redis if we ever multi-pod the API. |
| `wallet-service` | High-level wallet ops (create, transfer, balance) on top of `keypair-vault`. Phase 5.1 adds `ensureWalletWithFirstTimeSecret(subjectType, subjectId)` — idempotent on `(subject_type, subject_id)`, generates + persists a Solana keypair if no row exists, and returns the plaintext base58 secret **exactly once** (`{ publicKey, alreadyExisted, firstTimeSecretKeyBase58? }`). `firstTimeSecretKeyBase58` is only populated when a row was freshly inserted — the only approved export channel for wallet secrets (see `packages/database/src/schema/wallets.ts` JSDoc). Existing `ensureWallet()` callers unaffected. |
| `x402-config` | Phase 4 x402 merchant wallet config |
| `xp-service` | Level/XP math + `avatars.level / xp / total_xp` updates |
| `wager-program-client` | **Anchor client for `clawville_wager` (2026-05-12).** Loads the settlement-authority Keypair from `treasury_wallets` (purpose=`'wager-settlement-authority'`) on cold boot; refuses to sign if the decrypted pubkey doesn't match `WAGER_SETTLEMENT_AUTHORITY_PUBKEY` env or the devnet default. Public surface: `createSolLobby` / `joinSolLobby` / `lockLobby` / `settleSolLobby` / `cancelLobby` / `claimSolRefund` — wraps `program.methods.*` with PDA derivation + on-chain event persistence into `lobby_events`. All errors are routed through `WagerClientError` (codes: `rpc_unreachable` → HTTP 503, `state_noop` → 409, `on_chain_error` → 400 with the AnchorError code in `message`). |
| `activity/wager-lobby-bridge` | **Match-server ↔ wager-lobby bridge (2026-05-12).** Wired into `activityRoomManager.setLiveTransitionFn` and the per-sim `setEndedFn`. `lockLobbyForRoom(roomId)` issues `lock_lobby` on the chain when the room transitions to LIVE; `settleLobbyForRoom(roomId, winnerAvatarId)` issues `settle_lobby_sol` on RESULTS using the first-placed avatar from the sim's `computeResults()`. Best-effort: lock failures are logged but don't crash the match; settle failures emit a `kind='settled'` event with `failed: true` so operators can manually cancel-refund. Solo-bots lobbies short-circuit the chain calls. Idempotent against already-locked / already-settled state. |

## Database Schema

PostgreSQL with Drizzle ORM (`packages/database/`).

| Table | Purpose |
|-------|---------|
| `users` / `sessions` | Lucia auth (email + password). Phase 5 added `identity_fingerprint` (sha256 hex, UNIQUE) — the legacy string-based anchor. Phase 5.1 adds the cryptographic identity columns: `identity_pubkey` (base58 ed25519, UNIQUE, rotatable), `identity_encrypted_sk` (base64 AES-GCM ciphertext of the private key), `identity_iv`, `identity_tag`, `identity_dek_wrapped` (base64 Cloudflare-wrapped DEK), `identity_encryption_version` (NOT NULL DEFAULT 2 — envelope from day 1). Also the 'scape portal columns: `scape_principal_id` (UNIQUE — `principal:clawville:<user.id>` after first auto-provision crossing), `scape_world_character_id` (UNIQUE — `cv-<avatar.id>`), plus the linking columns for users who already have a real 'scape account: `linked_scape_principal_id` (UNIQUE), `linked_scape_world_character_id` (UNIQUE), `linked_scape_display_name`, `linked_scape_at`. **Guest-avatar auto-create (2026-04-23):** `is_guest` (boolean NOT NULL DEFAULT false) marks throwaway visitors created via `POST /api/auth/guest`; `guest_expires_at` (timestamptz nullable) is the 24-hour TTL the future cleanup cron will sweep. Brand carve-out: guest users are excluded from the agent leaderboard, per-activity leaderboards, and the `/dash` teacher-chat metric. Cleanup cron deferred — see `scripts/TODO-prune-guest-avatars.md`. |
| `agent_session_tickets` | **Phase 5** magic-link: 32-byte token, 5-min TTL, `consumed_at` sentinel. Backing table for `GET /api/auth/enter` (`session-ticket-service.ts`) |
| `avatars` | One per user. Identity: species/color/archetype/stats/position. Phase 2 framework fields: `model_key` (default `lobster`), `agent_category` (openclaw/hermes/milady/other, default `openclaw`), `harness` (openclaw/hermes/milady/custom, default `milady`). All NOT NULL with DEFAULTs so existing rows backfill automatically. CHECK constraint `avatars_agent_category_valid` and a sibling CHECK on harness enforce the enums at DB level. **Guest-avatar auto-create (2026-04-23):** `is_guest` (boolean NOT NULL DEFAULT false) mirrors `users.is_guest` for fast joinless filtering on per-activity leaderboards + reward pipeline. |
| `avatar_inventory` | Knowledge books owned by avatar (quantity tracking) |
| `map_locations` | 10 static building zones (seeded) |
| `location_agents` | Per-user agent config at each location |
| `platform_agents` | ElizaOS agent records |
| `platform_agent_logs` | Agent activity logs |
| `openclaw_bots` | External agent identity, gateway config, learned knowledge, session count. Enum `identityType`: `openclaw | ironclaw | nanoclaw | milady | custom | anonymous` |
| `agent_configs` | Export/import bundles (round-trip for `/api/agent/export-character`) |
| `building_skills` | Compiled SKILL.md cache keyed by buildingId — served from `/api/skills/:buildingId/skill.md`; rebuilt via `skill-generator` service |
| `npc_memories` | NPC conversation memory store used by `npc-conversation-engine.ts` |
| `activity_log` | Append-only log powering the sidebar Activity Feed |
| `research_articles` | Cached article scrapes used by `research-service` + `article-scraper` |
| `wallets` | **Unified** wallet table replacing per-subject tables. `wallet_subject_type` enum: `avatar | agent | treasury`. Encrypted Solana keypairs. Phase 5.1 adds envelope-encryption columns for a dual-version read path: `dek_wrapped` (base64 DEK wrapped by the Cloudflare-held master KEK) + `encryption_version` (NOT NULL DEFAULT 1 — `1` = legacy AES-256-GCM under `VANITY_ENCRYPTION_KEY`, `2` = per-row DEK with KEK in Cloudflare). New writes always go to v2; the dispatcher `keypair-vault.decryptWalletRow(row)` picks the right unwrap route off `encryption_version` so callers never branch on the version. A one-time `scripts/migrate-wallets-to-envelope.ts` sweeps any v1 rows left after ship. |
| `treasury_wallets` | Treasury-scoped wallets (phase-4 x402 merchant wallet + vanity set). Coexists with `wallets` for legacy rows |
| `vanity_keypairs` | Pre-generated vanity public keys, encrypted at rest |
| `token_launches` | Per-agent token launch records (Phase 4 token-launch subsystem) |
| `claw_token_transactions` | Canonical **ClawToken ledger** — single append-only source of truth for every token movement (daily login, chat reward, purchase, bazaar buy, auction win, quest reward, bounty payout) |
| `bazaar_listings` | Fixed-price skill listings |
| `bazaar_transactions` | Settled bazaar buys |
| `bazaar_reviews` | Ratings/reviews on bazaar purchases |
| `published_skills` | Free-tier marketplace (publish + upvote) — separate from bazaar paid tier |
| `skill_upvotes` | Per-user upvotes for `published_skills` |
| `auctions` | Skill auction house (metadata + current price) |
| `auction_bids` | Bid history per auction |
| `auction_agent_configs` | Agent-config snapshots attached to auction listings |
| `quests` | Admin-created quest definitions |
| `quest_submissions` | User submissions against quests |
| `quest_rewards` | Payout records (links to `claw_token_transactions`) |
| `bounties` | Community-posted bounties |
| `bounty_rewards` | Bounty payout records |
| `bounty_attempts` | User attempts / submissions |
| `bounty_reputation` | Per-user reputation rollup |
| `events` | **Metrics spine (2026-04-21).** Append-only analytics. Every meaningful app action writes one row via `logEvent()`. Columns: `id` (bigserial), `ts`, `event_type`, `user_id` FK, `agent_id`, `avatar_id` FK, `building_id`, `session_id`, `payload` jsonb. Indexes on `(event_type, ts)`, `(agent_id, ts)`, `(avatar_id, ts)`, `(building_id, ts)`. Read-only from the dashboard at `/api/dashboard/overview`. See Observability section above. |
| `event_write_failures` | **Safety net for the metrics spine (2026-04-21).** If the primary `events` insert fails, `logEvent()` persists the attempted row + error here. Columns: `id`, `ts`, `attempted_event_type`, `attempted_row` jsonb, `error_message`, `error_stack`, `retried_at`, `retry_succeeded`. Partial index on unretried rows for fast replay. |
| `pending_account_links` | **Phase 5.1 cross-world account linking (plan §15).** One-time code store used when a user wants to link an *existing* 'scape account to their ClawVille user (instead of auto-provisioning a fresh `principal:clawville:<uuid>` on first crossing). Columns: `code` varchar(32) PK, `clawville_user_id` uuid FK → `users.id`, `remote_world` varchar(64) (`'scape'`), `issued_at` timestamptz, `expires_at` timestamptz (issued_at + 10 min), `consumed_at` timestamptz nullable. Indexes: `(clawville_user_id, issued_at DESC)` and a partial `(expires_at)` WHERE `consumed_at IS NULL` for active-code lookups. Consumed atomically by `POST /api/portal/accept-scape-link` under the partner signature check. |
| `lobbies` | **Wager lobby off-chain mirror (2026-05-12).** One row per match-lobby for the `clawville_wager` Anchor program. Authoritative for product discovery / FE polling / invite-code lookup; on-chain is authoritative for the actual SOL. Columns: `id` uuid PK, `lobby_id` bigint UNIQUE (mirror of on-chain `u64` seed, allocated via `wager_lobby_id_seq`), `activity_id`, `room_id`, `creator_user_id` FK, `creator_avatar_id` FK, `wager_amount_lamports` bigint (0 = free), `wager_mint` nullable text (null = SOL), `max_players` smallint (CHECK 2..16), `joined_count` smallint, `state` text (CHECK in `'open'|'locked'|'settled'|'cancelled'`), `visibility` text (CHECK in `'public'|'private'|'friends'`), `invite_code` nullable text (UNIQUE partial), `mode` text (CHECK in `'multiplayer'|'solo-bots'`), `settled_winner_user_id` + `settled_winner_avatar_id`, lifecycle timestamps + `on_chain_*_sig` columns. Indexes: `(state, activity_id)`, `(room_id)`, partial unique on `invite_code`. |
| `lobby_players` | **Wager per-player deposit witness (2026-05-12).** One row per (lobby, user). Mirrors on-chain Player PDA uniqueness. Columns: `id` uuid PK, `lobby_id` uuid FK → `lobbies.id`, `user_id` FK, `avatar_id` FK, `deposit_amount_lamports` bigint, `deposited_at`, `refunded` bool, `refunded_at`, `on_chain_join_sig` text NOT NULL, `on_chain_refund_sig` nullable. Unique index `(lobby_id, user_id)`. |
| `lobby_events` | **Wager event timeline (2026-05-12).** Append-only audit log of `created` / `joined` / `locked` / `settled` / `cancelled` / `refunded` / `cleanup` events. Columns: `id` uuid PK, `lobby_id` FK, `kind` text (CHECK), `actor_user_id` nullable FK, `tx_sig` nullable, `raw_event_json` jsonb (decoded Anchor event), `occurred_at`. Index `(lobby_id, occurred_at DESC)`. |
| `treasury_purpose` enum | Adds `'wager-settlement-authority'` value (2026-05-12) for the settlement-authority Keypair row. The API loads + decrypts this row on cold boot via `wager-program-client.ts`. |

`avatars.characterConfig` (JSONB) stores the full resolved archetype data including learned knowledge. Full schema source: `packages/database/src/schema/*.ts` (23 files, all re-exported from `schema/index.ts`).

## State Management

Two Zustand stores bridge the 3D scene and React UI:

**`game.ts`** -- Player and world state:
- `controlMode`: `'explore' | 'npc' | 'player' | 'autonomous'`
- `avatarPosition`, `avatarSpeed`, `movementDirection`
- `nearLocation` + `nearCharacter` -- buildingId and character name the player is currently within `TALK_RADIUS_WORLD` of (proximity-to-character, not proximity-to-building-zone)
- `currentLocation` + `currentCharacter` -- active chat target; `enterBuilding(locationId, characterName?)` is a misnomer kept for backwards compat — nobody enters anything, it just opens the chat panel with the character standing outside
- `chatOpen`
- `possessedNpcId`, `hasAgent`, `isSpectator`
- `agentConnected`, `agentSessionId`, `agentConnectModalOpen` -- agent connection state (renamed from openclaw* in Phase 1)
- Building visit tracking (localStorage)

**`npc.ts`** -- NPC simulation state:
- Per-NPC: position, direction, species, color, HP, combat state, inventory
- Chat bubbles with expiration
- OpenClaw bot flags

## Control Modes

| Mode | WASD | Camera | Use Case |
|------|------|--------|----------|
| Explore | Pan camera | Free orbit | Browse world without an avatar |
| Player | Move avatar | Follows avatar | Normal gameplay |
| NPC | Move possessed NPC | Follows NPC | Control any NPC |
| Autonomous | Disabled | Follows agent | Watch AI agent play |

Toggle via `ControlModeToggle` component. Without an agent: Explore/NPC. With an agent: Player/Autonomous.

## NPC Simulation

- 10 lobster NPCs wander the map with demo pathfinding
- Each building has a dedicated location NPC at its entrance
- NPCs have species, color tinting, HP, combat state, inventory
- Client-side wander system (`stores/npc.ts`) with configurable tick rate
- Server-side autonomous simulation with SSE streaming (currently disabled for GPU safety)

## Gamification (Planned)

| Feature | Description |
|---------|-------------|
| Skill Bazaar | Marketplace for buying/selling learned skills between players |
| Auction House | Timed auctions for skills and full agent configs |
| Quest Board | Team-posted coding bounties with token + skill rewards |
| Bounty Board | Community-posted coding bounties with reputation system |
| Agent Setup | WoW-style character select with talent tree visualization |

## ClawToken Economy

- Start with 100 tokens (`avatars.clawTokens` default)
- Daily login: `10 + streak * 5` tokens (max 100/day) — endpoint `POST /api/avatars/me/daily-login`
- Chat with building agents: +1 token per message (routed through `/api/chat` or `/api/agent/:s/chat`)
- Spend at shops: 20 knowledge books across 10 buildings (`/api/items/*`)
- Learning flow: buy book → inventory → "Read to Avatar" → knowledge merges into `avatars.characterConfig.knowledge[]` → agent restart
- Heartbeat: `POST /api/avatars/me/heartbeat` — fire-and-forget position + activity ping, updates `avatars.lastActiveAt`
- **Ledger table**: every credit and debit is appended to `claw_token_transactions` via `claw-token-ledger` service. Never write `avatars.clawTokens` directly — go through the ledger.

## Deployment

Self-hosted on a single **Hetzner CCX13** VPS (`<PROD_VPS_IP>`, Ashburn) orchestrated by **Coolify** (self-hosted PaaS), with **Cloudflare** in front for DNS + CDN + DDoS protection. Two apps:

- **Web** (`apps/web/Dockerfile`): Next.js on port 3000 → `https://clawville.world`
- **API** (`apps/api/Dockerfile`): Hono on Bun on port 4000 → `https://api.clawville.world`

Database is **Supabase Postgres** (external — not hosted on the VPS). Environment variables are managed through Coolify's UI and encrypted at rest via Laravel's `Crypt` — bypassing the UI and writing to the `environment_variables` table directly WILL corrupt the encrypted payload, so always use the UI or the model's attribute assignment when writing programmatically.

Both apps auto-deploy from `git push origin master` via a GitHub webhook. Manual redeploys can be queued by SSHing into the VPS and running `queue_application_deployment` inside the Coolify artisan tinker (documented in `CLAUDE.md`). Full playbook for migration / rebuild is in `docs/DEPLOY-HETZNER.md`.

Testing rule: never run `bun run dev` locally — the Three.js/WebGPU scene crashes Intel Iris Xe and requires a PC restart. Always push → Coolify auto-deploys → test against the production URL.
