'use client';

/**
 * CasinoLighting.tsx
 *
 * Neon ambient lighting for the casino interior scene.
 * Underwater Vegas vibe: cyan + magenta point lights + dark purple ambient.
 *
 * Iris Xe rules enforced:
 *   - NO shadows (castShadow always false)
 *   - Point light count: 3 (hemisphere + ambient + 3 point = total 5 light objects,
 *     well within the 7-light GPU context-loss threshold documented in
 *     gotchas/point-lights-iris-xe-gpu-saturation.md)
 */

import * as THREE from 'three';

const CYAN_COLOR    = new THREE.Color(0x00ffe0);
const MAGENTA_COLOR = new THREE.Color(0xff00cc);
const AMBIENT_COLOR = new THREE.Color(0x1a0a2e);

export function CasinoLighting() {
  return (
    <>
      {/* Dark purple ambient fill — prevents pitch-black corners */}
      <ambientLight color={AMBIENT_COLOR} intensity={2.5} />

      {/* Hemisphere — cool ceiling / warm floor bounce for depth */}
      <hemisphereLight args={[0x1a0a3a, 0x2a0a1a, 1.2]} />

      {/* Cyan neon — left wall */}
      <pointLight
        position={[-180, 120, -60]}
        color={CYAN_COLOR}
        intensity={3.5}
        distance={600}
        decay={2}
        castShadow={false}
      />

      {/* Magenta neon — right wall */}
      <pointLight
        position={[180, 120, -60]}
        color={MAGENTA_COLOR}
        intensity={3.5}
        distance={600}
        decay={2}
        castShadow={false}
      />

      {/* Cyan fill above slot bank — illuminates cabinet tops */}
      <pointLight
        position={[0, 200, -100]}
        color={CYAN_COLOR}
        intensity={2.0}
        distance={500}
        decay={2}
        castShadow={false}
      />
    </>
  );
}

export default CasinoLighting;
