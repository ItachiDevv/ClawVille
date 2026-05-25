// @ts-nocheck
'use client';

import * as THREE from 'three/webgpu';
import { BUILDING_TARGET_HEIGHT, type BuildingSpec } from './buildings-manifest';

const DECORATIVE_PARENT_NAMES = new Set(['Flowers', 'Path', 'Skybox', 'Road', 'Sand']);
const DECORATIVE_NAME_PREFIXES = ['Skybox_'] as const;
const BACKDROP_KILL_NAMES = new Set<string>(['Object_1']);
const BACKDROP_KILL_MATERIALS = new Set<string>([]);
const MAX_FOOTPRINT = 2000;

const _bbox = new THREE.Box3();
const _meshBox = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _bodyBbox = new THREE.Box3();
const _bodyCenter = new THREE.Vector3();

function stripDecorativeMeshes(scene: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    if (child.name) {
      for (const prefix of DECORATIVE_NAME_PREFIXES) {
        if (child.name.startsWith(prefix)) {
          toRemove.push(child);
          return;
        }
      }
    }
    if (child.name && BACKDROP_KILL_NAMES.has(child.name)) {
      toRemove.push(child);
      return;
    }
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (mat?.name && BACKDROP_KILL_MATERIALS.has(mat.name)) {
      toRemove.push(child);
      return;
    }

    let p: THREE.Object3D | null = child.parent;
    while (p) {
      if (p.name && DECORATIVE_PARENT_NAMES.has(p.name)) {
        toRemove.push(child);
        break;
      }
      p = p.parent;
    }
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}

function measureSceneBox(scene: THREE.Object3D): THREE.Box3 | null {
  scene.updateMatrixWorld(true);
  _bbox.makeEmpty();
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) return;
      _meshBox.copy(bb).applyMatrix4(mesh.matrixWorld);
      _bbox.union(_meshBox);
    }
  });
  return _bbox.isEmpty() ? null : _bbox.clone();
}

function stripGroundPlanes(scene: THREE.Object3D): void {
  const fullBox = measureSceneBox(scene);
  if (!fullBox) return;
  const fullMinY = fullBox.min.y;
  const fullHeight = fullBox.max.y - fullBox.min.y;
  if (fullHeight === 0) return;

  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;

    _meshBox.copy(bb).applyMatrix4(mesh.matrixWorld);
    const sy = _meshBox.max.y - _meshBox.min.y;
    const sx = _meshBox.max.x - _meshBox.min.x;
    const sz = _meshBox.max.z - _meshBox.min.z;
    const maxXZ = Math.max(sx, sz);

    const isFlat = maxXZ > 2 && sy / maxXZ < 0.005;
    const isAtBottom = _meshBox.max.y < fullMinY + fullHeight * 0.05;
    if (isFlat && isAtBottom) toRemove.push(mesh);
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}

function applyChildScaleOverrides(scene: THREE.Object3D, overrides?: Record<string, number>): void {
  if (!overrides) return;
  scene.traverse((child) => {
    const factor = overrides[child.name];
    if (factor != null && factor !== 1) child.scale.multiplyScalar(factor);
  });
}

function measureObjectBox(root: THREE.Object3D): THREE.Box3 | null {
  root.updateMatrixWorld(true);
  _bodyBbox.makeEmpty();
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) return;
      _meshBox.copy(bb).applyMatrix4(mesh.matrixWorld);
      _bodyBbox.union(_meshBox);
    }
  });
  return _bodyBbox.isEmpty() ? null : _bodyBbox.clone();
}

export function prepareMeshletBuildingScene(
  spec: BuildingSpec,
  root: THREE.Object3D,
): { worldMatrix: THREE.Matrix4; sceneBox: THREE.Box3 | null } {
  stripDecorativeMeshes(root);
  stripGroundPlanes(root);

  const sceneBox = measureSceneBox(root);
  if (!sceneBox) return { worldMatrix: new THREE.Matrix4(), sceneBox: null };

  sceneBox.getSize(_size);
  sceneBox.getCenter(_center);
  const targetMaxDim = spec.targetMaxDim ?? BUILDING_TARGET_HEIGHT;
  const maxDim = Math.max(_size.x, _size.y, _size.z);
  let scale = maxDim > 0.001 ? targetMaxDim / maxDim : 1;

  const scaledMaxXZ = Math.max(_size.x, _size.z) * scale;
  if (scaledMaxXZ > MAX_FOOTPRINT) {
    scale *= MAX_FOOTPRINT / scaledMaxXZ;
  }

  const fullCenterX = _center.x;
  const fullCenterZ = _center.z;
  let pivotOffsetX = fullCenterX * scale;
  const pivotOffsetY = sceneBox.min.y * scale;
  let pivotOffsetZ = fullCenterZ * scale;

  if (spec.childScaleOverrides) {
    root.updateMatrixWorld(true);
    applyChildScaleOverrides(root, spec.childScaleOverrides);
    root.updateMatrixWorld(true);
  }

  if (spec.bodyAnchorChild) {
    const bodyChild = root.getObjectByName(spec.bodyAnchorChild);
    const bodyBox = bodyChild ? measureObjectBox(bodyChild) : null;
    if (bodyBox) {
      bodyBox.getCenter(_bodyCenter);
      pivotOffsetX += (_bodyCenter.x - fullCenterX) * scale;
      pivotOffsetZ += (_bodyCenter.z - fullCenterZ) * scale;
    } else if (typeof window !== 'undefined') {
      console.warn(`[meshlet-body-anchor] ${spec.id}: bodyAnchorChild "${spec.bodyAnchorChild}" not found`);
    }
  }

  const outer = new THREE.Matrix4()
    .makeTranslation(spec.posX, -2 + (spec.yOffset ?? 0), spec.posZ)
    .multiply(new THREE.Matrix4().makeRotationY((spec.rotY ?? 0) + (spec.rotYOffset ?? 0)));
  const inner = new THREE.Matrix4().makeTranslation(
    -pivotOffsetX,
    -pivotOffsetY,
    -pivotOffsetZ + (spec.pivotZBias ?? 0),
  );
  const uniformScale = new THREE.Matrix4().makeScale(scale, scale, scale);

  return {
    worldMatrix: outer.multiply(inner).multiply(uniformScale),
    sceneBox,
  };
}
