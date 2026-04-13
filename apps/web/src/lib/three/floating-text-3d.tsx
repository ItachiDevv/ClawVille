'use client';

import { useRef, useState, memo } from 'react';
import { useFrame } from '@react-three/fiber';
// Text removed
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const FLOAT_SPEED = 30; // units per second upward
const LIFETIME = 1.5; // seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FloatingTextInstance {
  id: number;
  text: string;
  color: THREE.Color;
  x: number;
  y: number;
  z: number;
  life: number;
  opacity: number;
}

let nextId = 0;

// ---------------------------------------------------------------------------
// FloatingTexts3D Component
// ---------------------------------------------------------------------------

function FloatingTexts3D() {
  // React state drives re-renders; useRef holds the mutable list so useFrame
  // can mutate it without triggering extra re-renders mid-flight.
  // Each useFrame tick: update physics on the ref, then call setTexts() with a
  // shallow copy so React re-renders with the latest positions and opacities.
  const textsRef = useRef<FloatingTextInstance[]>([]);
  const [texts, setTexts] = useState<FloatingTextInstance[]>([]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);

    // Consume any pending floating texts from the game store
    const pending = useGameStore.getState().consumeFloatingTexts();
    if (pending.length > 0) {
      const store = useGameStore.getState();
      const worldX = store.avatarPosition.x - HALF_W;
      const worldZ = store.avatarPosition.y - HALF_H;

      for (const { text, color } of pending) {
        textsRef.current.push({
          id: nextId++,
          text,
          color: new THREE.Color(color),
          x: worldX + (Math.random() - 0.5) * 10,
          y: 20, // start above avatar
          z: worldZ,
          life: 0,
          opacity: 1,
        });
      }
    }

    if (textsRef.current.length === 0) return;

    // Update existing texts
    const alive: FloatingTextInstance[] = [];
    for (const ft of textsRef.current) {
      ft.life += dt;
      ft.y += FLOAT_SPEED * dt;
      // Fade out in last 40%
      const ratio = ft.life / LIFETIME;
      ft.opacity = ratio > 0.6 ? 1 - (ratio - 0.6) / 0.4 : 1;

      if (ft.life < LIFETIME) {
        alive.push(ft);
      }
    }
    textsRef.current = alive;

    // Shallow-copy array to trigger React re-render with updated positions
    setTexts([...alive]);
  });

  if (texts.length === 0) return null;

  return (
    <group>
      {texts.map((ft) => (
        <mesh key={ft.id} position={[ft.x, ft.y, ft.z]}>
          <sphereGeometry args={[1.5, 6, 6]} />
          <meshBasicMaterial color={ft.color} transparent opacity={ft.opacity} />
        </mesh>
      ))}
    </group>
  );
}

export default memo(FloatingTexts3D);
