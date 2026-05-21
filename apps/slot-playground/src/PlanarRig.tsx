/**
 * PlanarRig — the currently-shipped texture-scroll planar reel layer
 * (mirror of apps/web/src/components/cove/SlotReels3D.tsx).
 *
 * Stub here. To be lifted in if both Drum and Hybrid fail, used as a
 * comparison baseline.
 */

import type { SlotRigProps } from './types';

export default function PlanarRig(_props: SlotRigProps) {
  return (
    <mesh>
      <planeGeometry args={[6, 4]} />
      <meshBasicMaterial color={0x062e3b} />
      {/* TODO — port from apps/web SlotReels3D when needed for comparison. */}
    </mesh>
  );
}
