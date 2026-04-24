'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * Text is a PNG asset at /town-directory-sign.png. Loaded via drei
 * useTexture, which suspends — MUST be wrapped in <Suspense> at the
 * mount site (see World3DCanvas.tsx).
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame allocations — all geo/mat are module-scope
 */

import { memo, useMemo } from 'react';
import { useTexture } from '@react-three/drei';
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
const textPlaneGeo = new THREE.PlaneGeometry(PLANK_W - 40, PLANK_H - 40);

const woodMat = new THREE.MeshBasicMaterial({ color: WOOD_COLOR });

const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  const texture = useTexture('/town-directory-sign.png');

  const textMat = useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff });
  }, [texture]);

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
      <mesh
        geometry={textPlaneGeo}
        material={textMat}
        position={[0, PLANK_Y, PLANK_D / 2 + 1]}
        matrixAutoUpdate={false}
      />
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
