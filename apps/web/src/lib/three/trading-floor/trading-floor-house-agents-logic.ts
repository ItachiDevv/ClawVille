/**
 * trading-floor-house-agents-logic.ts
 *
 * Pure logic for the five house-agent figures under the Trading Floor big
 * screen (P15 task T4; ops/house-traders/arena-review/P15_PLAN_2026-10-02.md
 * §2 "Mount (T4)" and §3 "Detection (T4)"). No React, no store, no renderer:
 * the R3F mount (`trading-floor-house-agents.tsx`) calls these once per frame
 * with plain numbers, and `trading-floor-house-agents-mount.test.ts` pins them.
 *
 * Every function here is zero-allocation on its per-frame path: results go
 * into caller-owned records.
 */

import {
  TRADING_FLOOR_HOUSE_AGENT_SPOTS,
  TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS,
  tradingFloorHouseAgentHidden,
} from './trading-floor-room';

/** New path, so `?v=1`. Any later byte change at this path needs `?v=2` (CF edge cache). */
export const HOUSE_AGENTS_GLB = '/models/trading-floor/trading-floor-house-agents.glb?v=1';

/** T3 asset contract: one mesh node per template, in FLOOR_ARENA_TEMPLATES order. */
export function houseAgentNodeName(templateId: string): string {
  return `HouseAgent_${templateId}`;
}

/** Walk-up opens at <= 250 wu (the room constant) and closes past 290 wu. */
export const HOUSE_AGENT_WALKUP_OPEN_RADIUS = TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS;
export const HOUSE_AGENT_WALKUP_CLOSE_RADIUS = 290;
/** The pop-up anchor: the walk-up agent's chest point. */
export const HOUSE_AGENT_CHEST_Y = 200;
/** Phone labels: the walk-up agent, else the nearest agent within this distance. */
export const HOUSE_AGENT_PHONE_LABEL_RADIUS = 900;
/** Phone = useIsMobile() AND a canvas narrower than this (CSS px). */
export const HOUSE_AGENT_PHONE_MAX_WIDTH = 600;
/** Idle: breathing scale.y 1 +/- 0.006 and yaw +/- 0.03 rad. */
export const HOUSE_AGENT_BREATH_AMPLITUDE = 0.006;
export const HOUSE_AGENT_YAW_AMPLITUDE = 0.03;
/** Label target meaning "show all five" (desktop and tablet). */
export const HOUSE_AGENT_ALL_LABELS = -2;

export interface HouseAgentSpotXZ {
  readonly x: number;
  readonly z: number;
}

const OPEN_SQ = HOUSE_AGENT_WALKUP_OPEN_RADIUS * HOUSE_AGENT_WALKUP_OPEN_RADIUS;
const CLOSE_SQ = HOUSE_AGENT_WALKUP_CLOSE_RADIUS * HOUSE_AGENT_WALKUP_CLOSE_RADIUS;
const PHONE_SQ = HOUSE_AGENT_PHONE_LABEL_RADIUS * HOUSE_AGENT_PHONE_LABEL_RADIUS;

function distSq(spot: HouseAgentSpotXZ, x: number, z: number): number {
  const dx = spot.x - x;
  const dz = spot.z - z;
  return dx * dx + dz * dz;
}

/** Nearest spot index within `maxSq` (squared wu), else -1. Ties go to the lower index. */
function nearestWithin(
  x: number, z: number, maxSq: number, spots: readonly HouseAgentSpotXZ[],
): number {
  let best = -1;
  let bestSq = maxSq;
  for (let i = 0; i < spots.length; i++) {
    const d = distSq(spots[i]!, x, z);
    if (d <= bestSq && (best < 0 || d < bestSq)) {
      best = i;
      bestSq = d;
    }
  }
  return best;
}

/**
 * Next walk-up index from the previous one. Blocked (seated, another
 * interaction armed, the Exchange panel open, out of the room) is -1. The
 * nearest agent within the OPEN radius wins, even over a held index; a held
 * index survives out to the CLOSE radius (hysteresis). Spots are 510 wu apart,
 * so two open zones never overlap.
 */
export function resolveHouseAgentWalkup(
  previous: number,
  bodyX: number,
  bodyZ: number,
  blocked: boolean,
  spots: readonly HouseAgentSpotXZ[] = TRADING_FLOOR_HOUSE_AGENT_SPOTS,
): number {
  if (blocked || !Number.isFinite(bodyX) || !Number.isFinite(bodyZ)) return -1;
  const open = nearestWithin(bodyX, bodyZ, OPEN_SQ, spots);
  if (open >= 0) return open;
  const held = previous >= 0 ? spots[previous] : undefined;
  if (held && distSq(held, bodyX, bodyZ) <= CLOSE_SQ) return previous;
  return -1;
}

export interface HouseAgentWalkupTracker {
  /** The index last written to the store (-1 = closed). */
  index: number;
}

export function createHouseAgentWalkupTracker(): HouseAgentWalkupTracker {
  return { index: -1 };
}

export interface HouseAgentPlayerRead {
  readonly x: number;
  readonly z: number;
  readonly seated: boolean;
  readonly otherInteractionArmed: boolean;
}

