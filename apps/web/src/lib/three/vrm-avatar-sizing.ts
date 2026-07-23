/**
 * vrm-avatar-sizing.ts
 *
 * Single source of truth for humanoid VRM avatar sizing in the world.
 *
 * Why this exists:
 *   VRMs in ClawVille come from two unit conventions —
 *     - VRoid (Milady): meters, feet at local Y=0, bbox.y ≈ 1.6.
 *     - Mixamo (Hermes/Tekk + future Mixamo-rigged characters): centimeters,
 *       HIPS at local Y=0 (feet at Y≈-95cm), bbox.y ≈ 190.
 *   A flat scale value applied to both produces wildly different on-screen
 *   heights. The fix is per-VRM auto-fit: measure the native bbox once, scale
 *   to a single canonical target height, lift by -bbox.min.y so feet land at
 *   world Y=0 regardless of rig convention.
 *
 * Standard: every humanoid VRM (Milady / Hermes / Tekk / future) renders at
 *   VRM_AVATAR_TARGET_HEIGHT_WU = 179.2 world units tall, feet on terrain.
 *   Add a SPECIES_TARGET_HEIGHT_WU override only when accessories (wings,
 *   tall hair, capes) inflate the bbox past the body silhouette and you want
 *   the BODY to read at the standard height (e.g. Tekk fan-wings).
 *
 * Callers:
 *   - apps/web/src/lib/three/arena-npcs.tsx (wandering NPCs)
 *   - apps/web/src/lib/three/player-avatar.tsx (player-controlled VRM)
 *   - any future VRM render site
 *
 * cosmetic-loader.tsx also calls computeCosmeticHeadFit (defined below).
 */

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

/**
 * Default on-screen height (world units) for every humanoid VRM avatar.
 *
 * Set to MATCH NORI (the town-guide character at world center,
 * GUIDE_SCALE=200, rendered separately via town-guide.tsx — not this
 * auto-fit pipeline). User-reported iteration 2026-05-18:
 *   - 179.2 (original): VRMs noticeably shorter than Nori
 *   - 360 (over-correction): VRMs noticeably TALLER than Nori
 *   - 270 (current): tuned from screenshot ratio — Nori was ≈ 75 %
 *     of the 360-scaled player, so 360 × 0.75 = 270
 *
 * Change this and every humanoid resizes uniformly. If Nori herself
 * ever moves to this pipeline, drop her SPECIES_TARGET_HEIGHT_WU
 * override at 270 too.
 */
export const VRM_AVATAR_TARGET_HEIGHT_WU = 270;

/**
 * Per-species/animatorId target-height overrides. Use when a model's bbox
 * is inflated by accessories that aren't the body (wings, cape, tall hair)
 * and you want the BODY to read at the standard height while the prop
 * legitimately overshoots above the headline.
 *
 * Key matches `species` in arena-npcs (registry key like 'tekk') AND
 * `animatorId` from the model registry (also 'tekk'). Both happen to be
 * 'tekk' for tekk; if they ever diverge we'll need separate maps.
 */
export const SPECIES_TARGET_HEIGHT_WU: Record<string, number> = {
  // Cyrus (hermes-male) — user feedback 2026-05-18: looks frail next to
  // the Milady VRMs at the shared 270 base. Bumped +10 % → 297 so he
  // reads as a slightly broader / taller male silhouette without
  // breaking proportions vs Nori. Two keys because the species key on
  // wandering NPCs is `hermes_male` (underscore, from the demo/SSE
  // payload) while the player-avatar path passes `reg.animatorId =
  // 'hermes-male'` (dash); both call sites resolve through this map.
  'hermes-male': 297,
  hermes_male:   297,

  // Phanes — the DEFAULT Hatcher partner avatar (agent-model-registry.ts:
  // `phanes` → animatorId 'hermes-male', pickerHidden, reserved). It shares
  // the hermes-male VRM rig, so it MUST read at the same 297 height.
  //
  // Owner-view (player-avatar.tsx) calls computeVRMAvatarFit(vrm,
  // reg.animatorId) → key 'hermes-male' → 297. Peer/autonomous-view
  // (arena-npcs.tsx computeVRMNpcScale) calls with `npc.species` → key
  // 'phanes', which had NO entry here and fell through to the 270 base —
  // so the SAME Hatcher agent rendered ~10 % taller to its owner than to
  // everyone else (Hatcher review FIX-11 / 3D-3; breaks Rule E5 three-axis
  // parity: one entity, one size whether human-piloted, autonomous, or
  // peer-viewed). 297 here matches the hermes-male value above so both
  // resolution paths agree. Safe because `phanes` is exclusively the
  // Hatcher default avatar — no other species maps to it.
  phanes: 297,

  // Biggie — exclusive avatar (2026-07-23, manual 2-account DB grant; see
  // agent-model-registry.ts). A heavyset 1.85 m male silhouette: matches the
  // hermes-male/phanes male-humanoid height of 297 so he reads comparable to
  // the other agents, not Milady-short. ONE key covers both resolution paths
  // (owner view passes reg.animatorId='biggie', peer view passes
  // modelKey/species 'biggie' — identical string, no FIX-11-class split).
  biggie: 297,

  // Tekk — design intent is "taller than everyone else" + wing-bbox
  // overhead. Iteration 2026-05-18:
  //   - 230 (original): body ~Milady height, wings fan above (base 179.2)
  //   - 460 (after 360 retune): "bigger than some buildings", way too big
  //   - 346 (after 270 retune): still too big
  //   - 320 (current): body lands ~310 wu (≈ 15 % taller than base
  //     270), bbox ceiling ~320 to give wings just a little headroom.
  //     If this still reads as "too big" drop to 300.
  tekk: 320,

  // Chibi class (added 2026-05-21) — eliza-chibi + milady-chibi share
  // animatorId='chibi'. User direction: "around half the height of the
  // others". Base 270 → half = 135. Both chibis use this override.
  chibi: 135,
};

