import * as THREE from 'three';
import type { LobsterRefs } from './lobster-animations';

// ---------------------------------------------------------------------------
// Spatial heuristic discovery of lobster body parts from a cloned GLB scene.
// Returns a LobsterRefs object; any part not found is null.
// The LobsterAnimator handles nulls gracefully.
// ---------------------------------------------------------------------------

interface MeshInfo {
  mesh: THREE.Mesh;
  box: THREE.Box3;
  size: THREE.Vector3;
  center: THREE.Vector3;
  volume: number;
}

function gatherMeshes(root: THREE.Object3D): MeshInfo[] {
  const infos: MeshInfo[] = [];
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;

    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const volume = size.x * size.y * size.z;

    if (volume > 0) {
      infos.push({ mesh, box, size, center, volume });
    }
  });
  return infos;
}

/**
 * Discover lobster body parts from a cloned lobster-ktx.glb scene using
 * spatial heuristics (bounding box positions relative to model center).
 */
export function discoverLobsterParts(root: THREE.Object3D): LobsterRefs {
  const meshes = gatherMeshes(root);
  if (meshes.length === 0) {
    return emptyRefs();
  }

  // Compute overall model bounds
  const modelBox = new THREE.Box3().setFromObject(root);
  const modelCenter = new THREE.Vector3();
  modelBox.getCenter(modelCenter);
  const modelSize = new THREE.Vector3();
  modelBox.getSize(modelSize);

  // Sort by volume descending for body detection
  const byVolume = [...meshes].sort((a, b) => b.volume - a.volume);

  // --- Body: largest mesh ---
  const body = byVolume[0]?.mesh ?? null;
  const bodyCenter = byVolume[0]?.center ?? modelCenter;

  // Classify remaining meshes by position relative to body center
  const remaining = meshes.filter((m) => m.mesh !== body);

  // Partition by position
  const leftSide: MeshInfo[] = [];   // x < bodyCenter.x
  const rightSide: MeshInfo[] = [];  // x > bodyCenter.x
  const aboveBody: MeshInfo[] = [];  // y significantly above body center
  const behindBody: MeshInfo[] = []; // z behind body (toward tail)
  const frontBody: MeshInfo[] = [];  // z in front (toward head)

  // Determine model orientation: lobster-ktx.glb typically faces -Z or +Z
  // We use the model's own extent to define thresholds
  const xThreshold = modelSize.x * 0.05; // near center-line
  const yUpperThreshold = bodyCenter.y + modelSize.y * 0.15;
  const zMidpoint = bodyCenter.z;

  for (const m of remaining) {
    const dx = m.center.x - bodyCenter.x;
    const isLeft = dx < -xThreshold;
    const isRight = dx > xThreshold;
    const isAbove = m.center.y > yUpperThreshold;
    const isBehind = m.center.z > zMidpoint; // +Z = tail side heuristic (for part classification only — model RENDERS facing +Z at rotation.y=0)
    const isFront = m.center.z < zMidpoint;

    if (isLeft) leftSide.push(m);
    if (isRight) rightSide.push(m);
    if (isAbove) aboveBody.push(m);
    if (isBehind) behindBody.push(m);
    if (isFront) frontBody.push(m);
  }

  // --- Claws: largest mesh on each side, in the front half ---
  const leftFrontByVol = leftSide
    .filter((m) => m.center.z <= zMidpoint + modelSize.z * 0.1)
    .sort((a, b) => b.volume - a.volume);
  const rightFrontByVol = rightSide
    .filter((m) => m.center.z <= zMidpoint + modelSize.z * 0.1)
    .sort((a, b) => b.volume - a.volume);

  const leftClawMesh = leftFrontByVol[0]?.mesh ?? null;
  const rightClawMesh = rightFrontByVol[0]?.mesh ?? null;

  // Wrap claws in groups for rotation pivot
  let leftClaw: THREE.Group | null = null;
  let rightClaw: THREE.Group | null = null;
  if (leftClawMesh) {
    leftClaw = wrapInGroup(leftClawMesh);
  }
  if (rightClawMesh) {
    rightClaw = wrapInGroup(rightClawMesh);
  }

  // Track assigned meshes to avoid double-assignment
  const assigned = new Set<THREE.Mesh>();
  if (body) assigned.add(body);
  if (leftClawMesh) assigned.add(leftClawMesh);
  if (rightClawMesh) assigned.add(rightClawMesh);

  // --- Tail segments: meshes behind body, sorted back-to-front ---
  const tailCandidates = behindBody
    .filter((m) => !assigned.has(m.mesh))
    .sort((a, b) => b.center.z - a.center.z); // furthest back first

  const tailSegments: (THREE.Mesh | null)[] = [];
  let tailFan: THREE.Mesh | null = null;

  if (tailCandidates.length > 0) {
    // The widest tail piece is the fan (typically the furthest back)
    const widestTail = [...tailCandidates].sort((a, b) => b.size.x - a.size.x);
    tailFan = widestTail[0]?.mesh ?? null;
    if (tailFan) assigned.add(tailFan);

    for (const tc of tailCandidates) {
      if (tc.mesh === tailFan) continue;
      if (tailSegments.length >= 4) break;
      tailSegments.push(tc.mesh);
      assigned.add(tc.mesh);
    }
  }

  // --- Eye stalks: small meshes above body, toward front ---
  const eyeCandidates = aboveBody
    .filter((m) => !assigned.has(m.mesh) && m.center.z <= zMidpoint)
    .sort((a, b) => a.volume - b.volume); // smallest first

  const eyeStalks: (THREE.Group | null)[] = [];
  for (const ec of eyeCandidates) {
    if (eyeStalks.length >= 2) break;
    const g = wrapInGroup(ec.mesh);
    eyeStalks.push(g);
    assigned.add(ec.mesh);
  }

  // --- Antennae: thin meshes extending from head area ---
  // Look for meshes that are elongated (one dimension >> others) near the front
  const antennaeCandidates = frontBody
    .filter((m) => {
      if (assigned.has(m.mesh)) return false;
      const dims = [m.size.x, m.size.y, m.size.z].sort((a, b) => b - a);
      const elongation = dims[0] / (dims[1] + 0.001);
      return elongation > 2; // at least 2x longer than wide
    })
    .sort((a, b) => a.volume - b.volume); // thinnest first

  const antennae: (THREE.Mesh | null)[] = [];
  for (const ac of antennaeCandidates) {
    if (antennae.length >= 2) break;
    antennae.push(ac.mesh);
    assigned.add(ac.mesh);
  }

  // --- Legs: small meshes arrayed along sides, not already assigned ---
  const legCandidates = remaining
    .filter((m) => {
      if (assigned.has(m.mesh)) return false;
      const dx = Math.abs(m.center.x - bodyCenter.x);
      return dx > xThreshold; // must be offset from center
    })
    .sort((a, b) => a.volume - b.volume); // smallest first (legs are small)

  const legs: (THREE.Mesh | null)[] = [];
  // Try to get 3 left + 3 right
  const leftLegs = legCandidates.filter((m) => m.center.x < bodyCenter.x).slice(0, 3);
  const rightLegs = legCandidates.filter((m) => m.center.x > bodyCenter.x).slice(0, 3);
  for (const ll of leftLegs) { legs.push(ll.mesh); assigned.add(ll.mesh); }
  for (const rl of rightLegs) { legs.push(rl.mesh); assigned.add(rl.mesh); }

  return {
    body,
    leftClaw,
    rightClaw,
    tailSegments,
    tailFan,
    legs,
    eyeStalks,
    antennae,
  };
}

function wrapInGroup(mesh: THREE.Mesh): THREE.Group {
  const parent = mesh.parent;
  if (parent instanceof THREE.Group && parent.children.length === 1) {
    return parent; // already a single-child group, reuse
  }
  const group = new THREE.Group();
  group.name = `${mesh.name}_pivot`;
  // Copy world position as group position, then zero out mesh local offset
  group.position.copy(mesh.position);
  group.quaternion.copy(mesh.quaternion);
  mesh.position.set(0, 0, 0);
  mesh.quaternion.identity();
  if (parent) {
    const idx = parent.children.indexOf(mesh);
    parent.children[idx] = group;
    group.parent = parent;
  }
  group.add(mesh);
  return group;
}

function emptyRefs(): LobsterRefs {
  return {
    body: null,
    leftClaw: null,
    rightClaw: null,
    tailSegments: [],
    tailFan: null,
    legs: [],
    eyeStalks: [],
    antennae: [],
  };
}
