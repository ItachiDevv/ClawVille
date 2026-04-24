'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * Plank face = Plane with baked wood+text PNG texture. The texture is
 * loaded via raw Image API and stored in React state; when it arrives,
 * R3F's JSX primitive material reconciles to bind it to the mesh.
 */

import { memo, useEffect, useState } from 'react';
import * as THREE from 'three/webgpu';

const POST_W = 20;
const POST_H = 420;
const POST_D = 20;
const POST_SPACING = 420;

const PLANK_W = 560;
const PLANK_H = 280;
const PLANK_Y = POST_H - PLANK_H / 2;
const BACKING_D = 10;

const SIGN_X = 0;
const SIGN_Y = 150;
const SIGN_Z = -120;

const WOOD_COLOR = 0x7c4a1b;

const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_D);
const plankBackGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, BACKING_D);
const plankFaceGeo = new THREE.PlaneGeometry(PLANK_W, PLANK_H);

const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      setTexture(tex);
      console.log('[TownDirectorySign] texture bound', img.width, 'x', img.height);
      (window as any).__TOWN_SIGN_DEBUG = { loaded: true, w: img.width, h: img.height };
    };
    img.onerror = (err) => {
      console.error('[TownDirectorySign] image load failed', err);
    };
    img.src = '/town-directory-sign.png';
  }, []);

  return (
    <group position={[SIGN_X, SIGN_Y, SIGN_Z]}>
      {/* Left post */}
      <mesh
        geometry={postGeo}
        position={[-POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      >
        <meshBasicMaterial color={WOOD_COLOR} />
      </mesh>
      {/* Right post */}
      <mesh
        geometry={postGeo}
        position={[POST_SPACING / 2, POST_H / 2, 0]}
        matrixAutoUpdate={false}
      >
        <meshBasicMaterial color={WOOD_COLOR} />
      </mesh>
      {/* Plank backing */}
      <mesh
        geometry={plankBackGeo}
        position={[0, PLANK_Y, -BACKING_D / 2]}
        matrixAutoUpdate={false}
      >
        <meshBasicMaterial color={WOOD_COLOR} />
      </mesh>
      {/* Plank face with baked text — JSX material so R3F reconciles when
          texture state updates after the PNG loads */}
      <mesh
        geometry={plankFaceGeo}
        position={[0, PLANK_Y, 12]}
        matrixAutoUpdate={false}
      >
        <meshBasicMaterial
          map={texture ?? undefined}
          color={texture ? 0xffffff : WOOD_COLOR}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
