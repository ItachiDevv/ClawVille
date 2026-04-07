'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Simplified terrain — single merged geometry for performance.
// Uses vertex colors on a subdivided plane instead of 1000 individual tiles.
// ---------------------------------------------------------------------------

const SAND = new THREE.Color(0xd4b896);
const SAND_DARK = new THREE.Color(0xbfa06a);
const SAND_LIGHT = new THREE.Color(0xe8d5b7);
const PATH_COLOR = new THREE.Color(0x8faaaa);

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function OceanFloor() {
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 80, 50);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const rand = seeded(42);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getY(i);

      // Gentle undulation
      pos.setZ(i, Math.sin(x * 0.015) * 1.5 + Math.cos(z * 0.02) * 1 + rand() * 0.5);

      // Vary sand color
      const t = rand();
      const c = t < 0.3
        ? new THREE.Color().lerpColors(SAND, SAND_DARK, rand())
        : t < 0.6
          ? new THREE.Color().lerpColors(SAND, SAND_LIGHT, rand() * 0.5)
          : SAND.clone();

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

// A few scattered decorations (minimal geometry)
function Decorations() {
  const rand = seeded(99);
  const items = useMemo(() => {
    const arr = [];
    // Small rocks
    for (let i = 0; i < 30; i++) {
      arr.push({
        type: 'rock',
        x: (rand() - 0.5) * MAP_WIDTH * 0.9,
        z: (rand() - 0.5) * MAP_HEIGHT * 0.9,
        scale: 0.5 + rand() * 1.5,
        color: new THREE.Color().lerpColors(new THREE.Color(0x888888), new THREE.Color(0x666666), rand()),
      });
    }
    // Coral blobs
    for (let i = 0; i < 15; i++) {
      arr.push({
        type: 'coral',
        x: (rand() - 0.5) * MAP_WIDTH * 0.85,
        z: (rand() - 0.5) * MAP_HEIGHT * 0.85,
        scale: 1 + rand() * 2,
        color: new THREE.Color().setHSL(rand(), 0.7, 0.5),
      });
    }
    return arr;
  }, []);

  return (
    <group>
      {items.map((item, i) => (
        <mesh key={i} position={[item.x, item.scale * 0.3 - 2, item.z]} castShadow>
          {item.type === 'rock' ? (
            <dodecahedronGeometry args={[item.scale, 0]} />
          ) : (
            <sphereGeometry args={[item.scale, 6, 6]} />
          )}
          <meshStandardMaterial color={item.color} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <group>
      <OceanFloor />
      <Decorations />
    </group>
  );
}
