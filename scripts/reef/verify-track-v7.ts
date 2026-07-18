/**
 * Numeric gate for the Reef Race v7 closed-loop track.
 *
 * Run from the repository root:
 *   bun scripts/reef/verify-track-v7.ts
 *
 * This intentionally imports the real shared ReefSpline/track exports and both
 * server/client placement builders. It reports every metric before failing so
 * track authors can tune one geometry pass from a complete diagnostic picture.
 */

import {
  ReefSpline,
  type Vec2,
} from '../../packages/shared/src/reef-race/spline';
import {
  REEF_RACE_DEFAULT_TRACK,
  REEF_RACE_DEFAULT_TRACK_ARC_LENGTH,
  REEF_RACE_DEFAULT_TRACK_LENGTH,
  REEF_RACE_SEGMENTS,
  REEF_RACE_TECHNICAL_ZONES,
  reefTrackBankAngleAt,
  reefTrackElevationAt,
} from '../../packages/shared/src/reef-race/track-layout';
import {
  REEF_START_GRID_COLUMN_OFFSET_WU,
  REEF_START_GRID_FRONT_ROW_BACK_WU,
  REEF_START_GRID_ROW_SPACING_WU,
  reefRaceStartGridPose,
} from '../../packages/shared/src/reef-race/start-grid';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Source-tree scripts run before packages/shared/dist exists. The API config
// correctly imports the workspace package by name in production, but its
// package export points at dist. Load that exact source module after rewriting
// only the workspace specifier to the real source entry; all builder code still
// executes from reef-race-config.ts itself.
async function importApiConfigFromSource() {
  const configPath = resolve(
    import.meta.dir,
    '../../apps/api/src/services/activity/sim/reef-race-config.ts',
  );
  const sharedSourceUrl = pathToFileURL(resolve(
    import.meta.dir,
    '../../packages/shared/src/index.ts',
  )).href;
  const source = (await Bun.file(configPath).text()).replaceAll(
    "'@clawville/shared'",
    `'${sharedSourceUrl}'`,
  );
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
  return import(moduleUrl);
}

const {
  REEF_BODY_RADIUS,
  REEF_MAX_SPEED,
  REEF_POWERUP_BOX_COUNT,
  REEF_POWERUP_RADIUS,
  buildSplineBoostPads,
  buildSplineRamps,
} = await importApiConfigFromSource();
const {
  buildSplineBoostPadsClient,
  buildSplineRampsClient,
} = await import('../../apps/web/src/lib/three/activities/reef-race/reef-race-config');

const ARC_MIN_WU = 70_000;
const ARC_MAX_WU = 96_000;
const CURVATURE_SAMPLES = 8_000;
const CURVATURE_H = 0.0005;
const RIBBON_SAMPLES = 2_400;
// Exclude only the connected local ribbon neighbourhood. This is well below a
// target 900wu-radius hairpin's ~2,827wu half-turn arc, so its opposing legs
// remain eligible as inter-passes while same-edge neighbours are not mislabeled.
const LOCAL_EDGE_EXCLUSION_ARC_WU = 1_500;
const CONTAINMENT_LOCAL_EXCLUSION_ARC_WU = 5_000;
const MIN_EDGE_CLEARANCE_WU = 300;
const MIN_CARVE_MARGIN_WU = 550;
const MIN_CP_SPACING_WU = 200;
const TECHNICAL_HW_MIN_WU = 450;
const TECHNICAL_HW_MAX_WU = 700;
const CORRIDOR_HW_MAX_WU = 1_620;
const TECHNICAL_RADIUS_MIN_WU = 900;
const TECHNICAL_RADIUS_MAX_WU = 1_300;
const BROAD_RADIUS_MIN_WU = 1_300;
const PLACEMENT_ZONE_CLEARANCE_T = 0.02;
const SEAM_CLEARANCE_T = 0.02;
const PAD_MIN_RADIUS_WU = 2_500;
const RAMP_MIN_RADIUS_WU = 1_500;
const BANK_MAX_RAD = (28 * Math.PI) / 180;
const SIM_PICKUP_COUNT = 8;

interface Point extends Vec2 {}

interface EdgeSegment {
  a: Point;
  b: Point;
  sampleIndex: number;
  side: 'left' | 'right';
}

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function cyclicT(t: number): number {
  return ((t % 1) + 1) % 1;
}

