'use client';

import { useRef, useMemo, useEffect, memo, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';
import { applyWalkAnimation, applyIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';
import { LobsterAnimator, resolveAnimState } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import {
  createCharacterAnimator,
  applyColorTint,
  type CharacterAnimator,
  MODEL_KEY_TO_TYPE,
} from '@/lib/three/character-animations';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB-based NPC renderer with terrain raycasting
// NPCs walk on the actual terrain surface instead of a static Y level
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const LERP_SPEED = 5;
// TARGET_NPC_HEIGHT: desired world-unit height for wandering NPCs.
// Previously NPC_SCALE=50 was a flat multiplier applied to all species; measured
// heights were 30-36 wu because species GLBs have native heights of 0.6-0.7 units
// (0.65 × 50 = 32.5). Per-model normalization (computeNpcScale below) replaces the
// flat multiplier — each species is measured at mount time and scaled to this target.
// Pass 1 (2026-04-16): reduced 120→75. Pass 2 (2026-04-16): reduced 75→45.
// User tested pass 1 and the lobster NPC was still too big relative to buildings (800 wu).
// 45 wu gives a ~1:17.8 ratio vs 800-wu building — target was 1:16–1:20.
const TARGET_NPC_HEIGHT = 45;

// Sanity clamp for per-species computed scale (mirrors arena-location-npcs logic).
// MAX = TARGET_NPC_HEIGHT/0.5 = 90 — any computed scale > 90 implies native above-pivot
// height < 0.5 units, which means only tiny props/accessories are non-skinned geometry.
// In that case we fall back to a safe default scale of TARGET_NPC_HEIGHT (assumes
// visual body native height ≈ 1.0 unit, which is true for the humanoid species).
const NPC_SCALE_CLAMP_MIN = TARGET_NPC_HEIGHT / 200; // ~0.225
const NPC_SCALE_CLAMP_MAX = TARGET_NPC_HEIGHT / 0.5; // 90

// Preload deferred to after SPECIES_MODEL declaration — see below.

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// Lobster GLB faces +Z natively (rotation.y=0 → head toward +Z). EMPIRICALLY VERIFIED 2026-04-16 (late PM, clean side-view screenshot).
// Prior session concluded +X — that was WRONG (camera was orbited, misread as side-view).
// To face direction (worldVx, worldVz): θ = atan2(worldVx, worldVz)  (no negations)
const DIR_ROTATION: Record<string, number> = {
  down: 0, up: Math.PI, right: Math.PI / 2, left: -Math.PI / 2, idle: 0,
};

import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

// Scratch objects for computeLocalMinY — module-scope to avoid GC in useMemo.
const _npcBbox = new THREE.Box3();
const _npcMeshBbox = new THREE.Box3();

/** Measure the non-SkinnedMesh bbox of a freshly cloned scene, returning both
 *  the per-species normalized scale and the local min.y for pivot grounding.
 *
 *  Normalizing dimension: bbox.max.y (above-pivot visual height). Using size.y
 *  inflates h when geometry extends below the pivot, causing under-sized renders.
 *  bbox.max.y gives the true "height above ground" of the tallest point.
 *
 *  Falls back to Box3.setFromObject() if no non-skinned geometry is found,
 *  then falls back to TARGET_NPC_HEIGHT scale if the computed value is outside
 *  the sanity clamp (implies only tiny accessory props are non-skinned).
 *
 *  pivotOffsetY = localMinY * finalScale — subtract from group.position.y each
 *  frame so the model's geometry bottom aligns with terrain surface. */
function computeNpcScale(scene: THREE.Object3D): { scale: number; localMinY: number } {
  scene.updateMatrixWorld(true);
  _npcBbox.makeEmpty();

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _npcMeshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _npcBbox.union(_npcMeshBbox);
    }
  });

  if (_npcBbox.isEmpty()) {
    // All geometry is SkinnedMesh (chihiro, priestess, chibi_goku, etc.).
    // Use the bind-pose bbox to measure the actual native geometry height — DO NOT
    // assume native height ≈ 1.0 unit. Some GLBs are exported at 500–650 native units;
    // applying scale=TARGET(120) on top would render them at 60000–78000 wu.
    // setFromObject() uses bind-pose world matrices (inflated Y extents), but we only
    // use it for SCALE computation (max.y / total height). We force localMinY=0 to avoid
    // using the inflated min.y in the pivot-offset calculation (which caused skyward launch).
    _npcBbox.setFromObject(scene);
    if (_npcBbox.isEmpty()) {
      // Truly empty scene (no geometry at all) — safe minimum
      return { scale: NPC_SCALE_CLAMP_MIN, localMinY: 0 };
    }
    const bindH = _npcBbox.max.y > 0.001 ? _npcBbox.max.y : (_npcBbox.max.y - _npcBbox.min.y);
    const bindScale = bindH > 0.001 ? TARGET_NPC_HEIGHT / bindH : TARGET_NPC_HEIGHT;
    const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, bindScale));
    // localMinY=0: never use the bind-pose min.y for pivot offset — it inflates to hundreds
    // of native units and would produce a catastrophic pivotOffsetY (scale * inflated_min).
    return { scale, localMinY: 0 };
  }

  // localMinY MUST come from the non-skinned bbox only — never from setFromObject.
  // If we used the inflated setFromObject fallback bbox, localMinY would be wrong
  // (bind-pose extends far below origin) and pivotOffsetY would launch NPCs skyward.
  const localMinY = _npcBbox.min.y;
  const maxY = _npcBbox.max.y;

  // Use bbox.max.y as normalizing height (above-pivot visual extent)
  const h = maxY > 0.001 ? maxY : 1.0;
  const computed = TARGET_NPC_HEIGHT / h;

  // If computed > CLAMP_MAX the non-skinned geometry is tiny accessories (not the body).
  // Fall back to bind-pose bbox for a more reliable body height estimate.
  // CRITICAL: force localMinY=0 here — localMinY came from a tiny accessory (e.g. a coin
  // at y=-154 local space). Using that value × a large scale would launch the NPC skyward.
  // (localMinY * 240 = -37000+ wu offset → NPC appears at +37000 above ground.)
  if (computed > NPC_SCALE_CLAMP_MAX) {
    const _bindBbox = new THREE.Box3().setFromObject(scene);
    if (!_bindBbox.isEmpty()) {
      const bindMaxY = _bindBbox.max.y > 0.001 ? _bindBbox.max.y : (_bindBbox.max.y - _bindBbox.min.y);
      if (bindMaxY > 0.001) {
        const bindScale = TARGET_NPC_HEIGHT / bindMaxY;
        const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, bindScale));
        return { scale, localMinY: 0 };
      }
    }
  }

  // Hard cap — unconditional. Never allow scale to escape this range regardless of
  // what the bbox measurement returns. This is the final safety net, not a conditional.
  const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, computed));

  return { scale, localMinY };
}

