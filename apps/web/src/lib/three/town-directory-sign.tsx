'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 * Module-scope materials only. No hooks. No state. No async.
 */

import { memo } from 'react';
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

// Module-scope face material with placeholder color.
// Image is loaded synchronously-ish: Image() starts fetching immediately on
// module load, and when onload fires we mutate the material's map. R3F's
// render loop redraws on every frame so the texture appears as soon as
// the map is assigned + material's needsUpdate is set.
const faceMat = new THREE.MeshBasicMaterial({
  color: WOOD_COLOR,
  side: THREE.DoubleSide,
  toneMapped: false,
});

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      faceMat.map = tex;
      faceMat.color.setHex(0xffffff); // remove placeholder tint
      faceMat.needsUpdate = true;
      (window as any).__TOWN_SIGN_DEBUG = {
        loaded: true,
        w: img.width,
        h: img.height,
        hasMap: !!faceMat.map,
      };
      console.log('[TownDirectorySign] texture bound module-scope', img.width, 'x', img.height);
    } catch (err) {
      console.error('[TownDirectorySign] texture error:', err);
    }
  };
  img.onerror = (err) => {
    console.error('[TownDirectorySign] image load failed', err);
    (window as any).__TOWN_SIGN_DEBUG = { loaded: false, err: String(err) };
  };
  img.src = '/town-directory-sign.png';
  (window as any).__TOWN_SIGN_DEBUG = { loading: true };
}

const TownDirectorySignInner = memo(function TownDirectorySignInner() {
  if (typeof window !== 'undefined') {
    (window as any).__TOWN_SIGN_RENDERED = Date.now();
  }
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