/**
 * Fallback scale if a caller hits the no-vrm path. Sized for a 1.6m Milady
 * so the placeholder reads at the standard height. Most callers should
 * already early-return before this matters.
 */
// Sized so a 1.6m placeholder renders at VRM_AVATAR_TARGET_HEIGHT_WU
// (270 / 1.6 ≈ 169). Most call sites early-return before hitting this;
// it only matters if a VRM is unavailable at measurement time.
export const VRM_AVATAR_FALLBACK_SCALE = 169;

/**
 * Compute the per-VRM render scale + foot-grounding offsetY so the avatar
 * stands at VRM_AVATAR_TARGET_HEIGHT_WU on screen with feet at world Y=0,
 * regardless of the source rig's pivot convention.
 *
 *  - Milady (VRoid spec): feet at local Y=0, bbox.min.y ≈ 0 → offsetY ≈ 0.
 *  - Hermes / Tekk (Mixamo rig): HIPS at local Y=0, feet at Y≈-95cm.
 *    Without the offset, scale alone leaves the feet at world Y≈-87 (buried).
 *
 * Mutates vrm.scene.scale during measurement and restores it before returning.
 */
export function computeVRMAvatarFit(
  vrm: { scene: THREE.Object3D } | null | undefined,
  speciesOrAnimatorId?: string,
  /**
   * Optional explicit target height (world units). When provided, takes
   * precedence over SPECIES_TARGET_HEIGHT_WU and VRM_AVATAR_TARGET_HEIGHT_WU.
   * Used by the cove interior to pass COVE_VRM_TARGET_HEIGHT without
   * polluting the shared SPECIES_TARGET_HEIGHT_WU map with a scene-specific
   * override.
   */
  targetHeightOverride?: number,
): { scale: number; offsetY: number } {
  if (!vrm) return { scale: VRM_AVATAR_FALLBACK_SCALE, offsetY: 0 };
  const prev = vrm.scene.scale.clone();
  vrm.scene.scale.setScalar(1);
  vrm.scene.updateMatrixWorld(true);
  // Settle skeleton bone matrices before measuring the bbox.
  //
  // Box3.setFromObject on a SkinnedMesh calls applyBoneTransform per vertex,
  // which reads skeleton.boneMatrices. Those matrices are only correct after
  // skeleton.update() runs — updateMatrixWorld alone does NOT compute them.
  // A freshly-parsed VRM whose animator has never ticked (the common case at
  // useMemo time, before the animator useEffect runs) has zero boneMatrices,
  // so every vertex maps to near-origin → size.y ≈ 0 → scale falls back to
  // VRM_AVATAR_FALLBACK_SCALE (169). For a Mixamo cm-rig with native bbox
  // ~194 units tall that's 169 × 194 = 32,786wu — the documented giant.
  //
  // Calling skeleton.update() here forces bind-pose matrices so the bbox
  // reflects the actual rest-pose silhouette. This is an idempotent read —
  // we restore vrm.scene.scale and updateMatrixWorld before returning.
  vrm.scene.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
      const sm = obj as THREE.SkinnedMesh;
      if (sm.skeleton) sm.skeleton.update();
    }
  });
  const box = new THREE.Box3().setFromObject(vrm.scene as unknown as THREE.Object3D);
  const size = new THREE.Vector3();
  box.getSize(size);
  vrm.scene.scale.copy(prev);
  vrm.scene.updateMatrixWorld(true);

  const target =
    targetHeightOverride ||
    (speciesOrAnimatorId && SPECIES_TARGET_HEIGHT_WU[speciesOrAnimatorId]) ||
    VRM_AVATAR_TARGET_HEIGHT_WU;
  const scale = size.y > 0 ? target / size.y : VRM_AVATAR_FALLBACK_SCALE;
  // Lift the model so its lowest point (feet) lands at world Y=0. For Mixamo
  // rigs box.min.y is negative (feet below hips/pivot) → offsetY > 0.
  const offsetY = -box.min.y * scale;
  return { scale, offsetY };
}

