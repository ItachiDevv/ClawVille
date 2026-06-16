# Cosmetics — In-Game Wearable Swap (plan + locked decisions)

> **Status:** PLAN LOCKED 2026-06-07, implementation not yet started. Recon complete (workflow `wf_8f824b69-031`). Awaiting team kickoff. This doc is the durable source of truth — survives context compaction. Update it as phases land.

## Goal (user's words)
Players must be able to **swap their avatar's cosmetics in game** — hats, sunglasses, wearable items — and **see it on their avatar**, proportionally correct, live. This was built before (shown on `/dash`), "kind of finished but very buggy," and the codebase changed a lot since. The 3D attachment + per-rig fit is the known bottleneck.

## LOCKED DECISIONS (this session — do not relitigate without the user)

1. **Scope = make the existing system actually work across all HUMANOID rigs.** Not the full Q3 storefront, not new art. DONE = any player, any humanoid avatar, opens wardrobe → equips hat/glasses → it sits proportionally right on THEIR head and swaps cleanly.
   - Humanoid rigs in scope: **Milady (VRM 0.x), Hermes, Tekk, Phanes, eliza-chibi (VRM 1.0)**.
   - **OpenClaw crustaceans (lobster/crab) are NON-humanoid** (no head bone) → separate anchor strategy, handled distinctly (Phase D). User explicitly carved these out: "those aren't humanoid so we need to do something else for that."

2. **PARITY REFRAME (user correction — important).** Do NOT build "human path vs agent path." There is ONE entity: an **avatar**. A human in control mode and an agent in autonomous mode are the *same avatar* with a different driver. So:
   - **One equip path** resolves "which avatar is acting" from whatever session is present (Lucia cookie OR agent session) → same avatar, real CT, real leaderboard. This IS the parity fix; it is not a second feature.
   - **Cosmetics are avatar STATE**, rendered by ONE shared avatar renderer used **everywhere an avatar is drawn** (player, NPC, agent body). No "local player special case." The current structural defect = the local player VRM has its own cosmetic-mount path while NPC/agent bodies have none.
   - **"Others see it" is not a choice** — it's automatic once cosmetics are avatar state + shared renderer. The only real variable is how far the world-state feed already propagates each avatar's loadout to other clients (the in-flight authoritative-shared-server / multiplayer gap). Wire loadout into the world feed; it propagates as far as the feed reaches. Do NOT overclaim cross-human-player realtime visibility until multiplayer carries it.

3. **Fit approach = proportion-aware AUTO-FIT (hybrid).** Compute attachment position/scale at runtime from each avatar's ACTUAL head metrics (head bone world pos + measured head-top + head-width), sibling to the existing `computeVRMAvatarFit` in `vrm-avatar-sizing.ts`. A chibi's oversized head gets a bigger hat; Phanes gets Phanes's proportions — automatically, NO per-rig hand-tuned offset table. Keep a small **optional per-rig override slot** for the rare case the metric is wrong. User: "need to make sure this works proportion wise for players avatars."

4. **Assets = REUSE the 12 procedural placeholder GLBs this pass.** Art pass (polish generator OR regen authored meshes) is scheduled AFTER fit is proven. Rationale: art quality ⊥ fit math; placeholders have known-clean pivots so any floating hat is a fit bug, not a mystery artist pivot. The 12 were rendered for the user 2026-06-07 (headless Blender → `tmp-cosmetic-render/cosmetics-catalog.png`); user approved reuse.

## The 12 current cosmetics (procedural three.js primitives — `apps/web/scripts/generate-cosmetic-glbs.mjs`)
- **Hats:** top-hat (350 rare), cowboy (200 common), beanie (200 common), wizard (600 epic), crown (800 epic), bucket (200 common)
- **Glasses:** classic-black (200), rose-gold (350), aviator (250), cyberpunk (600 epic), heart (400 rare), shutter (350 rare)
- Files: `apps/web/public/cosmetics/{hats,glasses}/<slug>.glb`. Authored in METRIC (meters) for VRM head-bone-local frame. No textures, flat MeshStandardMaterial.

## Architecture as it exists (recon `wf_8f824b69-031`)
Data path: own → equip → render. Hops 1, 9, 12 work; 2–4, 7–8, 10 are human-/Milady-only partials; **6 and 11 are broken/missing and gate the product goal.**

