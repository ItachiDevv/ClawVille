import { ReefSpline } from './spline';
import { REEF_RACE_DEFAULT_TRACK } from './track-layout';

export type ReefRaceObstacleKind = 'kelp' | 'urchin' | 'driftwood' | 'creature';

export interface ReefRaceWirePoint {
  x: number;
  /** Protocol Y is scene Z. */
  y: number;
}

interface ReefRaceObstacleBase {
  id: string;
  kind: ReefRaceObstacleKind;
  /** Static center for kelp/urchin/log; track-center crossing origin for creature. */
  position: ReefRaceWirePoint;
  /** Three.js Y rotation. Driftwood rot is its long axis; all others face down-track. */
  rot: number;
  /** Within-lap arclength fraction, used by deterministic bot planning. */
  progress: number;
  /** Normalized absolute-clock cycle offset. Static obstacles use zero. */
  phase: number;
}

export interface ReefRaceKelpObstacle extends ReefRaceObstacleBase {
  kind: 'kelp';
  params: { radius: number };
}

export interface ReefRaceUrchinObstacle extends ReefRaceObstacleBase {
  kind: 'urchin';
  params: { radius: number; clearanceHeight: number };
}

export interface ReefRaceDriftwoodObstacle extends ReefRaceObstacleBase {
  kind: 'driftwood';
  params: {
    halfLength: number;
    halfWidth: number;
    clearanceHeight: number;
  };
}

export interface ReefRaceCreatureObstacle extends ReefRaceObstacleBase {
  kind: 'creature';
  params: {
    radius: number;
    clearanceHeight: number;
    lateralSpan: number;
    periodMs: number;
    telegraphMs: number;
    crossingMs: number;
    direction: -1 | 1;
  };
}

export type ReefRaceObstacleLayout =
  | ReefRaceKelpObstacle
  | ReefRaceUrchinObstacle
  | ReefRaceDriftwoodObstacle
  | ReefRaceCreatureObstacle;

export interface ReefRaceRipSegment {
  position: ReefRaceWirePoint;
  /** Three.js Y rotation aligned to the local track tangent. */
  rot: number;
  halfLength: number;
  halfWidth: number;
}

export interface ReefRaceRipCurrentLayout {
  id: string;
  /** Center within-lap arclength fraction for bot planning. */
  progress: number;
  /** Signed offset from centerline, positive along ReefSpline.normalAt(). */
  lateralOffset: number;
  /** Additive sustained speed contribution, bounded by the normal kinetic cap. */
  speedBonus: number;
  segments: ReefRaceRipSegment[];
}

export interface ReefRaceFurnitureLayout {
  obstacles: ReefRaceObstacleLayout[];
  ripCurrents: ReefRaceRipCurrentLayout[];
}

export interface ReefRaceCreatureMotion {
  position: ReefRaceWirePoint;
  telegraph: boolean;
  crossing: boolean;
  crossingProgress: number;
}

const UINT32_RANGE = 0x1_0000_0000;
const START_CLEAN_WU = 1_800;
export const REEF_RACE_RAMP_AFTER_CLEAN_WU = 300;
const MIN_OBSTACLE_SPACING_WU = 700;

// Raw spline-t ramp anchors. Kept numeric here to avoid making shared depend on
// the API config; tests pin parity with buildSplineRamps().
export const REEF_RACE_RAMP_T_VALUES = [0.070, 0.135, 0.360, 0.450, 0.775, 0.900] as const;

type Candidate = {
  id: string;
  t: number;
  lateralFraction: number;
  sector: 0 | 1 | 2 | 3 | 4;
};