// ---------------------------------------------------------------------------
// Cosmetic head-fit helper
// ---------------------------------------------------------------------------

/**
 * Axis-sign-safe cosmetic placement in head-bone-LOCAL space.
 *
 * DESIGN RATIONALE (2026-06-07 plan §"DESIGN REFINEMENT"):
 *
 *   Every ClawVille humanoid VRM (Milady, Hermes, Tekk, Phanes, chibi) has
 *   a VRM humanoid 'head' bone. The convention (VRM0 vs VRM1, Mixamo vs
 *   VRoid rig origin) differs across rigs. Rather than hardcoding ±Z forward,
 *   we:
 *
 *     1. Find the head bone's WORLD position at rest (matrixWorld already
 *        updated by computeVRMAvatarFit / caller's updateMatrixWorld).
 *     2. Measure the head region's WORLD-space bounding box by traversing
 *        geometry children of the head bone subtree (skipping SkinnedMesh
 *        nodes whose bind-pose bbox is unreliable at scale — see
 *        gotcha skinned-mesh-bbox-inflation.md).
 *     3. Derive hat/glasses target position in WORLD space (head-top + lift
 *        for hats; eye-level + body-forward-offset for glasses).
 *     4. Convert to HEAD-BONE-LOCAL via boneMat.invert().  This is
 *        convention-agnostic — the matrix handles any sign combination.
 *
 *   The GLB cosmetic assets were authored in metric (meters) for a Mixamo-
 *   scale rig where the head-bone-local frame is approximately the same size
 *   as a real head (~0.2m wide). The `scale` output enlarges them into world
 *   units proportional to the measured head width.
 *
 *   Per-item assetMeta nudges (optional offsetXYZ / scaleHint) are applied
 *   ON TOP of the computed fit by the caller (HatOrGlassesRenderer).
 *
 * PERFORMANCE: this function is called ONCE at equip time (effect setup),
 * NOT per frame. Internal scratch vectors/matrices are local to the call —
 * per the Iris Xe invariant, no per-frame allocations.
 *
 * @param vrm - the loaded VRM instance (must have humanoid + scene).
 *   vrm.scene.matrixWorld must be up to date (call updateMatrixWorld first,
 *   which computeVRMAvatarFit already does; callers that don't go through
 *   that helper should call vrm.scene.updateMatrixWorld(true) before here).
 * @param category - 'hat' | 'glasses'
 * @param renderScale - the world scale applied to vrm.scene (from computeVRMAvatarFit).
 *   Required to convert head-bone native units → world units.
 * @returns { localPosition, desiredWorldWidth, headWidthWU } or null if no head bone.
 *   localPosition:     THREE.Vector3 in head-bone-local space for the cosmetic Group.
 *   desiredWorldWidth: target world-space width the cosmetic should occupy.
 *                      HatOrGlassesRenderer converts this to a local scale after
 *                      measuring the GLB asset width and bone world scale.
 *   headWidthWU:       head width in world units (diagnostic + nudge math).
 */
export interface CosmeticHeadFitResult {
  localPosition: THREE.Vector3;
  /**
   * Desired WORLD width (world units) the cosmetic should occupy.
   * = headWidthWU * CATEGORY_WIDTH_FACTOR[category].
   * HatOrGlassesRenderer converts this to a local scale after measuring
   * the GLB asset's authored width and the bone's world scale, eliminating
   * the magic-30 and the bone-world-scale-frame error (BUG 2).
   */
  desiredWorldWidth: number;
  /** head width in world units (diagnostic + used for nudge math in caller) */
  headWidthWU:   number;
}

/**
 * Ratio of head width to head height for a typical humanoid VRM head.
 * Used as fallback by computeCosmeticHeadFit when no skinned head verts
 * are found (non-skinned rig).  Value ≈ 0.85 (a humanoid head is slightly
 * narrower than it is tall).
 * Tunable by the orchestrator in browser: adjust here and rebuild.
 */
export const HEAD_WIDTH_TO_HEIGHT = 0.85;

/**
 * Per-category desired world width of the cosmetic as a fraction of headWidthWU.
 * hat:    slightly wider than the head (brim overhang)
 * glasses: slightly narrower than the head width (lens-to-lens span)
 * Tunable by the orchestrator in browser: adjust here and rebuild.
 */
export const CATEGORY_WIDTH_FACTOR: Record<'hat' | 'glasses', number> = {
  hat:     1.15,   // crown wide enough to CONTAIN the top hair (reduce poke-through)
  glasses: 0.62,   // span eye-to-eye and sit ON the face (not head-wide goggles)
};

