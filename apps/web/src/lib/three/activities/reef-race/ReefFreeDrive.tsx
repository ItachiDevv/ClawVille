'use client';

/**
 * ReefFreeDrive.tsx — CLIENT-ONLY free-drive sandbox for tuning the surf DRIVING FEEL.
 *
 * DEV TOOL, mounted only on /preview/reef-race-v2?mode=drive. You drive ONE kart with
 * the keyboard via the SAME shared `integrateSurfStep` model the real race uses for
 * server sim + client prediction, on the REAL spline track, with a chase camera — so
 * the handling here feels identical to the real race's prediction. No server: this is
 * a handling/feel workbench, not netcode. Tune via the physics-tuner panel
 * (REEF_PHYSICS_TUNING), then bake the values into reef-race-config.ts.
 *
 * Controls: A/D or ←/→ steer · auto-thrust · S brake · Shift = drift-charge mini-turbo
 * (HOLD while turning to charge, RELEASE for an instant speed kick; tiers 1/2/3) ·
 * Space = board-whip (swing the tail, recoil + bump the rival kart riding beside you).
 *
 * Board: the surfboard GLB is authored STANDING UP, so it's auto-oriented FLAT at build
 * via its bounding box (longest axis → forward +Z, thinnest axis → up +Y) inside a pivot;
 * the pivot then yaws/pitches(wave-slope)/banks each frame. It rides the actual WATER
 * SURFACE (datum + the shader's Gerstner heave via reef-wave-height.ts) so it sits ON
 * the water, not under it. Off-track (lateral > widthAt(t)+margin) FALLS into the void +
 * respawns at the last safe centerline point (Rainbow-Road time penalty).
 *
 * Colours: the GLB shares ONE material instance across clones, so each board CLONES its
 * material before tinting (else the last colour wins on both). Player = hot magenta (the
 * old cyan was invisible on cyan water); its emissive ramps with the drift charge + flashes
 * on boost — the drift's only visual feedback. Rival = coral.
 *
 * The rival kart LOCKS to a slot beside+ahead of you every tick (always within whipReach,
 * so the whip-bump actually connects — the old 5%/tick ease let it lag ~700wu behind a
 * fast player); a whip adds a transient knock offset that decays back to the slot. SCOPE:
 * whip-bump + off-track reset are FEEL prototypes (client-only); authoritative multiplayer
 * versions are a later sim job.
 *
 * FLUIDITY: the sim steps at a fixed 30Hz but the scene renders at ~240fps, so the board
 * is rendered at the INTERPOLATED pose between the previous and current sim state (alpha =
 * accum/TICK_DT) — board, rival, rotation, and chase camera all read the lerped pose.
 * Without it the board slides in ~8-frame jumps (the "glitchy motion"). Spawn/respawn
 * teleports snap (no slide) for one frame.
 *
 * Iris-Xe: surfboard GLB clones (no ShaderMaterial), import 'three', module-scope
 * scratch vectors/colours (no per-frame `new THREE.Vector3`), frustumCulled=false. The
 * dev debug hook is gated on `window.__REEF_ON` and writes reused objects (no GC).
 */

import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

import { integrateSurfStep, type SurfBodyState } from '@clawville/shared';
import { clientSpline } from './reef-race-spline-instance';
import { tAtXZ, elevationAtT, bankedDatumYAtT, forgetTKey } from './reef-race-elevation';
import { surfWaveHeightAt } from './reef-wave-height';
import { REEF_PHYSICS_TUNING as T } from './reef-physics-tuning';

const SURFBOARD = '/models/reef-race/surfboards/surfboard_1.glb';
useGLTF.preload(SURFBOARD);

const TICK_DT = 1 / 30;
const MAX_ACCUM = 0.25;
const STEER_TARGET_OFFSET = 0.7;

const FALL_TICKS = 34;
const FALL_DEPTH = 1100;

const PITCH_HALF_LEN = 120;  // ≈ half the board's length (wu) — sample the wave at nose & tail
const ROLL_HALF_WIDTH = 36;  // ≈ half the board's width (wu) — sample the wave at left & right rail
const PITCH_CLAMP = 0.6;     // ±34° — room for the nose-up trim + wave tip
const ROLL_CLAMP = 0.8;      // ±46° — room for track-bank + wave cross-slope
const DEG2RAD = 0.0174532925;