function pointInTechnicalZone(t: number): boolean {
  const u = cyclicT(t);
  return REEF_RACE_TECHNICAL_ZONES.some(
    (zone) => u >= zone.tStart && u <= zone.tEnd,
  );
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(cyclicT(a) - cyclicT(b));
  return Math.min(d, 1 - d);
}

function distanceToTechnicalZone(t: number): number {
  if (pointInTechnicalZone(t)) return 0;
  let distance = Infinity;
  for (const zone of REEF_RACE_TECHNICAL_ZONES) {
    distance = Math.min(
      distance,
      circularDistance(t, zone.tStart),
      circularDistance(t, zone.tEnd),
    );
  }
  return distance;
}

function headingAt(spline: ReefSpline, t: number): number {
  const tangent = spline.tangentAt(cyclicT(t));
  return Math.atan2(tangent.z, tangent.x);
}

function unwrapDelta(delta: number): number {
  let value = delta;
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

function curvatureAt(
  spline: ReefSpline,
  t: number,
): { radius: number; signedTurn: number } {
  const p0 = spline.centerlineAt(cyclicT(t - CURVATURE_H));
  const p1 = spline.centerlineAt(cyclicT(t));
  const p2 = spline.centerlineAt(cyclicT(t + CURVATURE_H));
  const inv2h = 1 / (2 * CURVATURE_H);
  const invH2 = 1 / (CURVATURE_H * CURVATURE_H);
  const vx = (p2.x - p0.x) * inv2h;
  const vz = (p2.z - p0.z) * inv2h;
  const ax = (p2.x - 2 * p1.x + p0.x) * invH2;
  const az = (p2.z - 2 * p1.z + p0.z) * invH2;
  const speed = Math.hypot(vx, vz);
  const signedCross = vx * az - vz * ax;
  const absCross = Math.abs(signedCross);
  const radius = absCross < 1e-9
    ? Infinity
    : (speed * speed * speed) / absCross;

  // This normalized three-point turn sign is resolution-stable for v7:
  // N=4000 and N=8000 with h=.0005 both return 40 reversals.
  const abx = p1.x - p0.x;
  const abz = p1.z - p0.z;
  const bcx = p2.x - p1.x;
  const bcz = p2.z - p1.z;
  const denom = Math.hypot(abx, abz) * Math.hypot(bcx, bcz);
  const signedTurn = denom > 1e-12
    ? (abx * bcz - abz * bcx) / denom
    : 0;
  return { radius, signedTurn };
}

function curvatureReversalCount(splineInstance: ReefSpline, sampleCount: number): number {
  let reversals = 0;
  let firstSign = 0;
  let previousSign = 0;
  for (let i = 0; i < sampleCount; i++) {
    const signedTurn = curvatureAt(splineInstance, i / sampleCount).signedTurn;
    const sign = signedTurn > 1e-7 ? 1 : signedTurn < -1e-7 ? -1 : 0;
    if (sign !== 0 && firstSign === 0) firstSign = sign;
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) reversals++;
    if (sign !== 0) previousSign = sign;
  }
  if (firstSign !== 0 && previousSign !== 0 && firstSign !== previousSign) reversals++;
  return reversals;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function pointOnSegment(a: Point, b: Point, p: Point): boolean {
  const epsilon = 1e-7;
  return Math.abs(cross(a, b, p)) <= epsilon
    && p.x >= Math.min(a.x, b.x) - epsilon
    && p.x <= Math.max(a.x, b.x) + epsilon
    && p.z >= Math.min(a.z, b.z) - epsilon
    && p.z <= Math.max(a.z, b.z) + epsilon;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  const epsilon = 1e-7;
  if (
    ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))
  ) return true;
  return (Math.abs(abC) <= epsilon && pointOnSegment(a, b, c))
    || (Math.abs(abD) <= epsilon && pointOnSegment(a, b, d))
    || (Math.abs(cdA) <= epsilon && pointOnSegment(c, d, a))
    || (Math.abs(cdB) <= epsilon && pointOnSegment(c, d, b));
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
  const u = Math.max(0, Math.min(1,
    ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq,
  ));
  return Math.hypot(p.x - (a.x + u * dx), p.z - (a.z + u * dz));
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function cyclicIndexGap(a: number, b: number, count: number): number {
  const gap = Math.abs(a - b);
  return Math.min(gap, count - gap);
}

