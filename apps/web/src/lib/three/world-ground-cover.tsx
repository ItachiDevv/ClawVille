'use client';

import { useState } from 'react';
import MergedSeaweed from '@/lib/three/merged-seaweed';
import { KelpForestAmbient } from '@/lib/three/kelp-forest';

export interface WorldGroundCoverProps {
  /** The governor's groundCover switch (tier 0 = true). */
  show: boolean;
  /** Device profile allows seaweed (ambient ground cover, not forced WebGL). */
  seaweedEligible: boolean;
  /** Device profile + water-fog flag allow the kelp forest. */
  kelpEligible: boolean;
  forceWebGL: boolean;
}

/**
 * Seaweed ground cover + the Northeast Kelp Forest blades.
 *
 * Mount once, then toggle visibility (web-load T8). A layer mounts on the
 * first render where `show` is true and stays mounted; later governor tier
 * changes only flip the inner group's `visible`. Before T8 each tier 1 -> 0
 * recovery remounted both layers: an 18,000-blade seaweed merge + 3 kelp
 * merges + 4 new TSL materials = a 154-181 ms task and 4-6 synchronous
 * pipeline creations on the first visible frame (local prod build at
 * 1342805d, 3/3 runs). That frame cost made the governor degrade again and
 * latch tier 1 for the session. A hidden layer keeps its render objects and
 * pipelines, so the reveal draws with no new pipeline. A layer that was never
 * shown never mounts, so an initial-tier-1 profile pays nothing at boot.
 *
 * The perf chunk roots keep their names: the boot-core compile whitelist
 * (BOOT_CORE_CHUNKS) keys on `perfChunk` 'seaweed' / 'kelp-forest'. The
 * visibility switch sits on an INNER group so the boot scans never see a
 * hidden root.
 */
export function WorldGroundCover({ show, seaweedEligible, kelpEligible, forceWebGL }: WorldGroundCoverProps) {
  // Monotonic latch. A render-phase update of this component's own state is
  // React's derived-state pattern: React re-renders at once, before commit.
  const [everShown, setEverShown] = useState(show);
  if (show && !everShown) setEverShown(true);
  const mounted = everShown || show;

  return (
    <>
      {mounted && seaweedEligible && (
        <group name="perf:seaweed" userData={{ perfChunk: 'seaweed' }}>
          <group visible={show}>
            <MergedSeaweed />
          </group>
        </group>
      )}
      {mounted && kelpEligible && (
        <group name="perf:kelp-forest" userData={{ perfChunk: 'kelp-forest' }}>
          <group visible={show}>
            <KelpForestAmbient forceWebGL={forceWebGL} />
          </group>
        </group>
      )}
    </>
  );
}
