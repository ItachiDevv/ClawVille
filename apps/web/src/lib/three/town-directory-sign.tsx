'use client';

/**
 * TownDirectorySign — wooden signboard at town center.
 *
 * Plank face = PlaneGeometry with a PNG texture. Texture is loaded via raw
 * Image API (not useLoader / useTexture) so we avoid Suspense machinery
 * entirely — if Suspense traps the sign subtree, nothing renders.
 *
 * The sign posts + backing are always visible. When the PNG image resolves,
 * the face plane's material swaps from a placeholder wood colour to the
 * wood+text texture.
 *
 * Debug: window.__TOWN_SIGN_DEBUG exposes the state at runtime.
 */

import { memo, useEffect, useRef, useState } from 'react';
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
  const [faceMat, setFaceMat] = useState<THREE.MeshBasicMaterial>(woodMat);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const texture = new THREE.Texture(img);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        const mat = new THREE.MeshBasicMaterial({
          map: texture,
          color: 0xffffff,
          side: THREE.DoubleSide,
          transparent: false,
          toneMapped: false,
        });
        setFaceMat(mat);
        if (typeof window !== 'undefined') {
          (window as any).__TOWN_SIGN_DEBUG = {
            loaded: true,
            imgW: img.width,
            imgH: img.height,
            hasMap: !!mat.map,
            matType: mat.constructor.name,
          };
          console.log('[TownDirectorySign] PNG loaded', img.width, 'x', img.height);
        }
      } catch (err) {
        console.error('[TownDirectorySign] Error creating texture:', err);
      }
    };
    img.onerror = (err) => {
      console.error('[TownDirectorySign] Image load failed:', err);
      if (typeof window !== 'undefined') {
        (window as any).__TOWN_SIGN_DEBUG = { loaded: false, err: String(err) };
      }
    };
    img.src = '/town-directory-sign.png';

    // Also record that the component mounted, even before image loads
    if (typeof window !== 'undefined') {
      (window as any).__TOWN_SIGN_DEBUG = { mounted: true, imgLoading: true };
      console.log('[TownDirectorySign] mounted, loading PNG...');
    }
  }, []);

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
      {/* Plank face — textured plane, Z=+12 to clear posts */}
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
