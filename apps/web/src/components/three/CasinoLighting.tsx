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
      {/* Ambient fill — strong enough to reveal the 600wu interior even at distance */}
      <ambientLight color={AMBIENT_COLOR} intensity={6.0} />

      {/* Hemisphere — cool ceiling / warm floor bounce for depth */}
      <hemisphereLight args={[0x4a3a7a, 0x6a4a3a, 2.5]} />

      {/* Cyan neon — left wall (linear decay so it reaches across the 600wu room) */}
      <pointLight
        position={[-180, 200, -60]}
        color={CYAN_COLOR}
        intensity={8.0}
        distance={1400}
        decay={1}
        castShadow={false}
      />

      {/* Magenta neon — right wall */}
      <pointLight
        position={[180, 200, -60]}
        color={MAGENTA_COLOR}
        intensity={8.0}
        distance={1400}
        decay={1}
        castShadow={false}
      />

      {/* Cyan fill above slot bank — illuminates cabinet tops */}
      <pointLight
        position={[0, 300, -100]}
        color={CYAN_COLOR}
        intensity={5.0}
        distance={1200}
        decay={1}
        castShadow={false}
      />
    </>
  );
}

export default CasinoLighting;
