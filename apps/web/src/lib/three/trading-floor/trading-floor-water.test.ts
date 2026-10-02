import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { positionWorld, time, uniform } from 'three/tsl';
import { WORLD_DEVICE_PROFILE } from '../device-class';
import {
  TRADING_FLOOR_BOARD_APPROACH_Z,
  TRADING_FLOOR_DOOR_APPROACH_Z,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SEATS,
  TRADING_FLOOR_SIDE_APPROACH_X,
  clampTradingFloorMovement2D,
  clampTradingFloorMovementSeated,
} from './trading-floor-room';
import {
  TRADING_FLOOR_WATER_ALPHA,
  TRADING_FLOOR_WATER_BOUNDS,
  TRADING_FLOOR_WATER_CAUSTIC_WAVE_VECTOR,
  TRADING_FLOOR_WATER_FLOW_DIRECTION,
  TRADING_FLOOR_WATER_FLOW_SPEED,
  TRADING_FLOOR_WATER_GRAZING_ALPHA,
  TRADING_FLOOR_WATER_GRAZING_COLOR,
  TRADING_FLOOR_WATER_GRAZING_DOT,
  TRADING_FLOOR_WATER_RENDER_ORDER,
  TRADING_FLOOR_WATER_RIPPLE_WAVE_VECTOR,
  TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION,
  TRADING_FLOOR_WATER_SECONDARY_FLOW_SPEED,
  TRADING_FLOOR_WATER_SHIMMER_ALPHA,
  TRADING_FLOOR_WATER_STEEP_COLOR,
  TRADING_FLOOR_WATER_STEEP_DOT,
  TRADING_FLOOR_WATER_Y,
  tradingFloorWaterAlpha,
  tradingFloorWaterBounds,
} from './trading-floor-water-layout';
import { createTradingFloorWater } from './trading-floor-water';

function disposeWater(mesh: ReturnType<typeof createTradingFloorWater>) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

function graphHasNode(mesh: ReturnType<typeof createTradingFloorWater>, uuid: string): boolean {
  let found = false;
  for (const root of [mesh.material.colorNode, mesh.material.opacityNode]) {
    root?.traverse((node) => { if (node.uuid === uuid) found = true; });
  }
  return found;
}

