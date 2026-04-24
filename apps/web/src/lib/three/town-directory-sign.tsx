'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * Text uses the SAME pattern as building labels in arena-buildings.tsx:
 * drei <Html> (no transform, no distanceFactor) with a compact
 * div + background. Renders as screen-space DOM at the 3D position,
 * guaranteed to show.
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame allocations
 */

import { memo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three/webgpu';

const POST_W = 20;
const POST_H = 420;
const POST_D = 20;
const POST_SPACING = 420;

const PLANK_W = POST_SPACING + POST_W + 80;
const PLANK_H = 240;
const PLANK_D = 12;
const PLANK_Y = POST_H - PLANK_H / 2;

const SIGN_X = 0;
const SIGN_Y = 150;
const SIGN_Z = -120;

const WOOD_COLOR = 0x7c4a1b;

const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_D);
const plankGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, PLANK_D);

const woodMat = new THREE.MeshBasicMaterial({ color: WOOD_COLOR });

const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  return (
    <group position={[SIGN_X, SIGN_Y, SIGN_Z]}>
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[-POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      />
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      />
      <mesh
        geometry={plankGeo}
        material={woodMat}
        position={[0, PLANK_Y, 0]}
        matrixAutoUpdate={false}
      />

      {/* Text label — same Html pattern as building labels (arena-buildings.tsx).
          Positioned at the plank's center height. */}
      <Html position={[0, PLANK_Y, 0]} center style={{ pointerEvents: 'none' }}>
        <div
          style={{
            background: 'rgba(124, 74, 27, 0.95)',
            border: '2px solid rgba(60, 35, 15, 0.9)',
            borderRadius: 6,
            padding: '10px 18px',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            fontFamily: 'Georgia, serif',
            color: '#f5e6c8',
          }}
        >
          <div style={{ fontWeight: 'bold', fontSize: 18, letterSpacing: 2, marginBottom: 4 }}>
            TOWN CENTER
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.3 }}>Auction</div>
          <div style={{ fontSize: 13, lineHeight: 1.3 }}>Bazaar</div>
          <div style={{ fontSize: 13, lineHeight: 1.3 }}>Marketplace</div>
        </div>
      </Html>
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
