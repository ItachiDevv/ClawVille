'use client';

import { useRef, useState, memo } from 'react';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
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
  // can mutate it. Only call setTexts when the count changes (text added or
  // expired) to avoid re-rendering every frame during the 1.5s lifetime.
  const textsRef = useRef<FloatingTextInstance[]>([]);
  const [texts, setTexts] = useState<FloatingTextInstance[]>([]);
  const prevCountRef = useRef(0);

  useSceneFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);

    // Consume any pending floating texts from the game store
    const pending = useGameStore.getState().consumeFloatingTexts();
    let dirty = pending.length > 0;
    if (dirty) {
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

    if (textsRef.current.length === 0) {
      if (prevCountRef.current > 0) {
        prevCountRef.current = 0;
        setTexts([]);
      }
      return;
    }

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
      } else {
        dirty = true; // a text expired
      }
    }
    textsRef.current = alive;

    // Only trigger React re-render when texts are added or removed
    if (dirty || alive.length !== prevCountRef.current) {
      prevCountRef.current = alive.length;
      setTexts([...alive]);
    }
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
