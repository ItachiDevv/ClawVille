'use client';

import { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';

extend(THREE as any);

// Preload models
useGLTF.preload('/models/lobster.glb');
useGLTF.preload('/models/coral-reef1.glb');
useGLTF.preload('/models/coral-reef2.glb');
useGLTF.preload('/models/coral-reef3.glb');
useGLTF.preload('/models/kelp.glb');
useGLTF.preload('/models/crayfish.glb');

// ---------------------------------------------------------------------------
// Underwater color palette
// ---------------------------------------------------------------------------
const SAND = new THREE.Color(0xd4b896);
const SAND_DARK = new THREE.Color(0xbfa06a);

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// Sandy ocean floor
// ---------------------------------------------------------------------------
function OceanFloor() {
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(600, 400, 60, 40);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const rand = seeded(42);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getY(i);
      pos.setZ(i, Math.sin(x * 0.02) * 2 + Math.cos(z * 0.03) * 1.5 + rand() * 0.8);

      const c = new THREE.Color().lerpColors(SAND, SAND_DARK, rand() * 0.4);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2, 0]} receiveShadow geometry={geo}>
      <meshStandardMaterial vertexColors roughness={0.85} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// GLB Model instances
// ---------------------------------------------------------------------------
function LobsterModel({ position, scale = 1, color, rotationY = 0 }: { position: [number, number, number]; scale?: number; color?: string; rotationY?: number }) {
  const { scene } = useGLTF('/models/lobster.glb');
  const ref = useRef<THREE.Group>(null);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.position.y = position[1] + Math.sin(t * 1.2 + phase) * 0.5;
    ref.current.rotation.y = rotationY + Math.sin(t * 0.3 + phase) * 0.2;
  });

  return (
    <group ref={ref} position={position} scale={scale}>
      <primitive object={cloned} />
    </group>
  );
}

function CoralModel({ position, model, scale = 1, rotationY = 0 }: { position: [number, number, number]; model: string; scale?: number; rotationY?: number }) {
  const { scene } = useGLTF(model);
  const cloned = useMemo(() => scene.clone(true), [scene]);

  return (
    <group position={position} scale={scale} rotation={[0, rotationY, 0]}>
      <primitive object={cloned} />
    </group>
  );
}

function KelpModel({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  const { scene } = useGLTF('/models/kelp.glb');
  const ref = useRef<THREE.Group>(null);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    if (ref.current) {
      const t = clock.elapsedTime;
      ref.current.rotation.z = Math.sin(t * 0.8 + phase) * 0.08;
      ref.current.rotation.x = Math.cos(t * 0.6 + phase) * 0.04;
    }
  });

  return (
    <group ref={ref} position={position} scale={scale}>
      <primitive object={cloned} />
    </group>
  );
}

