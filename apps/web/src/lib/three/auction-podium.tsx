'use client';

/**
 * AuctionPodium — world-surface anchor for the Auction House modal.
 *
 * A dramatic raised podium in the village center, further south for the 160x160 map.
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

import { useRef, useMemo, useEffect, memo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { color, float, sin, time, uv, mix, smoothstep } from 'three/tsl';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// World position — village center, further south for expanded 160x160 map.
// Was PODIUM_Z = 20; increased to 50 so podium clears the quest NPC and
// spreads town objects proportionally on the 5120x5120 world.
// ---------------------------------------------------------------------------
const PODIUM_X = 0;
const PODIUM_Z = 50;
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
    // 8× scaled: radiusBottom=144, height=1920. Beam extends high above podium.
    <mesh position={[0, 960, 0]} material={mat}>
      {/* CylinderGeometry: radiusTop, radiusBottom, height, radialSeg, heightSeg, openEnded */}
      <cylinderGeometry args={[0, 144, 1920, 24, 1, true]} />
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
    // Normalize to a reasonable size — 8× scaled target (18→144)
    const box = new THREE.Box3().setFromObject(c);
    const sz = new THREE.Vector3();
    box.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    const targetSize = 144;
    const s = maxDim > 0 ? targetSize / maxDim : 1;
    c.scale.setScalar(s);
    return c;
  }, [scene]);

  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  useFrame(({ clock }) => {
    if (!floatRef.current) return;
    const t = clock.elapsedTime;
    // Hover + rotate — 8× scaled offsets
    floatRef.current.rotation.y = t * 0.5;
    floatRef.current.position.y = 336 + Math.sin(t * 0.9) * 24;
  });

  return (
    <group ref={floatRef} position={[0, 336, 0]}>
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
      {/* Wide lower step — 8× scaled: top 112, bottom 144, height 80 */}
      <mesh position={[0, 40, 0]} material={darkMat}>
        <cylinderGeometry args={[112, 144, 80, 24, 1]} />
      </mesh>
      {/* Narrower upper platform — 8× scaled: top 80, bottom 112, height 48 */}
      <mesh position={[0, 104, 0]} material={darkMat}>
        <cylinderGeometry args={[80, 112, 48, 24, 1]} />
      </mesh>
      {/* Glowing rim ring at top — 8× scaled: torus radius 80, tube 4 */}
      <mesh position={[0, 129.6, 0]} rotation={[Math.PI / 2, 0, 0]} material={rimMat}>
        <torusGeometry args={[80, 4, 8, 32]} />
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

      {/* Invisible click volume — 8× scaled */}
      <mesh visible={false} position={[0, 160, 0]}>
        <cylinderGeometry args={[128, 160, 320, 12, 1]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
});

export default function AuctionPodium() {
  return <AuctionPodiumInner />;
}
