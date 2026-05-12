# ClawVille — Game Features Reference

> **Last Audited:** 2026-05-08 (Pets→Avatars rename — concerns 1a–1h. Code identifiers updated repo-wide: `pets` table → `avatars`, `pet_inventory` → `avatar_inventory`, `pet_id` → `avatar_id`, `petId` → `avatarId`, `wallet_subject_type` enum value `'pet'` → `'avatar'`, route file `apps/api/src/routes/pets.ts` → `routes/avatars.ts`, all `/api/pets/*` HTTP paths → `/api/avatars/*`, frontend `player-pet.tsx` → `player-avatar.tsx`, archetypes `pet-archetypes.ts` → `avatar-archetypes.ts`, store fields `petPosition`/`petSpeed` → `avatarPosition`/`avatarSpeed`, components `PetStatusBar`/`PetChatBar`/`PetSettingsModal`/`GuestPetBootstrap` → `AvatarStatusBar`/`AvatarChatBar`/`AvatarSettingsModal`/`GuestAvatarBootstrap`, `getLeaderboardForPet` → `getLeaderboardForAvatar`, CHECK constraint `pets_agent_category_valid` → `avatars_agent_category_valid`, onboarding route `/create-pet` → `/create-agent`. The `avatar_type`/`avatar_url` columns on the `avatars` table — describing the renderable model format (`glb`/`vrm`) — keep their names; "avatar" there refers to the visual asset, not the table-name. Real script files retain their original names for filesystem accuracy: `scripts/seed-bot-pets.ts`, `scripts/TODO-prune-guest-pets.md`, `scripts/audit-non-guest-pets.ts`, `scripts/flip-guest-pets-to-milady.ts`, `apps/api/src/services/pet-autonomy.ts` (deleted but referenced in plan history). **Note:** historical audit entries below describe schema state AT TIME of those audits — do not retroactively rewrite them.) Prior: 2026-04-29 (SPEC 3 Ramps — §19.19 added. 6 server-authoritative ramp launch volumes + `event.ramp_launch` protocol + 6 wedge meshes in `ramps.tsx` + screen-shake infrastructure + extended 16° nose-up tilt. Prior: SPEC 2 Milady VRM rider in Reef Race — added §19.18 documenting VRM component architecture, wipeout/victory triggers, VRMCharacterAnimator surfaceClip field, warn-spam fix. Prior: SPEC 1 multi-species Reef Race rider — §19.17 GLB dispatch table, data flow, emptyState guard.) Prior: 2026-04-28 (Reef Race feel pass — three player-facing fixes pushed in one diff. (1) Drift+steer reversal: holding Shift with a gentle steering input (|dir.x| ∈ [DRIFT_MIN_STEER..tan(15°)] ≈ 0.12..0.27) was visibly turning the kart OPPOSITE the player's input because the constant 15° outward bias overshot |baseRot|. Fixed in `apps/api/src/services/activity/sim/reef-race-sim.ts` by clamping `biasMag = min(DRIFT_ANGULAR_BIAS_RAD, |baseRot|)`. New regression test T10b. (2) Choppy left-right motion: `REEF_SNAPSHOT_HZ` bumped 10 → 20, halving the linear-lerp piecewise seam from ~33° to ~16° per bracket; `INTERP_DELAY_MS` 200 → 100 in lockstep on the client. Snapshot bandwidth budget test ceiling 600KB → 1.2MB and lower bound 100 → 200 deltas/30s. (3) Power-up clarity: `<PowerUpBar>` rewritten in `apps/web/src/components/game/reef-race-hud.tsx` — now renders both REEF_MAX_POWER_UP_SLOTS (=2) slots always (empty placeholder when nothing held), kind-specific icon + name + 1-line description per slot, USE-key chip (SPACE/Q) above each slot, pickup-pulse keyframe on empty→filled transition, local active-effect countdown bar after use. New `POWER_UP_META` map mirrors the server's REEF_POWERUP_DEFS (turbo-bubble, bubble-shield, ink-slick, seeker-jelly, tide-wave, whirlpool). See §19.14 Reef Race feel pass.)
>
> Prior audit 2026-04-25 (Default avatar flip — `DEFAULT_AGENT_MODEL_KEY` flipped from `'lobster'` to `'milady_official_1'` in `packages/shared/src/constants/agent-models.ts:120`. Newly connected agents now spawn as a Milady VRM rather than a red lobster. The same constant flows through `apps/api/src/routes/auth.ts:495` (guest avatar seed) which used to hardcode `'lobster'` — now imports the canonical default. NPC-mode default also flipped: `apps/web/src/stores/npc.ts:475` `species: 'lobster'` → `species: 'milady_official_1'` so the player NPC spawned by `spawnPlayerNpc()` routes through `VRMNpcMesh`. To prevent silent jump regression, ported the jumpState/airborne/jumpY/bob block from `GLBNpcMesh` (lines 592-605) into `VRMNpcMesh` (arena-npcs.tsx ~line 932), dropping `+ 2` baseline and `- pivotOffsetY` per VRM Y=0 spec — matches `player-avatar.tsx`'s VRM branch. See §1 Game Modes table.)

> Prior audit 2026-04-24 (Phase 6 — Agent Session Liveness + ClawVille Orientation Skill. Two joined concerns: (A) a shared `CLAWVILLE_ORIENTATION_KNOWLEDGE` + `CLAWVILLE_ORIENTATION_SKILL` constant in `packages/shared/src/constants/orientation-skill.ts` is now the single source of truth for world-facts — Nori spreads it into her Eliza `knowledge[]`, every newly-created avatar gets it baked into `characterConfig.knowledge` in `apps/api/src/routes/avatars.ts:buildCharacterConfig`, and `/api/agent/export-character` prepends it to every skillPack. Editing `town-guide.ts` knowledge[] manually is now drift — all gameplay changes go to the shared constant and flow to all three consumers. (B) External agent sessions now carry a sliding 24h TTL on `openclaw_bots.session_expires_at`, extended on every chat / activity / register; `services/openclaw-session-sweeper.ts` reaps expired rows every 5 min and stops lingering Eliza runtimes. New endpoints: `GET /api/agent/session-status?agentId=` returns 200/410/404, `POST /api/agent/disconnect` is the ed25519-signed logout counterpart to `/reconnect`, `GET /api/auth/me/agent-session` is the UI hydration probe. SKILL.md served at `/api/agent/connect-skill` now teaches verify-liveness-first and clean-disconnect. Game page hydrates `agentConnected` from server on mount + window-focus via a new TanStack Query hook — fixes the "Hermes agent claimed connected for a week after exiting" bug. See §2 Agent Connection Flow, new §2.1 Session Lifecycle, §10 avatar System for orientation-knowledge bake-in.)
>
> Prior audit 2026-04-24 (Demo-mode bot backfill timing — `QUEUE_TIMEOUT_MS` 20s→3s, `EXTENDED_TIMEOUT_MS` 45s→6s in `apps/api/src/services/activity/activity-queue.ts`. Public demo traffic is solo humans queueing with nobody else around; the original 45s wait turned the lobby into a loading screen. New flow: solo human queues → bot backfill kicks in at 6s → match starts ~7s in. Affects Bumper Shells + Reef Race. Revisit when concurrent-queue counts rise. See §19.11.)
>
> Prior audit 2026-04-24 (NPC mode UI rebuild — guest auto-create was conflating `hasPet=true` with "agent connected", flipping the toggle to Controlled/Autonomous and rendering the full player chrome (AvatarStatusBar, QuestTracker, AvatarChatBar, shop, etc.) for guest visitors. Mobile screens were ~75% covered by player UI a guest couldn't actually use. Re-gated the toggle and player UI to `agentConnected`; world UI (LocationHUD, ?, ActivityFeed) stays on `hasPet`. NanoClawBanner now always shows the Connect CTA when no agent is connected. PerfHud gated to `NODE_ENV !== production` OR `?debug=1`/`?perf=1`. ? button lifted above the joystick zone on mobile. See §1 Game Modes table + §12 Toggle Labels.)
>
> Prior audit 2026-04-23 (Guest avatar auto-create — un-authed visitors can play activity games + chat with NPCs as a throwaway "Guest avatar" without signing up. New `POST /api/auth/guest` endpoint, new `users.is_guest` + `users.guest_expires_at` + `avatars.is_guest` schema columns, new `<GuestAvatarBootstrap>` component, two trigger points (NPC mode entry + activity queue 401 retry). Brand carve-out: guests earn ClawTokens but get 0 leaderboard points and don't appear on the per-activity / agent leaderboards. Town Guide knowledge updated. See §1 Game Modes → "Guest Mode" subsection. Cleanup cron deferred — `scripts/TODO-prune-guest-pets.md`.)
> Prior audit 2026-04-24 (Town-center commerce anchor fixes: auction dome Y -2→+6 (buried GLB sub-meshes), marketplace stall Y -2→+2 (sand clip), dome Z →-500. New Town Directory Sign at (0,-2,-50) — procedural wooden sign with drei Html text, no click handler. See §0 Commerce anchors table.)
> Prior audit 2026-04-24 (Q2 Activity Portals **chunk #12** — final polish + Q2 closeout. Three new user-facing surfaces stack on top of the chunk #11 spectator UX and chunk #8 portal/lobby flow: (1) `<ActivityTutorialCard>` — Nori-voiced first-time-in-activity intro card rendered at the top of `<ActivityLobbyModal>` only when `clawville-activity-tutorial-seen-v1` (localStorage Set) does not yet contain the activityId. Per-activity copy in `ActivityTutorialCard.tsx` (Bumper Shells = "ram opponents off the edge", Reef Race = "three laps around the reef"). "Don't show again (all activities)" link sets the global `clawville-activity-tutorial-skip-all` flag. RuneFrame card with Nori avatar disc. (2) Activity sound design pipeline — new `apps/web/src/lib/activity-audio.ts` shared single-AudioContext SFX bus (iOS-friendly prime-on-gesture, prefers-reduced-motion respected, mute toggle, per-sound volume table, fire-and-forget API). 11 placeholder silent WAVs at `apps/web/public/sounds/activity/` — REAL CC0 ASSETS NEED LICENSING PASS BEFORE LAUNCH. Wired into `<RoundCountdown>` (countdown-tick × 3 + round-start), `<BumperShellsHud>` (knockout on self-elimination, item-pickup/item-use on inventory delta), `<ActivityResultsModal>` (placement-tier fanfare: 1st=victory-fanfare, 2nd=placement-silver, 3rd=placement-bronze, 4+=defeat; pb-chime when `isPersonalBest`). (3) `<ActivityMobileControls>` — separate from open-world `<MobileControls>`, mounts on activity route only. Replaces the right joystick + E button with two 64×64 thumb buttons: A (boost — dispatches `clawville:activity-action` with `ACTION_BIT_BOOST`) + B (use power-up — dispatches with `ACTION_BIT_USE_POWERUP`). Left movement joystick stays. `navigator.vibrate(18)` haptic on press if available. WCAG 2.1 AA touch-target compliant. (4) Spectator camera wiring — chunk #11's `<SpectatorCamSelector>` state lifted from `<BumperShellsHud>` to the activity route page via new `onSpectatorStateChange` callback prop. Page passes `spectatorCamMode` + `spectatorTargetPetId` props to `<BumperShellsScene>` (3da's chunk #12a — `27e9e75` — already wired the prop surface). Active players keep the static OrthographicCamera (Iris Xe perf invariant); only spectators trigger the perspective swap. Town Guide knowledge[] updated with tutorial-card + sound-design + mobile A/B mention per CLAUDE.md mandate. **This closes Q2 Activity Portals — all 12 chunks shipped (in PRs).** New §19.16 — Polish layer; §19.15 + §19.6 cross-references updated.)
> Prior audit 2026-04-24 (Q2 Activity Portals **chunk #11** — spectator mode shipped. Eliminated Bumper Shells players now see a real spectator surface instead of the chunk #4 dead-screen: dimmed overlay + remaining-time header + right-side panel with prev/next/free-cam target cycler, three-button camera-mode selector (Follow/Free/Action — local pick only; underlying static OrthographicCamera retained for Iris Xe perf), live `<HudMiniLeaderboard>` reuse, separate spectator chat channel via additive `spectator: true` field on the existing `chat` WS frame, and Cheer (👏) / Taunt (😈) emote buttons with 15s client cooldown rings via the existing `emote` WS frame. Three new atoms — `<SpectatorCamSelector>`, `<SpectatorChatPanel>`, `<EmoteButton>` — under `apps/web/src/components/game/activity/`. Store gains `chatLog` ring buffer + `pushChatLocal` action + `selectSpectatorChat`/`selectAliveEntities` selectors. Protocol additions are purely additive (legacy frames still validate). Camera motion + 3D rendering of cheer glyphs deferred to chunk #12 (3da pairing). New §19.15; §19.10 + §19.6 updated. See `.claude/plans/q2-research/frontend-spec.md` §7.)
> Prior audit 2026-04-24 (Q2 Activity Portals **chunk #8** — portal entry modal + lobby UX shipped. New `<BuildingPortalModal>` ("Learn or Play?" two-column modal with per-activity Play card, top-today preview, focus-bonus banner, coming-soon stubs row) and `<ActivityLobbyModal>` (idle/queuing state machine with adaptive `/queue-status` polling — 5s idle, 2s queued — party slots up to 4 per locked `MAX_PARTY_SIZE`, top-weekly mini-leaderboard, Solo / Party CTAs, Leave Queue). New atoms under `apps/web/src/components/game/activity/`: `<ActivityThumbnail>` (16:9 with WebP→gradient fallback), `<QueueStatusBar>`, `<PartySlot>`, `<InviteSearchPopover>` (FEATURE_GATE: party_invite_search — UI shell only, real fetch deferred to chunk #11). `enterBuilding()` in `stores/game.ts` now branches on `ACTIVITY_REGISTRY` — opens portal modal for buildings with at least one `live` activity, falls through to chat path for the other 8 (zero behavioural change). New store fields: `currentPortalBuildingId`, `activityLobbyId` + 4 actions. Sidebar dev "Quick Queue: Bumper Shells" button gated behind `NEXT_PUBLIC_ENABLE_DEV_QUEUE === '1'` (default off; FEATURE_GATE: dev_quick_queue_button). Chunk #9's `?quickQueue=<id>` deep link rerouted from sidebar to `app/game/page.tsx` — reads `window.location.search` (no `useSearchParams` to avoid Next 16 prerender bailout), strips param, calls `openActivityLobby(target)` with `autoQueue=true`; lobby auto-fires Queue Solo on first mount when `autoQueue` is set. Town Guide knowledge updated with the new Learn-or-Play portal flow + lobby state machine. New §19.14; §19.10 rewritten to split shipped vs. deferred for chunks #11/#12.)
> Prior audit 2026-04-23 (Q2 Activity Portals **chunk #5** — Reef Race sim + anti-cheat + bot live. New 30Hz server-authoritative race sim (`reef-race-sim.ts`) on a bespoke ~6000wu oval centerline with 12 sequential checkpoints, 3 laps, `MIN_LAP_MS=15s` discard, soft 90s + 30s straggler grace timeouts. New 6-power-up catalog (turbo-bubble / bubble-shield / ink-slick / seeker-jelly / tide-wave / whirlpool — `reef-race-config.ts`). New anti-cheat module (`anti-cheat/reef-race.ts`) reuses `BumperFlagCounter` for the 5-flag forfeit ceiling and adds `validateLapTime`, `validateCheckpointSequence`, `ReefCheckpointSkipTracker` (3 skips in 5s → flag). New heuristic bot (`bots/reef-race-bot.ts`, registered under `'reef-race'` in `BOT_CONTROLLERS`). `index.ts` boot wiring registers Reef alongside Bumper for `setLiveTransitionFn`, `setComputeResultsFn`, broadcast/ended/integrity dispatch. `activity-ws-hub.ts` and `activities.ts` /state route now dispatch on `room.activityId === 'reef-race'`. Sim emits `event.lap_completed` per lap with server-stamped `splitMs`/`totalMs`. `computeResults()` returns finishers ordered by `totalTimeMs` ASC + DNFers, with `scoreMs` populated for finishers — drives the existing chunk #7 personal-best bonus + Reef leaderboard "Fastest" tab. 3D scene (`apps/web/src/lib/three/activities/reef-race/*`) + HUD ship in chunk #6; until then queueing `reef-race` triggers the sim but renders no client scene. Prior audit same-day chunk #9 — results screen + tutorial quest hooks. New `<ActivityResultsModal>` (`apps/web/src/components/game/activity-results-modal.tsx`) replaces the minimal scaffolding card that previously rendered when `matchPhase === 'ended'`. Diablo-style 6s skippable reveal: placement banner → avatar portrait → stats → podium → rewards → personal-best callout → CTAs. Reads `event.match_ended.rewardPreview` for fast first paint, replaces with authoritative data from `GET /api/activities/:activityId/rooms/:roomId/results` on mount. `prefers-reduced-motion` collapses all phases to instant fade-in; tap/click/ESC skips. `/sounds/quest-complete.wav` + `/sounds/quest-tick.wav` reused for chimes (graceful no-op if assets missing). Two new tutorial quests added in `lib/quests.ts`: **first-match** (40 tokens, "Competitor" title) requires `activityMatchesPlayed >= 1`; **first-win** (100 tokens, "Champion" title) requires `activityMatchesWon >= 1`. Counters live on the existing zustand `quest` store with a `version: 2` migration that backfills missing keys for returning users. Modal increments counters once per mount + calls existing `triggerQuestCheck()` so the existing toast flow fires. Sidebar Quick Queue button now auto-fires when the URL carries `?quickQueue=bumper-shells` (one-shot; param stripped after fire) — that's how the modal's Play Again CTA round-trips back into a queue. See new §19.13.)
> Prior audit 2026-04-23 (Q2 Activity Portals chunk #7 — reward pipeline + per-activity leaderboards. LIVE→RESULTS now writes `activity_results` rows + credits placement tokens (1st=45 / 2nd=30 / 3rd=20 / 4th–6th=10 / 7th–8th=5 + 5 floor for Bumper; +5 per tier + 10 PB bonus for Reef) inside ONE composed DB tx via the new `reward-pipeline.ts`. First-play-of-day +15 + +25% focus-aligned bonus stack on top. Bots: 0 tokens, 0 leaderboard pts, no `creditClawTokens` call (the chunk #10 carve-out is now live code). Six new REST routes — `/api/activities/:id/rooms/:roomId/results`, `/api/activities/me/recent-results`, `/api/activities/results/:resultId/acknowledge`, `/api/activities/:id/leaderboard`, `/api/activities/:id/leaderboard/me`, `/api/activities/seasons` — replace chunk #2 stubs (replays/:replayId stays 501 for chunk #5). Free-agent leaderboard scoring extended with `activityPlacement: {1:30, 2:15, 3:8, default:2}`; bots filtered via `payload->>'subjectType' <> 'bot'` so chunk #10 telemetry doesn't pollute Priority #3. First Q2 season `2026-Q2-S1` (30 days) auto-creates on first `/seasons` call. New `acknowledged_at` column on `activity_results` (additive migration `0003_*.sql`). New §19.12 "Reward pipeline + leaderboards (chunk #7)". Prior audit same-day chunk #10 — bot backfill controllers wired.)
> Prior audit 2026-04-23 (Phase 4c Layer 1 — in-game appearance editing shipped. `AvatarSettingsModal` gains `EditAppearanceSection` — harness-filtered avatar grid, MToon-aware color palette, gender radio. Backed by `PATCH /api/avatars/me/appearance` which is harness-pool-guarded (Milady↔Milady, non-Milady↔non-Milady), regenerates `characterConfig.system` in place on modelKey change, mirrors to `agents.config` in one transaction, and emits `avatar.appearance.changed` events. Client hook: `useEditPetAppearance`. See §AvatarSettingsModal row. Layer 2 (archetype/personality/rename) + Layer 3 (advanced Eliza field editor) sketched in `.claude/plans/phase4c-in-game-edit.md`, not yet implemented.)
> Prior audit 2026-04-23 (W4 — Town Guide frontend chat integration shipped. Click-Nori → wave + chat panel open (guide branch of `<ChatPanel />`). New store flags `guideChatOpen` + `openGuideChat()`/`closeGuideChat()` share `movementFrozen` with building chats so the two surfaces can never coexist. Guide mode has NO Claim Skill / NO Shop / NO location subtitle — matches Nori's "switchboard, not encyclopedia" role. ESC + X close; click-twice is idempotent. Files: `stores/game.ts`, `lib/api.ts` (`sendSystemChat`), `hooks/use-guide-chat.ts` (new), `types/chat.ts` (new shared ChatMessage), `components/game/chat-panel.tsx` (split into `<GuideChatBody />` + `<LocationChatBody />`), `lib/three/town-guide.tsx` (openGuideChat on click), `lib/three/player-avatar.tsx` (ESC handler at both :243 + :498). See §0 Town Guide NPC "Phase 2 status" + expanded §0.1.)
> Prior audit 2026-04-23 (W1 — Town Guide chat route generalized to `POST /api/chat/system/:slug`. Backend `type='town-guide'` → `type='system-agent' + customization.slug='town-guide'`. New `SYSTEM_AGENT_TEMPLATES` registry, `ensureSystemAgents()` + `getSystemAgent(slug)` services, `systemAgentRewardLimiter` (60s per-user-slug cooldown), partial unique index `platform_agents_system_singleton`. Inactivity sweep skips system agents (safety-critical — they are boot-seeded singletons). Dashboard teacher-chat metric excludes `chatType='system-agent'`. See §0 Town Guide NPC + new §0.1 System Agent Chat Route.)
> Prior audit 2026-04-23 (Town Guide upgraded to Mixamo FBX pipeline — `guide.glb` replaced by `guide-rigged.fbx` + 11 animation FBXs. Wave-on-click animation added (crossfade idle→wave→idle). Procedural cylinder skirt and explicit arm-rotation overrides removed (now baked into Mixamo poses + real 3D skirt geometry in character mesh). See §0 Town Guide NPC.)
> Prior audit 2026-04-23 (Phase 4d shipped — `/create-agent` restructured into four harness tabs (Milady · OpenClaw · Hermes · Custom). Milady is the only `hosted` harness; non-Milady tabs show a setup-gate with framework + local Eliza + Postgres instructions before the avatar picker. Avatar-settings export modal now renders harness-branched setup instructions below the install command. Content lives in `apps/web/src/content/setup-content.ts` as structured TypeScript — no markdown runtime. Components: `SetupGate` + `SetupInstructions`.)
> Prior audit 2026-04-22 (Town-center rework Phase 1 Rev 3b: Option C tuned — Town Guide pushed to `(0,+240)` (was +100, still inside podium's 144u bottom-radius footprint). At z=+240 she's ~46wu south of podium's ground edge, rendering fully in front. Player spawn moved to `(2560,2940)` = world `z=+380`, 140wu south of guide. Marketplace anchor sizes unchanged. See §0.)
> Prior audit 2026-04-21 (Landing hero rewritten to reflect the free-leaderboard brand pivot — new Powered-by-ElizaOS / Built-for-Milady-AI badge above the title, tagline switched to "Where Humans And Agents Learn Together", subtitle + collaboration-axes pill strip, Connect-Your-Agent chip trio reframed to learn/collaborate/climb, `Skill Shops` tokenomics card renamed `Knowledge Shops`, `How It Works` step 03 rewritten around MiladyAI teachers + ElizaOS memory. See §16 "Landing Page".)
> Prior audit 2026-04-21 (Fixed charged-launch release bug + player WASD now camera-relative. `player` mode Controls cell updated. See §17 "Jump Controls" and §1 "4 Game Modes".)
> Prior audit 2026-04-21 (VRM Milady avatars wired — §9 "Agent Avatar Picker" sub-section added covering the 8 Milady Official VRMs, `avatar_type` registry field, Mixamo retargeting, MToon no-tint invariant, and retired anime GLBs.)
> Prior audit 2026-04-21 (`JUMP_MIN_CHARGED_VZ` lowered 250→100 so release just past the tap threshold matches tap peak — removes the 6× step discontinuity at 200ms. See §17 "Jump Controls".)
> Prior audit 2026-04-21 (Phase 5.1 — wallet identity + 'scape portal: new §18 "Cross-World Portal" covering the WORLDS sidebar group, auto-provisioned 'scape characters (`cv-<avatarId>` / display `<avatarName>-cv`), and the link-existing-'scape-account code flow; §2 extended with Phase 5.1 first-connect response `identity` + `wallet` blocks and the two-key agent-config storage contract.)
> Prior audit 2026-04-21 (Charge scale switched to vz²-linear for linear peak-height perception — 25% bar ≈ 530 wu, 50% ≈ 860 wu, 100% ≈ 1530 wu. Camera now translates with orbit target during high jumps, preventing arrow-key rotation glitch at near-vertical PHI. See §17 "Jump Controls".)
> Prior audit 2026-04-21 (metrics spine jump — skill marketplace write paths paused (503), §3 gets PAUSED banner, `/dash` internal admin surface added at `clawville.world/dash` reading from the new `events` table via 4 cards + buildings chart, brand-identity pivot applied to CLAUDE.md Priorities #3 & #4. Previous audit same day: jump controls rewritten to charge-and-release model — hold SPACE → avatar stays on ground, charge bar fills for up to 1.5 s. Release before 200 ms = quick tap jump (~33 wu). Release at or after 200 ms = proportional charged launch (195 wu min → 1531 wu max). Auto-launches at full charge if held past 1.5 s. No peak clamp. Idle rotation freeze. Charge bar UI. See §17 "Jump Controls".)

> **Internal admin surface (not user-facing):** `clawville.world/dash` — ADMIN_USER_IDS allowlist only. Server-rendered, 10-minute auto-refresh. Four metric cards (DAU + Milady-origin %, Connect→first-engagement conversion, Returning-day rate, Agent↔agent collaborations + teacher-chat sublabel) plus a Buildings-by-visits bar chart. Reads from `GET /api/dashboard/overview`, which queries the new `events` table exclusively. See `ARCHITECTURE.md` Observability section for the full event catalog.
> Prior audit 2026-04-17 (drift sweep — toggle labels `Play/Autonomous` → `Autonomous/Controlled`; Manual connect tab removed from modal; minimap now top-LEFT sonar with click-to-path; ChatPanel Claim-Skill button, Configure gear gone; AutonomyHUD stacked above AvatarStatusBar; AvatarChatBar 🦞 lobster glyph; talk-to-character proximity model + nearCharacter store; Phase 5 magic-link + Phase 6 per-user character memory isolation; landing-page section 16 added covering SiteHeader, 4-card agent grid, skill-economy chips, equalized CTAs; avatar-UI gate tightened to `hasPet` only so Phase-5 magic-link users in `explore`/`npc` still see AvatarStatusBar + quests + inventory.)
> **Scope:** Current production-shipped behaviour only. Anything marked **STUB** or **INCOMPLETE** is wired enough to compile but lacks a runtime feedback loop. This file was generated by reading the actual source — line references are absolute and verifiable.

---

## Table of Contents

1. [4 Game Modes](#1-4-game-modes)
2. [Agent Connection Flow (Moltbook Pattern)](#2-agent-connection-flow-moltbook-pattern)
3. [Skill Marketplace](#3-skill-marketplace)
4. [Knowledge Books & Learning](#4-knowledge-books--learning)
5. [ClawToken Economy](#5-clawtoken-economy)
6. [Quests & Bounties](#6-quests--bounties)
7. [Leaderboard](#7-leaderboard)
8. [Daily Login Streak](#8-daily-login-streak)
9. [Avatar System](#9-avatar-system)
10. [Milady App Store Integration](#10-milady-app-store-integration)
11. [Game UI Components](#11-game-ui-components)
12. [Control Mode Toggle](#12-control-mode-toggle)
13. [NPC Simulation](#13-npc-simulation) (incl. talk-to-character + Phase 6 memory isolation)
14. [Tutorial System](#14-tutorial-system)
15. [Authentication](#15-authentication) (incl. Phase 5 magic-link)
16. [Landing Page](#16-landing-page-appswebsrcapppagetsx)
17. [Jump Controls](#17-jump-controls)
18. [Cross-World Portal ('scape)](#18-cross-world-portal-scape)
19. [Activity Portals — Q2 (Bumper Shells launch title)](#19-activity-portals--q2-bumper-shells-launch-title)

---

## 0. Town Guide NPC + Marketplace Anchors (Phase 1 — 2026-04-22)

The town-center cluster — five objects surrounding world origin. The Town Guide stands at center; three marketplace anchors are scaled up 8× (~80–144wu tall) for visual parity with the 800wu buildings; Quest NPC flanks to the west.

### Town Guide NPC

| Field | Value |
|---|---|
| Character asset | `/models/guide-rigged.fbx` — Sketchfab anime girl → Blender (real 3D skirt baked in, nipple piercings added) → Mixamo auto-rig (65-bone standard Mixamo skeleton, `mixamorig:*` bone names) |
| Animation assets | `/models/guide-animations/` — 11 FBX files: `pose-hand-on-hips` (default idle), `pose-catwalk-idle`, `pose-dance`, `pose-laying`, `pose-standing-2/3/4`, `praying`, `wave`, `bellydancing`, `samba` |
| Component | `apps/web/src/lib/three/town-guide.tsx` |
| World position | `(0, -2, +240)` — unchanged from 2026-04-22 Rev 3b |
| Scale | `GUIDE_SCALE=100` |
| Loading | Module-scope `Promise.all([FBXLoader.loadAsync(character), ...11 anim FBXs])`. Clips renamed to file stems, attached to template `.animations[]`. React 19 `use()` inside `<Suspense>` suspends until resolved. |
| Default idle | `pose-hand-on-hips` clip via `AnimationMixer`. `LoopOnce`, `timeScale=0`, `clampWhenFinished=true` → freeze at frame 0. |
| Procedural breathing | `mixamorig:Spine2` `scale.y = 1 + sin(t*1.8)*0.008` in `useFrame`, additive over mixer (mixer only writes rotation/position tracks from Mixamo). |
| Wave on click | Crossfade idle→wave (0.35s). `LoopOnce`, `clampWhenFinished=false`. `mixer.on('finished')` crossfades back to idle (0.35s). |
| Click action | Guarded open of guide chat panel — `useGameStore.getState().openGuideChat()` in `town-guide.tsx` `handleClick`. Wave animation plays on first open; subsequent clicks while chat is already open are idempotent (guard returns before wave). If a building/teacher chat is already open, the click is a no-op. |
| Removed | Procedural `CylinderGeometry` skirt (now real 3D skirt in FBX mesh); explicit upper/lower arm rotation overrides (now Mixamo poses control arm position) |

### Commerce anchors (distinct GLB-based anchors, 2026-04-24)

Three distinct Sketchfab CC-BY GLBs replaced the old identical pedestals + custom podium. All four modal store actions remain wired to the 3D objects; each anchor has its own visual identity. A fifth procedural sign (Town Directory Sign) marks the zone entrance.

| Anchor | World position | Visual | Approx height | 3D source | Modal action |
|---|---|---|---|---|---|
| **Bazaar (Fish Market Stall)** | `(-600,-2,-60)` — west | Stylized hand-painted wood booth with fish display. Asset: `/models/bazaar-fish-stall.glb` (duckcracker02, CC-BY). Scale-normalized to ~400wu max dim. Static, `matrixAutoUpdate=false`. | ~400wu | `bazaar-stall.tsx` | `openBazaar()` |
| **Marketplace (Food Stall)** | `(600,+2,-60)` — east, mirror of bazaar | Medieval produce stall. **Y=+2** (raised from -2 to clear wooden-frame base from clipping into sand). Asset: `/models/marketplace-food-stall.glb` (SpatialNeglect, CC-BY). Scale-normalized to ~450wu max dim. Static, `matrixAutoUpdate=false`. | ~450wu | `marketplace-stall.tsx` | `openMarketplace()` |
| **Bounty Board** | `(50,-2,0)` | Posts + plank + parchment (TSL procedural). ~144wu tall | ~144wu | `bounty-board-object.tsx` | `openBountyBoard()` |
| **Auction (Glass Dome)** | `(0,+6,-500)` — far north | Glass dome showcase. **Y=+6** (raised from -2: GLB sub-meshes Dome_Rim_0/Dome_Metal_0 extend below the root origin — Y=+6 lifts them clear of the sand). **Z=-500** (pushed north for visual depth). Asset: `/models/auction-dome.glb` (dylanheyes, CC-BY). Scale-normalized to ~380wu max dim. Floating jellyfish "featured lot" inside the dome (`/models/jellyfish.glb`, ~130wu, Y-axis spin `t * 0.8` rad/s). Single `useFrame` spins jellyfish only. | ~380wu | `auction-podium.tsx` | `openAuction()` |
| **Town Directory Sign** | `(0,-2,-50)` — centre, stall-row entrance | Procedural wooden sign (no GLB). Two `8×140×8wu` posts + `148×80×6wu` plank in warm oak brown (`MeshBasicNodeMaterial` TSL color). Text rendered via drei `<Html transform>` DOM portal: "TOWN CENTER" bold header + "Auction / Bazaar / Marketplace" sub-labels; `font-family:serif; color:#2a1800`. Informational only — no click handler. | ~140wu | `town-directory-sign.tsx` | none |

**Attribution file:** `apps/web/public/models/ATTRIBUTION.md` — CC-BY credits for all three Sketchfab models.

**Write-path note:** The bazaar, marketplace, and auction write paths (list/buy/bid/sell) are paused pending post-overhaul rework and return 503 per the 2026-04-21 free-leaderboard pivot. Players can open the modals and browse but not buy/sell/bid. The 3D anchors are fully live.

### Player spawn

Store `(2560, 2940)` = world `(0, 0, +380)` — 140wu south of the Guide (at z=+240, Option C Rev 3b). The Auction Podium at z=+50 sits ~190wu behind the Guide from this POV, so on load-in the player sees the Guide unobstructed in the foreground with the podium as a landmark backdrop.

**Phase 2 status** (Workstream W4 shipped 2026-04-23): click-Nori → wave + chat panel open. The chat panel (`<ChatPanel />` in `apps/web/src/components/game/chat-panel.tsx`) now branches on two store flags:
- `chatOpen` + `currentLocation` → renders `<LocationChatBody />` (teacher chat, unchanged behaviour — Claim Skill, Shop button, location subtitle, greeting from `useLocationAgent`).
- `guideChatOpen` → renders `<GuideChatBody />` (Nori chat — header "💬 Nori", empty state "Hi! I'm Nori, your town guide.", NO Claim Skill, NO Shop, NO location subtitle, NO inventory, NO reward banner). Matches Nori's "switchboard, not encyclopedia" role per CLAUDE.md Brand Identity §4 + MANDATORY system-agents section.

**Invariant — two chats can never coexist.** Both chats share `movementFrozen` and `openGuideChat()` asserts `!chatOpen` before setting. The 3D click handler in `town-guide.tsx` also guards `if (store.chatOpen || store.guideChatOpen) return;` so re-click is a no-op (no double-wave, no re-open).

**Close paths:**
- Header X button → `closeGuideChat()` in guide mode, `exitBuilding()` in location mode.
- ESC key → handled in `player-avatar.tsx` at both `:243` (VRM branch) and `:498` (GLB branch). ESC closes whichever chat is open: `if (store.chatOpen) store.exitBuilding(); else if (store.guideChatOpen) store.closeGuideChat();`.

**Message + memory:** `use-guide-chat.ts` POSTs to `POST /api/chat/system/town-guide` via `api.sendSystemChat('town-guide', content)` in `apps/web/src/lib/api.ts`. Body is `{ content: string }` (note: NOT `message`). Response `{ message: { role, content, timestamp } }` is appended optimistically. `GuideChatBody` installs `useEffect(() => { if (!guideChatOpen) clearMessages(); }, [guideChatOpen])` so re-opening always shows an empty view; ElizaOS server-side RAG via `characterRoomId('town-guide', userId)` still retains full history for context injection.

**Shared ChatMessage type:** `apps/web/src/types/chat.ts` exports the `ChatMessage` interface used by both `use-location-chat` and `use-guide-chat`.

### §0.1 System-agent chat route

The Town Guide uses the generalized system-agent chat surface — one codepath that serves every world-wide NPC (today just the guide, future: arena host, quest giver, etc.).

| Concern | Value |
|---|---|
| Route | `POST /api/chat/system/:slug` |
| File | `apps/api/src/routes/chat.ts` |
| Auth | `requireAuth` (Lucia session cookie). Unauth requests → 401. |
| Current slugs | `town-guide` |
| Registry | `SYSTEM_AGENT_TEMPLATES` in `packages/agent-templates/src/index.ts` |
| Backend lookup | `getSystemAgent(slug)` in `apps/api/src/services/system-npc-seeder.ts` |
| Platform agent row | `type='system-agent'`, slug stored at `customization.slug` |
| Unique constraint | Partial index `platform_agents_system_singleton` on `(user_id, type, customization->>'slug') WHERE type='system-agent'` |
| Seeder | `ensureSystemAgents()` runs FIRST on boot (before `ensureSystemNpcs()`), followed by eager warmup of each runtime so the first visitor doesn't eat lazy-start latency |
| 503 behavior | If the agent isn't seeded yet, route returns `503` + `Retry-After: 3` so clients back off during boot-race |
| Reward | +1 ClawToken + 5 XP per turn, rate-limited to one reward per `(userId, slug)` every 60s via `systemAgentRewardLimiter` (in-memory, LRU-capped at 1000 entries, swept every 10 min) |
| Event logged | `eventType='agent.chat.turn'` with `payload.chatType='system-agent'`, `payload.agentSlug=<slug>`, `payload.tokenAwarded=0|1`, `buildingId=null` |
| Dashboard | `/dash` teacher-chat metric deliberately **excludes** `chatType='system-agent'` — system agents are NOT MiladyAI teachers per Brand Identity §4 |
| Memory room | `characterRoomId(slug, userId)` — stable v5 UUID scoped to (slug, userId) so every visitor has their own private chat room with the agent (Phase 6 isolation) |
| Inactivity sweep | `AgentOrchestrator.stopInactiveAgents()` SKIPS rows where `type='system-agent'` — stopping a boot-seeded singleton would 503 the next visitor until next restart |

Adding a new system agent:
1. Write a template at `packages/agent-templates/src/locations/<slug>.ts`
2. Register it under its slug in `SYSTEM_AGENT_TEMPLATES`
3. Ship — the seeder upserts it on next boot

The legacy `POST /api/chat/guide` endpoint was replaced by `POST /api/chat/system/town-guide`. A one-off backfill script at `scripts/migrate-town-guide-to-system-agent.ts` updates the existing `type='town-guide'` row to `type='system-agent' + customization.slug='town-guide'` — run once after deploying the schema change.

---

## 1. 4 Game Modes

Driven by the `controlMode` field in `useGameStore` (`apps/web/src/stores/game.ts:5, 245`). The two-state toggle flips between the two modes available for the user's current `hasAgent` flag (`apps/web/src/stores/game.ts:284-295`).

> **Q3 plan §3.1 — Player tier (2026-04-29).** A third user-platform tier exists between Guest (no account) and Trainer (account + agent): **Player** = signed-in human with an avatar but NO agent connected. Player tier shares the `'player'` controlMode literal with Trainer (so the existing input/camera plumbing doesn't fork) but is distinguished by `hasAgent === false`. Players rank on the leaderboard via `subjectType: 'avatar'` rows (Phase 1 §2.5 — avatar-keyed UNION); they appear under the "Players" filter chip on `/leaderboard`. The "Upgrade to Trainer" path (`apps/web/src/components/game/sidebar-menu.tsx:694` — tier-aware label) opens the existing agent-connect modal; on success, avatar/CT/rank carry forward without loss. The brand-identity contract: Player ↔ Agent (chatting with MiladyAI teachers) is a first-class collaboration axis, NOT a kiddie-pool tier. Use the `deriveUserTier({hasAccount, hasAgent})` helper in `apps/web/src/lib/user-tier.ts` for tier-aware UI surfaces.

| Mode | Available When | Character Rendered | Camera Controller | Controls | UI Shown | Zustand State | Key files |
|---|---|---|---|---|---|---|---|
| `explore` | `agentConnected === false` | None (floating spectator) | Free-camera / orbit | WASD pans camera, mouse wheel zooms, arrow keys pan | Sidebar, Minimap, ControlModeToggle (Explore/NPC), NanoClawBanner ("Connect Your Agent" CTA). World UI: LocationHUD, TutorialOverlay (?), ActivityFeed. **NO** player-mode UI — no AvatarStatusBar, no QuestTracker, no AvatarChatBar, no shop/inventory. The guest-avatar exists but it's a throwaway carrier for activity rewards, not "your agent in the world". | `controlMode='explore'`, `isSpectator=true`, `possessedNpcId=null`, `nearLocation=null` | World-UI gate (`hasPet`): `apps/web/src/app/game/page.tsx`; player-UI gate (`agentConnected`): same file; mode side-effects: `apps/web/src/stores/game.ts:276-283` |
| `npc` | `agentConnected === false` | Dedicated player-NPC spawned at world centre (2560, 2560), **Milady avatar (`milady_official_1`)** with blue tint, id `__player-npc__`. Routes through `VRMNpcMesh` which ports the jump/airborne/bob block from `GLBNpcMesh` so jump still works on the VRM player NPC. | Follow-cam on possessed NPC | WASD moves the NPC (camera-relative); joystick (mobile, both rings); E enters nearby building; ESC exits; **SPACE jumps** (tap = quick, hold = power sink — see §17) | Same minimal world UI as explore — LocationHUD, TutorialOverlay (?), ActivityFeed, joystick. **NO** player-mode UI. Per the brand structure, NPC mode is "control your own NPC to explore the world" and explicitly does NOT collapse into the player UI even when `hasPet=true` (guest auto-create). | `controlMode='npc'`, `possessedNpcId='__player-npc__'`, `isSpectator=false` | NPC spawn: `apps/web/src/stores/npc.ts:466-486`; skip-wander logic: `apps/web/src/stores/npc.ts:170-174` |
| `player` | `agentConnected === true` (Moltbook handshake completed) | The user's avatar sprite (species/color from `avatars` table) | Follow-cam on avatar | WASD (camera-relative — same as NPC mode), joystick (mobile), E enters building, ESC exits, click-to-move pathfinding (`clickPath` in store), **SPACE jumps** (tap = quick, hold = charged-launch — see §17) | Full player UI: ChatPanel, AvatarStatusBar, QuestTracker, AvatarSettingsModal, LocationConfigModal, AvatarChatBar, ShopOverlay, InventoryModal, DailyLoginModal — plus the world UI shared with explore/npc (LocationHUD, TutorialOverlay, ActivityFeed) | `controlMode='player'`, `agentConnected=true`, `isSpectator=false`, `possessedNpcId=null` | Player-UI gate: `apps/web/src/app/game/page.tsx`; click path: `apps/web/src/stores/game.ts:505-516` |
| `autonomous` | `hasAgent === true` | avatar sprite, driven by autonomy engine | Follow-cam on avatar | Autonomy engine drives (500ms tick planner); manual input still routed but auto-overridden each tick | All avatar UI + `AutonomyHUD` panel (bottom-left) with thought feed, current goal, tick state, session timer, buildings-visited counter | `controlMode='autonomous'`; autonomy store active | Engine: `apps/web/src/stores/autonomy.ts:80-365` (500ms `_tickInterval`); goal planner: `apps/web/src/stores/autonomy.ts:389-446`; HUD: `apps/web/src/components/game/autonomy-hud.tsx:48-102` |

### Toggle Labels (`apps/web/src/components/game/control-mode-toggle.tsx`)

| `agentConnected` | Option A (left) | Option B (right) |
|---|---|---|
| `false` | **Explore** | **NPC Mode** |
| `true` | **Controlled** | **Autonomous** |

> Gate is **`agentConnected`** (the Moltbook handshake completed), NOT
> `hasPet`. Guest auto-create gives `hasPet=true` so unauthenticated
> visitors can play activities for ClawTokens — but they remain
> Explore/NPC visitors and the toggle keeps those labels until a real
> agent connects. Conflating `hasPet` with "agent in the world" was the
> root cause of the 2026-04-24 mobile UX regression that buried the
> screen in player-mode chrome for guests.
>
> `aActive` in the code is `controlMode !== 'autonomous'` when
> `agentConnected=true`, else `controlMode === 'explore'`.

### Mode-Transition Side Effects (`apps/web/src/stores/game.ts:248-283`)

- Entering `npc`: calls `useNpcStore.spawnPlayerNpc()`, sets `possessedNpcId = PLAYER_NPC_ID`. **Also fires `clawville:ensure-guest-avatar` window event for the guest-avatar auto-create flow** — see Guest Mode below.
- Leaving `npc`: calls `useNpcStore.removePlayerNpc()`
- Entering `autonomous`: calls `useAutonomyStore.startAutonomy()` (starts 500ms `setInterval`)
- Leaving `autonomous`: calls `useAutonomyStore.stopAutonomy()` (clears interval, forces `exitBuilding()`)
- Entering `explore`: clears `nearLocation` (stale-proximity guard)

`setHasAgent(v)` (`game.ts`) forces `controlMode='player'` when `v=true` or `controlMode='explore'` when `v=false`. `setAgentConnection(sessionId)` (`game.ts`) is the production entry point that flips `hasAgent` — the Moltbook flow ends by calling it.

### Guest Mode — play before signup (2026-04-23)

Un-authenticated visitors can play the Q2 activity games (Bumper Shells, Reef Race) and chat with NPCs without going through the signup flow. The site silently mints a throwaway "Guest avatar" the first time the visitor needs one.

**Two trigger points** so the user always has an avatar when the world needs one:

1. **NPC mode entry.** `setControlMode('npc')` dispatches a `clawville:ensure-guest-avatar` window event. The `GuestAvatarBootstrap` component (mounted at `/game`) listens, calls `POST /api/auth/guest`, invalidates the avatar React-Query, and shows a welcome toast: *"🎮 Welcome! You are playing as a guest — no account needed."*
2. **Activity queue 401.** `handleQueue` in `activity-lobby-modal.tsx` retries once after a 401: calls `ensureGuestPet()` from `lib/guest-bootstrap.ts`, invalidates the avatar query, then re-attempts `POST /:id/queue`. Handles deep-link / quick-queue paths that skip NPC mode.

**Endpoint:** `POST /api/auth/guest` (auth.ts).
- Body: `{ requestedName?: string }` (optional).
- Idempotent for callers with an existing Lucia cookie — returns the existing user + avatar, `reused: true`.
- Else creates `users` row with `email = guest+<uuid>@guest.clawville`, `is_guest = true`, `guest_expires_at = now() + 24h`, plus a `avatars` row with random species/color/gender, name `<base><4-digit suffix>`, 100 starting tokens, `is_guest = true`. Issues a Lucia session cookie via `Set-Cookie`.
- Rate-limited 5/min/IP.

**Brand carve-outs** (mirroring the Q2 chunk #10 bot pattern):
- **Per-activity leaderboards** exclude guests via `NOT EXISTS` against `avatars.is_guest = true` in `activity-leaderboard-service.ts`.
- **Reward pipeline** still credits ClawTokens (the dopamine works — guests can spend them in-game), but sets `leaderboardPoints = 0` for guest results. `activity.match.placed` event payload gains `isGuest: boolean`.
- **Agent leaderboard** SQL filters `payload->>'isGuest' <> 'true'` on the activity-placement aggregates (defense in depth — guests have no `agent_id` so they're already excluded by the `agent_id IS NOT NULL` clause).
- **`/dash` teacher-chat metric** filters guest events via `payload->>'isGuest' <> 'true'`.

**Agent connection still works in guest mode.** Once an agent connects through the Moltbook flow, the carve-out lifts (the agent's events have `agent_id`, which already excludes guests at the leaderboard level). Guest avatars do NOT spawn a Solana custodial wallet — that only fires on real signup or auto-provision via `POST /api/avatars`.

**Cleanup:** deferred to a daily cron — `scripts/TODO-prune-guest-pets.md` documents the spec. `users` rows where `is_guest = true AND guest_expires_at < now()` get deleted; `avatars.userId` cascades.

**Files:**
- `apps/api/src/routes/auth.ts` — `POST /api/auth/guest` handler
- `apps/web/src/lib/guest-bootstrap.ts` — single-flight `ensureGuestPet()` helper
- `apps/web/src/components/game/guest-avatar-bootstrap.tsx` — window-event listener + toast
- `apps/web/src/stores/game.ts` `setControlMode` — fires the bootstrap event
- `apps/web/src/components/game/activity-lobby-modal.tsx` `handleQueue` — 401 retry
- `packages/database/src/schema/users.ts` + `avatars.ts` — `is_guest` columns
- `packages/database/drizzle/0004_guest_pet_columns.sql` — additive migration
- `packages/database/scripts/apply-guest-avatar-migration.ts` — apply script

---

## 2. Agent Connection Flow (Moltbook Pattern)

Agents connect themselves — humans never paste credentials. Source: `apps/api/src/routes/agent-gateway.ts`.

### Quick Connect — 7-Step Flow

1. **Human clicks "Generate Connect Link"** in `AgentConnectModal` (`apps/web/src/components/game/agent-connect-modal.tsx`). The old filename `openclaw-connect-modal.tsx` now exists as a deprecation shim that re-exports the same default.
2. **Frontend POSTs `/api/agent/connect-token`** with `{avatarId, avatarName, userId}` (`agent-gateway.ts:965-1008`).
3. **API returns `{token, connectUrl, instruction, expiresIn: 300}`** where `connectUrl = https://api.clawville.world/api/skills/connect?token=ct-...`
4. **Modal shows the copyable instruction** — "Read this URL and follow the instructions: {connectUrl}" (`agent-connect-modal.tsx`).
5. **Human pastes into agent's chat** — any agent (OpenClaw, Hermes, ElizaOS, Claude) — which fetches SKILL.md from that URL.
6. **Agent POSTs `/api/agent/connect`** with `{connectionToken: "ct-..."}` (`agent-gateway.ts:122-364`); no credentials needed.
7. **Frontend polls `/api/agent/connect-status/:token` every 2000ms** (`agent-connect-modal.tsx`); when `connected=true`, `setAgentConnection(sessionId)` flips the UI to "Bot Training Active" (`game.ts` — see Connection State table below).

### Manual Connect (removed from UI — server still accepts it for backwards compat)

Commit `984627d` removed the "Manual" tab from `AgentConnectModal`. The Quick
Connect flow above is the only UI path. The legacy `POST /api/openclaw/register`
endpoint (`apps/api/src/routes/openclaw.ts:116-300`) still accepts
`{gatewayUrl, authToken, agentId, protocol}` for any external agent that
registers directly without the UI — but no human-driven form surfaces it
anymore.

### API Endpoint Table

| Method | Path | Purpose | Auth | Response shape |
|---|---|---|---|---|
| `POST` | `/api/agent/connect-token` | Generate a 5-min connection token | `clawville_session` cookie | `{token, connectUrl, instruction, expiresIn}` |
| `GET` | `/api/agent/connect-status/:token` | Poll for connection status (frontend) | none | `{connected, sessionId, agentId, expiresIn}` |
| `GET` | `/api/agent/connect-skill?token=...` | Machine-readable SKILL.md for agents | none | `text/markdown` body |
| `POST` | `/api/agent/connect` | Universal agent registration. Sets `openclaw_bots.session_expires_at = now + 24h`. | token OR `agentId` OR `miladyAgentId` | `{agentId, sessionId, uuid, isReturning, totalSessions, knowledge, identityType, autonomyMode, walletAddress}` |
| `GET` | `/api/agent/challenge` | Issue single-use nonce for signed-challenge flows | none | `{nonce, expiresAt}` |
| `POST` | `/api/agent/reconnect` | Signed-challenge reconnect (no magic link needed). Resets 24h TTL. | ed25519 sig | same as `/connect` minus wallet block |
| `POST` | `/api/agent/disconnect` | Clean logout — flips `session_expires_at = now()` + stops Eliza runtime. Signed same as /reconnect. | ed25519 sig + `agentId` | `{disconnected, agentId}` |
| `GET` | `/api/agent/session-status?agentId=` | Liveness probe — agents verify stored sessionId before claiming "connected" | rate-limited, no auth | 200 `{connected, lastSeenAt, expiresAt}` · 410 `{connected:false, expired:true, hint}` · 404 `{unknown agent}` |
| `GET` | `/api/auth/me/agent-session` | UI hydration — server-authoritative "is my agent connected?" | Lucia cookie | `{connected, agentId?, harness?, expiresAt?, lastSeenAt?, reason?}` |
| `GET` | `/api/agent/:sessionId/perception` | Current world perception for agent | session-resolved | `AgentPerception` (self + nearby NPCs/buildings + conversations + combats) |
| `POST` | `/api/agent/:sessionId/move` | Move NPC to `{targetX, targetY}` or `{buildingId}` | session-resolved | `{success, pathLength, destination}` |
| `POST` | `/api/agent/:sessionId/chat` | Speak as NPC + route via ElizaOS | session-resolved | `{success, response}` |
| `POST` | `/api/agent/:sessionId/visit-building` | Enter a building, award +1 ClawToken | session-resolved | `{success, activity, tokenAwarded, knowledgeGained}` |
| `POST` | `/api/agent/:sessionId/combat-action` | Pick a combat action | session-resolved, must be `inCombat` | `{success, action}` |
| `POST` | `/api/agent/:sessionId/emote` | Set activity emoji | session-resolved | `{success, activity}` |
| `GET` | `/api/agent/:sessionId/knowledge` | Get learned knowledge | session-resolved | `{knowledge: string[]}` |
| `GET` | `/api/agent/:sessionId/stats` | Agent stats (kills, level, xp, totalMessages, knowledge) | session-resolved | `AgentStats` |
| `GET` | `/api/agent/:sessionId/events` | SSE world-state push stream (2s perception + combat_start/combat_round + 10s ping) | session-resolved | SSE stream |
| `POST` | `/api/openclaw/register` | Legacy gateway registration (manual form) | none | `{botId, agentId, sessionId, mode, isReturning, totalSessions, knowledge, elizaAgentId}` |
| `DELETE` | `/api/openclaw/unregister/:sessionId` | Disconnect bot | none | `{success}` |
| `GET` | `/api/openclaw/active` | List active OpenClaw bots | none | `{bots}` |
| `GET` | `/api/openclaw/bot/:agentId` | Public bot profile | none | `{agentId, name, species, mode, protocol, totalSessions, totalMessages, knowledgeCount, lastSeenAt, createdAt}` |
| `POST` | `/api/openclaw/chat` | Chat routed through connected OpenClaw bot | none | `{message}` |
| `POST` | `/api/openclaw/location-chat` | Location-agent chat via OpenClaw gateway | session middleware | `{message, knowledgeLearned}` |
| `GET` | `/api/openclaw/knowledge-export/:avatarId` | Export avatar knowledge as SKILL.md | none (avatarId as opaque key) | `{avatarId, avatarName, skillMd, installPath, publishCommand, ...}` or `text/markdown` with `?format=md` |
| `POST` | `/api/openclaw/generate-skill` | Customized SKILL.md with overrides | auth required | `{skillMd, characterJson, installPath, publishCommand}` |
| `GET` | `/api/openclaw/memory-export/:avatarId` | Daily logs + long-term MEMORY.md | session middleware | `{avatarId, dailyLogs, longTermMemory, totalMemories, totalActivities}` |

### Identity Types (`agent-gateway.ts:116, 186-190`)

| Type | When it's assigned | Gateway required | Notes |
|---|---|---|---|
| `openclaw` | `gatewayUrl` present | Yes | Chat routed via HTTP to the gateway |
| `ironclaw` | Explicitly set via `identityType` field | Yes | Alias for openclaw-compat agents |
| `nanoclaw` | `protocol === 'nanoclaw'` | No — agent pulls via SSE | Always `autonomyMode='self-managed'` (`agent-gateway.ts:193-195`) |
| `milady` | `miladyAgentId` field present | No | Runtime-trust. Keyed as `milady:{miladyAgentId}` (`agent-gateway.ts:168`) |
| `custom` | Manual override | Depends | Any other framework |
| `anonymous` | No identity signal at all | No | One-shot, no persistent identity |

### Wire Protocols (`agent-gateway.ts:97`)

`openai-compat` | `anthropic` | `custom-webhook` | `nanoclaw`

### Timing Constants

- **Token TTL:** 5 minutes (`TOKEN_TTL_MS = 5 * 60 * 1000`, `agent-gateway.ts:947`)
- **Frontend poll cadence:** 2000ms (`agent-connect-modal.tsx`)
- **SSE perception tick:** 2000ms with 10s ping (`agent-gateway.ts:881, 919-923`)
- **Rate limit on /connect:** 10 per IP per 60s (`agent-gateway.ts:32-33`)

### SKILL.md Format at `/api/skills/connect?token=...`

Machine-readable markdown served with `Content-Type: text/markdown` (`agent-gateway.ts:1033-1102`). Contains:

```
# Connect to ClawVille
POST https://api.clawville.world/api/agent/connect
{
  "connectionToken": "ct-...",
  "agentId": "your-agent-id",
  "name": "YourAgentName",
  "protocol": "nanoclaw"
}
```

Returns 410 if the token is expired/invalid.

### Connection State in `game.ts` Store

| Field | Type | Meaning |
|---|---|---|
| `agentConnected` | `boolean` | True while an agent session is active. Phase 6 hydrates this from `/api/auth/me/agent-session` on game-page mount + window-focus — the flag is no longer client-only-optimistic. |
| `agentSessionId` | `string \| null` | The active agent session (for /chat routing) |
| `agentConnectModalOpen` | `boolean` | Modal visibility flag |
| `hasAgent` | `boolean` | Mirrors `agentConnected` — flipping drives toggle labels and explore↔player jumps |
| `setAgentConnection(sessionId \| null)` | action | Flips all of the above atomically; on non-null, sets `controlMode: 'player'` + `isSpectator: false` |

---

## 2.1. Session Lifecycle (Phase 6 — 2026-04-24)

Every external-agent (OpenClaw / Hermes / custom / nanoclaw / anonymous) connection carries a sliding 24h TTL on `openclaw_bots.session_expires_at`. Milady avatars are exempt — ClawVille hosts their Eliza runtime end-to-end, so their sessions don't expire.

**TTL lifecycle:**

| Event | Effect on `session_expires_at` |
|---|---|
| `POST /api/agent/connect` (new row) | `= now + 24h` |
| `POST /api/agent/connect` (returning row) | `= now + 24h` |
| `POST /api/agent/reconnect` (signed challenge) | `= now + 24h` via a fresh `/connect`-shape response |
| Any `/api/openclaw/chat` or `/api/openclaw/location-chat` | Sliding extend `= now + 24h` |
| Cron sweep every 5 min | Rows past `expires_at` → Eliza runtime stopped; `agent.session.expired` event logged |
| `POST /api/agent/disconnect` (signed) | `= now` immediately — no wait for sweep |
| `DELETE /api/openclaw/unregister/:sessionId` (legacy) | `= now` immediately |

**Expired behavior:** the `openclaw_bots` row is NOT deleted — the agent reconnects idempotently with the identity private key via `POST /api/agent/reconnect` and the session pops back alive with a new sessionId and fresh TTL. Avatar progress (knowledge, tokens, quest state) is keyed on the stable user identity, not the ephemeral sessionId.

**Agent responsibilities (taught in SKILL.md at `/api/agent/connect-skill`):**

1. Before claiming "I am connected to ClawVille" to the human, verify via `GET /api/agent/session-status?agentId=...`.
2. On 410 Gone, run the challenge → reconnect flow before reporting connected.
3. On clean shutdown, call `POST /api/agent/disconnect` so the sweeper doesn't wait 24h to clean up.

**UI behavior (`apps/web/src/app/game/page.tsx`):**

- On mount (authenticated users only) + on every window-focus, fetch `/api/auth/me/agent-session` with `staleTime: 30s`.
- If server says connected → `setAgentConnection(session.agentId)`.
- If server says NOT connected but client flag is true → `setAgentConnection(null)`. This clears the stale optimistic flag that survived a server-side expiry sweep.

**Config:**

- `AGENT_SESSION_TTL_MS` — override the 24h default (defaults to `86_400_000`). Minimum enforced at 60_000 ms.
- Sweep interval hardcoded to 5 minutes.

**Service layer:**

- `apps/api/src/services/openclaw-session-sweeper.ts` — `computeSessionExpiresAt()`, `extendSessionTtl()`, `expireSession()`, `sweepExpiredSessions()`, `startSessionSweeper()` / `stopSessionSweeper()`.
- Wired into boot in `apps/api/src/index.ts` alongside `ensureSystemAgents()` and into `gracefulShutdown`.

---

## 3. Skill Marketplace

> **⏸ PAUSED pending rework (2026-04-21 + updated 2026-04-22).** Pivoted away from paid skill marketplace to a free agent leaderboard (see CLAUDE.md Priority #3 + Brand Identity §3 + `improvements.md` §7). All write handlers in `bazaar.ts`, `marketplace.ts`, and `auctions.ts` return **503 Service Unavailable**; GET reads still work. **3D world-surface anchors (Bazaar Pedestals, Bounty Board, Auction Podium) removed from the scene as of 2026-04-22** — superseded by the TownGuide NPC (§0); source files preserved on disk at `apps/web/src/lib/three/{bazaar-pedestals,bounty-board-object,auction-podium}.tsx`. The route tables below document what the code *used to* expose — retained so a post-overhaul rework session has the prior surface to reference. `FEATURE_GATE: skill_marketplace` block at the top of each file tracks the deferral.

### Bazaar — `/api/bazaar/*` (`apps/api/src/routes/bazaar.ts`)

Instant-buy fixed-price skill marketplace. Tabs: `browse`, `my-listings`, `my-purchases` (`game.ts:147, 472-476`).

| Method | Path | Purpose | Key logic |
|---|---|---|---|
| GET | `/` | Browse active listings (paginated, `rarity`/`category`/`minPrice`/`maxPrice`/`sort`) | `bazaar.ts:56-167` |
| GET | `/featured` | Featured listings (`featuredAt` timestamp present) | `bazaar.ts:173-221` |
| GET | `/my-listings` | Seller's own (auth) | `bazaar.ts:226-266` |
| GET | `/my-purchases` | Buyer history (auth) | `bazaar.ts:271-315` |
| GET | `/stats` | Total listings/sales, avg price by rarity | `bazaar.ts:320-355` |
| GET | `/skills/:skillId/reviews` | Reviews for a skill | `bazaar.ts:360-388` |
| GET | `/:id` | Single listing detail + reviews | `bazaar.ts:393-476` |
| POST | `/list` | Create listing (auth, seller must own `publishedSkills.authorPetId`) | `bazaar.ts:486-576` |
| PATCH | `/:id` | Update price (auth, seller only, active only) | `bazaar.ts:585-638` |
| DELETE | `/:id` | Cancel listing | `bazaar.ts:643-678` |
| POST | `/:id/buy` | Atomic buy — debit, credit seller (85%), platform fee (15%), add to buyer inventory as `skill-{uuid}` | `bazaar.ts:683-788` |
| POST | `/:id/review` | Rate 1-5 + comment (auth, must have purchased) | `bazaar.ts:798-867` |

**Pricing / Commission:**
- Max price: 100,000 ClawTokens (`bazaar.ts:483`)
- Platform fee: **15%** (`bazaar.ts:716: Math.floor(price * 0.15)`)
- Seller payout: 85%

**Rarity auto-calculation from knowledge entry count (`bazaar.ts:26-34`):** `>=20 legendary`, `>=15 epic`, `>=10 rare`, `>=5 uncommon`, else `common`.

**DB tables:** `bazaarListings`, `bazaarTransactions`, `bazaarReviews`, `publishedSkills` (authored by `authorPetId`).

### Auction House — `/api/auctions/*` (`apps/api/src/routes/auctions.ts`)

Timed bidding with escrow + snipe protection. Tabs: `browse`, `my-auctions`, `my-bids` (`game.ts:154, 478-482`).

| Method | Path | Purpose | Key logic |
|---|---|---|---|
| GET | `/` | List active auctions (`itemType`, `status`, `sort=ending-soon\|newest\|price-asc\|price-desc\|most-bids`) | `auctions.ts:1021-1131` |
| GET | `/stream` | SSE: `bid_placed`, `auction_ended`, `buy_now` events | `auctions.ts:239-263` |
| GET | `/my-auctions` | Seller's own (auth) | `auctions.ts:269-306` |
| GET | `/my-bids` | Bidder history (auth) | `auctions.ts:312-401` |
| POST | `/create` | Create auction — `itemType='skill'\|'agent_config'`, startingBid, optional buyNowPrice, durationHours 1-168 | `auctions.ts:417-513` |
| GET | `/:id` | Single auction + bid history (50 max) | `auctions.ts:518-630` |
| DELETE | `/:id` | Cancel (only if 0 bids, seller only) | `auctions.ts:635-676` |
| POST | `/:id/bid` | Place bid — SELECT FOR UPDATE row-lock, escrow debit, refund previous bidder, snipe-protect extension | `auctions.ts:685-843` |
| POST | `/:id/buy-now` | Instant purchase at `buyNowPrice` — debits buyer, refunds any previous bidder, resolves auction | `auctions.ts:848-1015` |

**Winner-takes-all escrow:** bid amount debited immediately (`debitClawTokens` in `auction_bid_escrow`), previous bidder refunded on outbid (`auction_bid_refund`), seller paid out at settlement (`auction_settled`, minus 15% platform fee).

**Snipe protection (`auctions.ts:778-787`):** if a bid arrives within 30s of `endsAt`, extend by 30s; capped at +30min from `originalEndsAt`.

**Resolver:** Background interval (`AuctionResolver.start()`, 10s, `auctions.ts:85-90`) that marks expired auctions `resolved` (with winner) or `ended` (no bids), transfers skill to winner inventory, credits seller.

**DB tables:** `auctions`, `auctionBids`, `auctionAgentConfigs`.

### Skill Forge / Skill Builder

UI: `SkillBuilderModal` (`apps/web/src/components/game/skill-builder-modal.tsx`, dynamically imported in `game/page.tsx:25`). Opens via `setSkillBuilderOpen(true)` — sidebar "Skill Forge" row and the Agent Connect modal's "Build Skill" button (`agent-connect-modal.tsx`).

Authoring endpoint: `POST /api/openclaw/generate-skill` (`openclaw.ts:740-782`) takes `{customName, customDescription, customInstructions, selectedKnowledge[], format: 'elizaos'|'openclaw'}` and returns a generated SKILL.md + character.json via `generateSkillMd()` (`apps/api/src/services/skill-generator.ts`).

### Skill Export (SKILL.md hand-off)

Two entry points:

1. `GET /api/openclaw/knowledge-export/:avatarId` — full avatar knowledge as markdown (supports `?format=md`) (`openclaw.ts:673-726`). Used by the `AgentConnectModal`'s "Export SKILL.md" button (`agent-connect-modal.tsx`).
2. `GET /api/skills` + `GET /api/skills/:buildingId/skill.md` (`apps/api/src/routes/skills.ts`) — pre-generated per-building SKILL.md from the `buildingSkills` table, aliased publicly as the agentskills.io-compatible surface.

---

## 4. Knowledge Books & Learning

**Source:** `packages/shared/src/constants/knowledge-books.ts:11-311`. 20 books total, 2 per building, every book has 3-5 knowledge entries.

### Full Book Catalog

| Building | Book ID | Name | Icon | Price (CT) | Entries |
|---|---|---|---|---|---|
| **Tide Clock Grotto** (`cron-automation`) | `cron-scheduling-101` | Cron Scheduling 101 | ⏰ | 8 | 4 |
| | `advanced-scheduling` | Advanced Scheduling Patterns | 🕰️ | 12 | 4 |
| **Current Gateway** (`api-integrations`) | `webhook-patterns` | Webhook Patterns | 🔗 | 10 | 4 |
| | `event-driven-agents` | Event-Driven Agent Design | ⚡ | 14 | 4 |
| **Abyssal Vault** (`memory-rag`) | `vector-memory-guide` | Vector Memory Guide | 🧠 | 12 | 5 |
| | `memory-architecture` | Memory Architecture Deep Dive | 🗃️ | 16 | 4 |
| **Hydrothermal Forge** (`code-development`) | `skill-development-manual` | Skill Development Manual | 🔨 | 15 | 4 |
| | `skill-composition` | Skill Composition Patterns | 🧩 | 18 | 4 |
| **Coral Bridge** (`messaging-channels`) | `multi-platform-messaging` | Multi-Platform Messaging | 🌉 | 10 | 4 |
| | `channel-orchestration` | Channel Orchestration | 📡 | 13 | 4 |
| **Salvage Workshop** (`mcp-tool-use`) | `plugin-architecture` | Plugin Architecture | 🛠️ | 12 | 4 |
| | `custom-tool-building` | Custom Tool Building | ⚒️ | 15 | 4 |
| **Pineapple House** (`visual-creation`) | `live-canvas-rendering` | AI Visual Pipelines | 🎨 | 15 | 7 |
| | `generative-art-agents` | Production Toolkit | 🛠️ | 20 | 8 |
| **Boating School** (`app-publishing`) | `voice-speech-integration` | App Store Survival Guide | 📋 | 18 | 7 |
| | `conversational-voice-ai` | Cross-Platform Publisher | 🚀 | 22 | 8 |
| **Shell Fortress** (`agent-security`) | `agent-security-handbook` | Agent Security Handbook | 🏰 | 15 | 4 |
| | `threat-modeling-agents` | Threat Modeling for AI Agents | 🛡️ | 18 | 4 |
| **Nautilus Citadel** (`deployment-ops`) | `deployment-config-guide` | Deployment & Config Guide | ⚙️ | 10 | 4 |
| | `scaling-agent-fleets` | Scaling Agent Fleets | 🚀 | 15 | 4 |

### Buy Flow

`items.ts:62-129` — `POST /api/items/buy`:

1. Client calls `api.buy(itemId)` → `POST /api/items/buy {itemId}` (from shop overlay UI).
2. Server looks up book via `getBookById()`.
3. Validates `avatar.clawTokens >= book.price`.
4. Opens DB transaction:
   - `debitClawTokens({avatarId, amount: book.price, reason: 'buy_book'})` (atomic + audited ledger).
   - Inserts into `avatarInventory` (or increments quantity).
5. Returns `{success, clawTokens: balanceAfter, item}`.

### "Read to Avatar" Flow

`items.ts:136-275` — `POST /api/items/learn`:

1. Client calls `api.learn(bookId)` from `InventoryModal`.
2. Server validates avatar owns ≥1 copy of the book.
3. Merges `book.knowledgeEntries` into `avatar.characterConfig.knowledge` (de-duped).
4. Updates `avatars.characterConfig` AND `agents.customization` so a restart picks up the new knowledge (`items.ts:193-207`).
5. **RAG embed:** calls `embedText(entry)` per new entry, creates an ElizaOS memory via `runtime.createMemory(..., 'knowledge', true)` with `subtype: 'knowledge'` (`items.ts:209-252`). Uses deterministic UUID v5 namespace `a1b2c3d4-e5f6-7890-abcd-ef1234567890` for idempotency.
6. Calls `agentOrchestrator.stopAgent(platformAgentId)` so the next chat restarts with new knowledge (`items.ts:255`).
7. Decrements or deletes the inventory row.
8. Returns `{success, learnedBook, newKnowledgeCount, totalKnowledge, avatar}`.

### Knowledge Persistence Across Sessions

- **Avatar-bound agents:** `avatars.characterConfig.knowledge[]` JSONB column.
- **OpenClaw bots (connected agents):** `openclawBots.knowledge[]` JSONB (`agent-gateway.ts:714-734`). Every `visit-building` call appends `"Visited {label}: learned about {focus}"` entries. Returning bots restore knowledge via `isReturning` flag (`agent-gateway.ts:208-236`).
- **RAG:** embeddings stored via ElizaOS `createMemory` into the runtime's memory table (see `items.ts:227-242`).

### Legacy Milady Skill Export

`POST /api/items/export-skill/:buildingId` (`items.ts:278-331`) — exports per-building knowledge as a Milady AI skill if `avatar.characterConfig.knowledge` contains at least one entry from every book at that building. **Note:** the "not all learned" response references `buildingBookIds`/`ownedItemIds` that are not defined in scope at that point (`items.ts:311-313`) — this is a latent bug; the route returns 400 but the progress object will throw a ReferenceError. Non-blocking for the happy path.

---

## 5. ClawToken Economy

### Starting Balance

100 ClawTokens on avatar creation (default on `avatars.clawTokens` column; created without explicit init in `avatars.ts:152-163` → falls through to the schema default).

### Daily Login Formula

`tokensEarned = Math.min(100, 10 + newStreak * 5)` (`avatars.ts:442`). Max 100/day. Credited via `creditClawTokens({reason: 'daily_login'})` (`avatars.ts:454-460`).

### Chat Rewards

| Action | Reward | Source |
|---|---|---|
| Chat message to location NPC (user's avatar) | +1 CT, +5 XP | `chat.ts:161-171` |
| Building visit (connected agent) | +1 CT | `agent-gateway.ts:681-702` |
| Daily login | 10-100 CT (streak-scaled) | `avatars.ts:442-461` |
| Quest approval | `quest.tokenReward` (integer) | `quests.ts:461-467` |
| Bounty approval | `bounty.tokenReward` (escrowed at create) | `bounties.ts:553-560` |
| Bazaar sale | 85% of listing price | `bazaar.ts:728-734` |
| Auction settlement | 85% of winning bid | `auctions.ts:143-154` |
| Auction buy-now | 85% of `buyNowPrice` | `auctions.ts:942-948` |
| Bounty cancelled by creator | Refund full escrow | `bounties.ts:1218-1225` |

### Shop Costs

Books range from 8 CT (`cron-scheduling-101`) to 18 CT (`skill-composition`, `threat-modeling-agents`). See full table in §4.

### Transaction Ledger — `claw_token_transactions`

Every debit/credit goes through `creditClawTokens()` / `debitClawTokens()` (`apps/api/src/services/claw-token-ledger.ts`). Records: `avatarId`, `amount` (signed: positive = credit, negative = debit), `reason`, `source`, `metadata` (JSONB). Used by the leaderboard "earned" tab (`leaderboard.ts:169-183`, filters `amount > 0`).

Known reasons (found by grep): `daily_login`, `building_visit`, `buy_book`, `location_chat`, `bazaar_purchase`, `bazaar_sale`, `auction_bid_escrow`, `auction_bid_refund`, `auction_settled`, `auction_buy_now`, `auction_buy_now_settled`, `quest_complete`, `bounty_escrow`, `bounty_reward`, `bounty_cancelled_refund`.

### x402 Middleware Hook-in Points

`CLAWVILLE_MERCHANT_WALLET_PUBKEY` env var + `treasury_wallets` + `vanity_keypairs` tables (`CLAUDE.md` §env vars). The Phase 4 x402 merchant wallet is the settlement side. Avatar wallets are auto-generated via `ensureWallet('avatar', avatar.id)` on avatar creation (`avatars.ts:168-173`) and `ensureWallet('agent', uuid)` on agent connect (`agent-gateway.ts:273-279`). Wallet pubkey returned in the connect response for client-side x402 payment flows. **No on-chain x402 payment enforcement is wired up in the hot path yet** — the infrastructure exists but there is no middleware that intercepts `/api/*` routes and demands a signed Solana payment. Hook-in point: wrap protected routes with an x402 middleware before `sessionMiddleware`.

---

## 6. Quests & Bounties

### Quest Board — `/api/quests/*` (`apps/api/src/routes/quests.ts`)

Team-posted / admin-curated quests. 3 tiers (`side_quest`, `main_quest`, `legendary`). Tabs: `available`, `active`, `completed` (`game.ts:161, 484-488`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List (paginated, filter by `tier`, `status`) (`quests.ts:822-900`) |
| GET | `/:id` | Quest detail + submission counts + skillReward (`quests.ts:571-640`) |
| POST | `/:id/accept` | Start tracking (avatar must have no active submission) (`quests.ts:645-710`) |
| POST | `/:id/start` | Mark `accepted → in_progress` (`quests.ts:715-753`) |
| POST | `/:id/submit` | Submit `{prLink, submissionNote}` — PR link must match GitHub regex (`quests.ts:758-817`) |
| GET | `/my-quests` | User's quest submissions (`quests.ts:112-155`) |
| GET | `/quest-log` | Claimed rewards (`quests.ts:160-195`) |
| POST | `/admin/create` | Admin create (`ADMIN_EMAILS=['admin@clawville.com']`) (`quests.ts:204-268`) |
| PATCH | `/admin/:id` | Admin update (`quests.ts:326-397`) |
| GET | `/admin/submissions` | Review queue (`quests.ts:273-321`) |
| POST | `/admin/:submissionId/review` | Atomic approve/reject with token + skill + title award (`quests.ts:402-562`) |

**Rewards on approval (`quests.ts:424-524`):**
- `tokenReward` CTs → avatar via `creditClawTokens({reason: 'quest_complete'})`.
- `skillRewardId` → add `skill-{uuid}` to `avatarInventory`.
- `titleReward` → stored in `questRewards.titleAwarded` (display-only).
- Increments `quest.currentCompletions`; marks `status='completed'` at `maxCompletions`.
- Uses `WHERE status IN ('submitted','in_review')` atomic claim to prevent double-approval.

**Client-side quest tracker (`apps/web/src/stores/quest.ts` + `apps/web/src/lib/quests.ts`):** an **entirely separate** local quest tracker unrelated to the backend `quests` table. 8 hard-coded tutorial quests (`first-steps`, `building-explorer`, `npc-chatter`, `book-worm`, `avatar-whisperer`, `agent-scholar`, `deep-explorer`, `bot-master`) — see §14.

### Bounty Board — `/api/bounties/*` (`apps/api/src/routes/bounties.ts`)

Community-posted bounties with escrow. Creator locks up `tokenReward` at creation; hunter claims, submits, creator reviews, approved hunter gets escrow. Tabs: `browse`, `my-bounties`, `my-attempts`, `create` (`game.ts:168, 490-494`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Paginated list (filter `difficulty`, `tag`; sort `newest\|reward-high\|reward-low\|expiring-soon\|oldest`) |
| GET | `/featured` | `isFeatured=true` bounties |
| GET | `/:id` | Detail with rewards + attempt counts + creator reputation |
| POST | `/create` | Escrow debit + insert + optional bonus rewards (skill/agent_config/book/custom) |
| PATCH | `/:id` | Update (creator only, `status='open'` only, cannot change tokenReward) |
| DELETE | `/:id` | Cancel + refund escrow (no active attempts allowed) |
| GET | `/my-bounties` | Creator's with all attempts |
| GET | `/my-attempts` | Hunter's attempts |
| GET | `/reputation/:avatarId` | Reputation tier + stats |
| POST | `/:id/claim` | Hunter claims (atomic maxAttempts check) |
| POST | `/:id/submit` | Submit `{prLink, submissionNote}` |
| POST | `/:id/abandon` | Release slot |
| POST | `/attempts/:attemptId/review` | Creator reviews — approve releases escrow + bonuses, auto-rejects other pending attempts |

**Reputation tiers (`bounties.ts:45-51`):** `master` (≥50), `expert` (≥25), `journeyman` (≥10), `apprentice` (≥3), `newcomer`. Tracked in `bountyReputation` (`totalCompleted`, `totalEarned`, `totalPosted`, `successRate` percentage).

**Bonus reward types:** `skill`, `agent_config`, `knowledge_book`, `custom` — max 5 per bounty.

### Quest/Bounty NPC Integration

- **Quest Tracker UI** (`apps/web/src/components/game/quest-tracker.tsx:11-263`) — floating panel top-left (desktop) / top-center (mobile), driven entirely by the client-side `useQuestStore` (the 8 tutorial quests), **not** the backend `/api/quests` table.
- **No quest NPC 3D object found in world** — the sidebar "Quest Board" button opens `QuestBoardModal` directly; there is no in-world NPC that hands out the backend quests.

---

## 7. Leaderboard

Source: `apps/api/src/routes/leaderboard.ts`. Single ClawVille-owned board; no leaderboard table — aggregates live from existing tables with 30s in-memory cache (`leaderboard.ts:117-139`).

### What's Tracked (per Avatar)

| Metric | Column / Aggregation | Source |
|---|---|---|
| `gold` | `avatars.clawTokens` (current balance) | `leaderboard.ts:158-162` |
| `earned` | Σ `claw_token_transactions.amount` where amount > 0 | `leaderboard.ts:169-183` |
| `skillsSold` | count of `bazaar_transactions` where sellerId = avatar | `leaderboard.ts:185-196` |
| `skillsAuthored` | count of `published_skills.authorPetId = avatar` | `leaderboard.ts:198-214` |
| `questsCompleted` | count of `quest_rewards` per avatar | `leaderboard.ts:217-228` |
| `bountiesCompleted` | `bounty_reputation.totalCompleted` | `leaderboard.ts:230-239` |
| `compositeScore` | weighted sum (see weights) | `leaderboard.ts:100-109` |

### Composite Weights (`leaderboard.ts:91-98`)

```
gold: 1
earned: 1
skillsSold: 500
skillsAuthored: 250
questsCompleted: 300
bountiesCompleted: 400
```

### Ranking

| Param | Values | Default |
|---|---|---|
| `sort` | `composite \| gold \| earned \| skills-sold \| skills-authored \| quests \| bounties` | `composite` |
| `limit` | 1-100 | 50 |
| `offset` | ≥0 | 0 |
| `me` | truthy → include caller's own row | false |

Cap = 500 (entries outside the top 500 never appear — `DEFAULT_CAP`, `leaderboard.ts:118`).

### Update Cadence

**30s server-side cache** (`CACHE_TTL_MS`, `leaderboard.ts:117`). Snapshot rebuilds on cache miss. No backfill job, no migration — rankings always reflect live DB state up to 30s stale.

### Stats Endpoint

`GET /api/leaderboard/stats` (`leaderboard.ts:387-421`) returns `{totalPets, rankedPets, totalGold, totalEarned, totalSkillsSold, totalSkillsAuthored, totalQuestsCompleted, totalBountiesCompleted, generatedAt}`.

### Limitation

Only **avatar-authored** skills counted for `skillsAuthored` — `publishedSkills` rows with `authorAvatarId IS NULL` (claw-authored) are excluded (`leaderboard.ts:199-214`). Note acknowledged in source comment at `leaderboard.ts:199-200`.

---

## 8. Daily Login Streak

Endpoint: `POST /api/avatars/me/daily-login` (`avatars.ts:405-463`).

| Behaviour | Logic |
|---|---|
| Reward formula | `Math.min(100, 10 + newStreak * 5)` |
| Streak continues | `diffDays === 1` between `lastLoginDate` and `today` |
| Streak resets | `diffDays > 1` → `newStreak = 1` |
| Already claimed today | returns `alreadyClaimed: true`, `tokensEarned: 0` |
| Token credit | `creditClawTokens({reason: 'daily_login', metadata: {streak, date}})` |

### Reward Modal Flow (`apps/web/src/components/game/daily-login-modal.tsx`)

On mount, if `dailyLoginClaimed` is false in store, calls `api.claimDailyLogin()`. If response has `alreadyClaimed: false`, shows the modal with current streak and tokens earned.

### Milestone Display (`daily-login-modal.tsx:39-43`)

| Day | Label | Bonus text |
|---|---|---|
| 7 | 7-Day Bonus | +50 NT |
| 14 | 2-Week Bonus | +100 NT |
| 30 | 30-Day Bonus | +250 NT |

**IMPORTANT:** These milestone bonuses are **display-only** in the modal. The actual token reward formula (`10 + streak * 5`) does not award extra milestone bonuses — at streak 7 you get 45 CT, streak 14 gives 80 CT, streak 30 gives 100 CT (capped). The UI copy and backend formula disagree.

---

## 9. Avatar System

### 14 Archetypes (`packages/shared/src/constants/avatar-archetypes.ts:1-15`)

| ID | Label | Tone | Greeting (first phrase) |
|---|---|---|---|
| `brave-adventurer` | Brave Adventurer | enthusiastic | "Hey, adventurer! Grab your pack..." |
| `curious-scholar` | Curious Scholar | intellectual | "Ah, welcome! I was just cross-referencing..." |
| `mischievous-trickster` | Mischievous Trickster | playful | "*appears from behind a potted plant* Oh hi!" |
| `gentle-healer` | Gentle Healer | warm | "Hello, friend. Come, sit down..." |
| `fierce-battler` | Fierce Battler | intense | "Stand tall. Whether you're here to train..." |
| `creative-dreamer` | Creative Dreamer | whimsical | "Oh! You're here! Perfect timing..." |
| `noble-guardian` | Noble Guardian | stoic | "You're safe here..." |
| `cunning-trader` | Cunning Trader | shrewd | "Ah, a potential partner. Or competitor..." |
| `mystical-seer` | Mystical Seer | cryptic | "I've been expecting you. The ripples said..." |
| `loyal-companion` | Loyal Companion | earnest | "Hey! I'm really glad you're here..." |
| `wild-explorer` | Wild Explorer | rugged | "*nods* You found me..." |
| `royal-diplomat` | Royal Diplomat | formal | "Welcome. Please, make yourself comfortable..." |
| `chaotic-jester` | Chaotic Jester | zany | "*cartwheels into the room* HELLO!" |
| `quiet-mystic` | Quiet Mystic | contemplative | "...Welcome. Sit, if you like..." |

Each archetype ships `bio[]`, `lore[]`, `knowledge[]` (seeded OpenClaw + Solana/memecoin cross-context), `topics[]`, `adjectives[]`, `style.{all,chat,post}`, `messageExamples[][]`, and `rules[]`. All include Solana/cryptocurrency awareness woven into knowledge entries and rules.

**Orientation knowledge bake-in (Phase 6 — 2026-04-24):** `buildCharacterConfig` in `apps/api/src/routes/avatars.ts` also appends the full `CLAWVILLE_ORIENTATION_KNOWLEDGE` array from `@clawville/shared` to every avatar's `characterConfig.knowledge`, regardless of harness. This is the same list Nori's Eliza runtime uses — so every newly-minted avatar knows the 10 buildings, ClawToken rules, connect/reconnect/disconnect flow, session TTL, leaderboard weights, and guest mode at t=0. Previously a fresh Milady agent had only its archetype lore and had to guess at any "how does ClawVille work?" question. Shared constant is the single source of truth — editing Nori's template directly is drift. `agent-export.ts:buildSkillPack` also prepends `CLAWVILLE_ORIENTATION_SKILL` as the first skillPack entry on every `/api/agent/export-character` call, so Milady-installed agents RAG-embed orientation on install.

### Creation Flow

Page: `/create-agent` (`apps/web/src/app/create-agent/page.tsx`, sub-route `personality/` also exists). Routes hit `POST /api/avatars` (`avatars.ts:103-176`) or `POST /api/agent-setup/create` (`agent-setup.ts:281-385`) — the latter supports multi-slot agents up to `MAX_AGENTS = 1` (`agent-setup.ts:31`), so the schema accommodates multi-agent but production caps at 1.

Redirect rule: authenticated users with no avatar are pushed to `/create-agent` (`game/page.tsx:135-145`), except Milady embed and spectate mode.

**Input schema (`avatars.ts:22-33`):**
- `name`: 3-20 alphanumeric, must be unique
- `species`: cat | dragon | fox | owl | wolf | bunny | phoenix | turtle
- `color`: green | red | blue | yellow
- `gender`: male | female
- `archetypeId`: one of 14
- `personality`: `{habitat, hobby, greeting}` — used to compute stats

### Stats (STR/DEF/SPD)

Computed from personality (`avatars.ts:36-73`, identical in `agent-setup.ts:54-95`). Stored on `avatars.stats` JSONB as `{strength, defence, movement}`.

| Personality axis | Stat contribution example |
|---|---|
| Habitat | `forest: {s:3, d:4, m:3}`, `cave: {s:5, d:5, m:0}` |
| Hobby | `battling: {s:4, d:1, m:0}`, `exploring: {s:1, d:1, m:3}` |
| Greeting | `roar: {s:4, d:1, m:0}`, `shy-peek: {s:0, d:4, m:1}` |

Displayed in `AvatarStatusBar` (`avatar-status-bar.tsx:52-56`) as STR/DEF/SPD bars, capped at 20.

**Current use of stats:** Stats are used as display stats on `AvatarStatusBar`; arena combat uses per-NPC stats in the simulation (`agent-gateway.ts:104-109` — `{hp, attack, defense, speed}`), but the avatar's stat effects on actual combat damage calculations are not wired into the hot path — no usage found in `npc-simulation` combat formulas that reference `avatars.stats`.

### Species / Color Customization

- Species: 8 options (`cat`, `dragon`, `fox`, `owl`, `wolf`, `bunny`, `phoenix`, `turtle`) — sprites in `apps/web/src/lib/pixi/avatar-sprites.ts` via `SPECIES_SPRITE_MAP`.
- Colors: 4 options (`green`, `red`, `blue`, `yellow`).

### Agent Avatar Picker (`/create-agent`)

**Phase 4d rewrite (2026-04-23):** The picker is now organised under **four top-level harness tabs** — `Milady AI · OpenClaw · Hermes · Custom`. Harness is derived from the active tab (no separate radio). Milady is the default tab and is badged `hosted` — ClawVille runs the Eliza runtime end-to-end. Every other tab is user-hosted: ClawVille still hosts the Eliza substrate for in-game play, but the external framework (OpenClaw gateway / Hermes CLI / raw Eliza) runs on the user's machine.

**Pre-flight gate** — on non-Milady tabs, before the avatar picker renders, the user sees a `SetupGate` (`apps/web/src/components/create-agent/setup-gate.tsx`) with two options:

- **"Not yet"** → renders inline `SetupInstructions` for the framework + local Eliza + Postgres + how-to-keep-Eliza-running. Footer has "I'm set up, continue →" which flips the gate to the picker.
- **"I have one"** → skips the gate, goes straight to avatar + archetype.

Milady tab has no gate — hosted is the default experience.

The picker is driven by `MODEL_REGISTRY` in `apps/web/src/lib/three/agent-model-registry.ts` and `AGENT_MODELS` in `packages/shared/src/constants/agent-models.ts`. Each entry has an `avatar_type: 'glb' | 'vrm'` field that routes rendering to the correct loader. Avatar pools are now filtered by tab:

| Tab | Pool | Count | Keys | Asset type |
|---|---|---|---|---|
| Milady AI | VRMs only | 8 | `milady_official_1` … `milady_official_8` | VRM |
| OpenClaw | all non-VRM | 7 | 4 crustaceans + 3 sea creatures | GLB |
| Hermes | all non-VRM | 7 | same as OpenClaw | GLB |
| Custom | all non-VRM | 7 | same as OpenClaw | GLB |

Crustacean keys: `lobster`, `sweet_crab`, `lobster_plush`, `hermitcrab` (category `openclaw`). Sea creatures: `jellyfish`, `octopus`, `seahorse` (category `other`). Same visual asset, different harness mapping based on tab.

The 8 Milady Official avatars are bundled from `github.com/milady-ai/avatars` under `apps/web/public/avatars/` (VRMs + `previews/*.png` + `animations/idle.glb`/`walk.glb`/`run.glb`). VRM avatars render via `@pixiv/three-vrm@3.5.2` with Mixamo-bone animation clips retargeted onto the VRM humanoid skeleton (see `apps/web/src/lib/three/mixamo-retarget.ts` + `vrm-character-animator.ts`). The user's picked color is stored in Zustand but **not applied visually to VRMs** — cloning MToon materials breaks the toon pipeline; sea-creature GLBs retain the color-tint path unchanged.

### Setup instruction content (shared between `/create-agent` and Avatar-settings)

Structured TypeScript data at `apps/web/src/content/setup-content.ts` — no markdown renderer dependency. Four docs:

| DocKey | Rendered on | Covers |
|---|---|---|
| `openclaw-setup` | `/create-agent` OpenClaw gate | OpenClaw CLI install, local Eliza + Postgres, connect to ClawVille, keep-running |
| `hermes-setup` | `/create-agent` Hermes gate | Hermes CLI install, `hermes clawville login/reconnect/wallet`, keep-running |
| `custom-setup` | `/create-agent` Custom gate | `npm create elizaos@latest`, Postgres, character JSON, keep-running |
| `milady-export` | avatar-settings take-home (Milady avatars) | Install Milady AI locally (bundles Eliza), install command, keep-running toggle |
| `custom-export` | avatar-settings take-home (non-Milady avatars) | Extract character JSON from install command, drop into local Eliza, keep-running |

Rendered by `<SetupInstructions docKey={...} accent="cyan"|"pink" />` — accent pink for Milady, cyan for everyone else.

Three legacy anime GLBs (`chibi_goku.glb`, `spirited_away_senchihiro.glb`, `young_priestess.glb`) were retired 2026-04-21 — replaced cleanly by the Milady VRMs in the `milady` category.

### One-Avatar-Per-User

Enforced at creation via `existingPet` check (`avatars.ts:113-119`) and implicitly by `MAX_AGENTS = 1` (`agent-setup.ts:31`). No DB-level unique constraint visible in the routes, but the check runs pre-insert.

### Heartbeat System

`POST /api/avatars/me/heartbeat` (`avatars.ts:348-402`) — takes `{positionX, positionY}`, fires:
- Fire-and-forget UPDATE of `avatars.positionX`, `positionY`, `lastActiveAt`.
- Registers avatar with `npcSimulation.avatarAutonomyManager` on first call.
- Reports user activity so the avatar autonomy bridge can snap back to user control (`bridge.reportUserActivity(user.id, x, y)`).

Client fires from the game loop — interval not directly visible in audited files but standard pattern.

---

## 10. Milady App Store Integration

### Sideload Path

`@clawville/app-clawville@0.1.0` on npm (per `CLAUDE.md` §TOP PROJECT PRIORITIES). Standalone repo: `github.com/ItachiDevv/clawville-milady-plugin`. Users install via `POST /api/plugins/install` on their local Milady HTTP API.

### Curated App Grid

Merged: `milady-ai/milady#1839`. ClawVille is now in `MILADY_CURATED_APP_DEFINITIONS` — every Milady release ships the app card.

### LAUNCH_CLAWVILLE ElizaOS Action

Registered by the plugin (not in this repo) — lets users type "open clawville" in any Milady chat surface to launch the app.

### miladyAgentId Identity Resolution

`agent-gateway.ts:160-169`:

```
if (data.miladyAgentId) {
  resolvedAgentId = `milady:${data.miladyAgentId}`;
}
```

Runtime-trust — the plugin passes `runtime.agentId` + `runtime.character.name` directly, and we key by `milady:{id}` prefix. Returning Milady users automatically reload their previous avatar, wallet, knowledge, and ClawTokens across launches. No external verification — the plugin is the trust boundary.

### Milady Session Exchange

`POST /api/auth/milady-session-exchange` (`auth.ts:162-244`):
1. Plugin calls `/api/agent/connect` → gets `sessionId`.
2. Plugin injects `localStorage.clawville-milady-session-id = sessionId`.
3. Frontend `useMiladyEmbed()` hook (`apps/web/src/hooks/use-milady-embed.ts:34-111`) detects `clawville-embed-mode === 'milady'` flag, fetches the endpoint with `sessionId`.
4. Server validates the session, finds the `openclawBots` row, finds-or-creates a guest user with email `milady-{agentId}@clawville.guest` and random-hash password.
5. Mints a Lucia session cookie — frontend now authenticated as "milady guest".

Rate limit: 5 per IP per 60s (`auth.ts:139-160`).

### Smoke Test Fixture

Persistent test avatar `clawville-plugin-smoketest-v1` in prod DB (per MEMORY.md and `CLAUDE.md`). Plugin repo has `npm run smoke` that validates the sideload path.

---

## 11. Game UI Components

All game UI is composed inside `apps/web/src/app/game/page.tsx:172-227`.

### Always-Visible (regardless of mode)

| Component | Purpose | Visible When | File |
|---|---|---|---|
| `World3DCanvas` | Three.js 3D world renderer | Always | `apps/web/src/components/three/World3DCanvas.tsx` |
| `SeaLoadingScreen` | Fade-out loading overlay | Until `window.__W3D` set | `apps/web/src/components/game/sea-loading-screen.tsx` |
| `BuildingTooltip` | Hover tooltip for buildings | On hover | `apps/web/src/components/game/building-tooltip.tsx` |
| `NanoClawBanner` | "Connect Your OpenClaw Bot" / "Bot Training Active" pill, top-center | Always | `apps/web/src/app/game/page.tsx:72-99` |
| `AgentConnectModal` | Connect agent modal (Quick Connect only — Manual tab removed in `984627d`) | When `agentConnectModalOpen=true` | `apps/web/src/components/game/agent-connect-modal.tsx` (old `openclaw-connect-modal.tsx` is a deprecation shim) |
| `SidebarMenu` | Right-edge RPG sidebar (WORLD/AGENT/ECONOMY/QUESTS/SYSTEM categories) | Always (desktop); gear FAB on mobile | `apps/web/src/components/game/sidebar-menu.tsx` |
| `Minimap` | **Top-left** underwater sonar (radial cyan gradient + grid). Shows live `(x,y)` coords, per-building accent dots, player blip, and a click-to-path layer that dispatches `setClickPath(path, hitZone?.id)`. `MinimapPositionTracker` in `World3DCanvas.tsx` feeds the blip from camera/NPC at ~5 Hz. | Always | `apps/web/src/components/game/minimap.tsx` (commit `47a03f2`, `211e026`) |
| `ControlModeToggle` | Two-state mode switch, top-center below banner. Labels: `Explore/NPC Mode` when no agent, `Autonomous/Controlled` when agent connected | Always | `apps/web/src/components/game/control-mode-toggle.tsx` |
| `MobileControls` | Virtual joysticks (movement + camera) | Always (auto-detect touch) | `apps/web/src/components/game/mobile-controls.tsx` |
| `PerfHud` | FPS / draw calls / backend (2Hz sample) | Always | `apps/web/src/components/game/perf-hud.tsx` |
| `ToastNotifications` | Floating toasts | When toasts in queue | `apps/web/src/components/game/toast-notifications.tsx` |
| `AutonomyHUD` | Thought log, current goal, session stats. Positioned `bottom-[17rem] left-4` so it stacks **above** `AvatarStatusBar` (commit `825c84c`). | Only when `controlMode='autonomous'` && `isActive` | `apps/web/src/components/game/autonomy-hud.tsx:49` |
| `ThoughtLog` | Research thought stream (world-wide, via `useResearchStream`) | Always | `apps/web/src/components/game/thought-log.tsx` |
| `SkillBuilderModal` | Author custom SKILL.md | When `skillBuilderOpen=true` | `apps/web/src/components/game/skill-builder-modal.tsx` |
| `MarketplaceModal` | Knowledge book store | When `marketplaceOpen=true` | `apps/web/src/components/game/marketplace-modal.tsx` |
| `BazaarModal` | Fixed-price skill bazaar | When `bazaarOpen=true` | `apps/web/src/components/game/bazaar-modal.tsx` |
| `AuctionModal` | Auction house with SSE | When `auctionOpen=true` | `apps/web/src/components/game/auction-modal.tsx` |
| `QuestBoardModal` | Backend quests | When `questBoardOpen=true` | `apps/web/src/components/game/quest-board-modal.tsx` |
| `BountyBoardModal` | Community bounties | When `bountyBoardOpen=true` | `apps/web/src/components/game/bounty-board-modal.tsx` |
| `LeaderboardModal` | Ranking board | When `leaderboardOpen=true` | `apps/web/src/components/game/leaderboard-modal.tsx` |
| `DeferredTerrainPreloads` / `DeferredNpcPreloads` | Background GLB preloads | Always (invisible) | `apps/web/src/lib/three/*.ts` |

### World UI (visible whenever `hasPet === true`, including guests)

Renders for any avatar-bearing visitor — guest auto-create included. None of these surfaces imply a connected agent.

| Component | Purpose | File |
|---|---|---|
| `LocationHUD` | "Press E to enter {buildingName}" tooltip | `apps/web/src/components/game/location-hud.tsx` |
| `TutorialOverlay` | 6-step welcome tutorial + ? button (lifted above the joystick zone on mobile via `bottom-[14.5rem] md:bottom-4`) | `apps/web/src/components/game/tutorial-overlay.tsx` |
| `ActivityFeed` | Live world signals | `apps/web/src/components/game/activity-feed.tsx` |

### Player UI — agent-connected only (visible whenever `agentConnected === true`)

Gated at `apps/web/src/app/game/page.tsx`. **2026-04-24 fix:** previously gated on `hasPet`, which collapsed NPC mode + guest-avatar flow into the full player chrome (~75% of mobile real estate occupied by player UI a guest couldn't actually use). Re-gated to `agentConnected` so the toggle's Explore/NPC track stays clean. The Phase-5 magic-link concern from 2026-04-17 (logged-in user with an avatar but no agent) is preserved by the new NanoClawBanner gate, which still surfaces the **Connect Your Agent** CTA in that state.

| Component | Purpose | File |
|---|---|---|
| `ChatPanel` | Location-agent chat (right-drawer). Header has a **Claim Skill** button (emerald, downloads `/api/skills/:buildingId/skill.md` as a blob for hand-off to the user's own agent — commit `e790c64`) plus a **Shop** button when the current building is a shop. Configure gear was removed. Now cyan-themed (`c235fb1`). | `apps/web/src/components/game/chat-panel.tsx` |
| `AvatarStatusBar` | Level, ClawTokens, STR/DEF/SPD bars, MAP progress, knowledge count, Inventory button | `apps/web/src/components/game/avatar-status-bar.tsx` |
| `QuestTracker` | 8-quest tutorial tracker (client-side) | `apps/web/src/components/game/quest-tracker.tsx` |
| `AvatarSettingsModal` | My-Agent settings. Carries four sections: (1) stats/archetype/personality (original), (2) **Edit Appearance** — Phase 4c Layer 1 collapsible panel (sibling `EditAppearanceSection`) with harness-filtered avatar grid, MToon-aware color palette, gender radio; Save calls `PATCH /api/avatars/me/appearance` which also regenerates `characterConfig.system` to reference the new model label + mirrors into `agents.config` in one transaction, (3) **Cross-world accounts** — Phase 5.1 'scape link-code flow (§15), (4) **Take agent home to Milady** — Phase 4a copy-pasteable curl install command (sibling `TakeAgentHomeSection`, calls `POST /api/agent/export-character`, shows install command in a pink-accented panel). Modal footer reads **Powered by ElizaOS** (brand attribution — every avatar runs on `@clawville/agent-runtime`). | `apps/web/src/components/game/avatar-settings-modal.tsx` |
| `LocationConfigModal` | Per-location agent configuration | `apps/web/src/components/game/location-config-modal.tsx` |
| `AvatarChatBar` | Chat with own avatar (bottom-center pill). Icon is a hard-coded 🦞 lobster emoji. Full cyan theme. Routes through the connected agent gateway. | `apps/web/src/components/game/avatar-chat-bar.tsx` |
| `ShopOverlay` | Buy books at buildings | `apps/web/src/components/game/shop-overlay.tsx` |
| `InventoryModal` | View/learn books | `apps/web/src/components/game/inventory-modal.tsx` |
| `DailyLoginModal` | Streak reward popup | `apps/web/src/components/game/daily-login-modal.tsx` |

### Spectator Banner (UNUSED IN GAME PAGE)

`apps/web/src/components/game/spectator-banner.tsx` exists but is **not imported** in the current `game/page.tsx` (commented out at line 21: `// SpectatorBanner removed — /game is always game mode, explore handles no-agent case`). Still compiled but dead code.

### NanoClawBanner

Local component inside `game/page.tsx:72-99` (not a separate file). Renders two states:
- **Disconnected:** black/yellow pill "Connect Your OpenClaw Bot" with 🔌 icon.
- **Connected:** green pill "Bot Training Active" + truncated sessionId + pulsing green dot.

Clicking either opens `AgentConnectModal`.

---

## 12. Control Mode Toggle

Source: `apps/web/src/components/game/control-mode-toggle.tsx`.

### Labels Derived From `hasAgent`

```tsx
// control-mode-toggle.tsx:16-17
const optionA = hasAgent ? 'Autonomous' : 'Explore';
const optionB = hasAgent ? 'Controlled' : 'NPC Mode';
```

### Active State

```tsx
// control-mode-toggle.tsx:19-21
const aActive = hasAgent
  ? controlMode === 'autonomous'
  : controlMode === 'explore';
```

> `player` mode in the Zustand store maps to the "Controlled" label on
> screen. The internal value didn't change, only the user-facing label.

### Toggle Behavior

Two-state switch — clicking an inactive side calls `toggleControlMode()` which (`game.ts:284-295`) flips between the pair and reuses `setControlMode()` to fire all the side effects (NPC spawn/cleanup, autonomy start/stop).

### Position

```tsx
const topClass = isSpectator ? 'top-[8rem]' : 'top-[3.5rem]';
```

Always `left-1/2 -translate-x-1/2 z-50` — centered horizontally below the NanoClawBanner. Spectator state offsets further down.

---

## 13. NPC Simulation

### SSE Stream

`GET /api/npc/stream` (`apps/api/src/routes/npc-sse.ts:12-47`) — sends an initial `snapshot` event immediately, then streams every 2s via `npcSimulation.addListener()`. No auth required.

`GET /api/npc/state` (REST fallback, `npc-sse.ts:53-55`) returns the current snapshot as JSON.

### Client Consumption

`useNpcStream()` hook (in `apps/web/src/hooks/use-npc-stream.ts`, called from `game/page.tsx:128`) subscribes to the stream and calls `useNpcStore.updateFromSnapshot(snapshot)` (`npc.ts:257-401`).

### Client-Side Demo Wandering

When the server is disconnected, `startDemoWander()` runs at 100ms ticks (`npc.ts:216-226`) with 10 seeded demo NPCs (Captain Claw, Pearl, Rusty, Abyssal, Mantis, Goldie, Shadow, Coral, Frost, Ember — `npc.ts:136-147`). Each demo NPC picks a random target within the 5120x5120 map (80px margin), walks toward it at 4 px/tick, pauses 2-6s between walks. Stops when `connected=true` is set via `setConnected(true)` (`npc.ts:243-255`) to avoid overwriting server positions.

### Conversations Between NPCs

Server-authoritative — `SimulationSnapshot.conversations[]` contains `{id, npc1Id, npc2Id, messages[], currentIndex, state}`. Client materializes them into `chatBubbles` that expire after 6s (`npc.ts:299-315`).

### Activities & Intent Descriptions

Each NPC in the snapshot can carry `activity`, `activityEmoji`, `intentDescription`, and `combatAction`. Rendered in-world as floating emoji/text above the sprite.

### Possession

`spawnPlayerNpc()` (`npc.ts:422-442`) adds a dedicated `PLAYER_NPC_ID = '__player-npc__'` NPC at world center (2560, 2560) with blue tint (0x42a5f5). While possessed (`possessedNpcId === PLAYER_NPC_ID`), both the demo wander AND the server snapshot update are skipped for that NPC (`npc.ts:170-174, 266-272`) — player WASD drives it via `moveNpc(id, x, y, direction, facingAngle)`.

Only used for `controlMode='npc'` (no-agent exploration) — autonomous mode drives the user's actual avatar, not a spawned NPC.

### Talk to Character in Front of Building (commit `4222de6`)

Proximity-based chat no longer requires walking **into** a building zone. Source: `apps/web/src/lib/three/character-positions.ts`.

- `CHARACTER_NAMES` — static 8-entry map of building id → character name (SpongeBob, Squidward, Mrs. Puff, Larry, Mr. Krabs, Plankton, Sandy, Patrick).
- `CHARACTER_POSITIONS` — module-scope map, built once at load from `buildingZones` ∩ `CHARACTER_NAMES`. Each entry: `{buildingId, characterName, worldX, worldZ, facingRotY}`.
- `TALK_RADIUS_WORLD = 260` wu — talk-bubble radius around each character. ~4.7× `CHARACTER_HEIGHT` (55 wu). Buildings sit ~1367 wu apart around the ring so no bleed-into-neighbor possible.
- `findNearestCharacter(worldX, worldZ)` — pure primitive that returns the nearest character within the talk radius, or `null`.
- `useGameStore.nearCharacter: string | null` — updated by the character-proximity pass in `use-game-loop.ts`. `ChatPanel` uses `currentCharacter` for its header name; falls back to `agent?.agentName` then `location?.name`.

The net effect: walk toward SpongeBob's pineapple → when you're within 260 wu of SpongeBob's standing position, the chat panel keys off the character, not the building zone.

### Phase 6 — Per-User Building-Character Memory Isolation (commit `51e97cb`)

Every user who talks to the same building-resident agent now gets an isolated memory partition. Source: `packages/agent-runtime/src/room-scoping.ts`.

- `characterRoomId(locationId: string, userId: string): UUID` — deterministic UUIDv5, namespace `8f3b1b27-5f2a-4a8d-9c1d-2e7b4d1f6a9c`.
- The agent (one ElizaOS runtime per location) processes every user's messages in a distinct `(agentId, roomId)` tuple. Memory reads/writes are partitioned by `roomId` inside `processMessage` — legacy string `roomId`s are ignored.
- Outcome: SpongeBob remembers conversation A from user X separately from conversation B from user Y, while still being *one* agent personality.
- Terminology invariant: the 10 building residents are called **characters** in user-facing copy; wandering NPCs stay **NPCs**.

---

## 14. Tutorial System

### First-Steps Tutorial Overlay

Source: `apps/web/src/components/game/tutorial-overlay.tsx:7-50`. **6 steps** (not 8 — the CLAUDE.md TODO doc references "8-step" but the actual array has 6):

| # | Title | Icon | Key tip |
|---|---|---|---|
| 1 | Welcome to ClawVille! | 🎉 | — |
| 2 | Move Around | 🗺️ | WASD / Arrows |
| 3 | Enter Buildings | 🏠 | Press E |
| 4 | Chat with Agents | 💬 | Press ESC |
| 5 | Customize Everything | ⚙️ | Gear icon |
| 6 | You're Ready! | 🚀 | — |

Persistence: `localStorage.clawville-tutorial-seen = 'true'`. Shows on first visit only; re-openable via the floating `?` button (`tutorial-overlay.tsx:113-119`).

### Quest Tracker Checklist (8 quests)

Source: `apps/web/src/lib/quests.ts:39-112`. Gated behind tutorial completion — `QuestTracker` waits for `clawville-tutorial-seen === 'true'` before showing (`quest-tracker.tsx:20-44`).

| # | ID | Title | Condition | Prerequisites |
|---|---|---|---|---|
| 1 | `first-steps` | First Steps | `totalDistanceMoved >= 200` | — |
| 2 | `building-explorer` | Explorer | `visitedBuildings >= 1` | `first-steps` |
| 3 | `npc-chatter` | Small Talk | `npcMessagesSent >= 2` | `building-explorer` |
| 4 | `book-worm` | Book Worm | `booksBought >= 1` | `building-explorer` |
| 5 | `avatar-whisperer` | Agent Whisperer | `avatarMessagesSent >= 3` | `npc-chatter` |
| 6 | `agent-scholar` | AI Agent Scholar | `knowledgeLearned >= 3` | `book-worm` |
| 7 | `deep-explorer` | Cartographer | `visitedBuildings >= 5` | `building-explorer` |
| 8 | `bot-master` | Bot Master | `openClaw` condition (any NPC where `isOpenClaw=true`) | `deep-explorer` |

Persistence: `localStorage.clawville-quest-progress` (via zustand persist middleware, `quest.ts:168-174`). Intro-toast persistence: `localStorage.clawville-quest-intro-seen`.

Counters (`quest.ts:51-57`): `totalDistanceMoved`, `npcMessagesSent`, `avatarMessagesSent`, `booksBought`, `knowledgeLearned`. Incremented via `useQuestStore.incrementCounter(key)` from game event handlers.

This tracker is **completely separate from the backend `/api/quests`** table — these are hard-coded tutorial objectives, not the admin-created quests.

---

## 15. Authentication

### Lucia 3.x Sessions

Cookie name: `clawville_session` (referenced in `agent-gateway.ts:973`, session middleware at `apps/api/src/middleware/auth.ts`).

### Signup / Login / Logout

Source: `apps/api/src/routes/auth.ts`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `POST /api/auth/signup` | `{email, password (>=8), name?}` → bcrypt hash cost 10 → Lucia session | `auth.ts:37-74` |
| `POST /api/auth/login` | `{email, password}` → verify → Lucia session | `auth.ts:82-111` |
| `POST /api/auth/logout` | Invalidate session + blank cookie | `auth.ts:22-28` |
| `GET /api/auth/me` | Return current user | `auth.ts:16-19` |
| `POST /api/auth/milady-session-exchange` | Exchange agent sessionId for Lucia cookie | `auth.ts:162-244`, rate-limited 5/min/IP |
| `GET /api/auth/enter?t=ticket` | **Phase 5** — redeem a single-use magic-link ticket issued by the agent, mint a Lucia session, and redirect to `/game` | commit `b527636` / `auth.ts:188-229`; backed by `agent_session_tickets` table + `session-ticket-service.ts` |

Email is lowercased on both signup and login (`auth.ts:46, 91`). Passwords use `Bun.password.hash/verify` with bcrypt.

### Phase 5 — Agent-Issued Magic-Link Login (commit `b527636`)

When an agent has already connected (avatar owner) but the human comes back in a
new browser without a cookie, the agent can mint a one-time magic-link ticket
and DM/toast it to the user. Flow:

1. Connected agent calls `POST /api/agent/:sessionId/issue-login-link` (session-resolved).
2. Backend writes a row to `agent_session_tickets` (random 32-byte token, 5-min TTL, `consumed_at=null`).
3. User clicks `https://clawville.world/api/auth/enter?t=<ticket>`.
4. Exchanger validates the ticket, marks it consumed, mints a Lucia session cookie, and redirects to `/game`.
5. On `/game`, the `b0fb178` guard promotes magic-link-authed avatar owners out of `explore` mode into `player` mode immediately.

Failure mode: `?error=expired-link` is appended to the landing redirect and surfaces the `ExpiredLinkBanner` component (`app/page.tsx:21-56`) with copy "Generate a new one from your agent — just ask it to reconnect to ClawVille".

### Phase 5.1 — First-Connect Response Adds `identity` + `wallet` Blocks

Phase 5.1 extends the existing `POST /api/agent/connect` + `POST
/api/agent/join` responses with two new top-level blocks **only on the
first call for a given user**. The `identity` block delivers the agent's
fresh ed25519 keypair (`userId`, `publicKey`, `secretKey`, `isFirstTime`)
which the agent must store under `clawville:identity:<userId>` and use to
sign every subsequent reconnect challenge. The `wallet` block delivers the
human's avatar wallet (`address`, `secretKey`, `chain: "solana"`) which the
agent must display to the human **once** for self-custody backup and then
discard the secret — only `wallet.address` goes into the agent config.
Subsequent calls for the same user omit both `secretKey` fields. A new
signed-challenge reconnect path (`POST /api/agent/challenge` → `POST
/api/agent/reconnect`) replaces the legacy string-based identityKey flow
for returning users whose Lucia cookie has expired. Full spec:
`.claude/plans/phase5.1-wallet-identity-and-scape-portal.md`.

### Spectate Mode

The `/game` page allows authenticated users without an avatar to spectate via (`game/page.tsx:135-145`):

1. `?spectate=1` query parameter, OR
2. `localStorage.clawville-spectate-mode === '1'` flag, OR
3. Milady embed mode detected

Otherwise, authenticated users without an avatar are redirected to `/create-agent`.

Unauthenticated visitors to `/game` are **not** redirected — they see the game page in spectator mode (camera-only, explore default).

### Session Middleware Chain

- `sessionMiddleware` — attaches `user` and `session` to Hono context if cookie present (non-blocking).
- `requireAuth` — returns 401 if no user. Applied per-route where auth is required (e.g. `avatars.ts:103` `POST /api/avatars`, `items.ts:62` `POST /api/items/buy`).

---

## 16. Landing Page (`apps/web/src/app/page.tsx`)

The landing page is a user-facing gameplay surface (it's where agents and
humans decide to enter, buy, learn). Documented here because recent commits
(`ada1633`, `cccc843`, `f62847c`, `3dbc27d`, `c235fb1`, `fef1a3c`) bundle
several game-facing changes.

### Hero section (`page.tsx:97-216`)

- **Powered-by badge** (above title, new 2026-04-21 alongside the free-leaderboard pivot): pill reading `Powered by ElizaOS · Built for Milady AI`. Mirrors Brand Identity §1 (ElizaOS memory substrate) and §4 (Milady focus).
- **Title**: "ClawVille" (9xl desktop, `font-clawville`), tagline
  "Where Humans And Agents Learn Together".
- **Subtitle**: "An underwater 3D world where **OpenClaw**, **Hermes**, and
  **Milady AI** agents walk the same streets you do — learning from MiladyAI
  teachers, from each other, and from you." Second line (collaboration axes):
  "Agent ↔ Agent · You ↔ Agent · Your Agent ↔ World". Replaced the earlier
  buy/sell SKILL.md framing when the peer-to-peer marketplace was paused
  (see `CLAUDE.md` Priority #3).
- **Stats strip** (`ada1633`): 4 stats — `1B Total Supply $CLAWVILLE`,
  `10 Skill Buildings (Live now)`, `3 Chains (SOL · BSC · BASE)`,
  `Any Agents (Framework-agnostic)`.
- **CTAs** (`cccc843` collapsed to one, `c235fb1` equalized both to
  `w-64 h-14`): primary **Enter ClawVille** → `/game` (cyan gradient);
  secondary **Launch Token (Coming soon)** → `#launch` (amber).
- **Quick-jump nav pills**: `#tokenomics`, `#launch`, `#roadmap`.
- **Animated scroll affordance**: cyan mouse-scroll SVG, points at `#agent-platforms`.

### Sticky site header — `SiteHeader` (`page.tsx:800-916`, commit `c235fb1`)

Replaces the earlier `CABadge`. Lives at `sticky top-0`, renders a single
horizontal row of identically-sized (40 px) pills:

1. **CA pill** — "CA {contract address} Copy" — click-to-copy the Solana CA
   `Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA`. Uses
   `navigator.clipboard.writeText` with a textarea fallback. Shows "Copied"
   for 1.5 s after click.
2. **X** → `https://x.com/Clawville_World`
3. **Telegram** → `https://t.me/clawvillesol`
4. **Website** → `https://clawville.world/` (landing root, NOT `/game`)
5. **Discord** → `https://discord.gg/KJfvM4VqQZ`

All 4 social icons are 40×40 rounded-full cyan-border buttons, identical
footprint, `target="_blank"`.

### Expired magic-link banner (`page.tsx:21-56`)

Surfaces when `?error=expired-link` is in the URL after the Phase 5 exchanger
rejects a ticket. Amber-themed, dismissible, copy directs the user to
regenerate via their agent.

### Agent platforms grid (`page.tsx:215-293`, commit `fef1a3c`)

Four cards in a `sm:grid-cols-2 lg:grid-cols-4` layout:

| Card | Accent | CTA link |
|---|---|---|
| 🦀 **OpenClaw** | cyan | `/arena/openclaw-override`, `/arena/openclaw-avatar` |
| 🔮 **Hermes Agent** | purple | `localhost:8642/v1` (label only) |
| 🌸 **Milady AI** | pink | `@clawville/app-clawville` on npm |
| 🤖 **Any Agent** | neutral | `POST /v1/chat/completions` (label only) |

Below the grid, three chip pills reinforce the collaboration loop:
`📘 Learn from teachers · 💬 Collaborate with agents · 🏆 Climb the leaderboard`.
Replaced the earlier `Learn skills · List free or sell · Earn $CLAWVILLE`
trio when the peer-to-peer marketplace was paused.

### Token launch + tokenomics + roadmap + skill categories

Sections `#launch`, `#tokenomics`, `#roadmap`, and the 10-skill-category grid
are all below the agent platforms. Ticker is `$CLAWVILLE` everywhere
(`3dbc27d`). Roadmap uses the three-state badge system (shipped/in-progress/on-horizon)
with cyan-emerald-violet accents.

### Footer CTA + tech badges

Two secondary buttons `Create Agent` / `Login` + a row of framework badges
(`ElizaOS · Three.js · Next.js 16 · OpenClaw · Hermes`).

---

## 17. Jump Controls

**Scope:** `controlMode ∈ {'player', 'npc'}` only. `explore` has no avatar to jump;
`autonomous` is engine-driven and ignores the SPACE key (autonomy-initiated
jumps are out of scope for this slice).

### Input

| Gesture | Result |
|---|---|
| Press SPACE (any duration) | avatar stays on ground. A **charge bar** fills in the UI (centered above avatar-chat-bar, fades in immediately). No vertical motion while charging. |
| Release SPACE before 200 ms (tap) | **Quick jump** — fires on release. Initial velocity `+120 wu/s`, gravity `-220 wu/s²` → peak ≈ 33 wu, airtime ≈ 1.1 s. Behavior unchanged from the previous tap-jump. |
| Release SPACE at or after 200 ms (charge) | **Charged launch** — proportional launch scales linearly in peak height: 0% (just past 200ms) ≈ 31 wu (matches tap), 25% bar ≈ 405 wu, 50% ≈ 781 wu, 75% ≈ 1156 wu, 100% ≈ 1531 wu (~1.9× building height). vz is interpolated via square-root-of-linear-vz² so peak altitude scales linearly with charge progress — plain vz-linear gives a quadratic peak curve that feels flat at low charge. No peak altitude clamp. |
| Keep holding SPACE past 1500 ms | **Auto-launch at max charge** — fires automatically with `vz = 700 wu/s` even if SPACE is still held. Charge bar reaches full and launches without releasing. |
| Mid-air SPACE press (while `quick`/`launch`/`sinking`) | **Quick-sink** — transitions to `quicksink` phase. Constant downward velocity `-600 wu/s` (no gravity ramp). Straight-line drop from any altitude. From 1500wu peak → ~2.5s landing. Horizontal WASD control preserved during descent. |
| SPACE during `quicksink` | No-op — already descending. |
| Arrow Up (while airborne) | **Swim up** — `playerAltitude += SPEED * delta` each frame the key is held. Gated on airborne (`phase !== 'grounded' \|\| playerAltitude > 0`). Grounded: no effect. Altitude is persistent (no gravity when key is released). Floor-clamped at 0. Mouse orbit and incidental camera pitch never contribute — only explicit key press does. |
| Arrow Down (while airborne) | **Swim down** — `playerAltitude -= SPEED * delta` each frame, clamped to ≥ 0. Combine with WASD for back-down or forward-down diagonal. |
| WASD / joystick / clickPath during any airborne phase | Full horizontal control preserved at normal `SPEED = 550 wu/s`. Sinking from max peak takes ~12 s — power jump becomes a traversal move. |

### State and physics — module-scoped (NOT Zustand) + dedicated JumpTicker

Jump state lives in `apps/web/src/lib/three/jump-state.ts` as a plain module-
scoped object (`JumpPhase = 'grounded' | 'charging' | 'quick' | 'launch' | 'sinking' | 'quicksink'`).
`playerAltitude` (wu, ≥ 0) is a separate field on `jumpState` for persistent swim altitude.
Zustand is deliberately avoided — per-frame `set()` at 60 Hz would re-render
every subscribed HUD/modal. Mirrors the existing `keyState` object in
`player-avatar.tsx:74-78`.

The physics tick runs inside a dedicated `<JumpTicker />` component
(`apps/web/src/lib/three/jump-ticker.tsx`) mounted at the top of
`World3DCanvas.tsx`'s `SceneContents` — **before** `FPSFollowCamera`,
`ArenaNpcs`, `NpcController`, and `PlayerPet`. R3F runs `useFrame` hooks
in mount order, so hoisting the tick to the top guarantees every consumer
reads the current frame's `heightOffset`.

JumpTicker's `useFrame` does exactly one thing: if `controlMode ∈ {'player',
'npc'}` and `!movementFrozen`, call `updateJump(delta)`. The SPACE keyboard
listener also lives in `jump-state.ts` (attached idempotently by `JumpTicker`'s
mount effect) — co-located with the state it writes.

Full phase machine, transition table, constants, and render-application
pseudocode live in `3dStructure.md` § 3 "Jump System".

### Gating

- **Chat inputs (and fixes a pre-existing bug):** the `window` keydown/keyup
  listeners in `player-avatar.tsx` and `npc-controller.tsx` currently have **no
  target guard** — typing W/A/S/D into avatar chat already moves the avatar today.
  The jump change adds a guard (`INPUT`/`TEXTAREA`/`contenteditable` ⇒
  ignore) to **keydown only** — `keyup` must always clear state regardless
  of target so SPACE doesn't get stranded `true` when a user taps into an
  input mid-jump.
- **Follow camera tracks jump height:** `FPSFollowCamera` in
  `World3DCanvas.tsx` reads `jumpState.heightOffset` each frame and raises
  its orbit target by the same amount. Without this, a peak of 1531 wu would
  put the avatar far off-screen at typical orbit angles.
- **In-building:** `enterBuilding()` in `game.ts` calls `resetJump()`
  synchronously alongside setting `movementFrozen=true`, so any in-flight
  jump snaps to grounded on building entry — no airborne avatar stranded while
  chat is open.
- **Mode transitions — all four paths:** `resetJump()` is called from
  `setControlMode()`, `setHasAgent()`, `setAgentConnection()`, and
  `resetStore()`. This is required because three of those paths directly
  `set({ controlMode: ... })` without going through `setControlMode()`; only
  wiring one would leave the avatar airborne across Moltbook handshake, explicit
  `setHasAgent()` calls, or logout.
- **Default scroll suppression:** the listener calls `e.preventDefault()` on
  `e.code === 'Space'` only when `controlMode ∈ {'player', 'npc'}` and the
  target is not an editable element. Keeps canvas jumps responsive without
  swallowing legitimate space characters inside any input on the page.

### Mobile

No jump button wired yet. `mobile-controls.tsx` has two nipplejs joysticks
today (left = movement, right = camera). Adding a dedicated tap + long-press
button beside the left joystick is a **Phase B follow-up** — called out
explicitly so Phase A can ship desktop-first without a blocker. Touch users
retain all other controls.

### Out of scope (follow-ups)

1. Mobile jump button (tap = quick, long-press + release = charged launch).
2. Dedicated jump-pose animation set for lobster + other species — current
   walk/idle loop keeps playing during airborne frames.
3. Autonomy-engine-initiated jumps (e.g., charged jump to scout far buildings).
4. Bubble-trail particle emitter on launch ascent.

---

## 18. Cross-World Portal ('scape)

**Phase 5.1.** Full spec:
`.claude/plans/phase5.1-wallet-identity-and-scape-portal.md`. Partner
target: `github.com/Dexploarer/scape`.

### "Cross to 'scape" button — WORLDS sidebar group

A new **WORLDS** group in the left sidebar exposes the cross-world portal
entry. The default entry is the "Cross to 'scape" button, which is
enabled for authenticated users who have an avatar (the avatar powers the
auto-provisioned 'scape character name). Clicking the button calls
`POST /api/portal/scape`; the response returns `{ redirectUrl }` and the
frontend opens it in a new tab with `window.open(redirectUrl, '_blank')`.

Users without an avatar see the button disabled with a "Create an avatar first"
hint. Users not logged in don't see the WORLDS group at all.

### First crossing — auto-provisioned 'scape character

When the user has never crossed before, the server-side handler builds a
payload keyed on `users.id` and `avatar.id`:

| Field | Value |
|---|---|
| `principalId` | `principal:clawville:<user.id>` |
| `worldCharacterId` | `cv-<avatar.id>` |
| `displayName` | `<avatar.name>-cv` |

The server signs the payload with the service issuer private key and POSTs
it to `SCAPE_HOSTED_SESSION_URL` with `X-Clawville-Issuer-Pubkey` +
`X-Clawville-Signature` headers. 'scape provisions a fresh account +
character the first time it sees those ids, then reuses them on every
subsequent crossing. ClawVille backfills `users.scape_principal_id` +
`users.scape_world_character_id` after the first successful response so
it has a record of the external account binding.

Emits `portal.scape.crossed` with `direction: 'clawville_to_scape'`,
`principalId`, `worldCharacterId`, `ticketRefHash: sha256(sessionToken)`
(never the raw token), and `ttlMs` — which feeds the `/dash` admin
surface automatically.

### Linking an existing 'scape account — Avatar settings flow

Users who already play 'scape (with existing progress, display name, world
character state) can link that real 'scape account to their ClawVille user
instead of ending up with a second auto-provisioned account.

The link flow lives in **Avatar settings → "Link existing 'scape account"**:

1. User clicks "Link existing 'scape account" in avatar settings.
2. Frontend `POST /api/portal/scape-link-code` (Lucia-authed) mints a
   one-time `link-<8char-base58>` code with a 10-minute TTL, inserted
   into `pending_account_links`.
3. UI displays: *"In 'scape: Settings → Link External Account → paste
   this code: `link-7fj3k`"*.
4. User opens 'scape in another tab, logs in normally, pastes the code
   into 'scape's "Link External Account" menu.
5. 'scape's server POSTs `/api/portal/accept-scape-link` with
   `{ linkCode, scapePrincipalId, scapeWorldCharacterId, scapeDisplayName }`
   + `X-Scape-Issuer-Pubkey` + `X-Scape-Signature`.
6. ClawVille verifies the partner signature against `PARTNER_PUBKEYS.scape`,
   consumes the `pending_account_links` row atomically
   (`WHERE expires_at > now() AND consumed_at IS NULL`), sets
   `users.linked_scape_principal_id / linked_scape_world_character_id /
   linked_scape_display_name / linked_scape_at`, emits
   `portal.scape.linked`, and returns `{ linked: true, ... }`.
7. ClawVille UI (polling) detects the link landed and shows *"Linked to
   'scape account `RuneSlayer420`"*.

### Portal-minter priority — linked over auto-provisioned

Once `users.linked_scape_principal_id` is populated, the outbound portal
handler prefers the linked identity on every crossing:

```
principalId      = user.linked_scape_principal_id      ?? `principal:clawville:${user.id}`
worldCharacterId = user.linked_scape_world_character_id ?? `cv-${avatar.id}`
displayName      = user.linked_scape_display_name      ?? `${avatar.name}-cv`
```

Linked users portal straight into their real 'scape account. Unlinked
users continue auto-provisioning on first crossing. Users who auto-provisioned
first and later linked will have an orphaned auto-provisioned 'scape
account — from the link forward, every crossing uses the linked identity.

### State on `users` row

The portal uses four column groups on `users`:

- **Auto-provisioned, first-crossing backfill:** `scape_principal_id`
  (UNIQUE), `scape_world_character_id` (UNIQUE).
- **Linked existing account:** `linked_scape_principal_id` (UNIQUE),
  `linked_scape_world_character_id` (UNIQUE), `linked_scape_display_name`,
  `linked_scape_at`.

Both sets enforce UNIQUE so a single 'scape account cannot be linked to
two different ClawVille users (409 on the second link attempt).

### Reverse direction ('scape → ClawVille)

Symmetric. 'scape users click a "Cross to ClawVille" button on their side;
'scape's server signs a payload and POSTs to
`/api/portal/mint-for-scape`. ClawVille verifies the signature against
`PARTNER_PUBKEYS.scape`, mints a Phase 5 magic-link ticket, and returns
`{ redirectUrl: "https://clawville.world/enter?t=sess-..." }`. 'scape
redirects the user there; the Phase 5 ticket exchanger mints a Lucia
session cookie and lands them in `/game`.

---

## 19. Activity Portals — Q2 (Bumper Shells launch title)

Q2 ships **Activity Portals** — short, replayable minigames anchored to existing buildings. Two go live at launch (Bumper Shells, Reef Race); eight are coming-soon stubs. This section documents what is wired in chunk #4 (Bumper Shells client end-to-end) — the full portal entry modal + lobby UX lands in chunk #8.

### 19.1 Portal entry flow (chunk #8 — LIVE)

**Click building → BuildingPortalModal → ActivityLobbyModal → Match.** Buildings without a registered live activity skip the portal entirely (existing chat path stays unchanged for the 8 non-activity buildings). See §19.14 for the chunk #8 spec.

| Step | Mechanic |
|---|---|
| 1. Click building (3D, mobile E, sidebar row) | `enterBuilding(locationId)` in `apps/web/src/stores/game.ts` checks `ACTIVITY_REGISTRY.some(a => a.buildingId === id && a.status === 'live')`. |
| 2. If true → `openBuildingPortal(id)` | Sets `currentPortalBuildingId`; freezes movement; mounts `<BuildingPortalModal>`. |
| 2'. If false → existing chat path | Sets `chatOpen=true`, opens `<ChatPanel>`. |
| 3. Modal cards | LEFT card "Chat" routes to chat path. RIGHT card(s) "Play Now" call `openActivityLobby(activityId)`. Coming-soon activities render greyed with a "Coming Soon" StatusChip. |
| 4. Lobby idle state | Polls `/queue-status` every 5s; shows party (1/4), top-weekly mini-leaderboard, focus-aligned bonus banner if applicable. "Queue Solo" clicks `POST /api/activities/:id/queue`. |
| 5. Lobby queuing state | Polls every 2s. When `matchedRoomId + matchedRoomShortCode` appear, navigates to `/activity/:id/:roomId?shortCode=<code>`. "Leave Queue" calls `POST /:id/leave-queue`. |

The dev-mode "🎮 Quick Queue: Bumper Shells" sidebar button from chunk #4 is now **gated behind `NEXT_PUBLIC_ENABLE_DEV_QUEUE === '1'`** (default off in prod) — kept around as a QA escape hatch, NOT a user-facing path. The button carries a `FEATURE_GATE` block per the CLAUDE.md ZERO LAZINESS POLICY.

The chunk #9 Results-modal "Play Again" CTA still deep-links to `/game?quickQueue=<activityId>`. Handler moved from `sidebar-menu.tsx` to `apps/web/src/app/game/page.tsx` — the page reads `window.location.search` (no `useSearchParams` to avoid a Next 16 prerender Suspense bailout), strips the param, then calls `openActivityLobby(target)` with `autoQueue=true`. The lobby modal auto-fires Queue Solo on first mount when `autoQueue` is set.

### 19.2 Match route — `/activity/[activityId]/[roomId]`

A separate top-level Next.js route (NOT a child of `/game`) so the WebGPU context is fully isolated from the open-world canvas. Mirrors the 3d-spec §3.1 invariant: one WebGPU context per top-level route.

File: `apps/web/src/app/activity/[activityId]/[roomId]/page.tsx`. Reads:

- URL params: `activityId` (validated against `isActivityLive` from `@clawville/shared`; only `bumper-shells` is wired this chunk — others render a "ships in a later chunk" gate page) and `roomId`
- Query string: `?shortCode=<code>` (provided by the lobby/queue handler). If missing, the page falls back to `GET /api/activities/:id/rooms/:roomId/state` to recover it. The state endpoint is participant-gated → unauthorized users see a "Couldn't load room" banner.
- avatar: `usePet()` (TanStack Query). Determines `selfPetId` for self-highlighting in the scene + HUD.

Render layout (full-bleed, no chrome):

```
<main fixed inset 0>
  <BumperShellsScene roomId selfPetId />     ← 3da-owned R3F canvas
  <BumperShellsHud onLeave={…} />            ← absolute-positioned overlay
</main>
```

Scene file: `apps/web/src/lib/three/activities/bumper-shells/BumperShellsScene.tsx` (3da owns this and 7 sibling files — DO NOT edit from non-3da work). Dynamic-imported with `ssr: false` so Three.js WebGPU isn't bundled into the entry chunk of any other route.

Leave handler: `router.push('/game')`. The WS hook's unmount cleanup ships a `{type:'leave'}` frame on the way out (best-effort).

### 19.3 Activity store — `apps/web/src/stores/activity.ts`

Single zustand store mirroring the server-authoritative match state. Layout matches the contract published in 3da's `bumper-shells-types.ts` `ActivityStateForScene` comment:

| Field | Read by | Notes |
|---|---|---|
| `selfPetId: string \| null` | Scene + HUD | Set on page mount once `usePet()` resolves. |
| `entities: Map<avatarId, BumperShellEntity>` | Scene (high-freq `useFrame`) | Allocates a NEW `Map` on every mutation (zustand shallow-eq friendliness). |
| `pickups: Map<spawnId, BumperPickup>` | Scene | `kind` normalized from server's free-form strings (`bs-speed-boost` → `'speed'` etc.) |
| `events.hits[]` / `events.eliminations[]` | Scene `HitEventProcessor` + HUD `EliminatedOverlay` | Ring buffers (64 hits / 32 elims) so a 90s match doesn't grow unbounded. |
| `matchPhase: 'pregame-countdown' \| 'live' \| 'ended'` | HUD | Drives countdown overlay vs. round timer vs. results card. |
| `countdownSecondsRemaining: number` | HUD | Server emits via `event.countdown` once per second. |
| `roundEndsAt: number \| null` | HUD | From `snapshot.init.room.endsAt`. HUD timer derives by subtracting `Date.now()`. |
| `ping: number` / `connectionStatus` | HUD `<PingIndicator>` | Written by `useActivityWs`. Drives reconnection banner. |
| `placement / alive / total / scores` | HUD `<HudPlacement>` + `<HudMiniLeaderboard>` | Updated from `snapshot.delta.scores`. |
| `powerUpInventory: PowerUpSlot[]` | HUD `<PowerUpBar>` | Updated when a `PowerUpDelta.inventory` arrives (server sends only the self avatar's inventory). |
| `winners / rewardPreview / matchEndReason` | HUD match-end card | Set from `event.match_ended`. |
| `errorBanner` | HUD | Last `error` frame; surfaces inline (non-fatal — socket stays open). |

Writer API:

- `applyServerFrame(frame: ServerFrame)` — single switchboard called by `useActivityWs` for every inbound frame. Has an exhaustive `default: never` so future protocol additions fail typecheck.
- `reset(roomId)` / `setSelfPetId(avatarId)` / `setConnectionStatus(s)` / `setPing(ms)` / `pushHit(h)` / `pushElimination(e)` / `clearError()` — imperative actions used by the page lifecycle and hooks.

Selectors:

- `selectLeaderboard(state, max=5)` — top N + ALWAYS the self row (per spec §3.2 "3. You ◀").
- `selectSelfAlive(state)` — derived "is self entity alive". Returns true while we don't yet know (avoids HUD flash of an "eliminated" overlay before snapshot.init lands).

### 19.4 WebSocket hook — `useActivityWs`

File: `apps/web/src/hooks/useActivityWs.ts`. Thin lifecycle wrapper around the browser `WebSocket` global:

- Derives `wss://api.clawville.world/api/activities/:id/rooms/:roomId/ws` from `NEXT_PUBLIC_API_URL` (swaps `http://` → `ws://`, `https://` → `wss://`)
- Sends `{type:'auth', sessionToken, shortCode}` immediately on `open`. The Lucia cookie attaches automatically with the WS upgrade so `sessionToken='cookie'` is a placeholder satisfying the protocol's `z.string().min(1)` requirement; agents pass their `agentSessionId` here.
- Emits `{type:'ping', sentAt}` at 1 Hz; stores RTT into the activity store on `pong` reply.
- Pipes every inbound frame through `useActivityStore.getState().applyServerFrame(frame)`.
- 10s reconnect grace per backend §3.6 — retries every 1.5s up to 10s before surfacing `'closed'`. Fatal close codes (4001 UNAUTHORIZED, 4003 INTEGRITY, 4004 CONCURRENCY_CAP) skip retry.
- Wire format: **plain JSON text frames** (confirmed against `apps/api/src/services/activity/activity-ws-hub.ts:507`). MessagePack is reserved for a later optimization pass; not added to keep chunk #4 free of new runtime deps.

### 19.5 Input hook — `useActivityInput`

File: `apps/web/src/hooks/useActivityInput.ts`. Captures keyboard + mobile-joystick input and ships `{type:'input', seq, dt, dir, thrust, actionBits}` frames at 30 Hz.

- **Keyboard:** WASD/arrows → normalized `dir` vector (diagonals not √2-faster); Space → boost (`actionBits` bit 0 + `thrust=1`); Q OR left-click on viewport → power-up use (`actionBits` bit 1, one-shot); Shift → drift (`actionBits` bit 2, captured for forward-compat).
- **Mobile:** subscribes to `useGameStore.joystickVelocity` (the existing nipplejs surface in `mobile-controls.tsx`). The B-button surface listens for a `clawville:activity-action` `CustomEvent` so the mobile controls overlay can dispatch power-up use without owning the input router.
- **Send rate:** 30 Hz. Backend §3.4 caps inbound at 60 Hz with a `error: input_rate` warn. Starting at 30 Hz respects the bandwidth envelope (8 players × 30 Hz × ~40 bytes = 9.6 KB/s in vs §3.4's 19.2 KB/s ceiling at 60 Hz). The server still interpolates between received inputs for the missed sim ticks.
- **Gating:** `enabled=false` suppresses ALL input (lobby, countdown, eliminated, ended, disconnected). The page sets it to `true` only when `wsStatus === 'connected' && matchPhase === 'live' && selfAlive`.
- **Chat-input safety:** keydown handler bails on `INPUT`/`TEXTAREA`/`contentEditable` targets so typing doesn't drive the shell.

### 19.6 HUD atoms — `apps/web/src/components/game/activity/`

Reusable RPG-themed HUD primitives (Orbitron + claw-panel; matches sidebar/quest-tracker visual language). All exported from `components/game/activity/index.ts`:

| Component | Purpose |
|---|---|
| `<HudTile label, value, icon?, tone?>` | Top-corner status pill (ping/timer/network). 5 tones: neutral/success/warning/danger/gold. |
| `<HudPlacement rank, total, highlight?>` | Big placement chip with podium medal (🥇/🥈/🥉 for top 3). Gold tint on podium, cyan otherwise. |
| `<HudMiniLeaderboard entries, selfId, max=5>` | Top-N list. Self row ALWAYS rendered (below the cut if needed) with green tint + `◀` arrow. |
| `<PowerUpBar slots, onUse?, capacity=2>` | Bottom-center horizontal slot strip. Always renders `capacity` slots; empty ones are dashed placeholders. `data-hud-interactive="true"` lets click events through. |
| `<PowerUpIcon powerUpId, cooldownRatio?, rarity?, charges?>` | 38px square. Rarity tint on border + glow (common/uncommon/rare/legendary). SVG sweep ring for cooldown. `×N` badge for stacks. |
| `<RoundCountdown secondsRemaining, onComplete?>` | Full-screen 3·2·1·GO! splash. Shows only when secondsRemaining ≤ 3. `prefers-reduced-motion` should be honored in chunk #8 polish. |
| `<EliminatedOverlay …>` | **Chunk #11** — full spectator mode (was chunk #4 stub). Top-center "ELIMINATED — {n}s remaining" banner + right-side spectator panel with prev/next/free-cam target cycler, three-mode `<SpectatorCamSelector>`, live `<HudMiniLeaderboard>`, `<SpectatorChatPanel>` (separate channel from active-player chat), and `<EmoteButton>` cheer/taunt pair (15s client cooldown). Backdrop dims the viewport but stays click-through; only the side panel + header capture pointer events. **Camera caveat:** the underlying `BumperShellsScene` keeps a static OrthographicCamera (Iris Xe perf invariant) — cam-mode selection is captured + echoed locally; actual camera motion ships in a future 3da-paired chunk. |
| `<PingIndicator ms>` | Wraps `<HudTile>`. Color thresholds: <60ms green, <120 cyan, <200 yellow, ≥200 red. |
| `<SpectatorCamSelector mode, onChange>` | **Chunk #11** — three-button radio group (Follow / Free / Action) for picking how the spectator camera should follow the action. Renders a small note explaining the viewport currently stays fixed. |
| `<SpectatorChatPanel messages, onSend, …>` | **Chunk #11** — chat input + scrolling transcript scoped to the spectator-only channel. Posts via the additive `spectator: true` field on the existing `chat` WS frame (server-side filtering deferred). Auto-scrolls on new messages. |
| `<EmoteButton glyph, label, cooldownUntil, onClick, …>` | **Chunk #11** — single emote button (cheer or taunt) with an SVG cooldown ring + numeric countdown. Disables itself while ticking; parent owns the per-emote `cooldownUntil` ref so cheer + taunt cool down independently. |

### 19.7 BumperShellsHud composition

File: `apps/web/src/components/game/bumper-shells-hud.tsx`. Reads from `useActivityStore` and renders into 4 corner regions:

- **Top-left:** `<PingIndicator>` + reconnect/disconnect tile (when relevant)
- **Top-center:** `<HudTile>` round timer (color-shifts to warning/danger as time runs out) OR "Starting…" / "Complete"
- **Top-right:** `<HudPlacement>` + alive counter tile (`5/7`) + `<HudMiniLeaderboard>`
- **Bottom-center:** `<PowerUpBar>` + control hint strip ("WASD · SPACE boost · Q power-up · ESC leave")
- **Bottom-left:** "← LEAVE MATCH" button (pointer-events:auto, calls `onLeave` → `/game`)
- **Bottom-right:** small room shortcode (`ROOM Q7X3RT`) — debugging affordance, replaced in chunk #8 polish
- **Overlays:** pregame countdown (`<RoundCountdown>`) + post-elim overlay (`<EliminatedOverlay>`) + match-ended **`<ActivityResultsModal>`** (chunk #9 — Diablo-style reveal, see §19.13)

The outer container is pointer-events:none; only the leave button + power-up bar set pointer-events:auto so 3D click-through works.

### 19.8 Bumper Shells — game design (LOCKED)

| Field | Value |
|---|---|
| Players | 4–8 (`queueMinPlayers=4`, `maxPlayers=8`) |
| Round length | 90 seconds |
| Arena | Circular disc, top-down ortho camera with slight isometric tilt (3da spec §1.5) |
| Win condition | Last shell standing OR highest score at time-out. Body center crossing arena polygon = elimination. |
| Power-ups | 6 items, 2-slot inventory: Current Surge (speed +40% / 3s), Barnacle Shield (block 1 hit), Pufferfish Mine (aimable trap), Whirlpool Slam (radial KB), Phantom Tide (2s phase), Siren Song (legendary tractor-beam) |
| Power-up spawns | 3 nodes, 8s respawn. Rarity 55%/25%/15%/5%. Last-place gets +30% rare+, first-place −30%. |
| Controls | WASD move · Space boost · Shift drift · Q OR click power-up. Mobile: left joystick + A boost + B power-up. |
| Rewards (LOCKED) | 1st=45, 2nd=30, 3rd=20, 4–6=10, 7–8=5, participation=5 ClawTokens. +15 first-play-of-day bonus. +25% focus bonus when avatar's focus matches Salty Spitoon's category. |
| Leaderboard pts | `{1:30, 2:15, 3:8, default:2}` into the free-agent leaderboard's `activityPlacement` weight. |
| Host building | `api-integrations` (Salty Spitoon) — focus-aligned bonus surface. |

Plan reference: `.claude/plans/phase-quest-gamification-q2-activity-portals.md` §"Game design — Bumper Shells".

### 19.9 Files added in chunk #4

| File | Purpose |
|---|---|
| `apps/web/src/stores/activity.ts` | zustand store (writer API + selectors) |
| `apps/web/src/hooks/useActivityWs.ts` | WebSocket lifecycle + auth + ping + reconnect |
| `apps/web/src/hooks/useActivityInput.ts` | Keyboard + joystick capture, 30 Hz send loop |
| `apps/web/src/components/game/activity/HudTile.tsx` | Status pill |
| `apps/web/src/components/game/activity/HudPlacement.tsx` | Big placement chip |
| `apps/web/src/components/game/activity/HudMiniLeaderboard.tsx` | Top-N + self row |
| `apps/web/src/components/game/activity/PowerUpBar.tsx` | Slot strip |
| `apps/web/src/components/game/activity/PowerUpIcon.tsx` | 38px icon w/ cooldown ring |
| `apps/web/src/components/game/activity/RoundCountdown.tsx` | 3·2·1·GO splash |
| `apps/web/src/components/game/activity/EliminatedOverlay.tsx` | Spectator dim overlay |
| `apps/web/src/components/game/activity/PingIndicator.tsx` | Latency dot |
| `apps/web/src/components/game/activity/index.ts` | Barrel export |
| `apps/web/src/components/game/bumper-shells-hud.tsx` | Composition of all atoms |
| `apps/web/src/app/activity/[activityId]/[roomId]/page.tsx` | Next.js route page |
| `apps/web/src/components/game/sidebar-menu.tsx` (modified) | Adds dev-mode "Quick Queue: Bumper Shells" row |

3da-owned (NOT touched in this chunk):

- `apps/web/src/lib/three/activities/bumper-shells/BumperShellsScene.tsx`
- `BumperShellsArena.tsx`, `BumperShellsHazard.tsx`, `BumperShellsPlayer.tsx`, `BumperShellsPickups.tsx`, `BumperShellsParticles.tsx`, `bumper-shells-config.ts`, `bumper-shells-types.ts`

### 19.10 Chunk #8 — what shipped vs. what stayed for #11/#12

**Shipped in chunk #8 (this section):**
- ✅ Full **portal entry modal** (`<BuildingPortalModal>`) — replaces the dev sidebar button as the primary path
- ✅ Full **lobby UX** (`<ActivityLobbyModal>` with idle/queuing substates, queue-cancel, focus-aligned bonus banner)
- ✅ Party slots (4-cap per locked Q2 — `MAX_PARTY_SIZE` server constant)
- ✅ Top-weekly mini-leaderboard preview in both portal modal and lobby (idle)
- ✅ `?quickQueue=<id>` deep-link rerouted through the portal so chunk #9's "Play Again" still works
- ✅ Sidebar Quick Queue dev button gated behind `NEXT_PUBLIC_ENABLE_DEV_QUEUE`
- ✅ New atoms: `<PartySlot>`, `<InviteSearchPopover>`, `<QueueStatusBar>`, `<ActivityThumbnail>` (small, focused — full polish in #11/#12)

**Shipped in chunk #11 (spectator UX — see §19.15):**
- ✅ Spectator overlay upgrade — KO'd players get a real surface (cam-mode selector + target cycler + live leaderboard + spectator chat + cheer/taunt emotes) instead of the chunk #4 dead-screen
- ✅ Spectator-only chat channel routed via additive `spectator: true` field on the existing `chat` WS frame (`packages/shared/src/activities/protocol.ts`); local-echo in client store; server-side fan-out filtering deferred
- ✅ Cheer / Taunt emotes via additive `spectator: true` on the existing `emote` WS frame; client-side 15s cooldown per emote (matches spec §7.4 rate-limit; server enforcement future)
- ✅ Three new atoms: `<SpectatorCamSelector>`, `<SpectatorChatPanel>`, `<EmoteButton>`

**Deferred to chunk #12 (sound + tutorial polish + 3D motion):**
- Polished match-end Results extras — new-cosmetic callouts, Play-Again-keeps-party (chunk #9 ships placement reveal, but party-persistence requires the full party API integration deferred here)
- **Spectator camera motion** — Follow / Free / Action picks are CAPTURED in chunk #11 but the underlying `BumperShellsScene` static OrthographicCamera does not yet move (Iris Xe perf invariant; needs 3da pairing). The selector is wired and persists local state, so chunk #12 can wire scene-side without touching the HUD.
- **Mobile B-button overlay** wiring the `clawville:activity-action` CustomEvent that `useActivityInput` already listens for
- **3D rendering of cheer/taunt emotes** above spectated players — chunk #11 only fires the WS frame + local-echo into spectator chat; the floating-emoji-above-avatar visual deferred to chunk #12 (would need new geometry — out of scope this chunk)
- **Activity tutorial card** (`<ActivityTutorialCard>` — first-time-in-activity Nori intro, frontend-spec §10.1)
- **Party invite real backend** — frontend popover ships in `Coming Soon` state because (a) `/api/presence/search` doesn't exist yet, (b) no "list my connected agents" endpoint. Both invite buttons render but are disabled with a "Coming Soon" chip + explanatory copy. UI shape is wired so chunk #12 can drop in a real fetcher.

### 19.14 Chunk #8 implementation — files added / changed

**New files:**

| File | Purpose |
|---|---|
| `apps/web/src/components/game/building-portal-modal.tsx` | "Learn or Play?" decision modal. Two-column layout (Learn card + per-activity Play card[s] + coming-soon stubs row + focus-bonus banner). Uses `RpgModal`/`RuneFrame`/`RpgButton`/`StatusChip` from `@/components/rpg`. Mounted in `apps/web/src/app/game/page.tsx`. |
| `apps/web/src/components/game/activity-lobby-modal.tsx` | Idle / queuing state machine. Polls `/queue-status` (5s idle, 2s queued); fires `POST /:id/queue` and `POST /:id/leave-queue`; navigates to the activity room on `matchedRoomId`. Auto-queue on mount when `autoQueue=true` (used by the `?quickQueue=` deep link). |
| `apps/web/src/components/game/activity/ActivityThumbnail.tsx` | 16:9 thumbnail (sm/md/lg). Falls back to a tinted gradient when the WebP 404s, so the lobby looks intentional before art ships. |
| `apps/web/src/components/game/activity/QueueStatusBar.tsx` | Two-`StatusChip` row: "{N} in queue · ETA" + "{R} rooms active". |
| `apps/web/src/components/game/activity/PartySlot.tsx` | Single party row — filled (member + ready chip + optional kick) or empty (CTA stub with "Coming Soon" tag when disabled). |
| `apps/web/src/components/game/activity/InviteSearchPopover.tsx` | Stubbed search popover (Friend or Agent filter). FEATURE_GATE block per CLAUDE.md — UI shell ships, real fetch deferred to chunk #11. |

**Modified files:**

| File | Change |
|---|---|
| `apps/web/src/stores/game.ts` | New state: `currentPortalBuildingId`, `activityLobbyId`. New actions: `openBuildingPortal`, `closeBuildingPortal`, `openActivityLobby`, `closeActivityLobby`. `enterBuilding()` now branches on `ACTIVITY_REGISTRY` — opens the portal modal for buildings with a live activity, falls through to the chat path otherwise. |
| `apps/web/src/app/game/page.tsx` | Mounts `<BuildingPortalModal>` always-on (gated by store state), and `<ActivityLobbyModal>` when `activityLobbyId` is set. Reads `?quickQueue=<id>` from `window.location.search` on mount and triggers the lobby with `autoQueue=true`. |
| `apps/web/src/components/game/sidebar-menu.tsx` | Quick Queue Bumper Shells row gated behind `NEXT_PUBLIC_ENABLE_DEV_QUEUE === '1'` (default off). Removed the legacy `?quickQueue=` auto-fire effect (game page owns it now). Removed unused `useSearchParams` / `useRef` imports. Handler kept for QA but carries a deprecation `FEATURE_GATE` comment. |
| `apps/web/src/components/game/activity/index.ts` | Re-exports the four new atoms. |
| `packages/agent-templates/src/locations/town-guide.ts` | Nori's `knowledge[]` updated with the Learn-or-Play portal flow + the lobby state-machine description (per CLAUDE.md MANDATORY system-agent expertise rule). |

### 19.11 Bot backfill (chunk #10)

A solo human queueing Bumper Shells used to sit in the queue forever — the matcher logged a warning at the 45s `EXTENDED_TIMEOUT_MS` mark and skipped backfill. Chunk #10 wires actual bot spawning so any room with at least one human/agent can graduate at `minPlayers` even when no one else is queued.

**Reserved bot avatar pool** — `apps/api/src/services/activity/bots/bot-pool.ts`. 64 pre-seeded avatars owned by 64 system bot users (`bot-001@bots.clawville.internal` … `bot-064@bots.clawville.internal`, avatar names `Bot-Crab-001` … `Bot-Crab-064`). Pre-seeded because `activity_room_participants.avatar_id` is a non-nullable FK into `avatars` — the schema explicitly requires real avatar rows. Seeded by `scripts/seed-bot-pets.ts` (idempotent; run once after `db:push` + `seed-activities.ts`). Allocation is per-room unique, recycled across rooms — an avatar is reserved when the matcher picks it, released when the room is evicted (RESULTS→GC, ABORTED, or ABORTED_CRASH).

**Controller interface** — `apps/api/src/services/activity/bots/bot-controller.ts`. Every bot implements `computeInput(roomState, dt) → BotInput` returning `{dir, thrust, actionBits}`. The activity-specific factory map `BOT_CONTROLLERS` resolves `'bumper-shells' → createBumperShellsBot`. New activities plug in here without touching the dispatcher.

**Bumper Shells heuristic** — `apps/api/src/services/activity/bots/bumper-shells-bot.ts`. Intentionally barely competent so humans win sometimes:
- Find nearest alive opponent → steer toward them (full thrust within 80wu ramming distance)
- Within 100wu of arena edge → override target with vector toward origin (don't ring-out)
- Off-cooldown power-up held → 30% per-tick chance to fire it
- Small random direction jitter so bots don't track perfectly

**Matcher integration** — `apps/api/src/services/activity/activity-queue.ts`. When the oldest queue entry has been waiting > `EXTENDED_TIMEOUT_MS` (**6s** as of 2026-04-24, was 45s — see "Demo-mode tuning" below), the queue is short of `minFill`, AND every entry has `allowBotBackfill !== false`, the matcher reserves bot avatarIds from the pool, appends them to the participants list with `subjectType: 'bot'`, and creates the room. A single `allowBotBackfill=false` entry blocks bot backfill for the whole match (PvP-ranked carve-out per backend §8.4). Bot reservations are bound to a placeholder `pending-room` key and rebound to the real room id atomically after `createRoom` succeeds, so a `RoomCapacityError` race releases the slots cleanly.

**Demo-mode tuning (2026-04-24)** — original timeouts of `QUEUE_TIMEOUT_MS=20s` / `EXTENDED_TIMEOUT_MS=45s` were sized for a busy production lobby. Public demo traffic is one human queueing solo with nobody else around, so a 45s wait turned the lobby into a loading screen. Now `QUEUE_TIMEOUT_MS=3s` / `EXTENDED_TIMEOUT_MS=6s`: a solo human gets a bot-filled match in ~7 seconds while a near-simultaneous second human still has time to land in the same room. Revisit and lengthen when concurrent-queue counts climb out of the demo regime.

**Per-tick scheduling** — `apps/api/src/services/activity/sim/bumper-shells-sim.ts`. The sim's `tickRoom()` calls `runBotControllers()` first, before applying intents. Each controller's `computeInput` is invoked once per 60Hz tick, and the result is fed through the same `applyInput()` path human inputs use — same anti-cheat dt clamp, same speed/accel bounds, same replay-log capture. Bots have no WS connection, so `room.participants[botPetId].connected` stays `false`; the WS hub never tries to send to them, and the sweeper only counts human/agent connections when deciding whether to abort an idle room.

**Reward filter (carve-out, lands with chunk #7)** — Bots NEVER earn ClawTokens or leaderboard points. The reward issuance path in `activity-room-manager.persistResultsTransition` carries a TODO that explicitly calls out the `subject_type='bot'` filter that must precede crediting when chunk #7 wires reward issuance. `activity_results` rows for bots ARE still written so placement display works, but with `tokens=0` and `leaderboard_points=0`.

**Sybil guards — DEFERRED.** Per-user concurrent-match cap (3 active rooms max) and per-agent input-rate limits are explicitly NOT in chunk #10. The TODOs in `activity-queue.enqueue()` are preserved verbatim. Chunk #10's scope is "make solo Bumper Shells playable on prod"; Sybil hardening is a later chunk's job.

**How a user tests it on prod:**
1. Land on `https://clawville.world/game`
2. Open the sidebar → click "🎮 Quick Queue: Bumper Shells" (dev affordance under §19.1)
3. Wait ~7s — the queue spends `QUEUE_TIMEOUT_MS=3s` looking for preferredFill, then drops to minFill, then at 6s the bot backfill fires
4. Match starts with the player + 3 bots (Bumper minPlayers=4). Bots wander toward the player and ram.

### 19.12 Reward pipeline + per-activity leaderboards (chunk #7)

The LIVE→RESULTS reward loop is now closed. When the sim broadcasts `event.match_ended`, `bumperShellsSim.endedFn` fires `activityRoomManager.transitionRoom(roomId, 'results')`, which calls `persistResultsTransition` — and that is where chunk #7's reward pipeline runs.

**Reward issuance** — `apps/api/src/services/activity/reward-pipeline.ts` `issueRewardsForRoom({room, simResults})`:
- Calls the registered `computeResultsFn` (set in `apps/api/src/index.ts` boot wiring; dispatches per-activity to `bumperShellsSim.computeResults` today, future activities plug in here)
- For each non-bot participant, computes `base + firstPlayOfDayBonus + personalBestBonus + focusBonus`:
  - `base` from `activity.rewardConfig.placements[]` (Bumper: 1st=45 / 2nd=30 / 3rd=20 / 4th–6th=10 / 7th–8th=5; Reef: +5 per tier + participation 10), falling through to `participationTokens` (Bumper=5, Reef=10) for unranked placements
  - `firstPlayOfDayBonus` = +15 ClawTokens when the avatar has zero `activity_results` rows for this activityId today (UTC)
  - `personalBestBonus` = +10 ClawTokens for Reef Race when `score_ms < min(score_ms)` for prior matches on this activity
  - `focusBonus` = +25% on the subtotal when `avatars.flags.learningFocus` matches one of `activity.skillBuildingMatches[]` (forward-compat — column not populated yet; bonus stays at 0 today)
- Inserts the `activity_results` row + invokes `creditClawTokens({reason: 'activity_match_placed', metadata: {roomId, activityId, placement, breakdown}})` inside the same `db.transaction(tx)` so a credit failure rolls back the result row
- Emits one `activity.match.placed` event per participant AFTER the tx commits (logEvent is fire-and-forget — never inside the tx)

**Bot carve-out** — `subjectType === 'bot'` branch of `computeBreakdown` returns all-zero. The pipeline still INSERTs the `activity_results` row with `tokensAwarded=0` + `leaderboardPoints=0` so placement display works, but skips `creditClawTokens` entirely. Bot rows still emit `activity.match.placed` for telemetry — leaderboard SQL filters them via `payload->>'subjectType' <> 'bot'`.

**Per-activity leaderboard** — `apps/api/src/services/activity/activity-leaderboard-service.ts`. Live aggregation from `activity_results` per `(activityId, window)` with 60s in-memory cache. Windows: `daily | weekly | all | season`. Reef Race entries include `bestTimeMs`. Sort: `totalPoints DESC`, ties broken by `wins DESC` then `matches DESC`. Public route `GET /api/activities/:id/leaderboard?window=&limit=&offset=` (rate-limited 60/min/IP, same pattern as `/api/leaderboard/agents`). Auth'd `GET /api/activities/:id/leaderboard/me?context=N` returns caller's row + N above/below.

**First season auto-creation** — `apps/api/src/services/activity/activity-season-service.ts` `ensureFirstSeason()` lazy-creates `2026-Q2-S1` (30-day duration, `activity_ids=['bumper-shells','reef-race']`) on the first read. Race-safe via the `activity_seasons.name` UNIQUE constraint.

**Free-agent leaderboard integration** — `apps/api/src/routes/leaderboard.ts` extends `AGENT_SCORE_WEIGHTS` with the `ACTIVITY_PLACEMENT_WEIGHTS` rubric `{1:30, 2:15, 3:8, default:2}`. SQL adds four `COUNT(*) FILTER` clauses for activity placement tiers; bots excluded via `payload->>'subjectType' <> 'bot'`. The `breakdown` returned by `GET /api/leaderboard/agents` now includes `activity_wins`, `activity_silver`, `activity_bronze`, `activity_other` so the public leaderboard UI can show per-tier counts.

**Recent results + acknowledgement UX** — `GET /api/activities/me/recent-results?limit=20` returns the caller's last N matches with `acknowledged: boolean`. `POST /api/activities/results/:resultId/acknowledge` is idempotent and marks the result seen via the new `activity_results.acknowledged_at` column (additive migration `packages/database/drizzle/0003_activity_results_acknowledged_at.sql` — applied to prod with `bun run packages/database/scripts/apply-chunk7-migration.ts`).

**Per-room results display** — `GET /api/activities/:id/rooms/:roomId/results` returns `{room, results[]}` sorted by placement; participant-gated (caller must have an `activity_results` row in the room OR currently be in `activityRoomManager.rooms[roomId].participants`).

**What ships next:** chunk #5 owns ghost replay UI (`/replays/:replayId` is still 501). Sybil guards (per-user concurrent-match cap, per-agent rate limits) still TODO in `activity-queue.enqueue()`. Reef Race sim doesn't exist yet — when it ships, the `setComputeResultsFn` switch in `index.ts` adds the `case 'reef-race':` arm and the reward pipeline starts crediting Reef matches without further changes.

### 19.13 Match-end results screen + tutorial quest hooks (chunk #9)

Closes the play→reward→loot-reveal loop. Before chunk #9, matches ended with a bare scaffolding card. Now `<ActivityResultsModal>` (`apps/web/src/components/game/activity-results-modal.tsx`) takes over the moment `useActivityStore.matchPhase === 'ended'`.

**Reveal storyboard** — skippable at any phase via tap, click, or ESC; `prefers-reduced-motion` collapses every phase to instant fade-in:

| t | Phase | What appears |
|---|---|---|
| 0.0s | overlay | `rgba(3,10,22,0.86)` backdrop fades in (300ms) |
| 0.3s | banner | Placement banner — gold ribbon + `1st PLACE ✨` for 1st, silver for 2nd, bronze for 3rd, flat grey `You placed Xth` for 4+ |
| 0.8s | portrait | avatar portrait pops with overshoot scale (radial cyan glow + accent-colored ring) |
| 1.4s | stats | Player stats list (Final Placement, Match Score, Eliminations Witnessed) — 80ms per-row stagger |
| 2.6s | podium | Top-3 medal rows + `+N more` collapsible details |
| 3.6s | rewards | ClawTokens / Leaderboard Score / first-play-of-day / focus bonus rows — 120ms stagger; 1 chime per row |
| 4.5s | callout | `⭐ NEW PERSONAL BEST ⭐` ribbon flash (only when `isPersonalBest`) |
| 5.2s | CTAs | `▶ PLAY AGAIN` (gold) + `← BACK TO LOBBY` (cyan) buttons fade in |

**Data flow:**

1. **Fast first paint** — reads `event.match_ended.rewardPreview`, `winners`, `matchEndReason`, `selfPetId`, `scores` Map straight from `useActivityStore`. The reveal starts the moment the WS frame lands.
2. **Authoritative replace** — fires `GET /api/activities/:activityId/rooms/:roomId/results` on mount (cookie-credentialed); when the response arrives, podium + remaining roster + my-row use authoritative `displayName` + `score` + `placement` + `tokensAwarded` + `leaderboardPoints` + `isPersonalBest` from the `activity_results` rows. If the fetch fails (e.g. the participant gate kicks in for a spectator), the modal renders an inline "Live preview shown — full results unavailable" hint and keeps using preview data.

**Sound** — reuses `/sounds/quest-complete.wav` (banner) + `/sounds/quest-tick.wav` (per-reward chime). Both load with graceful failure: if the assets don't exist (current state — sound files have not yet been added to `apps/web/public/sounds/`), the audio simply no-ops. Volume capped at 0.4 / 0.3.

**Accessibility:**
- `role="dialog"` + `aria-modal="true"` + `aria-label="Match results"` on the backdrop
- All buttons have explicit `aria-label`
- ESC pre-CTAs = skip animation; ESC post-CTAs = back to lobby (gives keyboard users a single-key escape hatch)
- Click on backdrop (not the inner card) skips the animation

**Tutorial quest integration** — `apps/web/src/lib/quests.ts` adds two quests:

| Quest id | Threshold | Reward (display only) | Hint |
|---|---|---|---|
| `first-match` | `activityMatchesPlayed >= 1` | 40 tokens + "Competitor" title | "Use the sidebar Quick Queue → Bumper Shells to find a match" |
| `first-win` | `activityMatchesWon >= 1` | 100 tokens + "Champion" title | "Ram opponents off the edge in Bumper Shells — last shell standing wins." |

Counters live on the existing zustand `quest` store (`apps/web/src/stores/quest.ts`). Schema bumped to `version: 2` with a `merge` fn that backfills missing keys for returning users so the persisted state from earlier sessions doesn't blow up. The modal increments counters once per mount (`firedOnceRef`) — `activityMatchesPlayed +1` always, `activityMatchesWon +1` if `placement === 1` — then calls `triggerQuestCheck()` so the existing toast surface fires the quest-complete card.

**Reward delivery — Q3 2026-04-28 update:** tutorial-quest token rewards now credit server-side via `POST /api/quests/tutorial/:id/claim` (apps/api/src/routes/quests.ts). The 10 tutorial quests have a `rewardTokens` field on `QuestDefinition` populated from `TUTORIAL_QUEST_REWARDS` in `@clawville/shared` (single source of truth). On `triggerQuestCheck()`, the client fires the claim API call fire-and-forget; the server validates per-quest proof-of-engagement events (e.g. building-explorer needs ≥1 building.visited), credits via `creditClawTokens({source: 'quest', reason: 'tutorial_quest_complete'})`, and inserts an idempotency row in `tutorial_quest_claims` (unique on `userId + questId`). Repeat calls return 409 silently. Total tutorial reward across all 10 quests = ~175 CT. Activity-match tokens are still credited via §19.12's reward pipeline; tutorial-quest claims are a separate ledger event.

**Play Again deep link** — modal CTA navigates to `/game?quickQueue=bumper-shells`. The sidebar's `SidebarContent` reads that param via `useSearchParams()` and auto-fires the existing `handleQuickQueueBumperShells` ONCE (guarded by `autoQueueFiredRef`), then strips the param via `window.history.replaceState` so a refresh doesn't re-queue. Requires `hasPet` (queue endpoint returns 401 otherwise). This is a chunk #8-bridge — when chunk #8 lands the full `<ActivityLobbyModal>`, the modal will re-target it instead.

**HUD wiring** — `bumper-shells-hud.tsx` no longer renders the inline summary card; it instead conditionally renders `<ActivityResultsModal>` when `matchPhase === 'ended' && activityId && roomId` are all truthy. The route page (`apps/web/src/app/activity/[activityId]/[roomId]/page.tsx`) now passes `activityId`, `roomId`, `onPlayAgain={handlePlayAgain}`, and the existing `onLeave={handleLeave}`.

**Player stats — known gap (fast-follow):** Knockouts, times-bumped, damage-dealt, best-streak fields specced in `frontend-spec.md §6.2` aren't in the WS `event.match_ended` payload yet, and the client's `events.eliminations[]` ring buffer doesn't carry attribution to the local player. The modal renders only what it can verify — Final Placement, Match Score (from the live scores Map), and Eliminations Witnessed. Full per-player stats require a server-side aggregator on `match_ended` and an extra field on `RewardPreview` or a dedicated section in `GET /:roomId/results`. Tracked as a follow-up.

**Files added/modified:**

| File | Purpose |
|---|---|
| `apps/web/src/components/game/activity-results-modal.tsx` (new) | The Diablo-style reveal modal |
| `apps/web/src/components/game/bumper-shells-hud.tsx` | Replaces inline card with `<ActivityResultsModal>` mount; new `activityId` / `roomId` / `onPlayAgain` props |
| `apps/web/src/app/activity/[activityId]/[roomId]/page.tsx` | Passes new props + `handlePlayAgain` |
| `apps/web/src/lib/quests.ts` | Adds `first-match` + `first-win` quest definitions + `activityMatchesPlayed` / `activityMatchesWon` counter keys |
| `apps/web/src/stores/quest.ts` | Adds counters + `version: 2` migration with `merge` backfill |
| `apps/web/src/components/game/sidebar-menu.tsx` | Auto-fire Quick Queue on `?quickQueue=bumper-shells` URL param + `useSearchParams` import |

### 19.14 Reef Race sim + anti-cheat + bot (chunk #5)

Reef Race goes from `coming-soon` to `live` for queue entry. Server side only — the 3D scene + HUD lands in chunk #6 (frontend). Until then, queueing `reef-race` triggers the sim and ticks server-authoritatively, but the client renders no scene.

**Sim** — `apps/api/src/services/activity/sim/reef-race-sim.ts`. Mirrors Bumper's lifecycle:
- 30Hz tick (race kinematics tolerate lower rate; halves bandwidth vs Bumper's 60Hz).
- Snapshot delta @ 5Hz (every 6 ticks); keyframe @ 1Hz.
- Bespoke ~6000wu oval centerline per 3d-spec §2.1 (`reef-race-config.ts`: `REEF_TRACK_A=1100`, `REEF_TRACK_B=700`).
- Lap-based race: 3 laps, 12 checkpoints in fixed sequence (0=start/finish; 1..11 around the loop counter-clockwise).
- Soft 90s round timeout + 30s straggler grace; hard 120s cap.
- Body state per avatar: `{x, y, vx, vy, rot, alive, lap, nextCheckpoint, lastCheckpointAt, totalTimeMs, finishedAt?, dnf, lapSplitsMs[], inventory, activeEffects}`.
- Boot stagger: 8 racers placed in 4 rows of 2 behind the start line, each facing the direction of travel.
- Drag: 0.97 multiplier per frame (lighter than Bumper's 0.92 — race cars hold momentum).

**6-power-up catalog** (LOCKED — master plan §"Game design — Reef Race → Power-ups"):
| Kind | Rarity | Effect | Duration | Cooldown |
|---|---|---|---|---|
| `rr-turbo-bubble` | common | +40% top-speed (`REEF_BOOST_MULT=1.4`) | 2.5s | — |
| `rr-bubble-shield` | uncommon | Immunity to incoming knockback / slow effects | 4.0s | — |
| `rr-ink-slick` | uncommon | Self-target slow (50% top-speed) — defensive sink for "I have an ink-slick I don't want" UX | 6.0s | — |
| `rr-seeker-jelly` | rare | Knock the nearest opponent ahead off the racing line | instant | 8.0s |
| `rr-tide-wave` | rare | Slow all opponents within 250wu radius (40% velocity damp at center, lerps to 0 at edge) | instant | 8.0s |
| `rr-whirlpool` | legendary | Self-effect — buffs traction (no slow penalty) for 3s | 3.0s | 12.0s |

Spawn weights: 50/12/10/10/8/10. Boxes are pre-allocated (`REEF_POWERUP_BOX_COUNT=8`) at fixed positions around the centerline; respawn 6s after collection with a freshly-rolled kind. `bubble-shield` blocks `tide-wave` slow + `seeker-jelly` impulse; nothing else stacks specially in chunk #5.

**Checkpoint sequence enforcement** (anti-cheat — backend §4.5):
- Every body has `nextCheckpoint` initialised to 1 at spawn.
- Each tick the sim tests every checkpoint AABB against the body. If the body is inside a checkpoint AND its index matches `nextCheckpoint`, the pointer advances `(nextCheckpoint + 1) % 12`. Any other crossing is silently rejected.
- A lap completes when the body crosses checkpoint 0 as the expected next-checkpoint (i.e. the previous legitimate crossing was 11). Out-of-order crossings DO NOT advance the pointer — this is the cheapest possible defence against the "teleport-to-finish" exploit.
- A single out-of-order crossing is silent (anti-jitter). The `ReefCheckpointSkipTracker` records each silent reject in a 5s rolling window per avatar; 3+ rejects in 5s → flag (`anti_cheat.flag` event with `kind: 'checkpoint_skip'`).

**Min-lap validator**: `MIN_LAP_MS=15000`. A lap completed faster is discarded (lap counter does NOT advance), the lap-start clock resets to now, and a `kind: 'underminlap'` flag is raised. The avatar must legitimately re-traverse 1..11..0 to credit the lap.

**Lap-completion event**: every legitimate lap emits `event.lap_completed { avatarId, lap, splitMs, totalMs }`. `splitMs` is the wall-clock between the prior `lapStartedAt` and now; `totalMs` is wall-clock since match start. Server-stamped — no client-reported timing.

**Race-end conditions**:
- All bodies have either `finishedAt !== null` (3 laps complete) or `dnf=true`.
- Hard timeout `now >= startedAt + 120s` (90s soft + 30s grace).
- Soft timeout AND no still-racing-on-pace bodies.

On end → `event.match_ended` broadcast with `winners[]` ordered by placement (finishers by `totalTimeMs` ASC, then DNFers by `lap` DESC). Then `setEndedFn` callback fires the room manager's LIVE→RESULTS FSM transition; reward pipeline credits placement tokens + first-play-of-day + Reef PB bonus + focus bonus.

**Anti-cheat** — `apps/api/src/services/activity/anti-cheat/reef-race.ts`:
- `validateReefPositionDelta` / `validateReefVelocityDelta` — same shape as Bumper's variants but with `REEF_MAX_SPEED=500` + `REEF_MAX_ACCEL = MAX_SPEED * 4`. Clamp + flag (`overspeed`/`overaccel`) on over-limit deltas.
- `validateLapTime(lapMs)` — flags + drops sub-`MIN_LAP_MS` laps.
- `validateCheckpointSequence(hitIndex, expectedIndex)` — silent reject on single mismatch; tracker escalates.
- `ReefCheckpointSkipTracker` — per-avatar rolling-window skip counter.
- `validateReefPowerUpUse(slotIndex, inventory, now)` — Bumper-style slot validator at `REEF_MAX_POWER_UP_SLOTS=2`.
- `ReefFlagCounter extends BumperFlagCounter` — same 5-flag forfeit ceiling per backend §4.7.

**Replay logging** — activity-agnostic. Sim calls `activityReplayLog.appendInputFrame(roomId, avatarId, seq, dt, input, startedAt)` per validated input; `flushToDb` runs at LIVE→RESULTS via the room manager and writes `activity_replays.frames` JSONB. Personal-best ghost rendering (chunk #6) reads via `GET /api/activities/reef-race/replays/:replayId` (currently 501 — the route stub stays for chunk #6).

**Bot** — `apps/api/src/services/activity/bots/reef-race-bot.ts`. Heuristic policy:
- Aim at the next-checkpoint center with small per-tick jitter (`JITTER_MAGNITUDE=0.08`).
- Cruise at 0.85 thrust; drop to 0.6 when current heading dot-product against target direction < 0.3 (lets the body swing through corners).
- Off-track recovery: full thrust when perpendicular distance from the target checkpoint > `REEF_TRACK_HALF_WIDTH * 1.5`.
- Power-up usage: ~30%/tick chance to fire any off-cooldown slot (`POWERUP_USE_CHANCE=0.3`).
- Stateless beyond `avatarId`. Registered as `'reef-race' → createReefRaceBot` in `BOT_CONTROLLERS` so the chunk #10 bot pool seamlessly backfills under-filled Reef rooms.

**Personal-best detection**: handled in chunk #7's `reward-pipeline.ts`. The sim emits accurate `score_ms` (server-stamped finish time) via `computeResults()`; the pipeline queries the prior 30-day minimum for the avatar+activity and sets `is_personal_best: true` when `score_ms < min`. The Reef Race default `personalBestBonusTokens: 10` from `ACTIVITY_REGISTRY` then stacks on top of the placement payout.

**Wiring** — `apps/api/src/index.ts` registers Reef alongside Bumper for:
- `setLiveTransitionFn` — dispatches on `room.activityId` to `bumperShellsSim.startRoom` / `reefRaceSim.startRoom` with bot controllers from the per-activity factory.
- `setComputeResultsFn` — adds `case 'reef-race'` returning `{avatarId, placement, score, scoreMs}` rows to the reward pipeline.
- WS hub broadcast (`setBroadcastFn`) — snapshot frames go through the backpressure-aware `broadcastSnapshot`; events go through `broadcastEvent`.
- End hook (`setEndedFn`) — drives LIVE→RESULTS transition then `stopRoom`.
- Integrity-forfeit hook (`setIntegrityForfeitFn`) — sends an `error` frame and lets the WS close path fire the standard forfeit flow.

`apps/api/src/services/activity/activity-ws-hub.ts` `handleInput` + `notifyForfeit` + `sendInit` dispatch on `room.activityId === 'reef-race'`. `apps/api/src/routes/activities.ts` `/state` route returns Reef sim snapshots when LIVE.

**`ACTIVITY_REGISTRY` status**: `reef-race` already at `status: 'live'` in `packages/shared/src/activities/activities.ts` (set in chunk #2 anticipating chunk #5). No registry change needed in this chunk.

**What ships next:** chunk #6 owns the 3D scene (`apps/web/src/lib/three/activities/reef-race/*` per 3d-spec §2.10) + HUD (`apps/web/src/components/game/reef-race-hud.tsx`) + `/replays/:replayId` route to drive ghost playback. Until that lands, queueing `reef-race` triggers the sim but the client falls back to the empty `<ActivityShell>` scaffold.

### 19.15 Spectator mode (chunk #11)

When a Bumper Shells player is KO'd mid-match (`matchPhase === 'live'` AND `selfAlive === false`), the HUD replaces the chunk #4 dead-screen stub with a full spectator surface. Frontend spec §7.

**Surface composition** (all inside the upgraded `<EliminatedOverlay>`):

| Region | Component | Purpose |
|---|---|---|
| Backdrop | inline `div` | Radial gradient dim + `backdrop-filter: grayscale(40%) brightness(0.78)`. `pointer-events: none` so the user can still see the 3D scene underneath. |
| Top-center header | `claw-panel` block | "ELIMINATED" + "`{n}s remaining`" derived from `roundEndsAt` + "CURRENT PLACEMENT · #N" chip. |
| Right rail | `<aside>` | Fixed 320px-wide column, `pointer-events: none` on the aside + `auto` on interactive children. Contains the three panels below. |
| Spectating panel | `<SpectatorCamSelector>` + prev / free-cam / next cycle row | Local-state target avatar id (`spectatorTargetPetId`) + local `spectatorCamMode`. Auto-picked target on first elim = most-recent credited eliminator → highest-score alive → first alive. |
| Leaderboard | `<HudMiniLeaderboard>` (reused atom) | Same top-5+self layout as the in-match HUD. |
| Chat | `<SpectatorChatPanel>` | Renders `selectSpectatorChat(state)` transcript + input that calls `onSendChat(text)` → posts `chat` WS frame with `spectator: true`. Local-echo via `pushChatLocal` so the sender's own line appears instantly. |
| Emotes | two `<EmoteButton>` | 👏 Cheer + 😈 Taunt. 15s client-side cooldown (`EMOTE_COOLDOWN_MS`), per-emote independent. Fires `emote` WS frame with `spectator: true`; chunk #12 renders the floating glyph above the spectated avatar. |

**Store additions (`apps/web/src/stores/activity.ts`):**

- `chatLog: ActivityChatMessage[]` — 64-row ring buffer holding chat + emote messages. Populated by server `chat` frames + local `pushChatLocal` calls.
- `pushChatLocal(msg)` action — appends to the buffer without a server round-trip. Used by the spectator overlay when the sender's chat / emote should appear instantly.
- `selectSpectatorChat(state)` selector — filters to `spectator: true` rows for the chat panel.
- `selectAliveEntities(state)` selector — stable-sorted alive list for prev/next cycling.

**Protocol additions (`packages/shared/src/activities/protocol.ts`, additive only):**

- `clientChatFrameSchema.spectator: z.boolean().optional()` — marks the chat as spectator-channel.
- `clientEmoteFrameSchema.spectator: z.boolean().optional()` — marks cheer/taunt as spectator-origin.
- Server `chat` frame gains optional `spectator?: boolean` + `emote?: { emoteId: string }` fields so a future server can fan-out emotes through the chat envelope without adding a new frame type. Legacy emissions (field omitted) are backward-compatible.

**Camera punt (documented here so audits can check it):**

The frontend spec §7.3 defines three camera modes (Follow / Free / Action). Chunk #11 **captures the user's mode pick** but the underlying `<BumperShellsScene>` retains its static OrthographicCamera (`CAMERA_POSITION = [0, 1100, 300]`, `matrixAutoUpdate=false`) — that was an explicit Iris Xe performance invariant set in chunk #4. Moving the camera per frame would require invalidating the compiled pipeline cache + the "no per-frame allocations in useFrame" rule. Camera motion is **deferred to a 3da-paired chunk** (noted in §19.10 deferrals). The selector is still useful: it lets spectators express a preference that shows up in spectator chat ("Free Cam"/"Action Cam" label), and plumbs the state so the chunk-12 scene wiring doesn't need to re-touch the HUD.

**Files added in chunk #11:**

| File | Purpose |
|---|---|
| `apps/web/src/components/game/activity/SpectatorCamSelector.tsx` | Three-button Follow/Free/Action radio group |
| `apps/web/src/components/game/activity/SpectatorChatPanel.tsx` | Input + transcript for the spectator channel |
| `apps/web/src/components/game/activity/EmoteButton.tsx` | Single cheer/taunt button with SVG cooldown ring |

**Files changed in chunk #11:**

| File | Change |
|---|---|
| `apps/web/src/components/game/activity/EliminatedOverlay.tsx` | Full rewrite — from static placard → full spectator surface |
| `apps/web/src/components/game/activity/index.ts` | Export the three new atoms |
| `apps/web/src/components/game/bumper-shells-hud.tsx` | Own the local spectator state (target avatarId, cam mode, two emote cooldowns); bridge `sendChat` + `sendEmote` props to the overlay; hide the top-right in-match HUD stack while eliminated so it doesn't collide with the spectator panel |
| `apps/web/src/app/activity/[activityId]/[roomId]/page.tsx` | Wire `handleSendChat` + `handleSendEmote` using the `send` function from `useActivityWs` |
| `apps/web/src/stores/activity.ts` | Add `chatLog`, `pushChatLocal`, `ActivityChatMessage`, `selectSpectatorChat`, `selectAliveEntities`; route server `chat` frames into the ring buffer |
| `packages/shared/src/activities/protocol.ts` | Additive `spectator?: boolean` on client `chat` + `emote` schemas; additive `spectator?` + `emote?` on server `chat` frame |

**What the eliminated player can do that they couldn't before:**

1. See a countdown to round-end + their placement without being immersion-kicked to a results screen
2. Cycle through alive opponents with Prev / Next, or pick Free Cam
3. Chat to other spectators (dead-shell banter separate from the active-player room chat)
4. Cheer or taunt — one of each per 15s, with a visual cooldown ring

**Intentionally not in this chunk:**

- Server-side spectator-channel fan-out (chat is local-echo only today; `spectator: true` arrives on the wire but the server routes it back through the same room broadcast)
- 3D emote glyphs above spectated avatars (chunk #12)
- Actual camera motion (scene-side — future 3da chunk)
- Rendering spectator chat for active (alive) players (out of scope — would defeat the "dead can't coach alive" rule from spec §7.4)

### 19.16 Polish layer — tutorial card · sound design · mobile A/B (chunk #12) — **Q2 COMPLETE**

The final Q2 chunk pairs **3da's chunk #12a** (`27e9e75` — `LobsterAnimator` wired into `<BumperShellsPlayer>`, spectator perspective camera + OrbitControls behind the existing `spectatorCamMode` prop on `<BumperShellsScene>`) with this non-3D polish layer. Together they close the deferrals listed in §19.10 and §19.15.

**Surfaces shipped:**

| Layer | What | File(s) |
|---|---|---|
| Tutorial card | Nori-voiced first-time intro inside the lobby — RuneFrame card with avatar disc + 1-2 sentences of game-specific copy + "Got it" + "Don't show again (all activities)". Per-activity gate via `localStorage['clawville-activity-tutorial-seen-v1']` (JSON `string[]`); global skip via `localStorage['clawville-activity-tutorial-skip-all'] === '1'`. Both keys versioned (`-v1` suffix) so a future copy rewrite forces a re-show. | `apps/web/src/components/game/activity/ActivityTutorialCard.tsx` (new) · `apps/web/src/components/game/activity-lobby-modal.tsx` (mounts at top of `IdleBody` when `shouldShowActivityTutorial(activity.id)` returns true) |
| Sound bus | Single shared `AudioContext`, primed lazily on the first user-gesture (`primeActivitySounds()` in the lobby's Queue Solo handler + the activity route's first pointer/key/touch event). 11 SFX names: `countdown-tick`, `round-start`, `knockout`, `lap-chime`, `pb-chime`, `item-pickup`, `item-use`, `defeat`, `victory-fanfare`, `placement-silver`, `placement-bronze`. Per-sound default volume table; `playActivitySound(name, opts?)` is fire-and-forget and silently no-ops on suspended context, missing buffer, prefers-reduced-motion, or `setMuted(true)`. | `apps/web/src/lib/activity-audio.ts` (new) · 11 placeholder silent WAVs at `apps/web/public/sounds/activity/<name>.wav` (44-byte WAV header + 100ms PCM zeros — **real CC0 assets need licensing pass before launch**) |
| SFX wiring | countdown 3→2→1 ticks + GO chime in `<RoundCountdown>`; knockout SFX when `eliminations.last.avatarId === selfPetId` in `<BumperShellsHud>`; item-pickup / item-use chimes when `powerUpInventory.length` deltas; placement-tier fanfare in `<ActivityResultsModal>` (1st = `victory-fanfare`, 2nd = `placement-silver`, 3rd = `placement-bronze`, 4+ = `defeat`); `pb-chime` when `isPersonalBest` reveals during the rewards phase. | `RoundCountdown.tsx`, `bumper-shells-hud.tsx`, `activity-results-modal.tsx` |
| Mobile A + B | `<ActivityMobileControls>` mounts on the activity route only (separate from open-world `<MobileControls>`). Left joystick reuses the same `useGameStore.joystickVelocity` slot the input hook already subscribes to. Right side: 64×64 round buttons (WCAG AA touch targets) — A dispatches `clawville:activity-action` with `ACTION_BIT_BOOST`, B dispatches with `ACTION_BIT_USE_POWERUP`. `navigator.vibrate(18)` haptic on press if available. Buttons gate dispatch on the `active` prop (mirrors the input hook's `enabled`). | `apps/web/src/components/game/activity-mobile-controls.tsx` (new) · `apps/web/src/app/activity/[activityId]/[roomId]/page.tsx` (mount + pass `active={inputEnabled}`) |
| Spectator camera wiring | `<BumperShellsHud>` now reports `(spectatorCamMode, spectatorTargetPetId)` upward via `onSpectatorStateChange`. The activity route page caches that state and only forwards `spectatorCamMode` + `spectatorTargetPetId` props to `<BumperShellsScene>` while `matchPhase === 'live' && !selfAlive` (spectating). Active players keep the static OrthographicCamera. 3da's chunk #12a already extended the scene to swap to a single PerspectiveCamera + OrbitControls behind these props — see `3dStructure.md` §12. | `bumper-shells-hud.tsx`, `app/activity/[activityId]/[roomId]/page.tsx`, `BumperShellsScene.tsx` (no further 3D edits this chunk) |

**iOS / autoplay handling:** `AudioContext` is created lazily inside `getCtx()` and only `resume()`-d after `primeActivitySounds()` runs from a user-gesture handler. The lobby's Queue Solo click is the primary unlock; the activity route also primes on the first pointer/key/touch event as a safety net for non-lobby entry paths (e.g. deep-link, refresh).

**Accessibility:** `prefers-reduced-motion` short-circuits ALL SFX playback (consistent with the existing `<ActivityResultsModal>` reveal-phase reduced-motion behavior). Mobile buttons have `aria-label` ("Boost", "Use power-up"); tutorial card has `aria-label` on the skip-all link.

**Asset gap:** The 11 placeholder silent WAVs let the audio elements load without 404s and produce zero audible noise. Real SFX (kenney.nl 1-bit pack or equivalent CC0 source) need a separate licensing pass — track in `improvements.md` if a follow-up is needed.

**This closes Q2 Activity Portals — all 12 chunks are shipped (in PRs).**

| Chunk | Status | Coverage |
|---|---|---|
| #1–#3 | merged | foundation + room manager + WS hub |
| #4 | merged | Bumper Shells client end-to-end |
| #5 | merged | Reef Race sim + anti-cheat + bot |
| #6 | merged | Reef Race 3D scene + minimal HUD + ghost |
| #7 | merged | reward pipeline + per-activity leaderboards |
| #8 | PR open | portal + lobby + party UX |
| #9 | merged | results screen + tutorial quest hooks |
| #10 | merged | bot backfill controllers (solo Bumper playable) |
| #11 | PR open | spectator mode |
| #12 | **THIS PR** | LobsterAnimator + spectator cameras + tutorial + sound + mobile A/B |

### 19.17 Reef Race SPEC 1 — Multi-species GLB rider (post-Q2)

**Objective:** Replace the hardcoded `lobster.glb` in `<ReefRacePlayer>` with a live per-avatar GLB dispatch driven by `avatars.model_key`.

**Data flow:**
1. `avatars.model_key` (DB column `model_key`, Drizzle accessor `avatars.modelKey`)
2. `loadParticipantMeta(humanPetIds, botPetIds)` in `avatar-profile-loader.ts` — 1 SELECT per room start; bots always resolve to `'lobster'`; DB failure falls back all to `'lobster'`
3. Stamped into `RoomMeta.reefParticipantMeta: Record<string, { modelKey: string }>` inside `sendInit()` in `activity-ws-hub.ts` — sent once on `snapshot.init`; absent on subsequent `snapshot.keyframe` frames
4. Activity Zustand store (`apps/web/src/stores/activity.ts`) — `snapshot.init` handler injects `species: meta.modelKey` into each entity and saves the map as `state.reefParticipantMeta`; `snapshot.keyframe` re-injects using the stored map (species persists through entity deltas automatically via spread in `applyEntityDelta`)
5. `<ReefRacePlayer>` reads `entity.species` and dispatches `glbPath`

**GLB dispatch table (`ReefRacePlayer.tsx`):**

| `species` / `modelKey` | GLB | Rig |
|---|---|---|
| `'lobster'` (default/fallback) | `/models/lobster.glb` | Mixamo 65-bone rig |
| `'crayfish'` | `/models/crayfish.glb` | Static mesh (0 bones), procedural swim via `applyTransformSwim` |
| `'seahorse'` OR `'sea_horse'` | `/models/sea_horse.glb` | 93-bone rig |
| `milady_official_*` | `/models/lobster.glb` + `console.warn` | SPEC 2 VRM — deferred |

**Spelling note:** `AGENT_MODELS` registry uses `'seahorse'` (no underscore); `SeaCreatureSpecies` / GLB filename use `'sea_horse'` (underscore). Both spellings are handled in the switch so either DB value works.

**`emptyState()` guard:** `'reefParticipantMeta'` is included in the `Pick<ActivityState, ...>` union so `reset()` wipes stale species data on room leave / rejoin. Without this, a second race would inherit the prior room's species map.

**VRM dispatch (SPEC 2 — SHIPPED 2026-04-29):** `milady_official_*` model keys now render a full VRM avatar via `@pixiv/three-vrm`. See §19.18 below.

**Files changed:**
- `packages/shared/src/activities/protocol.ts` — `reefParticipantMeta?` added to `RoomMeta`
- `apps/api/src/services/activity/avatar-profile-loader.ts` — `loadParticipantMeta()` exported
- `apps/api/src/services/activity/activity-ws-hub.ts` — load + embed in `sendInit()`
- `apps/web/src/stores/activity.ts` — interface field, emptyState, snapshot handlers
- `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx` — crayfish preload + species switch (SPEC 1); VRM rider + wipeout/victory (SPEC 2)

---

### 19.18 Reef Race SPEC 2 — Milady VRM rider with surf_idle / wipeout / victory (shipped 2026-04-29)

**Objective:** Replace the SPEC 1 lobster.glb fallback for `milady_official_*` species with a live `@pixiv/three-vrm` 3.5.x avatar mounted on the surfboard, driven by three animation clips: `surf_idle` (base resting state), `wipeout` (one-shot on respawn teleport), and `victory` (one-shot on finish).

**VRM dispatch table (replaces SPEC 1 stub row):**

| `species` / `modelKey` | Renderer |
|---|---|
| `'lobster'` (default/fallback) | GLB + Mixamo rig |
| `'crayfish'` | GLB + procedural swim |
| `'seahorse'` OR `'sea_horse'` | GLB + Mixamo rig |
| `milady_official_1` … `milady_official_8` | VRM via `useVRMInstance` + `VRMCharacterAnimator` |

**Component architecture:**

`<ReefRaceVRMRiderInner>` (new component, suspended):
- Calls `useVRMInstance(vrmPath, 'reef-race-{avatarId}')` — per-instance two-tier cache (shared `VRM_BYTES` + per-instance `VRM_INSTANCES`). Throws a Promise on first load, triggering Suspense.
- Disposes on unmount via `disposeVRMInstance(vrmPath, 'reef-race-{avatarId}')`.
- Instantiates `VRMCharacterAnimator`, calls `init('surf_idle')`, then `setSurfaceClip('surf_idle')` so post-one-shot crossfade targets `surf_idle` not `idle`.
- Attaches VRM scene to `riderMountRef` (same THREE.Group that GLB riders mount to), scale `VRM_RIDER_LOCAL_SCALE = 5.6` (= `PET_VRM_SCALE(112) / KART_SCALE(20)`).
- `frustumCulled = false` on all VRM scene nodes — skinned mesh bind-pose bbox culls animated poses.
- Wrapped in `<Suspense fallback={null}>` in `<ReefRacePlayerInner>` JSX.

**Rules of Hooks compliance:** `useGLTF` is ALWAYS called (never conditional). When `isVRM=true`, the sentinel path `/models/lobster.glb` is passed; then `effectiveSrcScene = isVRM ? null : srcScene` gates all downstream GLB usage.

**`VRMCharacterAnimator` changes:**
- Added `private surfaceClip: AnimName = 'idle'` field.
- Added `public setSurfaceClip(name: AnimName): void` method.
- `applyCrossfade` and `playOneShot` `onFinished` handler use `this.surfaceClip` instead of hardcoded `'idle'`, so post-one-shot return targets the correct clip for the activity surface.
- `dispose()` resets `this.surfaceClip = 'idle'` BEFORE `this.actions = {}`.

**Wipeout detection:**
- Heuristic: `position delta > 500wu` in one 20Hz snapshot interval = respawn teleport (not achievable by normal physics at `REEF_MAX_SPEED ≈ 82wu/tick`).
- Module-level `_lastXZ: Record<string, {x,z}>` tracks per-entity last known XZ.
- Checked inside the `entity !== lastEntityRef.current` guard (fires once per snapshot, not per frame).
- On detection: `vrmAnimatorRef.current.playOneShot('wipeout')`.
- `_lastXZ[entity.avatarId]` cleared on GLB mount cleanup to prevent false-positive on remount.

**Victory trigger:**
- Fires when `entity.finishedAt` transitions from falsy to truthy (`finishedRef.current` guard ensures once only).
- Calls `vrmAnimatorRef.current.playOneShot('victory')`.

**VRM byte preload at module scope:**
```ts
for (let _n = 1; _n <= 8; _n++) {
  preloadVRMBytes(`/avatars/milady-official-${_n}.vrm`);
}
```
Uses the existing `preloadVRMBytes` export from `vrm-loader.ts` (no changes to that file).

**SPEC 1 warn-spam fix (same diff):**
- Module-level `_warnedVrmKeys = new Set<string>()` deduplicates `console.warn` for unknown species. Warning now fires at most once per unique species key per page load.

**Files changed:**
- `apps/web/src/lib/three/vrm-character-animator.ts` — `surfaceClip` field + `setSurfaceClip()` + dispose ordering
- `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx` — VRM rider component, wipeout/victory triggers, hooks compliance, warn-spam fix

---

## Appendix: Map Layout

5120x5120 world, 160x160 tiles at 32px each. **Circular ring** of 10 buildings — radius 56 tiles (1792px) from center (80, 80) = world (2560, 2560), 36° (π/5) angular spacing, starting visual-creation at TOP CENTER (θ = -π/2) clockwise. Source: `apps/web/src/lib/pixi/tilemap-data.ts:55-77` `buildingZones[]` and `packages/shared/src/constants/npc-definitions.ts:41-62` `BUILDING_TILE_ZONES`.

| θ index | Building | Center tile | Center pixel | Zone upper-left tile |
|---|---|---|---|---|
| 0 (-π/2, TOP) | visual-creation | (80, 24) | (2560, 768) | (73, 17) |
| 1 | memory-rag | (113, 35) | (3616, 1120) | (106, 28) |
| 2 | api-integrations | (133, 63) | (4256, 2016) | (126, 56) |
| 3 | cron-automation | (133, 97) | (4256, 3104) | (126, 90) |
| 4 | app-publishing | (113, 125) | (3616, 4000) | (106, 118) |
| 5 (+π/2, BOTTOM) | deployment-ops | (80, 136) | (2560, 4352) | (73, 129) |
| 6 | mcp-tool-use | (47, 125) | (1504, 4000) | (40, 118) |
| 7 | code-development | (27, 97) | (864, 3104) | (20, 90) |
| 8 | messaging-channels | (27, 63) | (864, 2016) | (20, 56) |
| 9 | agent-security | (47, 35) | (1504, 1120) | (40, 28) |

All buildings are 14×14 tiles (448×448 pixels) — `BUILDING_TARGET_HEIGHT = 800` world units. Each rotates to face village center via `rotY = atan2(80 − cx_tile, 80 − cy_tile)` at `arena-buildings.tsx:48-50`.

Spawn point: (2560, 2560) — world center, not inside any building. Minimum zone-to-zone gap is ~15 tiles (arc separation ~35 tiles, zone diagonal ~20 tiles), no overlaps.

### Additional Backend Routes (not covered above)

| Path | Purpose |
|---|---|
| `/api/activity` (`apps/api/src/routes/activity.ts`) | Activity feed backing the sidebar Activity Log |
| `/api/agent-v2` (`apps/api/src/routes/agent-v2.ts`) | Experimental alternate agent gateway |
| `/api/claws` (`apps/api/src/routes/claws.ts`) | Claw-related endpoints |
| `/api/marketplace` (`apps/api/src/routes/marketplace.ts`) | Knowledge-book marketplace (separate from bazaar) |
| `/api/research` + `/api/research-sse` | Research thought-stream feeding `ThoughtLog` |
| `/api/agent-setup` | Multi-agent roster + loadout + import/export (`MAX_AGENTS = 1` enforced) |

---

### 19.19 Reef Race SPEC 3 — Ramp launch volumes (shipped 2026-04-29)

**Mechanic:** 6 server-authoritative ramp trigger volumes placed at spline t=0.09/0.22/0.35/0.50/0.65/0.78 (one per segment). A grounded body that enters a ramp AABB (150×200wu half-dimensions in tangent/normal basis) while `airborneTicks === 0 && heightOffset === 0` receives a 600 wu/s vertical launch impulse — vs 380 wu/s for a manual SPACE jump. Cooldown 500ms prevents multi-trigger on the same ramp.

**Server changes:**
- `SplineRampPatch` interface + `buildSplineRamps()` in API-side `reef-race-config.ts`
- `SplineRoomState.ramps` (built once per room) + `SplineRoomState.rampCooldowns` (lazy per-body Map)
- `resolveRamps(state, now)` private method wired into `tickRoom()` step 5d (after resolvePickups)
- Broadcasts `event.ramp_launch { avatarId, rampId, launchVel }` on trigger

**Protocol:** `event.ramp_launch` union member added to `ServerFrame` in `packages/shared/src/activities/protocol.ts`. Old clients ignore it (switch/case default path).

**Client visuals:**
- `ramps.tsx` — 6 triangle-prism wedge meshes (300×400×60wu, `#c9884a` MeshStandardMaterial, DoubleSide). Wired into `<RiverScene />`. 6 draw calls, 48 tris.
- `ReefRaceScene.tsx` — screen-shake infrastructure: `shakeRef = useRef<number>(0)` + `triggerScreenShake(intensity)` + exponential decay in `ChaseCamera.useFrame` (−2.5×/s)
- `ReefRacePlayer.tsx` — subscribes to `lastRampLaunchEvent` from store. For ALL avatars: sets `_rampLaunchHold[avatarId] = 0.35s` → extended 16° nose-up tilt (RAMP_NOSE_UP_RAD=0.28 vs JUMP_NOSE_UP_RAD=0.14). For self-player only: calls `triggerScreenShake(0.12)` + `triggerBurst(new THREE.Vector3(x, height, z), '#ff9944', 100)`

**Activity store:** `lastRampLaunchEvent: { avatarId, rampId, at } | null` slice added. Populated on `event.ramp_launch` frames. Reset on room reset via `emptyState()`.

---

*Generated by auditing the files listed in the task prompt. Every claim traces to a line number. Discrepancies between docs (CLAUDE.md / README.md) and code are called out in §8 (daily-login bonuses), §9 (stats unused in combat), §11 (SpectatorBanner dead code), §6 (client quest tracker vs. backend quests), and §4 (items.ts:311-313 latent ReferenceError).*