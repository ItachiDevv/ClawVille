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

**Last Audited:** 2026-06-18 (Language/translation UX rework — lag · too-few-languages · randomly-switches-back). Founder follow-up to S9. `game-language-control.tsx`: (1) **incremental processing** — the MutationObserver now translates only changed/added subtrees (`collectRecordsFromNode`, debounced `flushPending` queue) instead of a FULL `.game-container` TreeWalker re-walk on every mutation (the lag source); full walk only on initial pass + language switch. (2) **fast-reapply** — when React reverts a translated node to English, the observer re-applies the cached translation SYNCHRONOUSLY (no debounce, no API) so it never flashes back; the crude global `suppressObserverUntil` is replaced by per-node/per-attr self-write detection. (3) **dynamic-string skip** (`isDynamicStatusText`) — high-churn counters/timers ("6 / 12 visited", "1,250", "LV 1 · 0 SKILLS") aren't translated, so they stop thrashing the cache + tripping the rate limit. (4) **~43-language menu** (was 10; server translates to any BCP-47 locale via the LLM). (5) **client 429 backoff** (~12s, cached-only) + a generation/seq model. **Server:** `/api/i18n/translate` rate limit 30→60/min/IP. Codex co-reviewed (Rule E3) — caught a recapture bug (a tracked-but-untranslated node React fills with new text now recaptures + translates). `next build` exit 0. NEEDS founder cold-test + mobile/iPad sweep (Rule E4). `ARCHITECTURE.md §i18n` same-diff. Prior audit follows.

**Prior Last Audited:** 2026-06-18 (S9 — translation: fixed an unbounded memory leak). Investigating the "translation issues" (no specific founder repro) found `game-language-control.tsx` was sound (order-safe `/api/i18n` response + English fallback, correct `.game-container` root, skip-selectors) EXCEPT `trackedTextNodes`/`trackedAttrElements` are strong-ref `Set`s that accumulated every DOM node ever seen while translation was ACTIVE and never pruned → unbounded heap growth + an ever-slower `restoreOriginals`/collect pass = a long-session jank/freeze vector (also feeds S8). Fix (retention/bounding only, no translation-behaviour change): `pruneDisconnectedTracked()` deletes `!isConnected` nodes (run in `restoreOriginals` + each translate pass), re-track on re-observe so a pruned→reconnected node stays restorable, + a bounded FIFO client cache (3000, oldest-evicted). WeakMap originals left intact. Codex co-reviewed. Prior audit follows.)

**Prior Last Audited:** 2026-06-18 (S6 — left quest tracker decrowded). `quest-tracker.tsx` expanded view read as "two duplicate boxes": the collapsed-header `claw-panel` + the expanded-list `claw-panel` were two stacked rounded boxes, AND the active quest rendered TWICE (header title+progress block had no `!expanded` guard + the expanded active card). Refactor (pure JSX/CSS, no quest store/definitions change): ONE `claw-panel` (`!p-0`) wrapper = unframed header on top + a divider + a scroll body; the header is now SLIM while expanded (rich hint+progress shown only while COLLAPSED) so the active quest renders once; compact typography (base/sm → sm/xs, tighter padding); scroll affordance added (bottom fade-gradient overlay matching the navy panel + a thin cyan webkit/`scrollbar-width:thin` scrollbar) so a new user can tell it scrolls; robust `max-h-[min(420px,calc(100vh-320px))]` (was `calc(100vh-640px)` which collapsed to min-h on laptops). Single instance confirmed (the two `/game/page.tsx` mounts are mutually exclusive on `agentConnected`). The bigger left-vs-right quest PARITY rework stays deferred (backlog). Codex co-reviewed. NEEDS mobile/iPad sweep + founder sign-off (Rule E4). Prior audit follows.)

**Prior Last Audited:** 2026-06-18 (S5 — bottom-center chat/prompt deconfliction). `LocationHUD` ("Press E") now lifts to `env+84px` on desktop whenever a bottom chat pill is present (every non-explore mode has one: `AvatarChatBar` in player/autonomous, `TalkToCharacterBar` in npc), so it no longer overlaps the ~54px pill band; mobile already cleared (+220px). The NPC-mode conflation (both `LocationHUD` and `TalkToCharacterBar` showed "Talk to {resident}" for the SAME building resident — `findNearestCharacter` maps buildingId→resident, so `nearCharacter`+`nearLocation` are always set together) is fixed via a VERB SPLIT: `TalkToCharacterBar` owns "Talk to {resident}" (transient `/api/chat/transient` = `gpt-4o-mini`, no auth — the guest cheap-GPT path, already in place = S5 part 3 done) and `LocationHUD` becomes the distinct "Enter {building}" (full ElizaOS resident chat via `enterBuilding`). `EmailVerifyBanner` now YIELDS (returns null) when `LocationHUD` is visible (`!explore && nearLocation && !chatOpen && !guideChatOpen`), mirroring the existing Hatcher mutual-exclusion — at most one bottom-center surface shows. Files: `location-hud.tsx`, `email-verify-banner.tsx`. Codex co-reviewed. NEEDS mobile/iPad viewport sweep + founder sign-off (Rule E4). Prior audit follows.)

**Prior Last Audited:** 2026-06-17 (Land Economy Phase 1 — NEW §18b. Priced parcel buy (server-stamped `price_ct`, cap 5/avatar, Founder→501), tier-gated structure placement (free Lv1, `isSkuAllowedForTier`) + priced upgrades (`STRUCTURE_UPGRADE_COSTS`, tier ceiling `getTierMaxLevel`), `/owned`+`/me` now return `{parcels, structures}`. Leaderboard: 3 land events scored (`land.parcel.purchased` 5, `land.structure.placed` 3, `land.structure.upgraded` 5) from shared constants, mirrored in both agent/avatar CTEs. Rule E5 parity: human cookie OR agent session both buy/place/upgrade as the bound avatar with real CT + leaderboard. `ARCHITECTURE.md §2/§5a/§5b` + Nori `town-guide.ts` updated same-diff. Prior audit follows.)
> **Prior Last Audited:** 2026-06-15 (Cove agent-parity completed across ALL FOUR games — §18a.l. `cove-slots.ts` + `cove-baccarat.ts` + `cove-holdem.ts` now resolve a connected/hosted agent session to its bound avatar for real-CT settlement, matching `cove-blackjack.ts`; guests stay demo; non-ledger/unbound agents get 403. No leaderboard change; no `PROTOCOL_VERSION` bump — settlement resolver only, agent ACTION whitelist unchanged. Closes the Rule E5 retroactive cove debt. Prior audit follows.)

**Prior Last Audited:** 2026-06-15 (Hatcher owner-launch = CONTROLLED mode through the magic link, §2f — SUPERSEDES the 2026-06-13 spectate/observe-only framing below). The owner-launch handler now lands the owner in `controlMode:'player'` DRIVING the agent's bound avatar instead of spectating in 'explore': `setControlMode('player')` (no `hatcherSpectate`/`requestCameraFocus`; stale spectate flag defensively cleared), the exchange sends + returns `mode:'controlled'`, and the agent's separate autonomous `oc-${sessionId}` sim body is SUPPRESSED server-side (hidden from snapshots; skipped by planNpcBehaviors/getIdleAliveNpcs/findNearestIdleNpc/moveNpcs; frozen on prime; `[ACTION:]` tags stripped un-executed) while the owner drives — primed for 3s by the exchange (keyed on the namespaced agentId) and refreshed by the 5Hz `POST /api/world/position`, auto-expiring ~3s after driving stops (explore mode gates uploads off → autonomy resumes). The exchange ENFORCES the identity invariant suppression rests on: `409 agent_not_bound` if the agent row has no bound user, `403 agent_not_owned` if the launching Lucia session ≠ the agent's bound user (both new on `HatcherLaunchExchangeResponse.error`) — fail loud, never silently dupe a body. Multi-agent precision + bubble-leak FIXED (follow-up, same session): suppression is keyed to the LAUNCHED agent (server-side `humanControlledOpenClawLaunchesByUser` Map bound at exchange) so refresh re-ups ONLY the launched agent — a user's other Hatcher proxies keep running; the binding outlives the 3s TTL so a >3s upload stall is re-primed on resume (no permanent two-body); and both snapshots filter active conversations involving a suppressed proxy so no lingering bubble. Files: `packages/shared/src/types/openclaw.ts`, `apps/api/src/routes/{partner-hatcher-launch,world}.ts`, `apps/api/src/services/npc-simulation.ts`, web `components/game/hatcher-launch-handler.tsx`. Gates: `bunx tsc --noEmit` apps/api exit 0 (after `@clawville/shared` rebuild); `bunx next build` apps/web exit 0; Codex independent review SHIP-WITH-FIXES → both required fixes (ownership guard + complete freeze) applied. CONFIRMED + LIVE 2026-06-15: Hatcher aligned `/launch/exchange` to the spec + deployed to prod + repointed Hatcher PROD → ClawVille PROD (issuer `.well-known`s smoke-checked); controlled launch live prod↔prod. Detail: `ARCHITECTURE.md §13` 2026-06-15. PARITY: human path = magic-link → `'player'` of the bound avatar; agent path = the SAME avatar (its autonomous proxy is the suspended one); settlement binds to `row.userId`. Team `controlled-magic-link-2026-06-15` (Claude impl + Codex review). Prior audit follows.

**Prior Last Audited:** 2026-06-13 (Hatcher fix batch — owner-launch carrier + transient-failure recovery, §2f). **FIX-1 (launch feature was silently dead in PROD):** the owner-launch handler (`hatcher-launch-handler.tsx`) now accepts the grant from BOTH the URL **query string** AND the **fragment**, PREFERRING query and stripping the consumed params from whichever carrier they arrived on. Hatcher's deployed PROD dashboard emits the grant on the query string (`/game?hatcher_agent=…&hatcher_launch=…`), so the prior fragment-ONLY reader (2026-06-12 entry #3 below) silently no-op'd against all real partner traffic — the entire feature was dead. The `#fragment` form stays the PREFERRED-but-not-required carrier on log-hygiene grounds (query bearers leak into access logs + early `Referer`s); migrating Hatcher's emitter to the fragment is hardening FOLLOW-UP / partner relay item **R1**, not a precondition. This SUPERSEDES the "MUST emit in the fragment / query silently no-ops" contract in the prior entry. **FIX-12 (transient launch failures offer in-page Retry):** a transient exchange failure (network blip, our issuer momentarily unconfigured / 503, or a 401 set-cookie/redirect race) now surfaces an in-page **Retry** instead of dead-ending to "relaunch from Hatcher"; the 401 cookie-race also does one short AUTO re-attempt. Earlier the token was stripped + the `firedRef` re-entry guard latched BEFORE the exchange resolved, leaving NO recovery path for a one-off failure. Terminal failures (`agent_not_registered`, definitive `exchange_rejected`) keep the hard relaunch dead-end. PARITY: owner-side observe-only entry; no economy writes (spectate). Reference: REVIEW-REPORT.md FIX-1 + FIX-12. Files: `components/game/hatcher-launch-handler.tsx`, `lib/api.ts`. Prior audit follows.