| # | Hop | File / table / route |
|---|---|---|
| 1 | Catalog SKUs | `cosmetic_skus` (`packages/database/src/schema/cosmetics.ts:47-109`); `GET /api/cosmetics/catalog` (`apps/api/src/routes/cosmetics.ts:77-122`) |
| 2 | Per-rig asset binding | `cosmetic_variants` (`cosmetics.ts:111-161`); `asset_meta` jsonb `{boneAnchor, offsetXYZ, scale, rotationXYZ}` — only `rigType='milady-vrm'` seeded |
| 3 | Buy → ownership | `POST /api/cosmetics/:skuId/buy` (`routes/cosmetics.ts:263-364`) → `debitClawTokens` + insert `avatar_skins` |
| 4 | Equip state | `POST /api/cosmetics/:skuId/equip\|unequip` (`routes/cosmetics.ts:201-249`) → flips `avatar_skins.equipped` bool |
| 5 | In-game equip UI | `CosmeticDrawer` (`apps/web/src/components/game/cosmetic-drawer.tsx:66-440`); hooks `use-cosmetics.ts`; Zustand `cosmeticDrawerOpen` (`stores/game.ts:174-175`) |
| 6 | **Drawer render mount (BROKEN)** | `CosmeticDrawerMount` (`apps/web/src/app/game/page.tsx:496`) trapped in agent-gated block (`page.tsx:480`) → dead click for no-agent players |
| 7 | Read "what I'm wearing" | `GET /api/cosmetics/owned` (`routes/cosmetics.ts:128-195`) → `useEquippedCosmetics` (`cosmetic-loader.tsx:358-400`) — own avatar only |
| 8 | 3D attach to head bone | `CosmeticLoader`→`HatOrGlassesRenderer` (`apps/web/src/lib/three/cosmetic-loader.tsx:412-505`); `findBone ?? findHeadBone` (`:170-211,455-457`) |
| 9 | Bone animated each frame | `VRMCharacterAnimator.update()` (`vrm-character-animator.ts:749-771`) — order `mixer.update→vrm.update→updateMatrixWorld` (the fix that stabilized attach) |
| 10 | Only render mount | `PlayerAvatarVRMInner` (`player-avatar.tsx:686-691`) hardcoded `rigType="milady-vrm"`; `PlayerAvatarGLBInner` mounts NONE |
| 11 | **Other avatars (MISSING)** | `arena-npcs.tsx`, `npc-controller.tsx` — no cosmetic code at all |
| 12 | Admin telemetry | `GET /api/dashboard/cosmetics` (`dashboard.ts:355-388`) → `/dash` tab (`app/dash/tabs/cosmetics.tsx`) — read-only |

## Bug list (deduped, by severity — from recon)
**CRITICAL**
- B1. Drawer unreachable for no-agent (Player-tier) humans — dead click. `app/game/page.tsx:480,496`. Un-gate (move mount into `hasAvatar` block ~`:451-463`).

**HIGH**
- B2. No unified equip path — routes are `requireAuth`-only. `routes/cosmetics.ts:128,241,246,263`. Adopt `requireAuthOrAgentSession` / `getSubject`-style resolver (pattern exists, see below).
- B3. Cosmetics render only on local player VRM. NPC/agent/remote bodies show nothing. `player-avatar.tsx:686` only; `arena-npcs.tsx` none.
- B4. No endpoint returns ANOTHER avatar's loadout. `routes/cosmetics.ts:135-143` filters caller's own avatar only. Needed for world render.
- B5. `CosmeticLoader` hardcodes `rigType='milady-vrm'` + only on VRM avatars. `player-avatar.tsx:688`; GLB path none.
- B6. Offsets Milady-only → float/clip on Hermes/Tekk/Phanes/chibi. `seed-milady-cosmetics.ts:42-189` + `player-avatar.tsx:687`.

