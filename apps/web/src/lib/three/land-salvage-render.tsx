'use client';

/**
 * land-salvage-render.tsx — public in-world render layer for seabed salvage
 * nodes (Land gamification P7b render half, §2.2/§2.3/§2.5).
 *
 * Budget approach, deliberately simpler than `land-kit-pieces.tsx`'s
 * fixed-chunk / farthest-first admission system: that machinery exists
 * because PLAYER-PLACED kit pieces are unbounded (a yard can keep growing),
 * so the render layer needs a runtime admission decision. Salvage nodes are
 * NOT player-placed — the topology is a fixed, capped set of
 * `SALVAGE_NODE_COUNT` (48) world decorations, so the total cost is bounded
 * at BUILD TIME, not runtime:
 *   - 3 draw calls total (one merged mesh per look variant).
 *   - ~40-90 tris per node cluster x 48 nodes ≈ 2.5k-4k triangles total —
 *     roughly 1.5% of the kit layer's OWN 250,000-triangle ceiling, and a
 *     rounding error against the 60-draw-call kit budget.
 * Re-deriving a chunk/admission system for a fixed 3-draw-call, ~4k-triangle
 * addition would be complexity with no budget it is protecting. What DOES
 * carry over from the kit layer: owned-geometry disposal on unmount, no
 * InstancedMesh (matches this codebase's established "merged geometry, not
 * InstancedMesh" convention for static world decoration —
 * see merged-seaweed.tsx), matrixAutoUpdate discipline, and zero per-frame
 * allocations in the hot path (recoloring runs on a 3s wall-clock interval +
 * store-driven effect, never inside a useFrame/useSceneFrame callback).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SALVAGE_NODES, type SalvageNode } from '@clawville/shared';
import { api } from '@/lib/api';
import { LAND_SALVAGE_REFRESH_EVENT } from '@/lib/land-query-keys';
import { KIT_FLOOR_Y } from '@/lib/three/land-kit-assets';
import { salvageNodeLook, type SalvageNodeLook } from '@/lib/three/land-salvage-nodes';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { isSalvageNodeClaimable, useSalvageStore } from '@/stores/salvage';

const SALVAGE_NODE_LOOKS: readonly SalvageNodeLook[] = ['shells', 'driftwood', 'coral'];

/** Deterministic per-node facing so a look's cluster doesn't read copy-pasted. */
function salvageNodeYaw(nodeId: string): number {
  let h = 0;
  for (let i = 0; i < nodeId.length; i++) h = (h * 31 + nodeId.charCodeAt(i)) >>> 0;
  return ((h % 3600) / 3600) * Math.PI * 2;
}

// ---------------------------------------------------------------------------
// SalvageStateHydrator — headless, public-feed poll + explicit refresh event.
// Mirrors KitPieceHydrator's pattern (land-kit-pieces.tsx).
// ---------------------------------------------------------------------------

// Cooldowns are 6h-granular (§2.2), so a slow poll is correct — this exists
// to catch cross-avatar/cross-tab claims and cooldown expiry, not to be a
// live feed. The claim UI patches the store immediately on its own POST.
const SALVAGE_POLL_MS = 45_000;

export function SalvageStateHydrator() {
  const setState = useSalvageStore((state) => state.setState);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const hydrate = async (): Promise<void> => {
      const response = await api.getLandSalvageState().catch(() => null);
      if (cancelled) return;
      if (response) {
        setState({
          nodes: response.nodes,
          materialBalance: response.materialBalance,
          claimsUsedToday: response.claimsUsedToday,
          claimsRemainingToday: response.claimsRemainingToday,
          ownerClaimsUsedToday: response.ownerClaimsUsedToday,
          ownerClaimsRemainingToday: response.ownerClaimsRemainingToday,
          lastClaim: response.lastClaim,
          rules: response.rules,
        });
      }
      if (!cancelled) {
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => void hydrate(), SALVAGE_POLL_MS);
      }
    };

    const refreshNow = () => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      void hydrate();
    };

    void hydrate();
    window.addEventListener(LAND_SALVAGE_REFRESH_EVENT, refreshNow);
    return () => {
      cancelled = true;
      window.removeEventListener(LAND_SALVAGE_REFRESH_EVENT, refreshNow);
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [setState]);

  return null;
}

