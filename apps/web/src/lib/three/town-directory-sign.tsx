'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 * Fully flat: no memo wrapper, no inner component, no state.
 * If this doesn't render, the problem is upstream of the component.
 */

import * as THREE from 'three/webgpu';

// 2026-05-21 — Bumped all sign geometry by ×1.4 per user direction
// (was POST 14×280×14 / SPACING 280 / PLANK 380×190 / BACK 6).
const POST_W = 20;     // was 14
const POST_H = 392;    // was 280
const POST_D = 20;     // was 14
const POST_SPACING = 392; // was 280

const PLANK_W = 532;   // was 380
const PLANK_H = 266;   // was 190
const PLANK_Y = POST_H - PLANK_H / 2;
const BACKING_D = 8;   // was 6

const SIGN_X = 0;
const SIGN_Y = 0; // posts rest just above sand (sand at Y=-2)
const SIGN_Z = -120;

const WOOD_COLOR = 0x7c4a1b;

const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_D);
const plankBackGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, BACKING_D);
const plankFaceGeo = new THREE.PlaneGeometry(PLANK_W, PLANK_H);

const woodMat = new THREE.MeshBasicMaterial({ color: WOOD_COLOR });
const faceMat = new THREE.MeshBasicMaterial({
  color: WOOD_COLOR,
  side: THREE.DoubleSide,
  toneMapped: false,
});

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    faceMat.map = tex;
    faceMat.color.setHex(0xffffff);
    faceMat.needsUpdate = true;
    (window as any).__TOWN_SIGN_DEBUG = { loaded: true, w: img.width, h: img.height };
  };
  img.src = '/town-directory-sign.png';
}

export default function TownDirectorySign() {
  if (typeof window !== 'undefined') {
    (window as any).__TOWN_SIGN_RENDERED = ((window as any).__TOWN_SIGN_RENDERED || 0) + 1;
  }
  return (
    <group position={[SIGN_X, SIGN_Y, SIGN_Z]} userData={{ isOccluder: true }}>
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[-POST_SPACING / 2, POST_H / 2, 0]}
      />
      <mesh
        geometry={postGeo}
        material={woodMat}
        position={[POST_SPACING / 2, POST_H / 2, 0]}
      />
      <mesh
        geometry={plankBackGeo}
        material={woodMat}
        position={[0, PLANK_Y, -BACKING_D / 2]}
      />
      <mesh
        geometry={plankFaceGeo}
        material={faceMat}
        position={[0, PLANK_Y, 12]}
      />
    </group>
  );
}