/** Legacy helper for computeLocalMinY — kept for call sites that only need minY.
 *  @deprecated Use computeNpcScale instead when you also need the scale. */
function computeLocalMinY(scene: THREE.Object3D): number {
  return computeNpcScale(scene).localMinY;
}

// Module-scope scratch Box3 for the rendered-height hard cap (Layer 2 safety net).
// Allocated once — never inside useFrame to avoid GC pressure.
const _renderedBbox = new THREE.Box3();

// Shared raycaster — set to only hit layer 1 (terrain)
const _raycaster = new THREE.Raycaster();
_raycaster.layers.set(TERRAIN_LAYER);
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3(0, -1, 0);

/** Raycast down from (x, z) to find terrain surface Y */
function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  _rayOrigin.set(x, 200, z);
  _raycaster.set(_rayOrigin, _rayDir);
  // Re-apply layer after set() (set() resets layers)
  _raycaster.layers.set(TERRAIN_LAYER);
  _raycaster.far = 400;

  const intersects = _raycaster.intersectObjects(scene.children, true);
  if (intersects.length > 0) {
    return intersects[0].point.y;
  }
  return -2; // flat sand floor
}

// Map species strings to GLB paths + model keys for the new character system
const SPECIES_MODEL: Record<string, { path: string; key: string }> = {
  lobster:       { path: '/models/lobster.glb',                    key: 'lobster' },
  crayfish:      { path: '/models/crayfish.glb',                   key: 'crayfish' },
  sweet_crab:    { path: '/models/sweet_crab_sketchfabweekly.glb', key: 'sweet_crab' },
  lobster_plush: { path: '/models/lobster_plush.glb',              key: 'lobster_plush' },
  hermitcrab:    { path: '/models/hermitcrab.glb',                 key: 'hermitcrab' },
  chihiro:       { path: '/models/spirited_away_senchihiro.glb',   key: 'chihiro' },
  priestess:     { path: '/models/young_priestess.glb',            key: 'priestess' },
  chibi_goku:    { path: '/models/chibi_goku.glb',                 key: 'chibi_goku' },
  jellyfish:     { path: '/models/jellyfish.glb',                  key: 'jellyfish' },
  octopus:       { path: '/models/octopus_toy.glb',                key: 'octopus' },
  seahorse:      { path: '/models/sea_horse.glb',                  key: 'seahorse' },
};
const DEFAULT_SPECIES = SPECIES_MODEL.lobster;