function cyclicArcGap(a: number, b: number, totalArcLength: number): number {
  const gap = Math.abs(a - b);
  return Math.min(gap, totalArcLength - gap);
}

function arraysMatchOnPlacementFields(
  server: ReadonlyArray<{
    id: string;
    t: number;
    lateralOffset: number;
    halfLength: number;
    halfWidth: number;
  }>,
  client: ReadonlyArray<{
    id: string;
    t: number;
    lateralOffset: number;
    halfLength: number;
    halfWidth: number;
  }>,
): boolean {
  return server.length === client.length && server.every((entry, index) => {
    const mirror = client[index];
    return mirror !== undefined
      && entry.id === mirror.id
      && entry.t === mirror.t
      && entry.lateralOffset === mirror.lateralOffset
      && entry.halfLength === mirror.halfLength
      && entry.halfWidth === mirror.halfWidth;
  });
}

const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
const arc = spline.totalArcLength;

console.log('Reef Race v7 track verification');
console.log('================================');
console.log(`control points                 = ${REEF_RACE_DEFAULT_TRACK.length}`);
console.log(`total arc length               = ${arc.toFixed(1)} wu`);
check(arc >= ARC_MIN_WU && arc <= ARC_MAX_WU,
  `total arc ${arc.toFixed(1)} is outside [${ARC_MIN_WU}, ${ARC_MAX_WU}] wu`);
check(REEF_RACE_DEFAULT_TRACK.length === REEF_RACE_DEFAULT_TRACK_LENGTH,
  `track length export ${REEF_RACE_DEFAULT_TRACK_LENGTH} != actual ${REEF_RACE_DEFAULT_TRACK.length}`);
check(Math.abs(arc - REEF_RACE_DEFAULT_TRACK_ARC_LENGTH) < 0.1,
  `arc export ${REEF_RACE_DEFAULT_TRACK_ARC_LENGTH} != real spline ${arc.toFixed(3)}`);

const cpParameters = REEF_RACE_DEFAULT_TRACK.map((cp) =>
  spline.closestPointOnSpline(cp).t);
const nearestCpBoundary = (boundaryT: number) => {
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < cpParameters.length; i++) {
    const delta = circularDistance(boundaryT, cpParameters[i]);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return { index: bestIndex, delta: bestDelta };
};
console.log('themed segment ranges:');
for (let i = 0; i < REEF_RACE_SEGMENTS.length; i++) {
  const segment = REEF_RACE_SEGMENTS[i];
  const startCp = nearestCpBoundary(segment.tStart);
  const endCp = nearestCpBoundary(segment.tEnd);
  const segmentArc = spline.arclengthFromT(segment.tEnd)
    - spline.arclengthFromT(segment.tStart);
  const antiCheatFloorMs = segmentArc / REEF_MAX_SPEED * 0.7 * 1_000;
  console.log(
    `  ${segment.id.padEnd(10)} t=[${segment.tStart.toFixed(4)}, ${segment.tEnd.toFixed(4)}] `
      + `CP${startCp.index}->CP${endCp.index}, arc=${segmentArc.toFixed(1)}wu, `
      + `floor=${antiCheatFloorMs.toFixed(0)}ms`,
  );
  check(segment.tEnd > segment.tStart,
    `segment ${segment.id} has non-positive t range`);
  check(startCp.delta <= 0.00015 && endCp.delta <= 0.00015,
    `segment ${segment.id} boundary is not CP-pinned (deltas ${startCp.delta}, ${endCp.delta})`);
  if (i > 0) {
    check(segment.tStart === REEF_RACE_SEGMENTS[i - 1].tEnd,
      `segment ${segment.id} is not contiguous with ${REEF_RACE_SEGMENTS[i - 1].id}`);
  }
}
check(REEF_RACE_SEGMENTS[0]?.tStart === 0, 'first themed segment does not start at t=0');
check(REEF_RACE_SEGMENTS.at(-1)?.tEnd === 1, 'last themed segment does not end at t=1');

