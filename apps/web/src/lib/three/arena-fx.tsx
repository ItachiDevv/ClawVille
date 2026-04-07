'use client';

import { useRef, useMemo, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useNpcStore } from '@/stores/npc';
import type { NpcSpriteState } from '@/stores/npc';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;

/** Convert pixel X to Three.js world X */
function toWorldX(px: number): number {
  return px - MAP_WIDTH / 2;
}

/** Convert pixel Y to Three.js world Z */
function toWorldZ(py: number): number {
  return py - MAP_HEIGHT / 2;
}

// ---------------------------------------------------------------------------
// Types for tracked FX instances
// ---------------------------------------------------------------------------
interface DamageNumberFx {
  id: string;
  damage: number;
  x: number;
  y: number; // Three.js Y (height)
  z: number;
  opacity: number;
  life: number; // 0..1 over 1 second
}

interface HitFlashFx {
  id: string;
  x: number;
  z: number;
  scale: number;
  opacity: number;
  life: number;
}

interface LootParticle {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  opacity: number;
  life: number;
}

interface LootSparkleGroup {
  id: string;
  particles: LootParticle[];
}

// ---------------------------------------------------------------------------
// ArenaFx Component
// ---------------------------------------------------------------------------
function ArenaFx() {
  // Refs to track active FX and avoid duplicates
  const damageNumbersRef = useRef<DamageNumberFx[]>([]);
  const hitFlashesRef = useRef<HitFlashFx[]>([]);
  const lootSparklesRef = useRef<LootSparkleGroup[]>([]);
  const seenCombatIdsRef = useRef<Set<string>>(new Set());
  const seenLootIdsRef = useRef<Set<string>>(new Set());

  // Force re-renders by bumping a counter
  const frameCounterRef = useRef(0);

  // Shared geometry for loot particles (allocated once)
  const particleGeo = useMemo(() => new THREE.SphereGeometry(1.5, 6, 4), []);

  // Hit flash geometry
  const flashGeo = useMemo(() => new THREE.SphereGeometry(1, 12, 8), []);

  useFrame((_, delta) => {
    const state = useNpcStore.getState();
    const now = Date.now();
    const npcs = state.npcs;
    const npcMap = new Map<string, NpcSpriteState>();
    for (const npc of npcs) {
      npcMap.set(npc.id, npc);
    }

    // -----------------------------------------------------------------------
    // Spawn new damage numbers + hit flashes from CombatEvents
    // -----------------------------------------------------------------------
    for (const event of state.combatEvents) {
      if (event.expiresAt < now) continue;
      if (seenCombatIdsRef.current.has(event.id)) continue;
      seenCombatIdsRef.current.add(event.id);

      const defender = npcMap.get(event.defenderId);
      if (!defender) continue;

      const worldX = toWorldX(defender.x) + (Math.random() - 0.5) * 20;
      const worldZ = toWorldZ(defender.y);

      // Damage number
      damageNumbersRef.current.push({
        id: `dmg-${event.id}`,
        damage: event.damage,
        x: worldX,
        y: 30, // start height above ground
        z: worldZ,
        opacity: 1,
        life: 0,
      });

      // Hit flash
      hitFlashesRef.current.push({
        id: `flash-${event.id}`,
        x: toWorldX(defender.x),
        z: worldZ,
        scale: 5,
        opacity: 0.6,
        life: 0,
      });
    }

    // -----------------------------------------------------------------------
    // Spawn loot sparkles from LootEvents
    // -----------------------------------------------------------------------
    for (const event of state.lootEvents) {
      if (event.expiresAt < now) continue;
      if (seenLootIdsRef.current.has(event.id)) continue;
      seenLootIdsRef.current.add(event.id);

      const winner = npcMap.get(event.winnerId);
      if (!winner) continue;

      const cx = toWorldX(winner.x);
      const cz = toWorldZ(winner.y);

      const particles: LootParticle[] = [];
      const count = Math.min(event.itemCount * 3 + 4, 16);
      for (let i = 0; i < count; i++) {
        particles.push({
          id: `lp-${event.id}-${i}`,
          x: cx + (Math.random() - 0.5) * 30,
          y: 5 + Math.random() * 10,
          z: cz + (Math.random() - 0.5) * 30,
          vx: (Math.random() - 0.5) * 40,
          vy: 30 + Math.random() * 50,
          vz: (Math.random() - 0.5) * 40,
          opacity: 1,
          life: 0,
        });
      }

      lootSparklesRef.current.push({
        id: `sparkle-${event.id}`,
        particles,
      });
    }

    // -----------------------------------------------------------------------
    // Animate damage numbers: rise upward, fade out over 1s
    // -----------------------------------------------------------------------
    const aliveDamageNumbers: DamageNumberFx[] = [];
    for (const dn of damageNumbersRef.current) {
      dn.life += delta;
      dn.y += 40 * delta; // rise upward
      dn.opacity = Math.max(0, 1 - dn.life);
      if (dn.life < 1) {
        aliveDamageNumbers.push(dn);
      }
    }
    damageNumbersRef.current = aliveDamageNumbers;

    // -----------------------------------------------------------------------
    // Animate hit flashes: expand and fade over 0.3s
    // -----------------------------------------------------------------------
    const aliveFlashes: HitFlashFx[] = [];
    for (const hf of hitFlashesRef.current) {
      hf.life += delta;
      hf.scale = 5 + hf.life * 80; // expand
      hf.opacity = Math.max(0, 0.6 * (1 - hf.life / 0.3));
      if (hf.life < 0.3) {
        aliveFlashes.push(hf);
      }
    }
    hitFlashesRef.current = aliveFlashes;

    // -----------------------------------------------------------------------
    // Animate loot particles: float upward, slow spread, fade over 1.5s
    // -----------------------------------------------------------------------
    const aliveSparkles: LootSparkleGroup[] = [];
    for (const group of lootSparklesRef.current) {
      let anyAlive = false;
      for (const p of group.particles) {
        p.life += delta;
        p.x += p.vx * delta * 0.5;
        p.y += p.vy * delta;
        p.z += p.vz * delta * 0.5;
        p.vy -= 20 * delta; // gravity
        p.opacity = Math.max(0, 1 - p.life / 1.5);
        if (p.life < 1.5) anyAlive = true;
      }
      if (anyAlive) aliveSparkles.push(group);
    }
    lootSparklesRef.current = aliveSparkles;

    // -----------------------------------------------------------------------
    // Clean up seen IDs for expired events
    // -----------------------------------------------------------------------
    const activeCombatIds = new Set(state.combatEvents.map((e) => e.id));
    for (const id of seenCombatIdsRef.current) {
      if (!activeCombatIds.has(id)) {
        seenCombatIdsRef.current.delete(id);
      }
    }
    const activeLootIds = new Set(state.lootEvents.map((e) => e.id));
    for (const id of seenLootIdsRef.current) {
      if (!activeLootIds.has(id)) {
        seenLootIdsRef.current.delete(id);
      }
    }

    // Trigger re-render
    frameCounterRef.current += 1;
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const damageNumbers = damageNumbersRef.current;
  const hitFlashes = hitFlashesRef.current;
  const lootGroups = lootSparklesRef.current;

  return (
    <group>
      {/* Damage number texts */}
      {damageNumbers.map((dn) => (
        <Text
          key={dn.id}
          position={[dn.x, dn.y, dn.z]}
          fontSize={10}
          color="#ff4444"
          anchorX="center"
          anchorY="middle"
          outlineWidth={1.5}
          outlineColor="#000000"
          fillOpacity={dn.opacity}
          outlineOpacity={dn.opacity}
        >
          {`-${dn.damage}`}
        </Text>
      ))}

      {/* Hit flashes (expanding red spheres) */}
      {hitFlashes.map((hf) => (
        <mesh
          key={hf.id}
          position={[hf.x, 15, hf.z]}
          scale={[hf.scale, hf.scale, hf.scale]}
          geometry={flashGeo}
        >
          <meshBasicMaterial
            color={0xff0000}
            transparent
            opacity={hf.opacity}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {/* Loot sparkle particles */}
      {lootGroups.map((group) =>
        group.particles
          .filter((p) => p.life < 1.5)
          .map((p) => (
            <mesh
              key={p.id}
              position={[p.x, p.y, p.z]}
              geometry={particleGeo}
            >
              <meshBasicMaterial
                color={0xffd700}
                transparent
                opacity={p.opacity}
              />
            </mesh>
          ))
      )}
    </group>
  );
}

export default memo(ArenaFx);
