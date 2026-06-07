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
 * @returns { localPosition, localScale, headWidthWU } or null if no head bone.
 *   localPosition: THREE.Vector3 in head-bone-local space for the cosmetic Group.
 *   localScale:    uniform scale (scalar) for the cosmetic Group.
 *   headWidthWU:   head width in world units (diagnostic, also used by caller for
 *                  per-category override math).
 */
export interface CosmeticHeadFitResult {
  localPosition: THREE.Vector3;
  localScale:    number;
  /** head bounding-box width in world units (useful for debugging + nudge math) */
  headWidthWU:   number;
}

/**
 * Reference head width (world units) the cosmetic GLBs were authored for.
 *
 * The procedural placeholder GLBs (generate-cosmetic-glbs.mjs) were built in
 * metric. A Milady VRM at renderScale ≈ 169 has a head bbox ≈ 28–34 wu wide.
 * We use 30 wu as the design reference — cosmetics authored at 1× scale look
 * correct on Milady at 30 wu.  Larger/smaller heads get cosmetics scaled
 * proportionally.
 */
export const COSMETIC_REF_HEAD_WIDTH_WU = 30;

/**
 * Hat clearance: extra vertical gap between measured head-top and hat base,
 * in world units.  Prevents the hat from clipping into hair.
 */
const HAT_CLEARANCE_WU = 2;

/**
 * Glasses sit at this fraction below head-top-to-head-bottom.
 * 0.25 ≈ eye-level on a typical humanoid head.
 */
const GLASSES_EYE_FRACTION = 0.25;

/**
 * How far forward (in world units, relative to head width) glasses are offset
 * from the head-bone origin along the BODY-FACING direction.  Prevents clipping
 * into the face.
 */
const GLASSES_FORWARD_FACTOR = 0.5;