let headingSweep = 0;
let previousHeading = headingAt(spline, 0);
for (let i = 1; i <= CURVATURE_SAMPLES; i++) {
  const currentHeading = headingAt(spline, i / CURVATURE_SAMPLES);
  headingSweep += unwrapDelta(currentHeading - previousHeading);
  previousHeading = currentHeading;
}
console.log(`heading sweep                   = ${(headingSweep / Math.PI).toFixed(6)} pi`);
check(Math.abs(headingSweep - 2 * Math.PI) < 0.02,
  `heading sweep ${(headingSweep / Math.PI).toFixed(6)}pi is not +2pi`);

let minRadius = Infinity;
let minRadiusT = 0;
let minBroadRadius = Infinity;
let minBroadRadiusT = 0;
let minCarveMargin = Infinity;
let minCarveMarginT = 0;
let widthMin = Infinity;
let widthMax = -Infinity;
const technicalStats = REEF_RACE_TECHNICAL_ZONES.map((zone) => ({
  ...zone,
  minRadius: Infinity,
  minRadiusT: zone.tStart,
  minWidth: Infinity,
  maxWidth: -Infinity,
}));

for (let i = 0; i < CURVATURE_SAMPLES; i++) {
  const t = i / CURVATURE_SAMPLES;
  const width = spline.widthAt(t);
  const { radius, signedTurn } = curvatureAt(spline, t);
  const carveMargin = radius - width;
  widthMin = Math.min(widthMin, width);
  widthMax = Math.max(widthMax, width);
  if (radius < minRadius) {
    minRadius = radius;
    minRadiusT = t;
  }
  if (!pointInTechnicalZone(t) && radius < minBroadRadius) {
    minBroadRadius = radius;
    minBroadRadiusT = t;
  }
  if (carveMargin < minCarveMargin) {
    minCarveMargin = carveMargin;
    minCarveMarginT = t;
  }
  void signedTurn;

  for (const stat of technicalStats) {
    if (t < stat.tStart || t > stat.tEnd) continue;
    stat.minWidth = Math.min(stat.minWidth, width);
    stat.maxWidth = Math.max(stat.maxWidth, width);
    if (radius < stat.minRadius) {
      stat.minRadius = radius;
      stat.minRadiusT = t;
    }
  }
}
const reversals = curvatureReversalCount(spline, CURVATURE_SAMPLES);
const halfSampleReversals = curvatureReversalCount(spline, CURVATURE_SAMPLES / 2);

console.log(`sampled half-width range        = [${widthMin.toFixed(1)}, ${widthMax.toFixed(1)}] wu`);
console.log(`minimum radius overall          = ${minRadius.toFixed(1)} wu @ t=${minRadiusT.toFixed(5)}`);
console.log(`minimum radius broad sections   = ${minBroadRadius.toFixed(1)} wu @ t=${minBroadRadiusT.toFixed(5)}`);
for (const stat of technicalStats) {
  console.log(
    `technical ${stat.id.padEnd(12)}         = t=[${stat.tStart.toFixed(4)}, ${stat.tEnd.toFixed(4)}], `
      + `minR=${stat.minRadius.toFixed(1)} @ ${stat.minRadiusT.toFixed(5)}, `
      + `hw=[${stat.minWidth.toFixed(1)}, ${stat.maxWidth.toFixed(1)}]`,
  );
  check(Number.isFinite(stat.minRadius), `${stat.id} contains no curvature samples`);
  check(
    stat.minRadius >= TECHNICAL_RADIUS_MIN_WU
      && stat.minRadius <= TECHNICAL_RADIUS_MAX_WU,
    `${stat.id} minimum radius ${stat.minRadius.toFixed(1)} outside `
      + `[${TECHNICAL_RADIUS_MIN_WU}, ${TECHNICAL_RADIUS_MAX_WU}]`,
  );
  check(stat.minWidth >= TECHNICAL_HW_MIN_WU,
    `${stat.id} minimum width ${stat.minWidth.toFixed(1)} < ${TECHNICAL_HW_MIN_WU}`);
  check(stat.minWidth <= TECHNICAL_HW_MAX_WU,
    `${stat.id} never pinches to <= ${TECHNICAL_HW_MAX_WU} wu`);
}
console.log(`minimum carve margin R-hw       = ${minCarveMargin.toFixed(1)} wu @ t=${minCarveMarginT.toFixed(5)}`);
console.log(`curvature reversals             = ${reversals} (N=${CURVATURE_SAMPLES}), ${halfSampleReversals} (N=${CURVATURE_SAMPLES / 2}), h=${CURVATURE_H}`);
check(minCarveMargin > MIN_CARVE_MARGIN_WU,
  `minimum carve margin ${minCarveMargin.toFixed(2)} <= ${MIN_CARVE_MARGIN_WU}`);
