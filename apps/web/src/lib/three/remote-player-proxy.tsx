'use client';

import { useRef, useMemo, useEffect, memo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
import type { RemotePlayerState } from '@/stores/players';
import type { NpcSpriteState } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

/**
 * Module-scope shared geometry — every proxy mesh instance points at the same
 * THREE.CapsuleGeometry. Capsule radius 25 + length 120 + 8 radial segments +
 * 4 cap segments → roughly 200 verts, mirrors a humanoid silhouette tightly
 * enough to read as "a player" at the distance where the LOD orchestrator
 * demotes them (typically > 4000 wu).
 *
 * Iris Xe hard rule: ONE CapsuleGeometry across N proxies. Per-instance
 * materials are cloned (color varies); never per-instance geometry.
 */
const _proxyCapsuleGeometry = new THREE.CapsuleGeometry(25, 120, 4, 8);

/** Shared scratch for terrain raycast — module-scope, never inside useFrame. */
const _proxyRaycaster = new THREE.Raycaster();
_proxyRaycaster.layers.set(TERRAIN_LAYER);
const _proxyRayOrigin = new THREE.Vector3();
const _proxyRayDir = new THREE.Vector3(0, -1, 0);

let _proxyCachedTerrain: THREE.Object3D | null = null;
function findTerrain(scene: THREE.Scene): THREE.Object3D | null {
  if (_proxyCachedTerrain && _proxyCachedTerrain.parent) return _proxyCachedTerrain;
  _proxyCachedTerrain = null;
  scene.traverse((obj) => {
    if (_proxyCachedTerrain) return;
    if ((obj as THREE.Mesh).isMesh && obj.layers.test(_proxyRaycaster.layers)) {
      _proxyCachedTerrain = obj;
    }
  });
  return _proxyCachedTerrain;
}

function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  const terrain = findTerrain(scene);
  if (!terrain) return -2;
  _proxyRayOrigin.set(x, 200, z);
  _proxyRaycaster.set(_proxyRayOrigin, _proxyRayDir);
  _proxyRaycaster.layers.set(TERRAIN_LAYER);
  _proxyRaycaster.far = 400;
  const hits = _proxyRaycaster.intersectObject(terrain, false);
  if (hits.length > 0) return hits[0].point.y;
  return -2;
}

/**
 * Minimum contract the proxy mesh needs from any entity (NPC or remote player).
 * Matches the position fields of NpcSpriteState and RemotePlayerState so both
 * can be passed in without an adapter.
 */
interface EntityProxyInput {
  id: string;
  name: string;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  ts: number;
  tsDelta: number;
  color: number;
}

function hashSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h) + id.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) % 6;
}

interface EntityProxyMeshProps {
  entity: EntityProxyInput;
}

/**
 * Cheap stand-in for a full VRM/GLB beyond the LOD-cap distance. Mounted by
 * `remote-players.tsx` (for remote players) and `arena-npcs.tsx` (for
 * wandering NPCs not in the top-14 full-render tier).
 *
 * Costs ~3 draws + ~1 KB GPU memory vs ~150 KB + 4 draws + skinned animation
 * + spring physics for the full VRM.
 *
 * What it does:
 *   - One CapsuleGeometry (module-scope shared) tinted by `entity.color`.
 *   - Entity-interpolated position (same alpha math as VRMNpcMesh / GLBNpcMesh).
 *   - Throttled terrain raycast (every 6th frame, seed-staggered).
 *   - WorldLabel with `entity.name` via the existing bio-luminescent rig.
 *
 * What it does NOT do:
 *   - ZERO AnimationMixer, ZERO spring bones, ZERO VRM scene parse.
 *   - No facing rotation — capsule is rotation-symmetric on Y; saving the
 *     atan2 / slerp work per frame.
 *   - No bob — Iris Xe budget is the constraint, not visual richness.
 *
 * Frustum culling ON (Three.js default) — the renderer only pays mesh
 * upload when the bounding sphere is on-screen.
 */
