import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOOR_ARENA_HOUSE_AGENTS, FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import {
  applyHouseAgentHidden,
  createHouseAgentWalkupTracker,
  HOUSE_AGENT_ALL_LABELS,
  HOUSE_AGENT_BREATH_AMPLITUDE,
  HOUSE_AGENT_CHEST_Y,
  HOUSE_AGENT_PHONE_LABEL_RADIUS,
  HOUSE_AGENT_WALKUP_CLOSE_RADIUS,
  HOUSE_AGENT_WALKUP_OPEN_RADIUS,
  HOUSE_AGENT_YAW_AMPLITUDE,
  HOUSE_AGENTS_GLB,
  houseAgentIdle,
  houseAgentLabelTarget,
  houseAgentLabelVisible,
  houseAgentNodeName,
  houseAgentPhoneLabels,
  resolveHouseAgentWalkup,
  stepHouseAgentWalkup,
  writeHouseAgentAnchor,
  writeVisibleOnChange,
} from './trading-floor-house-agents-logic';
import {
  TRADING_FLOOR_HOUSE_AGENT_SPOTS,
  TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS,
} from './trading-floor-room';

/**
 * trading-floor-house-agents-mount.test.ts
 *
 * P15 task T4 (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §2 "Mount
 * (T4)", §3 "Detection (T4)", §6 row T4): the five house-agent figures at the
 * big screen. Pure walk-up / label / idle / hide logic, then structural checks
 * on the R3F mount and on the two interior lines (W2, W3) the room owner
 * approved. The room owner's constants suite is `trading-floor-house-agents.test.ts`.
 */

const SPOTS = TRADING_FLOOR_HOUSE_AGENT_SPOTS;
const S0 = SPOTS[0]!;
const S1 = SPOTS[1]!;
const S3 = SPOTS[3]!;

interface Player {
  x: number;
  z: number;
  seated: boolean;
  otherInteractionArmed: boolean;
}

function player(x: number, z: number, extra: Partial<Player> = {}): Player {
  return { x, z, seated: false, otherInteractionArmed: false, ...extra };
}

/** A body point `d` wu in front (+Z) of spot `s`. */
function inFront(s: { x: number; z: number }, d: number): [number, number] {
  return [s.x, s.z + d];
}