const CAM_LERP = 6.0;
const CAM_LOOK_UP = 60;

const RIVAL_LATERAL = 200;   // wu beside the player the rival rides (within whipReach)
const RIVAL_AHEAD = 40;

const _camWanted = new THREE.Vector3();
const _camLook = new THREE.Vector3();

// Drift-charge / boost emissive ramp (player board glows brighter + whiter as the
// mini-turbo charges, then flashes on boost — the only visual feedback the drift had).
const _emBase = new THREE.Color('#ff2bd6'); // player rest emissive (magenta)
const _emHot = new THREE.Color('#ffffff');  // hot-charge / boost flash target
const _emTmp = new THREE.Color();

// DEV debug hook — gated on `window.__REEF_ON` (off by default → zero hot-path cost),
// writes into REUSED module objects (no per-frame allocation / GC). The verify harness
// sets __REEF_ON then reads window.__REEF / __REEFOBJ.
const _dbg = {
  mounted: true,
  pred: { x: 0, z: 0, vx: 0, vz: 0, rot: 0, speed: 0 },
  dummy: { x: 0, z: 0 }, t: 0, alpha: 0,
  falling: false, fallTicks: 0, lastSafeT: 0,
  driftCharge: 0, boostTicks: 0, boostMult: 1, whipCd: 0, whipSwing: 0,
  boardPos: [0, 0, 0], boardEulerDeg: [0, 0, 0], boardScale: 0,
  camPos: [0, 0, 0], camToBoard: 0, surfaceY: 0, rideHeight: 0,
};
const _dbgObj: { player: unknown; dummy: unknown; camera: unknown; scene: unknown } =
  { player: null, dummy: null, camera: null, scene: null };
type ReefDebugWindow = { __REEF_ON?: boolean; __REEF?: unknown; __REEFOBJ?: unknown };
const RAD2DEG = 57.29578;

// Surf-conforming board tilt at world (x,z) facing `rot`, on spline `t`, at `time`.
// PITCH (fore-aft): the wave-surface slope nose→tail + a baseline nose-up trim, so it
// planes like a surfboard. ROLL (lateral): the wave-surface slope left→right rail PLUS
// the track bank, so the board leans with the wave's cross-slope AND into banked turns.
// Both gained by T.pitchWaveGain. Reused scratch (no per-call alloc). Used by BOTH boards.
const _tiltOut = { pitch: 0, roll: 0 };
function surfTilt(x: number, z: number, rot: number, t: number, time: number, angVel: number): { pitch: number; roll: number } {
  const fX = Math.sin(rot), fZ = Math.cos(rot);   // forward
  const rX = Math.cos(rot), rZ = -Math.sin(rot);  // right
  // PITCH — nose vs tail (rotation.x<0 = nose up; wave term + trim both subtract)
  const hNose = surfWaveHeightAt(x + fX * PITCH_HALF_LEN, z + fZ * PITCH_HALF_LEN, time);
  const hTail = surfWaveHeightAt(x - fX * PITCH_HALF_LEN, z - fZ * PITCH_HALF_LEN, time);
  let pitch = -Math.atan2(hNose - hTail, 2 * PITCH_HALF_LEN) * T.pitchWaveGain - T.pitchTrimDeg * DEG2RAD;
  if (pitch < -PITCH_CLAMP) pitch = -PITCH_CLAMP; else if (pitch > PITCH_CLAMP) pitch = PITCH_CLAMP;
  // ROLL — CONFORM to the FULL water surface (banked datum + wave). Sample the actual
  // surface height at the board's left & right rails and tilt so the board lies FLAT on
  // the lateral slope (water lower on the right ⇒ right rail DOWN). This replaces the old
  // wave-only + separate bankAngle terms, which lived in different frames and ANTI-conformed
  // (board tilted opposite the water). Sign verified vs the rendered mesh: rotation.z<0 =
  // right rail UP, so conforming to down-right water needs +roll ⇒ roll = -atan2(sR - sL).
  const rxR = x + rX * ROLL_HALF_WIDTH, rzR = z + rZ * ROLL_HALF_WIDTH;
  const rxL = x - rX * ROLL_HALF_WIDTH, rzL = z - rZ * ROLL_HALF_WIDTH;
  const sRight = bankedDatumYAtT(rxR, rzR, t) + surfWaveHeightAt(rxR, rzR, time);
  const sLeft  = bankedDatumYAtT(rxL, rzL, t) + surfWaveHeightAt(rxL, rzL, time);
  // Sign verified clean (board width-axis Y vs water cross-slope): roll<0 = right rail UP,
  // so conforming to down-right water (sRight<sLeft) needs roll<0 ⇒ roll = +atan2(sR - sL).
  let roll = Math.atan2(sRight - sLeft, 2 * ROLL_HALF_WIDTH)    // conform: lie flat on the slope
           + angVel * T.turnLeanGain;                           // optional lean INTO the carve (default 0)
  if (roll < -ROLL_CLAMP) roll = -ROLL_CLAMP; else if (roll > ROLL_CLAMP) roll = ROLL_CLAMP;
  _tiltOut.pitch = pitch; _tiltOut.roll = roll;
  return _tiltOut;
}