function CrayfishModel({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  const { scene } = useGLTF('/models/crayfish.glb');
  const ref = useRef<THREE.Group>(null);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    if (ref.current) {
      const t = clock.elapsedTime;
      ref.current.position.y = position[1] + Math.sin(t * 0.9 + phase) * 0.3;
      ref.current.rotation.y += 0.005;
    }
  });

  return (
    <group ref={ref} position={position} scale={scale}>
      <primitive object={cloned} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Bubble particles
// ---------------------------------------------------------------------------
function Bubbles({ count = 50 }: { count?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(() => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x: (Math.random() - 0.5) * 400,
        y: Math.random() * 80 - 10,
        z: (Math.random() - 0.5) * 300,
        speed: 2 + Math.random() * 4,
        wobble: Math.random() * Math.PI * 2,
        size: 0.3 + Math.random() * 0.8,
      });
    }
    return arr;
  }, [count]);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    data.forEach((b, i) => {
      const y = ((b.y + b.speed * t) % 90) - 10;
      dummy.position.set(
        b.x + Math.sin(t * 0.5 + b.wobble) * 2,
        y,
        b.z + Math.cos(t * 0.4 + b.wobble) * 1.5,
      );
      dummy.scale.setScalar(b.size * (0.8 + Math.sin(t + b.wobble) * 0.2));
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshStandardMaterial color={0xaaddff} transparent opacity={0.25} roughness={0.1} metalness={0.3} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Slow orbiting camera
// ---------------------------------------------------------------------------
function OrbitCamera() {
  useFrame(({ camera, clock }) => {
    const t = clock.elapsedTime * 0.06;
    const radius = 140;
    camera.position.x = Math.sin(t) * radius;
    camera.position.z = Math.cos(t) * radius * 0.7;
    camera.position.y = 55 + Math.sin(t * 0.3) * 8;
    camera.lookAt(0, 5, 0);
  });
  return null;
}

// ---------------------------------------------------------------------------
// Scene contents
// ---------------------------------------------------------------------------
function SceneContents() {
  const rand = seeded(123);

  const coralPlacements = useMemo(() => {
    const arr = [];
    const models = ['/models/coral-reef1.glb', '/models/coral-reef2.glb', '/models/coral-reef3.glb'];
    for (let i = 0; i < 18; i++) {
      arr.push({
        pos: [(rand() - 0.5) * 320, -2, (rand() - 0.5) * 220] as [number, number, number],
        model: models[Math.floor(rand() * models.length)],
        scale: 0.1 + rand() * 0.2,
        rotY: rand() * Math.PI * 2,
      });
    }
    return arr;
  }, []);

  const kelpPositions = useMemo(() => {
    const arr = [];
    for (let i = 0; i < 15; i++) {
      arr.push({
        pos: [(rand() - 0.5) * 350, -2, (rand() - 0.5) * 250] as [number, number, number],
        scale: 0.15 + rand() * 0.25,
      });
    }
    return arr;
  }, []);

  return (
    <>
      <OrbitCamera />

      {/* Lighting */}
      <ambientLight intensity={0.4} color={0x88ccee} />
      <directionalLight
        position={[100, 200, 80]}
        intensity={0.9}
        color={0xffeedd}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <pointLight position={[0, 70, 0]} intensity={0.5} color={0x00e5ff} distance={250} />
      <pointLight position={[-60, 50, -30]} intensity={0.2} color={0x44aaff} distance={150} />
      <pointLight position={[80, 50, 20]} intensity={0.2} color={0x22ccdd} distance={150} />

      <fog attach="fog" args={[new THREE.Color(0x061520), 100, 350]} />

      {/* Ocean floor */}
      <OceanFloor />

      {/* Real coral models */}
      {coralPlacements.map((c, i) => (
        <CoralModel key={`coral-${i}`} position={c.pos} model={c.model} scale={c.scale} rotationY={c.rotY} />
      ))}

      {/* Real kelp models */}
      {kelpPositions.map((k, i) => (
        <KelpModel key={`kelp-${i}`} position={k.pos} scale={k.scale} />
      ))}

      {/* Real lobster models — visible around scene edges */}
      <LobsterModel position={[-65, 0, -15]} scale={0.35} rotationY={0.5} />
      <LobsterModel position={[75, 0, -20]} scale={0.3} rotationY={2.1} />
      <LobsterModel position={[-55, 0, 45]} scale={0.25} rotationY={4.2} />
      <LobsterModel position={[70, 0, 50]} scale={0.35} rotationY={1.0} />
      <LobsterModel position={[5, 0, -65]} scale={0.28} rotationY={3.5} />
      <LobsterModel position={[-90, 0, 10]} scale={0.3} rotationY={5.5} />

      {/* Crayfish scattered */}
      <CrayfishModel position={[95, 0, -40]} scale={0.2} />
      <CrayfishModel position={[-40, 0, 70]} scale={0.18} />

      {/* Bubbles */}
      <Bubbles count={60} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Exported component
// ---------------------------------------------------------------------------
export default function LandingScene() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) return null;

  return (
    <div className="absolute inset-0 z-0">
      <Canvas
        shadows
        gl={{ antialias: true }}
        camera={{
          fov: 50,
          near: 1,
          far: 500,
          position: [0, 55, 140],
        }}
        onCreated={({ scene }) => {
          scene.background = new THREE.Color(0x061520);
        }}
      >
        <SceneContents />
      </Canvas>
    </div>
  );
}