/**
 * One frame of walk-up detection. Calls `write` (the store's
 * `setHouseAgentWalkup`) ONLY when the index changes, never per frame.
 * `eAvailable` is true whenever an index is open: the rungs above it in the
 * E / USE ladder (stand, monitor, door, sit) all block the walk-up here, so an
 * open walk-up is always what E reaches.
 */
export function stepHouseAgentWalkup(
  tracker: HouseAgentWalkupTracker,
  player: HouseAgentPlayerRead,
  panelOpen: boolean,
  active: boolean,
  write: (index: number, eAvailable: boolean) => void,
  spots: readonly HouseAgentSpotXZ[] = TRADING_FLOOR_HOUSE_AGENT_SPOTS,
): number {
  const blocked = !active || panelOpen || player.seated || player.otherInteractionArmed;
  const next = resolveHouseAgentWalkup(tracker.index, player.x, player.z, blocked, spots);
  if (next !== tracker.index) {
    tracker.index = next;
    write(next, next >= 0);
  }
  return next;
}

/**
 * Write the pop-up anchor in CSS px. `viewX` / `viewZ` are the chest point in
 * camera space; `ndcX` / `ndcY` its projection. View z >= 0 is at or behind
 * the camera plane, where the projection is MIRRORED, so the side comes from
 * view x instead and y sits at mid height. `left` / `top` are the canvas
 * offset in the viewport.
 */
export function writeHouseAgentAnchor(
  out: { x: number; y: number; onScreen: boolean },
  viewZ: number,
  viewX: number,
  ndcX: number,
  ndcY: number,
  width: number,
  height: number,
  left: number,
  top: number,
): void {
  if (viewZ >= 0) {
    out.x = left + (viewX < 0 ? 0 : width);
    out.y = top + height / 2;
    out.onScreen = false;
    return;
  }
  out.x = left + (ndcX * 0.5 + 0.5) * width;
  out.y = top + (1 - (ndcY * 0.5 + 0.5)) * height;
  out.onScreen = ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
}

/** Phone label policy applies only on a touch device with a narrow canvas. */
export function houseAgentPhoneLabels(isMobile: boolean, canvasWidth: number): boolean {
  return isMobile && canvasWidth < HOUSE_AGENT_PHONE_MAX_WIDTH;
}

/**
 * Which label(s) show. Desktop and tablet: all five. Phone: the walk-up agent,
 * else the nearest agent within 900 wu, else none, so five capsules never stack
 * on a 390 px screen.
 */
export function houseAgentLabelTarget(
  phone: boolean,
  walkupIndex: number,
  bodyX: number,
  bodyZ: number,
  spots: readonly HouseAgentSpotXZ[] = TRADING_FLOOR_HOUSE_AGENT_SPOTS,
): number {
  if (!phone) return HOUSE_AGENT_ALL_LABELS;
  if (walkupIndex >= 0) return walkupIndex;
  return nearestWithin(bodyX, bodyZ, PHONE_SQ, spots);
}

export function houseAgentLabelVisible(index: number, target: number): boolean {
  return target === HOUSE_AGENT_ALL_LABELS || target === index;
}

/** Golden-ratio seed per agent, in [0, 1). */
function seed(index: number, salt: number): number {
  const v = (index + 1) * 0.6180339887 + salt * 0.7548776662;
  return v - Math.floor(v);
}

const TAU = Math.PI * 2;

/**
 * Idle pose for agent `index` at time `t` seconds, written into `out`.
 * Breathing: scale.y = 1 + 0.006 sin(...), period 3.4-4.3 s. Sway: yaw offset
 * 0.03 sin(...), period 7-10 s. Phases and periods are seeded per agent.
 */
export function houseAgentIdle(
  index: number,
  t: number,
  out: { scaleY: number; yaw: number },
): { scaleY: number; yaw: number } {
  const a = seed(index, 1);
  const b = seed(index, 2);
  const breathPeriod = 3.4 + 0.9 * a;
  const swayPeriod = 7 + 3 * b;
  out.scaleY = 1 + HOUSE_AGENT_BREATH_AMPLITUDE * Math.sin((TAU * t) / breathPeriod + TAU * a);
  out.yaw = HOUSE_AGENT_YAW_AMPLITUDE * Math.sin((TAU * t) / swayPeriod + TAU * b);
  return out;
}

/** Write `visible` only when it changes. Returns true when it wrote. */
export function writeVisibleOnChange(target: { visible: boolean }, next: boolean): boolean {
  if (target.visible === next) return false;
  target.visible = next;
  return true;
}

export type HouseAgentHiddenFn = (
  index: number, camX: number, camY: number, camZ: number, bodyX: number, bodyZ: number,
) => boolean;

/**
 * The per-figure hide rule: hide figure i when the camera is inside it or
 * the camera-to-body sightline crosses it (`tradingFloorHouseAgentHidden`).
 * The label and the walk-up stay on. Writes `visible` only on a change;
 * returns the number of writes. A missing node is skipped.
 */
export function applyHouseAgentHidden(
  meshes: readonly ({ visible: boolean } | null | undefined)[],
  camX: number,
  camY: number,
  camZ: number,
  bodyX: number,
  bodyZ: number,
  hidden: HouseAgentHiddenFn = tradingFloorHouseAgentHidden,
): number {
  let writes = 0;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!mesh) continue;
    if (writeVisibleOnChange(mesh, !hidden(i, camX, camY, camZ, bodyX, bodyZ))) writes++;
  }
  return writes;
}