check(widthMin >= TECHNICAL_HW_MIN_WU,
  `global half-width ${widthMin.toFixed(1)} < ${TECHNICAL_HW_MIN_WU}`);
check(widthMax <= CORRIDOR_HW_MAX_WU,
  `global half-width ${widthMax.toFixed(1)} > ${CORRIDOR_HW_MAX_WU}`);
check(minBroadRadius >= BROAD_RADIUS_MIN_WU,
  `minimum broad-section radius ${minBroadRadius.toFixed(1)} < ${BROAD_RADIUS_MIN_WU}`);
check(reversals >= 36 && reversals <= 42,
  `curvature reversals ${reversals} outside [36, 42]`);
check(reversals === halfSampleReversals,
  `curvature reversal count is sample-unstable: ${reversals} at N=${CURVATURE_SAMPLES}, `
    + `${halfSampleReversals} at N=${CURVATURE_SAMPLES / 2}`);

let minCpSpacing = Infinity;
let minCpPair = '';
for (let i = 0; i < REEF_RACE_DEFAULT_TRACK.length; i++) {
  const a = REEF_RACE_DEFAULT_TRACK[i];
  const b = REEF_RACE_DEFAULT_TRACK[(i + 1) % REEF_RACE_DEFAULT_TRACK.length];
  const spacing = Math.hypot(b.x - a.x, b.z - a.z);
  if (spacing < minCpSpacing) {
    minCpSpacing = spacing;
    minCpPair = `CP${i}->CP${(i + 1) % REEF_RACE_DEFAULT_TRACK.length}`;
  }
}
console.log(`minimum adjacent-CP spacing     = ${minCpSpacing.toFixed(1)} wu (${minCpPair})`);
check(minCpSpacing > MIN_CP_SPACING_WU,
  `adjacent CP spacing ${minCpSpacing.toFixed(1)} <= ${MIN_CP_SPACING_WU}`);

const centers: Point[] = [];
const left: Point[] = [];
const right: Point[] = [];
const sampleArcs: number[] = [];
const sampleWidths: number[] = [];
const sampleTangents: Point[] = [];
for (let i = 0; i < RIBBON_SAMPLES; i++) {
  const t = i / RIBBON_SAMPLES;
  const center = spline.centerlineAt(t);
  const normal = spline.normalAt(t);
  const tangent = spline.tangentAt(t);
  const width = spline.widthAt(t);
  centers.push(center);
  left.push({ x: center.x + normal.x * width, z: center.z + normal.z * width });
  right.push({ x: center.x - normal.x * width, z: center.z - normal.z * width });
  sampleArcs.push(spline.arclengthFromT(t));
  sampleWidths.push(width);
  sampleTangents.push(tangent);
}

let centerlineIntersections = 0;
let containedRibbonOverlaps = 0;
for (let i = 0; i < RIBBON_SAMPLES; i++) {
  const a = centers[i];
  const b = centers[(i + 1) % RIBBON_SAMPLES];
  for (let j = i + 1; j < RIBBON_SAMPLES; j++) {
    if (cyclicIndexGap(i, j, RIBBON_SAMPLES) <= 1) continue;
    const c = centers[j];
    const d = centers[(j + 1) % RIBBON_SAMPLES];
    if (segmentsIntersect(a, b, c, d)) centerlineIntersections++;
  }

  // Boundary intersections catch ordinary ribbon crossings. This additional
  // test catches the no-boundary-crossing case where a narrow pass is wholly
  // contained inside a wider non-local pass: its centerline point lies inside
  // the other segment's linearly interpolated half-width.
  for (let j = 0; j < RIBBON_SAMPLES; j++) {
    const arcGap = cyclicArcGap(sampleArcs[i], sampleArcs[j], arc);
    if (arcGap <= LOCAL_EDGE_EXCLUSION_ARC_WU) continue;
    const c = centers[j];
    const d = centers[(j + 1) % RIBBON_SAMPLES];
    const dx = d.x - c.x;
    const dz = d.z - c.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq <= 1e-12) continue;
    const u = Math.max(0, Math.min(1,
      ((a.x - c.x) * dx + (a.z - c.z) * dz) / lengthSq,
    ));
    const projected = { x: c.x + u * dx, z: c.z + u * dz };
    const distance = Math.hypot(a.x - projected.x, a.z - projected.z);
    const widthJ = sampleWidths[j]
      + (sampleWidths[(j + 1) % RIBBON_SAMPLES] - sampleWidths[j]) * u;
    const tangentI = sampleTangents[i];
    const tangentJ = sampleTangents[j];
    const tangentDot = tangentI.x * tangentJ.x + tangentI.z * tangentJ.z;
    // Connected ribbon neighbourhoods remain spatially inside their own wide
    // strip for several thousand wu. Exclude that same-direction topology, but
    // never exclude the opposing legs of a hairpin (negative tangent dot).
    if (
      arcGap <= CONTAINMENT_LOCAL_EXCLUSION_ARC_WU
      && tangentDot >= 0
    ) continue;
    if (distance < widthJ - 1e-6) containedRibbonOverlaps++;
  }
}