describe('P15 T4 walk-up detection (pure)', () => {
  test('radii: open at the room constant 250, close past 290', () => {
    expect(HOUSE_AGENT_WALKUP_OPEN_RADIUS).toBe(TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS);
    expect(HOUSE_AGENT_WALKUP_OPEN_RADIUS).toBe(250);
    expect(HOUSE_AGENT_WALKUP_CLOSE_RADIUS).toBe(290);
  });

  test('opens at <= 250, not at 251, from closed', () => {
    expect(resolveHouseAgentWalkup(-1, ...inFront(S0, 250), false)).toBe(0);
    expect(resolveHouseAgentWalkup(-1, ...inFront(S0, 251), false)).toBe(-1);
    expect(resolveHouseAgentWalkup(-1, ...inFront(S0, 280), false)).toBe(-1);
  });

  test('hysteresis: stays open to 290, closes at 290.5', () => {
    expect(resolveHouseAgentWalkup(0, ...inFront(S0, 270), false)).toBe(0);
    expect(resolveHouseAgentWalkup(0, ...inFront(S0, 290), false)).toBe(0);
    expect(resolveHouseAgentWalkup(0, ...inFront(S0, 290.5), false)).toBe(-1);
  });

  test('nearest wins, also against a held index', () => {
    // 265 wu right of spot 0 (held by hysteresis) is 245 wu left of spot 1.
    const x = S0.x + 265;
    expect(Math.abs(S1.x - x)).toBe(245);
    expect(resolveHouseAgentWalkup(0, x, S0.z, false)).toBe(1);
    // From closed, between two spots, the nearer one opens.
    expect(resolveHouseAgentWalkup(-1, S1.x - 200, S1.z, false)).toBe(1);
    // Exactly midway (255 each): nothing opens from closed.
    expect(resolveHouseAgentWalkup(-1, (S0.x + S1.x) / 2, S0.z, false)).toBe(-1);
  });

  test('blocked (seated, other interaction armed, panel open, inactive) is -1', () => {
    const t = createHouseAgentWalkupTracker();
    const writes: Array<[number, boolean]> = [];
    const write = (i: number, e: boolean) => {
      writes.push([i, e]);
    };
    const [x, z] = inFront(S1, 100);
    expect(stepHouseAgentWalkup(t, player(x, z), false, true, write)).toBe(1);
    expect(stepHouseAgentWalkup(t, player(x, z, { seated: true }), false, true, write)).toBe(-1);
    expect(stepHouseAgentWalkup(t, player(x, z), false, true, write)).toBe(1);
    expect(stepHouseAgentWalkup(t, player(x, z, { otherInteractionArmed: true }), false, true, write)).toBe(-1);
    expect(stepHouseAgentWalkup(t, player(x, z), false, true, write)).toBe(1);
    expect(stepHouseAgentWalkup(t, player(x, z), true, true, write)).toBe(-1);
    expect(stepHouseAgentWalkup(t, player(x, z), false, true, write)).toBe(1);
    expect(stepHouseAgentWalkup(t, player(x, z), false, false, write)).toBe(-1);
    expect(writes).toEqual([
      [1, true], [-1, false], [1, true], [-1, false], [1, true], [-1, false], [1, true], [-1, false],
    ]);
  });

  test('one store write per transition, never per frame', () => {
    const t = createHouseAgentWalkupTracker();
    let count = 0;
    const calls: Array<[number, boolean]> = [];
    const write = (i: number, e: boolean) => {
      count++;
      calls.push([i, e]);
    };
    const far = player(...inFront(S3, 600));
    const near = player(...inFront(S3, 120));
    const edge = player(...inFront(S3, 280)); // inside the close radius
    for (let f = 0; f < 30; f++) stepHouseAgentWalkup(t, far, false, true, write);
    expect(count).toBe(0);
    for (let f = 0; f < 60; f++) stepHouseAgentWalkup(t, near, false, true, write);
    for (let f = 0; f < 60; f++) stepHouseAgentWalkup(t, edge, false, true, write);
    expect(count).toBe(1);
    for (let f = 0; f < 30; f++) stepHouseAgentWalkup(t, far, false, true, write);
    expect(count).toBe(2);
    expect(calls).toEqual([[3, true], [-1, false]]);
  });

  test('anchor: chest height, in-front projection, behind camera is not mirrored', () => {
    expect(HOUSE_AGENT_CHEST_Y).toBe(200);
    const a = { x: 0, y: 0, onScreen: true };
    // In front, NDC (0.5, -0.5) on a 1000 x 800 canvas at (10, 20).
    writeHouseAgentAnchor(a, -0.2, -100, 0.5, -0.5, 1000, 800, 10, 20);
    expect(a).toEqual({ x: 10 + 750, y: 20 + 600, onScreen: true });
    // In front but outside the NDC box: off screen, x keeps its true side.
    writeHouseAgentAnchor(a, -50, -100, 1.4, 0, 1000, 800, 0, 0);
    expect(a.onScreen).toBe(false);
    expect(a.x).toBeGreaterThan(500);
    // Behind the camera (view z >= 0) on the LEFT (view x < 0): left side, even
    // though the mirrored NDC x says right.
    writeHouseAgentAnchor(a, 10, -300, 0.9, 0.1, 1000, 800, 0, 0);
    expect(a.onScreen).toBe(false);
    expect(a.x).toBeLessThan(500);
    expect(a.y).toBe(400);
    writeHouseAgentAnchor(a, 0, 300, -0.9, 0.1, 1000, 800, 0, 0);
    expect(a.onScreen).toBe(false);
    expect(a.x).toBeGreaterThan(500);
  });
});

