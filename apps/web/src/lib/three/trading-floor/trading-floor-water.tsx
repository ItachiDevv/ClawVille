'use client';

import { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { color, dot, float, mix, normalView, positionViewDirection, positionWorld, sin, smoothstep, time, uniform } from 'three/tsl';
import { CURRENT_WORLD_DEVICE_PROFILE } from '../device-class';
import {
  TRADING_FLOOR_WATER_ALPHA,
  TRADING_FLOOR_WATER_BOUNDS,
  TRADING_FLOOR_WATER_CAUSTIC_WAVE_VECTOR,
  TRADING_FLOOR_WATER_FLOW_DIRECTION,
  TRADING_FLOOR_WATER_FLOW_SPEED,
  TRADING_FLOOR_WATER_GRAZING_ALPHA,
  TRADING_FLOOR_WATER_GRAZING_COLOR,
  TRADING_FLOOR_WATER_GRAZING_DOT,
  TRADING_FLOOR_WATER_HIGHLIGHT_COLOR,
  TRADING_FLOOR_WATER_RENDER_ORDER,
  TRADING_FLOOR_WATER_RIPPLE_WAVE_VECTOR,
  TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION,
  TRADING_FLOOR_WATER_SECONDARY_FLOW_SPEED,
  TRADING_FLOOR_WATER_SHIMMER_ALPHA,
  TRADING_FLOOR_WATER_STEEP_COLOR,
  TRADING_FLOOR_WATER_STEEP_DOT,
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
    color: TRADING_FLOOR_WATER_STEEP_COLOR,
    opacity: TRADING_FLOOR_WATER_ALPHA,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false,
    toneMapped: false,
  });

  // Per-fragment view direction, not one angle at each of the four corners.
  // Low tiers use this fixed Fresnel tint with no time or ripple nodes.
  const normalDotView = dot(normalView, positionViewDirection).clamp(0, 1);
  const grazing = smoothstep(
    TRADING_FLOOR_WATER_GRAZING_DOT, TRADING_FLOOR_WATER_STEEP_DOT, normalDotView,
  ).oneMinus();
  const tint = mix(color(TRADING_FLOOR_WATER_STEEP_COLOR), color(TRADING_FLOOR_WATER_GRAZING_COLOR), grazing);
  const alpha = mix(float(TRADING_FLOOR_WATER_ALPHA), float(TRADING_FLOOR_WATER_GRAZING_ALPHA), grazing);
  material.colorNode = tint;
  material.opacityNode = alpha;

  if (!lowTier) {
    // Sample p - velocity * time: the crests travel from the door toward -Z.
    // Each layer carries its own bends, with a small GPU-only phase wobble.
    const primaryTravel = time.mul(TRADING_FLOOR_WATER_FLOW_SPEED);
    const x = positionWorld.x.sub(primaryTravel.mul(TRADING_FLOOR_WATER_FLOW_DIRECTION.x));
    const z = positionWorld.z.sub(primaryTravel.mul(TRADING_FLOOR_WATER_FLOW_DIRECTION.z));
    const secondaryTravel = time.mul(TRADING_FLOOR_WATER_SECONDARY_FLOW_SPEED);
    const x2 = positionWorld.x.sub(secondaryTravel.mul(TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION.x));
    const z2 = positionWorld.z.sub(secondaryTravel.mul(TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION.z));
    const wobble = sin(time.mul(0.45)).mul(0.12);
    // Three broad crest families across two separately advected layers.
    const w1 = sin(x.mul(TRADING_FLOOR_WATER_RIPPLE_WAVE_VECTOR.x)
      .add(z.mul(TRADING_FLOOR_WATER_RIPPLE_WAVE_VECTOR.z)).add(sin(z.mul(0.008)).mul(0.65)).add(wobble));
    const w2 = sin(x2.mul(-0.021).add(z2.mul(0.058)).add(sin(x2.mul(0.012)).mul(0.65)).sub(wobble));
    const w3 = sin(x.mul(TRADING_FLOOR_WATER_CAUSTIC_WAVE_VECTOR.x)
      .add(z.mul(TRADING_FLOOR_WATER_CAUSTIC_WAVE_VECTOR.z)).add(w1.mul(0.45)));
    const crests = smoothstep(0.85, 0.985, w1).mul(0.50)
      .add(smoothstep(0.85, 0.985, w2).mul(0.32))
      .add(smoothstep(0.85, 0.985, w3).mul(0.18));
    // Strongest on the mid floor; fade at the horizon to avoid thin far bands.
    const visibility = mix(float(0.55), float(1), grazing)
      .mul(smoothstep(0.06, 0.18, normalDotView));
    const shimmer = crests.mul(visibility).mul(motion);
    material.colorNode = mix(tint, color(TRADING_FLOOR_WATER_HIGHLIGHT_COLOR), shimmer.mul(0.85));
    // Near-floor alpha <= 0.142; even overlapping far crests stay <= 0.50.
    material.opacityNode = alpha.add(shimmer.mul(TRADING_FLOOR_WATER_SHIMMER_ALPHA));
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