**Prior Last Audited:** 2026-06-12 (Codex full-diff review — web findings #2/#3/#5; ROUND 2 web finding R2-4). **R2-4 (spectate survives an API restart):** a Hatcher launch lands the owner in spectate (`controlMode='explore'`, `hatcherSpectate=true`). In explore mode `useWorldStream` skips the 5 Hz `/api/world/position` upload, so the `409 → ticketed-rejoin` recovery path can NEVER fire — the SSE downlink's `onerror` was the only recovery trigger, and it merely reopened the SAME stream URL. After an API restart the room registry is wiped, so the stream's membership gate returns `403` and a bare reopen 403s forever — the launched viewer is stranded on a dead stream by any deploy/restart. Fix: the recovery logic (replay `/api/world/join` WITH the sticky-room recovery ticket, refresh `roomId`+`roomTicket`+local presence id, then re-point the SSE) is extracted into one `rejoinWithTicket()` primitive that both `recoverFrom409` (player mode) and the SSE `onerror` handler (explore/spectate) delegate to. On an SSE error with an established session + ticket the handler ESCALATES in two steps to protect the scarce `/join` budget (server `joinRateLimiter`: 3 per 60s per IP): step 1 a cheap BARE same-url reopen heals a transient network blip for zero `/join` cost (the stream's `open` handler clears the escalation flag); step 2, only if that bare reopen ALSO errors (the membership-loss signal — a restart 403s every reopen), it runs the ticketed rejoin to re-acquire membership + a fresh ticket, then re-points the stream at the room the rejoin returns. A single shared `recoveryInFlight` latch prevents concurrent rejoins (with the player-mode 409 path), and the existing exp-backoff (3s→60s, 20 attempts) is preserved as the fallback when the API is still down. So a flapping stream can't exhaust the 3/min `/join` budget, and a genuine restart still recovers. First-time stream opens and the normal player-mode 409 recovery are unchanged. PARITY: render/recovery-only, no economy writes — spectate is observe-only. `next build` exit 0. Files: `hooks/use-world-stream.ts`. **#2 (paired-vs-bearer split, reload fix):** the game-page reload effect used to pass the server's `agentSession.agentId` into `setAgentConnection()` AS IF it were the session bearer; the next avatar chat then sent that `agentId` as the `sessionId` → `404 agent_session_not_found` → the connection cleared ~1s after every reload (the partner's recurring symptom). Root cause is architectural: the server emits the agent-session **bearer exactly once at connect and never re-emits it** (hard security invariant), so `/me/agent-session` genuinely cannot hand the browser a live bearer after a reload — the only honest reload state is "paired, no live bearer." Fix splits two store states: **`agentPaired`** (reload-survivable "this user has a connected agent," derived from `/me/agent-session`, drives the Bot-Training pill + Controlled/Autonomous toggle + cove autonomous availability, carries NO bearer) vs **`agentSessionId`** (the live bearer, set ONLY by the in-session connect flow that actually received it, null after reload). New `setAgentPaired(true)` hydrates the paired state with `agentSessionId=null`; the agent-bearer chat path (`agentConnected && agentSessionId`) stays OFF by construction, so `<AvatarChatBar>` falls back to the authed `api.sendAvatarChat` (no 404, avatar stays mounted) and shows a quiet "chatting with <avatar> — reconnect your agent to chat as it" affordance. Reconciled with the D2 stale-clear: the server-says-disconnected branch now calls `setAgentPaired(false,{keepEmbodied})` with the same owner-embodiment guard. No fabricated bearer anywhere. **#3 (Hatcher launch token off the query string):** the launch grant moved from `/game?hatcher_agent=&hatcher_launch=` to the URL **fragment** `/game#hatcher_agent=&hatcher_launch=` — a query-string bearer is captured by CDN/web access logs + leaks into the `Referer` of early sub-resource requests BEFORE the post-mount strip runs; a fragment is never sent to the server, logged, or refer[r]ed. Hatcher's dashboard MUST now emit the grant in the fragment (a query-string launch silently no-ops). **#5 (remote players freeze):** the players store now does IMMUTABLE updates — a moved remote player gets a NEW object so its identity flips, the memo'd `RemotePlayerEntry` re-renders, the adapter recomputes, and the mesh's entity-interp lerps prevX→x; still players keep their reference so memo bails. Before, the store mutated in place, identity never changed, the `adaptPlayer` `useMemo([player])` froze at mount, and remotes mounted once then never moved (the D3a Suspense-outside-memo fix cured the load deadlock but not this). `next build` exit 0. Files: `stores/game.ts`, `app/game/page.tsx`, `components/game/avatar-chat-bar.tsx`, `components/game/hatcher-launch-handler.tsx`, `stores/players.ts`, `lib/three/remote-players.tsx`. PARITY: UI/render-only; no economy writes (cove autonomous still resolves the agent server-side from the authed session, so paired-no-bearer reload play binds correctly). Prior audit: (sticky-room recovery — a deploy/restart no longer splits a grouped party; the server hands each session a signed, self-expiring recovery ticket it replays on rejoin to re-converge the room — see §11z.e). Prior audit: (regression D2 — dead-session stale-clear must not unmount a logged-in owner's avatar): the 2026-06-11 reconnect-recovery (prior entry #3) shipped a `setAgentConnection(null)` that cascaded `controlMode → 'explore'`, hard-unmounting `<PlayerAvatar>` ~1s after a connected user sent a chat that 404'd on a server-dropped session (partner: "avatar vanished mid-game"). Fix: `setAgentConnection(sessionId, { keepEmbodied })` — a still-authenticated **non-guest owner with an avatar** stays in `'player'` (body mounted, camera following); only the agent-specific state clears. Guest/avatar-less users still fall to `'explore'`. `<AvatarChatBar>` mount gate widened from `agentConnected`-only to `hasAvatar && controlMode∈{player,autonomous}` so its in-panel reconnect banner survives the clear and the owner can keep chatting via the non-agent `api.sendAvatarChat` path; agent-only progression/shop surfaces still gate on `agentConnected`. Race-safe (defaults to keeping the body when the shared `['auth-me']` cache is unresolved, reconciled by the auth-sync effect). Full detail in §2a reconnect-UX note. Does NOT touch `hatcherSpectate`/launch-banner flows (those land in `'explore'`, where the chat bar correctly stays unmounted). PARITY: UI/embodiment-only, no economy writes; the reconnect path is the agent's own re-handshake. `next build` exit 0. Files: `stores/game.ts`, `avatar-chat-bar.tsx`, `app/game/page.tsx`.

**Prior Last Audited:** 2026-06-12 (bottom-center banner stack — Hatcher lift + mutual exclusion; task #2 extension): resolved the residual collisions the trio entry below flagged as out-of-scope. (1) **Hatcher launch banner lifted** (`hatcher-launch-handler.tsx`): the launch failure/relaunch banner moved from `bottom-4` (band ~16–87px, overlapping the chat pill) to `bottom-20` (band 80–151px desktop, 80–399px at 390px mobile where it wraps to ~319px tall). Now clears the `<AvatarChatBar>` chat pill (`bottom-0`, ~12–54px) with a 26px gap at every viewport, stays in-viewport on mobile, and remains transient + dismissable. (2) **Email ⇄ Hatcher mutual exclusion** (new `hatcherLaunchBannerActive` store flag in `stores/game.ts` + setter): `HatcherLaunchHandler` mirrors its banner visibility into the flag (effect on `banner`, cleared on unmount); `<EmailVerifyBanner>` reads it and suppresses itself while a Hatcher banner is active. This eliminates the email-vs-Hatcher stack entirely (no positional lift can clear the ~319px mobile Hatcher panel), so the email nudge yields the slot to the higher-priority transient and returns on dismiss. Email banner stays at `bottom-24` (clears the chat pill on its own when shown). Verified in-browser desktop + mobile 390×844 (no overlaps; flag + setter present in the built bundle). PARITY: UI-only, no economy writes; both banners remain reachable by any visitor regardless of human/agent path.

**Prior Last Audited:** 2026-06-11 (partner-feedback trio — web side): (1) **EmailVerifyBanner gating** (`email-verify-banner.tsx` + `game/page.tsx`): the "Confirm your email" nudge was rendering for EVERYONE, including agent-identity users (auto-created via `resolveOrCreateUserByIdentity` with `email: null` — nothing to confirm) and guest/demo sessions. Now gated on `isAuthenticated && !isGuest && user.email`-non-empty && `!emailVerified` at BOTH the mount site and the component's internal early-return (defense in depth). `me()`'s `user.email` type corrected to `string | null` to match the DB. (2) **Bottom-center collision fixed:** the email banner lifted from `bottom-4` → `bottom-24` (6rem) so it stacks above the WHOLE bottom-center stack — both the `<AvatarChatBar>` "Chat with <agent>" pill (`bottom-0`/`z-50`, band ~12–54px) AND the 2-line Hatcher launch banner (`hatcher-launch-handler.tsx` at `bottom-4`, band ~16–87px) — instead of overlapping (partner screenshot). `bottom-20` was an interim value that still clipped the 2-line Hatcher panel; `bottom-24` clears it (banner bottom at 96px, ~9px gap, measured in-browser). `bottom-28`/`bottom-32` aren't generated in this Tailwind build so `bottom-24` is the ceiling. (Pre-existing, separate: the Hatcher banner itself still overlaps the chat pill — flagged to the lead, not in this task's scope.) (3) **Stale connected-state recovery** (`avatar-chat-bar.tsx`): when a connected-agent chat send hits `404 + code:'agent_session_not_found'` (server lost the in-memory session after an API restart/deploy/expiry), the bar clears `agentConnected`/`agentSessionId`/the Bot-Training pill via `setAgentConnection(null)` and shows a non-blocking Reconnect banner opening `<AgentConnectModal>` — no auto-retry (no stored credentials). Matches on the stable `code`/`status`, never the de-branded message copy; `lib/api.ts` now throws an `ApiError` carrying `status` + `code`. PARITY: both fixes are agent-path aware — the banner suppression covers agent-identity users, and the reconnect flow is the agent's own re-handshake; no economy writes.

**Prior Last Audited:** 2026-06-11 (Hatcher launch entry §2f): owner-side launch handler consumes `?hatcher_agent=&hatcher_launch=` on `/game`, exchanges the grant via `POST /api/partner/hatcher/launch/exchange` (Lucia-authed), and drops the owner into spectate ('explore') focused on the agent's in-world body via the new one-shot `cameraFocusRequest` store signal (drained by `WASDCameraController`). v1 is observe-only (`autonomous`); `controlled` possession is a follow-up. 401 → relaunch-from-dashboard banner; other failure → non-blocking banner; params absent → zero behaviour change. New: `HatcherLaunchHandler` component, `api.hatcherLaunchExchange`, `cameraFocusRequest`/`requestCameraFocus`/`consumeCameraFocus` + `hatcherSpectate`/`setHatcherSpectate` in `stores/game.ts` (spectate exempts the owner from the explore→player auto-promotion). PARITY: human watches via portal launch URL; agent already in-world via partner registration; no economy writes.

**Prior Last Audited:** 2026-06-10 (NPC stroll continuity + guest mode-hijack fix + **server-cadence root cause**): (0) **Waypoint-tick burn FIXED** (`npc-simulation.ts moveNpcs`): the path-follower burned an entire 200ms tick on every A* waypoint arrival (index advance, zero movement) — waypoints arrive every 3–5 ticks, so ~1/3 of walking ticks emitted no position change. Measured live: walking NPC frozen 38% of screen time in 150–200ms-move/50–150ms-freeze cycles ("NPCs move in spurts"); this was also the long-standing ~2.5Hz-not-5Hz effective sim cadence. Now the mover walks the tick's full 44px along the path polyline across waypoint boundaries, then applies the unchanged single collision pipeline; consumed waypoints only commit when the clamp applied the full move (no corner-cutting on shaved moves). (1) **Wander heading continuity** (`npc-simulation.ts`): free-roamer replans bias the next leg into a ±60° forward cone around the last applied movement heading (`headingAngle`, new runtime field) with an 800px minimum leg, falling back to the old uniform annulus sample on the last 4 of 12 attempts; wander arrivals now chain into the next leg after a 0.4–0.8s beat 60% of the time (was ALWAYS a dead 4–8s stand). Fixes "NPCs hit stopping points and turn around constantly" — baseline measured 90 heading reversals/min across 10 NPCs on staging. (2) **Guests exempt from explore→player promotion** (`game/page.tsx`): the avatar-sync effect promoted ANY avatar owner out of 'explore' on every `useAvatar` refetch — for guests (avatar auto-minted by NPC mode) this hijacked the toggle into character control ("on explore mode but controlling an NPC"); now gated `!isGuest`. (3) **Correction of the prior entry:** the "walk speed raised to 550 wu/s" change described below was REVERTED same-day (`af6a550e` — 110-unit ticks glitched the client interp); server speed is the tuned 220 wu/s (baseStep 44 @5Hz) and the leg/body pairing is solved by the restored speed-matched locomotion (`9e3bc63a` restore, see `3dStructure.md` §13). PARITY: server sim + guest-mode UX, no agent-path change.

**Prior Last Audited:** 2026-06-10 (NPC gait sync + icon pill row): (1) **[REVERTED same-day — see entry above]** NPC walk speed raised to the player's 550 wu/s (server `moveNpcs` baseStep 44→110 @5Hz). (2) **Controls + Language are icon-only circles side by side** under the shortened sidebar (Gamepad2 at right:16, Languages glyph at right:68, bottom+12; current language lives in the hover tooltip; popover opens up-left). Language no longer covers the inventory; Controls no longer floats mid-screen at right:260. Sidebar `maxHeight` calc(100vh−72px) → calc(100vh−140px). Mobile placements unchanged. PARITY: visual/UI only.

**Prior Last Audited:** 2026-06-10 (toggle + NPC-mode spawn fixes): (1) **ControlModeToggle fixed at `top-[5rem]` for all modes** — the `isSpectator ? top-[9.5rem]` branch cleared a spectator banner deleted long ago, so the Explore-mode toggle floated 72px low and jumped on mode flip; `top-[5rem]` is the position NPC mode already shipped at (no new overlap surface). (2) **NPC-mode spawn corrected to (5760, 6300)** — town center in front of Nori, same point as `avatarPositionRef`; the old (3840, 3840) was the pre-expansion 7680px-map center, dropping NPC-mode players in an empty southwest field. PARITY: UI/spawn only.

**Prior Last Audited:** 2026-06-10 (`/game` language layer): `<GameLanguageControl>` mounts globally on `/game` and can translate visible game DOM text into the browser locale or a selected locale via `POST /api/i18n/translate`. Scope is page-level UI text (HUD, modals, controls, chat panels, NPC messages as rendered), not an NPC-response-only hook. It skips canvas/script/input internals, preserves original English DOM text in memory, and re-scans mutations as panels/chat appear. Backend translation is OpenAI-backed through the Hono API, not Gemini. PARITY: the surface is mounted outside avatar/agent gates, so guests, humans with avatars, and connected-agent manual-control sessions see the same language control; autonomous agents are unaffected.

**Prior Last Audited:** 2026-06-10 (`/game` controls discoverability + mobile jump): `<TutorialOverlay>` now mounts for every `/game` visitor, and its persistent Controls button opens directly to the movement/run/jump step. Desktop renders the help surface as a compact controls drawer positioned left of the right sidebar so it does not cover the agent/menu panel; mobile keeps a dismissable modal sheet. The intro documents WASD, touch joysticks, Shift run, full-tilt joystick run, Space charged jump, Space quick-sink, and the mobile Jump button. `<MobileControls>` exposes a touch Jump button for `player` and `npc` modes that feeds the existing jump state machine. PARITY: human and connected-agent manual-control paths see the same control reference; autonomous agents remain governed by their action surface.

**Last Audited:** 2026-06-10 (spike cleanup — transport restore + governor + HUD status): (1) **Nine user flows un-404'd:** guest signup (`/api/auth/guest`), forgot/reset-password, send-verification, NPC transient chat (TalkToCharacterBar), shop item purchase/learn, username check/update, avatar fetch/position/appearance, and location agent chat were broken by the 2026-06-08 same-origin fetch change in `lib/api.ts` (no Next routes exist for them) and are restored to routing via `NEXT_PUBLIC_API_URL`. Transport-only — no gameplay-rule change. (2) **World labels / speech bubbles / activity FX can no longer be auto-hidden:** the adaptive governor is capped to ground-cover (seaweed) only; `?fast=1` is the sole, explicit opt-in that hides labels (debug/measurement). (3) **`hudPerfMode` dead constant stripped** from `game/page.tsx` — all 14 HUD surfaces it wrapped render unconditionally again (master structure). (4) **Demo HUD status:** the 2026-06-08 "demo HUD recovery" below is NEW feature work, not a restoration (the Demo Player panel / forced QuestTracker never existed pre-spike) — it remains functionally intact but is **PENDING user sign-off + the mandatory mobile/iPad viewport sweep** (`docs/mobile-ipad-verification.md`) before staging→master promotion. PARITY: all restored flows serve humans (browser+Lucia/guest) and agents (honoRequest/server surfaces) identically to master.

**Prior Last Audited:** 2026-06-08 (demo HUD recovery + auth-state cleanup): `/game` keeps progression HUD surfaces visible before an agent is connected. In no-avatar Explore/NPC mode, `AvatarStatusBar` renders a demo/NPC fallback instead of returning null; `QuestTracker` can be forced visible for the demo/pre-connect surface. The sidebar account row follows `auth-me`: real non-guest auth shows Logout; unauthenticated/guest demo state shows Log In / Sign Up and must not render email-confirmation or logout state. Agent-only Eliza chat, inventory, shop, emote, daily-login, cosmetic, and autonomy controls remain under the connected-agent gate.

**Prior Last Audited:** 2026-06-07 (playable perf rollback): `/game` always keeps the core HUD and screen controls mounted. The 2026-06-06 adaptive fallback that collapsed `NanoClawBanner`, email banner, `SidebarMenu`, `Minimap`, `ControlModeToggle`, `MobileControls`, `NoriButton`, location/activity/status/autonomy/thought-log chrome under tier 4 or `?fast=1` was removed after staging verification showed the game became effectively unplayable. Performance modes are not allowed to hide core game controls in normal play.

**Prior Last Audited:** 2026-06-06 (adaptive world performance mode): when `/game` is launched with `?fast=1` or the world governor reaches tier 4, heavy always-on HUD chrome collapsed (`NanoClawBanner`, email banner, `SidebarMenu`, `Minimap`, `ControlModeToggle`, `MobileControls`, `NoriButton`, location/activity/status/autonomy/thought-log chrome) while modals, toasts, chat surfaces, guest bootstrap, and the 3D canvas remained mounted. This was a performance fallback, not a new gameplay mode; superseded by the 2026-06-07 playable rollback.

**Last Audited:** 2026-06-12 (multiplayer rooms: soft-cap flexible fill, §11z.a): rooms now have a soft cap of 12 (auto-fill target) and keep the hard cap of 20. Auto-fill packs joiners into the FULLEST room still under 12 (cozy clustering, no lone spawns) and mints a fresh room only when every room is at 12; it never seeds the 12-to-20 band. That band is reserved headroom for friends joining a specific room via invite code, which is honored up to 20 (unchanged). Prior **Last Audited:** 2026-06-06 (multiplayer rooms: human/agent co-presence parity + token-leak fix, new §1d): shared rooms (up to 20) now support a connected/hosted agent walking around AS ITSELF (bound avatar, real CT + leaderboard, counted toward the room cap, `kind:'agent'` indicator dot) alongside humans, for full Rule E5 parity on the world surface. Human joins via Lucia cookie, agent via `X-Clawville-Agent-Session` on the same `POST /api/world/join`. Security: the room SSE snapshot now emits only a non-reversible opaque presence `id` (never the raw Lucia bearer/guest fp/agent id), and the stream is gated on room membership. Guests/avatar-less agents now spawn at town center. See ARCHITECTURE.md §6 (world routes) + §13. Prior **Last Audited:** 2026-06-05 (create-agent picker grouping + card fix): (1) chibis (`eliza_chibi`, `milady_chibi`) now appear under the **MILADY** tab, not OpenClaw (they are stylized Milady avatars). (2) The **entire `hatcher` category** (hatcher_1..8 + phanes) is excluded from the picker via explicit per-tab category allowlists in `MODELS_BY_TAB` (milady = `milady`+`chibi`, hermes = `hermes`, openclaw/custom = `openclaw`+`other`); Hatcher avatars are assigned EXCLUSIVELY through Hatcher's own UI/API on register and are never user-selectable. (3) Removed the hardcoded per-card "Milady" pill in `renderCard` (it rendered on EVERY VRM card including Hermes/Tekk, was factually wrong, and covered the face); the tab already states the category. `mapCategoryToTab` now maps `chibi`->milady so returning chibi users land on the right tab.

**Last Audited:** 2026-06-05: **Phanes is the default Hatcher avatar (reserved, not in the picker).** New Hatcher agents now spawn as `phanes`, a bespoke Greek-deity VRM (`DEFAULT_HATCHER_MODEL_KEY` in `@clawville/shared`), instead of a random `hatcher_N` Milady placeholder. Set in `partner-hatcher.ts` (register `resolvedSpecies` + `buildHatcherAvatarValues` `resolvedModel`). Reserved: `pickerHidden:true` on the web registry entry hides it from `/create-agent` (filtered in `create-agent/page.tsx`), and it is excluded from the `pickRandomHatcherModelKey` placeholder pool. Asset `/avatars/phanes.vrm` (Tripo to Mixamo to VRM 1.0, animatorId `hermes-male`; built via the fixed `blender-glb-to-fbx-mixamo.py`). PARITY: agent-only feature (Hatcher avatars are agent-bound; humans unaffected); REAL-CT settlement still binds to the agent's avatar (unchanged).

**Last Audited:** 2026-06-04: **Hatcher register auto-provisions an avatar (Rule E5 parity, §2d).** An identityKey-bound `POST /api/partner/hatcher/agents` now auto-creates a default avatar for the resolved user when they have none, so a fresh Hatcher agent is immediately ledger-capable and can play the Cove for REAL CT (closes the prior `agent_session_has_no_active_avatar` 403). Reuses the canonical agent-avatar shape (`partner-hatcher.ts` `ensureHatcherAvatar` over the pure `buildHatcherAvatarValues`): starting balance = schema default `avatars.clawTokens=100` (NO separate grant, human and `/join` parity, no faucet, >= Cove 5-CT min), `isActive:true`, `agentCategory:'hatcher'`, `harness:'custom'`, render model = assigned `hatcher_N`. Idempotent (one avatar per user; re-register reuses and never re-grants). No-identityKey register unchanged (non-ledger, no avatar). PARITY: human path = avatar at signup (`POST /api/avatars`); agent path = avatar auto-provisioned on signed register; settlement binds to that avatar via `resolveAgentSession` then cove `getSubject`. tsc clean (api); e2e harness 75/75; focused verify 4/4 (`scripts/hatcher/verify-avatar-provision.ts`). Prior **Last Audited:** 2026-06-01 — **Hatcher skill-learning loop + partner-key auth + leaderboard carve-out (Phase C, new §2e).** New partner-gated skill surfaces close the learning loop: `GET /api/skills/manifest.json` (single poll target with per-skill content hashes) + `GET /api/skills/protocol/skill.md` (the stable, token-free connection protocol manual — the three-surface connection-SKILL.md, now a real hashed endpoint, closing the documented infra gap). Both + the 10 per-building `:buildingId/skill.md` reads are gated by a scoped, revocable `partner_api_keys` bearer (`requirePartnerKey('skills:read')`, hash-not-plaintext, show-once mint via `scripts/mint-partner-key.ts`) + a per-PARTNER rate ceiling (60/min keyed on partnerId, not IP). The `clawville-play` meta skill stays PUBLIC (open-onboarding). **Leaderboard carve-out:** partner-key skill fetches tag `via:'partner-import'` and are EXCLUDED from the agent-leaderboard aggregation so a partner re-embedding our manual daily can't farm `skill_md.fetched` rank or trip the 11/day cap. **`/connect` lockdown:** `identityType:'hatcher'` removed from the public connect enum — Hatcher agents register only via the partner-signed path. No new game flow for end-users (a partner integration surface); leaderboard weights unchanged. tsc clean (api + shared + database); migration written, NOT applied. — Prior **Last Audited:** 2026-06-01 — **Hatcher dashboard stats endpoint (Phase B, §2d extended).** New read-only `GET /api/partner/hatcher/agents/:agentId/stats` (partner-signed GET — canonical-challenge ed25519 over method+path+unix-ms with a 5-min freshness window) returns registration + leaderboard (score/rank reusing the public-board scoring) + learning (books/knowledge/quests) + last-20 interactions for the Hatcher per-agent dashboard. Exposes only public values (wallet pubkey ok; scoped cognition token never decrypted/echoed; event payloads secret-key-scrubbed); opaque 404 for missing/non-hatcher rows; 60s per-agent cache; 60/min/IP read limiter. READ-ONLY — no migration. Knowledge surfaces unchanged (no new game flow — a partner-facing analytics read). tsc clean (api + shared). — Prior **Last Audited:** 2026-06-01 — **Hatcher proxy-cognition + partner-registration API (Phase A, new §2d).** Hatcher keeps the agent's brain: new partner-signed `POST/PATCH/DELETE /api/partner/hatcher/agents` registers/updates/removes an agent (Bot Avatar or NPC Override mode), encrypts the scoped cognition token at rest (`openclaw_bots.proxy_token_*`), spawns/overrides the in-world body, binds a user via `identityKey`. Cognition routes through `OpenClawClient.chat()` case `hatcher-proxy` → SSRF-guarded `POST {proxyUrl}/integrations/clawville/agents/{agentId}/chat` with DUAL auth (Hatcher Bearer + our ed25519 sig) and an orientation+world-state system message; fails soft. Two bug fixes shipped same diff: (a) `/api/agent/disconnect` now removes the in-world body (was leaking until restart); (b) building-visit + teacher-chat CT credits now resolve the bound avatar via `bot.userId → avatars.id` (connected agents previously earned NO CT). Knowledge synced (Nori + orientation-skill proxy note). tsc clean (api + shared + database); migration written, NOT applied. — Prior **Last Audited:** 2026-06-01 — Landing page §15 updated: hero fold fix (h-[100svh]), collaboration band relocated below hero, LiveDemoStrip now three live tiles (AgentChatVignette / CoveVignette / BuildingVisitVignette), ReefRaceVignette + BumperShellsPlaceholder removed. — Prior **Last Audited:** 2026-06-01 — **Hatcher agents connect + render (Phase 2, new §2c).** `identityType:'hatcher'` added to `/api/agent/connect` (7th external type); additive `orientation` field on the connect response carrying `CLAWVILLE_ORIENTATION_KNOWLEDGE` so an external agent embeds "you are inside ClawVille" in its own system prompt (Phase 3 swaps it for a manifest URL + content-hash); a connecting Hatcher agent is assigned a RANDOM `hatcher_N` placeholder avatar (new `hatcher` category, backed by the 8 Milady VRMs until Phase 4 repoints the paths) via `pickRandomHatcherModelKey()`, persisted on `openclaw_bots.species` so reconnects keep the same look. Connect does NOT write `avatars.agent_category`; the CHECK + shared `AGENT_CATEGORIES` tuple gained `'hatcher'` (mirror invariant) via `migrations-manual/2026-06-01_add_hatcher_agent_category.sql` so the human/avatars write path can't 500. Knowledge synced same-diff (Nori + orientation-skill connected-worlds line). tsc clean (api + shared). **Prior Last edit:** 2026-06-01 — **Hatcher cross-world portal (partner #2, backend + docs only — new §17f).** Faithful mirror of the 'scape portal: `verifyScapeSignature` generalized to `verifyPartnerSignature(partnerId)` in `apps/api/src/routes/portal.ts`; 4 new endpoints (`POST /api/portal/hatcher` Lucia CV→Hatcher, `POST /api/portal/mint-for-hatcher` inbound user portal via `X-Hatcher-*` signature + the same `principal:clawville:<uuid>` regex, `POST /api/portal/accept-hatcher-link`, `POST /api/portal/hatcher-link-code`); 6 mirror `users` columns (`hatcher_*` + `linked_hatcher_*`) + idempotent migration; `GET /api/avatars/me` surfaces `linkedHatcher*`; new env `HATCHER_HOSTED_SESSION_URL`/`HATCHER_WEB_ORIGIN` + `PARTNER_PUBKEYS.hatcher`. **Cross-partner redemption bug fixed same diff** — both `accept-*-link` handlers now require `pending_account_links.remote_world` to match the partner endpoint. Outbound "Cross to Hatcher" sidebar UI deferred until Hatcher ships their session-issue endpoint. Knowledge synced same-diff (orientation-skill.ts canonical + Nori inline). tsc clean (api). **Prior Last edit:** 2026-05-29 — **Cove verifier back-compat for pre-fix history rows (economy fixer pass #2; drift: `/cove/history/:eventId/verify` deep-equal in `apps/api/src/routes/cove-history.ts`).** The economy fix changed the serialized bytes for blackjack/hold'em (new rake keys) + baccarat banker-win rows (new commission-floored payout/net/commission). The `/verify` deep-equal was unchanged, so PRE-FIX closed rows — staging shares prod's Supabase DB, so they almost certainly exist — would falsely report `verified:false` on perfectly fair, correctly-settled historical hands. Fixed via pure DB-free helpers `blackjackOutcomesMatch`/`holdemOutcomesMatch`/`baccaratOutcomesMatch` (`apps/api/src/services/cove-verify-compat.ts`): bj/th strip the rake keys from BOTH sides when the stored row lacks them; baccarat compares non-monetary fields strictly + accepts payout/net/commission matching EITHER the new OR the old banker-win formula recomputed from the coup's bet/stake/winner. Post-fix + tampered rows still compare strictly. 22 regression tests (`cove-verify-compat.test.ts`); `engineVersion` deliberately NOT bumped (would break shared-shoe nonce-0 replay). tsc clean (api+database); engine tests 148 + verifier 22 green. **Prior 2026-05-29 — Cove casino economy fixes + CT-economy monitor (new §18a.k; drift: §18a.f blackjack + §18a.g hold'em + §18a.j baccarat got HOUSE RAKE / commission-fix notes).** Baccarat banker commission now floors the player's winnings `floor(stake×95/100)` (house-positive at every stake — closed the sub-20-stake faucet); hold'em settle rakes `min(floor(pot×5/100),5)` CT off the pot; blackjack settle rakes `floor(max(0,payout−bet)×5/100)` on net winnings (winners only). All idempotent (computed once under the FOR UPDATE lock, stored in `outcomeJson`, never re-applied on replay); `cove_game_events.payout` carries the post-rake figure. New admin-only `GET /api/cove/economy/summary` (`cove-economy.ts`, FEATURE_GATE `cove_ct_economy_monitor`) aggregates minted/burned/houseNet per gameType + a `faucets[]` alarm. tsc clean (api+database); 146 engine tests green. Plan `.claude/plans/cove-casino-economy.md`. **Prior Last edit:** 2026-05-29 — Phase 6.6.1 REAL baccarat (Punto Banco) engine + ledger + FIRST playable UI shipped (was a sign-only 3D placeholder). New §18a.j. Backend (engine builder): pure deterministic engine `apps/api/src/services/baccarat-engine.ts` (`bac-v1`) — 8-deck no-replacement HMAC commit-reveal shoe over `provable-rng.ts`, the EXACT fixed standard third-card tableau (`bankerDraws`), integer payouts (`settleBet`: Player 1:1, Banker 0.95:1 with floored 5% commission, Tie 8:1, P/B push on tie), pure `replayCoup`/`replayShoeUpToCoup` (55/55 unit tests). One-shot route `apps/api/src/routes/cove-baccarat.ts` mounted at `/api/cove/baccarat` (open/coup/close/current/:id) — coup deals+resolves+settles in ONE `db.transaction` under the shoe `FOR UPDATE` lock (no in-progress window — Punto Banco has no decisions), `claw-token-ledger` the only balance write path, one `cove_game_events` row per coup (`gameType='baccarat'`, `nonce=coupIndex`), idempotent via `(shoeId, idempotencyKey)` partial-unique, payout > MAX_SAFE_INTEGER rejected, currency seam 501 for sol/usdc, guest 100 demo CT. New `baccarat_shoes`+`baccarat_coups` tables (`packages/database/src/schema/baccarat.ts`; migration `scripts/casino/migrate-baccarat-tables.mjs`). `/cove/history/:eventId/verify` extended with the `baccarat` branch (`replayShoeUpToCoup` + `sha256(serverSeed)==hash` + deep-equal). Frontend (this drop): NEW from-scratch `BaccaratModal` + `BaccaratCard` (copied from `BlackjackModal`), server-authoritative (no client shoe/tableau/payout math) — P/B/T bet selector + stake chips (5–500) + single Deal + result reveal (natural badges, winner-side highlight, commission note, push handling), fairness commit/reveal + `/cove/history` deeplink, `AgentModeBar` Control(advise)/Autonomous(gated) with FEATURE_GATE `baccarat_autonomous_agent_mode` (deadline 2026-07-15). NEW `apps/web/src/lib/cove/baccarat-api-client.ts` (`useOpenBaccaratShoe`/`usePlayBaccaratCoup`/`useCloseBaccaratShoe`/`fetchCurrentBaccaratShoe`/`fetchBaccaratShoe` + `reshuffledBody` + `describeBaccaratError`). NEW shared `packages/shared/src/types/cove-baccarat.ts` wire types one-shape with engine+route. NEW `BaccaratTableHotspot` in `cove-interior.tsx` at `[285,100,584]` (invisible `boxGeometry`, `matrixAutoUpdate=false`, mirror of the blackjack/holdem hotspots). `useCoveStore` baccarat slice (`baccaratOpen`/`baccaratBet`/`openBaccaratTable`/`closeBaccaratTable`/`setBaccaratBet`). `<BaccaratModal />` mounted in `/cove/page.tsx`; cove subtitle → "Slots · Blackjack · Hold'em · Baccarat". Three-surface sync: Nori `knowledge[]` + `CLAWVILLE_ORIENTATION_KNOWLEDGE` updated with real Punto Banco rules/payouts/provably-fair/agent-modes; Connection SKILL.md protocol content authored in the knowledge surfaces with the documented infra-gap TODO (global endpoint ships with the connected-agent protocol drop). **Prior Last edit:** 2026-05-28 — Phase 6.5.1 REAL No-Limit Texas Hold'em engine + ledger shipped. §18a.g rewritten from the 6.5.0 mock to the server-authoritative engine: in-house 7-card evaluator + HMAC per-hand deck shuffle (`apps/api/src/services/holdem-engine.ts`, `th-v1`), five deterministic bot personalities (tag/lag/tight-passive/calling-station/nit), correct side-pots, poker STACK custody (buy-in debit at open → chips move in `playerStack` per hand → cash-out credit at close) via `claw-token-ledger`, idempotent settle under a table `FOR UPDATE` lock + `(tableId, idempotencyKey)` partial-unique. New tables `holdem_tables` + `holdem_hands` (migration `scripts/casino/migrate-holdem-tables.mjs`); one `cove_game_events` row per hand (`gameType='holdem'`); `/cove/history/:eventId/verify` extended with the `holdem` replay branch. Web `HoldemModal` REWIRED from the mock reducer to the real `/api/cove/holdem/*` flow (new `holdem-api-client.ts`; deleted `holdem-mock-engine.ts`); server-authoritative rendering (no client deck/eval/pot math); real fold/check/call/bet/raise + slider + All-In; `AgentModeBar` Control(advise)/Autonomous(gated) with FEATURE_GATE `holdem_autonomous_agent_mode` (deadline 2026-07-15). Shared `cove-holdem.ts` retired the mock surface for the real wire types; `COVE_HOLDEM_DEFAULT_BUYIN` 1000→100, blinds 1/2, buy-in 20–500. Three-surface sync: Nori `knowledge[]` + `CLAWVILLE_ORIENTATION_KNOWLEDGE` updated with real NLHE rules/bots/agent-modes; Connection SKILL.md protocol content authored at `.claude/plans/cove-texas-holdem.md §11` (global endpoint still the documented infra gap → 6.5.2). **Prior Last edit:** 2026-05-28 — Phase 6.7.5 guest cove history added. `/cove/history` no longer Lucia-gated; unauthenticated visitors see their own browser's history scoped server-side by `guest_fp_hash` (sha256(FINGERPRINT_SECRET || raw_fp) — never reversible, never seen by the client). New `POST /api/cove/history/claim` (Lucia-authed) migrates guest rows to the new user on signup — wrapped in `db.transaction` so `cove_game_events` and `slot_sessions` flip atomically. Signup hook on `/login?mode=signup` calls claim, stashes the toast message in `sessionStorage`, and `<CoveClaimToast>` (mounted in `Providers`) surfaces it after the redirect. Demo balance (100 fun CT seeded at guest-session open) lives entirely inside the slot session row and does NOT convert to real ClawTokens — only the audit/history rows survive signup. Read paths (GET `/`, GET `/:eventId`, GET `/:eventId/verify`) resolve the caller as user OR guest via `resolveSubject(c)`; owner check on `/verify` now compares the matching subject (user_id for authed, guest_fp_hash for guests). Admin bypass on `/:eventId` + `/verify` unchanged for dispute support. Plan: `.claude/plans/cove-guest-history.md`. New §18a.i covers the user-facing flow. **Prior Last edit:** 2026-05-27 — Phase 6.7.0 UI: Game History page + per-event verifier routes added (impl-ui). `/cove/history` — server-component auth-gate (Lucia redirect to /login if unauthed), then client-side `HistoryTable` with `HistoryFilterBar` (game-type chips in cyan/red/silver/blue matching cove signs + win/loss filter chips), `HistoryRow` (expandable drawer shows outcomeJson, serverSeedHash, revealedServerSeed with "shoe still open" badge when null, Verify deeplink), infinite scroll via `useInfiniteQuery` against `GET /api/cove/history`. `/cove/verify/[eventId]` — runtime dispatch: `gameType==='slots'` renders `SlotsEventVerifier` (fetches event row, runs `replaySpin` + sha256 commitment check from existing `apps/web/src/lib/cove/verifier.ts`, green check or red flag + divergence reasons); other game types show Phase 6.7.X placeholder. New API client at `apps/web/src/lib/cove/history-client.ts`. Prior 2026-05-27: Phase 6.7.0 cove cross-game history scaffold + slots integration. New §18a.h documents the unified history surface across all four cove games. Backend: `/api/cove/history` route mounted (`GET /` owner-only keyset-paginated list, `GET /:eventId/verify` owner-or-admin engine-replay) and the slot-spin write integration that records every spin to `cove_game_events` in the SAME transaction as `slot_spins` (revealed seed back-filled on `/session/close` so the commit-reveal hash chain becomes verifiable). Slots is the first game wired; blackjack/hold'em/baccarat join in 6.7.1/6.7.2/6.7.3 once their server-authoritative engines ship. **Prior Last edit:** 2026-05-27 — Phase 6.5.0 Texas Hold'em visual shell added to the cove. New §18a.g covers the 6-seat felt at the second poker table (mirror of the blackjack station at X=294, Z=335), the deterministic 5-bot opposition, the `HoldemTableHotspot` + `BankBanner` ("TEXAS HOLD'EM", `#22dd88`) rendered in `cove-interior.tsx`, the `useCoveStore` Hold'em slice (`holdemModalOpen`, `holdemBuyIn`, `openHoldemTable(balance)`, `closeHoldemTable()`), the `HoldemModal` mount in `/cove/page.tsx`, and the mock backend route `POST /api/cove/holdem/play-mock-hand`. Cove subtitle bumped to "Slots · Blackjack · Hold'em". Phase 6.5.0 is display-only (no engine, no ledger writes, no real-money escrow). Phase 6.5.1 vendors pokerpocket + bot personalities + ClawToken ledger; 6.5.2 ships the connected-agent WebSocket protocol + multi-human seats + Hold'em Connection SKILL.md + hosted-agent skill memory; 6.5.3 lobby + tiered tables; 6.5.4 real-money via wager program; 6.5.5 polish + BB/100 leaderboard. **Prior Last edit:** 2026-05-27 — Free-wanderer roster restored to full 14-NPC cast (8 Milady + 3 Hermes + 2 chibi + 1 lobster). Was trimmed to 9 in `fb982d8b`; user asked for the original 8-Milady ensemble back. Added aria/suki/hana/yumi/ren using milady_official_1/3/4/5/6 paths (every VRM path unique, per the vrm-loader single-instance cache rule). Home positions chosen to fill the gaps between existing 9 around the FREE_ROAMER annulus. `WANDERING_VRM_PATHS` preload list, `arena-npcs.tsx` preloads, and `stores/npc.ts` DEMO_NPCS list all updated same diff. **Prior Last edit:** 2026-05-26 — Two fixes: (1) Free-roaming NPC wander annulus restored to 1500-3200 wu (was 900-2400 in `cf1feb96`, which let `planApproachNearbyNpc` chain-drag every wanderer into a pile-up at the town directory sign). Approach probability dropped 0.50 → 0.20, stand-off radius 250 → 400 wu, and both planners now reject candidate stand-off points that fall outside the FREE_ROAMER annulus so converging approachers can never drift into the inner town-center prop zone. NPCs currently outside the annulus force-wander instead of approaching, so once the cluster breaks it stays broken. (2) `SeaLoadingScreen` re-gated on `window.__W3D_READY` (canvas first-frame AND `StaggeredTextureUpload` complete) instead of `window.__W3D` (canvas only) — restored the texture-readiness gate that was reverted in `1ffc40a8`. Eliminates the blue/blank world flashed between overlay dismissal and full texture availability. **Prior Last edit:** 2026-05-25 — §18a.f blackjack table rewritten for Phase 6.4.0 interactive-shell fix: client-side deterministic mock deck walks bet → deal → hit/stand → dealer playout → outcome (state machine). `BlackjackCard` readability pass (light face + dark suits/ranks, red for hearts/diamonds). `BlackjackModal` adds explicit per-phase action surface and a visible WALK AWAY button after `resolved`. Server route `POST /api/cove/blackjack/play-mock-hand` no longer driven from the UI — kept as a stub for 6.4.1 evolution. Prior: 2026-05-21 — §18a.c casino slot entry: E-key proximity interaction + bank labels. Two `WorldLabel` labels ("Classic" / "Bonus") float above left-wall slot banks; bio-capsule style (Fraunces serif, glow shadow). Within 250wu: "press E to play" subtext appears. Within 200wu: pressing E opens the slot screen with the correct paytableId (`classic-3x5` or `classic-3x5-bonus`). `SlotHotspot` click path preserved as fallback. AABB collision prevents walking through cabinets and dealer station (4 cabinet boxes + dealer box, slide-push, zero allocs). Prior: 2026-05-20 — Landing + loader cleanup: removed the "Launch Your Agent Token (Coming Soon)" CTA + section + nav pill from `apps/web/src/app/page.tsx` entirely (pre-pivot artifact; marketplace pivoted to free leaderboard 2026-04-21 per Brand Identity). Tightened SiteHeader chrome — "How It Works" + "Leaderboard" demoted from wide text pills to icon-only 40×40 round buttons matching the X/Telegram/Web/Discord squares (header now: 1 CA pill + 6 uniform icons). Game `SeaLoadingScreen` (`apps/web/src/components/game/sea-loading-screen.tsx`) animation now loops infinitely on a single 7s `claw-avatar-loop` keyframe combining drop + splash + sink + reset; splash rings loop on the same 7s period aligned to the surface hit. Shimmer bar replaced with a width-fill progress bar driven by an eased simulated curve `1 - exp(-t/3500ms)` capped at 0.92 until `window.__W3D` fires (real ready signal), then snaps to 100% and fades. `role="progressbar"` + `aria-valuenow` added. 30s force-dismiss now also snaps progress to 100% so the bar isn't frozen at 92% during fade. Prior: 2026-05-19 — Concern 6.1.5 (Bundle B bonus mechanics): new `classic-3x5-bonus` paytable layered on top of the shipped `classic-3x5` engine — 11 symbols (id 10 = Treasure Chest scatter, `themeColor '#ffd778'`, pays anywhere on 5×3 grid for count ≥ 3 at 2×/10×/50× total predict). 3+ scatters award **10** free spins (`AWARD_BASE`); 3+ scatters during FS award **+5** (`AWARD_RETRIGGER`), capped at **50** unspent (`CAP_REMAINING`). Free spins consume no predict (debit skipped on FS path; `totalStaked` unchanged). Every landed WILD draws a 2×/3×/5× multiplier (60/30/10 cum, drawn via `sampleIntFromBytes(range=100)` per landed wild — cursor advances per draw). **RTP-shape lock (team-lead decision):** wild multipliers apply to line wins **only in FS mode** (base records the chip but does NOT amplify); FS does NOT additionally double line wins or multiplier values — `FS_LINE_WIN_MULTIPLIER=1`, `FS_WILD_MULTIPLIER_DOUBLE=false`. Spec-literal doubling (both flags on) measured 126% combined RTP at 30k MC, unshippable; current flags land 100k MC at **96.38% combined** inside strict CI band `[95.5%, 99.5%]` and ~1 trigger per 90 base spins. Value to the player in FS: spins are free + multiplier wilds at 2/3/5× still apply + scatter pay-anywhere still fires on retrigger. Engine surface adds `WildMultiplier`, `SpinResult.wildMultipliers`/`scatterPayout`, `RunSpinArgs.freeSpinMode?`. Wire types add `SerializedWildMultiplier`, `SpinResponse.mode/freeSpinsRemaining`. Session state machine in `slot_sessions.mode` + `free_spins_remaining` (already in schema). Route `/spin` derives `isFreeSpinSpin` from session pre-lock snapshot, FOR-UPDATE re-check 409s if mode changed mid-flight. `/session/open` accepts both paytables; `/paytables/:id` returns both; `/verify` accepts both. Frontend asset: `apps/web/public/assets/slot-symbols/s10.svg` (Treasure Chest), `CLASSIC_SLOT_SYMBOL_ASSETS[10]`. Tests: 67/67 engine pass (25 new Bundle B tests including `wildMultiplierForDraw` mapping, scatter line-break, multiplier products, FS vs base equivalence, distribution sanity); 4 new DB-gated route tests for the FS state machine + retrigger cap. RTP sim `--paytable classic-3x5-bonus` flag + new CI gate step in `rtp-gate.yml` enforcing `[0.955, 0.995]`. Plan §6.5 updated same diff. Prior: Concern 6.1.8 (rename): casino slot wire field `bet` → `predict` end-to-end to align with "Predictive Gaming Cove" public framing. DB column `slot_spins.bet` renamed to `slot_spins.predict` via single-statement migration at `packages/database/migrations-manual/2026-05-19_rename_slot_spins_bet_to_predict.sql`. Drizzle schema, Hono Zod schemas (request + response), engine `RunSpinArgs.predict`, route variables, error codes (`predict_must_be_positive`, `predict_exceeds_supported_range`, `predict_must_equal_session_reserved_predict`, idempotency-cache mismatch `cached predict=X, new predict=Y`), tests, frontend client (`OpenSlotSessionArgs.predict`, `SpinArgs.predict`, `SpinResponse.predict`, `VerifySpinArgs.predict`), verifier (`runSpinLocal({...predict})`, `perLinePredict`), HUD (`PREDICT_CHIPS`, "PREDICT" label, `cv-predict-chips-wrap` class), UI component `BetChips → PredictChips` (file + class + props cascaded), CLI flag `--bet → --predict` in `scripts/casino/rtp-sim.ts`, all docs updated same diff. Engine math UNCHANGED — `runSpin` outputs byte-identical pre/post for the same inputs. Prior: Concern 6.1.6 + 6.1.7 (slice 5): **Phase 6.1 fully LIVE end-to-end for ClawTokens.** The slot UI now talks to the real `/api/casino/slots/*` backend — open / spin / cash-out — and the mock engine has been deleted. Every spin is recorded server-side with provably-fair commit-reveal; the player can replay every spin in a closed session via the new `/casino/verify` page (anonymous manual replay) or `/casino/verify/<sessionId>` (auth-gated owner-only, runs the whole session through a browser-side WebCrypto port of the server's HMAC-SHA256 engine and shows green/red verdict per spin). The slot screen now shows a 🔐 fairness chip with the committed `serverSeedHash` and a deeplink to the per-session verifier; cashing out reveals the seed in-line. Bet chips changed to [20, 40, 100, 200, 500, 1000] ClawTokens (must be a multiple of 20 paylines per slot-engine guard). Casino interior gets a top-right "🔐 Verify" link to the manual verifier. Browser-side test suite at `apps/web/src/lib/casino/__tests__/verifier.test.ts` (20 tests, all green) re-uses slice-1 hand-computed RNG fixtures to prove byte-identity between WebCrypto and Node `crypto`. Toast layer handles 4xx + 501 (SOL/USDC "coming in Phase 6.2"). Prior: Concern 6.1.5 (slice 4): Monte Carlo RTP CI gate. Slot `classic-3x5` paytable RTP officially **96.00%** (analytic over uniform-stop sampling) / **95.89%** (empirical, 1M-spin Monte Carlo on fixed seed). Strip length retuned 80→84 with composition (Cherry×22 + Lemon×22 + Orange×14 + Plum×14 + Bell×7 + 1× each of BAR/Seven/WILD/BAR×2/BAR×3) per reel; payout multipliers unchanged. `scripts/casino/rtp-sim.ts` runs 1M spins in ~11s; `.github/workflows/rtp-gate.yml` enforces RTP ∈ [95%, 97%] on every PR touching `slot-paytables.ts`/`slot-engine.ts`/`provable-rng.ts`. Acceptance band per plan: ±0.5% of 96.00% (= [95.50%, 96.50%]). Prior: Concern 6.1.3 + 6.1.4 (slice 3): fun-money casino slots backend LIVE for ClawTokens. New `/api/casino/slots/*` route group — `session/open` (commit publishes `serverSeedHash`, reserves bet), `spin` (idempotency-key required, 60/min/user rate limit, atomic txn debit+spin+credit), `session/close` (reveals `serverSeed`, refunds escrow), `paytables/:id` + `verify` (both public, pure compute). New tables `slot_sessions` + `slot_spins` with partial unique index for one-open-session-per-user + per-session idempotency-key uniqueness. SOL/USDC stubbed at 501 until Phase 6.2 custody. Frontend mock (`apps/web/src/lib/casino/mock-engine.ts`) still live until slice 5 swap. Prior: Concern 6.1.2: backend slot engine landed (`apps/api/src/services/slot-engine.ts`, deterministic, 40+ tests, bigint payouts). Prior: Concern 6.0.4 polish pass: Slot UI redesign. New design-token system (`casino-tokens.css`), `useFX` 5-tier FX state machine, NeonButton/NeonCard/NeonModal/BetChips UI primitives, SVG symbol art (Kelp/Anchor/Shell/Pearl/Coin/Crab/Trident/Lobster) replacing emoji, coin+confetti particle bursts, mega-win screen flash + 3s lockout, prefers-reduced-motion honored. SpinResult contract untouched. Prior: Concern 6.0.5 — walkable interior. Prior: Concern 6.0.4 — 2D slot screen (mock data).

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

### 1d. Multiplayer rooms: human/agent co-presence (Phase 1; agent parity 2026-06-06)

The open world runs as shared rooms (auto-fill to a soft cap of `ROOM_SOFT_CAP_PLAYERS = 12`, hard cap `ROOM_MAX_PLAYERS = 20` via 4-char invite code for friend groups). Everyone in a room sees everyone else move in real time over the `/api/world/:roomId/stream` SSE feed; a wandering NPC is swapped out to make space when a player joins and restored 5s after they leave. **Full human/agent parity (Rule E5):** a connected or hosted agent can be co-present in the SAME room as a human, walking around AS ITSELF (its own bound avatar with real name/species/position), counted toward the room cap, swap-eligible, and earning real ClawTokens + leaderboard credit, NOT an anonymous guest. A human joins via the site (Lucia cookie); an agent joins the same `POST /api/world/join` route with its `X-Clawville-Agent-Session` header (validated by `validateLiveAgentSession`). Each presence carries a `kind: 'human' | 'guest' | 'agent'`; `kind === 'agent'` shows the connected-agent indicator dot in the 3D layer. **Security:** the room snapshot never carries any session's raw token, only a non-reversible opaque presence `id` (server-derived `publicId`), and the SSE stream is gated on room membership (a non-member gets 403). Full wire shape + auth model: `ARCHITECTURE.md §6` (world routes).

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
| `agentPaired` | boolean | **Reload-survivable** "this user has a connected agent" (Codex finding #2, 2026-06-12). Derived from `/me/agent-session` on game-page mount via `setAgentPaired(true)`; carries **NO bearer**. Drives every paired INDICATOR (Bot-Training pill, Controlled/Autonomous toggle, cove autonomous availability). Distinct from `agentSessionId` — see paired-vs-bearer note below. |
| `agentConnected` | boolean | UI gate — the convenience union "paired AND/OR holds a live bearer." Set true whenever `agentPaired` is true (with or without a bearer). UI consumers read it as "is paired"; **bearer paths MUST AND it with `agentSessionId`** (they do — `avatar-chat-bar`, `use-location-chat`). |
| `agentSessionId` | string \| null | The **live agent-session bearer**. Set ONLY by the in-session connect-token polling success path (`setAgentConnection(sessionId)`), the single flow that actually receives a bearer. The server emits the bearer **exactly once at connect and never re-emits it**, so this is **null after any reload** — `setAgentPaired` forces it null by construction. Cleared on disconnect + on a dead-session stale-clear (reconnect-UX note below). |
| `agentConnectModalOpen` | boolean | UI flag for the modal |
| `hasAgent` | boolean | Mirrors agentConnected; legacy field name still used in some store actions |
| `hatcherSpectate` | boolean | Legacy spectate-exemption flag from the pre-2026-06-15 "owner watches in explore" launch. The controlled-mode launch (§2f) NO LONGER sets it — it lands in `'player'` and explicitly clears it. Still present + read by the explore→player promotion guard and `setAgentPaired`'s `keepSpectate` branch (both treat `false` as "promote/embody normally"), so the controlled handler defensively zeroes it to defeat a stale `true` from a prior launch in the same session. Cleared by any explicit `setControlMode`. |
| `hatcherLaunchBannerActive` | boolean | True while `HatcherLaunchHandler`'s bottom-center failure/relaunch banner is showing (mirrored from its `banner` state via effect; cleared on unmount). Drives the email-banner mutual exclusion — `<EmailVerifyBanner>` suppresses itself while this is set so the two bottom-center surfaces never stack/occlude. Added 2026-06-12. |
| `cameraFocusRequest` | `{x,y}\|null` | One-shot explore-camera focus point (game coords). Set via `requestCameraFocus`, drained by `WASDCameraController` (`consumeCameraFocus`). Used by §2f to centre the camera on the launched agent's body. |

**Reconnect UX on a dead agent session (2026-06-12, regression D2 fix).** When a chat send through a connected agent hits a dead session (server dropped it on restart/deploy/expiry → `agent_session_not_found` / 404), `avatar-chat-bar.tsx` calls `setAgentConnection(null, { keepEmbodied })`. The avatar belongs to the **USER**, not the agent session, so a still-authenticated **non-guest owner with an avatar stays embodied**: `controlMode` holds at `'player'` (camera keeps following, `<PlayerAvatar>` stays mounted) and only the agent-specific state clears (`agentConnected`, `agentSessionId`, Bot-Training pill, autonomous mode → manual `player`). A **guest or avatar-less** user still falls back to `'explore'` as before. Race-safe: if the shared `['auth-me']` cache hasn't resolved when the clear fires, we DEFAULT to keeping the body (the user is mid-game with an avatar) and let `game/page.tsx`'s auth-sync effect reconcile once auth loads. `keepEmbodied` is the gate, and the chat-bar derives it from the REAL avatar object + auth state (`!!avatar && (!authFetched || (user && !user.isGuest))`). `setAgentConnection` does NOT re-derive embodiment in the store: the store doesn't hold the avatar object (React Query `['avatar']` is the source of truth), and its `avatarName` field is left `''` by every `setAvatarAppearance` call site, so a store-side AND-gate on it would be a silent no-op that never keeps anyone embodied (a first attempt did exactly that — green build, dead fix; caught in audit). The caller owns the decision. `<AvatarChatBar>` is mounted for any embodied avatar-owner in `player`/`autonomous` (gate widened from `agentConnected`-only) so its in-panel "Agent session ended — reconnect your agent" banner survives the clear and the user can keep chatting with their own avatar via the non-agent `api.sendAvatarChat` path; the agent-only progression/shop surfaces still gate on `agentConnected`. Before this fix the clear cascaded `controlMode → 'explore'`, which hard-unmounted the live avatar ~1s after the user sent a message (partner-reported "avatar vanished mid-game").

**Paired vs live bearer — reload behavior (2026-06-12, Codex finding #2).** Two store states are deliberately split and must never be conflated:

- **`agentPaired`** — survives a reload. The game page hydrates it from `GET /api/auth/me/agent-session` on mount via `setAgentPaired(true, agentId?)`, which sets `agentPaired=true`, `agentConnected=true`, `hasAgent=true`, embodies the owner in `'player'`, and forces **`agentSessionId=null`**. It drives the paired indicators (Bot-Training pill, Controlled/Autonomous toggle, cove autonomous availability). It is NOT a bearer; the optional `agentId` is diagnostics-only.
- **`agentSessionId`** — the live bearer, set ONLY by the in-session connect flow (`setAgentConnection(sessionId)` from the connect-token poll). The server returns the bearer **exactly once at connect and never re-emits it** (hard security invariant), so `/me/agent-session` cannot hand the browser one — the browser can only hold it in the same session that performed the connect. It is null after any reload.

The agent-bearer chat path gates on `agentConnected && agentSessionId`, so after a reload (bearer null) `<AvatarChatBar>` falls back to the authed `api.sendAvatarChat` and shows a quiet "Chatting with <avatar> — reconnect your agent to chat as it" affordance. **The previous bug:** the reload effect passed the server's `agentId` into `setAgentConnection()` as if it were the bearer; the next avatar chat sent `agentId` as `sessionId` → `404 agent_session_not_found` → the connection cleared ~1s after every reload (the partner's recurring symptom). The split makes the "paired but no bearer" reload state explicit and removes any path that fabricates a bearer. Genuine owner-driven agent chat after reload would need a real owner-safe re-acquire endpoint — out of scope; the only way to chat AS the agent again is to re-run the in-session connect flow. The server-says-disconnected branch calls `setAgentPaired(false, null, { keepEmbodied })`, applying the same owner-embodiment guard as the dead-session clear above. Files: `stores/game.ts` (`agentPaired` + `setAgentPaired`), `app/game/page.tsx` (hydration effect), `avatar-chat-bar.tsx` (paired-no-bearer affordance).

### 2b. Timing constants

- Connect token TTL: 5 minutes (`agent-gateway.ts`)
- Connect-status polling: 2-second interval (frontend `agent-connect-modal.tsx`)
- Agent-orchestrator auto-stop after inactivity: 30 minutes (`agent-orchestrator.ts`)

### 2c. Hatcher agents connect + render (partner #2, 2026-06-01)

Agents from the [Hatcher](https://hatcher.host) hosting platform connect through the **same universal `/api/agent/connect`** path — no separate endpoint. Two seams (`.claude/plans/hatcher-integration.md` §3 + §5):

- **`identityType: 'hatcher'`** — a 7th identity type on the connect schema, mirroring the other external types. It rides the existing perception/action surface (move, chat, visit-building, activities); the only behavioural difference is the render model below.
- **`orientation` field on the `/connect` response** — every connecting agent (not just Hatcher) now gets a canonical "you are inside ClawVille" payload (`{ text, factCount, source, note }`, sourced verbatim from `CLAWVILLE_ORIENTATION_KNOWLEDGE` in `packages/shared/src/constants/orientation-skill.ts`). An external agent — which brings its own model and gets **no** server-side Eliza runtime for its chat — embeds this in its own system prompt so it acts as a ClawVille agent. Additive, non-breaking. _Phase 3 swaps the inline text for a manifest URL + content-hash so agents poll-and-diff instead of re-reading the full body each connect._
- **Random placeholder avatar** — a connecting Hatcher agent (with no explicit `species`) is assigned a **random `hatcher_N` render model** (`pickRandomHatcherModelKey()` in `@clawville/shared`). The new **`hatcher` avatar category** is backed by the 8 Milady Official VRMs as PLACEHOLDER art (web `MODEL_REGISTRY` maps `hatcher_N → /avatars/milady-official-N.vrm`); Phase 4 repoints those paths to bespoke Hatcher VRMs with no connect-logic change. The model is carried via `openclaw_bots.species` (the connected-agent render surface) and **persisted**, so a returning Hatcher agent keeps the SAME avatar across reconnects rather than re-rolling. The connect flow does **not** write an `avatars.agent_category` row (only the human/`/join` paths do), so no per-agent DB write changes.

See `ARCHITECTURE.md §6` for the endpoint table + identity types, and §9 for the avatar registry.

### 2d. Hatcher proxy-agents register + play (partner #2, Phase A — 2026-06-01)

The primary Hatcher integration (`.claude/plans/hatcher-integration.md` §13/§14): **Hatcher keeps the agent's brain.** Instead of the agent pulling our perception and driving itself, Hatcher registers the agent in ClawVille on its behalf, ClawVille spawns the in-world body, and when the agent needs to speak ClawVille **calls back to a Hatcher-managed per-agent proxy** for cognition. ElizaOS remains the memory/skill substrate; cognition is the agent's own brain via Hatcher (consistent with the bring-your-own-brain connect pattern, not an ElizaOS violation).

- **Registration API (`/api/partner/hatcher/agents`)** — partner-signed (`X-Hatcher-Issuer-Pubkey` + `X-Hatcher-Signature` = ed25519 over the raw body, verified against `PARTNER_PUBKEYS.hatcher`; no human login). `POST` registers/upserts an agent (mode **Bot Avatar** = a new in-world body, or **NPC Override** = take over a roaming brand NPC), provisions a custodial wallet, spawns the body, and binds a ClawVille user when an `identityKey` is supplied. `PATCH` updates name/species/personality/mode and rotates the cognition token, propagating to the LIVE spawned entity. `DELETE` removes the in-world body and tombstones the row. The scoped Hatcher token is **encrypted at rest** and never returned in any response.
- **Avatar auto-provision (Rule E5 parity, 2026-06-04).** An identityKey-bound register now also AUTO-PROVISIONS a default avatar for the resolved user if they have none, so a fresh Hatcher agent is immediately ledger-capable and can play the Cove for REAL ClawTokens (previously it hit a 403 `agent_session_has_no_active_avatar` because no avatar existed to bind real-CT play to). The auto-created avatar matches the human and `/join` agent shape exactly: the starting balance is the schema default `avatars.clawTokens = 100` (NO separate grant, same as a human at signup, so no faucet and >= the Cove 5-CT min bet), `isActive: true`, render model = the assigned `hatcher_N` (`agentCategory: 'hatcher'`, `harness: 'custom'`). It is **idempotent**: one avatar per user (UNIQUE `avatars.user_id`); a re-register reuses the existing avatar and never mints a second one nor re-grants CT. A register WITHOUT an `identityKey` is unchanged (no user, no avatar, intentionally non-ledger). The response carries `avatarProvisioned`.
- **Cognition callback** — when a Hatcher agent speaks, `OpenClawClient.chat()` POSTs an OpenAI chat-completions body to `{proxyUrl}/integrations/clawville/agents/{agentId}/chat` with DUAL auth (Hatcher's scoped Bearer token + our ed25519 signature). The system message is the ClawVille orientation + a live world-state snapshot of the agent's body, so the Hatcher brain plays in-context. The proxy URL is SSRF-guarded (https + allowlisted Hatcher host). On any proxy error/timeout the turn fails soft (the agent just doesn't speak that turn).
- **Earning CT** — Phase A also fixed a bug where connected agents never earned ClawTokens for building visits / teacher chats (the credit targeted the wrong id). Connected agents bound to a ClawVille user now earn +1 CT per building visit and per teacher-chat turn, same as everyone else.
- **Dashboard stats (`GET /api/partner/hatcher/agents/:agentId/stats`, Phase B — 2026-06-01)** — a read-only per-agent surface for the Hatcher-side dashboard (their ask #5: registration status, avatar identity, mode, quests completed, books learned, rank, recent interactions). Partner-signed GET: since a GET has no body, Hatcher signs a canonical challenge `clawville-partner-get\nGET\n<path>\n<unix-ms>` with `X-Hatcher-Signature` + `X-Hatcher-Timestamp` (5-min freshness window for replay defence), verified against `PARTNER_PUBKEYS.hatcher`. The response carries: **registration** (raw agentId, name, mode, species/avatar model, cognition backend, wallet PUBKEY, active flag, last-seen, total sessions), **leaderboard** (score + rank + the contribution breakdown, reusing the SAME public-leaderboard scoring so the dashboard matches `/leaderboard`), **learning** (books learned, knowledge-chunk count, quests completed — quests only when the agent is bound to a ClawVille user via `identityKey`), and **recentInteractions** (the agent's last 20 in-world events). It exposes ONLY public values — the scoped Hatcher cognition token is never decrypted or echoed; a Hatcher key can only read its own agents (opaque 404 otherwise).

### 2e. Skill-learning loop + partner-key auth + leaderboard carve-out (partner #2, Phase C — 2026-06-01)

The skill-learning loop lets a partner's agents keep their imported ClawVille knowledge fresh (`.claude/plans/hatcher-integration.md` §4). Two new surfaces + a scoped auth layer:

- **Manifest poll (`GET /api/skills/manifest.json`)** — a single target a partner polls every 6–24h. Returns the `protocol` + `orientation` + each of the 10 building skills with a **content hash** (`sha256:<hex>`, computed live from the served markdown + 60s cached). The partner diffs each hash and re-fetches + re-embeds ONLY what changed (vs re-reading every body each poll).
- **Protocol manual (`GET /api/skills/protocol/skill.md`)** — the STABLE, token-free "how to connect + play" manual (connect → perceive → act → learn → stay-alive → disconnect). **This is the three-surface connection-SKILL.md surface** (CLAUDE.md game-flow rule, surface #2) and it now exists as a real hashed endpoint — closing the long-documented infra gap. The per-token magic-link connect block stays dynamic on `/api/agent/connect-skill?token=…`. A `protocol.contentHash` change is EAGER (re-embed before the next play session); building-skill changes are LAZY.
- **Partner API keys** — the manifest, protocol, and the 10 per-building `:buildingId/skill.md` reads are gated by `requirePartnerKey('skills:read')`: a scoped, revocable bearer minted by `scripts/mint-partner-key.ts` (shown ONCE, only its sha256 hash stored — no recovery path, mirror of the wallet-secret rule). A partner is revoked via `partner_api_keys.revoked_at` without touching the ed25519 `PARTNER_PUBKEYS` allowlist the portal/registration surfaces use. The `clawville-play` meta skill stays PUBLIC (open-onboarding brand priority). Rate ceiling: 60/min keyed on the validated **partnerId** (not IP — a partner egresses all its agents from one IP).
- **Leaderboard carve-out (anti-farm)** — a skill fetched via a partner key tags its `skill_md.fetched` event `via:'partner-import'`, and the agent-leaderboard aggregation EXCLUDES those rows. So a partner re-embedding our manual daily can neither farm `skill_md.fetched` rank nor trip the 11/day skill-fetch cap. Organic in-world/browser fetches (no `via` tag) still count exactly as before — the leaderboard weights are unchanged.

End-users are unaffected: this is a platform-integration surface. Normal play still reaches the 10 building skills through the session-authed `/api/agent/:sessionId/skills/:buildingId/skill.md` mirror after the avatar owns the curriculum (§4).

### 2f. Hatcher launch entry — owner CONTROLS their agent (partner #2, controlled-mode shipped 2026-06-15)

The owner-side entry point: Hatcher's dashboard "Launch" button opens `https://clawville.world/game?hatcher_agent=<agentId>&hatcher_launch=<launchToken>` (the QUERY-string form is Hatcher's current PROD output and is **fully supported**) so the human who hosts the agent on Hatcher can drop into ClawVille and **drive their agent's avatar** (controlled mode — the shipped deliverable; the earlier "watch / spectate / autonomous-first" framing was superseded 2026-06-15). The portal flow (`POST /api/portal/mint-for-hatcher`) logs the owner into **the agent's bound ClawVille user** via a magic-link session BEFORE the redirect, so the launch lands authenticated AS the agent's owner and the avatar the owner drives IS the agent's avatar.

**The handler now accepts the grant from BOTH the query string AND the URL fragment, PREFERRING query (FIX-1, 2026-06-13 — supersedes the 2026-06-12 fragment-only contract).** Hatcher's deployed PROD dashboard emits the grant on the QUERY string (`/game?hatcher_agent=…&hatcher_launch=…`); a fragment-only reader silently no-op'd against real partner traffic — the entire owner-launch feature was dead in production. The handler reads the two params off whichever carrier they arrive on (query checked first, fragment as fallback) and strips them from THAT carrier after consuming them. The `#fragment` form remains the **preferred-but-not-required** carrier on log-hygiene grounds (a bearer-style token in `?query=` is captured by CDN/web-server access logs and leaks into the `Referer` of early sub-resource requests before the post-mount strip runs; a fragment is never sent to the server, logged, or refer[r]ed) — but moving Hatcher's emitter to the fragment is a hardening FOLLOW-UP (partner relay item R1), NOT a precondition for the integration working. The launchToken is useless to a third party without OUR issuer-signed exchange, so the bounded log-leak risk is acceptable until R1 lands.

**Flow (controlled — owner drives the agent's avatar):**
- `HatcherLaunchHandler` (`apps/web/src/components/game/hatcher-launch-handler.tsx`, mounted unconditionally on `/game`) reads the two params off BOTH `window.location.search` (query, checked first) and `window.location.hash` (fragment, fallback) on mount (leading `?`/`#` stripped, then parsed as form-encoded pairs — plain string parsing, not `useSearchParams`, to dodge the Next 16 prerender Suspense bailout).
- Both params present → it strips them from WHICHEVER carrier they arrived on via `history.replaceState` immediately (preserving any unrelated query/fragment keys; dropping the `?`/`#` entirely if none remain — so a refresh can't replay the single-use `launchToken`, and the token never lingers in the URL/history) and calls `api.hatcherLaunchExchange({ agentId, launchToken })` exactly once (re-entry guard).
- **Success** (`{ ok: true, agent: { agentId, name, x, y, mode: 'controlled' } }`): land the owner IN CONTROL — `setControlMode('player')` mounts `PlayerAvatar` (follow camera) driving the agent's bound SQL avatar (the magic-link session is logged into the agent's bound user, so `/api/avatars/me` returns the agent's avatar). It deliberately does NOT set explore / `hatcherSpectate` / `requestCameraFocus` (those are spectate-only and would block the explore→player promotion) and **defensively clears any stale `hatcherSpectate`** from a prior launch in the same browser session so neither the promotion guard nor `setAgentPaired`'s `keepSpectate` branch can pull the owner back out of player control. Toast: `"Controlling <name> · launched from Hatcher"`.
  - **The agent's autonomous in-world body (a separate `oc-${sessionId}` sim NPC, §2d) is SUPPRESSED server-side** while the owner drives, so the world shows ONE body (the owner-driven avatar), not the player avatar plus an auto-walking proxy twin. The exchange primes a 3 s suppression window keyed on the agent; the owner's 5 Hz `POST /api/world/position` uploads refresh it; it auto-expires ~3 s after driving stops (e.g. switching to explore, which gates uploads off → the proxy resumes autonomy). Mechanism detail (hide/skip/freeze/strip-actions) in `ARCHITECTURE.md §13` 2026-06-15.
- **401 / `launch_requires_session`**: a dismissable bottom-centre banner "Open ClawVille from your Hatcher dashboard to launch this agent" — no login redirect built (the portal owns login), don't dead-end silently. **The 401 cookie-race also does one short AUTO re-attempt (FIX-12, 2026-06-13)**: a launch that races the set-cookie/redirect can 401 once before the session cookie is readable, so the handler retries the exchange once after a brief delay before surfacing the banner.
- **Transient failure** (network blip, our issuer momentarily unconfigured / 503, or the 401 set-cookie/redirect race) → an in-page **Retry** affordance instead of a dead-end (FIX-12, 2026-06-13). Earlier the token was stripped and the re-entry guard (`firedRef`) latched BEFORE the exchange resolved, so a transient failure had NO recovery path — the owner was told to relaunch from Hatcher even though a single retry would have worked. The handler now distinguishes transient (retryable in-page) from terminal failures.
- **Terminal failure** (`agent_not_registered`, `agent_not_bound`, `agent_not_owned`, definitive `exchange_rejected`) → keeps the hard "relaunch from Hatcher" dead-end (non-blocking bottom-centre banner; the game has already loaded normally) — a retry can't fix an unregistered/unbound/un-owned agent or a rejected grant.
- **Params absent → zero behaviour change.**

**Ownership invariant (enforced):** controlled mode only works when the launching Lucia session IS the agent's bound user (suppression keys on `boundUserId === session user`). The exchange therefore hard-rejects an agent with no bound user (`409 agent_not_bound` — registered without an `identityKey`, so there's no avatar to drive) and an agent bound to a DIFFERENT user (`403 agent_not_owned`) rather than silently leaving the autonomous proxy as a second body.

**Endpoint:** `POST /api/partner/hatcher/launch/exchange` (Lucia-authed; no guest exchange). Sends Hatcher `mode: 'controlled'` and returns `agent.mode: 'controlled'`. Wire detail + the session-hash transmit rule (`clawvilleSessionId = sha256(sessionId)`, raw session id NEVER sent to Hatcher) live in `ARCHITECTURE.md`. The launch params are attacker-controlled — the exchange's 2xx is the authorization signal, never the params alone. (CONFIRMED + LIVE 2026-06-15: Hatcher accepts `mode:'controlled'` — aligned to the spec, deployed to prod, Hatcher PROD → ClawVille PROD.)

**PARITY:** human path = portal-composed launch URL → magic-link session → `'player'` control of the agent's bound avatar; agent path = the SAME bound avatar (the agent is in-world via partner registration §2d; the launch hands its avatar to the owner and SUSPENDS the agent's autonomous proxy for the duration). Settlement/identity bind to `row.userId` (the bound user) either way — no guest fallback.

---

## 3. Session lifecycle — Phase 6 (2026-04-24)

Sliding 24-hour TTL on `openclaw_bots.session_expires_at`. Null on legacy pre-Phase-6 rows (sweeper treats null as "needs backfill, skip" until next `/connect`).

| Endpoint | Effect on `session_expires_at` |
|---|---|
| `POST /api/agent/connect` / `POST /api/openclaw/register` | Set to `now + 24h` on both insert and update |
| `POST /api/openclaw/chat`, `POST /api/openclaw/location-chat` | Slide forward 24h on every message |
| `POST /api/openclaw/unregister/:sessionId` | Set to `now()` immediately (explicit logout) |
| `POST /api/agent/disconnect` | Same — ed25519-signed logout. **(2026-06-01 fix)** now ALSO `unregisterOpenClaw`s every live in-world body bound to the agent — previously the spawned NPC lingered until an API restart. |

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

Quest-giver NPC at world center (`<QuestNpc>`) plus the QuestBountyPavilion (`<QuestBountyPavilion>`) anchor the boards in 3D space. The pavilion is an octagonal open-air structure at (0, groundedY, −1220) — 1100 wu behind the town directory sign — housing both boards under one roof. Click the left half of the pavilion (boards 1+2) to open the Quest Board, click the right half (boards 3+4) to open the Bounty Board. Bio-luminescent floating labels ("Quests" cyan / "Bounties" amber) hover above each half. The earlier standalone `<BountyBoardObject>` was removed 2026-05-21 — the pavilion supersedes it.

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

**Languages (2026-05-22):** the UI ships in English and 简体中文 (Simplified Chinese). Locale is negotiated from `Accept-Language` on first visit and persisted in the `cv_locale` cookie. Players can switch any time via the **Language** dropdown in the Sidebar SYSTEM section — change reloads the page so every server-rendered slot picks up the new locale. Brand terms (ClawVille, ClawTokens, Nori, Milady, Moltbook, Reef Race, Bumper Shells, OpenClaw, Hermes, and the 10 building names) stay English in every language. Chat messages — Nori, building teachers, NPC chat, agent-gateway chat — adopt the user's locale via a server-side system-prompt addendum; the message body is generated in-language by the model. Allowlist scaffolded for `ja` and `ko` (translations pending). Technical reference: `ARCHITECTURE.md § i18n`.

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
| `<TutorialOverlay>` | 7-step welcome tutorial + persistent Controls button. Desktop opens a compact drawer left of the right sidebar; mobile opens a dismissable modal sheet. The Controls step documents WASD, touch joysticks, Shift/full-tilt run, Space charged jump/quick-sink, and the mobile Jump button. |
| `<GameLanguageControl>` | Persistent `/game` language control. Uses browser locale by default, offers a selector for common locales, batch-translates visible HUD/modal/chat DOM strings through `/api/i18n/translate`, and re-scans mutations so late-mounted panels are covered. |
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
| `<AvatarChatBar>` | Chat with own avatar (bottom-center pill, `bottom-0`/`z-50`). Icon: avatar preview thumbnail, falling back to a category/model emoji. When `agentConnected && agentSessionId`, sends route through the connected agent gateway (`api.openclawChat`); otherwise through `api.sendAvatarChat`. **Stale-session recovery (2026-06-11):** if a connected-agent send returns `404` with `code: 'agent_session_not_found'` (server lost the in-memory session — API restart/deploy/expiry), the bar calls `setAgentConnection(null)` (clears `agentConnected` + `agentSessionId` + the "Bot Training Active" pill), posts an "Agent session ended" assistant line, and shows a non-blocking amber **Reconnect** banner that opens `<AgentConnectModal>`. No auto-retry/auto-reconnect — there are no stored credentials to redo the handshake. The banner self-clears once `agentConnected` flips back true. The web matches on the stable `code`/`status` (never the de-branded message copy) — `ApiError` in `lib/api.ts` carries `status` + `code`. |
| `<EmailVerifyBanner>` | Soft "Confirm your email" nudge (`page.tsx`). **Gating (2026-06-11):** renders ONLY when `isAuthenticated && !isGuest && user.email` is a non-empty string && `!emailVerified` (+ the per-user 7-day localStorage dismissal window). Agent-identity users (auto-created via `resolveOrCreateUserByIdentity` with `email: null`) and guests have nothing to confirm and are excluded — the partner screenshot showed the banner wrongly appearing for an email-less agent user. The gate is enforced at BOTH the mount site (`game/page.tsx`) AND the component's internal early-return (defense in depth); `me()`'s `user.email` type is `string \| null` to match reality. Docked at `bottom-24` so it clears the `<AvatarChatBar>` chat pill. **Mutual exclusion (2026-06-12):** suppresses itself while `hatcherLaunchBannerActive` (the transient Hatcher launch banner) is set — the two bottom-center surfaces never co-render, since no positional lift clears the ~319px mobile Hatcher panel. The email nudge yields the slot and returns once the Hatcher banner is dismissed. |
| `<ShopOverlay>` | Buy books at buildings |
| `<InventoryModal>` | View / learn books |
| `<DailyLoginModal>` | Streak reward popup (§8) |

### 11d. Removed legacy

- `<SpectatorBanner>` and the original `<OpenClawConnectModal>` component files were deleted (orphaned post-`<AgentConnectModal>` rename). The `// SpectatorBanner removed — /game is always game mode` sentinel comment lives in `game/page.tsx` so a future reader doesn't try to re-add it on the assumption that spectator state needs a separate banner — it doesn't, the toggle and `<NanoClawBanner>` already cover those states.

---

## 11z. Multiplayer (Phase 1 — 2026-05-27)

Player rooms are server-authoritative buckets of ≤20 players each, with a
soft cap of 12 that auto-fill targets (the 12-to-20 band is invite-code
headroom for friend groups). The 20-player hard ceiling is set by the Iris Xe
full-VRM budget (14 simultaneous wanderer VRMs + 10 building residents).
Every player that joins a room
**swaps out** one wanderer NPC (preferring the same species so the visual
cast stays balanced) so the total drawn VRM count never exceeds the
budget. The NPC reappears 5 s after the player leaves.

### 11z.a Room model

- **ID format:** 4 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L).
- **Capacity:** soft cap 12, hard cap 20. Auto-fill keeps rooms cozy by
  filling to 12; the 12-to-20 band is reserved headroom so friends can join
  a specific room via invite code even after auto-fill stops seeding it. No
  join path ever seats a 21st player.
- **Auto-fill:** `POST /api/world/join` (no invite code) lands the caller in
  the **fullest** room still under the soft cap of 12 — so players cluster
  together instead of scattering into lone spawns. When every room has
  reached 12 it mints a fresh one. Auto-fill never seeds the 12-to-20
  headroom band. (29 auto-fill players distribute 12 / 12 / 5.)
- **Invite code:** `POST /api/world/join { roomId: "ABCD" }` honors a
  4-char code all the way to the hard cap of 20 (authenticated callers
  only for a never-before-seen code). If the room exists with room under 20
  → join (this is how a friend group fills the headroom band). If it doesn't
  exist → mint with that ID (auth'd only). If it's at 20 → fall back to
  auto-fill.
- **GC:** rooms with zero players for 5 min are deleted; players idle
  for 30 s with no `POST /api/world/position` get kicked.
- **Tradeoff:** the soft cap produces more, smaller rooms at high
  concurrency (100 players ≈ 9 rooms of 12 vs ≈ 5 rooms of 20). The global
  (non-room-filtered) activity arrays on each room snapshot are therefore
  re-serialized into roughly 2× more per-tick snapshots at scale — an
  accepted cost traded for better small-group co-presence and fewer lone
  spawns. (This global-array fan-out is pre-existing, not introduced by the
  soft cap.)

### 11z.b NPC swap-out

When a player joins a room, the registry picks one NPC from the room's
swap-eligible roster (every `NPC_DEFINITIONS` entry where `buildingId === ''`
— the 14 wanderers). Priority order:

1. NPC whose species matches the joiner's avatar species (lex-first).
2. Any other wanderer (lex-first by ID).
3. No swap — the room is already at the 14-VRM floor.

Building residents (Patrick, Gary, Karen, …) are **never** swap-eligible.
They hold load-bearing knowledge and stay in every room.

### 11z.c Leave + restore

When the player leaves, the registry restamps the swap's `removedAt` to
"now". The room's next tick (≥5 s later) re-adds the NPC to
`room.npcs` — the snapshot filter promptly stops hiding it and the
client renders it again.

### 11z.d Wire surface

- `POST /api/world/join` → `{ roomId, id, roomTicket, capacity, playerCount, swappedOutNpcId, players }`. `roomTicket` is the signed sticky-room recovery token (see §11z.e); the client stores it and replays it only on a recovery rejoin.
- `POST /api/world/leave` → fire-and-forget; idempotent if the session isn't in a room.
- `POST /api/world/position` → 5 Hz position update. Server enforces a 10 Hz
  per-session ceiling and silently drops excess.
- `GET /api/world/:roomId/stream` → SSE snapshot every 200 ms. Payload
  shape is the existing `SimulationSnapshot` with `roomId` stamped and
  `players: PlayerSnapshot[]` populated; the `npcs` array is filtered to
  the room's current roster.
- `GET /api/world/rooms` → admin-only roster of live rooms.

### 11z.e Sticky-room recovery — deploys no longer split groups (2026-06-12)

The room registry is in-memory, so an API deploy/restart wipes every room.
Clients auto-recover (a `POST /api/world/position` 409 re-runs join), but a
bare rejoin was AUTO-FILLED — so a deploy could scatter a group of friends who
were together in one room across freshly-minted rooms. Fix: on join the server
hands the client a signed **recovery ticket** (HMAC-SHA256 over
`{roomId, sub, exp}`, signed with a key DERIVED from the env-stable
`FINGERPRINT_SECRET`, self-expiring after 15 min). The client holds it and
replays it on its next recovery rejoin; the server verifies the signature and
confirms the ticket is bound to the caller's OWN session — via a secret-derived
subject (`sha256` of the raw sessionId, NOT the wire-broadcast presence id), so
a captured ticket can't be replayed by anyone who can't also present the
matching cookie/agent-session/fingerprint — then **recreates the named room** so
the dispersed group re-converges. Guests included — the ticket, not an auth
check, is the proof. Recovery bypasses the soft cap (12) to reconverge a group
but never the hard cap (20); a group larger than 20 can't all reconverge (the
hard cap is the VRM ceiling). PARITY: a connected/hosted agent recovers
identically through the same join path — its ticket subject derives from its
agent-session id. No DB writes (the ticket is the durable anchor, held
client-side — mirrors the openclaw session-restore pattern).

### 11z.f Backwards compat

`/api/npc/stream` keeps emitting the legacy world-wide snapshot (no
players, full NPC roster) so any dashboard or stale client still works
for one release.

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

`<TutorialOverlay>` — 7-step welcome modal/drawer triggered by `localStorage` key `clawville-tutorial-seen`. Mounted for all `/game` visitors. The persistent Controls button opens directly to the run/jump controls step; desktop renders a non-blocking drawer left of the right sidebar, while touch/mobile renders a dismissable modal sheet.

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

**Updated 2026-06-16** — added the **Qwerti buy widget** (partner integration, step 1): a floating "buy/swap $CLAWVILLE" launcher (Qwerti's non-custodial DeFAI aggregator — card / Apple Pay / Google Pay / crypto on-ramp). `components/landing/qwerti-buy-widget.tsx` renders null and self-injects `https://widget.qwerti.ai/widget/v1/buy.js` (campaign `clawville-792703809-76951`) on `requestIdleCallback` so it never competes with the 3D hero's first paint (priority #1). **HOMEPAGE ONLY** — injected/torn down in `page.tsx`, never in the root layout, so the launcher never appears over the `/game` WebGPU scene; cleanup calls `Qwerti.destroy()` + removes the `<script>` and `#qwerti-widget-root`. `data-auto-open="false"` (dashboard snippet defaults `true` — overridden so it never auto-pops a buy modal on load). **Themed to ClawVille cyan in code** via `--wt-*` CSS custom-property overrides on `#qwerti-widget-root` (THEME_CSS in the component — custom props pierce the shadow boundary; the widget sets these vars INLINE on the host, so our `#id` rule needs `!important` to win), recoloring the launcher, modal border, glow, message box, and Buy-Token button (no Qwerti-dashboard change needed). A branded **"Buy $CLAWVILLE" header pill** (next to the CA pill, responsive: "Buy" on mobile) calls `openQwertiBuy()` → opens the hosted buy page (magic link) in a new tab. (The widget's `Qwerti.openWidget()` API is a no-op in the current build — verified live; only the launcher's own real click opens the in-page panel — so the button uses the always-reliable hosted page; the in-page cyan widget stays reachable via its floating launcher.) CSP note: `next.config.mjs` sets only `frame-ancestors` (no `script-src`/`default-src`), so the third-party script + its iframes load unblocked. Marketing/economy surface (buy $CLAWVILLE) — NOT a live in-world game mechanic, so intentionally NOT propagated to Nori/SKILL.md. See `Partnerships.md` → QwertiAI.

**Updated 2026-06-10** — restored PayAI press-release hyperlink parity with the Google Docs source: inline article links now wrap the source phrases for ClawVille, PayAI, x402 protocol docs, PayAI Facilitator, agent-native payment infrastructure, and the x402 quickstart; the inline ClawVille link routes to `/game` on-site while footer/community links remain external.

**Updated 2026-06-08** — added the PayAI × ClawVille **press release**: a "🔴 BREAKING" banner at the top of the hero (`page.tsx`, smooth-scrolls to `#press-release`) + a full long-form `<PressRelease>` article section rendered directly below the hero (`components/landing/press-release.tsx`). Lead key-art (`announce.webp`) sits under an enlarged ClawVille × PayAI lockup; 8 co-branded section banners + the lead live at `/public/press/payai/*.webp` (WebP ~200–280KB each, down from ~3MB PNG; all `loading="lazy"` so they never touch the hero's initial paint — priority #1). Forward-looking marketing content (the PayAI integration is announced, not yet built) → intentionally NOT propagated to Nori/SKILL.md (not a live game mechanic).

**Updated 2026-06-01** — hero fold fix + collaboration band + three live demo tiles.

### 15a. Page structure (scroll order)

| Section | Description | Source |
|---|---|---|
| `<LandingScene>` (z-0) | Cinematic reef-canyon 3D backdrop — mounts behind hero via `position:fixed` equivalent | `components/three/LandingScene.tsx` (dynamic, SSR disabled) |
| `<SiteHeader>` (sticky) | Top-bar: CA copy-pill + How-It-Works + Leaderboard + X/Telegram/Web/Discord icons | `page.tsx` (bottom of file) |
| **Hero `<section>`** — `h-[100svh]` | Exactly one viewport tall (svh = handles mobile browser chrome). Contains: **🔴 BREAKING news banner** (top, scrolls to `#press-release`), powered-by badge, h1 ClawVille, tagline, one-line subtitle, Create Agent + Enter ClawVille CTAs, "Already have an account? Log in" link, scroll cue. Legibility overlay at `z-[5]` (radial + vertical dark gradient) between scene and content. | `page.tsx` |
| **`<PressRelease id="press-release">`** | PayAI × ClawVille press-release article — enlarged co-branded lockup + `announce.webp` lead banner, 8 numbered sections each with a lazy WebP banner, ClawVille/PayAI community-links footer. Renders directly below the hero. | `components/landing/press-release.tsx` |
| **Collaboration `<section id="collaboration">`** | Relocated from hero. Eyebrow "Three Ways To Collaborate" + `<MiladyAvatarShowcase>` + `<CollaborationAxes>` grid + stats strip (1B / 10 / 3 / Any) + quick-jump nav pills (Gameplay / Tokenomics / Roadmap). | `page.tsx` |
| `<LiveDemoStrip>` | Three live 3D vignette tiles (see §15b). | `components/landing/live-demo-strip.tsx` |
| `<GameplayShowcase>` | Six feature cards. | `components/landing/gameplay-showcase.tsx` |
| Connect Your Agent | Platform grid (OpenClaw / Hermes / Milady AI / Any Agent) + collaboration-loop pills. | `page.tsx` |
| Tokenomics | $CLAWVILLE supply + utility pillars. | `page.tsx` |
| Skill Categories | 10-building grid. | `page.tsx` |
| Roadmap | 5-milestone timeline. | `page.tsx` |
| Footer CTA | "Ready to dive in?" + tech badges + ElizaOS attribution. | `page.tsx` |
| `<ExpiredLinkBanner>` | Surfaces `?error=expired-link` from stale magic-links (fixed overlay). | `page.tsx` |
| `<HowItWorksModal>` | Full-page explainer modal. | `components/landing/how-it-works-modal.tsx` |
| `<QwertiBuyWidget>` | Qwerti floating "buy $CLAWVILLE" launcher (partner). Renders null; lazy self-injects on idle, homepage-only, `data-auto-open="false"`, full teardown on nav. | `components/landing/qwerti-buy-widget.tsx` |

### 15b. Live demo tiles (LiveDemoStrip)

All three tiles are `status='live'`. `ReefRaceVignette.tsx` and `BumperShellsPlaceholder` removed.

| Tile | Vignette component | href | accent |
|---|---|---|---|
| Agent ↔ Agent | `AgentChatVignette` | `/leaderboard` | cyan |
| The Cove | `CoveVignette` | `/cove` | pink |
| Building Visit | `BuildingVisitVignette` | `/game` | amber |

3D composition details for all four landing scenes (LandingScene + 3 vignettes): see **`3dStructure.md §11`**.

---

## 16. Jump controls

The full state machine, physics constants, and per-frame integration math live in **`3dStructure.md §6e`** (it's a 3D-rendering / physics concern, not a gameplay surface).

Gameplay-facing summary:
- **SPACE** triggers `charging` (avatar stays on ground while holding); release < 200 ms → quick tap (small hop), release ≥ 200 ms → scaled launch (peak altitude linear in charge); `holdMs ≥ 1500 ms` auto-launches at max.
- **Mid-air SPACE** triggers quicksink (fast controlled descent at −600 wu/s).
- **Touch Jump button** in `<MobileControls>` mirrors SPACE: press/hold to charge, release to launch, tap mid-air to quicksink.
- **Speed/run** uses Shift while moving on desktop; touch users push the movement joystick to the outer ring to engage the same run multiplier.
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

### 17f. Second partner — Hatcher (2026-06-01)

Hatcher (a managed AI-agent hosting platform — "Heroku for AI agents") is the **second** connected-world partner, a faithful mirror of the 'scape portal. Backend + docs shipped 2026-06-01 (`.claude/plans/hatcher-integration.md` §2); the outbound **"Cross to Hatcher"** sidebar UI is **deferred** until Hatcher ships their session-issue endpoint (no dead UI scaffolded). The two partners share the same signing keypair (`CLAWVILLE_SERVICE_ISSUER_SK/_PUBKEY`) and the same generalized verifier (`verifyPartnerSignature(partnerId)`); only the partner id, env URLs, inbound headers (`X-Hatcher-*`), `users` column set, and event prefix (`portal.hatcher.*`) differ.

- **Outbound (CV → Hatcher):** `POST /api/portal/hatcher` (Lucia) → signs the same payload shape → POSTs to `HATCHER_HOSTED_SESSION_URL` → relays the returned `sessionToken` into a `HATCHER_WEB_ORIGIN` redirect.
- **Inbound user portal (Hatcher → ClawVille):** `POST /api/portal/mint-for-hatcher` (Hatcher signature) — verifies against `PARTNER_PUBKEYS.hatcher`, validates the same `principal:clawville:<uuid>` anti-enumeration regex, mints a Phase 5 magic-link ticket (`identityType:'portal-hatcher'`), returns `{ redirectUrl: https://clawville.world/enter?t=... }`.
- **Account linking:** `POST /api/portal/hatcher-link-code` (Lucia) mints a code with `remote_world:'hatcher'`; `POST /api/portal/accept-hatcher-link` (Hatcher signature) consumes it and writes `users.linked_hatcher_*`.
- **6 mirror `users` columns:** `hatcher_principal_id` / `hatcher_world_character_id` (auto-provision cache) + `linked_hatcher_principal_id` / `linked_hatcher_world_character_id` / `linked_hatcher_display_name` / `linked_hatcher_at` (account-link). `GET /api/avatars/me` surfaces `linkedHatcherPrincipalId` / `linkedHatcherDisplayName` alongside the scape pair.
- **Cross-partner redemption fix (same diff):** both `accept-*-link` handlers now require the pending code's `remote_world` to match the partner endpoint, so a 'scape code can't be redeemed via the Hatcher endpoint and vice-versa (opaque 404 on mismatch).

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

Accessible by clicking the casino building (slot 9, W ring, `casino-exterior.glb` pyramid) in the open world.

**Walk-in flow (Concern 6.0.3 — SHIPPED):** Click casino building → `triggerCasinoWalkIn()` in `arena-buildings.tsx`. In player/NPC/autonomous modes: avatar walks toward door at `(940, 5760 game-px)` using existing `setClickPath`. When within 200 game-px of door OR after 1500ms max-wait → 500ms fade-to-black → mid-fade router push to `/casino` → `/casino` page mounts with `<SceneTransition fadeInOnMount />` and fades from black over 500ms. In explore mode (no avatar): immediate fade with no walk. Total perceived time ≤ 3s.

**Walk-out flow:** "Back to World" button in `/casino` → `triggerTransition({ to: '/game', onMidway })`. Mid-fade: `avatarPositionRef` + `useGameStore` both set to casino door position `(2000, 5760 game-px)` — 400 wu east of building center (toward town center), so avatar spawns on the entrance side of the building, not the back. `/game` page fade-in is handled by its own `<SceneTransition />` (no `fadeInOnMount` — only fades on triggered exit, not on raw page load).

_Exit position math: Casino slot 9 W → cx=50 tiles → worldX = 50×32 − 5760 = −4160 wu. Exit = −3760 wu = game-px x=2000. Prior value (940) was WRONG — placed avatar on the far (back) wall._

### 18a.a. Interior scene (Concern 6.0.2 — SHIPPED)

Route `/casino` mounts a route-isolated R3F Canvas (`key="casino-interior"`) with a separate WebGPU context. Scene shows the casino interior GLB (Predictive Gaming Cove theme). Slot machine hotspots are invisible click boxes — cursor: pointer on hover; click opens the 2D slot screen (§18a.c).

| Asset | Detail |
|---|---|
| `casino-interior.glb` | Gameready, Draco-compressed, 4.2MB, ~211k tris |
| `casino-interior-fallback.glb` | Cartoon, no Draco, 58KB, 449 tris — Object_8+Object_9 = slot cluster |

**FPS auto-fallback:** if avg FPS < 40 over the first 5 seconds, the scene silently reloads the fallback GLB. Force fallback: `?fallback=1`. Back to World button top-left → `triggerTransition({ to: '/game', onMidway: reposition })` (see walk-out flow above).

### 18a.b. Walk-in / walk-out animation (Concern 6.0.3 — SHIPPED)

See walk-in + walk-out flow descriptions in the §18a header above. Key files: `SceneTransition.tsx` (generic), `arena-buildings.tsx` (`triggerCasinoWalkIn`), `casino/page.tsx` (walk-out + `fadeInOnMount`), `game/page.tsx` (`<SceneTransition />`).

### 18a.c. 2D slot screen (Concern 6.0.4 — SHIPPED · slice 5 real-backend wire LIVE 2026-05-19)

Clicking a slot machine hotspot opens a full-viewport DOM overlay (z-index 9990) over the 3D canvas. The 3D interior stays mounted and rendering underneath. ClawTokens-only currency in Phase 6.1; the modal now talks to `/api/casino/slots/*` for real (mock engine deleted in slice 5).

**Lifecycle (slice 5):**
1. Hotspot click → `openSlotScreen(machineSlug, paytableId, startBalance)`. `startBalance` = current `avatar.clawTokens`. No API call yet.
2. First spin press → `useOpenSlotSession.mutate({paytableId, currency:'clawtokens', predict})` → server returns `{sessionId, serverSeedHash, clientSeed}` → store mirror via `setSessionMeta`.
3. Every spin press → mint fresh `crypto.randomUUID()` Idempotency-Key (re-used on a single press's retries) → `useSpin.mutate({sessionId, predict, idempotencyKey})` → atomic server txn debits predict + credits any winnings → response `{spinId, reels, winAmount, balance, ...}` (BigInt fields are strings on the wire) → adapter `spinResponseToSpinResult` promotes to bigint → existing reel-anim pipeline + `useFX` consume it unchanged.
4. Cash-out (✕ button or "Walk Away") → `useCloseSlotSession.mutate({sessionId})` → server REVEALS `serverSeed` → store `setRevealedServerSeed` → fairness tooltip shows it inline → modal auto-closes after 1.2s.

**Fairness chip (slice 5):** Below the header, a clickable cyan chip displays the short `serverSeedHash` (committed at open) or, after cash-out, the revealed seed. Tapping it opens a dialog with full hashes + clientSeed + deeplinks to `/casino/verify/<sessionId>` (per-session) and `/casino/verify` (manual).

**Paytable:** 5×3 reel grid, 20 paylines, 8 symbols (Cherry → Wild). Publicly verifiable constants in `packages/shared/src/constants/slot-paytables.ts` (`CLASSIC_REEL_STRIPS`, `CLASSIC_SYMBOLS`, `CLASSIC_LINES`). Exported from `@clawville/shared`. Target RTP 96%.

**Mock engine (`apps/web/src/lib/casino/mock-engine.ts`):** `Math.random()` only — no HMAC, no backend. Outcome-forcing: picks tier first (60% loss / 25% small / 10% medium / 4% big / 1% mega), then tries up to 200 random reel stops to hit the target multiplier range. Falls back to `constructGuaranteedWin()`. Phase 6.1 SWAP: same `mockSpin(MockSpinParams): SpinResult` signature and return type, implementation only changes.

**`SpinResult` contract** (`apps/web/src/lib/casino/types.ts`) — frozen for Phase 6.1 swap-in:
```ts
interface SpinResult {
  reels: number[][];        // [5 reels][3 rows], symbol IDs
  winningLines: WinningLine[];
  winAmount: bigint;        // atomic ClawToken units
  freeSpinsAwarded: number;
  isFreeSpin: boolean;
  cursorAfter: number;
}
interface WinningLine { lineIndex: number; symbols: number[]; winAmount: bigint; multiplier: number; }
```

**UI polish pass (Concern 6.0.4 — 2026-05-18):** Replaced emoji symbols + inline-style hodgepodge with a real design system. New files: `apps/web/src/styles/casino-tokens.css` (single source of truth for neon palette, spacing, radius, motion, shadows, plus shared keyframes — `cv-spin-jitter`, `cv-stop-pop`, `cv-coin-burst`, `cv-confetti-burst`, `cv-shake-soft|hard`, `cv-screen-flash`, `cv-mega-banner-in`, `cv-glow-pulse`), `apps/web/src/lib/casino/useFX.ts` (5-tier FX state machine — see below), `apps/web/src/components/casino/ui/` (NeonButton primary/secondary/ghost, NeonCard with title+subtitle+action, NeonModal with backdrop blur + ESC + click-outside + focus trap, BetChips chip-style selector), `packages/shared/src/constants/slot-symbols.ts` (`CLASSIC_SLOT_SYMBOL_ASSETS` — maps SymbolId → SVG path + ClawVille-themed display name). SVG art at `apps/web/public/assets/slot-symbols/s0..s7.svg` — Kelp / Anchor / Shell / Pearl / Coin / Crab / Trident / Lobster (wild). `<img onError>` falls back to legacy emoji if a SVG is missing — no 404 surfaces to the player.

**Reel animation (`SlotReels.tsx`):** CSS keyframes only (no canvas), Iris Xe safe. Sequential stop: reel `i` settles at `2.0 + i×0.4`s → [2.0, 2.4, 2.8, 3.2, 3.6s]. While spinning: `cv-spin-jitter` 240ms linear infinite + `saturate(1.15)` filter. On stop: `cv-stop-pop` 260ms `cubic-bezier(0.2,0.8,0.2,1)` one-shot. Win cells: gold ring + bloom box-shadow + `cv-symbol-stopped-pulse`. Win line overlay: horizontal neon strip at the row of each winning payline. Mobile responsive via `--slot-cell-size`. Shake intensity passed in via prop — `useFX().state.shakeLevel` drives `cv-shake-soft` or `cv-shake-hard` on the reel container.

**Slot HUD (`SlotHUD.tsx`):** top strip (balance CT / session P&L / spin count) + bottom bar built on `NeonButton` + `BetChips`. SPIN button states: `ready | spinning | evaluating | insufficient | locked` (locked = mega-win 3s lockout). Bottom bar sticks to safe-area-inset-bottom on mobile (`position: sticky; bottom: 12px; padding-bottom: env(safe-area-inset-bottom)`).

**Win celebration (`WinCelebration.tsx`):** 5-tier dispatcher reading from `useFX().state`. Tiers (derived in `useFX.deriveWinTier` via bigint math `winAmount * 100n / predict`): **micro** (< 2× — 4 coins, no overlay), **small** (< 10× — 8 confetti + soft shake), **medium** (< 50× — 18 coins + 14 confetti + soft shake + vignette), **big** (< 500× — 24 coins + 18 confetti + hard shake + WIN banner), **mega** (≥ 500× — 42 coins + 30 confetti + hard shake + screen flash + 3s spin lockout). Each particle gets `--cv-idx` and `--cv-count` inline so a single `cv-coin-burst`/`cv-confetti-burst` keyframe handles spread and stagger. RAF count-up drives the big/mega banner amount. `prefers-reduced-motion` halves particle counts, disables screen flash, demotes `hard` shake to `soft`.

**useFX hook (`apps/web/src/lib/casino/useFX.ts`):** `{state, onSpinStart, onSpinResolved, reset}`. State surface: `{tier, winAmount, predict, shakeLevel, isGlowActive, isSnapActive, isHugeWinFlashActive, particles[], isLockedOut}`. All timers tracked in a ref array + cleaned up on unmount or `reset()`. `reset()` called from `handleClose` so closing mid-celebration drops every pending particle and clears the lockout.

**Paytable modal (`PaytableModal.tsx`):** Built on `NeonModal` + `NeonCard`. Symbol rows render the SVG asset (with emoji fallback) keyed off `CLASSIC_SLOT_SYMBOL_ASSETS`. Payout chips use the symbol's theme color. Closes on Escape or backdrop click (handled by NeonModal).

**State (`apps/web/src/stores/casino.ts`, slice 5):** `useCasinoStore` Zustand slice. Tracks UI state PLUS server session metadata mirrored from the open response: `sessionId`, `serverSeedHash`, `clientSeed`, `revealedServerSeed`. `openSlotScreen(machineSlug, paytableId, startBalance)` resets every slot of session state. `recordSpin(result, balance, spinCount)` writes the AUTHORITATIVE post-spin balance from the server response — we never re-derive balance locally (defends against out-of-band ClawToken deltas between spins). `closeSlotScreen()` resets all session metadata. The mock cursor system was deleted with `mock-engine.ts` in slice 5.

**Autoplay:** `AutoplayState { count, remaining, active }` — modes: fixed spins, until cashout, until big win. Continues if session balance ≥ predict after each reel settle; otherwise halts with a low-balance banner.

**Key files:**
- `apps/web/src/lib/casino/types.ts` — SpinResult contract (frozen, shared with verifier)
- `apps/web/src/lib/casino/slot-api-client.ts` — TanStack Query hooks + wire types (slice 5)
- `apps/web/src/lib/casino/verifier.ts` — browser-safe WebCrypto port of slot-engine (slice 5)
- `apps/web/src/lib/casino/__tests__/verifier.test.ts` — byte-identity tests (slice 5)
- `apps/web/src/lib/casino/useFX.ts` — 5-tier FX state machine (polish pass)
- `apps/web/src/stores/casino.ts` — Zustand store (mirrors server session metadata)
- `apps/web/src/styles/casino-tokens.css` — design tokens + shared keyframes (polish pass)
- `apps/web/src/components/casino/SlotScreenModal.tsx` — root modal + orchestration (slice 5 real-backend wire)
- `apps/web/src/components/casino/SlotReels.tsx` — 5×3 reel grid (SVG symbols)
- `apps/web/src/components/casino/SlotHUD.tsx` — balance strip + controls (predict chips now 20-divisible)
- `apps/web/src/components/casino/WinCelebration.tsx` — 5-tier FX dispatcher
- `apps/web/src/components/casino/PaytableModal.tsx` — symbol/line viewer
- `apps/web/src/components/casino/ui/{NeonButton,NeonCard,NeonModal,BetChips}.tsx` — branded primitives (polish pass)
- `apps/web/src/app/casino/page.tsx` — interior page + top-right 🔐 Verify link (slice 5)
- `apps/web/src/app/casino/verify/page.tsx` — manual verifier (slice 5)
- `apps/web/src/app/casino/verify/[sessionId]/page.tsx` — per-session verifier (slice 5)
- `apps/web/public/assets/slot-symbols/s0..s7.svg` — ClawVille-themed reel art
- `packages/shared/src/constants/slot-paytables.ts` — canonical paytable constants
- `packages/shared/src/constants/slot-symbols.ts` — SVG asset manifest

### 18a.d. Backend / RNG / wager program (Concern 6.1 — fun-money LIVE for ClawTokens; SOL/USDC pending 6.2)

On-chain slot RNG (SOL/USDC) + settlement via `clawville_wager` Anchor program land in Phase 6.2. ClawTokens fun-money tier is LIVE end-to-end as of 2026-05-19 (slice 3).

**Phase 6.1 backend (LIVE 2026-05-19):**

- `POST /api/casino/slots/session/open` — Lucia auth. Body `{paytableId: 'classic-3x5', currency: 'clawtokens', predict}`. Debits `predict` ClawTokens (reservation), generates `(serverSeed, serverSeedHash, clientSeed)`, returns `{sessionId, serverSeedHash, clientSeed, predict, startingBalance, escrowAmount, createdAt}`. `serverSeed` is NEVER returned at open. One open session per user (partial unique index on `slot_sessions` enforces race-safety; 409 on duplicate). `currency: 'sol' | 'usdc'` → 501 `CURRENCY_COMING_SOON`.
- `POST /api/casino/slots/spin` — Lucia auth. Header `Idempotency-Key` required (1-64 chars). Body `{sessionId, predict}`. Predict must equal session's reserved predict (slice 3 simplicity — variable predict lands later). 60 spins/min/user rate limit. Atomic transaction: row-locks session FOR UPDATE, asserts pre-engine counter snapshot still current (concurrent-spin guard via `session_counter_changed_retry`), debits predict via `claw-token-ledger`, inserts spin row (duplicate `(sessionId, idempotencyKey)` trips 23505 → cached replay), updates session counters (`nonceCounter++`, `cursorCounter = result.cursorAfter`, `totalStaked += predict`, `totalWon += winAmount`, `escrowAmount -= predict` capped at 0, `currentBalance += winAmount - predict`, `spinCount++`), credits winnings via `claw-token-ledger`. Idempotency replay short-circuits BEFORE engine call, BEFORE debit, BEFORE all session writes — same key always returns the same `spinId` + reels + winAmount.
- `POST /api/casino/slots/session/close` — Lucia auth. Body `{sessionId}`. Locks session, refunds remaining `escrowAmount` (via `creditClawTokens`), sets `status='closed'`, REVEALS `serverSeed` in response. Public verifier at `POST /api/casino/slots/verify` can now replay every spin against the released seed.
- `GET /api/casino/slots/session/:id` — Lucia auth, owner-only (403 cross-user). Returns the full session row; `serverSeed` is `null` while `status='open'`, REVEALED once closed.
- `GET /api/casino/slots/session/:id/spins?limit=N` — Lucia auth, owner-only, paginated (default 50, max 200).
- `GET /api/casino/slots/paytables/:id` — **public**, no auth. Returns the `classic-3x5` paytable bundle (symbols + lines + reel strips + rtp) for verifier replay.
- `POST /api/casino/slots/verify` — **public**, pure compute. Body `{paytableId, serverSeed, clientSeed, nonce, cursor, predict}` → returns the same `SpinResult` shape the spin endpoint emits. Does NOT persist anything.

**BigInt wire serialization** — `winAmount` and `winningLines[i].winAmount` are bigints in the engine. Every API response converts via `serializeSpinResult` / `serializeWinningLine` (`apps/api/src/routes/casino-slots.types.ts`) — bigints stringified, no global `BigInt.prototype.toJSON` monkey-patch.

**Frontend wire (slice 5, LIVE 2026-05-19):** The mock engine (`apps/web/src/lib/casino/mock-engine.ts`) has been DELETED. The slot UI now calls the API directly via TanStack Query hooks in `apps/web/src/lib/casino/slot-api-client.ts`: `useOpenSlotSession`, `useSpin` (caller-managed `Idempotency-Key`), `useCloseSlotSession`, `useSlotSession`, `useSlotSessionSpins`, `useSlotPaytable`, `useVerifySpinRemote`. BigInt-as-string contract preserved end-to-end; only `spinResponseToSpinResult` promotes to bigint at the FX boundary.

**Provably-fair verifier UI (slice 5, public + auth-gated):** Two new routes ship the player-visible side of the commit-reveal scheme.

- `/casino/verify` — **anonymous**, paste your own seeds. Form takes `serverSeed` (revealed at session close), `clientSeed`, `nonce`, `cursor`, `predict`, paytable. Verify button runs the spin TWICE: once in the browser via `runSpinLocal` (WebCrypto port in `apps/web/src/lib/casino/verifier.ts`), once on the server via `POST /api/casino/slots/verify`. Reels + winAmount + cursorAfter compared byte-by-byte; green check if identical, red flag with divergence reasons if not. Also recomputes `sha256(serverSeed)` and shows it for player-side commit-hash checking.
- `/casino/verify/[sessionId]` — **auth-gated, owner-only**. Loads session detail via `GET /session/:id`; if status='open' shows "verify after session closes" (server redacts `serverSeed` while open anyway). Once closed, fetches all spins via `GET /session/:id/spins?limit=200`, runs `replaySpin` per row in nonce order, displays a green/red table with divergence details. Includes a top-of-page `sha256(serverSeed)` recompute that asserts the commit-hash invariant.

**Verifier guarantee (slice 5 test suite):** `apps/web/src/lib/casino/__tests__/verifier.test.ts` (20 tests, all green) re-uses the slice-1 hand-computed RNG fixtures to assert byte-identity between browser WebCrypto and Node `crypto`. `runSpinLocal({serverSeed:'a'*64, clientSeed:'abcd1234', nonce:0, cursor:0, predict:20n})` produces `reels=[[7,1,1],[1,3,0],[3,1,1],[1,4,3],[2,2,0]]`, `winAmount=55n`, `cursorAfter=20` — identical to the server's `runSpin` output. If WebCrypto drifts by one byte, the test suite fails and the casino's provably-fair claim is broken.

**Events emitted:** `casino.slots.session.opened`, `casino.slots.spin.executed`, `casino.slots.session.closed` — visible in `/dash` event tile once the leaderboard hook is added.

**Real-money path (SOL + USDC):** Phase 6.2 (`clawville_wager` Anchor program extension — 8 new ix). Slice 3 stubs return 501 with a friendly "coming in 6.2" message — the UI's toast layer in `slot-api-client.ts` already maps 501 to "SOL/USDC coming in Phase 6.2".

### 18a.e. Walkable interior + slot cabinet props (Concern 6.0.5 — SHIPPED)

Player avatar (VRM or GLB) mounts inside the casino interior scene. Fully self-contained movement system in `casino-interior.tsx` — does NOT reuse `player-avatar.tsx` (too coupled to world map, terrain, quests).

**Player spawn:** position `(0, 0, +240)` — near the front wall entrance. Initial rotation π (facing −Z into the room).

**WASD movement:** camera-relative, 250 wu/s, bounded to `x∈[-115,+115], z∈[-270,+270]`. Module-scope key state (`casinoKeys`, `casinoKeyListenersAttached`) — separate from world-canvas state to avoid cross-canvas contamination.

**Follow camera:** +55 wu above avatar, +160 wu behind (opposite heading). Exp-decay lerp `1 - Math.exp(-8 * delta)`, looks at `avatar + Y×18`. Camera is frozen when the 2D slot screen modal is open (`useCasinoStore.getState().slotScreenOpen === true`).

**Avatar routing:** `CasinoPlayerAvatar` reads `useGameStore(s => s.avatarModelKey)` + `MODEL_REGISTRY.avatar_type`. VRM avatars use `useVRMInstance('casino-player')` + `VRMCharacterAnimator`. GLB avatars use the lobster path with `CASINO_AVATAR_SCALE=40`. VRM facing: `atan2(vx, vz)` (same as world player — verified correct for Mixamo-rigged VRMs that face −Z natively).

**Slot cabinet props:** 4 low-poly cabinets along the left wall (`x=-115`, z spread at −175/−100/−25/+50). Each cabinet: base plinth (`BoxGeometry 42×6×32`), body (`38×68×28`, dark purple), emissive cyan screen panel (`24×34×2`, `emissiveIntensity 1.2`), red lever (`CylinderGeometry r3 h22`). All geometry at module scope (built once). `matrixAutoUpdate=false` after first placement. 4 cabinets × 4 meshes = 16 additional draw calls.

**Hotspots:** now positioned at cabinet faces (`x=-90, y=37`), one per cabinet. Click → `useCasinoStore.openSlotScreen`. Invisible `MeshBasicMaterial`.

**Canvas initial camera:** `[0, 55, 400]` — directly behind spawn point, follow-cam takes over frame 1.

**Initial camera position:** `CasinoCanvas` starts at `[0, 55, 400]` (behind spawn + 160wu). R3F follow-camera overrides this on the first useFrame tick so there is no visual jump.

### 18a.f. Blackjack table (Phase 6.4.0 — interactive client-side shell, 2026-05-25)

**Scope:** interactive display shell. The player walks every decision themselves — bet, deal, hit/stand each card, then watch the dealer play out — but bets are display-only ClawTokens with NO ledger writes (`transferClawTokens()` not called). The real engine + on-chain wager program + ElizaOS skill memory for hosted agents arrives in Phase 6.4.1. Connection SKILL.md + hosted-agent memory injection deferred to Phase 6.4.2.

**HOUSE RAKE (economy fix 2026-05-29, applies to the REAL 6.4.1 engine):** blackjack is an intentionally-countable SKILL game (single shuffle per shoe + exposed dealt history is the fair-competition surface — we do NOT neutralise the count), so a skilled/counting agent goes +EV. To keep the house whole the engine takes a rake of `floor(max(0, totalPayout − totalBet) × 5/100)` — 5% of the player's NET WINNINGS, WINNERS ONLY. Pushes and losses pay no rake, and the rake never touches the returned stake, so it changes no basic-strategy decision. The credited payout = `totalPayout − rake` (net-100 win → 5 CT rake → credited 95). `computeBlackjackRake` in `blackjack-engine.ts`; applied once at settle in `cove-blackjack.ts` under the shoe `FOR UPDATE` lock; recorded in `outcomeJson.rake`/`rakedPayout`/`rakedNet` + the flat `blackjack_hands.payout`/`net` hold the post-rake figures; `cove_game_events.payout` is the raked figure (CT-economy monitor burn includes the rake); idempotent settled-replay never re-rakes. See `.claude/plans/cove-casino-economy.md` §1/§2.

**Why the rewrite:** the initial 6.4.0 cut collapsed bet → deal → outcome into a single server POST that returned a canned hand — the player never chose hit/stand, the cards were unreadable, and the WALK AWAY button was invisible. Phase 6.4.0 was retargeted to a real interactive shell on the client so the visual + flow contract for 6.4.1 is exercised end-to-end before the wager engine lands.

**State machine (client-side, drives the modal):** `idle` (bet chip selector + DEAL, no cards visible) → `dealing` (~820ms while the opening 4 cards animate in: 2 player face-up, 1 dealer face-up, 1 dealer face-down; no player actions) → `player-turn` (HIT + STAND active; DOUBLE / SPLIT / SURRENDER rendered-but-disabled with `Phase 6.4.1` labels; auto-advances to `dealer-turn` on player bust >21) → `dealer-turn` (dealer reveals hole card and draws at ~420ms per card until the rule below is met; no player actions) → `resolved` (outcome banner + payout CT delta + NEXT HAND + WALK AWAY). ESC during `resolved` closes; ESC during an active hand is ignored to prevent accidental fold.

**Deck + RNG:** standard 52-card single deck, shuffled per hand via `mulberry32` seeded from `crypto.getRandomValues` on each DEAL press — reproducible per hand, unpredictable across hands. The seed is not surfaced to the UI in 6.4.0; provably-fair commit-reveal arrives with the real engine in 6.4.1.

**Dealer policy:** dealer hits on soft 17, stands on hard 17+. Aces count as 11 unless that would bust, then 1 (both player and dealer). Outcomes + payout deltas on the local display balance: `blackjack` = `floor(bet × 1.5)` (3:2), `win` = `bet` (1:1), `push` = `0` (bet returned), `loss` = `-bet`, `bust` = `-bet`. Banner strings: `BLACKJACK!` / `YOU WIN` / `PUSH` / `BUST` / `YOU LOSE`.

**3D hotspot:** `BlackjackTableHotspot` component in `apps/web/src/lib/three/cove-interior.tsx`. Invisible `boxGeometry (200×200×150 wu)` + `meshBasicMaterial visible={false}`, anchored at `(_DEALER_CENTER_X − 60, 100, _DEALER_CENTER_Z)` = `(307, 100, 0)`. Mirrors `SlotHotspot` pattern exactly — `onPointerOver` sets `cursor: pointer`, `onClick` calls `useCoveStore.getState().openBlackjackTable(avatar?.clawTokens ?? 0)`, `matrixAutoUpdate=false`. A `BankBanner` plane with label `"BLACKJACK"` in `#22dd88` floats at Y=280 above the hotspot.

**2D modal:** `apps/web/src/components/cove/blackjack/BlackjackModal.tsx`. Felt background (CSS gradient `#0d3a1e → #0a2e18`). Sub-components: `HandRow` (cards + ace-correct total), `OutcomeBanner` (win=amber, push=cream, loss=`#e85555`), `BlackjackCard` (Unicode suit glyphs on a light face — hearts/diamonds red `#c92020`, spades/clubs near-black `#0d0d0d`, slide-in keyframe per card with staggered delay so contrast passes WCAG AA in the live modal). Bet chips: `BET_STEPS = [10, 25, 50, 100, 250, 500]` ClawTokens — display only in 6.4.0. Action surface is phase-driven: `idle` shows bet chips + DEAL; `player-turn` shows HIT / STAND active with DOUBLE / SPLIT / SURRENDER disabled and labelled "Phase 6.4.1"; `dealer-turn` shows no actions (dealer auto-plays); `resolved` shows NEXT HAND (re-opens at `idle`, balance preserved) and WALK AWAY (closes the modal). WALK AWAY is now filled crimson with white text — the prior dark-red-on-dark-navy made it invisible against the felt and was the headline regression of the first 6.4.0 cut. Local display balance tracked in component state — no ledger write.

**State:** `useCoveStore` (`apps/web/src/stores/cove.ts`) extended with blackjack slice: `blackjackOpen`, `blackjackPhase` (`'idle' | 'dealing' | 'player-turn' | 'dealer-turn' | 'resolved'`), `blackjackBet`, `blackjackOutcome`, `blackjackPlayerHand`, `blackjackDealerHand`, `blackjackPayout`, `blackjackOutcomeLabel`, `blackjackDisplayBalance`. Actions: `openBlackjackTable(displayBalance)`, `closeBlackjackTable()`, `setBlackjackBet(n)`, `setBlackjackPhase(p)`, `setBlackjackHands(playerHand, dealerHand)`, `setBlackjackResult(...)`.

**Types:** `apps/web/src/lib/cove/blackjack-types.ts` — frontend-local copy for 6.4.0. Canonical shared types already promoted to `packages/shared/src/types/cove-blackjack.ts` (exported from `@clawville/shared`) in Phase 6.4.0. Web components will migrate to `@clawville/shared` and the local copy deleted in Phase 6.4.1.

**Backend route:** `apps/api/src/routes/cove-blackjack.ts`, mounted at `app.route('/api/cove/blackjack', ...)` in `index.ts`. The original `POST /play-mock-hand` is no longer called by the web client (the client-side deck owns play). The endpoint is kept as a stub for 6.4.1 evolution — see the route-fate recommendation in the 2026-05-25 audit handoff for the agreed final shape.

**Page mount:** `apps/web/src/app/cove/page.tsx` — `<BlackjackModal />` mounted after `<SlotScreenModal />`. Interior branding subtitle updated to "Slots · Blackjack".

**AGENT PARITY (2026-06-03, connected/hosted agents play blackjack AS THEMSELVES):** a connected/hosted agent plays blackjack autonomously for real ClawTokens, exactly like a human (Rule E5 + CLAUDE.md human-parity TOP DIRECTIVE). Two live autonomous surfaces: the agent playing from its OWN runtime via the cove tools (needs no browser), and the in-modal human-supervised driver where a human flips THEIR open table to Autonomous and the browser asks the agent via the shipped relay (see the driver bullet below). The one honest boundary: self-managed nanoclaw agents decide client-side and cannot be push-asked, so the in-modal path degrades to Control for them.

- **Server-side agent play (impl-1):** the cove identity resolver in `cove-blackjack.ts` resolves a connected/hosted agent session to its BOUND avatar, so settlement (debit/credit through `claw-token-ledger.transferClawTokens()`) and leaderboard credit bind to the agent's avatar in REAL CT (agents never fall into the guest/demo tier). The play surface is a two-step hybrid: the in-world `[ACTION: enter_cove()]` verb (no params) in the `npc-simulation.ts` executor walks the agent to the cove, then four session-bound TOOLS (`cove_blackjack_open_session`, `cove_blackjack_deal {shoeId, bet, insurance?}`, `cove_blackjack_action {handId, action, handSlot?}`, `cove_blackjack_close_session {shoeId}`) at `/api/agent/:sessionId/cove/blackjack/tools.json` + `POST .../:tool` drive the hand. The server is authoritative: the agent receives only its own cards + the dealer upcard + the legal actions, never the dealer hole / undealt shoe / seed before reveal. The `blackjack-engine.ts` provably-fair logic is byte-for-byte unchanged + verifiable at `/cove/history`.
- **game-skill-memory loop (impl-1):** `apps/api/src/services/game-skill-memory.ts` writes an earned-skill memory per resolved hand (`metadata.subtype:'game-skill'`, `skill:'blackjack'`, `subskill:'<situation>'`) via `createMemory()` for hosted agents (offered as a `memory_recommendation` for connected agents), and pre-existing blackjack skill memory informs later play (the competitive edge). `GET /api/agent/:sessionId/cove/blackjack/skill-memory` returns the accumulated lessons + win/loss tally.
- **Agent-from-its-own-runtime autonomous path:** a connected/hosted agent plays autonomously from its OWN runtime via the `enter_cove()` verb + the four session-bound cove tools above. No human and no browser driver are involved.
- **Frontend in-modal supervised driver (impl-2, `BlackjackModal.tsx`), LIVE:** when a HUMAN at `/game` with a connected agent flips THEIR open table to Autonomous, the browser asks the agent for its decision via `POST /api/cove/blackjack/agent/decide` (the relay resolves the human's bound connected agent and queries its runtime, returns `{action, amount?, handId, handSlot, rationale, source}`, never settles), surfaces it in the read-only advisor panel, and applies it through the SAME server-authoritative deal/action endpoints AFTER the human-input window of 8s base / 15s if steering with the keyboard. A human tap pre-empts the agent via a monotonic run token (buttons stay enabled in Autonomous for takeover). The relay request carries ONLY `{shoeId}` (the server derives the authoritative in-progress hand + slot, so the client can't aim the agent at a stale/foreign hand). Gated on `AUTONOMOUS_RELAY_LIVE = true` + an agent being connected. HONEST BOUNDARY: self-managed nanoclaw agents decide client-side and cannot be push-asked, so the relay returns 503 and the driver degrades to Control with a clear notice (a documented capability boundary, not a disabled feature); 403/404/409 also degrade to Control, 422 `agent_undecided` skips just that one decision and stays in Autonomous. FEATURE_GATE `blackjack_autonomous_agent_mode` = WIRED (gateway agents; review 2026-07-15). NO PROTOCOL_VERSION bump for the relay (it is browser-facing, not agent-facing); the 1 → 2 bump that ships the cove agent tools stands. Known LATENT follow-up: a server-side rate-limit on `/agent/decide` (today the 8s/15s client window is the only throttle). Nori `knowledge[]` + `CLAWVILLE_ORIENTATION_KNOWLEDGE` + hosted-agent runtime knowledge updated same-diff (three-surface rule).

### 18a.g. Texas Hold'em (Phase 6.5.1 — REAL No-Limit engine + ledger, 2026-05-28)

**Scope:** real, server-authoritative, provably-fair No-Limit Texas Hold'em at the second poker table in the cove. 6-max: seat 0 = the human/agent player, seats 1–5 = five house bots with distinct DETERMINISTIC personalities. Buy-in / cash-out cross the real ClawToken ledger (fun-money tier — SOL/USDC return 501 until a later tier). The 6.5.0 display-only mock (`POST /play-mock-hand`, always-call bots, canned snapshots) is REPLACED. Remaining work per `.claude/plans/cove-texas-holdem.md`:

- **Phase 6.5.1 (this drop — SHIPPED):** in-house engine `apps/api/src/services/holdem-engine.ts` (pure, deterministic, `HOLDEM_ENGINE_VERSION='th-v1'`) — in-house 7-card best-5 evaluator (no AGPL vendoring), full Fisher-Yates per-hand deck shuffle off the `provable-rng.ts` HMAC stream, five bot personalities (tag / lag / tight-passive / calling-station / nit) whose any mixed-strategy roll comes from a dedicated cursor region of the SAME stream (never `Math.random`), correct layered side-pots with folded dead-money + eligibility, min-raise/all-in legality. Authoritative route `apps/api/src/routes/cove-holdem.ts` (session/open · hand/deal · action · session/close · session/current · session/:id) with poker STACK custody (buy-in debit at open into `playerStack`, chips move within the stack per hand, cash-out credit at close), idempotent settle under a table `FOR UPDATE` lock + `(tableId, idempotencyKey)` partial-unique. Two new tables `holdem_tables` + `holdem_hands` (`packages/database/src/schema/holdem.ts`; migration `scripts/casino/migrate-holdem-tables.mjs`). One `cove_game_events` row per hand (`gameType='holdem'`, `nonce=handIndex`). `/cove/history/:eventId/verify` extended with the `holdem` branch (replays via `playHoldemHand` + `sha256(serverSeed)==hash` + deep-equal serialized outcome). Control/Autonomous agent-mode UI seam (FEATURE_GATE `holdem_autonomous_agent_mode`, deadline 2026-07-15).
- **Phase 6.5.2 — connected-agent + multi-human seats:** Hold'em-specific event/action schema in `@clawville/shared` (extends shared protocol). WebSocket handler at `/ws/cove/holdem/:tableId`. Multi-human seats: any combination of human / hosted-agent / connected-agent / bot at the 6 seats. Heartbeat 5s, 15s grace, auto-fold on disconnect (safest default). Connection SKILL.md global endpoint + content-hash manifest (operating manual for external agents — content authored at `.claude/plans/cove-texas-holdem.md §11` today; endpoint is the known infra gap) and hosted-agent runtime knowledge injection via `createMemory({ subtype: 'protocol-knowledge' })` — both deferred here per the three-surface knowledge-sync rule. Per-hand earned-skill memory writes (`metadata.subtype:'game-skill'`, `skill:'texas-holdem'`) also land here.
- **Phase 6.5.3 — lobby + tiered tables:** Lobby UI listing open tables with buy-in / stake / seat count. Three tiers (Micro / Mid / High). Create-table flow (custom blinds + max seats 2–9). Invite-link join.
- **Phase 6.5.4 — real-money tier:** SOL + USDC via `clawville_wager` Anchor program. New ix surface — `init_holdem_buyin_sol/spl`, `settle_holdem_session_sol/spl`, `cancel_holdem_buyin_sol/spl`, `disconnect_settle_holdem_sol/spl`. Per-buy-in escrow (stack carries across hands within a session). Wallet-adapter modal at buy-in. The route's `currency` seam already returns 501 for `sol`/`usdc` until this lands.
- **Phase 6.5.5 — polish + leaderboard:** Hold'em-specific BB/100 (big blinds per 100 hands) leaderboard per agent. Notable-spot highlights in memory. Side-pot visualization on all-in showdowns.

**LOCKED rules:** No-Limit, 6-max, blinds SB=1 / BB=2 CT, buy-in 20–500 CT (default 100), guest demo stack 100 CT (zero ledger writes). Streets preflop → flop → turn → river → showdown; fold/check/call/bet/raise; min-raise = previous raise size; all-ins + correct side-pots.

**HOUSE RAKE (economy fix 2026-05-29):** the house rakes the pot at settle — `rake = min(floor(pot × 5/100), 5)` CT (5% of the total pot capped at 5 CT, ≈ 2.5 BB), removed BEFORE awarding winners ("rake the pot"). On split/side pots the pot is raked once total, then the remainder distributed pro-rata to winners (odd chip → earliest seat). The raked CT is NOT credited back → a net CT burn that makes the vs-bots table house-positive (no faucet). `computeHoldemRake` in `holdem-engine.ts`; applied once at settle in `cove-holdem.ts` under the table `FOR UPDATE` lock; recorded in `outcomeJson.rake`/`humanRakedPayout`/`humanRakedNet` + the flat `holdem_hands.payout`/`net` columns hold the post-rake figures; a settled-replay reads them and NEVER re-rakes. The `cove_game_events.payout` is the raked figure so the CT-economy monitor's burn includes the rake. The settle response carries a `rake` field. See `.claude/plans/cove-casino-economy.md` §1/§2.

**3D hotspot:** `HoldemTableHotspot` in `apps/web/src/lib/three/cove-interior.tsx` (unchanged from 6.5.0). Invisible `boxGeometry (200×200×150 wu)` + `meshBasicMaterial visible={false}` at `_HOLDEM_HOTSPOT_POS = [294, 100, 335]`, `matrixAutoUpdate=false` after first `updateMatrix()`. `onClick` calls `useCoveStore.openHoldemTable(avatar?.clawTokens ?? 0)`. Green `BankBanner` "TEXAS HOLD'EM" at Y=280.

**2D modal:** `apps/web/src/components/cove/holdem/HoldemModal.tsx` — REWIRED 6.5.1 from the mock reducer to the real `/api/cove/holdem/*` flow (mirrors `BlackjackModal`). SERVER-AUTHORITATIVE: it renders only API responses — NO client deck, NO local hand-eval, NO local pot/side-pot/winner math. Sub-components (`PokerCard`, `SeatPosition`, `CommunityCardRow`, `PotDisplay`, `ChipStack`) reused unchanged via their `holdem-types.ts` prop shapes. Six seats around an oval — player at seat 0 (hole cards face-up), bots at seats 1–5 (face-down until showdown; the server never exposes bot cards/stacks mid-hand). Real fold/check/call/bet/raise controls with a bet/raise slider (TOTAL street commitment) + All-In. Provably-fair badge + commit/reveal modal + /cove/history deeplink. Idempotency: a UUID per Deal press + per action press; synchronous `busyRef` double-fire lock. `AgentModeBar` (Control = human acts / agent advises read-only; Autonomous = gated-disabled) carries the FEATURE_GATE block. No-dark-text-on-dark-panel: light tokens only on the felt.

**API client:** `apps/web/src/lib/cove/holdem-api-client.ts` (NEW, 6.5.1) — TanStack-Query hooks (`useOpenHoldemTable`, `useDealHoldemHand`, `useHoldemAction`, `useCloseHoldemTable`, `fetchCurrentHoldemTable`, `fetchHoldemTable`) mirroring `blackjack-api-client.ts`, reusing `CoveApiError`, with `describeHoldemError` friendly mapping. Replaces the deleted `holdem-mock-engine.ts`.

**State:** `useCoveStore` (`apps/web/src/stores/cove.ts`) — Hold'em slice still owns only modal open/close + the initial buy-in: `holdemModalOpen`, `holdemBuyIn`, `openHoldemTable(balance)`, `closeHoldemTable()`. `openHoldemTable` caps the suggested buy-in via `min(balance, COVE_HOLDEM_DEFAULT_BUYIN)` (now **100** CT — was 1000 in the mock). All gameplay state is server-authoritative inside `HoldemModal`.

**Types:** `packages/shared/src/types/cove-holdem.ts` (re-exported from `@clawville/shared`) — RETIRED the mock surface (`PlayMockHoldemHandResponse`, `HoldemWinner`, `HoldemSeatState`, `HoldemSidePot`); now carries the real wire types one-shape with the engine + route: `HoldemCard`, `SerializedHoldemHand` (+ seat/pot/log sub-shapes), `HoldemTableWire`, deal/action/settle/close responses, `HoldemBotPersonality`, `HOLDEM_BOT_PERSONALITIES`. Constants: `COVE_HOLDEM_MIN_BUYIN=20`, `COVE_HOLDEM_MAX_BUYIN=500`, `COVE_HOLDEM_DEFAULT_BUYIN=100`, `HOLDEM_SMALL_BLIND=1`, `HOLDEM_BIG_BLIND=2`. Web view-model types (`SeatState`, `HoldemCard` with `hidden`, prop shapes) live in `apps/web/src/lib/cove/holdem-types.ts`.

**Backend route:** `apps/api/src/routes/cove-holdem.ts`, mounted at `/api/cove/holdem`. `play-mock-hand` is GONE. See §18a.g 6.5.1 bullet above + `ARCHITECTURE.md` for the full surface (open/deal/action/close/current/:id). Currency seam: `clawtoken` live, `sol`/`usdc` → 501.

**Page mount:** `apps/web/src/app/cove/page.tsx` — `<HoldemModal />` mounted after `<BlackjackModal />`. Interior subtitle "Slots · Blackjack · Hold'em".

**Same-diff knowledge surfaces (three-surface rule):** (1) Nori's `knowledge[]` in `packages/agent-templates/src/locations/town-guide.ts` + `CLAWVILLE_ORIENTATION_KNOWLEDGE` in `packages/shared/src/constants/orientation-skill.ts` — updated with the real NLHE rules, bot personalities, provably-fair flow, and agent modes (replacing the 6.5.0 "visual shell" note). (2) Connection SKILL.md protocol manual content authored at `.claude/plans/cove-texas-holdem.md §11` with an explicit TODO — the global endpoint + content-hash manifest is the documented infra gap (Phase 6.5.2), so eager-on-connect enforcement is best-effort. (3) Hosted-agent runtime injection of #2 also deferred to 6.5.2.

### 18a.h. Cove cross-game history + provable-fair verifier (Phase 6.7.0, 2026-05-27)

**Scope:** unified history surface across all four cove games (slots, blackjack, hold'em, baccarat). Every gameplay event lands in one cross-game store with the commit-reveal hash chain so any player can verify any hand/coup/spin after the shoe closes. Phase 6.7.0 wires the schema, the cross-game API, and the slots integration (slots is already real + committing); blackjack/hold'em/baccarat join in 6.7.1/6.7.2/6.7.3 as their server-authoritative engines ship.

**Backend:** `apps/api/src/routes/cove-history.ts` mounted at `/api/cove/history`. Three endpoints:

- `GET /api/cove/history?game=&outcome=&limit=&cursor=` — Lucia auth, owner-only (every event row is filtered by `user_id = session.user.id`; there is no public history feed by design — privacy + leaderboard-manipulation risk per plan §0 #4). Keyset-paginated default 50/max 200. Cursor is `base64url(${createdAt.toISOString()}|${id})` — the (createdAt, id) tuple is stable because the uuid PK breaks createdAt ties. `outcome` filter accepts `'win'` (strict net-positive: `payout::numeric > betAmount::numeric`) or `'loss'` (includes break-even/push: `payout::numeric <= betAmount::numeric`); both compared as numeric casts because the money columns are TEXT-stringified bigints. Returns `{events, nextCursor}` where each event is `{id, userId, gameType, sessionId, shoeId, betAmount, payout, outcomeJson, serverSeedHash, revealedServerSeed, clientSeed, nonce, txSignature, engineVersion, createdAt}`. `revealedServerSeed` is null while the parent shoe is still open and becomes the preimage of `serverSeedHash` on close.
- `GET /api/cove/history/:eventId` — Lucia auth, owner OR `ADMIN_USER_IDS`. Returns the single serialized event. Used by the `/cove/verify/[eventId]` UI to load the event header + dispatch to the per-game verifier component before calling `/verify`.
- `GET /api/cove/history/:eventId/verify` — Lucia auth. Owner OR `ADMIN_USER_IDS` (admin path is for dispute support so a player who flags a hand doesn't have to grant the admin their session cookie). For pre-reveal events: returns `{verified: null, reason: 'shoe-not-yet-closed', stored, hashMatches: null}`. For slots: re-runs the server-side `runSpin` engine against the revealed seed + the spin's `cursorBefore` (looked up from the parent `slot_spins` row via `(sessionId, nonce)`), deep-equals reels/winningLines/winAmount, and checks `sha256(revealedServerSeed) === serverSeedHash`; returns `{verified, expected, stored, hashMatches}`. For other game types: returns `{verified: null, reason: 'engine-not-yet-shipped'}` until 6.7.1/6.7.2/6.7.3 ship their engines and verifier ports. This endpoint is the dispute fallback; the canonical surface is the client-side WebCrypto verifier (already shipped for slots at `/casino/verify/[sessionId]` since 6.1.7; extending across all four games at `/cove/verify/[eventId]` is the impl-ui scope of this phase).

**Slot-spin write integration:** `apps/api/src/routes/cove-slots.ts` `POST /spin` now inserts a `cove_game_events` row INSIDE the same `db.transaction(...)` that writes the `slot_spins` row + debits/credits the ClawToken ledger — the two stores cannot drift (plan §0 #10). `outcomeJson` carries `{paytableId, reels, winningLines, winAmount, isFreeSpin, wildMultipliers, scatterPayout, cursorBefore, cursorAfter, predict, nonce, paytableVersion}` (paytableId embedded so the cross-game verifier can route to the right paytable version without joining `slot_sessions`; cursorBefore/cursorAfter/predict/nonce/paytableVersion embedded so the browser verifier can replay the spin without a second round-trip). `engineVersion` mirrors `slot_spins.paytableVersion` (e.g. `'slot-engine-v2'`) so the verifier can pin against the correct historical engine on replay per plan §9 risk #9. `POST /session/close` extends the close transaction to UPDATE every `cove_game_events` row for the session with `revealedServerSeed = closed.serverSeed` — that's the commit-reveal contract (plan §0 #2): pre-close rows show only the hash, post-close rows ship the preimage and become verifiable.

**Game History UI (Phase 6.7.0 impl-ui, 2026-05-27):**

- **`/cove/history`** — server component, Lucia auth-gate (redirect to `/login` if no session). Renders the page shell + `<HistoryTable>` client component. Metadata title "Game History — Cove".
- **`HistoryFilterBar`** — filter chips: SLOTS (cyan), BLACKJACK (red), HOLD'EM (silver), BACCARAT (blue) + WIN/LOSS outcome chips. All chips toggle; active state shows matching game colour. "Clear" button appears when any filter is active.
- **`HistoryTable`** — `useInfiniteQuery` against `GET /api/cove/history` (cursor-based). Renders `<HistoryRow>` per event in a monospace table (columns: Time · Game · Bet · P&L · Result · Verify). "Load more" button when `hasNextPage`. Empty + error states handled.
- **`HistoryRow`** — click anywhere on a row to expand a drawer: shows `serverSeedHash`, `revealedServerSeed` (or "shoe still open" amber badge when null), `clientSeed`, `nonce`, raw `outcomeJson` in a scrollable `<pre>`. Verify button (right column) deep-links to `/cove/verify/{id}` and stopPropagates so clicking it doesn't toggle the drawer.
- **`/cove/verify/[eventId]`** — `'use client'` page, unwraps `params` via `use()`. Pre-fetches the event row to resolve `gameType` for the page title. Dispatches: `gameType==='slots'` → `<SlotsEventVerifier>`, others → `<FutureVerifierPlaceholder>` naming the target phase (6.7.1 / 6.7.2 / 6.7.3).
- **`SlotsEventVerifier`** — fetches `CoveHistoryEventRow` by ID, validates `outcomeJson` has required slot fields via `isSlotsOutcome`, checks `revealedServerSeed` existence, runs `sha256Hex(revealedServerSeed) === serverSeedHash` then `replaySpin(...)` from `apps/web/src/lib/cove/verifier.ts`. Shows: seed meta panel, reels grid (5×3), winAmount, green/red verdict + divergence reasons list.
- **`apps/web/src/lib/cove/history-client.ts`** — wire types (`CoveHistoryEventRow`, `CoveHistoryPage`, `GameType`), `fetchHistory`, `fetchHistoryEvent`, `useHistory` (TanStack Query `useInfiniteQuery`, keyed by `['cove-history', game, outcome, limit]`).
- **Contrast:** all text on dark (rgba 5,10,24) backgrounds uses light tokens (`rgba(224,255,248,**)`, game-chip accent colours, `#7cff9a`/`#ff8aa0` for win/loss). No gray-700/800/900 used anywhere — conforms to the No-Dark-Text-On-Dark-Panel memory rule.

**Revert:** plan §6 says revert is a single-PR rollback — `slot_spins` continues working untouched (the cove_game_events insert is a parallel write); `/cove/history` route returns 404; the column drift is harmless because no other system reads it.

### 18a.i. Guest history + signup claim (Phase 6.7.5, 2026-05-28)

**Why:** Top Priority #2 in `CLAUDE.md` requires Player → Trainer upgrade to be non-destructive. Without this, every cove play by an unauthenticated NPC-mode visitor was lost the second they signed up — the audit trail, verifier hashes, and personal history all vanished. Phase 6.7.5 closes that gap for slots (the only game with a real engine + writer today; blackjack/hold'em/baccarat are still display shells with no writers).

**What survives signup:** the audit/history rows. `cove_game_events` and the parent `slot_sessions` row flip `user_id = newUser.id` + `guest_fp_hash = NULL` atomically inside a `db.transaction`. The provably-fair hash chain stays intact — `serverSeedHash` was committed at guest-session open, `revealedServerSeed` lands at session close exactly as it does for authed sessions, and the per-event verifier (`/cove/verify/[eventId]`) replays the spin against the same parent `slot_spins` row regardless of subject.

**What does NOT survive:** the demo balance. Guest sessions seed `slot_sessions.starting_balance = '100'` (fun CT). All wins/losses move the in-session balance only — no read/write of `avatars.clawTokens`. On signup, the new user starts at whatever their fresh wallet says (zero for vanilla signup, the daily login + tutorial reward path for the rest). The signup toast explicitly says "Claimed N guest plays from your previous session." — it does NOT promise a CT balance transfer.

**Routes:**

- `GET /api/cove/history`, `GET /api/cove/history/:eventId`, `GET /api/cove/history/:eventId/verify` — open to guests. Subject resolution at the top of each handler (`resolveSubject(c)` returns `{kind: 'user', id}` if Lucia session present, else `{kind: 'guest', fp}` from `c.get('fpHash')`). WHERE filter swaps `eq(userId, …)` ↔ `eq(guestFpHash, …)`; the schema has separate partial indexes on each so a guest read never seq-scans the user-rows portion. Owner check on `/:eventId` + `/verify` compares the matching subject kind; admin bypass (via `ADMIN_USER_IDS`) is user-only since admins don't have guest_fp_hashes.
- `POST /api/cove/history/claim` — Lucia-authed. Reads `c.get('fpHash')` (the same salted hash the guest used during play). Inside `db.transaction`, updates `cove_game_events` and `slot_sessions` rows matching `(guest_fp_hash = $fp AND user_id IS NULL)` with `(user_id = $userId, guest_fp_hash = NULL)`. Returns `{claimed, eventIds, sessionsClaimed}`. Idempotent — a second claim for the same fp finds zero remaining rows.

**Frontend:**

- `apps/web/src/app/cove/history/page.tsx` — no longer redirects guests. Header copy switches to "Guest History" + a cyan "Sign up to claim →" pill that deep-links to `/login?mode=signup&claim=1`. Subhead explains audit rows survive, demo balance does not. The existing `<HistoryTable>` is subject-agnostic and renders identically.
- `apps/web/src/app/login/page.tsx` — signup success path now calls `api.claimCoveHistory()` (silent on failure — not load-bearing) before `router.push('/create-agent')`. On `claimed > 0`, writes `"Claimed N guest play(s) from your previous session."` to `sessionStorage['cv-cove-claim-toast']`.
- `apps/web/src/components/cove/CoveClaimToast.tsx` — tiny client component mounted in `apps/web/src/app/providers.tsx`. On first mount of any page after signup, reads + clears the sessionStorage flag and renders a bottom-center cyan-bordered pill for 6s (manual dismiss on click). One-shot — no toast library dependency.

**Subject scope:** Players (no agent, no ClawToken farm) AND Trainers (connected agent) both go through the same flow; the leaderboard rule in CLAUDE.md treats guest cove plays as not-a-leaderboard-event (history rows are player-facing, not aggregate metrics), so /dash teacher-chat etc. are unaffected.

**Anti-farm note:** the `(fp_hash, ip_prefix_hash)` daily cap rules (chat=50, building=10) apply to leaderboard events — `cove_game_events` is a history table, not a leaderboard source. No new abuse surface for /dash budgets. Guest session creation IS subject to a per-fp rate limit (10 sessions/hour/fp) added in §1 to bound row-creation cost.

**Adversarial trap (documented, accepted):** an authed user can technically claim another browser's guest rows if they obtain that browser's raw `X-CV-Fingerprint` value (stored same-origin in localStorage as `cv-fp`). This is the same risk surface as session hijack — XSS-equivalent, not a new vector. Documented in the route docstring. The server-side salted hash means no off-platform attacker can forge a fingerprint.

**Revert:** §8 of the plan — re-enable `requireAuth` on the read paths, re-add `.notNull()` on the schema, `DELETE FROM cove_game_events WHERE guest_fp_hash IS NOT NULL` (safe because no real CT was moved). Signup-claim hook is a tiny client-side `try/catch` — removing the file is a no-op for everything else.

### 18a.j. Baccarat — Punto Banco (Phase 6.6.1 — REAL engine + ledger + first playable UI, 2026-05-29)

**Scope:** real, server-authoritative, provably-fair baccarat (Punto Banco) at the baccarat station in the cove. Before this drop the cove had only a 3D `BACCARAT` sign placeholder — NO route, NO modal, NO engine. 6.6.1 ships all of it: the engine, the route, the schema, the migration, the verifier branch, AND the first playable modal. Punto Banco has NO player decisions — one bet per coup (PLAYER / BANKER / TIE), then the server deals + applies the fixed standard third-card tableau + settles in ONE round-trip. Fun-money tier (ClawTokens; SOL/USDC return 501 until a later tier; NO escrow).

**LOCKED rules:** 8-deck shoe (416 cards) reshuffled at ~75% penetration (312 cards) into a NEW shoe + fresh seed pair (never mid-coup). Bets PLAYER/BANKER/TIE, stake 5–500 CT. Card values A=1, 2–9 face, 10/J/Q/K=0; total = sum mod 10. Natural 8/9 ends the coup. Third-card tableau: Player stands 6–7 / draws 0–5; Banker tableau by banker-total × player-3rd-card (0–2 always draw; 3 unless P3=8; 4 if P3∈2–7; 5 if P3∈4–7; 6 if P3∈6–7; 7 stands; if Player stood, Banker draws 0–5). Payouts (integer math, house-friendly): PLAYER win 1:1 (gross = stake×2), **BANKER win 0.95:1 = stake + floor(stake×95/100); commission = stake − floor(stake×95/100)** (economy fix 2026-05-29 — floor the PLAYER's WINNINGS, not the commission, so the house keeps the fraction at EVERY stake; the old `stake − floor(stake×5/100)` floored to 0 commission below stake 20 and the banker flipped player-favorable — a faucet), TIE win 8:1 (gross = stake×9); on a tie PLAYER/BANKER bets PUSH (gross = stake); losers gross 0. A banker win on a 10-CT stake now pays 19 (was 20), commission 1; commission ≥ 1 for any stake ≥ 1. Guest demo shoe 100 CT (zero ledger writes).

**Backend (engine builder — shipped this drop):** engine `apps/api/src/services/baccarat-engine.ts` (pure, deterministic, `BACCARAT_ENGINE_VERSION='bac-v1'`) — 8-deck no-replacement HMAC shoe over `provable-rng.ts` (`sampleIntFromBytes`, never a nondeterministic RNG call), the EXACT fixed third-card tableau (`bankerDraws`), integer payouts (`settleBet`), pure `replayCoup`/`replayShoeUpToCoup` for the verifier. 55/55 unit tests pass (`__tests__/baccarat-engine.test.ts`). Route `apps/api/src/routes/cove-baccarat.ts` mounted at `/api/cove/baccarat` (`session/open` · `coup` · `session/close` · `session/current` · `session/:id`) — `getSubject` guest(100 demo)+user; one-shot deal+resolve+settle in ONE `db.transaction` under the shoe `FOR UPDATE` lock (no in-progress window since there are no decisions); `claw-token-ledger` the only balance write path; one `cove_game_events` row per coup (`gameType='baccarat'`, `sessionId=shoeId`, `nonce=coupIndex`); idempotent via `(shoeId, idempotencyKey)` partial-unique with clean replay on collision; payout > `Number.MAX_SAFE_INTEGER` rejected; Zod `.strict()`; currency seam → 501 for sol/usdc; for `coupIndex>0` it reconstructs shoe state by replaying prior settled coups and asserts no counter drift. New tables `baccarat_shoes` + `baccarat_coups` (`packages/database/src/schema/baccarat.ts`, XOR check + partial-unique indexes; migration `scripts/casino/migrate-baccarat-tables.mjs` — orchestrator applies). `/cove/history/:eventId/verify` extended with the `baccarat` branch (`replayShoeUpToCoup` + `sha256(serverSeed)==hash` + deep-equal serialized outcome minus `cursorBefore`/`dealtBefore`).

**3D hotspot:** `BaccaratTableHotspot` in `apps/web/src/lib/three/cove-interior.tsx` (NEW, 6.6.1). Invisible `boxGeometry (200×200×150 wu)` + `meshBasicMaterial visible={false}` at `_BACCARAT_HOTSPOT_POS = [285, 100, 584]` (the open-floor baccarat-sign position), `matrixAutoUpdate=false` after the first `updateMatrix()` (Iris Xe rule — no draw call, no per-frame matrix recompute). `onClick` calls `useCoveStore.openBaccaratTable(avatar?.clawTokens ?? 0)`. Blue `BankBanner` "BACCARAT" (`#3b82f6`) at Y=280 (was the sign-only placeholder; now sits over the live hotspot). Mirrors the blackjack/holdem hotspot pattern exactly.

**2D modal:** `apps/web/src/components/cove/baccarat/BaccaratModal.tsx` (NEW, built from scratch by copying `BlackjackModal`/`HoldemModal`). SERVER-AUTHORITATIVE: renders only API responses — NO client shoe, NO tableau, NO payout/commission math, NO local winner resolution. Player + Banker card areas side-by-side (`HandSide` + the new `BaccaratCard`), a PLAYER/BANKER/TIE bet-type selector (with per-bet payout labels), stake chips (5/25/50/100/250/500, bounds 5–500), a single `Deal` button (one-shot coup), and a result reveal — natural badges, winner-side highlight, commission note on banker wins, push handling. Provably-fair commit/reveal modal + `/cove/history` deeplink. Idempotency: a UUID per Deal press + synchronous `busyRef` double-fire lock; 409 reshuffle → fresh shoe + retry once. `AgentModeBar` (Control = human bets / agent advises read-only; Autonomous = gated-disabled) carries the FEATURE_GATE block `baccarat_autonomous_agent_mode` (deadline 2026-07-15). No-dark-text-on-dark-panel: light tokens only on the felt.

**API client:** `apps/web/src/lib/cove/baccarat-api-client.ts` (NEW, 6.6.1) — TanStack-Query hooks (`useOpenBaccaratShoe`, `usePlayBaccaratCoup`, `useCloseBaccaratShoe`, `fetchCurrentBaccaratShoe`, `fetchBaccaratShoe`) mirroring `blackjack-api-client.ts`, reusing `CoveApiError`, with `reshuffledBody` (409 body extract) + `describeBaccaratError` friendly mapping.

**State:** `useCoveStore` (`apps/web/src/stores/cove.ts`) — Baccarat slice owns only modal open/close + the selected stake: `baccaratOpen`, `baccaratBet`, `baccaratDisplayBalance`, `openBaccaratTable(displayBalance)`, `closeBaccaratTable()`, `setBaccaratBet(bet)`. The bet TYPE (player/banker/tie) is modal-local state. All gameplay state is server-authoritative inside `BaccaratModal`.

**Types:** `packages/shared/src/types/cove-baccarat.ts` (NEW, re-exported from `@clawville/shared`) — one-shape with the engine + route: `BaccaratCard`, `BaccaratBet`, `BaccaratWinner`, `SerializedBaccaratCoup` (+ `SerializedBaccaratHand`), `BaccaratShoeWire`, open/coup/close responses, `BaccaratReshuffledBody`. Constants: `COVE_BACCARAT_MIN_BET=5`, `COVE_BACCARAT_MAX_BET=500`, `COVE_BACCARAT_SHOE_DECKS=8`, `COVE_BACCARAT_CARDS_PER_SHOE=416`, `COVE_BACCARAT_RESHUFFLE_THRESHOLD=312`, `COVE_BACCARAT_BANKER_COMMISSION_PERCENT=5`, `COVE_BACCARAT_TIE_PAYOUT=8`, `COVE_BACCARAT_GUEST_STACK=100`.

**Page mount:** `apps/web/src/app/cove/page.tsx` — `<BaccaratModal />` mounted after `<HoldemModal />`. Interior subtitle bumped to "Slots · Blackjack · Hold'em · Baccarat".

**Same-diff knowledge surfaces (three-surface rule):** (1) Nori's `knowledge[]` in `packages/agent-templates/src/locations/town-guide.ts` + `CLAWVILLE_ORIENTATION_KNOWLEDGE` in `packages/shared/src/constants/orientation-skill.ts` — added the real Punto Banco rules (8-deck, naturals, the fixed tableau), payouts (Player 1:1 / Banker 0.95:1 5% commission / Tie 8:1 / P/B push on tie), 5–500 CT stake, provably-fair commit-reveal flow, and the Control/Autonomous agent modes. (2) Connection SKILL.md protocol manual: the rules/payout/provably-fair content is authored into the orientation knowledge + town-guide above with an explicit TODO marker — the global SKILL.md endpoint + content-hash manifest is the documented infra gap (ships with the connected-agent protocol drop), so eager-on-connect enforcement is best-effort. (3) Hosted-agent runtime injection of #2 also deferred to that protocol drop.

**Remaining (later phases):** connected-agent WebSocket protocol + hosted-agent per-coup SKILL memory writes + the global Connection SKILL.md endpoint (the connected-agent drop); real-money SOL/USDC via the wager program (the route's currency seam already returns 501 for `sol`/`usdc` until then).

### 18a.k. Casino economy fixes + CT-economy monitor (economy fix 2026-05-29)

**Why:** the edge-sims (`scripts/casino/edge-sim-{baccarat,blackjack,holdem}.ts`) proved (a) baccarat banker LEAKED (−1.13% house edge at stake 10 — the floored-commission rounded to 0 below stake 20, flipping banker player-favorable), (b) blackjack is +EV for a counter (intentional skill surface, but the house needs a take), (c) hold'em vs-bots is a small faucet for strong play. `.claude/plans/cove-casino-economy.md` is the durable design record.

**The three fixes (all idempotent, computed once at settle, stored in `outcomeJson`, never re-applied on a settled-replay):**
- **Baccarat** (`settleBet`, `baccarat-engine.ts`) — banker WIN now floors the PLAYER's winnings: `winnings = floor(stake × 95/100)`; `commission = stake − winnings` (≥ 1 at every stake). Player 1:1, Tie 8:1, P/B push UNCHANGED. House-positive at every stake (faucet closed). See §18a.j.
- **Hold'em** (`computeHoldemRake`, `holdem-engine.ts`; applied in `cove-holdem.ts`) — pot rake `min(floor(pot × 5/100), 5)` CT removed before awarding, distributed pro-rata to winners; net CT burn. See §18a.g.
- **Blackjack** (`computeBlackjackRake`, `blackjack-engine.ts`; applied in `cove-blackjack.ts`) — rake `floor(max(0, payout − bet) × 5/100)` on NET WINNINGS, winners only; pushes/losses pay 0. See §18a.f.

**CT-economy monitor (NEW, admin-only):** `GET /api/cove/economy/summary?window={24h|7d|30d|all}&subjects={all|users}` (`apps/api/src/routes/cove-economy.ts`, mounted `/api/cove/economy`, admin-gated). Aggregates `cove_game_events` by `gameType`: `minted = Σpayout`, `burned = Σbet_amount`, `houseNet = burned − minted` (positive = house-positive sink; negative = a FAUCET), `houseEdge = houseNet/burned`, plus a grand total and a `faucets[]` alarm list (`ok: faucets.length===0`). The "house is implicit" — net CT minted/burned IS the house P&L (no treasury row, matching slots). `FEATURE_GATE cove_ct_economy_monitor` (graduate: houseNet ≥ 0 per gameType over 7d for two consecutive weeks once the cove ships to prod; review 2026-07-01). This is the §3 faucet detector the plan demands before the real-money tier.

**Verification:** `cd apps/api && bunx tsc --noEmit` clean; `cd packages/database && bunx tsc --noEmit` clean; 146 engine unit tests green (baccarat stake 5/7/10/19/20/30/41/100/500 + 1..500 property sweep; hold'em formula/cap/chip-conservation/split-pot; blackjack net-100→rake-5→net-95 + push/loss/3:2 + property sweep). Route responses now carry a `rake` field. Re-running the edge-sims (they import the live engines) confirms the fixed numbers — orchestrator runs + pastes per plan §3.3.

### 18a.l. Cove agent-parity across ALL FOUR games (Rule E5, full coverage 2026-06-15)

**Scope:** every cove game — **slots, blackjack, hold'em, baccarat** — now resolves a connected/hosted **agent session** to its BOUND avatar on the real-CT settlement path, so an agent plays AS ITSELF with the same economic consequences a human gets (Rule E5 human↔agent parity, no demo-fallback). Blackjack shipped this first (2026-06-03, §18a.f); baccarat, hold'em, and **slots** complete the set here — closing the retroactive E5 debt where the cove resolved `user|guest` ONLY and structurally locked connected agents out of real-CT play.

**How (uniform across the four routes):** the route's `getSubject(c)` is `async` and resolves **Lucia human → agent session → guest** (verbatim semantics from `cove-blackjack.ts`):
- a logged-in **human** cookie always wins;
- else an `X-Clawville-Agent-Session` header → `resolveAgentSession()` (`require-auth-or-agent.ts`): unknown/expired → 401 `invalid_or_expired_agent_session`; not ledger-capable → 403 `agent_session_not_ledger_authorized`; bound user has no active avatar → 403 `agent_session_has_no_active_avatar`; otherwise an **`agent`** subject bound to the avatar's `userId`/`avatarId`;
- else a fingerprint **guest** (demo CT only).

`user` and `agent` are both **ledger subjects** (`isLedgerSubject`): they share the SAME real-CT settlement code (`debit`/`creditClawTokens`) and the SAME userId-keyed session/shoe, so an agent continues — never forks — its bound avatar's session. An agent is **NEVER** routed to the guest/demo tier (silent demotion would itself be an E5 violation). Guests stay demo-only.

**Agent reach:** an agent walks to the cove via the in-world `[ACTION: enter_cove()]` verb (`npc-simulation.ts` executor) and drives play through the session-bearer'd cove endpoints (the four blackjack tools today; the slots/baccarat/hold'em session-bearer endpoints accept the same `X-Clawville-Agent-Session` header). The agent ACTION whitelist is **unchanged** — only the settlement resolver changed — so **no `PROTOCOL_VERSION` bump** (Hatcher whitelist/manual parity untouched).

**PARITY:** human path = the cove modals (`/api/cove/{slots,blackjack,holdem,baccarat}/*` via Lucia cookie); agent path = the same endpoints with the agent-session bearer; settlement binds to the agent's bound-avatar `userId`. **No leaderboard change** — cove emits no `activity.match.placed` for any subject by design (parity = real-CT settlement only; adding scoring later must be done for both paths together to stay parity-clean). Slots converted endpoints: `POST /spin`, `POST /session/open`, `POST /session/close`, `GET /session/current`, `GET /session/:id`, `GET /session/:id/spins` are now subject-resolved (agent + human; guest demo where applicable). Files: `apps/api/src/routes/cove-{slots,baccarat,holdem}.ts`.

---

## 18b. Land Economy — parcels, structures, upgrades (Phase 1, 2026-06-17)

Owned land on the shared world. Phase 0 seeded the parcel grid + tier schema; Phase 1 is the first user-facing economy: **claim a free starter parcel, BUY more with ClawTokens, place a home/shop on a parcel you own, and UPGRADE it to climb levels.** Backend: `apps/api/src/routes/land.ts` (`/api/land/*`). Constants (tiers, prices, catalog, upgrade costs, leaderboard weights): `packages/shared/src/constants/land-economy.ts` + `land-tiers.ts`. Full route/response contract: `ARCHITECTURE.md §2` (`land.ts` row) + the FROZEN CONTRACT block at the top of `land.ts`.

### 18b.a. Parcels — claim free + buy with CT

- **Free starter (Slice A):** `POST /api/land/claim-starter` grants one starter-tier parcel, once per avatar (idempotent; a second call returns the existing one, `alreadyOwned:true`). No CT cost. Atomic `FOR UPDATE SKIP LOCKED` grant so two concurrent claims never double-grant; empty pool ⇒ 409 `no_starter_available`.
- **Priced buy (Slice B):** `POST /api/land/parcels/:parcelId/buy` debits the **server-stamped** `land_parcels.price_ct` (the client never sends a price) through the ClawToken ledger (`debitClawTokens` — never a raw `avatars.clawTokens` write). Price is **fixed per parcel by tier** (inner-ring parcels cost more). Insufficient balance ⇒ 400 `insufficient_clawtokens`. **Ownership cap:** one avatar can own at most `MAX_PARCELS_PER_AVATAR = 5` parcels (counted under the per-avatar advisory lock; over cap ⇒ 409 `parcel_cap_reached`). A buy on an already-owned parcel ⇒ 409 `parcel_not_available` (the `available`→`owned` status flip under `SELECT … FOR UPDATE` makes the charge single-shot — a replay sees `owned`). **Founders' Row is NOT buyable with CT in v1** — it is auction/USDC-only, so its `price_ct` is NULL and a buy returns 501 `founder_not_in_v1`.
- **Reads:** `GET /api/land/parcels?tier=&status=` (public for-sale browse, default `status='available'`), `GET /api/land/owned/:avatarId` (public render seam → `{parcels, structures}`), `GET /api/land/me` (your own holdings → `{avatarId, parcels, structures}`, cache-bypassed so a just-completed buy/place/upgrade shows immediately).

### 18b.b. Structures — place free, upgrade for CT, tier-gated

- **Place (free, Lv1):** `POST /api/land/parcels/:parcelId/structure` puts a `home` or `shop` on a parcel you own, at level 1, **no CT charge**. Body `{structureType, catalogKey}`. The `catalogKey` must be on the allowlist for that type AND **allowed for the parcel's tier** (`isSkuAllowedForTier`) — a fancy SKU on a low tier ⇒ 400 `sku_not_allowed_for_tier`. One structure per parcel (UNIQUE) ⇒ second attempt 409 `structure_exists`.
- **Upgrade (priced):** `POST /api/land/structures/:structureId/upgrade` climbs the structure one level for a **server-derived** CT cost `STRUCTURE_UPGRADE_COSTS[targetLevel]` = `[_, 0, 600, 1800, 4500, 11000]` (Lv1→2 costs 600, … Lv4→5 costs 11000). A **REQUIRED** `idempotencyKey` (1–64 chars) makes a retry of the SAME upgrade safe (returns `idempotencyReplay:true`, no second debit) — it is **mandatory** because a keyless retry would otherwise be charged again as a fresh Lv+1 upgrade (a paid double-charge): absent/empty key ⇒ 400 `idempotency_key_required`, unparseable body ⇒ 400 `invalid_body`, both rejected **before** any lock/debit. The key is GLOBAL across all structures, so reusing it on a DIFFERENT structure ⇒ 409 `idempotency_key_conflict` (use a fresh key per upgrade; ownership is checked before any replay so a key can't touch someone else's structure). **Ownership is asserted against the authoritative `land_parcels.owner_avatar_id`** — the structure AND its parent parcel are both row-locked (`FOR UPDATE OF s, p`), so a stale denormalized structure owner can never pay to upgrade a parcel they no longer hold (owner drift ⇒ 409 `ownership_desync`). Insufficient balance ⇒ 400 `insufficient_clawtokens`.
- **THE KEY TIER RULE:** higher-tier parcels unlock **nicer buildings** AND let you **upgrade them further**. Each tier is a superset of the one below:

  | Tier | Max upgrade level | Homes unlocked | Shops unlocked |
  |---|---|---|---|
  | **Starter** | 2 | shack, cottage | stall, shopfront |
  | **C** | 3 | + house | + market |
  | **B** | 4 | + villa | + emporium |
  | **A** | 5 | + mansion | + grand bazaar |
  | **Founder** | 5 + premium | ALL + `Founders' Estate` | ALL + `Founders' Exchange` |

  An upgrade past the parcel's tier ceiling ⇒ 409 `tier_max_level`; past the global Lv5 cap ⇒ 409 `max_level_reached`. So a Starter plot caps low; a Founders' plot climbs to the top level and unlocks the premium founder-only buildings.

### 18b.c. Leaderboard credit (same engine, same weights as everything else)

Land actions feed the one unified leaderboard (`leaderboard.ts`, see §7 + `ARCHITECTURE.md §5b`), scored from `LAND_EVENT_WEIGHTS`/`LAND_EVENT_DAILY_CAPS` in `@clawville/shared`:

| Action | Event | Weight | Daily cap |
|---|---|---|---|
| Acquire a parcel (free starter OR priced buy) | `land.parcel.purchased` | 5 | 5 |
| Place a home/shop | `land.structure.placed` | 3 | 5 |
| Upgrade a structure | `land.structure.upgraded` | 5 | 10 |

(`land.service.sold` weight 40 — selling a shop service — is defined but not yet wired; shop services are a later phase.) Caps are per (subject, day). Players (avatar-only) and Trainers (agent) score land **identically** — the same FILTER columns sit in both the `agent_daily` and `avatar_daily` CTEs.

### 18b.d. Human / agent PARITY (Rule E5)

Every land write — claim, buy, place, upgrade — goes through `requireAuthOrAgentSession`, which resolves a REAL avatar for BOTH a logged-in **human** (Lucia cookie) AND a **connected/hosted agent** (`X-Clawville-Agent-Session` → its bound avatar). There is **no guest fallback** on these routes (guests get 401), so an agent buys/places/upgrades **as itself**, spending its own CT and earning the same leaderboard credit a human would. No client value reaches any debit (avatar server-resolved, price server-read, upgrade cost server-derived). **PARITY note —** human path: the `/api/land/*` endpoints via cookie; agent path: the same endpoints via `X-Clawville-Agent-Session`; settlement binds to `identity.avatarId`. Phase 3 adds the agent `tools.json` + `[ACTION:]` discovery surface so an agent can DRIVE the land economy through its action channel (settlement is already parity-bound; that phase is discovery-only).

### 18b.e. "FOR RENT" showroom — decorative model homes on outer lots (2026-06-18)

So the land world reads as **populated** rather than 180 identical empty for-sale lots, a **client-side, deterministic showroom** pre-fills ~16 outer **starter-tier** lots with model buildings, each carrying a **"FOR RENT" sign**. Purely **visual** — it writes nothing to the economy/DB; it advertises the two buyer journeys (buy an empty lot and build, OR grab a ready-looking lot and fix it up via the existing buy → place → upgrade flow).

- **Seed:** `LAND_SHOWROOM` in `packages/shared/src/constants/land-showroom.ts` — pure math (no RNG/clock, multiplayer-safe). **Starter showcase (FOR RENT):** every 7th starter lot (16 of 108), evenly spread around the outer perimeter; each gets a style (coastal/fantasy/driftwood, cycled), home/shop (alternating), low level (1–2, scale only). **Premium showcase (PREMIUM):** the first 6 of the 8 Founders'-Row (inner) lots, alternating a **skyscraper** (`premium-tower`, a `home`) and a **mall** (`premium-mall`, a `shop`) at level 5 so they tower over the starter cottages — the "higher tier = nicer buildings" payoff made visible (2 founder lots left open for the real auction). Both model pairs are Kenney CC0 low-poly. `SHOWROOM_PARCEL_IDS` is the combined id set.
- **Render:** `apps/web/src/lib/three/land-showroom.tsx` (mounted in `World3DCanvas` beside `LandStructures`). Reuses the proven GLB clone/normalize/ground/cull pipeline from `land-structures.tsx`; the 6 cottage GLBs + the 2 premium GLBs (`premium-tower/home.glb`, `premium-mall/shop.glb`) back it (primitive fallback if a model is missing). Each lot's sign is a per-lot plank+post placed by the same edge-facing-origin math as the for-sale signs, using one of two shared `CanvasTexture`s picked by the entry's `signLabel`: amber **"FOR RENT" / "CLAWVILLE ESTATES"** for starter lots, gold **"PREMIUM" / "FOUNDERS' ROW"** for founder lots. Iris-Xe-safe (no drei Text, no ShaderMaterial, zero per-frame allocs). On every showroom lot, `land-parcels.tsx` **suppresses the FOR-SALE sign** (the lot frame stays) so they read FOR RENT / PREMIUM only.
- **Hide-when-owned:** each showroom lot's group hides the instant its parcel status flips to `owned` in the land store, so a real buyer's placed structure (`LandStructures`) cleanly takes over with no overlap. (Today this fires only once parcel-ownership is hydrated into the store; until that wire lands the showroom is always-on decoration — see the TODO for the "claim a model home & inherit its level" transfer economy + interiors.)

### 18b.f. FOR-SALE signage — 3 categories (regular / premium / premium-partner)

Every one of the 180 plots carries a **FOR SALE sign**, styled by a **visual category** (separate from the economic tier — signage is purely cosmetic, `packages/shared/src/constants/land-signage.ts`, rendered by `land-parcels.tsx`). Three categories, escalating in size + fanciness:

| Category | Plots | Sign | Look |
|---|---|---|---|
| **regular** | `b` / `c` / `starter` tiers (the larger outer square frames) | basic, 68×28wu plank | dark plank, thin tan border, "FOR SALE" |
| **premium** | `founder` + `a` tiers (the inner square frames just outside the town circle) | ~1.35× bigger, 92×38wu | gold double-border + corner ticks, "FOR SALE" + "PREMIUM" |
| **premium-partner** | a **game-owner-curated subset** of premium plots (`PREMIUM_PARTNER_PARCEL_IDS`) | ~1.7× bigger, 116×48wu | cyan/platinum ornate border + topper bar, "FOR SALE" + "PARTNER" |

**Premium and premium-partner share the same land** (the inner premium ring) — partner plots are specific premium lots WE reserve for partners (default 6: 3 founder + 3 a-tier, spread around the ring; edit the set to re-designate). `getLandSignCategory(parcel)` resolves the category (partner-id → premium-partner; founder/a tier → premium; else regular). Draw budget: 5 tier-body meshes + 3 sign-post + 3 sign-plank = 11 (was 7). The signs are merged per category (one mesh each), Iris-Xe-safe (text baked into per-category `CanvasTexture`s, no drei Text), all disposed on unmount. **Most plots stay empty = "builder" plots** (buy + build your own); only ~22 carry the showroom example buildings. The land-showroom layer no longer draws its own sign (signage is unified here), so a showroom lot shows its example building **plus** its category FOR-SALE sign.

---

## 19. Map layout

Source: `packages/shared/src/constants/map-locations.ts`. 160×160 tile grid, 32 px/tile = 5120×5120 world units. Village center tile `(80, 80)` → world `(0, 0)`. Building ring at radius 68 tiles = 2176 wu, 10 slots at 36° spacing.

See **`3dStructure.md §1`** for the full coordinate system + axis conventions, and **`WorldContent.md §2`** for the building roster.

---

## 20. Recent material changes

Compact log. The audit-history wall at the top of the prior version of this doc has been replaced with this. Entries are gameplay-facing — backend/service changes belong in `ARCHITECTURE.md §13`, 3D-render changes in `3dStructure.md §13`.

- 2026-06-18 — **Land showroom — FOR RENT + PREMIUM (new §18b.e).** 16 outer starter lots (FOR RENT cottages) + 6 inner Founders'-Row lots (PREMIUM skyscraper/mall, Kenney CC0, level-5 so they tower) pre-filled with deterministic model buildings + signs, so the land world reads as set-up (not 180 empty for-sale lots) AND shows off the "higher tier = nicer buildings" payoff. Client-side decoration only (no economy/DB write); advertises the existing buy → place → upgrade ("fix it up") path. New `LAND_SHOWROOM` constant (`packages/shared`, starter + premium entries, `signLabel` per lot) + `land-showroom.tsx` render layer (mounted in `World3DCanvas`, reuses the `land-structures.tsx` GLB pipeline, two Iris-Xe-safe sign CanvasTextures); `land-parcels.tsx` suppresses the FOR-SALE sign on those lots. Hides a lot when its parcel becomes owned. In-world buy is still via the sidebar **Land Office** panel — no walk-up popup yet. Real "claim a model home & inherit its level" transfer + parcel interiors + walk-up buy prompt are TODO. See `3dStructure.md §13`.
- 2026-06-07 — Playable perf rollback: `/game` HUD controls stay mounted under adaptive tiers and `?fast=1`. The prior tier-4 HUD collapse was rejected because it removed screen buttons and made staging unplayable. 3D-side proxy removals are documented in `3dStructure.md`; the full rollback ledger is `docs/perf-integration-change-ledger-2026-06-07.md`.
- 2026-05-29 — **Cove casino economy fixes + CT-economy monitor (new §18a.k).** Baccarat banker commission now floors the player's WINNINGS (`floor(stake×95/100)`) so the house keeps the fraction at EVERY stake (closed the sub-20-stake faucet — banker was −1.13% house edge at stake 10). Hold'em settle takes a `min(floor(pot×5/100), 5)` CT pot rake (net burn). Blackjack settle takes a `floor(max(0, payout−bet)×5/100)` rake on net winnings (winners only). All three idempotent (computed once under the FOR UPDATE lock, stored in `outcomeJson`, never re-applied on replay); the `cove_game_events.payout` carries the post-rake figure so the new admin-only `GET /api/cove/economy/summary` (minted/burned/houseNet per gameType + `faucets[]` alarm; FEATURE_GATE `cove_ct_economy_monitor`) detects any game going net-positive to players. tsc clean (api+database), 146 engine tests green. See `.claude/plans/cove-casino-economy.md`.
- 2026-05-29 — Phase 6.6.1 REAL baccarat (Punto Banco) at the cove baccarat station — first playable UI (was a sign-only placeholder, no route/modal/engine). Server-authoritative provably-fair engine (`baccarat-engine.ts`, `bac-v1`): 8-deck no-replacement HMAC shoe, the EXACT fixed standard third-card tableau, integer payouts (Player 1:1, Banker 0.95:1 with floored 5% commission, Tie 8:1, P/B push on tie), pure replay for the verifier; 55/55 unit tests. One-shot route `/api/cove/baccarat` (open/coup/close/current/:id) — Punto Banco has no decisions, so a coup deals+resolves+settles in ONE txn under the shoe `FOR UPDATE` lock; idempotent via `(shoeId, idempotencyKey)`; guest 100 demo CT; currency seam 501 for sol/usdc. New `baccarat_shoes`/`baccarat_coups` tables + migration; one `cove_game_events` row per coup; `/cove/history` verifier `baccarat` branch (`replayShoeUpToCoup`). NEW from-scratch `BaccaratModal` + `BaccaratCard` (copied from BlackjackModal) — P/B/T selector + stake chips + Deal + result reveal (natural badges, winner highlight, commission note); server-authoritative rendering. NEW `baccarat-api-client.ts` + shared `cove-baccarat.ts` wire types. NEW `BaccaratTableHotspot` at [285,100,584] (mirror of the blackjack/holdem invisible hit-box). `useCoveStore` baccarat slice. Cove subtitle → "Slots · Blackjack · Hold'em · Baccarat". Three-surface knowledge sync (Nori + orientation + Connection-SKILL protocol content). New §18a.j. Connected-agent protocol + Connection-SKILL endpoint + hosted-agent memory + real-money SOL/USDC are later phases.
- 2026-05-28 — Phase 6.5.1 REAL No-Limit Texas Hold'em at the cove's second poker table — replaces the 6.5.0 display-only mock. Server-authoritative provably-fair engine (in-house 7-card evaluator + HMAC per-hand deck, 5 deterministic bot personalities, side-pots), real ClawToken stack custody (buy-in 20–500 CT default 100, blinds 1/2, cash-out at walk-away; guests 100 demo CT, no ledger), idempotent settle under a table row lock. New `holdem_tables`/`holdem_hands` tables + migration; one `cove_game_events` row per hand; `/cove/history` verifier `holdem` branch. `HoldemModal` rewired to the real `/api/cove/holdem/*` flow (new `holdem-api-client.ts`, deleted `holdem-mock-engine.ts`); Control(advise)/Autonomous(gated) agent modes with FEATURE_GATE. Three-surface knowledge sync (Nori + orientation + Connection-SKILL protocol content). §18a.g rewritten. WebSocket connected-agent protocol + Connection-SKILL endpoint + hosted-agent memory still 6.5.2; real-money SOL/USDC 6.5.4. See `.claude/plans/cove-texas-holdem.md`.
- 2026-05-27 — Phase 6.7.0 Game History UI: `/cove/history` (auth-gated infinite-scroll table with game + win/loss filter chips, expandable row drawer showing hash chain + outcomeJson) + `/cove/verify/[eventId]` (per-event verifier dispatch — slots uses full WebCrypto `replaySpin` from `verifier.ts`; other games show Phase 6.7.X placeholder). New `history-client.ts` API client + `HistoryTable`/`HistoryRow`/`HistoryFilterBar`/`SlotsEventVerifier` components. `GameFeatures.md §18a.h` extended with UI subsection.
- 2026-05-27 — Phase 6.5.0 Texas Hold'em visual shell at the second poker table in the cove (mirror of the blackjack station across X). 6-seat felt + 5 deterministic bot opponents + display-only ClawToken buy-in. New §18a.g. Real pokerpocket engine + ClawToken ledger in Phase 6.5.1; WebSocket protocol + Connection SKILL.md + hosted-agent memory injection in 6.5.2; real-money tier in 6.5.4. See `.claude/plans/cove-texas-holdem.md`.
- 2026-05-25 — Phase 6.4.0 interactive-shell fix: blackjack table rewritten to a client-side mock deck (standard 52, mulberry32 seeded per hand) that walks the player through a real state machine (`idle → dealing → player-turn → dealer-turn → resolved`) with HIT/STAND decisions and dealer-hits-soft-17 playout. `BlackjackCard` readability pass (light face + red/black suit glyphs, WCAG-AA in modal). `BlackjackModal` gets per-phase action surface + visible crimson WALK AWAY button. `POST /api/cove/blackjack/play-mock-hand` no longer driven from the UI — kept as a stub for 6.4.1 (final shape pending route-fate decision). See rewritten §18a.f.
- 2026-05-18 `b1c36b3` — Concern 6.0.5: Walkable casino interior + slot cabinet props. Self-contained WASD movement + follow camera in `casino-interior.tsx`. `CasinoPlayerAvatar` routes VRM (`useVRMInstance`+`VRMCharacterAnimator`) vs GLB (lobster, scale=40). Player spawns at (0,0,240) facing −Z. 4 primitive slot cabinets on left wall (x=−115, module-scope geometry). Hotspots moved onto cabinet faces. Walk-out exit corrected to (2000, 5760) — was wrong (940). Canvas initial camera updated to [0,55,400].
- 2026-05-18 — Concern 6.0.4: 2D slot screen shipped. Full 5×3 reel UI with sequential-stop CSS animation, win highlights, paytable modal, win celebration, autoplay. Mock engine (Math.random + outcome forcing). SpinResult/WinningLine types frozen for Phase 6.1 swap. Slot hotspot onClick wired to `openSlotScreen`. `SlotScreenModal` mounted on `/casino` page as fixed DOM overlay (z-index 9990). No real money; in-memory CT balance only.
- 2026-05-18 — Concern 6.0.3: Casino walk-in animation. `SceneTransition.tsx` (new generic rAF fade). `triggerCasinoWalkIn()` in `arena-buildings.tsx` (walk + 500ms fade, explore-mode bypass). `/casino` page: `fadeInOnMount` fade-from-black on arrival, `triggerTransition` + mid-fade avatar reposition `(940, 5760)` on exit. `/game` page: mounts `<SceneTransition />`. `avatarPositionRef` spawn updated to `(5760, 6140)`.
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