// ---------------------------------------------------------------------------
// Procedural low-poly cluster geometry — one local-space shape per look.
// Built once at module scope (pure geometry, no THREE.Scene dependency), so
// it costs nothing beyond the one-time construction in `buildLookGeometry`.
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

/** Deterministic per-node jitter without a shared RNG cursor (order-independent). */
function nodeJitter(nodeId: string, salt: number): number {
  let h = salt;
  for (let i = 0; i < nodeId.length; i++) h = (h * 31 + nodeId.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function buildShellsCluster(nodeId: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const shellCount = 4;
  for (let i = 0; i < shellCount; i++) {
    const jitter = nodeJitter(nodeId, i * 17 + 3);
    const radius = 6 + jitter * 6;
    const geometry = new THREE.SphereGeometry(radius, 6, 4, 0, Math.PI * 2, 0, Math.PI * 0.6);
    geometry.scale(1, 0.55, 1);
    const angle = (i / shellCount) * Math.PI * 2 + jitter * 1.2;
    const dist = 6 + jitter * 10;
    geometry.translate(Math.cos(angle) * dist, radius * 0.4, Math.sin(angle) * dist);
    // toNonIndexed() returns a COPY — the indexed source is never used again
    // and must be disposed itself, not just the copy pushed to `parts`.
    const nonIndexed = geometry.toNonIndexed();
    geometry.dispose();
    parts.push(nonIndexed);
  }
  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  return merged;
}

function buildDriftwoodCluster(nodeId: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const logCount = 2;
  for (let i = 0; i < logCount; i++) {
    const jitter = nodeJitter(nodeId, i * 23 + 7);
    const length = 46 + jitter * 30;
    const radius = 4.2 + jitter * 2;
    const geometry = new THREE.CylinderGeometry(radius * 0.7, radius, length, 5, 1);
    geometry.rotateZ(Math.PI / 2);
    geometry.rotateY(i * 0.9 + jitter * 1.4);
    geometry.translate(0, radius, (jitter - 0.5) * 10);
    const nonIndexed = geometry.toNonIndexed();
    geometry.dispose();
    parts.push(nonIndexed);
  }
  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  return merged;
}

function buildCoralCluster(nodeId: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const fingerCount = 5;
  for (let i = 0; i < fingerCount; i++) {
    const jitter = nodeJitter(nodeId, i * 13 + 11);
    const height = 20 + jitter * 26;
    const radius = 4 + jitter * 3;
    const geometry = new THREE.ConeGeometry(radius, height, 5);
    const angle = (i / fingerCount) * Math.PI * 2;
    const lean = 0.18 + jitter * 0.22;
    geometry.rotateZ(Math.cos(angle) * lean);
    geometry.rotateX(Math.sin(angle) * lean);
    geometry.translate(Math.cos(angle) * 5, height / 2, Math.sin(angle) * 5);
    const nonIndexed = geometry.toNonIndexed();
    geometry.dispose();
    parts.push(nonIndexed);
  }
  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  return merged;
}

function buildClusterLocalGeometry(look: SalvageNodeLook, nodeId: string): THREE.BufferGeometry {
  if (look === 'shells') return buildShellsCluster(nodeId);
  if (look === 'driftwood') return buildDriftwoodCluster(nodeId);
  return buildCoralCluster(nodeId);
}

const LOOK_TINTS: Readonly<Record<SalvageNodeLook, { available: THREE.Color; cooldown: THREE.Color }>> = {
  shells: { available: new THREE.Color(0xfff1c7), cooldown: new THREE.Color(0x4d5561) },
  driftwood: { available: new THREE.Color(0xd8a468), cooldown: new THREE.Color(0x453f34) },
  coral: { available: new THREE.Color(0xff7f66), cooldown: new THREE.Color(0x4a4550) },
};

interface NodeVertexRange {
  nodeId: string;
  start: number;
  count: number;
}

interface LookGeometryResult {
  geometry: THREE.BufferGeometry;
  ranges: NodeVertexRange[];
}

function buildLookGeometry(look: SalvageNodeLook, nodes: readonly SalvageNode[]): LookGeometryResult {
  const parts: THREE.BufferGeometry[] = [];
  const ranges: NodeVertexRange[] = [];
  let cursor = 0;
  const placementMatrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);

  for (const node of nodes) {
    const cluster = buildClusterLocalGeometry(look, node.id);
    position.set(node.x, KIT_FLOOR_Y, node.z);
    rotation.setFromAxisAngle(UP, salvageNodeYaw(node.id));
    placementMatrix.compose(position, rotation, scale);
    cluster.applyMatrix4(placementMatrix);

    const vertexCount = cluster.getAttribute('position')!.count;
    ranges.push({ nodeId: node.id, start: cursor, count: vertexCount });
    cursor += vertexCount;
    parts.push(cluster);
  }

  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();

  const colorArray = new Float32Array(cursor * 3);
  const tint = LOOK_TINTS[look].available;
  for (let i = 0; i < cursor; i++) {
    colorArray[i * 3] = tint.r;
    colorArray[i * 3 + 1] = tint.g;
    colorArray[i * 3 + 2] = tint.b;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  return { geometry: merged, ranges };
}

// ---------------------------------------------------------------------------
// One merged mesh per look — recolors in place when claim state changes.
// ---------------------------------------------------------------------------

function SalvageLookMesh({ look }: { look: SalvageNodeLook }) {
  const nodesForLook = useMemo(
    () => SALVAGE_NODES.filter((node) => salvageNodeLook(node.band) === look),
    [look],
  );

  const built = useMemo(() => buildLookGeometry(look, nodesForLook), [look, nodesForLook]);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0.05,
      }),
    [],
  );

  const meshRef = useRef<THREE.Mesh>(null);
  /** Last-painted claimable boolean per node, avoids rewriting unchanged vertices. */
  const paintedRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    const colorAttr = built.geometry.getAttribute('color') as THREE.BufferAttribute;
    const tints = LOOK_TINTS[look];

    const repaint = () => {
      const cooldowns = useSalvageStore.getState().nodeCooldowns;
      let dirty = false;
      for (const range of built.ranges) {
        const claimable = isSalvageNodeClaimable(cooldowns, range.nodeId);
        if (paintedRef.current.get(range.nodeId) === claimable) continue;
        paintedRef.current.set(range.nodeId, claimable);
        const tint = claimable ? tints.available : tints.cooldown;
        for (let i = range.start; i < range.start + range.count; i++) {
          colorAttr.setXYZ(i, tint.r, tint.g, tint.b);
        }
        dirty = true;
      }
      if (dirty) colorAttr.needsUpdate = true;
    };

    repaint();
    // Store-driven repaint (a claim or a fresh poll landed) plus a slow
    // wall-clock tick so a cooldown that naturally elapses while the player
    // is standing nearby flips color without requiring a new network response.
    const unsubscribe = useSalvageStore.subscribe(repaint);
    const interval = setInterval(repaint, 3000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [built, look]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Geometry already carries the world-space transform per vertex (baked in
    // buildLookGeometry) — the mesh itself stays at identity, so one explicit
    // updateMatrix() is enough under matrixAutoUpdate={false}.
    mesh.updateMatrix();
    makeObject3DWebGPUSafe(mesh);
  }, []);

  useEffect(
    () => () => {
      built.geometry.dispose();
      material.dispose();
    },
    [built, material],
  );

  return (
    <mesh
      ref={meshRef}
      name={`land-salvage:${look}`}
      geometry={built.geometry}
      material={material}
      matrixAutoUpdate={false}
      frustumCulled
    />
  );
}

export default function LandSalvageNodesLayer() {
  return (
    <>
      <SalvageStateHydrator />
      {SALVAGE_NODE_LOOKS.map((look) => (
        <SalvageLookMesh key={look} look={look} />
      ))}
    </>
  );
}
