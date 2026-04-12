'use client';

/**
 * AuctionPodium — world-surface anchor for the Auction House modal.
 *
 * A dramatic raised podium in the village center, south of the quest NPC.
 *
 * Composition (keeping draw calls tight):
 *   - A large stepped cylinder base (solid dark material)     1 draw call
 *   - An emissive glow ring at the podium rim (additive)      1 draw call
 *   - A floating jellyfish.glb above the podium (the "lot")   1–3 draw calls
 *   - A fake "spotlight" — upward-facing open cone with       1 draw call
 *     AdditiveBlending + TSL emissive falloff. No SpotLight.
 *
 * Total: ~5–6 draw calls
 *
 * Clicking: useGameStore().openAuction()
 *
 * GPU constraints: TSL only, no GLSL, no Text/Billboard, no SpotLight (light budget 3/3 full)
 */

import { useRef, useMemo, memo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { color, float, sin, time, uv, mix, smoothstep } from 'three/tsl';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// World position — village center, 36 units south of center
// ---------------------------------------------------------------------------
const PODIUM_X = 0;
const PODIUM_Z = 20;
const PODIUM_Y = -2;

// Preload the floating item
useGLTF.preload('/models/jellyfish.glb');

// ---------------------------------------------------------------------------
// Module-scope scratch
// ---------------------------------------------------------------------------
const _floatRotScratch = new THREE.Euler();

// ---------------------------------------------------------------------------
// Fake spotlight cone — open CylinderGeometry pointing upward
// TSL: additive blending + uv-based falloff so it fades toward the top
// ---------------------------------------------------------------------------
function SpotlightCone() {
  const mat = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide, // inside of cone visible from outside
    });

    // uv().y goes 0→1 from bottom to top. Fade out toward top (far end of cone).
    const fade = smoothstep(float(0.0), float(0.6), uv().y).oneMinus();
    const pulse = sin(time.mul(float(1.0))).mul(float(0.15)).add(float(0.85));

    // Legendary gold spotlight tint
    m.colorNode = color(0xf97316).mul(float(0.25)).mul(fade).mul(pulse);
    m.opacity = 0.6;
    return m;
  }, []);

  return (
    // Open-top cone: radiusTop=0 makes a proper cone. radiusBottom=wide at podium.
    // Tall and narrow — reaches up from podium toward water surface
    <mesh position={[0, 120, 0]} material={mat}>
      {/* CylinderGeometry: radiusTop, radiusBottom, height, radialSeg, heightSeg, openEnded */}
      <cylinderGeometry args={[0, 18, 240, 24, 1, true]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Floating item above the podium
// ---------------------------------------------------------------------------
function FloatingAuctionItem() {
  const floatRef = useRef<THREE.Group>(null!);
  const { scene } = useGLTF('/models/jellyfish.glb');

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    // Normalize to a reasonable size
    const box = new THREE.Box3().setFromObject(c);
    const sz = new THREE.Vector3();
    box.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    const targetSize = 18;
    const s = maxDim > 0 ? targetSize / maxDim : 1;
    c.scale.setScalar(s);
    return c;
  }, [scene]);

  useFrame(({ clock }) => {
    if (!floatRef.current) return;
    const t = clock.elapsedTime;
    // Hover + rotate
    floatRef.current.rotation.y = t * 0.5;
    floatRef.current.position.y = 42 + Math.sin(t * 0.9) * 3.0;
  });

  return (
    <group ref={floatRef} position={[0, 42, 0]}>
      <primitive object={cloned} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Podium base — two stacked cylinders for a stepped look
// ---------------------------------------------------------------------------
function PodiumBase() {
  const darkMat = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = color(0x071525);
    return m;
  }, []);

  const rimMat = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pulse = sin(time.mul(float(1.2))).mul(float(0.3)).add(float(0.7));
    m.colorNode = color(0xf97316).mul(float(0.6)).mul(pulse);
    m.opacity = 0.8;
    return m;
  }, []);

  return (
    <>
      {/* Wide lower step */}
      <mesh position={[0, 5, 0]} material={darkMat}>
        <cylinderGeometry args={[14, 18, 10, 24, 1]} />
      </mesh>
      {/* Narrower upper platform */}
      <mesh position={[0, 13, 0]} material={darkMat}>
        <cylinderGeometry args={[10, 14, 6, 24, 1]} />
      </mesh>
      {/* Glowing rim ring at top */}
      <mesh position={[0, 16.2, 0]} rotation={[Math.PI / 2, 0, 0]} material={rimMat}>
        <torusGeometry args={[10, 0.5, 8, 32]} />
      </mesh>
    </>
  );
}

// ---------------------------------------------------------------------------
// Full auction podium
// ---------------------------------------------------------------------------
const AuctionPodiumInner = memo(function AuctionPodiumInner() {
  const openAuction = () => useGameStore.getState().openAuction();

  return (
    <group
      position={[PODIUM_X, PODIUM_Y, PODIUM_Z]}
      onClick={(e) => {
        e.stopPropagation();
        openAuction();
      }}
      onPointerEnter={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'auto';
      }}
    >
      <PodiumBase />

      {/* Fake spotlight shaft */}
      <SpotlightCone />

      {/* Floating auction lot */}
      <Suspense fallback={null}>
        <FloatingAuctionItem />
      </Suspense>

      {/* Invisible click volume */}
      <mesh visible={false} position={[0, 20, 0]}>
        <cylinderGeometry args={[16, 20, 40, 12, 1]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
});

export default function AuctionPodium() {
  return <AuctionPodiumInner />;
}
