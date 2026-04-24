'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * Plank face = PlaneGeometry with PNG texture mapped directly onto it.
 * Text is physically baked into the sign's front surface.
 *
 * Debug: exposes window.__TOWN_SIGN_DEBUG with the texture + material refs
 * so we can diagnose texture binding issues at runtime.
 */

import { memo, useEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
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

const woodMat = new THREE.MeshBasicMaterial({ color: WOOD_COLOR });

const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  // Load the PNG via the core TextureLoader — same path useTexture uses
  // internally but without drei's wrapping layer.
  const texture = useLoader(THREE.TextureLoader, '/town-directory-sign.png');

  const faceMat = useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      color: 0xffffff,
      side: THREE.DoubleSide, // visible from both sides — defends against
                               // accidentally-back-face rendering
      transparent: false,
      toneMapped: false,
    });
    return mat;
  }, [texture]);

  // Expose debug refs on window so we can diagnose at runtime
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__TOWN_SIGN_DEBUG = {
        texture,
        faceMat,
        textureImg: texture.image
          ? { w: texture.image.width, h: texture.image.height, src: texture.image.src || 'no-src' }
          : null,
        hasMap: !!faceMat.map,
        colorSpace: texture.colorSpace,
      };
      console.log('[TownDirectorySign] mounted', (window as any).__TOWN_SIGN_DEBUG);
    }
  }, [texture, faceMat]);

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
        geometry={plankBackGeo}
        material={woodMat}
        position={[0, PLANK_Y, -BACKING_D / 2]}
        matrixAutoUpdate={false}
      />
      {/* Plank face — textured plane with wood+text baked in.
          Pushed forward to Z=+6 to ensure it's clearly in front of the backing
          and the posts (posts span Z=-10 to +10, so face must be at Z>10). */}
      <mesh
        geometry={plankFaceGeo}
        material={faceMat}
        position={[0, PLANK_Y, 12]}
        matrixAutoUpdate={false}
      />
    </group>
  );
});

export default function TownDirectorySign() {
  return <TownDirectorySignInner />;
}
