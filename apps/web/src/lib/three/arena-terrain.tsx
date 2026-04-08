'use client';

import { Suspense, useEffect, useRef, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Terrain: Bikini Bottom GLB + sand floor + coral/kelp decorations
// ---------------------------------------------------------------------------

export const TERRAIN_LAYER = 1;

// bikini-bottom.glb REMOVED — it contained duplicate buildings (Krusty Krab,
// Pineapple, Squidward's, Patrick's Rock) baked into one scene, overlapping
// with our individual building GLBs. Sand floor + individual buildings is cleaner.
useGLTF.preload('/models/coral-reef1.glb');
useGLTF.preload('/models/coral-reef2.glb');
useGLTF.preload('/models/coral-reef3.glb');
useGLTF.preload('/models/kelp.glb');
// Border decorations — old generic buildings repurposed as scenery
useGLTF.preload('/models/building-lighthouse.glb');
useGLTF.preload('/models/building-shipwreck.glb');
useGLTF.preload('/models/building-submarine.glb');
useGLTF.preload('/models/building-tower2.glb');
useGLTF.preload('/models/building-seashell.glb');
useGLTF.preload('/models/building-anchor.glb');
useGLTF.preload('/models/building-barrel.glb');
useGLTF.preload('/models/building-chest.glb');

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;

/** Generate a canvas-based sand texture with grain and color variation */
function createSandTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Base sandy color
  ctx.fillStyle = '#e8d5b0';
  ctx.fillRect(0, 0, size, size);

  // Add noise grains for sand texture
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 30;
    const speckle = Math.random() < 0.03 ? -25 : 0;
    data[i] = Math.max(0, Math.min(255, data[i] + noise + speckle));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise + speckle));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise * 0.8 + speckle));
  }
  ctx.putImageData(imageData, 0, 0);

  // Subtle wave ripples
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = '#c4a882';
  ctx.lineWidth = 2;
  for (let y = 20; y < size; y += 18 + Math.random() * 12) {
    ctx.beginPath();
    for (let x = 0; x < size; x += 4) {
      const wave = Math.sin(x * 0.02 + y * 0.1) * 3;
      if (x === 0) ctx.moveTo(x, y + wave);
      else ctx.lineTo(x, y + wave);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(24, 16);
  return texture;
}

function SandFloor() {
  const ref = useRef<THREE.Mesh>(null);
  const sandTexture = useMemo(() => {
    if (typeof document === 'undefined') return null;
    return createSandTexture();
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.layers.enable(TERRAIN_LAYER);
  }, []);

  return (
    <mesh
      ref={ref}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -2, 0]}
    >
      <planeGeometry args={[MAP_WIDTH * 3, MAP_HEIGHT * 3]} />
      {sandTexture ? (
        <meshBasicMaterial map={sandTexture} />
      ) : (
        <meshBasicMaterial color={0xe8d5b0} />
      )}
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Coral/kelp decorations scattered around the map
// ---------------------------------------------------------------------------
interface DecoEntry {
  model: string;
  x: number;
  z: number;
  scale: number;
  rotY: number;
}

const DECORATIONS: DecoEntry[] = [
  // --- Coral scattered across the whole map, between and around buildings ---
  // Between top-row buildings
  { model: '/models/coral-reef1.glb', x: -350, z: -260, scale: 4, rotY: 0 },
  { model: '/models/coral-reef2.glb', x: -80,  z: -280, scale: 3, rotY: 1.2 },
  { model: '/models/coral-reef3.glb', x: 200,  z: -240, scale: 3.5, rotY: 2.5 },
  // Between rows 1 and 2
  { model: '/models/coral-reef1.glb', x: -420, z: -80,  scale: 3, rotY: 0.5 },
  { model: '/models/coral-reef2.glb', x: -150, z: -40,  scale: 2.5, rotY: 3.1 },
  { model: '/models/coral-reef3.glb', x: 100,  z: -60,  scale: 3, rotY: 1.8 },
  { model: '/models/coral-reef1.glb', x: 350,  z: -90,  scale: 2.5, rotY: 4.2 },
  // Between rows 2 and 3
  { model: '/models/coral-reef2.glb', x: -300, z: 120,  scale: 3, rotY: 0.3 },
  { model: '/models/coral-reef3.glb', x: 0,    z: 100,  scale: 2.5, rotY: 2.0 },
  { model: '/models/coral-reef1.glb', x: 280,  z: 140,  scale: 3, rotY: 5.1 },
  // South of village
  { model: '/models/coral-reef2.glb', x: -200, z: 300,  scale: 3.5, rotY: 1.0 },
  { model: '/models/coral-reef3.glb', x: 150,  z: 320,  scale: 3, rotY: 3.5 },
  // --- Kelp scattered throughout ---
  { model: '/models/kelp.glb', x: -480, z: -200, scale: 5, rotY: 0.5 },
  { model: '/models/kelp.glb', x: -250, z: -160, scale: 4, rotY: 2.0 },
  { model: '/models/kelp.glb', x: 50,   z: -150, scale: 4.5, rotY: 4.0 },
  { model: '/models/kelp.glb', x: 300,  z: -200, scale: 4, rotY: 1.0 },
  { model: '/models/kelp.glb', x: 480,  z: -100, scale: 5, rotY: 3.0 },
  { model: '/models/kelp.glb', x: -400, z: 50,   scale: 4, rotY: 5.5 },
  { model: '/models/kelp.glb', x: 420,  z: 80,   scale: 4.5, rotY: 0.8 },
  { model: '/models/kelp.glb', x: -350, z: 250,  scale: 5, rotY: 2.5 },
  { model: '/models/kelp.glb', x: 380,  z: 280,  scale: 4, rotY: 4.5 },
  // --- Small props along edges ---
  { model: '/models/building-anchor.glb',  x: -550, z: -320, scale: 2, rotY: 1.0 },
  { model: '/models/building-barrel.glb',  x: 520,  z: -300, scale: 2, rotY: 2.5 },
  { model: '/models/building-chest.glb',   x: -500, z: 300,  scale: 1.5, rotY: 3.0 },
  { model: '/models/building-barrel.glb',  x: 500,  z: 320,  scale: 2, rotY: 4.0 },
  { model: '/models/building-anchor.glb',  x: -560, z: 0,    scale: 2, rotY: 5.5 },
  { model: '/models/building-anchor.glb',  x: 550,  z: 0,    scale: 2, rotY: 0.3 },
  // Distant ships (tiny, far corners)
  { model: '/models/building-shipwreck.glb',  x: -700, z: 450, scale: 0.4, rotY: 0.8 },
  { model: '/models/building-submarine.glb',  x: 700,  z: 450, scale: 0.4, rotY: 1.5 },
];

function SingleDecoration({ entry }: { entry: DecoEntry }) {
  const { scene } = useGLTF(entry.model);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return (
    <primitive
      object={cloned}
      position={[entry.x, -2, entry.z]}
      scale={entry.scale}
      rotation={[0, entry.rotY, 0]}
    />
  );
}

function UnderwaterDecorations() {
  return (
    <group>
      {DECORATIONS.map((entry, i) => (
        <SingleDecoration key={i} entry={entry} />
      ))}
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <SandFloor />
      <UnderwaterDecorations />
    </Suspense>
  );
}