**MEDIUM**
- B7. Dead `boneAnchor:'J_Bip_C_Head'` (matches NO rig). `seed-milady-cosmetics.ts:225`. Real head bone = `mixamorig:Head`. Resolve via `vrm.humanoid.getRawBoneNode('head')`. Survives today only by `findHeadBone` fallback (`cosmetic-loader.tsx:198-205`).
- B8. No single-item-per-slot enforcement → two hats stack. `routes/cosmetics.ts:201-239` (blind set equipped=true) + renderer maps ALL equipped (`cosmetic-loader.tsx:865`). Need a `slot` concept + server unequip-siblings (or partial-unique index).
- B9. VRM0 vs VRM1 forward-axis not handled → glasses can land on back of head on non-Milady. `seed-milady-cosmetics.ts:119-121`. Detect from `vrm.meta` / metaVersion.
- B10. Supply cap never enforced on catalog/buy. `routes/cosmetics.ts:94-96,271-308`.
- B11. RESTRICT FK migration UNAPPLIED → prod FKs still CASCADE. `packages/database/drizzle/phase3-cosmetics-restrict.sql` exists but no apply script ran it; only `phase3-cosmetics.sql:42-43,75-76` (CASCADE) applied. Hard-deleting a SKU CASCADE-deletes owners' `avatar_skins` (silent loss of paid ownership). TS schema declares `onDelete:'restrict'` (`cosmetics.ts:121,175`) — schema LIES vs live DB.
- B12. No `?v=N` cache-bust on `/cosmetics/*.glb`; SW serves cache-first (`apps/web/public/sw.js:94,213-214`). Re-export = ~1wk stale (CLAUDE.md invariant).

**LOW**
- B13. `OutfitRenderer` is a no-op stub but "outfit" is a selectable drawer chip → silent "Equipped" that never shows. `cosmetic-loader.tsx:757-765` + `cosmetic-drawer.tsx:45`. HIDE chip.
- B14. `PaletteRenderer` whole-material swap, skips MToon → does nothing on Milady. `cosmetic-loader.tsx:685-746`. HIDE chip or implement MToon-aware.
- B15. `generate-cosmetic-thumbnail.mjs` referenced but DOES NOT EXIST → all `thumbnail_url` null, `/dash` + shop cards show emoji fallback. (Headless Blender render proven viable 2026-06-07 — reuse that approach.)
- B16. Inputs validated by ad-hoc regex/Set not Zod. `routes/cosmetics.ts:56-57,207,267`. Project rule = Zod on all inputs.
- B17. No CHECK constraints on `slot/category/scope/rarity`; free-text drifting (`category='emote'` undocumented). `cosmetics.ts:54,67,71,177`.
- B18. No Drizzle `relations()` for cosmetics tables (`index.ts:116-128` omits `avatarSkins`).
- B19. Doc drift: `GameFeatures.md` has NO cosmetic section; `3dStructure.md §12` (`:848,852`) names non-existent `lib/three/cosmetics/` + stale bone list; `ARCHITECTURE.md` omits `/api/cosmetics/*`; carve-out pointer dead (real home `.claude/plans/gamification-economy-and-shop-q3.md §1` + `CLAUDE.md`).

## Unified equip path — the pattern to ADOPT (already exists)
`apps/api/src/middleware/require-auth-or-agent.ts`:
- `requireAuthOrAgentSession` middleware → sets `c.var.identity` discriminated union `{kind:'user'|'agent', userId, avatarId, agentId, sessionId?}`. Lucia cookie precedence, else `X-Clawville-Agent-Session` header.
- `resolveAgentSession(sessionId)` → `{userId, avatarId, agentId, ledgerCapable}`, fail-closed via `validateLiveAgentSession` (Map membership + `openclaw_bots.session_expires_at > now`, NULL = expired; rebind re-validation for real-CT theft).
- Cove uses a `getSubject(c)` resolver (`routes/cove-blackjack.ts:246`) on its economy write paths. **Mirror this on cosmetics buy/equip/unequip/owned.** `requireAuth` stays only where a Lucia human owns a table; the avatar-acting paths use the resolver.

## Fit math (Phase B detail)
- Anchor: `vrm.humanoid.getRawBoneNode('head')` (the raw bone the animator drives — see hop 9). Parent cosmetic Group to it (NOT normalized node — normalized is for the AnimationMixer).
- Measure per-avatar in head-bone-LOCAL frame at rest pose: head-top Y (bbox of head-region verts or skinned head mesh), head width X. Hats: place at headTopY + clearance, scale ∝ headWidth. Glasses: place at eye-level (fraction down from head-top) + forward by head-depth/2, scale ∝ faceWidth. Forward sign from VRM0/VRM1 (`vrm.meta`).
- Build a `computeCosmeticHeadFit(vrm)` helper next to `computeVRMAvatarFit` (`vrm-avatar-sizing.ts`). Optional `assetMeta` per-item nudge still applies on top (small offset/scale multiplier), and an optional per-rig override map for escape hatches.

