'use client';

import { useRef, useMemo, useCallback, useState, memo } from 'react';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParticleType =
  | 'dust'
  | 'hearts'
  | 'zzz'
  | 'sweat'
  | 'music'
  | 'stars'
  | 'sparkle';

export interface ParticleRequest {
  type: ParticleType;
  x: number; // Three.js world X
  y: number; // Three.js world Y (height)
  z: number; // Three.js world Z
  count?: number; // defaults per type
}

interface Particle {
  active: boolean;
  type: ParticleType;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  life: number;
  maxLife: number;
  opacity: number;
  scale: number;
  color: THREE.Color;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARTICLES = 100;

// Per-type defaults: color palette, velocity ranges, gravity, lifetime, scale
const TYPE_CONFIG: Record<
  ParticleType,
  {
    colors: number[];
    vxRange: [number, number];
    vyRange: [number, number];
    vzRange: [number, number];
    gravity: number;
    lifetime: [number, number];
    scale: [number, number];
    defaultCount: number;
  }
> = {
  dust: {
    colors: [0xc4a882, 0xb89b71, 0xd4b896],
    vxRange: [-15, 15],
    vyRange: [2, 8],
    vzRange: [-15, 15],
    gravity: -2,
    lifetime: [0.4, 0.8],
    scale: [0.4, 0.8],
    defaultCount: 5,
  },
  hearts: {
    colors: [0xff4466, 0xff6688, 0xff2244],
    vxRange: [-5, 5],
    vyRange: [15, 30],
    vzRange: [-5, 5],
    gravity: 0,
    lifetime: [1.0, 1.8],
    scale: [0.6, 1.2],
    defaultCount: 3,
  },
  zzz: {
    colors: [0x88ccff, 0xaaddff, 0x66bbff],
    vxRange: [2, 8],
    vyRange: [10, 18],
    vzRange: [-2, 2],
    gravity: 0,
    lifetime: [1.5, 2.5],
    scale: [0.8, 1.4],
    defaultCount: 2,
  },
  sweat: {
    colors: [0x4488ff, 0x66aaff, 0x3377ee],
    vxRange: [-8, 8],
    vyRange: [5, 12],
    vzRange: [-3, 3],
    gravity: -25,
    lifetime: [0.5, 1.0],
    scale: [0.3, 0.6],
    defaultCount: 4,
  },
  music: {
    colors: [0x00cccc, 0x00eebb, 0x44ddcc],
    vxRange: [-8, 8],
    vyRange: [15, 25],
    vzRange: [-4, 4],
    gravity: 0,
    lifetime: [1.2, 2.0],
    scale: [0.7, 1.0],
    defaultCount: 3,
  },
  stars: {
    colors: [0xffd700, 0xffee44, 0xffcc00],
    vxRange: [-25, 25],
    vyRange: [20, 50],
    vzRange: [-25, 25],
    gravity: -15,
    lifetime: [0.8, 1.5],
    scale: [0.5, 1.2],
    defaultCount: 8,
  },
  sparkle: {
    colors: [0xffffff, 0x88ffff, 0xccffff],
    vxRange: [-12, 12],
    vyRange: [8, 20],
    vzRange: [-12, 12],
    gravity: -3,
    lifetime: [0.6, 1.2],
    scale: [0.3, 0.7],
    defaultCount: 6,
  },
};

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// Singleton request queue (accessible outside React)
// ---------------------------------------------------------------------------

const pendingRequests: ParticleRequest[] = [];

/** Emit particles at a given world position. Call from anywhere. */
export function emitParticles(request: ParticleRequest) {
  pendingRequests.push(request);
}

// ---------------------------------------------------------------------------
// ParticleSystem Component
// ---------------------------------------------------------------------------

function ParticleSystem() {
  // Pool of particles
  const poolRef = useRef<Particle[]>(null!);
  if (!poolRef.current) {
    const pool: Particle[] = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      pool.push({
        active: false,
        type: 'dust',
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 0,
        life: 0,
        maxLife: 1,
        opacity: 0,
        scale: 0.5,
        color: new THREE.Color(0xffffff),
      });
    }
    poolRef.current = pool;
  }

  // Shared geometry
  const sphereGeo = useMemo(() => new THREE.SphereGeometry(1, 6, 4), []);
  const boxGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);

  // PERF: track active particles in React state (only updated when count changes)
  // so the render body never calls pool.filter() — that allocates a new array
  // every React reconcile even when all particles are inactive.
  const [activeParticles, setActiveParticles] = useState<Particle[]>([]);
  const prevActiveCountRef = useRef(0);

  // Acquire a free particle from the pool
  const acquire = useCallback((): Particle | null => {
    const pool = poolRef.current as unknown as Particle[];
    for (const p of pool) {
      if (!p.active) return p;
    }
    return null;
  }, []);

  useSceneFrame((_, delta) => {
    const pool = poolRef.current as unknown as Particle[];
    const dt = Math.min(delta, 0.1);

    // Process pending requests
    while (pendingRequests.length > 0) {
      const req = pendingRequests.shift()!;
      const cfg = TYPE_CONFIG[req.type];
      const count = req.count ?? cfg.defaultCount;

      for (let i = 0; i < count; i++) {
        const p = acquire();
        if (!p) break;

        p.active = true;
        p.type = req.type;
        p.x = req.x + randRange(-3, 3);
        p.y = req.y + randRange(-1, 1);
        p.z = req.z + randRange(-3, 3);
        p.vx = randRange(cfg.vxRange[0], cfg.vxRange[1]);
        p.vy = randRange(cfg.vyRange[0], cfg.vyRange[1]);
        p.vz = randRange(cfg.vzRange[0], cfg.vzRange[1]);
        p.gravity = cfg.gravity;
        p.life = 0;
        p.maxLife = randRange(cfg.lifetime[0], cfg.lifetime[1]);
        p.opacity = 1;
        p.scale = randRange(cfg.scale[0], cfg.scale[1]);
        p.color.set(pickRandom(cfg.colors));
      }
    }

    // Update all active particles
    for (const p of pool) {
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy += p.gravity * dt;

      // Fade out in the last 40% of life
      const lifeRatio = p.life / p.maxLife;
      p.opacity = lifeRatio > 0.6 ? 1 - (lifeRatio - 0.6) / 0.4 : 1;
    }

    // Only trigger React re-render when active count changes — avoids calling
    // pool.filter() in the render body every frame (costly array allocation).
    const currentActive = pool.filter((p) => p.active);
    const newCount = currentActive.length;
    if (newCount !== prevActiveCountRef.current) {
      prevActiveCountRef.current = newCount;
      setActiveParticles([...currentActive]);
    }
  });

  const pool = poolRef.current as unknown as Particle[];
  // Use state-driven active list (updated lazily when count changes, not every frame)
  const active = activeParticles;

  return (
    <group>
      {active.map((p, i) => {
        // Use box for zzz and music, sphere for everything else
        const geo = p.type === 'zzz' || p.type === 'music' ? boxGeo : sphereGeo;
        return (
          <mesh
            key={i}
            position={[p.x, p.y, p.z]}
            scale={[p.scale, p.scale, p.scale]}
            geometry={geo}
          >
            <meshBasicMaterial
              color={p.color}
              transparent
              opacity={p.opacity}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}

export default memo(ParticleSystem);