/**
 * Per-rig head-fit overrides for avatars whose skin weights CORRUPT the
 * automatic head measurement (no clean strong-weight signal exists on them):
 *   - the chibi weights its whole upper body to the head bone → head measured
 *     ~2.5x too big → giant hat that reads as floating;
 *   - Hermes weights only her upper skull → head measured small/high → the hat
 *     is swallowed by her (un-head-weighted) hair.
 * Keyed by the avatar's rig key. Applied ON TOP of the measured head box:
 *   widthMul     — scales head width + depth (→ cosmetic size)
 *   heightMul    — scales head height (→ hat drop depth + glasses eye span)
 *   topShiftFrac — shifts the head TOP up(+)/down(-) by a fraction of head height
 * Tunable in /preview/cosmetics. A new corrupted rig gets an entry here — and
 * should be flagged by a head-weight sanity check in the avatar pipeline.
 */
export interface RigHeadOverride {
  /** When true, DISCARD the corrupt vert measurement and anchor the head box to
   *  the head BONE using the metre dims below × bone world scale. */
  boneAnchored?: boolean;
  /** Crown Y relative to the head bone, native metres (× bone scale). MAY be
   *  NEGATIVE — some broken rigs place the head MESH below the 'head' bone. */
  headTopAboveBoneM?: number;
  /** Head height (drives hat drop + glasses eye span), native metres. Falls back
   *  to headTopAboveBoneM when omitted. Kept SEPARATE so the crown can sit below
   *  the bone while the head still has a positive height. */
  headHeightM?: number;
  /** Head width / depth, native metres (× bone scale). */
  headWidthM?: number;
  headDepthM?: number;
  /** When true, IGNORE the head bone AND skin-weight measurement entirely and
   *  measure the head as the TOP SLAB of the posed body AABB: crown = body
   *  max.y, head = the top `headFraction` of total body height, centred on the
   *  body's X/Z. For chibi-class rigs whose auto-rig (Mixamo OR Meshy) both
   *  drops the 'head' bone far below the real head AND rigidly weights 40–60% of
   *  the body to it — so neither boneAnchored nor vert-weight finds the head, but
   *  the silhouette top always does (pigtails/side-hair cancel on a symmetric
   *  body, so the centre stays put and width is derived from height, not the raw
   *  slab). */
  geometricTopSlab?: boolean;
  /** Head height as a fraction of total body height, for geometricTopSlab
   *  (default 0.42). Tunable on /preview/cosmetics. */
  headFraction?: number;
}

export const RIG_HEAD_OVERRIDE: Record<string, RigHeadOverride> = {
  // These rigs weight the head bone so badly the vert measurement is wrong in
  // BOTH position and size — so we bone-anchor them. Metres tuned on
  // /preview/cosmetics (?{rig}Top=&{rig}H=&{rig}W=).
  //
  // Hermes: SOLVED — looks worn (top hat at her hairline). ✅
  hermes: { boneAnchored: true, headTopAboveBoneM: 0.22, headWidthM: 0.32 },
  // chibi: GEOMETRIC TOP-SLAB measure (2026-06-19). MEASURED ground truth: both
  // chibis' auto-rigs place the 'head' bone at 42–58% of body height (eliza 57.6%,
  // milady 42%) — FAR below the real head (crown at ~100%) — so the old
  // boneAnchored override dropped the hat to the low bone → it landed on the
  // neck/chest (the user-reported bug). A faithful Meshy re-rig was validated and
  // does NOT help: Meshy weights 41%+ of the body (chest→crown) to the head bone
  // too — a chibi's head dominates the silhouette, so no auto-rigger isolates it.
  // The head IS reliably the top ~42% of the silhouette, so we measure it
  // geometrically instead of trusting the broken bone/weights. headFraction tuned
  // so the head spans ~crown..neck (eliza 1.10→1.90, milady 1.10→1.90 in rig m).
  chibi: { geometricTopSlab: true, headFraction: 0.42 },
};

/**
 * How far the hat DROPS onto the head, as a fraction of measured head height.
 * A real hat is not balanced on the crown — the head goes UP INTO the hat, so
 * the hat base sits BELOW the crown (around the upper head / hairline).
 * 0.0 = base at crown (floats); 0.30 ≈ base ~1/3 down the head so the brim
 * sits BELOW the hairline (crown contains the top hair) = worn look, not plonked.
 * Tunable by the orchestrator in browser.
 */
const HAT_DROP_FRACTION = 0.30;

/**
 * Glasses sit at this fraction of measured head height BELOW the head top.
 * Eyes are roughly mid-face, ~0.52 down from the crown on a stylized head.
 * Tunable by the orchestrator in browser.
 */
const GLASSES_EYE_FRACTION = 0.52;

/**
 * How far forward glasses are offset, as a fraction of measured head DEPTH,
 * along the face-forward direction — places the lenses just in front of the
 * face surface (depth/2 ≈ face front) instead of floating off the head.
 */
const GLASSES_FORWARD_FACTOR = 0.45;

/**
 * Minimum skinned-vertex weight contribution from the head bone for a vertex
 * to be included in the head AABB measurement.  0.5 means the head bone must
 * be the dominant influence (> 50 % of the total weight for that vertex).
 */
