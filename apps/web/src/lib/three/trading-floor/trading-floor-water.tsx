'use client';

import { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { float, positionGeometry, sin, time, uniform, vec3 } from 'three/tsl';
import { CURRENT_WORLD_DEVICE_PROFILE } from '../device-class';
import {
  TRADING_FLOOR_WATER_ALPHA,
  TRADING_FLOOR_WATER_BOUNDS,
  TRADING_FLOOR_WATER_RENDER_ORDER,
  TRADING_FLOOR_WATER_SHIMMER_ALPHA,
  TRADING_FLOOR_WATER_Y,
} from './trading-floor-water-layout';

function skipRaycast(): void {}

/** One front-facing plane, two triangles, one unlit node material. */
export function createTradingFloorWater(lowTier: boolean, motion = uniform(1)) {
  const geometry = new THREE.PlaneGeometry(
    TRADING_FLOOR_WATER_BOUNDS.halfX * 2,
    TRADING_FLOOR_WATER_BOUNDS.halfZ * 2,
  );
  const material = new THREE.MeshBasicNodeMaterial({
    color: '#4e8d7c',
    opacity: TRADING_FLOOR_WATER_ALPHA,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false,
    toneMapped: false,
  });

  if (!lowTier) {
    // Local XY becomes floor XZ after rotation. World-unit wavelengths keep
    // ripples the same size when the room grows. No vertex displacement.
    const x = positionGeometry.x;
    const z = positionGeometry.y;
    const w1 = sin(x.mul(0.027).add(z.mul(0.012)).add(time.mul(0.24))).mul(0.5).add(0.5);
    const w2 = sin(x.mul(0.014).sub(z.mul(0.031)).sub(time.mul(0.19))).mul(0.5).add(0.5);
    const w3 = sin(x.mul(0.009).add(z.mul(0.018)).add(time.mul(0.13))).mul(0.5).add(0.5);
    const shimmer = w1.mul(w2).mul(w3).pow(3).mul(motion);
    const tint = vec3(material.color.r, material.color.g, material.color.b);
    material.colorNode = tint.add(vec3(0.16, 0.22, 0.17).mul(shimmer));
    // At least 88% of the seal, gold seams and additive pools survives.
    material.opacityNode = float(TRADING_FLOOR_WATER_ALPHA)
      .add(shimmer.mul(TRADING_FLOOR_WATER_SHIMMER_ALPHA));
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'TradingFloorWater';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = TRADING_FLOOR_WATER_Y;
  mesh.renderOrder = TRADING_FLOOR_WATER_RENDER_ORDER;
  mesh.raycast = skipRaycast;
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function TradingFloorWater({ active }: { active: boolean }) {
  const motion = useMemo(() => uniform(0), []);
  const mesh = useMemo(
    () => createTradingFloorWater(CURRENT_WORLD_DEVICE_PROFILE.initialQualityTier > 0, motion),
    [motion],
  );
  // Keep the SAME graph and visible mesh during the stage warm (active=false).
  // Activation only changes a uniform, never creates a post-reveal pipeline.
  useLayoutEffect(() => { motion.value = active ? 1 : 0; }, [active, motion]);
  useEffect(() => () => {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }, [mesh]);
  return <primitive object={mesh} dispose={null} />;
}
