'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { color, float, sin, time } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KELP_FOREST_PORTAL_WORLD_CENTER } from './kelp-forest-location';

interface PortalUniform {
  value: number;
}

interface PortalResources {
  archGeometry: THREE.BufferGeometry;
  discGeometry: THREE.BufferGeometry;
  archMaterial: THREE.Material;
  discMaterial: THREE.Material;
  webGlTimeUniform: PortalUniform | null;
}

function createArchGeometry(): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  let merged: THREE.BufferGeometry | null = null;
  try {
    const left = new THREE.CylinderGeometry(30, 42, 360, 10, 3, false);
    const leftPosition = left.getAttribute('position');
    for (let index = 0; index < leftPosition.count; index++) {
      const normalizedHeight = Math.min(1, Math.max(0, (leftPosition.getY(index) + 180) / 360));
      leftPosition.setX(index, leftPosition.getX(index) + normalizedHeight * 18);
      leftPosition.setZ(index, leftPosition.getZ(index) + Math.sin(normalizedHeight * Math.PI) * 10);
    }
    left.computeVertexNormals();
    left.translate(-132, 180, 0);
    pieces.push(left);

    const right = new THREE.CylinderGeometry(30, 42, 360, 10, 3, false);
    const rightPosition = right.getAttribute('position');
    for (let index = 0; index < rightPosition.count; index++) {
      const normalizedHeight = Math.min(1, Math.max(0, (rightPosition.getY(index) + 180) / 360));
      rightPosition.setX(index, rightPosition.getX(index) - normalizedHeight * 18);
      rightPosition.setZ(index, rightPosition.getZ(index) - Math.sin(normalizedHeight * Math.PI) * 10);
    }
    right.computeVertexNormals();
    right.translate(132, 180, 0);
    pieces.push(right);

    const crown = new THREE.TorusGeometry(132, 30, 10, 36, Math.PI);
    crown.translate(0, 360, 0);
    pieces.push(crown);

    const leftFrond = new THREE.ConeGeometry(34, 150, 8, 2, false);
    leftFrond.rotateZ(-0.42);
    leftFrond.translate(-92, 390, -6);
    pieces.push(leftFrond);

    const rightFrond = new THREE.ConeGeometry(34, 150, 8, 2, false);
    rightFrond.rotateZ(0.42);
    rightFrond.translate(92, 390, -6);
    pieces.push(rightFrond);

    merged = mergeGeometries(pieces, false);
    if (!merged) throw new Error('Kelp Forest portal arch geometry could not be merged');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  } catch (error) {
    merged?.dispose();
    throw error;
  } finally {
    for (const piece of pieces) piece.dispose();
  }
}

