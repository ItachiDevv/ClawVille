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

// Post dims (world units)
const POST_W = 8;
const POST_H = 280;
const POST_D = 8;
const POST_SPACING = 220; // centre-to-centre X distance between the two posts

const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_D);

// Plank dims — spans between post tops with overhang
const PLANK_W = POST_SPACING + POST_W + 30; // 258wu wide — slight overhang
const PLANK_H = 160;
const PLANK_D = 6;
// Plank center should sit so the plank TOP aligns with post tops.
// Posts extend from local Y=0 to Y=POST_H. Plank top at Y=POST_H means
// plank center at Y = POST_H - PLANK_H/2.
const PLANK_Y = POST_H - PLANK_H / 2;

const plankGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, PLANK_D);

// World position of the sign group — raise Y enough to clearly stand above
// any terrain bumps and be obviously visible.
const SIGN_X = 0;
const SIGN_Y = 0; // base of posts at world Y=0 (sand is at Y=-2; posts rest just above)
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

      {/* Text label — Html DOM portal in SCREEN-space mode (no `transform`).
          Same pattern the building labels use — projects to the 3D position
          and renders as normal DOM overlay. `transform` mode was causing the
          text to render inside/behind the plank via CSS-3D clipping. */}
      <Html
        position={[0, PLANK_Y + 20, 0]}
        center
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        <div
          style={{
            fontFamily: 'serif',
            color: '#f5e6c8',
            backgroundColor: 'rgba(60, 35, 15, 0.92)',
            border: '3px solid #7c4a1b',
            borderRadius: '6px',
            textAlign: 'center',
            padding: '14px 22px',
            lineHeight: 1.3,
            userSelect: 'none',
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
          }}
        >
          <div style={{ fontWeight: 'bold', fontSize: '24px', marginBottom: '8px', letterSpacing: '2px' }}>
            TOWN CENTER
          </div>
          <div style={{ fontSize: '16px' }}>Auction</div>
          <div style={{ fontSize: '16px' }}>Bazaar</div>
          <div style={{ fontSize: '16px' }}>Marketplace</div>
        </div>
      </Html>
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