const edgeSets: ReadonlyArray<{ side: 'left' | 'right'; points: Point[] }> = [
  { side: 'left', points: left },
  { side: 'right', points: right },
];
let ribbonEdgeIntersections = 0;
let minEdgeClearance = Infinity;
let minEdgePair = '';
for (let edgeA = 0; edgeA < edgeSets.length; edgeA++) {
  for (let edgeB = edgeA; edgeB < edgeSets.length; edgeB++) {
    const setA = edgeSets[edgeA];
    const setB = edgeSets[edgeB];
    for (let i = 0; i < RIBBON_SAMPLES; i++) {
      const segmentA: EdgeSegment = {
        a: setA.points[i],
        b: setA.points[(i + 1) % RIBBON_SAMPLES],
        sampleIndex: i,
        side: setA.side,
      };
      const jStart = edgeA === edgeB ? i + 1 : 0;
      for (let j = jStart; j < RIBBON_SAMPLES; j++) {
        const localIndexGap = cyclicIndexGap(i, j, RIBBON_SAMPLES);
        if (edgeA === edgeB && localIndexGap <= 1) continue;
        const segmentB: EdgeSegment = {
          a: setB.points[j],
          b: setB.points[(j + 1) % RIBBON_SAMPLES],
          sampleIndex: j,
          side: setB.side,
        };
        if (segmentsIntersect(segmentA.a, segmentA.b, segmentB.a, segmentB.b)) {
          ribbonEdgeIntersections++;
        }
        const arcGap = cyclicArcGap(sampleArcs[i], sampleArcs[j], arc);
        if (arcGap <= LOCAL_EDGE_EXCLUSION_ARC_WU) continue;
        const clearance = segmentDistance(
          segmentA.a,
          segmentA.b,
          segmentB.a,
          segmentB.b,
        );
        if (clearance < minEdgeClearance) {
          minEdgeClearance = clearance;
          minEdgePair = `${segmentA.side}@${(i / RIBBON_SAMPLES).toFixed(4)}~`
            + `${segmentB.side}@${(j / RIBBON_SAMPLES).toFixed(4)}`;
        }
      }
    }
  }
}
const xzSelfOverlaps = centerlineIntersections
  + ribbonEdgeIntersections
  + containedRibbonOverlaps;
console.log(`XZ self-overlaps               = ${xzSelfOverlaps} (centerline=${centerlineIntersections}, ribbonEdges=${ribbonEdgeIntersections}, contained=${containedRibbonOverlaps})`);
console.log(`minimum inter-pass edge clear. = ${minEdgeClearance.toFixed(1)} wu @ ${minEdgePair} (local arc exclusion ${LOCAL_EDGE_EXCLUSION_ARC_WU} wu)`);
check(xzSelfOverlaps === 0, `XZ self-overlaps = ${xzSelfOverlaps}`);
check(minEdgeClearance > MIN_EDGE_CLEARANCE_WU,
  `inter-pass edge clearance ${minEdgeClearance.toFixed(1)} <= ${MIN_EDGE_CLEARANCE_WU}`);

const elevationH = 1e-5;
const y0 = reefTrackElevationAt(0);
const y1 = reefTrackElevationAt(1);
const slope0 = (reefTrackElevationAt(elevationH) - reefTrackElevationAt(-elevationH))
  / (2 * elevationH);