## DESIGN REFINEMENT (2026-06-07) — universal variant + runtime-computed fit
Because the fit is now PROPORTION-AWARE and computed at render time from each avatar's own head, **we no longer need per-rig variants or per-rig offset tables.** Contract:
- **One `'universal'` variant per SKU** (asset_url + small per-CATEGORY base meta: `clearance`, optional `scaleHint`/`nudge`). No `milady-vrm`/`hermes`/… rows to seed and keep in sync. This deletes bug B6 at the root.
- **All proportion logic lives in the runtime fit helper.** `rigType` is NOT used to pick offsets; at most it branches humanoid-vs-crustacean. Forward-axis (VRM0/VRM1) is detected at runtime from `vrm.meta`, not from DB.
- **Axis-sign safety (the recurring bug):** do NOT hardcode +Z/−Z. Compute placement in a frame you can reason about — the avatar's WORLD/measured frame (AABB-top for hats, eye-level + body-facing-forward for glasses) — then express it in head-bone-LOCAL via the bone's inverse world matrix at rest. This kills the sign-flip class of bugs ([[feedback_vrm_facing_formula]]).
- Migration impact: backend can collapse `cosmetic_variants` usage to `'universal'`; existing `milady-vrm` rows can be re-pointed or left (loader prefers `'universal'`). Decide in Phase A.

## IMPLEMENTATION PROGRESS (2026-06-07) — Phase B in flight
- **Commit `1ec1e1a8`** (3da pass 1, on `feat/openai-text-swap`): first `computeCosmeticHeadFit`. Agent over-eagerly committed+pushed (feature branch, NO deploy). Treated as WIP-under-review, NOT shipped.
- **Pass 2 (reconciler, uncommitted)**: fixed scale-frame (asset-aware `desiredWorldWidth / (assetWidth × boneWorldScale)`, killed magic-30) + `pickVariant` first-available fallback. Head measurement was still a proxy.
- **Codex review round 2 (read the files)** found: (a) `Object3D.traverse` callback `return` does NOT prune the subtree → cosmetic child meshes still inflated `bodyBox`; (b) `bodyBox.max.y` = whole-body top + `setFromObject` SkinnedMesh bounds are pose-sensitive → hat height unreliable; (c) `getWorldDirection()` returns local **+Z** in world (matrixWorld[8..10]) but avatars face **−Z** → glasses forward sign was REVERSED.
- **Pass 3 (in flight, `3da-fit-robust`)**: replace measurement with HEAD-ISOLATED, POSE-CORRECT vertex AABB — iterate skinned verts weighted to the head bone (`applyBoneTransform`→world→`expandByPoint`), giving real head width/height/depth, pose-correct, cosmetics auto-excluded (not skin-weighted). Drops the `HEAD_WIDTH_TO_HEIGHT` aspect guess. Facing sign behind exported const `GLASSES_FACING_SIGN` (default −1) to verify visually. Finite guards (no clamp-masking). PLUS new dev route `apps/web/src/app/preview/cosmetics/page.tsx` — standalone WebGL R3F (capturable, unlike the WebGPU game scene) rendering Milady/Hermes/Tekk/Phanes/chibi each wearing top-hat + glasses, sized via `computeVRMAvatarFit`, for visual fit verification + constant tuning.

**OPEN (next):** (1) Codex review round 3 on the vertex-AABB measurement. (2) Build + screenshot `/preview/cosmetics`; CONFIRM the facing sign (flip `GLASSES_FACING_SIGN` if glasses land behind the head) + tune `HAT_CLEARANCE_WU`, `GLASSES_EYE_FRACTION`, `CATEGORY_WIDTH_FACTOR` across rigs. (3) Browser sign-off, then commit staging-first. (4) THEN Backend Phase A (unified equip path etc.). (5) Phase C render-on-all-avatars, Phase D crustaceans, Phase E UI/thumbnails.

**Tunable fit consts (in `vrm-avatar-sizing.ts`):** `CATEGORY_WIDTH_FACTOR{hat:1.05,glasses:0.95}`, `HAT_CLEARANCE_WU=2`, `GLASSES_EYE_FRACTION=0.25`, `GLASSES_FORWARD_FACTOR`/`headDepth*0.5`, `GLASSES_FACING_SIGN=-1`, `HEAD_WEIGHT_THRESHOLD=0.5`.

## AUTONOMOUS SESSION RESULT (2026-06-07 night) — Phase B fit: 4/5 rigs solved, chibi needs Blender