const CANDIDATES: Record<ReefRaceObstacleKind, readonly Candidate[]> = {
  kelp: [
    { id: 'k01', t: .035, lateralFraction: -.28, sector: 0 },
    { id: 'k02', t: .095, lateralFraction: .34, sector: 0 },
    { id: 'k03', t: .180, lateralFraction: -.42, sector: 0 },
    { id: 'k04', t: .245, lateralFraction: .32, sector: 1 },
    { id: 'k05', t: .315, lateralFraction: -.38, sector: 1 },
    { id: 'k06', t: .405, lateralFraction: .43, sector: 2 },
    { id: 'k07', t: .500, lateralFraction: -.31, sector: 2 },
    { id: 'k08', t: .590, lateralFraction: .39, sector: 2 },
    { id: 'k09', t: .680, lateralFraction: -.44, sector: 3 },
    { id: 'k10', t: .740, lateralFraction: .30, sector: 3 },
    { id: 'k11', t: .825, lateralFraction: -.36, sector: 4 },
    { id: 'k12', t: .955, lateralFraction: .40, sector: 4 },
  ],
  urchin: [
    { id: 'u01', t: .047, lateralFraction: .12, sector: 0 },
    { id: 'u02', t: .112, lateralFraction: -.18, sector: 0 },
    { id: 'u03', t: .205, lateralFraction: .20, sector: 1 },
    { id: 'u04', t: .286, lateralFraction: -.12, sector: 1 },
    { id: 'u05', t: .338, lateralFraction: .16, sector: 1 },
    { id: 'u06', t: .425, lateralFraction: -.20, sector: 2 },
    { id: 'u07', t: .535, lateralFraction: .14, sector: 2 },
    { id: 'u08', t: .625, lateralFraction: -.17, sector: 3 },
    { id: 'u09', t: .705, lateralFraction: .18, sector: 3 },
    { id: 'u10', t: .755, lateralFraction: -.14, sector: 3 },
    { id: 'u11', t: .850, lateralFraction: .20, sector: 4 },
    { id: 'u12', t: .970, lateralFraction: -.18, sector: 4 },
  ],
  driftwood: [
    { id: 'd01', t: .058, lateralFraction: -.25, sector: 0 },
    { id: 'd02', t: .120, lateralFraction: .24, sector: 0 },
    { id: 'd03', t: .225, lateralFraction: -.20, sector: 1 },
    { id: 'd04', t: .300, lateralFraction: .23, sector: 1 },
    { id: 'd05', t: .340, lateralFraction: -.24, sector: 1 },
    { id: 'd06', t: .435, lateralFraction: .18, sector: 2 },
    { id: 'd07', t: .565, lateralFraction: -.25, sector: 2 },
    { id: 'd08', t: .645, lateralFraction: .22, sector: 3 },
    { id: 'd09', t: .730, lateralFraction: -.22, sector: 3 },
    { id: 'd10', t: .760, lateralFraction: .24, sector: 3 },
    { id: 'd11', t: .865, lateralFraction: -.18, sector: 4 },
    { id: 'd12', t: .980, lateralFraction: .22, sector: 4 },
  ],
  creature: [
    { id: 'c01', t: .062, lateralFraction: 0, sector: 0 },
    { id: 'c02', t: .124, lateralFraction: 0, sector: 0 },
    { id: 'c03', t: .260, lateralFraction: 0, sector: 1 },
    { id: 'c04', t: .345, lateralFraction: 0, sector: 1 },
    { id: 'c05', t: .440, lateralFraction: 0, sector: 2 },
    { id: 'c06', t: .610, lateralFraction: 0, sector: 3 },
    { id: 'c07', t: .765, lateralFraction: 0, sector: 3 },
    { id: 'c08', t: .890, lateralFraction: 0, sector: 4 },
    { id: 'c09', t: .945, lateralFraction: 0, sector: 4 },
  ],
};

const RIP_CANDIDATES = [0.190, 0.325, 0.515, 0.665, 0.840, 0.965] as const;

