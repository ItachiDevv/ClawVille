'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * The plank face IS the text — a PlaneGeometry with the wood+text PNG
 * as its material map. The text is physically part of the sign, not a
 * floating overlay. Posts are simple wood-coloured BoxGeometry.
 *
 * Requires <Suspense> wrapper at mount site (useTexture suspends).
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame allocations
 */

import { memo, useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three/webgpu';

const POST_W = 20;
const POST_H = 420;
const POST_D = 20;
const POST_SPACING = 420;

// Plank face — 2:1 aspect to match the PNG's 1024x512.
const PLANK_W = 560;
const PLANK_H = 280;
const PLANK_Y = POST_H - PLANK_H / 2;

// Small back-plate behind the face so the sign has some depth
const BACKING_D = 10;

const SIGN_X = 0;
const SIGN_Y = 150;
const SIGN_Z = -120;

const WOOD_COLOR = 0x7c4a1b;

const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_D);
const plankBackGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, BACKING_D);
const plankFaceGeo = new THREE.PlaneGeometry(PLANK_W, PLANK_H);

const woodMat = new THREE.MeshBasicMaterial({ color: WOOD_COLOR });

const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  const texture = useTexture('/town-directory-sign.png');

  const faceMat = useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff });
  }, [texture]);

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
      {/* Plank backing — gives the sign depth; wood-coloured */}
      <mesh
        geometry={plankBackGeo}
        material={woodMat}
        position={[0, PLANK_Y, -BACKING_D / 2]}
        matrixAutoUpdate={false}
      />
      {/* Plank front face — flat plane with the wood+text texture baked on.
          Text IS the face of the sign, not a floating overlay. */}
      <mesh
        geometry={plankFaceGeo}
        material={faceMat}
        position={[0, PLANK_Y, 0.5]}
        matrixAutoUpdate={false}
      />
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