export function computeCosmeticHeadFit(
  vrm: {
    humanoid?: { getRawBoneNode?: (name: string) => THREE.Object3D | null } | null;
    scene: THREE.Object3D;
  } | null | undefined,
  category: 'hat' | 'glasses',
  renderScale: number,
): CosmeticHeadFitResult | null {
  if (!vrm) return null;

  // 1. Get the raw head bone (what the animator actually drives — NOT the
  //    normalized bone used by the AnimationMixer).
  const headBone =
    vrm.humanoid?.getRawBoneNode?.('head') ?? null;
  if (!headBone) return null;

  // Ensure world matrices are current.  The VRM is already at renderScale
  // in the scene at this point (caller applies scale before calling equip).
  vrm.scene.updateMatrixWorld(true);

  // 2. World position of the head bone.
  // Scratch vectors — local to this call, never allocated per frame.
  const headBoneWorldPos = new THREE.Vector3();
  headBone.getWorldPosition(headBoneWorldPos);

  // 3. Build WORLD-space AABB of the head region.
  //    We walk DIRECT children of the head bone and any non-SkinnedMesh
  //    descendants whose geometry origin is close to the head bone.
  //    SkinnedMesh bind-pose bboxes are unreliable (see
  //    gotcha: skinned-mesh-bbox-inflation.md) — we skip them.
  //
  //    If no geometry is found under the head bone we fall back to a
  //    fraction of the full body bbox so chibi / low-poly VRMs still get
  //    a sensible estimate.
  const headBox = new THREE.Box3();
  headBone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return; // unreliable bbox
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const geoBbox = mesh.geometry.boundingBox;
    if (!geoBbox) return;
    // Expand the accumulating box with this mesh's geometry in world space.
    const tempBox = geoBbox.clone().applyMatrix4(mesh.matrixWorld);
    headBox.union(tempBox);
  });

  // Fallback: if head subtree has no usable geometry, estimate from full bbox.
  const usedFallback = headBox.isEmpty();
  if (usedFallback) {
    // Estimate head as top 15 % of total body bbox height.
    const bodyBox = new THREE.Box3().setFromObject(vrm.scene as unknown as THREE.Object3D);
    const bodyHeight = bodyBox.max.y - bodyBox.min.y;
    const headTopEst = bodyBox.max.y;
    const headBottomEst = headTopEst - bodyHeight * 0.15;
    const headHalfWidthEst = bodyHeight * 0.08; // typical head width ≈ 16% of body height
    headBox.min.set(
      headBoneWorldPos.x - headHalfWidthEst,
      headBottomEst,
      headBoneWorldPos.z - headHalfWidthEst,
    );
    headBox.max.set(
      headBoneWorldPos.x + headHalfWidthEst,
      headTopEst,
      headBoneWorldPos.z + headHalfWidthEst,
    );
  }

  const headSize = new THREE.Vector3();
  headBox.getSize(headSize);

  const headTopWorldY  = headBox.max.y;
  const headWidthWU    = headSize.x; // WORLD units at current renderScale
  const headHeightWU   = headSize.y;

  // Scale cosmetic proportional to measured head width vs the reference.
  // Clamp to a reasonable range to avoid absurdly large/tiny cosmetics on
  // edge cases (e.g. a very low-poly head mesh with a 1-triangle bbox).
  const rawScale = headWidthWU / COSMETIC_REF_HEAD_WIDTH_WU;
  const localScale = Math.max(0.25, Math.min(4.0, rawScale));

  // 4. Compute WORLD-SPACE target position of the cosmetic.
  //
  //    Hat: hover directly above the head top, slightly inward along Y.
  //    Glasses: at eye level (fraction below head top) with a forward offset
  //    along the body-facing direction.
  //
  //    Body facing direction in WORLD space:
  //    We read the avatar scene's +Z-local axis in world space and NEGATE it
  //    to get the facing direction. All ClawVille VRMs face -Z after load
  //    (memory: feedback_vrm_facing_formula — Milady VRM0 gets rotateVRM0
  //    which adds π, flipping to face -Z; Hermes/Tekk/Phanes/chibi VRM1.x
  //    face +Z natively and get faceYaw=Math.PI applied in the picker/world
  //    scene, also ending at -Z).  So the face direction = scene.getWorldDirection()
  //    which returns the -Z local axis in world space.
  const facingDirWorld = new THREE.Vector3();
  vrm.scene.getWorldDirection(facingDirWorld); // −Z axis in world space = face forward

  let targetWorldPos: THREE.Vector3;

  if (category === 'hat') {
    // Place at head top + clearance, above head bone center XZ.
    const centerX = (headBox.min.x + headBox.max.x) * 0.5;
    const centerZ = (headBox.min.z + headBox.max.z) * 0.5;
    targetWorldPos = new THREE.Vector3(
      centerX,
      headTopWorldY + HAT_CLEARANCE_WU * localScale,
      centerZ,
    );
  } else {
    // 'glasses': place at eye level, shifted forward.
    const eyeLevelWorldY = headTopWorldY - headHeightWU * GLASSES_EYE_FRACTION;
    const forwardOffsetWU = headWidthWU * GLASSES_FORWARD_FACTOR;
    const centerX = (headBox.min.x + headBox.max.x) * 0.5;
    const centerZ = (headBox.min.z + headBox.max.z) * 0.5;
    targetWorldPos = new THREE.Vector3(
      centerX + facingDirWorld.x * forwardOffsetWU,
      eyeLevelWorldY,
      centerZ + facingDirWorld.z * forwardOffsetWU,
    );
  }

  // 5. Convert world-space target position to HEAD-BONE-LOCAL space via the
  //    bone's inverse world matrix.  This is AXIS-SIGN SAFE — it handles any
  //    rig convention (VRM0 +Z forward, VRM1 -Z forward, Mixamo cm origin,
  //    VRoid m origin) without a single hardcoded ±Z.
  const invBoneMat = new THREE.Matrix4().copy(headBone.matrixWorld).invert();
  const localPosition = targetWorldPos.clone().applyMatrix4(invBoneMat);

  return { localPosition, localScale, headWidthWU };
}