export function deriveReefRaceSeed(roomId: string): number {
  let hash = 5381;
  for (let i = 0; i < roomId.length; i += 1) {
    hash = ((hash << 5) + hash + roomId.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

function mix(seed: number, value: string): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return hash >>> 0;
}

function circularDistance(a: number, b: number, length: number): number {
  const direct = Math.abs(a - b);
  return Math.min(direct, length - direct);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Shared absolute-clock motion contract. Each cycle is dormant first, then
 * telegraphs, then crosses; the remaining period is never treated as contact.
 */
export function reefRaceCreatureMotionAt(
  obstacle: ReefRaceCreatureObstacle,
  serverNowMs: number,
  out?: ReefRaceCreatureMotion,
): ReefRaceCreatureMotion {
  const { periodMs, telegraphMs, crossingMs, lateralSpan, direction } = obstacle.params;
  const phaseMs = obstacle.phase * periodMs;
  const cycleMs = positiveModulo(serverNowMs + phaseMs, periodMs);
  const activeStartMs = periodMs - telegraphMs - crossingMs;
  const telegraph = cycleMs >= activeStartMs && cycleMs < activeStartMs + telegraphMs;
  const crossing = cycleMs >= activeStartMs + telegraphMs;
  const crossingProgress = crossing
    ? Math.min(1, Math.max(0, (cycleMs - activeStartMs - telegraphMs) / crossingMs))
    : 0;
  const smooth = crossingProgress * crossingProgress * (3 - 2 * crossingProgress);
  const lateral = direction * (-lateralSpan / 2 + lateralSpan * smooth);
  const normalX = -Math.cos(obstacle.rot);
  const normalZ = Math.sin(obstacle.rot);
  const result = out ?? {
    position: { x: 0, y: 0 },
    telegraph: false,
    crossing: false,
    crossingProgress: 0,
  };
  result.position.x = obstacle.position.x + normalX * lateral;
  result.position.y = obstacle.position.y + normalZ * lateral;
  result.telegraph = telegraph;
  result.crossing = crossing;
  result.crossingProgress = crossingProgress;
  return result;
}

export function buildReefRaceFurniture(seedInput: number): ReefRaceFurnitureLayout {
  const seed = seedInput >>> 0 || 1;
  const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
  const rampArcs = REEF_RACE_RAMP_T_VALUES.map((t) => spline.arclengthFromT(t));
  const chosenArcs: number[] = [];

  const candidateArc = (candidate: Candidate) => spline.arclengthFromT(candidate.t);
  const cleanCandidate = (candidate: Candidate): boolean => {
    const arc = candidateArc(candidate);
    if (arc < START_CLEAN_WU) return false;
    if (rampArcs.some((rampArc) => positiveModulo(arc - rampArc, spline.totalArcLength) <= REEF_RACE_RAMP_AFTER_CLEAN_WU)) {
      return false;
    }
    return chosenArcs.every((other) => circularDistance(arc, other, spline.totalArcLength) >= MIN_OBSTACLE_SPACING_WU);
  };

  const choose = (kind: ReefRaceObstacleKind, count: number): Candidate[] => {
    const candidates = [...CANDIDATES[kind]].sort(
      (a, b) => mix(seed, `${kind}:${a.id}`) - mix(seed, `${kind}:${b.id}`),
    );
    const result: Candidate[] = [];
    const seenSectors = new Set<number>();
    for (let pass = 0; pass < 2 && result.length < count; pass += 1) {
      for (const candidate of candidates) {
        if (result.includes(candidate) || !cleanCandidate(candidate)) continue;
        if (pass === 0 && seenSectors.has(candidate.sector)) continue;
        result.push(candidate);
        seenSectors.add(candidate.sector);
        chosenArcs.push(candidateArc(candidate));
        if (result.length === count) break;
      }
    }
    if (result.length !== count) {
      throw new Error(`Unable to place ${count} ${kind} obstacles for seed ${seed}`);
    }
    return result;
  };

  const counts = {
    kelp: 4 + (mix(seed, 'kelp-count') & 1),
    urchin: 3 + (mix(seed, 'urchin-count') & 1),
    driftwood: 2 + (mix(seed, 'driftwood-count') & 1),
    creature: 1 + (mix(seed, 'creature-count') & 1),
  } as const;

  const obstacles: ReefRaceObstacleLayout[] = [];
  for (const kind of ['kelp', 'urchin', 'driftwood', 'creature'] as const) {
    for (const candidate of choose(kind, counts[kind])) {
      const center = spline.centerlineAt(candidate.t);
      const normal = spline.normalAt(candidate.t);
      const tangent = spline.tangentAt(candidate.t);
      const width = spline.widthAt(candidate.t);
      const lateral = candidate.lateralFraction * width;
      const position = {
        x: center.x + normal.x * lateral,
        y: center.z + normal.z * lateral,
      };
      const progress = spline.arclengthFromT(candidate.t) / spline.totalArcLength;
      const trackRot = Math.atan2(tangent.x, tangent.z);
      const id = `reef-${kind}-${candidate.id}`;
      if (kind === 'kelp') {
        obstacles.push({ id, kind, position, rot: trackRot, progress, phase: 0, params: { radius: 125 } });
      } else if (kind === 'urchin') {
        obstacles.push({ id, kind, position, rot: trackRot, progress, phase: 0, params: { radius: 52, clearanceHeight: 72 } });
      } else if (kind === 'driftwood') {
        obstacles.push({ id, kind, position, rot: trackRot + Math.PI / 2, progress, phase: 0, params: { halfLength: 190, halfWidth: 38, clearanceHeight: 68 } });
      } else {
        const periodMs = 20_000 + mix(seed, `${id}:period`) % 10_001;
        obstacles.push({
          id,
          kind,
          position: { x: center.x, y: center.z },
          rot: trackRot,
          progress,
          phase: mix(seed, `${id}:phase`) / UINT32_RANGE,
          params: {
            radius: 82,
            clearanceHeight: 95,
            lateralSpan: Math.max(500, width * 1.65),
            periodMs,
            telegraphMs: 2_000,
            crossingMs: 3_500 + mix(seed, `${id}:cross`) % 1_501,
            direction: (mix(seed, `${id}:direction`) & 1) === 0 ? -1 : 1,
          },
        });
      }
    }
  }

  const ripCount = 2 + (mix(seed, 'rip-count') & 1);
  const ripTs = [...RIP_CANDIDATES]
    .sort((a, b) => mix(seed, `rip:${a}`) - mix(seed, `rip:${b}`))
    .slice(0, ripCount);
  const ripCurrents = ripTs.map((t, index): ReefRaceRipCurrentLayout => {
    const before = spline.tangentAt((t - .004 + 1) % 1);
    const after = spline.tangentAt((t + .004) % 1);
    const turn = before.x * after.z - before.z * after.x;
    const width = spline.widthAt(t);
    const lateralOffset = (turn >= 0 ? -1 : 1) * Math.min(width * .62, width - 180);
    const progress = spline.arclengthFromT(t) / spline.totalArcLength;
    const segments: ReefRaceRipSegment[] = [];
    for (const deltaProgress of [-.006, 0, .006]) {
      const segmentProgress = positiveModulo(progress + deltaProgress, 1);
      const segmentT = spline.tFromArclength(segmentProgress * spline.totalArcLength);
      const center = spline.centerlineAt(segmentT);
      const normal = spline.normalAt(segmentT);
      const tangent = spline.tangentAt(segmentT);
      segments.push({
        position: {
          x: center.x + normal.x * lateralOffset,
          y: center.z + normal.z * lateralOffset,
        },
        rot: Math.atan2(tangent.x, tangent.z),
        halfLength: 380,
        halfWidth: 135,
      });
    }
    return {
      id: `reef-rip-${index}-${Math.round(t * 1000)}`,
      progress,
      lateralOffset,
      speedBonus: .18 + (mix(seed, `rip:${t}:bonus`) % 8) / 100,
      segments,
    };
  });

  return { obstacles, ripCurrents };
}
