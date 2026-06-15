# Diagnostic — Hatcher partner regressions (2026-06-12)

Partner symptoms on staging: (1) avatar "underground" again with a fresh agent (v3), (2) sending a chat message makes the avatar disappear after ~1s, (3) a GIANT body (~10x legs) visible in the world, (4) "wrong" UI state: Connect Your Agent + Explore/NPC toggles while clearly having an account, no login/signup buttons.

Method: code recon (2 agents) + live reproduction on staging (diagnostic agent `diag-giant-repro-1` species=phanes via public connect; forced API restart; forced restore; synthetic second player via curl heartbeat in a shared room; THREE scene-graph bbox measurement via CDP).

## Confirmed defects (with evidence)

### D1 — Restore rebuilds the cognition client WRONG (b453fb18, `openclaw-session-restore.ts`)
LIVE-PROVEN: an `anonymous` agent (no gateway at all) was restored after a real API restart and came back wired as an OpenAI-compat gateway client. Its chat now 502s (`Agent gateway error: Unable to connect`) and the server error-logs `Chat failed` on every NPC conversation tick. The restore "matrix" claimed anonymous = restorable body; in reality the rebuilt client is a different backend than the original.
Also (recon, same family): species fallback at restore uses `DEFAULT_AGENT_MODEL_KEY` ('milady_official_1') for ALL types including hatcher (`openclaw-session-restore.ts:168, :251`); `DEFAULT_HATCHER_MODEL_KEY` ('phanes') is not even imported. Wrong body model after restore whenever `bot.species` is null.
NOTE: restart SURVIVAL itself works — the session restored instead of 404ing. The rebuild fidelity is what's broken.

### D2 — Chat-404 stale-clear hard-unmounts the live avatar (b453fb18, web)
Mechanism (file-level): chat 404 `agent_session_not_found` → `avatar-chat-bar.tsx:200` → `setAgentConnection(null)` → `controlMode` falls to `'explore'` → `World3DCanvas.tsx:1370` conditional unmounts `<PlayerAvatar>`. That IS his "avatar disappears after 1 second."
Why his fresh v3 still 404'd: registration through Hatcher's panel is server-side only — his BROWSER still held the removed v2 session id (client agent-state is only set by the magic-link/connect flow in that browser). First chat → legit 404 → our new clear fires → avatar vanishes mid-game.
The "wrong" UI state is the designed logged-in-Player-tier state (Lucia session from the v2 magic link persists on the USER, so no login/signup buttons; no connected agent, so Connect Your Agent + Explore/NPC). Designed, but disorienting and WRONG as UX in this flow: the user did nothing except send a message.

### D3 — CORRECTED 2026-06-12 (post-fix live A/B): the "remote players never render" claim below was a TEST ARTIFACT
The original synthetic second player held no SSE stream, so the room registry GC'd its presence every ~30s — the entity vanished before any VRM could mount. With the corrected recipe (join + HOLD `GET /api/world/:roomId/stream` + position heartbeat), remote players render correctly on BOTH the old and fixed bundles (12 SkinnedMeshes, tallest ~257wu, labels present, four-assertion gate PASS). The REAL D3 defect is the GIANT: `computeVRMAvatarFit` measures the Box3 before `skeleton.update()` settles bone matrices → size.y≈0 → falls back to scale 169 → on a Mixamo cm-rig (phanes, native bbox ~194) = ~32,786wu. Meter-scale milady rigs mask the race, which is why only the partner (first phanes-avatar user) ever saw it. Fix: settle skeletons before measuring (vrm-avatar-sizing.ts). The latency improvements (eager bytes preload, parse concurrency 1→2) ship as hygiene. Synthetic-player runbook for future live checks: guest cookie → world/join → background `curl -N` on the room stream → 3s position posts with dirZ.

### D3 (original, superseded) — Remote players do not render (multiplayer, likely latent since 2026-06-06, first real exercise now)
LIVE-PROVEN: two players (browser guest + curl-heartbeat synthetic player) in room CNHS, 13wu apart, server room snapshot correct (`playerCount:2`, both entries present). Client store received the entity (a `perf:remote-players` child appeared) but ZERO skinned meshes ever mounted, no name label, nothing visible. Remote-player rendering is broken end-to-end on the live bundle.
GIANT THEORY (to be code-confirmed by the fix team): the partner relogged/reloaded repeatedly, leaving его own ghost presences (30s GC) in his room; a remote-player VRM that mounts through this broken path with a missing/wrong fit-scale application (the remote path is suspected to lack `computeVRMAvatarFit`) renders at native/registry scale instead of fitted scale → the giant white legs (his own phanes-family avatar, unfitted). The giant only ever appears for users who share a room with another presence — which no one did until the partner.

### D4 — "Underground again" (his v3 report)
The locomotion root-motion fix (PER_CHARACTER_IN_PLACE strips) is correct per clip data, but his v3 test happened while D2 unmounted his avatar and D3 ghost-rendered presences — what he saw as "underground" needs a clean re-test AFTER D1-D3 land. Do not assume the sinking fix failed; do not assume it succeeded.

## What was verified working during the same session
Restart survival (restore fires, no 404), `sessionExpiresAt` in connect response, both lifecycle sweepers booted with correct defaults, NPC substitution on room join (`milady-aria` swapped out), soft-cap room auto-fill placing the second guest into the occupied room, email-banner gating (absent for guests).

## Why this shipped (process failure, honest)
1. No end-to-end partner-flow test exists. The audits (3 teams, all "APPROVED") reviewed code and ran unit suites; nothing drove the live binary through register → magic-link entry → chat → render. The 75/75 selftest harness mocks the DB and never exercises spawn/render/session-restore against reality.
2. My verification covered guest paths and ERROR paths (curl 401/404) — never the happy path with a real registered agent, because we cannot sign as Hatcher and no mock partner existed. The "PENDING: real settled-hand smoke" item had been open since 06-05; shipping on top of it repeatedly was the mistake.
3. Multiplayer remote rendering had NEVER been exercised by two real simultaneous humans — the partner was the first. That gap predates yesterday but yesterday's changes (stale-clear, restore-respawn) multiplied the exposure.
4. Each staging deploy killed the partner's (pre-hash) session mid-test, compounding the appearance of breakage.

## Remediation (in flight)
- FIX-1: restore rebuild fidelity — rebuilt config must deep-equal the original per identity type (anonymous/nanoclaw/milady have NO gateway client; hatcher rebuilds proxy; species fallback per category). Regression test: for each identity type, register → capture config → simulate restart → restore → assert deep-equal.
- FIX-2: remote-player render — root cause mount failure + missing fit-scale; verify live with the synthetic-player technique (curl guest + heartbeat), which is now a documented repro tool.
- FIX-3: stale-clear UX — clearing agent state must NOT unmount the avatar of a still-authenticated user with an avatar; controlMode stays 'player' for the bound user; the banner explains the agent session ended.
- HARNESS: mock-Hatcher client + proxy (recon-designed): staging-only second partner pubkey (explicit `ALLOW_TEST_PARTNER` env gate), signed register/stats client, mock proxy verifying our cognition signature, run as a MANDATORY pre-ship gate together with a two-presence browser render check.
- FREEZE: nothing ships to staging until the harness + live two-player render check pass.