// Preload all species GLBs at module level (11 models, ~3-4 MB total) so
// wandering NPCs don't cause network+parse pops when they first appear.
Object.values(SPECIES_MODEL).forEach(({ path }) => useGLTF.preload(path));

// ---------------------------------------------------------------------------
// Single NPC using GLB model with terrain following
// ---------------------------------------------------------------------------
const GLBNpcMesh = memo(function GLBNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);
  // Layer 2 safety net: one-shot rendered-height hard cap applied after first render.
  // Catches any NPC that slips through computeNpcScale with a wrong pivot offset.
  const rescaleAppliedRef = useRef(false);
  const npcRef = useRef(npc);
  npcRef.current = npc;
  const { scene: threeScene } = useThree();
  // idToSeed returns a float (0..10). Convert to integer so (frame + seed) % N
  // uses integer arithmetic — float modulo with strict === 0 never fires.
  const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);

  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(0);
  const currentTerrainY = useRef(0);

  const speciesInfo = SPECIES_MODEL[npc.species] ?? DEFAULT_SPECIES;
  const { scene } = useGLTF(speciesInfo.path);

  // Determine which animation system to use
  const useNewSystem = speciesInfo.key !== 'lobster' && speciesInfo.key !== 'crayfish';

  const { cloned, npcScale, lobsterAnimator, charAnimator, pivotOffsetY } = useMemo(() => {
    const c = scene.clone(true);
    const tint = new THREE.Color(npc.color);
    applyColorTint(c, tint, 0.7, 0.25);

    // Compute per-species normalized scale + pivot offset.
    // npcScale normalizes the model's above-pivot height to TARGET_NPC_HEIGHT.
    // pivotOffset = localMinY * npcScale — subtracted from group.position.y so
    // the geometry bottom aligns with terrain regardless of model pivot placement.
    const { scale: npcScaleComputed, localMinY } = computeNpcScale(c);
    const pivotOffset = localMinY * npcScaleComputed;

    if (useNewSystem) {
      const anim = createCharacterAnimator(speciesInfo.key, c);
      return {
        cloned: c,
        npcScale: npcScaleComputed,
        lobsterAnimator: null as LobsterAnimator | null,
        charAnimator: anim as CharacterAnimator,
        pivotOffsetY: pivotOffset,
      };
    } else {
      const parts = discoverLobsterParts(c);
      const anim  = new LobsterAnimator(parts);
      return {
        cloned: c,
        npcScale: npcScaleComputed,
        lobsterAnimator: anim,
        charAnimator: null as CharacterAnimator | null,
        pivotOffsetY: pivotOffset,
      };
    }
  }, [scene, npc.color, speciesInfo.key, useNewSystem]);

  // Dispose cloned geometry + materials when the NPC is removed from the store
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  useFrame(({ clock }, delta) => {
    const d = npcRef.current;
    const group = groupRef.current;
    const animGroup = animGroupRef.current;
    if (!group || !animGroup) return;

    const dt = Math.min(delta, 0.1);

    // Update target XZ position
    targetPos.current.set(d.x - HALF_W, 0, d.y - HALF_H);

    // Lerp XZ position
    currentPos.current.x += (targetPos.current.x - currentPos.current.x) * (1 - Math.exp(-LERP_SPEED * dt));
    currentPos.current.z += (targetPos.current.z - currentPos.current.z) * (1 - Math.exp(-LERP_SPEED * dt));

    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // Raycast to find terrain surface Y (every 3rd frame to save perf).
    // Use (frame + seed) % 3 to stagger across NPCs — prevents all NPCs from
    // raycasting on the same frame tick (which would spike the CPU every 150ms).
    // Use clock.elapsedTime (already available) instead of Date.now() to avoid
    // a syscall allocation in the hot path.
    const frame = Math.floor(clock.elapsedTime * 60);
    if ((frame + seed) % 3 === 0) {
      const terrainY = getTerrainY(group.position.x, group.position.z, threeScene);
      currentTerrainY.current += (terrainY - currentTerrainY.current) * 0.3;
    }

    // Base bob on top of terrain height.
    // Subtract pivotOffsetY to ground each GLB regardless of pivot placement:
    //   pivotOffsetY = localMinY * npcScale (per-species)
    //   - pivotOffsetY < 0 → pivot above feet → subtracting a negative raises the model
    //   - pivotOffsetY = 0 → no change
    //   - pivotOffsetY > 0 → pivot below feet (floating) → lowers it
    const isMoving = d.direction !== 'idle' && !d.isDead;
    const bob = isMoving ? Math.sin(clock.elapsedTime * 4.0 + seed) * 0.6 : 0;
    group.position.y = currentTerrainY.current + 2 + bob - pivotOffsetY;

    // Direction rotation — use smooth facingAngle when set (possessed NPC),
    // otherwise snap to cardinal DIR_ROTATION (autonomous wander NPCs).
    const targetRot = d.facingAngle != null ? d.facingAngle : (DIR_ROTATION[d.direction] ?? 0);
    // Shortest-path lerp (handle wrapping around ±PI)
    let diff = targetRot - currentRotY.current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    currentRotY.current += diff * Math.min(1, 8 * dt);
    group.rotation.y = currentRotY.current;

    // Layer 2: one-shot rendered-height hard cap.
    // Runs once after 0.5s so geometry/bones settle before measurement.
    // Guards against any NPC whose pivot offset blows up despite Layer 1 fixes.
    // HARD_MAX = 95 wu — 2× TARGET_NPC_HEIGHT=45 headroom (pass 2: reduced from 160 on 2026-04-16).
    if (!rescaleAppliedRef.current && clock.elapsedTime > 0.5) {
      _renderedBbox.setFromObject(group);
      if (!_renderedBbox.isEmpty()) {
        const renderedH = _renderedBbox.max.y - _renderedBbox.min.y;
        const HARD_MAX = 95;
        if (renderedH > HARD_MAX) {
          const scaledSubGroup = group.children[0]; // the [npcScale, npcScale, npcScale] group
          if (scaledSubGroup) {
            scaledSubGroup.scale.multiplyScalar(HARD_MAX / renderedH);
          }
          // Also reset vertical position to terrain surface so it's no longer floating
          group.position.y = currentTerrainY.current + 2;
        }
        rescaleAppliedRef.current = true;
      }
    }

    if (useNewSystem && charAnimator) {
      // Universal character animation system — handles all secondary motion internally
      charAnimator.update(animGroup, clock.elapsedTime, dt, isMoving);
    } else if (lobsterAnimator) {
      // Legacy lobster skeletal animation
      const suggestedState = resolveAnimState({
        isDead: d.isDead,
        inCombat: false,
        combatAction: null,
        direction: d.direction,
        inConversation: false,
      });
      lobsterAnimator.update(dt, clock.elapsedTime, suggestedState, d.direction);

      // Procedural group-level squash/stretch/tilt
      const animStateData = {
        group: animGroup,
        isMoving,
        elapsed: clock.elapsedTime,
        delta: dt,
        direction: d.direction,
        seed,
      };
      if (isMoving) {
        applyWalkAnimation(animStateData);
      } else {
        applyIdleAnimation(animStateData);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {/* Scaled model sub-group — per-species normalized scale */}
      <group scale={[npcScale, npcScale, npcScale]}>
        <group ref={animGroupRef}>
          <primitive object={cloned} />
        </group>
      </group>
      {/* Name label — OUTSIDE scaled group so position is in world units.
          100 = clearance above TARGET_NPC_HEIGHT=45 for the tallest species. */}
      <Html
        position={[0, 100, 0]}
        center
        distanceFactor={300}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'rgba(8, 20, 38, 0.78)',
            border: '1px solid rgba(100, 200, 255, 0.25)',
            borderRadius: 6,
            padding: '2px 8px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          <span
            style={{
              color: '#fff',
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.03em',
            }}
          >
            {npc.name}
          </span>
          {npc.isOpenClaw && (
            <span
              style={{
                background: 'rgba(16, 185, 129, 0.85)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 9,
                borderRadius: 4,
                padding: '1px 4px',
                letterSpacing: '0.04em',
              }}
            >
              OpenClaw
            </span>
          )}
        </div>
      </Html>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default function ArenaNpcs() {
  const npcs = useNpcStore((s) => s.npcs);

  return (
    <Suspense fallback={null}>
      <group>
        {npcs.map((npc) => (
          <GLBNpcMesh key={npc.id} npc={npc} />
        ))}
      </group>
    </Suspense>
  );
}