const HEAD_WEIGHT_THRESHOLD = 0.5;

/**
 * Sign multiplier for the glasses facing offset.
 *
 * Three.js `Object3D.getWorldDirection(target)` returns the object's LOCAL +Z
 * axis in world space — NOT the facing direction.  All ClawVille VRMs end up
 * facing WORLD -Z after load:
 *   - Milady VRM0: `VRMUtils.rotateVRM0` applies a π Y-rotation → faces -Z.
 *   - VRM1.x (Hermes/Tekk/Phanes/chibi): `faceYaw = Math.PI` → faces -Z.
 *
 * Therefore `scene.getWorldDirection()` returns the BACK of the avatar (+Z in
 * world = behind).  Adding it directly would push glasses behind the head.
 *
 * Fix: multiply by `GLASSES_FACING_SIGN = -1` to flip the vector so it
 * points face-forward.
 *
 * The orchestrator can verify the sign in the `/preview/cosmetics` route:
 * if glasses appear behind the head, flip this to +1.
 */
export const GLASSES_FACING_SIGN = -1;

export function computeCosmeticHeadFit(
  vrm: Pick<VRM, 'humanoid' | 'scene'> | null | undefined,
  category: 'hat' | 'glasses',
  renderScale: number,
  rigKey?: string,
  /** Dev tuning: explicit override that wins over the RIG_HEAD_OVERRIDE table. */
  tuningOverride?: RigHeadOverride,
): CosmeticHeadFitResult | null {
  if (!vrm) return null;

  // renderScale is retained in the signature for backwards-compat with existing callers
  // but is no longer used internally — the new algorithm works in world space directly
  // since vrm.scene is already at renderScale in the scene by the time equip runs.
  void renderScale;

  // 1. Get the raw head bone (what the animator actually drives — NOT the
  //    normalized bone used by the AnimationMixer).
  const headBone = vrm.humanoid?.getRawBoneNode?.('head') ?? null;
  if (!headBone) return null;

  // Ensure world matrices are current.  The VRM is already at renderScale
  // in the scene at this point (caller applies scale before calling equip).
  vrm.scene.updateMatrixWorld(true);

  // 2. HEAD-ISOLATED AABB via skinned-vertex traversal.
  //
  //    Walk all SkinnedMesh nodes in vrm.scene.  For each mesh:
  //      a. Find the head bone's index in the skeleton's bone array.
  //      b. Iterate all vertices; for each, check the 4 skin-influence pairs
  //         (skinIndex, skinWeight).  Include the vertex IFF the head bone's
  //         total weight contribution >= HEAD_WEIGHT_THRESHOLD (0.5).
  //      c. Call sm.applyBoneTransform(vertexIndex, tmp) to pose the vertex
  //         at the current skeleton state (Three.js r182 SkinnedMesh.js:319).
  //      d. sm.localToWorld(tmp) to convert to world space.
  //      e. Expand headBox.
  //
  //    Cosmetics are plain THREE.Group (no SkinnedMesh), so they are auto-
  //    excluded from the vertex loop — no name-prefix check needed.
  //
  //    If headBox is still empty after the loop (non-skinned rig, or avatar
  //    scene has no meshes yet), fall back to the BONE-ANCHORED body-bbox
  //    estimate (the previous "reconciler pass" algorithm) so the function
  //    never returns null on a valid VRM with a head bone.
  // 2. ROBUST GEOMETRIC HEAD MEASUREMENT (rig-independent). Production auto-rigs
  //    vary wildly in how they skin the head — the chibi weights its whole upper
  //    body to the head bone; Hermes weights only her upper skull — so we do NOT
  //    trust skin weights for the head EXTENT. Two passes:
  //      PASS 1 (seed): collect verts STRONGLY weighted to the head bone (>= 0.9).
  //        Only the actual skull is ever weighted that high, so this rejects
  //        arms/torso even on a bad rig → a clean head CENTRE + rough scale.
  //        Drops the threshold if a rig has too few strong verts.
  //      PASS 2 (geometric expand): from that seed, scan ALL skinned verts that
  //        are geometrically NEAR the seed centre (seed-scaled radius) and above
  //        its base → the full head+hair AABB by LOCATION, not weight. Captures
  //        hair the head bone doesn't own (fixes Hermes) and excludes far body
  //        verts (fixes chibi).
  const seedBox = new THREE.Box3();
  const tmp = new THREE.Vector3();
  let seedCount = 0;
  for (const seedThreshold of [0.9, 0.7, 0.5]) {
    seedBox.makeEmpty();
    seedCount = 0;
    vrm.scene.traverse((child) => {
      const sm = child as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton || !sm.geometry) return;
      const headBoneIndex = sm.skeleton.bones.indexOf(headBone as THREE.Bone);
      if (headBoneIndex === -1) return;
      const si = sm.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
      const sw = sm.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
      const pos = sm.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!si || !sw || !pos) return;
      // equip-on-load race: refresh boneMatrices so applyBoneTransform is valid.
      sm.skeleton.update();
      for (let i = 0; i < pos.count; i++) {
        let w = 0;
        for (let s = 0; s < 4; s++) if (si.getComponent(i, s) === headBoneIndex) w += sw.getComponent(i, s);
        if (w < seedThreshold) continue;
        tmp.fromBufferAttribute(pos, i);
        sm.applyBoneTransform(i, tmp);
        sm.localToWorld(tmp);
        if (!isFinite(tmp.x) || !isFinite(tmp.y) || !isFinite(tmp.z)) continue;
        seedBox.expandByPoint(tmp);
        seedCount++;
      }
    });
    if (seedCount >= 8) break;
  }

  // 3. Derive measurement values from the geometric head AABB (or fall back).
  let headTopWorldY: number;
  let headWidthWU: number;
  let headHeightWU: number;
  let headDepthWU: number;
  let headCenterX: number;
  let headCenterZ: number;
  const eps = 1e-4;

  if (seedCount >= 8 && !seedBox.isEmpty()) {
    const seedCenter = new THREE.Vector3(); seedBox.getCenter(seedCenter);
    const seedSize = new THREE.Vector3(); seedBox.getSize(seedSize);

    // The strong-weight seed IS the head (skull): clean across rigs because only
    // the skull is ever weighted >=0.9, so arms/torso (chibi) are already gone.
    // Use it directly for WIDTH / DEPTH / CENTRE. Then a TIGHT, UPWARD-ONLY scan
    // extends the TOP to a hair crown sitting DIRECTLY above the skull (radius =
    // skull half-width, y strictly above the seed top, capped) so the hat clears
    // the hair WITHOUT catching shoulders, wings, or side-hair (which inflated
    // the earlier greedy expansion: Milady w 71->137, Tekk caught its wings).
    const topRadius = Math.max(seedSize.x, seedSize.z, eps) * 0.55;
    const topR2 = topRadius * topRadius;
    const crownCeil = seedBox.max.y + Math.max(seedSize.y, eps) * 0.6; // hair adds <=60% skull height
    const gtmp = new THREE.Vector3();
    let crownY = seedBox.max.y;
    vrm.scene.traverse((child) => {
      const sm = child as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton || !sm.geometry) return;
      const pos = sm.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      sm.skeleton.update();
      const step = pos.count > 15000 ? 3 : 1; // subsample huge meshes
      for (let i = 0; i < pos.count; i += step) {
        gtmp.fromBufferAttribute(pos, i);
        sm.applyBoneTransform(i, gtmp);
        sm.localToWorld(gtmp);
        if (!isFinite(gtmp.y) || gtmp.y <= seedBox.max.y || gtmp.y > crownCeil) continue;
        const dx = gtmp.x - seedCenter.x;
        const dz = gtmp.z - seedCenter.z;
        if (dx * dx + dz * dz > topR2) continue; // directly above the skull only
        if (gtmp.y > crownY) crownY = gtmp.y;
      }
    });

    headTopWorldY = crownY;
    headHeightWU  = Math.max(crownY - seedBox.min.y, eps);
    headWidthWU   = Math.min(Math.max(seedSize.x, eps), headHeightWU * 1.4);
    headDepthWU   = Math.min(Math.max(seedSize.z, eps), headHeightWU * 1.4);
    headCenterX   = seedCenter.x;
    headCenterZ   = seedCenter.z;
  } else {
    // FALLBACK PATH: no head-weighted verts found (non-skinned rig or T-pose
    // skeleton not bound).  Use the bone-anchored body-bbox approach so the
    // function never returns null for a valid VRM with a head bone.
    const headBoneWorldPos = new THREE.Vector3();
    headBone.getWorldPosition(headBoneWorldPos);

    const bodyBox = new THREE.Box3();
    vrm.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry) return;
      // Skip cosmetic Groups (they are not Mesh, but guard anyway).
      if (child.name.startsWith('cosmetic-')) return;
      const meshBox = new THREE.Box3().setFromObject(mesh);
      if (meshBox.isEmpty()) return;
      bodyBox.union(meshBox);
    });

    if (bodyBox.isEmpty()) return null;

    headTopWorldY = bodyBox.max.y;
    headHeightWU  = Math.max(headTopWorldY - headBoneWorldPos.y, eps);
    headWidthWU   = headHeightWU * HEAD_WIDTH_TO_HEIGHT;
    headDepthWU   = headWidthWU; // assume square cross-section for fallback
    headCenterX   = headBoneWorldPos.x;
    headCenterZ   = headBoneWorldPos.z;
  }

  // 3b. Per-rig correction for avatars whose skin weights corrupt the auto
  //     measurement (see RIG_HEAD_OVERRIDE). For the worst rigs we DISCARD the
  //     vert measurement and anchor to the head BONE (reliable) + override dims.
  const rigOverride = tuningOverride ?? (rigKey ? RIG_HEAD_OVERRIDE[rigKey] : undefined);
  if (rigOverride?.boneAnchored) {
    const hb = new THREE.Vector3(); headBone.getWorldPosition(hb);
    const hsc = new THREE.Vector3(); headBone.getWorldScale(hsc);
    const boneScale = (Math.abs(hsc.x) + Math.abs(hsc.y) + Math.abs(hsc.z)) / 3 || 1;
    const topAboveM = rigOverride.headTopAboveBoneM ?? 0.13;
    // Crown can be ABOVE or BELOW the bone (broken rigs displace the head mesh).
    headTopWorldY = hb.y + topAboveM * boneScale;
    // Height is SEPARATE (defaults to topAbove) so a negative crown still has size.
    headHeightWU  = Math.max((rigOverride.headHeightM ?? Math.abs(topAboveM)) * boneScale, eps);
    headWidthWU   = Math.max((rigOverride.headWidthM ?? 0.15) * boneScale, eps);
    headDepthWU   = Math.max((rigOverride.headDepthM ?? rigOverride.headWidthM ?? 0.15) * boneScale, eps);
    headCenterX   = hb.x;
    headCenterZ   = hb.z;
  } else if (rigOverride?.geometricTopSlab) {
    // GEOMETRIC TOP-SLAB: discard bone + skin-weight entirely. Measure the full
    // posed body AABB; the crown is its max.y; the head is the top `headFraction`
    // of total height, centred on the body's X/Z. Width is derived from the head
    // HEIGHT (not the raw slab) so pigtails / side-hair don't inflate it. Runs
    // ONCE at equip — vert traversal is fine here (NOT per frame).
    const bodyBox = new THREE.Box3();
    const btmp = new THREE.Vector3();
    vrm.scene.traverse((child) => {
      const sm = child as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton || !sm.geometry) return;
      if (sm.name.startsWith('cosmetic-')) return;
      const pos = sm.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      sm.skeleton.update();
      const stride = pos.count > 15000 ? 3 : 1; // subsample huge meshes
      for (let i = 0; i < pos.count; i += stride) {
        btmp.fromBufferAttribute(pos, i);
        sm.applyBoneTransform(i, btmp);
        sm.localToWorld(btmp);
        if (isFinite(btmp.x) && isFinite(btmp.y) && isFinite(btmp.z)) bodyBox.expandByPoint(btmp);
      }
    });
    if (!bodyBox.isEmpty()) {
      const bsz = new THREE.Vector3(); bodyBox.getSize(bsz);
      const bctr = new THREE.Vector3(); bodyBox.getCenter(bctr);
      const frac = rigOverride.headFraction ?? 0.42;
      headTopWorldY = bodyBox.max.y;                                  // crown
      headHeightWU  = Math.max(bsz.y * frac, eps);                    // top frac of body
      headWidthWU   = Math.max(headHeightWU * HEAD_WIDTH_TO_HEIGHT, eps);
      headDepthWU   = headWidthWU;
      headCenterX   = bctr.x;
      headCenterZ   = bctr.z;
    }
  }

  // 4. desiredWorldWidth: the world width we want the cosmetic to occupy.
  const desiredWorldWidth = headWidthWU * CATEGORY_WIDTH_FACTOR[category];

  // 5. Compute WORLD-SPACE target position of the cosmetic.
  //
  //    Hat:    hover directly above the head top + HAT_CLEARANCE_WU.
  //    Glasses: at eye level (GLASSES_EYE_FRACTION below head-top) with a
  //             forward offset along the body-facing direction.
  //
  //    FACING DIRECTION (robust, per-avatar):
  //    The NORMALIZED head bone faces world -Z by VRM spec — true for BOTH VRM0
  //    and VRM1 after three-vrm normalization, and it tracks the scene's
  //    rotation. So its world -Z axis IS the avatar's face-forward, regardless
  //    of rig convention. This fixes glasses rendering behind/inside the head on
  //    the VRM1 rigs, where the global getWorldDirection sign was wrong (it only
  //    held for one orientation). Falls back to the legacy raw direction.
  const facingDirWorld = new THREE.Vector3(0, 0, -1);
  const normHeadBone = vrm.humanoid?.getNormalizedBoneNode?.('head') ?? null;
  if (normHeadBone) {
    // The normalized bone tree is updated by vrm.update() (a separate hierarchy
    // from the raw skeleton). Force its world matrix current in case equip runs
    // before the first vrm.update() — otherwise the face quaternion is stale.
    normHeadBone.updateWorldMatrix(true, false);
    const faceQuat = new THREE.Quaternion();
    normHeadBone.getWorldQuaternion(faceQuat);
    facingDirWorld.set(0, 0, -1).applyQuaternion(faceQuat);
  } else {
    vrm.scene.getWorldDirection(facingDirWorld);
    facingDirWorld.multiplyScalar(GLASSES_FACING_SIGN);
  }
  facingDirWorld.y = 0; // keep forward horizontal
  if (facingDirWorld.lengthSq() < 1e-8) facingDirWorld.set(0, 0, -1);
  facingDirWorld.normalize();

  let targetWorldPos: THREE.Vector3;

  if (category === 'hat') {
    // Drop the hat DOWN onto the head (base below the crown) so the head fills
    // the hat opening — a worn look, not balanced-on-top.
    targetWorldPos = new THREE.Vector3(
      headCenterX,
      headTopWorldY - headHeightWU * HAT_DROP_FRACTION,
      headCenterZ,
    );
  } else {
    // 'glasses': eye level (measured head height below the crown) + forward offset
    // along the face-forward dir, sized by measured head DEPTH so the lenses sit
    // just in front of the face surface.
    const eyeLevelWorldY = headTopWorldY - headHeightWU * GLASSES_EYE_FRACTION;
    const forwardOffsetWU = headDepthWU * GLASSES_FORWARD_FACTOR;
    targetWorldPos = new THREE.Vector3(
      headCenterX + facingDirWorld.x * forwardOffsetWU,
      eyeLevelWorldY,
      headCenterZ + facingDirWorld.z * forwardOffsetWU,
    );
  }

  // 6. Convert world-space target → HEAD-BONE-LOCAL via the bone's inverse
  //    world matrix.  AXIS-SIGN SAFE for any rig convention.
  const invBoneMat = new THREE.Matrix4().copy(headBone.matrixWorld).invert();
  const localPosition = targetWorldPos.clone().applyMatrix4(invBoneMat);

  // Guard final output for NaN (degenerate matrix inversion).
  if (!isFinite(localPosition.x) || !isFinite(localPosition.y) || !isFinite(localPosition.z)) {
    return null;
  }

  return { localPosition, desiredWorldWidth, headWidthWU };
}

