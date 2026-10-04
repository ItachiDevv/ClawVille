import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  HOUSE_AGENT_LABEL_MAX_WIDTH,
  HOUSE_AGENT_LABEL_MIN_GAP,
  HOUSE_AGENT_LABEL_PILL_STYLE,
  houseAgentLabelsPhone,
} from './trading-floor-house-agents';
import {
  placeTradingFloorChaseCamera,
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_HOUSE_AGENT_LABEL_Y,
  TRADING_FLOOR_HOUSE_AGENT_SPOTS,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_ROOM,
} from './trading-floor-room';

/**
 * F4 (browser review 2026-10-02): at 1440x900 the "Mid-Cap Climber" and
 * "Late Bloomer" name pills touched. The five labels sit 510 wu apart, and from
 * the far end of the room that is about 124 CSS px at 900 px tall. A one-line
 * pill of a two-word name is wider than that, so the pill now has a hard width
 * cap and wraps to two lines.
 *
 * The check projects the real label anchors through the real chase camera
 * (spawn and the back wall, yaw +/- 10 degrees, pitch min / 0 / max) and asks
 * that two adjacent pill boxes never come within HOUSE_AGENT_LABEL_MIN_GAP px,
 * at every size where all five labels show. A pill is centred on its anchor
 * (WorldLabel: translate(-50%, -50%)), so two pills of width <= W never touch
 * when their centres are W + gap apart.
 */

/** Every size where all five labels show (desktop, and tablets whose short side is >= 600). */
const ALL_FIVE: Array<[number, number, boolean]> = [
  [1440, 900, false],
  [1366, 768, false],
  [1280, 720, false],
  [1920, 1080, false],
  [744, 1133, true],
  [1133, 744, true],
  [820, 1180, true],
  [1180, 820, true],
  [1024, 1366, true],
  [1366, 1024, true],
];

/** Phone sizes, portrait AND landscape: one label at a time. */
const PHONES: Array<[number, number]> = [
  [390, 844],
  [844, 390],
  [375, 667],
  [667, 375],
];

const _v = new THREE.Vector3();

function minCentreSpacing(width: number, height: number): number {
  const out = { x: 0, y: 0, z: 0 };
  const camera = new THREE.PerspectiveCamera(TRADING_FLOOR_CAMERA.fov, width / height, 1, 20_000);
  let min = Number.POSITIVE_INFINITY;
  for (const bodyZ of [TRADING_FLOOR_PLAYER_SPAWN.z, TRADING_FLOOR_ROOM.halfZ - 100]) {
    for (const degrees of [-10, -5, 0, 5, 10]) {
      for (const pitch of [TRADING_FLOOR_CAMERA.pitchMin, 0, TRADING_FLOOR_CAMERA.pitchMax]) {
        const yaw = (degrees * Math.PI) / 180;
        placeTradingFloorChaseCamera(0, bodyZ, yaw, pitch, out);
        camera.position.set(out.x, out.y, out.z);
        camera.lookAt(
          Math.sin(yaw) * TRADING_FLOOR_CAMERA.lookAhead,
          TRADING_FLOOR_CAMERA.lookY,
          bodyZ - Math.cos(yaw) * TRADING_FLOOR_CAMERA.lookAhead,
        );
        camera.updateMatrixWorld();
        const xs = TRADING_FLOOR_HOUSE_AGENT_SPOTS.map((spot) => {
          _v.set(spot.x, TRADING_FLOOR_HOUSE_AGENT_LABEL_Y, spot.z).project(camera);
          return { x: (_v.x * 0.5 + 0.5) * width, inView: Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1 };
        });
        for (let i = 0; i + 1 < xs.length; i++) {
          if (xs[i]!.inView && xs[i + 1]!.inView) min = Math.min(min, xs[i + 1]!.x - xs[i]!.x);
        }
      }
    }
  }
  return min;
}

describe('F4: house-agent name pills never touch', () => {
  test('the pill has a hard width cap and wraps instead of growing', () => {
    expect(HOUSE_AGENT_LABEL_MAX_WIDTH).toBeGreaterThan(0);
    expect(HOUSE_AGENT_LABEL_PILL_STYLE.maxWidth).toBe(HOUSE_AGENT_LABEL_MAX_WIDTH);
    // The cap includes padding and border, so the box can never be wider.
    expect(HOUSE_AGENT_LABEL_PILL_STYLE.boxSizing).toBe('border-box');
    expect(HOUSE_AGENT_LABEL_PILL_STYLE.whiteSpace).not.toBe('nowrap');
    // A long single word still stays inside the box.
    expect(HOUSE_AGENT_LABEL_PILL_STYLE.overflowWrap).toBe('anywhere');
  });

  test.each(ALL_FIVE)('%ix%i (touch %p): adjacent pills keep at least the minimum gap', (width, height, touch) => {
    expect(houseAgentLabelsPhone(touch, width, height)).toBe(false);
    const spacing = minCentreSpacing(width, height);
    expect(Number.isFinite(spacing)).toBe(true);
    expect(spacing - HOUSE_AGENT_LABEL_MAX_WIDTH).toBeGreaterThanOrEqual(HOUSE_AGENT_LABEL_MIN_GAP);
  });

  test.each(PHONES)('%ix%i touch: phone policy (one label), also in landscape', (width, height) => {
    expect(houseAgentLabelsPhone(true, width, height)).toBe(true);
  });

  test('a desktop window is never a phone, however small', () => {
    expect(houseAgentLabelsPhone(false, 844, 390)).toBe(false);
    expect(houseAgentLabelsPhone(false, 500, 400)).toBe(false);
  });
});
