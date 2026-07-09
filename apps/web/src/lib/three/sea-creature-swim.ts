import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural transform-only swim animator for static (unrigged) sea creatures.
//
// Works on the WHOLE mesh group — no bone access, no geometry mutation,
// no material mutation. Pure rotation.x / rotation.z / position.y oscillation.
//
// Contract (caller must ensure):
//   - `meshRoot` is the direct cloned scene / rider mount child — NOT the world
//     group. The caller's component writes group.rotation.y (world facing) and
//     group.position (world position). This module touches only:
//       meshRoot.rotation.x   (pitch — nose up/down)
//       meshRoot.rotation.z   (roll  — side tilt)
//       meshRoot.position.y   (bob   — vertical breathing)
//     rotation.y is NOT touched — it is set by the caller from server data.
//
// Iris Xe budget: 16 callsites / frame (8 reef-race + 8 bumper-shells).
//   - Zero per-frame allocations (module-scope state map only).
//   - 4 Math.sin calls + 4 multiplies per call = well within budget.
// ---------------------------------------------------------------------------

interface ProceduralState {
  /** Accumulated time in seconds, per avatarId. */
  t: number;
  /** Cached "has any isBone nodes" check result — avoids re-traversal. */
  hasBones: boolean;
  /** Whether hasBones has been probed yet. */
  probed: boolean;
}

/** Module-scope state map — one entry per avatarId. No per-frame allocations. */
const _state = new Map<string, ProceduralState>();

function getState(avatarId: string): ProceduralState {
  let s = _state.get(avatarId);
  if (!s) {
    s = { t: 0, hasBones: false, probed: false };
    _state.set(avatarId, s);
  }
  return s;
}

/**
 * Probe whether `root` has any isBone nodes. Cached after first call per avatarId
 * so re-traversal never happens on the hot path.
 */
function probeHasBones(root: THREE.Object3D, s: ProceduralState): void {
  if (s.probed) return;
  s.probed = true;
  let found = false;
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) found = true;
  });
  s.hasBones = found;
}

/**
 * Apply procedural transform swimming motion to a static (unrigged) mesh root.
 *
 * @param meshRoot   The cloned scene / avatar container (NOT the world group).
 * @param avatarId      Stable id used to phase each entity independently.
 * @param dt         Frame delta seconds (already capped to 0.1 by caller).
 * @param speed      Entity speed in world units/second (from interpolated vx/vz).
 * @param baseY      The resting position.y this module should oscillate around.
 *                   Pass the mount's default Y offset (e.g. RIDER_MOUNT_OFFSET_DEFAULT[1]
 *                   for reef-race; 0 for bumper-shells clonedScene). The bob is
 *                   ADDED to this value, not to the current position.y (avoids drift).
 *
 * Called from `applySwimmingAnim` (reef-race) and `applyTransformSwim` (bumper-shells).
 * If the scene has bones (e.g. sea_horse-ktx.glb) the transform path is skipped — the
 * bone-based undulation in `applySwimmingAnim` handles rigged meshes.
 */
export function applyTransformSwim(
  meshRoot: THREE.Object3D,
  avatarId: string,
  dt: number,
  speed: number,
  baseY: number,
): void {
  const s = getState(avatarId);

  // Probe once — if bones exist let the caller's bone animator handle it.
  probeHasBones(meshRoot, s);
  if (s.hasBones) return;

  s.t += dt;
  const t = s.t;

  // Speed-based amplitude envelope: at speed=0 → 0.4; at speed=500 → 1.0.
  // Clamped so a very fast kart doesn't over-rotate the mesh.
  const env = 0.4 + speed * 0.0012;
  const envClamped = env < 0.4 ? 0.4 : env > 1.2 ? 1.2 : env;

  // Roll (rotation.z): gentle side-to-side lean — dominant visual cue for swimming.
  // Frequency scales slightly with speed so fast karts look more energetic.
  const rollFreq = 8.0 + speed * 0.006;
  meshRoot.rotation.z = Math.sin(t * rollFreq) * 0.08 * envClamped;

  // Pitch (rotation.x): nose-up / nose-down undulation.
  meshRoot.rotation.x = Math.sin(t * 6.0) * 0.04 * envClamped;

  // Bob (position.y): vertical breathing around the caller-supplied base.
  // Using baseY + delta avoids accumulating drift from repeated += operations.
  meshRoot.position.y = baseY + Math.sin(t * 4.0) * 0.03 * envClamped;
}

/**
 * Reset the procedural state for a given avatarId. Call when the entity is
 * removed / remounted so the new clone starts from t=0 with fresh probe state.
 */
export function resetTransformSwimState(avatarId: string): void {
  _state.delete(avatarId);
}
