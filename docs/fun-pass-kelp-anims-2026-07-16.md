# Fun Pass — Kelp Revival + Meshy Animation Pack (2026-07-16)

Founder-scoped cosmetic session. Two tracks, both pure-cosmetic (no economy surface).
Workflow: Fable plans → Codex implements → Fable reviews (founder model-allocation directive).
Branch: `feat/fun-pass-kelp-anims-2026-07-16` off `origin/staging` (c1dbf724). Worktree: `cv-fun`.

## Founder scope decisions (asked + answered this session)
- Tracks greenlit: **Kelp revival (B1+B2+B3)** + **Meshy animation pack**. Chess parked (decided: when built, v1 = friendly-only, no vCLAW, no leaderboard — zero E5 surface).
- Kelp maze centerpiece: **cosmetic/photo moment** (glowing landmark; NO daily chest, NO economy).

## Track K — Kelp Revival
Baseline reality: seaweed was never removed — `MergedSeaweed` (6,500 blades) is live in
`World3DCanvas.tsx:1031`, on by default (`waterFogParticles: true`), skipped on iOS/forceWebGL.
The world has expanded far past the seeded density, so it reads as "gone."
CORRECTION (Codex recon 2026-07-17, live code wins): world is 704×704 tiles / 22,528 wu —
the 576×576 figure in CLAUDE.md/earlier drafts is stale.

Codex read-only recon conclusions (adopted):
- B1: start at 18,000 ambient blades (~214k verts); raise only after 5 cold-mount
  measurements confirm the synchronous useMemo generation stays under the hitch budget.
- B2: northeast parcel gap, center (7808, -9900), 48×48 tiles, ~640 wu clearance from
  outer-c parcels; ~5,400 forest blades across 3 variants / 3 draw calls.
- B3: NO schema blocker for parity — maze wall AABBs defined in packages/shared, imported
  by client world-colliders.ts AND appended to shared getServerColliders(); server
  pathfinding.ts already rasterizes every collider from that source into the A* grid.
  Path width 64–75 wu (player half-width 25 wu).

- **B1 — density pass:** raise ambient `BLADE_COUNT` (6,500 → target ~18–24k, tune to what
  the merged-geometry gen cost + frame budget tolerates). Watch mount-time `useMemo` geometry
  generation cost (main-thread hitch at load) — chunk or cap as needed.
- **B2 — Kelp Forest corner:** dedicated dense zone in the emptiest map corner (justify pick
  from `buildingZones` + `LAND_PARCELS` + reef/track data). Tall kelp variants (3–4× current
  max height), distinct color grade/mood. Same proven pattern ONLY: merged BufferGeometry +
  TSL wind via `positionLocal`/`time`, 1 draw call per variant. NO new lights, NO postprocessing.
- **B3 — kelp maze:** maze layout constant in `packages/shared` (single source for client
  render + server pathfinding). Walls = extra-dense kelp rows + AABB colliders registered in
  `world-colliders.ts` (STRUCTURE-ON-MAP mandate, 3dStructure.md §6g). Server-side: NPC/agent
  A* must consume the same layout so hosted agents don't ghost through walls (PARITY).
  Entry gap + center clearing with a glowing cosmetic centerpiece (emissive mesh, subtle TSL
  pulse; NO point lights).

Constraints (kill-the-build): no `InstancedMesh + ShaderMaterial/NodeMaterial`, no drei
`<Text>`/`<Billboard>` in world scenes, no per-frame allocations in `useFrame`, keep
iOS/forceWebGL seaweed skip, `fog.far <= camera.far` unchanged. Same-diff doc update:
`3dStructure.md` §8 (+ new kelp-forest/maze subsection).

PARITY note: world geometry + colliders are shared by humans and agents; maze layout in
`packages/shared` feeds both the client colliders and server A* — no agent-blocking surface.

## Track A — Meshy Animation Pack
Current suite: 3 Mixamo locomotion + ~20 Mixamo emotes in `_emotes.glb` (bundle v1) + surf
clips. Meshy-first rule applies to all NEW clips (Mixamo = legacy only).

Pipeline (proven June 18 cronus run, all scripts in `scripts/hermes-pipeline/`):
1. Rig donor: `POST /openapi/v1/rigging` with cronus `mesh.glb` (data URI works). New rig
   task submitted this session: `019f6e37-a25a-77f2-9e1a-4487887f5eac`.
2. `POST /openapi/v1/animations {rig_task_id, action_id}` per clip from Meshy's action library.
3. Download GLBs → `canonicalize-skeleton.mjs` (byte-level rename → `mixamorig*`).
4. Bundle: extend `build-anim-bundles.mjs` — **Meshy-rig clips must NOT merge into the
   Mixamo-rig base doc** (rest poses differ). Ship as a second bundle `_emotes2.glb` whose
   base doc is a Meshy clip (all Meshy bakes of one rig share a rest pose), or as
   single-clip GLBs. Runtime retargeter computes rest-pose differentials per clip GLB, so
   both bundles retarget cleanly to every VRM.
5. Wire: `ANIM_PATHS` + `EMOTE_ANIM_NAMES` + hotbar + `preloadClips()` warming; bump bundle
   `?v=` (cache-bust rule — Cloudflare 7-day edge cache, no purge scope).
6. NPC ambient emotes: wandering NPCs occasionally play a peaceful emote (client-side,
   existing one-shot path) for town liveliness. No protocol/whitelist change.
7. Full 9-point animation shipping checklist (3dStructure.md §6f) before ship.

Emote distribution (discovered): player emotes are SHOP COSMETICS — `cosmetic_skus`
category='emote', variant `assetMeta.animationKey` → `ANIM_PATHS` key, hotbar reads
owned+equipped. New player emotes ship as SKUs via the existing idempotent seed pattern
(`packages/database/scripts/seed-emote-cosmetics.ts`; price ladder: common 200 / rare 400 /
epic 600 vCLAW — first-party cosmetic carve-out, explicitly allowed). The 3 NPC-ambient
clips (idle_var_a/b, doze) are NOT SKUs — free system clips fired by NPC ambient logic.

Clip pack generated this session (Meshy rig `019f6e37-a25a-77f2-9e1a-4487887f5eac`, action
IDs from docs.meshy.ai/en/api/animation-library): sit_ground 362, shrug 317, think 36,
stomp 255, backflip 462, breakdance 395, handstand 375, dance_funny 22, pushup 324,
kick_ball 410, clap 299, wave_one 290, idle_var_a 11, idle_var_b 12, doze 38.

NPC ambient emotes: per-NPC randomized timer while movement-idle (client, arena-npcs.tsx
animator layer) fires occasional idle_var_a/b/think/doze one-shots — town liveliness with
zero server/protocol change.

PARITY note: emotes are cosmetic; NPC/hosted-agent bodies use the same animator, no
agent-blocking surface. No PROTOCOL_VERSION change (no new agent-visible actions).
KNOWN PRE-EXISTING E5 GAP (not created here, flagged for founder): the cosmetics API is
requireAuth human-only — connected agents cannot buy/equip cosmetics (tracked in the
cosmetics-shop domain as OPEN on prod). New SKUs inherit that gap; fixing the resolver is
its own money-path change outside this cosmetic session.

## Verification gates
- `bun run build` green in worktree, then Fable browser-verifies on localhost (dev + prod
  bundle pass `bun run build && bun run start`), screenshots to founder.
- E4: nothing is called done/shipped without founder sign-off.
- Push to staging only when sign-off-ready.