describe('Trading Floor shallow water', () => {
  test('pins two steady floor flows toward the board at distinct angles and speeds', () => {
    expect(TRADING_FLOOR_WATER_FLOW_SPEED).toBe(58);
    expect(TRADING_FLOOR_WATER_FLOW_DIRECTION).toEqual({ x: 0, z: -1 });
    expect(TRADING_FLOOR_WATER_SECONDARY_FLOW_SPEED).toBe(44);
    expect(TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION).toEqual({ x: 0.28, z: -0.96 });
    for (const direction of [TRADING_FLOOR_WATER_FLOW_DIRECTION, TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION]) {
      expect(Math.hypot(direction.x, direction.z)).toBeCloseTo(1, 8);
      expect(direction.z).toBeLessThan(0);
    }
    const component = readFileSync(new URL('./trading-floor-water.tsx', import.meta.url), 'utf8');
    expect(component).toContain('time.mul(TRADING_FLOOR_WATER_FLOW_SPEED)');
    expect(component).toContain('time.mul(TRADING_FLOOR_WATER_SECONDARY_FLOW_SPEED)');
    expect(component).toContain('positionWorld.z.sub(primaryTravel.mul(TRADING_FLOOR_WATER_FLOW_DIRECTION.z))');
    expect(component).toContain('positionWorld.z.sub(secondaryTravel.mul(TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION.z))');
  });

  test('primary crest normals keep apparent flow toward the board', () => {
    expect(TRADING_FLOOR_WATER_RIPPLE_WAVE_VECTOR).toEqual({ x: 0.014, z: 0.040 });
    expect(TRADING_FLOOR_WATER_CAUSTIC_WAVE_VECTOR).toEqual({ x: 0.010, z: 0.057 });
    const direction = TRADING_FLOOR_WATER_FLOW_DIRECTION;
    for (const wave of [TRADING_FLOOR_WATER_RIPPLE_WAVE_VECTOR, TRADING_FLOOR_WATER_CAUSTIC_WAVE_VECTOR]) {
      const alignment = Math.abs(wave.x * direction.x + wave.z * direction.z) / Math.hypot(wave.x, wave.z);
      expect(alignment).toBeGreaterThan(0.85);
    }
    const component = readFileSync(new URL('./trading-floor-water.tsx', import.meta.url), 'utf8');
    for (const wave of ['RIPPLE', 'CAUSTIC']) {
      expect(component).toContain(`x.mul(TRADING_FLOOR_WATER_${wave}_WAVE_VECTOR.x)`);
      expect(component).toContain(`z.mul(TRADING_FLOOR_WATER_${wave}_WAVE_VECTOR.z)`);
    }
  });

  test('Fresnel alpha keeps the near seal clear and the far floor reflective', () => {
    expect(TRADING_FLOOR_WATER_ALPHA).toBeGreaterThanOrEqual(0.10);
    expect(TRADING_FLOOR_WATER_ALPHA).toBeLessThanOrEqual(0.15);
    expect(TRADING_FLOOR_WATER_GRAZING_ALPHA).toBeGreaterThanOrEqual(0.40);
    expect(TRADING_FLOOR_WATER_GRAZING_ALPHA + TRADING_FLOOR_WATER_SHIMMER_ALPHA).toBeLessThanOrEqual(0.50);
    for (const angle of [25, 30, 35, 90]) {
      expect(tradingFloorWaterAlpha(angle)).toBeCloseTo(TRADING_FLOOR_WATER_ALPHA, 8);
    }
    for (const angle of [0, 5, 8]) {
      expect(tradingFloorWaterAlpha(angle)).toBeCloseTo(TRADING_FLOOR_WATER_GRAZING_ALPHA, 8);
    }
    const midpointAngle = Math.asin((TRADING_FLOOR_WATER_GRAZING_DOT + TRADING_FLOOR_WATER_STEEP_DOT) / 2) * 180 / Math.PI;
    expect(tradingFloorWaterAlpha(midpointAngle)).toBeCloseTo(
      (TRADING_FLOOR_WATER_ALPHA + TRADING_FLOOR_WATER_GRAZING_ALPHA) / 2, 8,
    );
    expect(tradingFloorWaterAlpha(12)).toBeGreaterThan(0.40);
    expect(tradingFloorWaterAlpha(20)).toBeLessThan(0.20);
    for (let angle = 1; angle <= 90; angle++) {
      expect(tradingFloorWaterAlpha(angle)).toBeLessThanOrEqual(tradingFloorWaterAlpha(angle - 1));
    }
    expect(tradingFloorWaterAlpha(-10)).toBe(TRADING_FLOOR_WATER_GRAZING_ALPHA);
    expect(tradingFloorWaterAlpha(100)).toBe(TRADING_FLOOR_WATER_ALPHA);
    expect(TRADING_FLOOR_WATER_STEEP_COLOR).toBe('#4e8d7c');
    expect(TRADING_FLOOR_WATER_GRAZING_COLOR).toBe('#8ccfd0');
  });

  test('surface stays halfway up the smallest specified foot, below its ankle', () => {
    expect(TRADING_FLOOR_WATER_Y).toBeGreaterThanOrEqual(6);
    expect(TRADING_FLOOR_WATER_Y).toBeLessThanOrEqual(8);
    // Founder scale reference: a foot is 15-20 wu tall; its ankle is above it.
    expect(TRADING_FLOOR_WATER_Y).toBeLessThanOrEqual(15 / 2);
  });

  test('covers the entire movement envelope and stays inside inner wall faces', () => {
    const { halfX, halfZ } = TRADING_FLOOR_WATER_BOUNDS;
    expect(halfX).toBeGreaterThanOrEqual(TRADING_FLOOR_SIDE_APPROACH_X);
    expect(-halfZ).toBeLessThanOrEqual(TRADING_FLOOR_BOARD_APPROACH_Z);
    expect(halfZ).toBeGreaterThanOrEqual(TRADING_FLOOR_DOOR_APPROACH_Z);
    expect(halfX).toBeLessThan(TRADING_FLOOR_ROOM.halfX);
    expect(halfZ).toBeLessThan(TRADING_FLOOR_ROOM.halfZ);

    const out = { x: 0, z: 0 };
    for (let ix = -4; ix <= 4; ix++) {
      for (let iz = -4; iz <= 4; iz++) {
        clampTradingFloorMovement2D(
          TRADING_FLOOR_PLAYER_SPAWN.x, TRADING_FLOOR_PLAYER_SPAWN.z,
          ix * TRADING_FLOOR_ROOM.halfX, iz * TRADING_FLOOR_ROOM.halfZ, out,
        );
        expect(Math.abs(out.x)).toBeLessThanOrEqual(halfX);
        expect(Math.abs(out.z)).toBeLessThanOrEqual(halfZ);
      }
    }
    for (let seat = 0; seat < TRADING_FLOOR_SEATS.length; seat++) {
      clampTradingFloorMovementSeated(seat, 0, 0, 0, 0, out);
      expect(Math.abs(out.x)).toBeLessThanOrEqual(halfX);
      expect(Math.abs(out.z)).toBeLessThanOrEqual(halfZ);
    }
  });

  test('derives coverage from room constants, including the later 1.5x resize', () => {
    const scale = 1.5;
    const grown = tradingFloorWaterBounds({
      halfX: TRADING_FLOOR_ROOM.halfX * scale,
      halfZ: TRADING_FLOOR_ROOM.halfZ * scale,
      wallThickness: TRADING_FLOOR_ROOM.wallThickness,
    });
    const inset = TRADING_FLOOR_ROOM.wallThickness / 20;
    expect(grown.halfX).toBe(TRADING_FLOOR_ROOM.halfX * scale - inset);
    expect(grown.halfZ).toBe(TRADING_FLOOR_ROOM.halfZ * scale - inset);
  });

  test('adds exactly one single-pass mesh at the water surface with no click hits', () => {
    const mesh = createTradingFloorWater(false);
    try {
      let meshes = 0;
      mesh.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes++; });
      expect(meshes).toBe(1);
      expect(mesh.children).toHaveLength(0);
      expect(mesh.geometry.groups).toHaveLength(0);
      expect(mesh.geometry.index!.count).toBe(6);
      expect(Array.isArray(mesh.material)).toBe(false);
      expect(mesh.material.side).toBe(THREE.FrontSide);
      expect(mesh.matrixAutoUpdate).toBe(false);
      const bounds = new THREE.Box3().setFromObject(mesh);
      expect(bounds.min.x).toBeCloseTo(-TRADING_FLOOR_WATER_BOUNDS.halfX);
      expect(bounds.max.x).toBeCloseTo(TRADING_FLOOR_WATER_BOUNDS.halfX);
      expect(bounds.min.z).toBeCloseTo(-TRADING_FLOOR_WATER_BOUNDS.halfZ);
      expect(bounds.max.z).toBeCloseTo(TRADING_FLOOR_WATER_BOUNDS.halfZ);
      expect(bounds.min.y).toBeCloseTo(TRADING_FLOOR_WATER_Y);
      expect(bounds.max.y).toBeCloseTo(TRADING_FLOOR_WATER_Y);
      const ray = new THREE.Raycaster(
        new THREE.Vector3(0, TRADING_FLOOR_WATER_Y + 100, 0),
        new THREE.Vector3(0, -1, 0),
      );
      const control = new THREE.Mesh(mesh.geometry, mesh.material);
      control.matrixWorld.copy(mesh.matrixWorld);
      expect(ray.intersectObject(control)).not.toHaveLength(0);
      expect(ray.intersectObject(mesh)).toHaveLength(0);
    } finally { disposeWater(mesh); }
  });

  test('keeps normal transparency, depth testing and sorting between glow and tape', () => {
    const mesh = createTradingFloorWater(false);
    try {
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicNodeMaterial);
      expect(mesh.material).not.toBeInstanceOf(THREE.ShaderMaterial);
      expect(mesh.material.transparent).toBe(true);
      expect(mesh.material.depthWrite).toBe(false);
      expect(mesh.material.depthTest).toBe(true);
      expect(mesh.material.fog).toBe(false);
      expect(mesh.material.blending).toBe(THREE.NormalBlending);
      expect(mesh.renderOrder).toBe(TRADING_FLOOR_WATER_RENDER_ORDER);
      expect(mesh.renderOrder).toBeGreaterThan(-1);
      expect(mesh.renderOrder).toBeLessThan(0);
      expect(TRADING_FLOOR_WATER_ALPHA + TRADING_FLOOR_WATER_SHIMMER_ALPHA * 0.55).toBeLessThanOrEqual(0.15);
    } finally { disposeWater(mesh); }
  });

  test('stage low tiers keep fixed Fresnel tint without time, ripples or motion nodes', () => {
    const motion = uniform(1);
    const animated = createTradingFloorWater(false, motion);
    try {
      expect(animated.material.colorNode).not.toBeNull();
      expect(animated.material.opacityNode).not.toBeNull();
      expect(graphHasNode(animated, time.uuid)).toBe(true);
      expect(graphHasNode(animated, positionWorld.uuid)).toBe(true);
      expect(graphHasNode(animated, motion.uuid)).toBe(true);
      for (const deviceClass of ['desktop-low', 'phone', 'tablet'] as const) {
        const lowTier = WORLD_DEVICE_PROFILE[deviceClass].initialQualityTier > 0;
        expect(lowTier).toBe(true);
        const mesh = createTradingFloorWater(lowTier, motion);
        try {
          expect(mesh.material.colorNode).not.toBeNull();
          expect(mesh.material.opacityNode).not.toBeNull();
          expect(graphHasNode(mesh, time.uuid)).toBe(false);
          expect(graphHasNode(mesh, positionWorld.uuid)).toBe(false);
          expect(graphHasNode(mesh, motion.uuid)).toBe(false);
          expect(mesh.material.opacity).toBe(TRADING_FLOOR_WATER_ALPHA);
          expect(mesh.material.color.equals(animated.material.color)).toBe(true);
          expect(mesh.geometry.index!.count).toBe(animated.geometry.index!.count);
        } finally { disposeWater(mesh); }
      }
    } finally { disposeWater(animated); }
  });

  test('activation changes only a uniform on the graph present during warm', () => {
    const motion = uniform(0);
    const mesh = createTradingFloorWater(false, motion);
    try {
      const colorNode = mesh.material.colorNode;
      const opacityNode = mesh.material.opacityNode;
      motion.value = 1;
      expect(mesh.visible).toBe(true);
      expect(mesh.material.colorNode).toBe(colorNode);
      expect(mesh.material.opacityNode).toBe(opacityNode);
      const component = readFileSync(new URL('./trading-floor-water.tsx', import.meta.url), 'utf8');
      const interior = readFileSync(new URL('./trading-floor-interior.tsx', import.meta.url), 'utf8');
      expect(interior.match(/<TradingFloorWater\b/g)).toHaveLength(1);
      expect(interior).toContain('<TradingFloorWater active={active} />');
      expect(component).toContain('CURRENT_WORLD_DEVICE_PROFILE.initialQualityTier > 0');
      expect(component).toContain('motion.value = active ? 1 : 0');
      expect(component).toContain('return <primitive object={mesh} dispose={null} />');
      expect(component).not.toMatch(/use(?:Scene)?Frame\s*\(/);
      expect(component).toContain('mesh.geometry.dispose()');
      expect(component).toContain('mesh.material.dispose()');
    } finally { disposeWater(mesh); }
  });
});