/** Rival state. (x,z) is the rendered position = its slot beside the player PLUS a
 *  transient (bx,bz) knock offset; (vx,vz) is the whip-bump velocity feeding the offset. */
interface DummyState { x: number; z: number; vx: number; vz: number; bx: number; bz: number; }

/**
 * Build the base quaternion that lays an arbitrarily-authored board FLAT + nose-forward:
 * map its longest local axis → world +Z (forward) and its thinnest → world +Y (up).
 * Robust to however the GLB was authored (this one stands vertical).
 */
function boardBaseQuat(size: THREE.Vector3): THREE.Quaternion {
  const dims = [size.x, size.y, size.z];
  const longI = dims.indexOf(Math.max(dims[0], dims[1], dims[2]));
  const thinI = dims.indexOf(Math.min(dims[0], dims[1], dims[2]));
  const midI = 3 - longI - thinI;
  const world: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  world[longI].set(0, 0, 1);  // longest → forward
  world[thinI].set(0, 1, 0);  // thinnest → up
  world[midI].set(1, 0, 0);   // remaining → right
  const m = new THREE.Matrix4().makeBasis(world[0], world[1], world[2]);
  if (m.determinant() < 0) { world[midI].multiplyScalar(-1); m.makeBasis(world[0], world[1], world[2]); }
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export function ReefFreeDrive() {
  const { scene: src } = useGLTF(SURFBOARD);
  const { camera } = useThree();

  const playerRef = useRef<THREE.Object3D | null>(null);   // pivot
  const dummyObjRef = useRef<THREE.Object3D | null>(null); // pivot
  const groupRef = useRef<THREE.Group>(null);

  const pred = useRef<SurfBodyState>({ x: 0, z: 0, vx: 0, vz: 0, rot: 0 });
  const accum = useRef(0);
  const keys = useRef<Record<string, boolean>>({});
  const driftCharge = useRef(0);
  const boostTicks = useRef(0);
  const boostMult = useRef(1);
  const whipCd = useRef(0);
  const whipSwing = useRef(0);
  const whipSide = useRef(1);
  const spacePrev = useRef(false);
  const dummy = useRef<DummyState>({ x: 0, z: 0, vx: 0, vz: 0, bx: 0, bz: 0 });
  const playerMats = useRef<THREE.MeshStandardMaterial[]>([]);
  const camInit = useRef(false);
  const falling = useRef(false);
  const fallTicks = useRef(0);
  const lastSafeT = useRef(0);
  // Render interpolation: the state each fixed 30Hz step integrates FROM, lerped toward
  // the post-step state by alpha=accum/TICK_DT so the ~240fps render is smooth (the sim
  // only advances 30×/s; without this the board slides in ~8-frame jumps = the glitch).
  const prevSelf = useRef({ x: 0, z: 0, rot: 0 });
  const prevDummy = useRef({ x: 0, z: 0 });
  const snapRender = useRef(true); // skip interpolation for 1 frame after spawn/respawn (teleport)

  useEffect(() => {
    const group = groupRef.current;
    if (!group || !src) return;
    while (group.children.length > 0) group.remove(group.children[0]);

    playerMats.current = [];
    const mk = (hex: string, isPlayer: boolean): THREE.Object3D => {
      const clone = src.clone(true);
      const col = new THREE.Color(hex);
      clone.traverse((c) => {
        c.frustumCulled = false;
        const mesh = c as THREE.Mesh;
        if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.material) return;
        // CRITICAL: scene.clone(true) SHARES material instances, so tinting per clone
        // would make the last colour win on BOTH boards. Clone the material per board.
        const orig = mesh.material as THREE.MeshStandardMaterial;
        const mat = orig.clone();
        mesh.material = mat;
        if ((mat as { color?: THREE.Color }).color?.isColor) {
          mat.color.copy(col);
          if ('emissive' in mat && mat.emissive) {
            mat.emissive.copy(col);
            // Player glows enough to punch THROUGH the crest spray at rest (a flat board
            // at the chase-cam framing sits in the foam zone); the drift charge/boost ramp
            // (useFrame) drives the player's emissiveIntensity live above this base.
            mat.emissiveIntensity = isPlayer ? 1.0 : 0.4;
          }
          if (isPlayer) playerMats.current.push(mat);
        }
      });
      // Auto-orient FLAT: recenter, then rotate the longest axis to +Z, thinnest to +Y.
      const box = new THREE.Box3().setFromObject(clone);
      const size = new THREE.Vector3(); box.getSize(size);
      const center = new THREE.Vector3(); box.getCenter(center);
      clone.position.sub(center);                 // center the mesh at the inner origin
      const inner = new THREE.Group();
      inner.add(clone);
      inner.quaternion.copy(boardBaseQuat(size)); // lay it flat
      const pivot = new THREE.Object3D();          // gets the dynamic yaw/pitch/bank + pos + scale
      pivot.rotation.order = 'YXZ';
      pivot.add(inner);
      group.add(pivot);
      return pivot;
    };

    const c0 = clientSpline.centerlineAt(0);
    const tan0 = clientSpline.tangentAt(0);
    pred.current = { x: c0.x, z: c0.z, vx: 0, vz: 0, rot: Math.atan2(tan0.x, tan0.z) };
    accum.current = 0; camInit.current = false;
    driftCharge.current = 0; boostTicks.current = 0; boostMult.current = 1; whipCd.current = 0;
    falling.current = false; fallTicks.current = 0; lastSafeT.current = 0;
    dummy.current = { x: c0.x, z: c0.z, vx: 0, vz: 0, bx: 0, bz: 0 };
    prevSelf.current = { x: c0.x, z: c0.z, rot: Math.atan2(tan0.x, tan0.z) };
    prevDummy.current = { x: c0.x, z: c0.z };
    snapRender.current = true;

    // Player = hot magenta: max contrast on cyan water AND distinct from the coral
    // rival (the old cyan player was invisible — same hue as the water + foam).
    playerRef.current = mk('#ff2bd6', true);   // hot magenta — you
    dummyObjRef.current = mk('#ff6a3d', false); // coral — rival

    return () => {
      while (group.children.length > 0) group.remove(group.children[0]);
      playerRef.current = null; dummyObjRef.current = null;
      forgetTKey('fd-self'); forgetTKey('fd-dummy');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => { keys.current[e.code] = false; };
    window.addEventListener('keydown', down, { passive: false });
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  function step() {
    const p = pred.current;

    if (falling.current) {
      p.x += p.vx * TICK_DT; p.z += p.vz * TICK_DT;
      p.vx *= 0.99; p.vz *= 0.99;
      fallTicks.current += 1;
      if (fallTicks.current >= FALL_TICKS) {
        const c = clientSpline.centerlineAt(lastSafeT.current);
        const tan = clientSpline.tangentAt(lastSafeT.current);
        p.x = c.x; p.z = c.z; p.vx = 0; p.vz = 0;
        p.rot = Math.atan2(tan.x, tan.z);
        falling.current = false; fallTicks.current = 0;
        driftCharge.current = 0; boostTicks.current = 0; boostMult.current = 1;
        snapRender.current = true; // teleport — don't interpolate across the respawn
      }
      return;
    }

    const k = keys.current;
    const left = k['KeyA'] || k['ArrowLeft'];
    const right = k['KeyD'] || k['ArrowRight'];
    const brake = k['KeyS'] || k['ArrowDown'];
    const drifting = !!(k['ShiftLeft'] || k['ShiftRight']);
    const speed = Math.hypot(p.vx, p.vz);

    let turning = 0;
    if (left && !right) turning = 1;
    else if (right && !left) turning = -1;
    let dir: { x: number; z: number } | null = null;
    if (turning !== 0) {
      const aim = p.rot + STEER_TARGET_OFFSET * turning;
      dir = { x: Math.sin(aim), z: Math.cos(aim) };
    }

    // Drift mini-turbo: charge while held+turning+fast; release = INSTANT kick.
    const minSpeed = T.maxSpeed * T.driftMinSpeedFrac;
    if (drifting && turning !== 0 && speed >= minSpeed) {
      driftCharge.current += 1;
    } else if (!drifting && driftCharge.current > 0) {
      const c = driftCharge.current;
      let mult = 1;
      if (c >= T.driftTick3) mult = T.driftBoost3;
      else if (c >= T.driftTick2) mult = T.driftBoost2;
      else if (c >= T.driftTick1) mult = T.driftBoost1;
      if (mult > 1) {
        const kick = T.maxSpeed * (mult - 1);
        p.vx += Math.sin(p.rot) * kick;
        p.vz += Math.cos(p.rot) * kick;
        boostMult.current = mult; boostTicks.current = T.driftBoostTicks;
      }
      driftCharge.current = 0;
    } else if (!drifting) {
      driftCharge.current = 0;
    }

    // Board-whip (Space, edge-triggered, cooldown-gated).
    const space = !!k['Space'];
    if (space && !spacePrev.current && whipCd.current <= 0) {
      whipSide.current = -whipSide.current;
      whipSwing.current = T.whipSwingTicks;
      whipCd.current = T.whipCooldownTicks;
      const perpX = Math.cos(p.rot) * whipSide.current;
      const perpZ = -Math.sin(p.rot) * whipSide.current;
      p.vx += perpX * T.whipSelfImpulse;
      p.vz += perpZ * T.whipSelfImpulse;
      const d = dummy.current;
      if (Math.hypot(d.x - p.x, d.z - p.z) <= T.whipReach) {
        d.vx += perpX * T.whipBumpImpulse;
        d.vz += perpZ * T.whipBumpImpulse;
      }
    }
    spacePrev.current = space;
    if (whipCd.current > 0) whipCd.current -= 1;
    if (whipSwing.current > 0) whipSwing.current -= 1;

    let speedMod = 1;
    if (boostTicks.current > 0) { speedMod = boostMult.current; boostTicks.current -= 1; }

    const params = {
      maxSpeed: T.maxSpeed,
      maxAccel: T.maxAccel,
      turnRate: T.turnRate,
      turnSpeedFalloff: T.turnSpeedFalloff,
      airborneSteerMult: T.airborneSteerMult,
      forwardDrag: T.forwardDrag,
      lateralGrip: drifting ? Math.min(0.985, T.lateralGrip + 0.07) : T.lateralGrip,
      speedMod,
      accelMult: 1,
    };
    const thrust = brake ? 0 : 1;

    const next = integrateSurfStep(p, { dir, thrust, airborne: false }, params, TICK_DT);
    p.x = next.x; p.z = next.z; p.vx = next.vx; p.vz = next.vz; p.rot = next.rot;

    // Off-track detection.
    const tNow = tAtXZ(p.x, p.z, 'fd-self');
    const c = clientSpline.centerlineAt(tNow);
    const lat = Math.hypot(p.x - c.x, p.z - c.z);
    const hw = clientSpline.widthAt(tNow);
    if (lat > hw + T.offtrackMargin) { falling.current = true; fallTicks.current = 0; }
    else lastSafeT.current = tNow;

    // Rival LOCKS to a slot beside+ahead of the player every tick (so it stays within
    // whipReach — the old 5%/tick ease let it lag ~700wu behind a fast player and the
    // whip never connected). A whip adds a transient (bx,bz) knock offset that decays
    // back to the slot, so the bump is VISIBLE without the rival drifting away.
    const rX = Math.cos(p.rot), rZ = -Math.sin(p.rot);   // player right
    const fX = Math.sin(p.rot), fZ = Math.cos(p.rot);    // player forward
    const tgtX = p.x + rX * RIVAL_LATERAL + fX * RIVAL_AHEAD;
    const tgtZ = p.z + rZ * RIVAL_LATERAL + fZ * RIVAL_AHEAD;
    const d = dummy.current;
    d.bx += d.vx * TICK_DT; d.bz += d.vz * TICK_DT;   // knock velocity → offset
    d.vx *= 0.92; d.vz *= 0.92;                        // velocity decays (slow = the knock travels)
    d.bx *= 0.94; d.bz *= 0.94;                        // offset eases back to slot (slow = knock is readable)
    d.x = tgtX + d.bx; d.z = tgtZ + d.bz;              // locked beside player + visible knock
  }

  useFrame((state, frameDt) => {
    const player = playerRef.current;
    const dObj = dummyObjRef.current;
    if (!player || !dObj) return;

    const p = pred.current;
    const d = dummy.current;

    accum.current += frameDt > MAX_ACCUM ? MAX_ACCUM : frameDt;
    let guard = 0;
    while (accum.current >= TICK_DT && guard < 16) {
      // Snapshot the state we integrate FROM, so render can interpolate toward the result.
      prevSelf.current.x = p.x; prevSelf.current.z = p.z; prevSelf.current.rot = p.rot;
      prevDummy.current.x = d.x; prevDummy.current.z = d.z;
      step();
      accum.current -= TICK_DT; guard++;
    }
    // After a spawn/respawn the integrate-from state is a teleport away — snap, don't slide.
    if (snapRender.current) {
      prevSelf.current.x = p.x; prevSelf.current.z = p.z; prevSelf.current.rot = p.rot;
      prevDummy.current.x = d.x; prevDummy.current.z = d.z;
      snapRender.current = false;
    }

    const time = state.clock.elapsedTime;
    // Fraction toward the next sim tick — drives the smooth interpolation.
    const alpha = accum.current >= TICK_DT ? 1 : accum.current / TICK_DT;

    // ── Interpolated render pose (the fluidity fix: 30Hz sim → render-rate) ──
    const rx = prevSelf.current.x + (p.x - prevSelf.current.x) * alpha;
    const rz = prevSelf.current.z + (p.z - prevSelf.current.z) * alpha;
    const rrot = prevSelf.current.rot + (p.rot - prevSelf.current.rot) * alpha;
    // Angular velocity (rad/s) of the last sim tick — drives the lean-into-turn roll.
    const angVel = (p.rot - prevSelf.current.rot) / TICK_DT;

    const t = tAtXZ(rx, rz, 'fd-self');
    const datumY = elevationAtT(t);   // CENTERLINE elevation (smooth, no bank tilt) — for the camera
    // BOARD rides the BANKED water surface (tilts across the channel). Using the
    // centerline datum made it float above the low side of every banked turn.
    const surfaceY = bankedDatumYAtT(rx, rz, t) + surfWaveHeightAt(rx, rz, time) + T.rideHeight;
    const fallFrac = falling.current ? fallTicks.current / FALL_TICKS : 0;
    const py = surfaceY - fallFrac * fallFrac * FALL_DEPTH;

    const fwdX = Math.sin(rrot), fwdZ = Math.cos(rrot);   // forward (also used by the camera below)

    const swingFrac = T.whipSwingTicks > 0 ? whipSwing.current / T.whipSwingTicks : 0;
    const swingWag = swingFrac * 0.5 * whipSide.current;
    // Full surf tilt: pitch (nose-up + wave fore-aft) + roll (wave cross-slope + track bank
    // + lean into the turn).
    const tilt = surfTilt(rx, rz, rrot, t, time, angVel);

    player.scale.setScalar(T.kartScale);
    player.position.set(rx, py, rz);
    player.rotation.set(tilt.pitch, rrot + swingWag, tilt.roll + swingWag * 0.6);   // YXZ on the pivot

    // Drift feedback: ramp the player board's emissive by charge tier, flash on boost.
    const charge = driftCharge.current;
    let ei = 1.0, hot = 0;                                            // rest: visible through spray
    if (boostTicks.current > 0)            { ei = 3.0; hot = 0.75; } // boost flash
    else if (charge >= T.driftTick3)       { ei = 2.4; hot = 0.55; } // tier 3
    else if (charge >= T.driftTick2)       { ei = 1.9; hot = 0.38; } // tier 2
    else if (charge >= T.driftTick1)       { ei = 1.5; hot = 0.20; } // tier 1
    else if (charge > 0)                   { ei = 1.0 + 0.5 * (charge / Math.max(1, T.driftTick1)); }
    _emTmp.copy(_emBase).lerp(_emHot, hot);
    for (let i = 0; i < playerMats.current.length; i++) {
      const m = playerMats.current[i];
      m.emissive.copy(_emTmp);
      m.emissiveIntensity = ei;
    }

    // Rival — interpolated render pos too (tracks the interpolated player slot smoothly).
    const dx = prevDummy.current.x + (d.x - prevDummy.current.x) * alpha;
    const dz = prevDummy.current.z + (d.z - prevDummy.current.z) * alpha;
    const dt = tAtXZ(dx, dz, 'fd-dummy');
    const dSurfaceY = bankedDatumYAtT(dx, dz, dt) + surfWaveHeightAt(dx, dz, time) + T.rideHeight;
    const dtilt = surfTilt(dx, dz, rrot, dt, time, angVel);   // rival gets the SAME tilt (was flat)
    dObj.scale.setScalar(T.kartScale);
    dObj.position.set(dx, dSurfaceY, dz);
    dObj.rotation.set(dtilt.pitch, rrot, dtilt.roll);   // full wave pitch+roll, no whip swing

    // Camera follows the interpolated XZ but the SMOOTH track datum for Y (NOT py) — so
    // the view doesn't bob/bounce with every wave the board rides over (the "jumpy" feel);
    // the board still visibly surfs up/down the swell beneath the gliding camera.
    _camWanted.set(rx - fwdX * T.camBack, datumY + T.camUp, rz - fwdZ * T.camBack);
    _camLook.set(rx + fwdX * T.camAhead, datumY + CAM_LOOK_UP, rz + fwdZ * T.camAhead);
    if (!camInit.current) { camera.position.copy(_camWanted); camInit.current = true; }
    else camera.position.lerp(_camWanted, Math.min(1, CAM_LERP * frameDt));
    camera.lookAt(_camLook);

    // DEV debug hook — gated + allocation-free (see _dbg). Off unless window.__REEF_ON.
    const w = window as unknown as ReefDebugWindow;
    if (w.__REEF_ON) {
      const g = _dbg;
      g.pred.x = p.x; g.pred.z = p.z; g.pred.vx = p.vx; g.pred.vz = p.vz; g.pred.rot = p.rot;
      g.pred.speed = Math.hypot(p.vx, p.vz);
      g.dummy.x = d.x; g.dummy.z = d.z; g.t = t; g.alpha = alpha;
      g.falling = falling.current; g.fallTicks = fallTicks.current; g.lastSafeT = lastSafeT.current;
      g.driftCharge = driftCharge.current; g.boostTicks = boostTicks.current; g.boostMult = boostMult.current;
      g.whipCd = whipCd.current; g.whipSwing = whipSwing.current;
      g.boardPos[0] = player.position.x; g.boardPos[1] = player.position.y; g.boardPos[2] = player.position.z;
      g.boardEulerDeg[0] = player.rotation.x * RAD2DEG; g.boardEulerDeg[1] = player.rotation.y * RAD2DEG; g.boardEulerDeg[2] = player.rotation.z * RAD2DEG;
      g.boardScale = player.scale.x;
      g.camPos[0] = camera.position.x; g.camPos[1] = camera.position.y; g.camPos[2] = camera.position.z;
      g.camToBoard = Math.hypot(camera.position.x - player.position.x, camera.position.y - player.position.y, camera.position.z - player.position.z);
      g.surfaceY = surfaceY; g.rideHeight = T.rideHeight;
      _dbgObj.player = player; _dbgObj.dummy = dObj; _dbgObj.camera = camera; _dbgObj.scene = state.scene;
      w.__REEF = g; w.__REEFOBJ = _dbgObj;
    }
  });

  return <group ref={groupRef} />;
}