const slope1 = (reefTrackElevationAt(1 + elevationH) - reefTrackElevationAt(1 - elevationH))
  / (2 * elevationH);
let maxGrade = 0;
let maxGradeT = 0;
let previousY = y0;
let previousArc = 0;
for (let i = 1; i <= CURVATURE_SAMPLES; i++) {
  const t = i / CURVATURE_SAMPLES;
  const y = reefTrackElevationAt(t);
  const s = spline.arclengthFromT(t);
  const ds = s - previousArc;
  if (ds > 1e-9) {
    const grade = Math.abs(y - previousY) / ds;
    if (grade > maxGrade) {
      maxGrade = grade;
      maxGradeT = t;
    }
  }
  previousY = y;
  previousArc = s;
}
console.log(`elevation seam Y delta          = ${Math.abs(y1 - y0).toExponential(3)} wu`);
console.log(`elevation seam slope delta      = ${Math.abs(slope1 - slope0).toExponential(3)} wu/t`);
console.log(`maximum elevation grade         = ${(maxGrade * 100).toFixed(2)}% @ t=${maxGradeT.toFixed(5)}`);
check(Math.abs(y1 - y0) < 1e-6, `elevation seam Y delta ${Math.abs(y1 - y0)}`);
check(Math.abs(slope1 - slope0) < 1e-3,
  `elevation seam slope delta ${Math.abs(slope1 - slope0)}`);
check(maxGrade < 0.20, `maximum elevation grade ${(maxGrade * 100).toFixed(2)}% >= 20%`);

const widthDerivativeH = 1e-6;
const widthSlopeBefore = (spline.widthAt(1) - spline.widthAt(1 - widthDerivativeH))
  / widthDerivativeH;
const widthSlopeAfter = (spline.widthAt(widthDerivativeH) - spline.widthAt(0))
  / widthDerivativeH;
const widthSlopeRelativeDelta = Math.abs(widthSlopeAfter - widthSlopeBefore)
  / Math.max(1, Math.abs(widthSlopeAfter), Math.abs(widthSlopeBefore));
console.log(`width seam value delta          = ${Math.abs(spline.widthAt(1) - spline.widthAt(0)).toExponential(3)} wu`);
console.log(`width seam slope delta          = ${Math.abs(widthSlopeAfter - widthSlopeBefore).toExponential(3)} wu/t (${(100 * widthSlopeRelativeDelta).toFixed(4)}%)`);
check(Math.abs(spline.widthAt(1) - spline.widthAt(0)) < 1e-6, 'width is discontinuous at seam');
check(widthSlopeRelativeDelta < 0.005,
  `width seam relative slope delta ${(100 * widthSlopeRelativeDelta).toFixed(4)}% is not C1`);

const serverPads = buildSplineBoostPads();
const clientPads = buildSplineBoostPadsClient();
const serverRamps = buildSplineRamps();
const clientRamps = buildSplineRampsClient();
check(arraysMatchOnPlacementFields(serverPads, clientPads),
  'server/client boost-pad placement mirrors differ');
check(arraysMatchOnPlacementFields(serverRamps, clientRamps),
  'server/client ramp placement mirrors differ');
console.log(`placement mirror parity         = pads ${serverPads.length}/${clientPads.length}, ramps ${serverRamps.length}/${clientRamps.length}`);
for (const [kind, placements] of [
  ['pad', serverPads] as const,
  ['ramp', serverRamps] as const,
]) {
  for (const placement of placements) {
    const seamDistance = Math.min(cyclicT(placement.t), 1 - cyclicT(placement.t));
    const zoneDistance = distanceToTechnicalZone(placement.t);
    const radius = curvatureAt(spline, placement.t).radius;
    console.log(
      `${kind.padEnd(5)} ${placement.id.padEnd(18)} t=${placement.t.toFixed(4)} `
        + `zoneGap=${zoneDistance.toFixed(4)} seamGap=${seamDistance.toFixed(4)} `
        + `R=${radius.toFixed(0)} hw=${spline.widthAt(placement.t).toFixed(0)}`,
    );
    check(zoneDistance >= PLACEMENT_ZONE_CLEARANCE_T,
      `${kind} ${placement.id} is inside/within ${PLACEMENT_ZONE_CLEARANCE_T}t of a technical zone`);
    check(seamDistance > SEAM_CLEARANCE_T,
      `${kind} ${placement.id} is within ${SEAM_CLEARANCE_T}t of the seam`);
    const minimumPlacementRadius = kind === 'pad'
      ? PAD_MIN_RADIUS_WU
      : RAMP_MIN_RADIUS_WU;
    check(radius >= minimumPlacementRadius,
      `${kind} ${placement.id} radius ${radius.toFixed(1)} < broad-placement floor ${minimumPlacementRadius}`);
  }
}

