# Kelp Forest Realm — portal + dedicated scene + gamified maze (2026-07-18)

Founder verdict on the inline corner maze: rejected (undersized, non-immersive, land-ring collision, static on WebGL, no reward). Decisions locked via founder Q&A: center reward = EXCLUSIVE COSMETIC (no vCLAW), old maze REMOVED NOW (separate commit, in flight), FULL BUILD THIS SESSION. Design bar (memory `feedback_game_space_design_bar`): portal + own scene, avatar-dwarfing scale, motion on EVERY backend, gamified goal, verify the WebGL fallback before founder review.

## 1. World-side: the portal (in /game)

- At the NE grove (world 7808, −9900): a **glowing kelp archway portal** — merged BufferGeometry (arch + swirl disc), emissive pulse (TSL on WebGPU; on WebGL a plain emissive MeshStandardMaterial with a cheap uniform-driven pulse via onBeforeCompile — NO drei Text/Billboard, NO InstancedMesh+ShaderMaterial). Collider AABB + interaction prompt "Enter the Kelp Forest [E]" using the existing near-location prompt pattern → `SceneTransition` fade → route push `/kelp` (cove walk-in pattern verbatim, `apps/web/src/app/cove/page.tsx`).
- The surrounding `KelpForestAmbient` grove: REMOVE the `!FORCE_WEBGL` gate — the grove must render AND sway on WebGL too (founder saw bare sand). Sway on WebGL via GLSL injected with `onBeforeCompile` on the same merged geometry (the pre-r185 seaweed swayed fine on Iris Xe); TSL path unchanged on WebGPU. Perf governor may still hide it under FPS pressure (global policy, unchanged).
- Exit from the realm returns the avatar to the portal position (cove door-spawn pattern).

## 2. The realm: route `/kelp`, own Canvas + budget

- Route-isolated scene exactly like `/cove` (own Canvas `key`, clean WebGPU teardown, SceneTransition fadeInOnMount, "Back to the Reef" exit button, mobile controls reusing the cove walk stack + third-person camera + `clampMovement2D` against realm-local colliders).
- **Scale:** maze footprint ~2,600×2,600 wu, corridors ≥160 wu, walls of kelp **800 wu tall** (3× the 270 wu avatar — you are enclosed, you cannot see over). Realm-local coordinate space centered at origin; `camera near:1 far:8000`, `fog.far ≤ camera.far` (3da far-plane gotcha), deep-teal fog for depth, `material.fog=false` on the pearl beacon glows so goals read through fog (3da reef lesson).
- **Kelp:** 3–4 variants, merged BufferGeometry per variant (≤6 draw calls of kelp), ~14–20k blades total (≈540k verts — fine), wind on BOTH backends (TSL node material / onBeforeCompile GLSL — same displacement math, MAX sway amplitude sized so it can never visually seal a corridor). NaN clamp lesson applies (clamp normalizedHeight before pow). NO periodic stripe artifacts: any noise in shaders = hash/FBM, never product-of-sines (3da reef gotcha).
- **Atmosphere:** god-ray shafts (4–6 additive translucent cone planes, static, ~2 draw calls), drifting motes (one merged point/plane cloud, reuse water-fog-particle pattern), sand floor with baked ripple vertex color. NO postprocessing/bloom in v1 (Iris Xe floor).
- **Maze layout:** hand-authored ~13×13 cell grid in `packages/shared/src/constants/kelp-realm.ts` — wall AABB list + beacon graph derived from ONE source constant (no duplicated numbers). One true path + 4–6 substantial dead-end branches. Colliders: client clamp only (no server A* — the realm has no NPC sim; nothing walks it server-side).
- **Center:** the Pearl — scaled-up landmark (~300 wu shell + pearl), emissive pulse, orbiting glow particles. Reaching it triggers the claim flow.
- Perf target: 60 FPS on the Iris Xe floor, ≤14 total draw calls, zero per-frame allocations. Verify with the prod bundle on BOTH backends (CDP navigator.gpu strip for WebGL) + screenshots of both, BEFORE founder review.