**Verified ONLY in `/preview/cosmetics`** (WebGL, screenshot-capturable). NOT committed, NOT pushed, NOT verified in the live game (Iris Xe blocks local `dev`; user asleep, no sign-off).

**Outcome per rig (preview):**
- **Milady (VRM0), Tekk, Phanes (VRM1)** — pure AUTO-FIT (`computeCosmeticHeadFit`) — hat seated + worn-looking, glasses on the eyes. ✅
- **Hermes (VRM1)** — SOLVED via a **bone-anchored per-rig override** (`RIG_HEAD_OVERRIDE.hermes = { boneAnchored, headTopAboveBoneM: 0.22, headWidthM: 0.32 }`). Top hat at her hairline, hair below. ✅
- **chibi** — STILL WRONG (hat floats). **Its `head` bone is DISPLACED ~35 world-units ABOVE the rendered head mesh** (rig is broken — skin weights so corrupt the bone isn't where the head is). No bone-anchored value looks right: raising floats it, lowering buries it in the black hair. **NEEDS A BLENDER RE-RIG** (fix head-bone→head-mesh association). Current override is an approximate stopgap, flagged in code. ⚠️

**How the fit evolved (the dead ends, so we don't repeat them):**
- Auto-fit measures the head from skinned vertices weighted to the head bone. Works ONLY when the rig weights the head cleanly. The 2 bad rigs don't: chibi weights its whole upper body to the head bone (head measured ~2.5x too big → giant floating hat); Hermes weights only her upper skull (head too small/high → hat off to the side / buried).
- Tried: strong-weight (≥0.9) seed → all rigs fall through to 0.5 (no clean strong weights). Geometric expansion → over-captured shoulders/wings (Milady w 71→137, Tekk caught wings). Both reverted.
- **Conclusion:** no automatic head measurement is robust across these production rigs → **per-rig bone-anchored overrides** are the pragmatic answer (the head BONE is reliable… except on the chibi, where even the bone is displaced → Blender).

**Key files changed (all uncommitted in the working tree):**
- `apps/web/src/lib/three/vrm-avatar-sizing.ts` — `computeCosmeticHeadFit` (seed+geometric measurement, axis-safe world→bone-local; `RIG_HEAD_OVERRIDE` table + `RigHeadOverride` type; `rigKey` + `tuningOverride` params; bone-anchored branch with decoupled `headTopAboveBoneM`/`headHeightM`/`headWidthM`). Tunable consts: `CATEGORY_WIDTH_FACTOR`, `HAT_DROP_FRACTION`(0.30), `GLASSES_EYE_FRACTION`(0.52), `GLASSES_FORWARD_FACTOR`(0.45 of head DEPTH), `GLASSES_FACING_SIGN`. Skinning gotcha fixed: `sm.skeleton.update()` before `applyBoneTransform` (equip-on-load race) — without it the measure collapses to origin and cosmetics fly off.
- `apps/web/src/lib/three/cosmetic-loader.tsx` — `HatOrGlassesRenderer` auto-fit path (asset-aware + bone-scale-aware scale, `getRawBoneNode('head')` anchor); `avatarRigKey` threaded to `computeCosmeticHeadFit`; `pickVariant` first-available fallback; outfit/palette guarded off.
- `apps/web/src/lib/three/player-avatar.tsx` — `COSMETIC_RIG_KEY` map (animatorId→override key: `hermes-female`→`hermes`, `chibi`→`chibi`); passes `avatarRigKey`. **UNVERIFIED IN-GAME.**
- `apps/web/src/app/preview/cosmetics/{page,CosmeticsPreviewScene}.tsx` — NEW dev/QA route. **Dev tuning harness:** `?{rig}Top=&{rig}H=&{rig}W=` patches the override via `tuningOverride` (reload, no rebuild). The chibi values were found this way.
- `3dStructure.md §12` — needs a same-diff reconciliation pass (the 3da agent's earlier §12 edit predates the final algorithm).

**NEXT (resume here):**
1. **chibi:** Blender re-rig (head bone → head mesh) — the user offered to do this together. Until then it floats.
2. **Verify in the LIVE game** (staging after sign-off, or the user's browser): the game threading (`COSMETIC_RIG_KEY` → `avatarRigKey`) is written but unverified — confirm Hermes's override + the 3 auto-fit rigs render correctly in `/game`, not just the preview.
3. **Decide the dev harness fate:** keep `/preview/cosmetics` + the query-param `tuningOverride` as a dev tool, or strip before prod.
4. **BACKEND Phase A still NOT started** — the unified avatar-acting equip path (`requireAuthOrAgentSession`/`getSubject` on `cosmetics.ts`), single-per-slot, RESTRICT FK migration, per-avatar loadout endpoint, un-gate the drawer (`game/page.tsx:480,496`), `?v=N`, docs. This is what makes equip/swap actually work end-to-end (the fit work above is only the *render* half).
5. Commit **staging-first** after sign-off. Same-diff docs: `3dStructure.md §12` + `GameFeatures.md` cosmetics section.

## Non-humanoid crustaceans (Phase D)
Lobster/crab GLB avatars have no humanoid head bone. Options (decide at Phase D): (a) named anchor node convention baked into the GLB (`cosmetic_head` empty), (b) compute top-of-model bounding box and attach there, (c) scope cosmetics VRM-only + show "not available for this avatar." Lean (b) as pragmatic default, (a) as the clean long-term.

## Phasing
- **A — backend/data:** adopt `requireAuthOrAgentSession`/`getSubject` on buy/equip/unequip/owned (B2); single-per-slot server enforcement + `slot` concept (B8); apply RESTRICT FK migration (B11); `?v=N` (B12); Zod (B16); CHECK constraints (B17); relations() (B18); supply cap (B10). Add per-avatarId loadout endpoint (B4). Docs (B19).
- **B — 3D fit:** `computeCosmeticHeadFit` head-metric helper; thread REAL rigType from `avatarModelKey`/MODEL_REGISTRY (B5); `getRawBoneNode('head')` anchor (B7); VRM0/VRM1 axis (B9); per-category placement. Verify on EACH humanoid rig.
- **C — unify render:** shared cosmetic-attach applied to ALL avatars (player GLB path + NPC/agent bodies, B3); per-avatar loadout fetch wired to world feed (B11-render).
- **D — non-humanoid:** crustacean anchor.
- **E — UI + polish:** un-gate drawer (B1); HIDE outfit/palette chips (B13/B14); mobile+iPad verify (`docs/mobile-ipad-verification.md`); thumbnail pipeline (B15) reusing headless-Blender render.
- (later) Art pass — polish generator or regen authored meshes + `?v=N`.

## Implementation routing
- 3D files (`cosmetic-loader.tsx`, `player-avatar.tsx`, head-metric helper, `arena-npcs.tsx`) → **Rule E3** (Three.js/R3F → Codex-first on first edit unless user types "claude implement") + 3D-team (`3da`). CONFIRM with user at kickoff.
- Teams: 3D specialist (fit + unified render) + backend specialist (unified equip path + schema + migration), collaborative shared `team_name`.
- Push: **staging-first** (`git push origin staging` → verify `staging.clawville.world` → PR → master). Local test `bun run build && bun run start` (NEVER `bun run dev` — Iris Xe). Browser + mobile/iPad verify before any "done."
- Same-diff three-surface knowledge sync if any game-flow/agent-action changes: Nori `knowledge[]` (`town-guide.ts`), connection SKILL.md + `PROTOCOL_VERSION`, hosted-agent runtime. Adding an agent equip action → Hatcher whitelist (`npc-simulation.ts`) parity.

## Key paths quick-ref
- Schema `packages/database/src/schema/cosmetics.ts` · seed `packages/database/scripts/seed-milady-cosmetics.ts` · unapplied FK `packages/database/drizzle/phase3-cosmetics-restrict.sql`
- API `apps/api/src/routes/cosmetics.ts` · resolver `apps/api/src/middleware/require-auth-or-agent.ts` · cove ref `apps/api/src/routes/cove-blackjack.ts:246`
- 3D attach `apps/web/src/lib/three/cosmetic-loader.tsx` · only mount `apps/web/src/lib/three/player-avatar.tsx:686` · sizing `apps/web/src/lib/three/vrm-avatar-sizing.ts` · animator `apps/web/src/lib/three/vrm-character-animator.ts` · NPC `apps/web/src/lib/three/arena-npcs.tsx`
- Drawer `apps/web/src/components/game/cosmetic-drawer.tsx` · gate bug `apps/web/src/app/game/page.tsx:480,496` · store `apps/web/src/stores/game.ts:174`
- Assets `apps/web/public/cosmetics/{hats,glasses}/*.glb` · gen `apps/web/scripts/generate-cosmetic-glbs.mjs`
- Spec `.claude/plans/gamification-economy-and-shop-q3.md §4`
