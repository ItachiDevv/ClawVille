'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * Purely procedural (no GLB). Two vertical post BoxGeometries + one
 * horizontal plank BoxGeometry, coloured with MeshBasicNodeMaterial (TSL).
 * Text rendered via drei <Html> DOM portal (transform mode) — safe on
 * Intel Iris Xe.
 *
 * DO NOT use drei Text or Billboard — hard GPU crash on Iris Xe.
 *
 * Position: (0, -2, -50) — center of the stall row axis, north-facing.
 * Posts stand 140wu above their base, plank spans the top.
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame allocations — all geo/mat are module-scope
 *   - matrixAutoUpdate=false after mount (static, never moves)
 */

import { useEffect, memo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color } from 'three/tsl';

// ---------------------------------------------------------------------------
// Geometry + material — module scope so they're created once, never re-alloc.
// ---------------------------------------------------------------------------

// Wood colour: warm oak brown
const WOOD_COLOR = '#7c4a1b';

const woodMat = new MeshBasicNodeMaterial();
woodMat.colorNode = color(WOOD_COLOR);

// Post dims (world units) — BIGGER so the sign reads as a proper landmark
const POST_W = 16;
const POST_H = 360;
const POST_D = 16;
const POST_SPACING = 340;

const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_D);

// Plank dims — spans between post tops with overhang
const PLANK_W = POST_SPACING + POST_W + 60; // wide with overhang
const PLANK_H = 200;
const PLANK_D = 10;
// Plank top aligns with post tops: plank center at Y = POST_H - PLANK_H/2
const PLANK_Y = POST_H - PLANK_H / 2;

const plankGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, PLANK_D);

// World position — raised well above sand to clear terrain bumps.
const SIGN_X = 0;
const SIGN_Y = 40; // posts base well above sand (Y=-2); was 0 which looked half-buried
const SIGN_Z = -120;

// ---------------------------------------------------------------------------
// Inner component
// ---------------------------------------------------------------------------
const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  // Freeze world matrix after mount — sign never moves.
  useEffect(() => {
    // nothing to traverse here (static primitives); the group freeze is handled
    // by setting matrixAutoUpdate via ref — we use a no-op here and rely on R3F
    // primitives being static; matrixAutoUpdate defaults to true but the group
    // never moves so it's low-cost. For strict freeze we'd need a groupRef.
  }, []);

  return (
    <group position={[SIGN_X, SIGN_Y, SIGN_Z]}>
      {/* Left post */}
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[-POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      />

      {/* Right post */}
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      />

      {/* Horizontal plank — centered so its TOP aligns with post tops */}
      <mesh
        geometry={plankGeo}
        material={woodMat}
        position={[0, PLANK_Y, 0]}
        matrixAutoUpdate={false}
      />

      {/* Text label — Html in `transform` mode so it CSS-3Ds onto the plank
          face at world scale. Position is the plank's FRONT face (+Z side) so
          the text reads from the south where the player approaches. */}
      <Html
        position={[0, PLANK_Y, PLANK_D / 2 + 0.5]}
        center
        transform
        distanceFactor={10}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        <div
          style={{
            fontFamily: 'serif',
            color: '#2a1800',
            textAlign: 'center',
            padding: '12px 20px',
            lineHeight: 1.25,
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontWeight: 'bold', fontSize: '36px', marginBottom: '6px', letterSpacing: '2px' }}>
            TOWN CENTER
          </div>
          <div style={{ fontSize: '22px' }}>Auction</div>
          <div style={{ fontSize: '22px' }}>Bazaar</div>
          <div style={{ fontSize: '22px' }}>Marketplace</div>
        </div>
      </Html>
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
