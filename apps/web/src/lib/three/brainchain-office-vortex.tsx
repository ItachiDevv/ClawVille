'use client';

import { useRef } from 'react';
import * as THREE from 'three';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { avatarPositionRef } from '@/stores/game';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { canWalkIntoBrainchainOffice, openBrainchainOffice } from './brainchain-office-transition';
import { OFFICE_VORTEX_MODEL, stepOfficeDoorEdge, consumeOfficeLocomotion, type OfficeDoorEdge } from './brainchain-office-door';

import { vortexResources } from './brainchain-vortex-resources';

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
