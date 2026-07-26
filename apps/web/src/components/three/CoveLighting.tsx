"use client";

/**
 * CoveLighting.tsx
 *
 * Neon ambient lighting for the cove interior scene.
 * Underwater Vegas vibe with an Iris-Xe-safe three-light budget.
 *
 * Iris Xe rules enforced:
 *   - NO shadows (castShadow always false)
 *   - Exactly three objects: ambient + hemisphere + one non-shadow point.
 *   - The persistent slot mounts these once; its hidden root removes them
 *     from rendering while Cove is inactive.
 */

import * as THREE from "three/webgpu";

const CYAN_COLOR = new THREE.Color(0x00ffe0);
const AMBIENT_COLOR = new THREE.Color(0x1a0a2e);

export function CoveLighting() {
  return (
    <>
      {/* Ambient fill — strong enough to reveal the 600wu interior even at distance */}
      <ambientLight color={AMBIENT_COLOR} intensity={6.0} />

      {/* Hemisphere — cool ceiling / warm floor bounce for depth */}
      <hemisphereLight args={[0x4a3a7a, 0x6a4a3a, 2.5]} />

      {/* Cyan neon — left wall (linear decay so it reaches across the 600wu room) */}
      <pointLight
        position={[0, 260, -80]}
        color={CYAN_COLOR}
        intensity={9.0}
        distance={1400}
        decay={1}
        castShadow={false}
      />

      {/* Magenta neon — right wall */}
      {/* Cyan fill above slot bank — illuminates cabinet tops */}
    </>
  );
}

export default CoveLighting;
