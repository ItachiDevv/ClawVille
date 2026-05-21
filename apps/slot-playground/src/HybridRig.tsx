/**
 * HybridRig — planar reels but with a perspective tilt and faked drum
 * curvature via vertex-shader-free tricks (top/bottom row alpha fade +
 * subtle Y-skew per row).
 *
 * Fallback if DrumRig doesn't read well. To be fleshed out when needed.
 */

import type { SlotRigProps } from './types';

export default function HybridRig(_props: SlotRigProps) {
  return (
    <mesh>
      <planeGeometry args={[6, 4]} />
      <meshBasicMaterial color={0x0a3a4a} />
      {/* TODO — implement hybrid when DrumRig is rejected. */}
    </mesh>
  );
}
