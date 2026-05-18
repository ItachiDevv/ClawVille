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
  tekk: 346, // 270 × 1.28 — body lands at Nori/Milady height, wings fan above (kept proportional through the 2026-05-18 retune 179.2 → 360 → 270)
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
): { scale: number; offsetY: number } {
  if (!vrm) return { scale: VRM_AVATAR_FALLBACK_SCALE, offsetY: 0 };
  const prev = vrm.scene.scale.clone();
  vrm.scene.scale.setScalar(1);
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  vrm.scene.scale.copy(prev);
  vrm.scene.updateMatrixWorld(true);

  const target =
    (speciesOrAnimatorId && SPECIES_TARGET_HEIGHT_WU[speciesOrAnimatorId]) ||
    VRM_AVATAR_TARGET_HEIGHT_WU;
  const scale = size.y > 0 ? target / size.y : VRM_AVATAR_FALLBACK_SCALE;
  // Lift the model so its lowest point (feet) lands at world Y=0. For Mixamo
  // rigs box.min.y is negative (feet below hips/pivot) → offsetY > 0.
  const offsetY = -box.min.y * scale;
  return { scale, offsetY };
}