check(REEF_POWERUP_BOX_COUNT === SIM_PICKUP_COUNT,
  `config pickup count ${REEF_POWERUP_BOX_COUNT} differs from spline sim's fixed ${SIM_PICKUP_COUNT}`);
let minimumPickupInset = Infinity;
for (let i = 0; i < SIM_PICKUP_COUNT; i++) {
  const t = (i + 0.5) / SIM_PICKUP_COUNT;
  const width = spline.widthAt(t);
  const lateralOffset = Math.min(width * 0.5, 40);
  const inset = width - lateralOffset - REEF_POWERUP_RADIUS;
  minimumPickupInset = Math.min(minimumPickupInset, inset);
  check(inset > 0, `pickup ${i} extends outside corridor at t=${t.toFixed(4)}`);
}
console.log(`pickup lateral-fit min inset    = ${minimumPickupInset.toFixed(1)} wu (${SIM_PICKUP_COUNT} boxes, radius ${REEF_POWERUP_RADIUS})`);

const startCenter = spline.centerlineAt(0);
const startTangent = spline.tangentAt(0);
const startNormal = spline.normalAt(0);
let minimumGridInset = Infinity;
let minimumGridTangentDot = 1;
for (let i = 0; i < 8; i++) {
  const pose = reefRaceStartGridPose({
    center: startCenter,
    tangent: startTangent,
    normal: startNormal,
  }, i);
  const closest = spline.closestPointOnSpline({ x: pose.x, z: pose.z });
  const inset = spline.widthAt(closest.t) - closest.distance - REEF_BODY_RADIUS;
  minimumGridInset = Math.min(minimumGridInset, inset);
  const localTangent = spline.tangentAt(closest.t);
  const tangentDot = startTangent.x * localTangent.x + startTangent.z * localTangent.z;
  minimumGridTangentDot = Math.min(minimumGridTangentDot, tangentDot);
  check(inset > 0, `start-grid slot ${i} falls outside corridor by ${(-inset).toFixed(1)} wu`);
  check(tangentDot > Math.cos((15 * Math.PI) / 180),
    `start-grid slot ${i} sits beyond straight seam approach (tangent dot ${tangentDot.toFixed(4)})`);
}
console.log(`start-grid minimum inset         = ${minimumGridInset.toFixed(1)} wu`);
console.log(`start-grid minimum tangent dot   = ${minimumGridTangentDot.toFixed(6)} (8 slots, +/-${REEF_START_GRID_COLUMN_OFFSET_WU}wu, rear=${REEF_START_GRID_FRONT_ROW_BACK_WU + 3 * REEF_START_GRID_ROW_SPACING_WU}wu)`);

let maximumBank = 0;
let saturatedBankSamples = 0;
let invalidBankSamples = 0;
for (let i = 0; i < CURVATURE_SAMPLES; i++) {
  const t = i / CURVATURE_SAMPLES;
  const bank = Math.abs(reefTrackBankAngleAt(t, (tt) => headingAt(spline, tt)));
  maximumBank = Math.max(maximumBank, bank);
  if (bank >= BANK_MAX_RAD - 1e-6) saturatedBankSamples++;
  if (!Number.isFinite(bank) || bank > BANK_MAX_RAD + 1e-6) invalidBankSamples++;
}
console.log(`bank max / saturation            = ${(maximumBank * 180 / Math.PI).toFixed(2)} deg / ${saturatedBankSamples}/${CURVATURE_SAMPLES} samples (${(100 * saturatedBankSamples / CURVATURE_SAMPLES).toFixed(2)}%)`);
check(invalidBankSamples === 0,
  `${invalidBankSamples} bank samples were non-finite or exceeded the 28-degree clamp`);

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length} assertion${failures.length === 1 ? '' : 's'}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: all Reef Race v7 numeric gates satisfied.');
}
