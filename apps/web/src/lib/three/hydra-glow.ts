/**
 * hydra-glow.ts — emissive pulse for the Hydra wandering NPC (2026-10-31).
 *
 * Hydra's VRM (`/avatars/hydra-w30k.vrm`, registry key `hydra`, animatorId
 * `hydra`) has ONE glTF material whose `emissiveTexture` is a purpose-built
 * glow mask (neon-blue suit lines, chest H emblem, ring earpieces, mask line,
 * eyes; black elsewhere) with emissiveFactor (1,1,1). The file carries no
 * VRMC_materials_mtoon extension, so the loader keeps it a
 * MeshStandardMaterial. The main world has NO bloom pass: the glow is only
 * emissive brightness, so the pulse drives `emissiveIntensity`.
 *
 * Identity: callers pass the registry animatorId; only `hydra` is touched.
 * Never match by material/mesh name.
 *
 * Material sharing: vrm-loader parses one fully disjoint VRM per
 * (path, instanceId). Textures are deduped across instances, materials are
 * not, so every Hydra instance owns its material and the write never leaks
 * into another model.
 *
 * Per-frame cost: one Math.sin + one number write per collected material
 * (Hydra has exactly one). The material list is collected ONCE per loaded
 * instance; no traversal, no allocation per frame. In WebGPU the material
 * cache key reduces numbers to on/off, so a value in [0.8, 2.6] never forces
 * a pipeline rebuild; the change only refreshes the material uniform.
 */
import type * as THREE from 'three';

/** Registry animatorId of the Hydra NPC VRM (agent-model-registry.ts). */
export const HYDRA_ANIMATOR_ID = 'hydra';

/** Floor of the pulse (emissiveIntensity). */
export const HYDRA_GLOW_MIN_INTENSITY = 0.8;
/** Peak-to-floor swing; peak = MIN + AMPLITUDE = 2.6. */
export const HYDRA_GLOW_AMPLITUDE = 1.8;
/** Pulse frequency in Hz (one full breath every ~1.8 s). */
export const HYDRA_GLOW_FREQUENCY_HZ = 0.55;
/** Steady mid glow held when the viewer prefers reduced motion. */
export const HYDRA_GLOW_STEADY_INTENSITY =
  HYDRA_GLOW_MIN_INTENSITY + HYDRA_GLOW_AMPLITUDE * 0.5;

const HYDRA_GLOW_OMEGA = Math.PI * 2 * HYDRA_GLOW_FREQUENCY_HZ;

/** A material slot the pulse writes (MeshStandardMaterial or MToonMaterial). */
export type HydraGlowMaterial = THREE.Material & { emissiveIntensity: number };

/** Shared empty list: non-Hydra instances allocate nothing. */
export const NO_HYDRA_GLOW_MATERIALS: readonly HydraGlowMaterial[] = Object.freeze([]);

/** emissiveIntensity at time `tSeconds`: 0.8 + 1.8 * (0.5 + 0.5 * sin(t * 2π * 0.55)). */
export function hydraGlowIntensity(tSeconds: number): number {
  return (
    HYDRA_GLOW_MIN_INTENSITY
    + HYDRA_GLOW_AMPLITUDE * (0.5 + 0.5 * Math.sin(tSeconds * HYDRA_GLOW_OMEGA))
  );
}

/** True when the browser reports `prefers-reduced-motion: reduce`. SSR-safe. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Run ONCE per loaded VRM instance (mount effect, never per frame).
 *
 * - animatorId !== 'hydra': returns the shared empty list, touches nothing.
 * - Hydra: collects every distinct material with a numeric `emissiveIntensity`
 *   AND an `emissiveMap` (the glow mask; a material without the mask would
 *   glow uniformly, so it is left alone).
 * - reducedMotion: writes the steady mid glow once and returns the empty
 *   list, so the per-frame path does no work at all.
 *
 * Returns the list the per-frame update must pulse.
 */
export function prepareHydraGlow(
  root: THREE.Object3D,
  animatorId: string | undefined,
  reducedMotion: boolean,
): readonly HydraGlowMaterial[] {
  if (animatorId !== HYDRA_ANIMATOR_ID) return NO_HYDRA_GLOW_MATERIALS;
  const found: HydraGlowMaterial[] = [];
  root.traverse((obj) => {
    const material = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const entry of list) {
      const candidate = entry as THREE.Material & {
        emissiveIntensity?: unknown;
        emissiveMap?: unknown;
      };
      if (
        typeof candidate.emissiveIntensity === 'number'
        && candidate.emissiveMap
        && !found.includes(candidate as HydraGlowMaterial)
      ) {
        found.push(candidate as HydraGlowMaterial);
      }
    }
  });
  if (reducedMotion) {
    for (const material of found) material.emissiveIntensity = HYDRA_GLOW_STEADY_INTENSITY;
    return NO_HYDRA_GLOW_MATERIALS;
  }
  return found;
}

/** Per-frame write: one number per material, no allocation. */
export function updateHydraGlow(
  materials: readonly HydraGlowMaterial[],
  tSeconds: number,
): void {
  const count = materials.length;
  if (count === 0) return;
  const intensity = hydraGlowIntensity(tSeconds);
  for (let i = 0; i < count; i++) materials[i]!.emissiveIntensity = intensity;
}