function createDiscGeometry(): THREE.BufferGeometry {
  const segmentCount = 96;
  const positions = new Float32Array((segmentCount + 1) * 2 * 3);
  const indices = new Uint16Array(segmentCount * 6);
  let positionOffset = 0;
  let indexOffset = 0;

  for (let segment = 0; segment <= segmentCount; segment++) {
    const progress = segment / segmentCount;
    const angle = progress * Math.PI * 4.5;
    const radius = 18 + progress * 94;
    const halfWidth = 10 - progress * 4;
    const centerX = Math.cos(angle) * radius;
    const centerY = Math.sin(angle) * radius;
    const normalX = -Math.sin(angle);
    const normalY = Math.cos(angle);

    positions[positionOffset++] = centerX + normalX * halfWidth;
    positions[positionOffset++] = centerY + normalY * halfWidth;
    positions[positionOffset++] = 0;
    positions[positionOffset++] = centerX - normalX * halfWidth;
    positions[positionOffset++] = centerY - normalY * halfWidth;
    positions[positionOffset++] = 0;

    if (segment < segmentCount) {
      const base = segment * 2;
      indices[indexOffset++] = base;
      indices[indexOffset++] = base + 1;
      indices[indexOffset++] = base + 2;
      indices[indexOffset++] = base + 1;
      indices[indexOffset++] = base + 3;
      indices[indexOffset++] = base + 2;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function patchPortalPulse(
  material: THREE.MeshStandardMaterial,
  uniform: PortalUniform,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uKelpPortalTime = uniform;
    shader.fragmentShader = `uniform float uKelpPortalTime;\n${shader.fragmentShader}`;
    const anchor = '#include <emissivemap_fragment>';
    if (!shader.fragmentShader.includes(anchor)) {
      throw new Error('Kelp Forest portal emissive shader anchor missing');
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      anchor,
      `${anchor}\n  totalEmissiveRadiance *= (1.5 + 0.5 * sin(uKelpPortalTime * 1.8));`,
    );
  };
  material.customProgramCacheKey = () => 'kelp-portal-pulse-v1';
}

function createWebGpuMaterial(transparent: boolean): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    color: transparent ? 0x0b5d58 : 0x073f38,
    emissive: 0x24ffe0,
    emissiveIntensity: 1,
    roughness: 0.52,
    metalness: 0.08,
    transparent,
    opacity: transparent ? 0.48 : 1,
    depthWrite: !transparent,
    side: transparent ? THREE.DoubleSide : THREE.FrontSide,
    blending: transparent ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const pulse = sin(time.mul(float(1.8))).mul(float(0.5)).add(float(1.5));
  material.emissiveNode = color(0x24ffe0).mul(pulse);
  return material;
}

function createWebGlMaterial(
  transparent: boolean,
  uniform: PortalUniform,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: transparent ? 0x0b5d58 : 0x073f38,
    emissive: 0x24ffe0,
    emissiveIntensity: 1,
    roughness: 0.52,
    metalness: 0.08,
    transparent,
    opacity: transparent ? 0.48 : 1,
    depthWrite: !transparent,
    side: transparent ? THREE.DoubleSide : THREE.FrontSide,
    blending: transparent ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  patchPortalPulse(material, uniform);
  // WebGPURenderer(forceWebGL) converts this plain material to its node peer
  // and skips classic onBeforeCompile. Carry the same emissive node through
  // that conversion while retaining the requested uniform GLSL hook above.
  const pulse = sin(time.mul(float(1.8))).mul(float(0.5)).add(float(1.5));
  (
    material as THREE.MeshStandardMaterial & { emissiveNode: THREE.Node | null }
  ).emissiveNode = color(0x24ffe0).mul(pulse);
  return material;
}

function createPortalResources(forceWebGL: boolean): PortalResources {
  const archGeometry = createArchGeometry();
  const discGeometry = createDiscGeometry();
  const webGlTimeUniform = forceWebGL ? { value: 0 } : null;
  try {
    const archMaterial = forceWebGL
      ? createWebGlMaterial(false, webGlTimeUniform!)
      : createWebGpuMaterial(false);
    try {
      const discMaterial = forceWebGL
        ? createWebGlMaterial(true, webGlTimeUniform!)
        : createWebGpuMaterial(true);
      return {
        archGeometry,
        discGeometry,
        archMaterial,
        discMaterial,
        webGlTimeUniform,
      };
    } catch (error) {
      archMaterial.dispose();
      throw error;
    }
  } catch (error) {
    archGeometry.dispose();
    discGeometry.dispose();
    throw error;
  }
}

export function KelpForestPortal({ forceWebGL }: { forceWebGL: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const archRef = useRef<THREE.Mesh>(null);
  const discRef = useRef<THREE.Mesh>(null);
  const resources = useMemo(() => createPortalResources(forceWebGL), [forceWebGL]);

  useEffect(() => () => {
    resources.archGeometry.dispose();
    resources.discGeometry.dispose();
    resources.archMaterial.dispose();
    resources.discMaterial.dispose();
  }, [resources]);

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.matrixAutoUpdate = false;
      groupRef.current.updateMatrix();
    }
    if (archRef.current) {
      archRef.current.matrixAutoUpdate = false;
      archRef.current.updateMatrix();
    }
  }, []);

  useFrame(({ clock }) => {
    if (resources.webGlTimeUniform) {
      resources.webGlTimeUniform.value = clock.elapsedTime;
    }
    if (discRef.current) discRef.current.rotation.z = clock.elapsedTime * 0.18;
  });

  return (
    <group ref={groupRef} position={[KELP_FOREST_PORTAL_WORLD_CENTER.x, -2, KELP_FOREST_PORTAL_WORLD_CENTER.z]}>
      <mesh ref={archRef} geometry={resources.archGeometry} material={resources.archMaterial} />
      <mesh
        ref={discRef}
        geometry={resources.discGeometry}
        material={resources.discMaterial}
        position={[0, 215, -8]}
      />
    </group>
  );
}