## 3. Gamification: beacon traversal + exclusive reward (E5-clean)

- **Beacon graph:** pearl buoys at maze nodes (entry, junctions, dead ends, center) — physically rendered glowing markers. Server holds the same graph (shared constant). `POST /api/kelp/beacon/:id/visit` with subject auth (`sessionMiddleware + requireAuthOrAgentSession + requireLedgerCapableIdentity`; guests may traverse but claim returns the demo-tier notice — read-only economy rule).
- **Verification:** each visit requires the PREVIOUS beacon's HMAC token + a minimum elapsed time floor derived from graph-edge distance / max walk speed (server constant). Sequence(entry→…→center) with time floors ≈ effort of actually walking it; replayability is irrelevant because the reward is ONE-TIME per avatar.
- **Humans:** the client fires the visit call when the avatar walks within the beacon's radius; the maze IS the puzzle.
- **Agents (full parity, cove two-step-hybrid precedent):** in-world `[ACTION: enter_kelp_forest()]` walks the body to the portal (executor verb, whitelist + PV bump); traversal then runs over the SAME beacon REST endpoints via `X-Clawville-Agent-Session`. The manual gives ONLY the entry beacon; each visit response reveals adjacent beacon ids + bearings — the agent solves the maze as a graph search with real dead ends and the same time floors. Same reward endpoint, same one-time grant, binds to the agent's bound avatar.
- **Reward — "Pearl of the Depths":** exclusive cosmetic SKU, `acquiredVia: 'reward'`, NEVER purchasable (excluded from `checkSkuPurchasable` + catalog list; supplyCap null). Category `aura` if `cosmetic-loader` renders auras today; if not, implement the minimal aura attachment (small orbiting pearl-glow particles on the avatar root — merged geometry, no per-frame alloc) — NO scaffolding theater: whichever path ships must be visible in-world on both backends. Claim = idempotent `avatar_skins` insert inside a transaction (no CT movement — zero faucet surface). Telemetry event `kelp_maze.completed` (no leaderboard weight in v1 — avoids weight-registry churn; revisit later).

## 4. Same-diff obligations

- `PROTOCOL_VERSION` 25→26: new verb + §16 (realm + beacon API + reward) in the manual; orientation corpus + DECISION_SCOPE line + Nori voice line (all three surfaces); pointer-version strings updated.
- Docs: `ARCHITECTURE.md` (route, beacon endpoints, HMAC token scheme, no new tables), `GameFeatures.md` (realm + reward), `3dStructure.md` (portal + realm scene section, Last Audited), `docs/hatcher-integration-spec.md` (manual §16 mirror).
- PARITY note in the commit body (human path / agent path / settlement binding).
- Mobile+iPad viewport sweep for the new UI surfaces (portal prompt, realm HUD, exit button, claim toast) per the mandatory checklist.
- Rule E4: "compiled and rendering — needs your eyes" until founder sign-off. Mock-Hatcher harness on staging before PR merge (verb whitelist changed).

## 5. Build order (Codex implements, Fable reviews per commit)

1. `feat(world): Kelp Forest portal + all-backend swaying grove` — portal structure + prompt + route stub + grove WebGL sway ungate.
2. `feat(kelp): the Kelp Forest realm — scene, maze, atmosphere` — route, scene, colliders, movement, both-backend wind.
3. `feat(kelp): beacon traversal + Pearl of the Depths reward (E5)` — shared graph, endpoints, HMAC+floors, claim, cosmetic grant, agent verb + manual + PV26, three surfaces, docs.
4. Fable verification pass: both backends, mobile sweep, agent-path probe (beacon walk via curl with an agent session), screenshots to founder.

Out of scope v1 (recorded, not forgotten): audio; leaderboard weight for completion; moving hazards/currents; per-daily vCLAW find (founder chose cosmetic-only); minimap deliberately absent inside the maze.