/**
 * Tunable: how far the hat's "hide footprint" radius is, as a fraction of head
 * width, and how far BELOW the brim plane we start hiding (so the brim line
 * itself is clean). Tuned on /preview/cosmetics (?{rig}HideR=&{rig}HideY=).
 */
export const SCALP_HIDE_RADIUS_FACTOR = 0.62;
export const SCALP_HIDE_DROP_WU = 2;

/**
 * Hide the avatar's body-mesh geometry UNDER a hat so baked-in hair/scalp cannot
 * poke through it. Most ClawVille avatars are a SINGLE fused mesh (hair baked
 * into the body, one material — see VRM inspection 2026-06-07), so the hair can't
 * be hidden by toggling a separate mesh. Instead we drop the index-buffer
 * TRIANGLES whose posed centroid is inside the hat footprint (above the brim
 * plane, within `radius`); the opaque hat covers the removed region. The face
 * (below the brim) is untouched.
 *
 * Reversible — returns a restore fn (call on unequip / hat swap). Posed positions
 * use applyBoneTransform (with skeleton.update first, per the equip-on-load race),
 * computed once per vertex. NOT called for glasses.
 */
export function hideHeadGeometryUnderHat(
  vrm: { scene: THREE.Object3D },
  brimWorldY: number,
  centerX: number,
  centerZ: number,
  radius: number,
): () => void {
  const restores: Array<() => void> = [];
  const r2 = radius * radius;
  const yFloor = brimWorldY - SCALP_HIDE_DROP_WU;
  const tmp = new THREE.Vector3();
  vrm.scene.traverse((child) => {
    const sm = child as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.skeleton || !sm.geometry) return;
    if (sm.name.startsWith('cosmetic-')) return;
    const geo = sm.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    const index = geo.index;
    if (!pos || !index) return;
    sm.skeleton.update();
    const n = pos.count;
    const wx = new Float32Array(n);
    const wy = new Float32Array(n);
    const wz = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      tmp.fromBufferAttribute(pos, v);
      sm.applyBoneTransform(v, tmp);
      sm.localToWorld(tmp);
      wx[v] = tmp.x; wy[v] = tmp.y; wz[v] = tmp.z;
    }
    const src = index.array;
    const kept: number[] = [];
    let removed = 0;
    for (let t = 0; t < src.length; t += 3) {
      const a = src[t], b = src[t + 1], c = src[t + 2];
      const cx = (wx[a] + wx[b] + wx[c]) / 3;
      const cy = (wy[a] + wy[b] + wy[c]) / 3;
      const cz = (wz[a] + wz[b] + wz[c]) / 3;
      const dx = cx - centerX, dz = cz - centerZ;
      if (cy >= yFloor && dx * dx + dz * dz <= r2) { removed++; continue; }
      kept.push(a, b, c);
    }
    if (removed === 0) return;
    const Arr = (src as Uint8Array | Uint16Array | Uint32Array).constructor as
      | Uint16ArrayConstructor
      | Uint32ArrayConstructor;
    geo.setIndex(new THREE.BufferAttribute(new Arr(kept), 1));
    restores.push(() => geo.setIndex(index));
  });
  return () => restores.forEach((r) => r());
}