export const EntityProxyMesh = memo(function EntityProxyMesh({ entity }: EntityProxyMeshProps) {
  const groupRef = useRef<THREE.Group>(null!);
  const meshRef = useRef<THREE.Mesh>(null!);
  const { scene: threeScene } = useThree();

  const entityRef = useRef(entity);
  entityRef.current = entity;

  // Per-instance material clone. MeshBasicMaterial is the cheapest path on
  // Iris Xe — no lighting math, no normal sampling. Color from entity hex;
  // transparent off (alpha-blending costs an extra fragment pass on tiled
  // GPUs).
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: new THREE.Color(entity.color),
      toneMapped: false,
    }),
    [entity.color],
  );

  useEffect(() => () => material.dispose(), [material]);

  const currentTerrainY = useRef(0);
  const seed = useMemo(() => hashSeed(entity.id), [entity.id]);

  const { divRef: labelRef } = useWorldLabel({
    id: `proxy-label-${entity.id}`,
    anchorRef: groupRef,
    // Capsule top sits at y ≈ 145 above pivot. Add 60 wu of clearance so the
    // bio capsule sits above the head without overlap.
    offset: [0, 200, 0],
    initialVisible: true,
    fadeNear: 15000,
    fadeFar: 25000,
    fadeBaseOpacity: 0.85,
    occlude: true,
  });

  useFrame(({ clock }) => {
    const e = entityRef.current;
    const group = groupRef.current;
    if (!group) return;

    // Entity interpolation — render 1 tick behind real-time.
    const nowMs = Date.now();
    const tsDelta = e.tsDelta > 0 ? e.tsDelta : 200;
    const elapsed = nowMs - e.ts;
    const alpha = e.ts === 0 ? 1 : Math.max(0, Math.min(1, elapsed / tsDelta));
    const renderX = (e.prevX + (e.x - e.prevX) * alpha) - HALF_W;
    const renderZ = (e.prevY + (e.y - e.prevY) * alpha) - HALF_H;

    group.position.x = renderX;
    group.position.z = renderZ;

    // Throttled terrain sample — proxies are by definition far enough away
    // that a 10 Hz update is imperceptible. seed staggers writes so 14
    // proxies don't all raycast on the same frame.
    const frame = Math.floor(clock.elapsedTime * 60);
    if ((frame + seed) % 6 === 0) {
      const ty = getTerrainY(renderX, renderZ, threeScene);
      currentTerrainY.current += (ty - currentTerrainY.current) * 0.3;
    }
    group.position.y = currentTerrainY.current;
  });

  return (
    <group ref={groupRef}>
      {/* Capsule mesh — local offset +85 raises the center so the bottom cap
          (at y = -85 in local space) lands at the group origin = ground. */}
      <mesh
        ref={meshRef}
        geometry={_proxyCapsuleGeometry}
        material={material}
        position={[0, 85, 0]}
        frustumCulled
      />
      {/* Bio-luminescent label — reuse the WorldLabel rig from arena-npcs.tsx.
          Same DOM structure so visual language is consistent across full VRM
          and proxy avatars; only the underlying geometry differs. */}
      <WorldLabel divRef={labelRef}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            transform: 'translateY(-50%)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
              fontVariationSettings: '"opsz" 9',
              fontWeight: 480,
              fontSize: 13,
              color: '#effeff',
              padding: '5px 11px 6px',
              borderRadius: 999,
              background: 'rgba(8, 18, 32, 0.85)',
              border: '1px solid rgba(120, 220, 255, 0.45)',
              boxShadow:
                '0 0 14px rgba(100,230,255,0.45), 0 0 38px -4px rgba(80,220,255,0.35), inset 0 0 10px rgba(120,200,240,0.18)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.01em',
              lineHeight: 1,
              userSelect: 'none',
            }}
          >
            {entity.name}
          </div>
          <div
            style={{
              width: 1,
              height: 32,
              backgroundImage:
                'linear-gradient(rgba(140,240,255,0.78) 50%, transparent 50%)',
              backgroundSize: '1px 6px',
              backgroundRepeat: 'repeat-y',
              boxShadow: '0 0 6px rgba(120,240,255,0.55)',
              marginBottom: 2,
            }}
          />
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'rgba(160,234,255,1)',
            }}
          />
        </div>
      </WorldLabel>
    </group>
  );
});

/**
 * Thin wrapper for remote players — mounted by `remote-players.tsx` when the
 * LOD orchestrator demotes a player to proxy. Reads the same `RemotePlayerState`
 * fields the full mesh reads, dropped through `EntityProxyMesh` unchanged.
 */
export const RemotePlayerProxy = memo(function RemotePlayerProxy({
  player,
}: {
  player: RemotePlayerState;
}) {
  // RemotePlayerState.id is the opaque presence id (same key the full mesh +
  // LOD set use). Forward via the shared shape (no allocation needed beyond
  // the props object since EntityProxyMesh reads everything off
  // entity.{x,y,...} the same way).
  return (
    <EntityProxyMesh
      entity={{
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        prevX: player.prevX,
        prevY: player.prevY,
        ts: player.ts,
        tsDelta: player.tsDelta,
        color: player.color,
      }}
    />
  );
});

/**
 * Thin wrapper for wandering NPCs — mounted by `arena-npcs.tsx` when the LOD
 * orchestrator demotes an NPC out of the top-14 full tier. Same proxy mesh as
 * remote players; NPCs and players are visually indistinguishable at proxy
 * range (which is the point — both are humanoid silhouettes at > 4 km).
 */
export const NpcProxy = memo(function NpcProxy({ npc }: { npc: NpcSpriteState }) {
  return (
    <EntityProxyMesh
      entity={{
        id: npc.id,
        name: npc.name,
        x: npc.x,
        y: npc.y,
        prevX: npc.prevX,
        prevY: npc.prevY,
        ts: npc.ts,
        tsDelta: npc.tsDelta,
        color: npc.color,
      }}
    />
  );
});
