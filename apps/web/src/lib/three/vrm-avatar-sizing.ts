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
