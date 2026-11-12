'use client';

import { useRef } from 'react';
import * as THREE from 'three';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { avatarPositionRef } from '@/stores/game';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { canWalkIntoBrainchainOffice, openBrainchainOffice } from './brainchain-office-transition';
import { OFFICE_VORTEX_MODEL, stepOfficeDoorEdge, consumeOfficeLocomotion, type OfficeDoorEdge } from './brainchain-office-door';

// One opaque centre masks the static spiral. Only the last 2% fades out.
// The pink arms fade into that dark base, rather than revealing a second spiral.
function createSpiralTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const pixels = context.createImageData(512, 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const dx = (x - 255.5) / 255.5, dy = (y - 255.5) / 255.5;
    const r = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
    const arm = Math.pow(Math.max(0, Math.cos(5 * (angle + 2.8 * Math.log(Math.max(r, 0.025))))), 7);
    const glow = arm * Math.min(1, r * 10) * (1 - Math.max(0, r - 0.85) / 0.15);
    const i = (y * 512 + x) * 4;
    pixels.data[i] = 13 + 230 * glow; pixels.data[i + 1] = 7 + 127 * glow;
    pixels.data[i + 2] = 17 + 144 * glow;
    pixels.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, (1 - r) / 0.02)));
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
// Built on first render, not at import: test environments (happy-dom) have no
// 2D canvas context, and importing this file must never touch the DOM.
let geometry: THREE.CircleGeometry | null = null;
let material: THREE.MeshBasicMaterial | null = null;
function vortexResources(): { geometry: THREE.CircleGeometry; material: THREE.MeshBasicMaterial } {
  if (!geometry) geometry = new THREE.CircleGeometry(OFFICE_VORTEX_MODEL.radius, 64);
  if (!material) material = new THREE.MeshBasicMaterial({ map: createSpiralTexture(), transparent: true,
    depthWrite: false, blending: THREE.NormalBlending, toneMapped: false });
  return { geometry, material };
}

/** Lives under the same pivot, yaw, visibility and stream attachment as the GLB. */
export function BrainchainOfficeVortex({ scale, attached }: { scale: number; attached: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const edge = useRef<OfficeDoorEdge>({ initialized: false, inside: false, allowed: false, x: 0, z: 0 });
  useSceneFrame((_, delta) => {
    let visible = attached;
    for (let object: THREE.Object3D | null = mesh.current; object; object = object.parent) {
      if (!object.visible) { visible = false; break; }
    }
    if (visible && mesh.current) mesh.current.rotation.z -= delta * 0.7;
    const x = avatarPositionRef.x - MAP_WIDTH / 2, z = avatarPositionRef.y - MAP_HEIGHT / 2;
    const walked = consumeOfficeLocomotion(edge.current.x, edge.current.z, x, z);
    if (stepOfficeDoorEdge(edge.current, x, z, visible && canWalkIntoBrainchainOffice(), walked)) {
      openBrainchainOffice('walk-in');
    }
  });
  const resources = vortexResources();
  return <mesh ref={mesh} geometry={resources.geometry} material={resources.material} dispose={null}
    position={[OFFICE_VORTEX_MODEL.x * scale, OFFICE_VORTEX_MODEL.y * scale, OFFICE_VORTEX_MODEL.z * scale]}
    scale={scale} />;
}
