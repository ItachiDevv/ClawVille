import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
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
  TRADING_FLOOR_WATER_RENDER_ORDER,
  TRADING_FLOOR_WATER_SHIMMER_ALPHA,
  TRADING_FLOOR_WATER_Y,
  tradingFloorWaterBounds,
} from './trading-floor-water-layout';
import { createTradingFloorWater } from './trading-floor-water';

function disposeWater(mesh: ReturnType<typeof createTradingFloorWater>) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

describe('Trading Floor shallow water', () => {
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
      expect(TRADING_FLOOR_WATER_ALPHA + TRADING_FLOOR_WATER_SHIMMER_ALPHA).toBeLessThanOrEqual(0.12);
    } finally { disposeWater(mesh); }
  });

  test('stage low tiers omit animation nodes and keep the same mesh and tint', () => {
    const animated = createTradingFloorWater(false);
    try {
      expect(animated.material.colorNode).not.toBeNull();
      expect(animated.material.opacityNode).not.toBeNull();
      for (const deviceClass of ['desktop-low', 'phone', 'tablet'] as const) {
        const lowTier = WORLD_DEVICE_PROFILE[deviceClass].initialQualityTier > 0;
        expect(lowTier).toBe(true);
        const mesh = createTradingFloorWater(lowTier);
        try {
          expect(mesh.material.colorNode).toBeNull();
          expect(mesh.material.opacityNode).toBeNull();
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