describe('P15 T4 idle, labels, hide rule (pure)', () => {
  test('idle stays inside scale.y 1 +/- 0.006 and yaw +/- 0.03, seeded per agent', () => {
    expect(HOUSE_AGENT_BREATH_AMPLITUDE).toBe(0.006);
    expect(HOUSE_AGENT_YAW_AMPLITUDE).toBe(0.03);
    const pose = { scaleY: 0, yaw: 0 };
    let minS = Infinity, maxS = -Infinity, maxYaw = 0;
    for (let i = 0; i < SPOTS.length; i++) {
      for (let t = 0; t < 120; t += 0.0137) {
        houseAgentIdle(i, t, pose);
        minS = Math.min(minS, pose.scaleY);
        maxS = Math.max(maxS, pose.scaleY);
        maxYaw = Math.max(maxYaw, Math.abs(pose.yaw));
      }
    }
    expect(minS).toBeGreaterThanOrEqual(1 - 0.006 - 1e-12);
    expect(maxS).toBeLessThanOrEqual(1 + 0.006 + 1e-12);
    expect(maxYaw).toBeLessThanOrEqual(0.03 + 1e-12);
    // It does move, and no two agents breathe in step.
    expect(maxS - minS).toBeGreaterThan(0.01);
    const at = (i: number) => {
      houseAgentIdle(i, 7.3, pose);
      return `${pose.scaleY.toFixed(6)}:${pose.yaw.toFixed(6)}`;
    };
    expect(new Set([0, 1, 2, 3, 4].map(at)).size).toBe(5);
    // Returns its out record (no allocation).
    expect(houseAgentIdle(0, 1, pose)).toBe(pose);
  });

  test('phone policy: useIsMobile AND canvas width < 600', () => {
    expect(houseAgentPhoneLabels(true, 390)).toBe(true);
    expect(houseAgentPhoneLabels(true, 599)).toBe(true);
    expect(houseAgentPhoneLabels(true, 600)).toBe(false);
    expect(houseAgentPhoneLabels(true, 820)).toBe(false);
    expect(houseAgentPhoneLabels(false, 390)).toBe(false);
  });

  test('labels: all five on desktop and tablet; phone shows walk-up, else nearest within 900', () => {
    expect(HOUSE_AGENT_PHONE_LABEL_RADIUS).toBe(900);
    const shown = (target: number) =>
      SPOTS.map((_, i) => houseAgentLabelVisible(i, target));
    // Desktop / tablet: all five, wherever the player is.
    const desktop = houseAgentLabelTarget(false, -1, 0, 5000);
    expect(desktop).toBe(HOUSE_AGENT_ALL_LABELS);
    expect(shown(desktop)).toEqual([true, true, true, true, true]);
    // Phone, walk-up open on 2: only 2, even if another is nearer by a hair.
    expect(shown(houseAgentLabelTarget(true, 2, S3.x, S3.z + 100))).toEqual([false, false, true, false, false]);
    // Phone, no walk-up, 700 wu in front of 3: only 3.
    expect(shown(houseAgentLabelTarget(true, -1, S3.x, S3.z + 700))).toEqual([false, false, false, true, false]);
    // Phone, nothing within 900: none.
    expect(shown(houseAgentLabelTarget(true, -1, S3.x, S3.z + 901))).toEqual([false, false, false, false, false]);
  });

  test('visible is written only on a change', () => {
    let writes = 0;
    let value = true;
    const target = {
      get visible() {
        return value;
      },
      set visible(v: boolean) {
        writes++;
        value = v;
      },
    };
    expect(writeVisibleOnChange(target, true)).toBe(false);
    expect(writes).toBe(0);
    expect(writeVisibleOnChange(target, false)).toBe(true);
    expect(writeVisibleOnChange(target, false)).toBe(false);
    expect(writeVisibleOnChange(target, true)).toBe(true);
    expect(writes).toBe(2);
  });

  test('hide rule: per figure, from tradingFloorHouseAgentHidden, writes only on change', () => {
    let writes = 0;
    const meshes = SPOTS.map(() => {
      let v = true;
      return {
        get visible() {
          return v;
        },
        set visible(next: boolean) {
          writes++;
          v = next;
        },
      };
    });
    // Camera inside figure 2's box (low), body in front of it: only 2 hides.
    const cam: [number, number, number] = [SPOTS[2]!.x, 150, SPOTS[2]!.z + 10];
    const body: [number, number] = [SPOTS[2]!.x, SPOTS[2]!.z + 200];
    const calls: number[] = [];
    const hidden = (i: number, cx: number, cy: number, cz: number, bx: number, bz: number) => {
      calls.push(i);
      expect([cx, cy, cz, bx, bz]).toEqual([...cam, ...body]);
      return i === 2;
    };
    for (let f = 0; f < 20; f++) applyHouseAgentHidden(meshes, ...cam, ...body, hidden);
    expect(calls.length).toBe(20 * SPOTS.length);
    expect(meshes.map((m) => m.visible)).toEqual([true, true, false, true, true]);
    expect(writes).toBe(1);
    // Default predicate is the room's tradingFloorHouseAgentHidden.
    const fresh = SPOTS.map(() => ({ visible: true }));
    applyHouseAgentHidden(fresh, ...cam, ...body);
    expect(fresh[2]!.visible).toBe(false);
    expect(fresh[0]!.visible).toBe(true);
    // A missing mesh (GLB without that node) is skipped, not a crash.
    expect(() => applyHouseAgentHidden([null, ...fresh.slice(1)], ...cam, ...body)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structural: the mount file and the two interior lines
// ---------------------------------------------------------------------------

const HERE = import.meta.dir;
const MOUNT_SRC = join(HERE, 'trading-floor-house-agents.tsx');
const INTERIOR_SRC = join(HERE, 'trading-floor-interior.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Bodies of every useSceneFrame / useFrame callback, by brace matching. */
function frameCallbackBodies(src: string): string[] {
  const out: string[] = [];
  const re = /\b(useSceneFrame|useFrame)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    if (open < 0) break;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(open, end + 1));
  }
  return out;
}

describe('P15 T4 mount file (structural)', () => {
  test('the mount file exists', () => {
    expect(existsSync(MOUNT_SRC)).toBe(true);
  });

  const raw = existsSync(MOUNT_SRC) ? readFileSync(MOUNT_SRC, 'utf8') : '';
  const src = stripComments(raw);

  test('Iris Xe: no drei Text / Billboard, no InstancedMesh, no ShaderMaterial', () => {
    expect(src).not.toMatch(/\bBillboard\b/);
    expect(src).not.toMatch(/<Text[\s>/]/);
    expect(src).not.toMatch(/import[^;]*\bText\b[^;]*from\s+['"]@react-three\/drei['"]/);
    expect(src).not.toMatch(/InstancedMesh/);
    expect(src).not.toMatch(/ShaderMaterial/);
  });

  test('no `new ` inside a frame callback', () => {
    const bodies = frameCallbackBodies(src);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) expect(body).not.toMatch(/\bnew\s/);
  });

  test('GLB URL carries ?v= and the file ships', () => {
    expect(HOUSE_AGENTS_GLB).toBe('/models/trading-floor/trading-floor-house-agents.glb?v=1');
    expect(HOUSE_AGENTS_GLB).toMatch(/\.glb\?v=\d+$/);
    const file = join(HERE, '..', '..', '..', '..', 'public', HOUSE_AGENTS_GLB.split('?')[0]!);
    expect(existsSync(file)).toBe(true);
    expect(src).toMatch(/useGLTFWithKTX2\(\s*HOUSE_AGENTS_GLB\s*\)/);
  });

  test('node names follow the asset contract, in template order', () => {
    expect(FLOOR_ARENA_TEMPLATES.map((t) => houseAgentNodeName(t.id))).toEqual([
      'HouseAgent_genesis',
      'HouseAgent_runner',
      'HouseAgent_dip-hunter',
      'HouseAgent_midcap-climber',
      'HouseAgent_late-bloomer',
    ]);
    expect(FLOOR_ARENA_HOUSE_AGENTS.map((a) => a.templateId)).toEqual(FLOOR_ARENA_TEMPLATES.map((t) => t.id));
  });

  test('late mount: stage ready/resident gate, hidden compile, reveal, 5 s fallback', () => {
    expect(src).toMatch(/label:\s*'trading-floor-house-agents'/);
    expect(src).toMatch(/chainPostBootCompile\(/);
    expect(src).toMatch(/withStageSlotFrustumCullingDisabledSync\(\s*TRADING_FLOOR_SCENE_ID/);
    expect(src).toMatch(/status === 'ready' \|\| status === 'resident'/);
    expect(src).toMatch(/\b5000\b/);
  });

  test('Safe wrapper: Suspense + error boundary, exported', () => {
    expect(src).toMatch(/export function TradingFloorHouseAgentsSafe\b/);
    expect(src).toMatch(/<Suspense\b/);
    expect(src).toMatch(/getDerivedStateFromError/);
  });

  test('labels go through the DOM world-label overlay with occlude false', () => {
    expect(src).toMatch(/useWorldLabel\(/);
    expect(src).toMatch(/occlude:\s*false/);
    expect(src).toMatch(/TRADING_FLOOR_HOUSE_AGENT_LABEL_Y/);
    expect(src).toMatch(/useIsMobile\(\)/);
  });

  test('store: transitions through the tracker; -1 on leave and unmount', () => {
    expect(src).toMatch(/stepHouseAgentWalkup\(/);
    expect(src).toMatch(/setHouseAgentWalkup\(-1,\s*false\)/);
    expect(src).toMatch(/houseAgentWalkupAnchor/);
  });
});

describe('P15 T4 interior lines W2 + W3 (structural)', () => {
  const interior = readFileSync(INTERIOR_SRC, 'utf8');

  test('W2: one import and the mount right after <TradingFloorDecor />', () => {
    expect(interior).toContain("import { TradingFloorHouseAgentsSafe } from './trading-floor-house-agents';");
    expect(interior).toMatch(
      /<TradingFloorDecor active=\{active\} \/>\s*\n\s*<TradingFloorHouseAgentsSafe active=\{active\} readPlayer=\{readTradingFloorPlayer\} \/>/,
    );
    expect(interior.match(/<TradingFloorHouseAgentsSafe\b/g)?.length).toBe(1);
  });

  test('W3: the E / USE ladder default branch is the house-agent rung', () => {
    expect(interior).toMatch(/import \{ activateHouseAgentWalkup \} from '@\/stores\/house-agent-walkup';/);
    const start = interior.indexOf('export function activateTradingFloorUse');
    expect(start).toBeGreaterThan(0);
    const body = interior.slice(start, interior.indexOf('\n}\n', start));
    expect(body).toMatch(/case 'sit':[\s\S]*default:\s*\n\s*return activateHouseAgentWalkup\(\);/);
    expect(body).not.toMatch(/default:\s*\n\s*return false;/);
  });
});
