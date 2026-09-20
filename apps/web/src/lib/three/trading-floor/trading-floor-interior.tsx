'use client';

/**
 * trading-floor-interior.tsx
 *
 * Walkable INTERIOR for the Trading Floor building (ring slot 6 / S, id
 * `cron-automation`). Founder order 2026-09-19: "they would enter it like they
 * enter the cove and then they'd be able to actually look at a screen ... a
 * monitor almost to walk up to and manage trades."
 *
 * v2, founder verdict 2026-09-19: "there are no walls really ... we do need
 * walls. the lighting is good. we want it like a computer room, think of a New
 * York stock trading floor: a big screen in the middle on the back wall that
 * shows a bunch of charts, and computers lined up against the side that an
 * agent can go up and sit at."
 *
 * What is here:
 *   - The AUTHORED hall GLB (`INTERIOR_GLB`), built by
 *     `scripts/trading-floor/build-interior.mjs` and mounted at final scale
 *     with no auto-fit. Nothing in this room is a placeholder.
 *   - The GLB's single `TradingFloorConsoleModule` re-drawn as a 6-desk
 *     `InstancedMesh` row against the side walls, and its single
 *     `TradingFloorChairModule` re-drawn as the matching 6 chairs. Both come
 *     from `buildInstancedRow`, both read their placement out of
 *     `trading-floor-room.ts`.
 *   - The BIG BOARD (`TradingFloorScreen`), one plane on the -Z wall carrying
 *     live house-trader statuses and counts.
 *   - The TRADE TAPE (`TradingFloorTradeTape`), the same trades as physical
 *     objects: one emissive slab per recent trade, drifting from the board wall
 *     toward the door in two lanes, one lane per desk. ONE mesh, one draw call.
 *   - Walk-up hotspots: the MONITOR, which opens the EXISTING Exchange modal on
 *     its Trading Floor tab (`useGameStore.openTradingFloor`) — no second
 *     modal, no duplicated panel — the DOOR, and six SEATS.
 *
 * WHY THE LIGHT RIG CHANGED. The founder said the lighting was good, and the
 * hue is unchanged, but the rig was measurably the other half of "there are no
 * walls". Sampling the previous local pass gave the ceiling, the back wall and
 * both side walls at #3d627f — the same byte value on every surface — and the
 * floor at #375c7a, 2.5% apart. Ambient light is direction-independent, so an
 * ambient-dominated rig hands the floor normal, the wall normal and the ceiling
 * normal identical irradiance and every corner in the room disappears. The
 * point light was not making up the difference: `decay: 1` at r = 1100 with a
 * 3400 cutoff is a falloff of 0.00089, which is why the wall sampled the same
 * at two heights. v2 spends that light budget on a DIRECTIONAL key instead, so
 * N·L differs per face and a corner is a corner again. Still three lights, still
 * no shadows.
 *
 * Iris Xe invariants enforced here:
 *   - NO shadows anywhere.
 *   - NO drei <Text> / <Billboard>; floating prompts go through
 *     WorldLabelsOverlay (DOM), never canvas text. The board is a CanvasTexture
 *     on a plane, which is the sanctioned way to put words in this scene.
 *   - NO InstancedMesh + ShaderMaterial — both rows keep the GLB's own
 *     MeshStandardMaterial.
 *   - NO per-frame allocation — module-scope scratch only.
 *   - Draw calls: 6 static from the room GLB (floor, walls, ceiling, trim,
 *     dais, kiosk) + 1 instanced desk row + 1 instanced chair row + 1 board
 *     + 1 trade tape, = 10, plus the avatar. Every hotspot is `visible: false`,
 *     so they cost none.
 *   - 3 lights total (ambient + hemisphere + one non-shadow directional).
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import * as THREE from 'three/webgpu';
import { useGameStore } from '@/stores/game';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import {
  preloadClips,
  VRMCharacterAnimator,
  type AnimName,
} from '@/lib/three/vrm-character-animator';
import { disposeVRMInstance, useVRMInstance } from '@/lib/three/vrm-loader';
import { useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { clampCameraToRoom, type RoomBounds } from '@/lib/three/room-camera';
import {
  useWorldLabel,
  WorldLabel,
  WorldLabelsOverlayMount,
} from '@/lib/three/world-labels-overlay';
import {
  useSceneActive,
  useSceneCamera,
  useSceneFrame,
  useSlotCapabilities,
} from '@/components/three/world-stage/use-scene-frame';
import {
  usePlayerCapabilityController,
  type PlayerSpaceAdapter,
} from '@/lib/three/player/player-capability-controller';
import { TRADING_FLOOR_POLICY } from '@/lib/three/player/player-motion-policy';
import { requestTradingFloorExit } from './trading-floor-exit-intent';
import { TradingFloorScreen } from './trading-floor-screen';
import { TradingFloorTradeTape } from './trading-floor-trade-tape-mesh';
import {
  clampTradingFloorMovementSeated,
  computeTradingFloorArming,
  createTradingFloorArming,
  pushCameraOutOfSolids,
  resetTradingFloorArming,
  resolveTradingFloorInteraction,
  tradingFloorSeatedCameraYaw,
  validateAuthoredProp,
  wrapTradingFloorAngle,
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
  TRADING_FLOOR_CAMERA_Z_MAX,
  TRADING_FLOOR_CAMERA_Z_MIN,
  TRADING_FLOOR_CHAIR_HALF_X,
  TRADING_FLOOR_CHAIR_HALF_Z,
  TRADING_FLOOR_CHAIR_SEAT_Y,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_DESK_INNER_X,
  TRADING_FLOOR_DOOR,
  TRADING_FLOOR_DOOR_APPROACH_Z,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_PLAYER_SPEED_WU_PER_SEC,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SEATS,
  TRADING_FLOOR_SOLIDS,
  type TradingFloorSeat,
} from './trading-floor-room';

/**
 * The authored hall. Built by `scripts/trading-floor/build-interior.mjs` and
 * documented in 3dStructure.md §9g: 358 KB, 7,277 tris, 8 materials, 6 ETC1S
 * textures (measured with `scripts/trading-floor/inspect-glb.mjs` against the
 * shipped bytes, 2026-09-19 23:06), authored at 1 unit = 1 wu and ALREADY at
 * final scale — it is mounted with NO auto-fit (unlike `cove-interior.tsx`,
 * whose GLB is normalised to a target height). Two of those 8 materials belong
 * to props the scene pulls out and re-draws as instanced rows, so the room
 * costs 6 static draw calls + 2 instanced rows + 1 board = 9.
 *
 * `?v=2` since the v2 rebuild (textured walls, own ceiling material, textured
 * floor deck, screen surround, chair module, desks on the side walls). The
 * bytes at this path changed, so the query HAD to move: Cloudflare's edge cache
 * cannot be purged with our deploy token, so the query is the only invalidator
 * (CLAUDE.md, animation rule 9). `?v=2` has never been deployed, so re-exports
 * during this build are safe; from the first deploy on, never mutate the bytes
 * at an existing `?v=`.
 */
const INTERIOR_GLB = '/models/trading-floor/trading-floor-interior-opt1-mo-ktx.glb?v=2';

// ---------------------------------------------------------------------------
// Sit clips
//
// The seats reuse the COVE sit bundle (`/avatars/animations/_cove_sit.glb?v=4`,
// already registered in `vrm-character-animator.ts`). No asset bytes change, so
// no `?v=` bump — 3dStructure.md §6f rule 9 only binds a mutated asset.
//
// ALL seats use the m-variant idle. That is the cove's shipped policy, not a
// shortcut: the f-variant's expressive phases swing the arms out horizontally at
// shoulder height and were rejected on the live cove table (founder verdict
// 2026-07-16, `cove-interior.tsx`). The m-clip is the numerically-verified calm
// one. `sit_to_stand_m` matches it, so the exit does not change body type
// halfway through standing up.
// ---------------------------------------------------------------------------

const TRADING_FLOOR_SIT_CLIPS = Object.freeze({
  enter: 'sit_stand_to_sit',
  hold: 'sit_idle_m',
  exit: 'sit_to_stand_m',
}) satisfies Readonly<Record<'enter' | 'hold' | 'exit', AnimName>>;

/** Same playback speed the cove and the hold'em room use for this bundle. */
const SIT_CLIP_TIME_SCALE = 1.5;
/** The authored transition is ~4.8 s; at 1.5x it lands at 3.2 s. */
const SIT_CLIP_SECONDS = 4.8 / SIT_CLIP_TIME_SCALE;
/**
 * Hard cap on the cushion pin. A pin is a correction, not a placement: if a VRM
 * ever reports a wild hips position, clamping keeps the avatar in the room
 * instead of sinking it through the floor or launching it at the ceiling.
 * 40 wu is ~15% of avatar height, far beyond any real clip-vs-chair residual.
 */
const SIT_PIN_LIMIT = 40;

/**
 * Warm the three clips when this LAZY chunk loads, i.e. on entering the venue —
 * never on world boot (§6f rule 2 bans a mount-path `preloadEmoteClips()`; this
 * is the sanctioned `preloadClips(exact list)` form). All three live in one
 * bundle and `BUNDLE_CACHE` keys on the file path, so it is ONE fetch.
 *
 * Browser-guarded on purpose. Three test files import this module, and an
 * unguarded fetch against a relative URL with no server rejects at an arbitrary
 * later moment — which lands inside whichever test happens to be running and
 * fails it. One such flake was observed in a neighbouring file's clock test
 * before this guard.
 */
if (typeof window !== 'undefined') {
  preloadClips([
    TRADING_FLOOR_SIT_CLIPS.enter,
    TRADING_FLOOR_SIT_CLIPS.hold,
    TRADING_FLOOR_SIT_CLIPS.exit,
  ]);
}

/**
 * Which sit clips an avatar type uses. Exported as the test seam: the wiring
 * itself lives in a frame callback inside an R3F component, which cannot be
 * driven without a live canvas, but WHICH clips each avatar type gets is the
 * part that can silently regress.
 *
 * GLB avatars get null. They have no humanoid rig, no `VRMCharacterAnimator` and
 * no retarget path, so they keep the snap-only behaviour: the body moves to the
 * seat and holds its own idle.
 */
export function tradingFloorSitClips(
  avatarType: ModelRegistryEntry['avatar_type'],
): Readonly<Record<'enter' | 'hold' | 'exit', AnimName>> | null {
  return avatarType === 'vrm' ? TRADING_FLOOR_SIT_CLIPS : null;
}

const AVATAR_TARGET_HEIGHT = 270;
/** Low, long GLB avatars (lobster) must not fill the aisle. */
const AVATAR_MAX_FOOTPRINT = 150;

/**
 * `halfX` is the DESK ROW's inner face plus the margin, not the room's half
 * width. v2 moved the desks against the side walls, and they stand 166 wu tall
 * while the camera's own Y floor is `above + pitchMin` = 140: a camera clamped
 * to the wall therefore passed through a desk whenever the player pitched down
 * near the side of the hall. `clampCameraToRoom` takes X and Z bounds
 * separately, so narrowing X alone leaves the 2200 wu depth intact.
 *
 * The four corner pillars are covered by the same bound — they sit at |x| 1055
 * to 1165, outside the desk face — so the only solids the camera can still
 * enter are the central holo dais and the monitor kiosk, both of which the
 * camera reaches only from the middle of the room.
 *
 * TANGENT BY DESIGN, and do NOT "fix" the asymmetry with Z. `clampCameraToRoom`
 * permits `±(halfX − margin)`, so the `+ roomMargin` here cancels the clamp's
 * own inset and lands the bound exactly ON the desk face: X gets zero clearance
 * where Z gets 60. That is safe, not an oversight. At a desk's Z the player's
 * own collider stops them at |x| 939, which is INSIDE the camera bound, so the
 * camera always looks inward and the desk is behind it; between desks there is
 * no desk in the sightline at all. Adding a margin here would cost 60 wu of
 * framing in a room that is already short of it, for no artefact.
 */
const ROOM_BOUNDS: RoomBounds = {
  halfX: TRADING_FLOOR_DESK_INNER_X + TRADING_FLOOR_CAMERA.roomMargin,
  // Z is pre-EXPANDED by the margin for the same reason X is pre-shrunk: the
  // clamp subtracts one shared margin from every bound, so this is how each axis
  // gets the limit it actually needs. At the walls the camera must stay BEHIND
  // the player, and `halfZ` did the opposite — see TRADING_FLOOR_CAMERA_Z_MIN.
  zMin: TRADING_FLOOR_CAMERA_Z_MIN - TRADING_FLOOR_CAMERA.roomMargin,
  zMax: TRADING_FLOOR_CAMERA_Z_MAX + TRADING_FLOOR_CAMERA.roomMargin,
  yMin: 60,
  yMax: TRADING_FLOOR_ROOM.height + TRADING_FLOOR_CAMERA.above,
  margin: TRADING_FLOOR_CAMERA.roomMargin,
};

// ---------------------------------------------------------------------------
// Module-scope scratch — zero allocation in the frame loop.
// ---------------------------------------------------------------------------
const _forwardScratch = new THREE.Vector3();
const _cameraScratch = new THREE.Vector3();
const _lookScratch = new THREE.Vector3();
const _moveScratch: { x: number; z: number } = {
  x: TRADING_FLOOR_PLAYER_SPAWN.x,
  z: TRADING_FLOOR_PLAYER_SPAWN.z,
};
// Build-time scratch for the console row (runs once per room mount, never in a
// frame callback, but module-scope keeps the allocation out of the hot file).
const _instanceMatrix = new THREE.Matrix4();
const _instancePosition = new THREE.Vector3();
const _instanceQuaternion = new THREE.Quaternion();
const _instanceScale = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
/** Frame scratch for the seated cushion pin. */
const _hipScratch = new THREE.Vector3();

/** Live interior position, exported for the stage probe / tests. */
export const tradingFloorPlayerPositionRef: { x: number; z: number } = {
  x: TRADING_FLOOR_PLAYER_SPAWN.x,
  z: TRADING_FLOOR_PLAYER_SPAWN.z,
};

/**
 * Proximity state written by the player frame, read by the label components and
 * by the interact ladder. ONE mutable record, filled in place by
 * `computeTradingFloorArming` — the arming maths itself lives in
 * `trading-floor-room.ts` so it can be tested without an R3F root.
 */
const _arming = createTradingFloorArming();
/** Seat the player currently occupies, or -1. Not geometry — a choice. */
let _seatedIndex = -1;

/** Test/probe seam — the arming state the frame loop last published. */
export function readTradingFloorProximity(): {
  monitorArmed: boolean;
  monitorHint: boolean;
  doorArmed: boolean;
  doorHint: boolean;
  seatArmedIndex: number;
  seatHintIndex: number;
  seatedIndex: number;
} {
  return {
    monitorArmed: _arming.monitorArmed,
    monitorHint: _arming.monitorHint,
    doorArmed: _arming.doorArmed,
    doorHint: _arming.doorHint,
    seatArmedIndex: _arming.seatArmedIndex,
    seatHintIndex: _arming.seatHintIndex,
    seatedIndex: _seatedIndex,
  };
}

function resetTradingFloorProximity(): void {
  resetTradingFloorArming(_arming);
  _seatedIndex = -1;
}

// ---------------------------------------------------------------------------
// Hotspot actions
// ---------------------------------------------------------------------------

/**
 * Open the Trading Floor panel. This is the SAME store action the sidebar row
 * uses (`Economy -> Trading Floor`), so the in-world monitor and the menu land
 * on one modal with one data path — there is no second panel to keep in sync.
 */
export function openTradingFloorMonitor(): void {
  const store = useGameStore.getState();
  if (store.exchangeOpen && store.exchangeTab === 'floor') return;
  store.openTradingFloor();
}

/**
 * The ONE interact action for this room. E on the keyboard and the USE button
 * on a touch device both call THIS — they do not each re-implement the order.
 *
 * That is not tidiness. The first v2 pass left the sit toggle inside the
 * keyboard-only `onInteractEdge` and the USE button kept its two-case ladder,
 * so the founder's own request ("computers ... that an agent can go up and sit
 * at") was unreachable on every phone and iPad. One exported action is the only
 * shape where adding a fourth interaction cannot silently skip touch.
 *
 * The ORDER itself is `resolveTradingFloorInteraction` in
 * `trading-floor-room.ts` — a pure function of the arming record, so
 * "stand beats monitor beats door beats sit" is pinned by a behavioural test
 * (`trading-floor-seats.test.ts`) rather than by reading this file. What stays
 * here is only the EFFECT of each rung, because two of the four touch React
 * state. The label suppression in `TradingFloorLabels` mirrors the same order.
 *
 * Returns true when it consumed the press.
 */
/**
 * Clicking a seat. Runs the SAME ladder E does rather than a second sit path,
 * so a click can never take a seat that E would refuse.
 *
 * The click only counts on the seat the player is already standing in range of.
 * This room has `clickPath: false`, so a click on a distant chair has no way to
 * walk the avatar there, and teleporting them across the hall would be worse
 * than doing nothing. Clicking the armed seat while seated stands the player up,
 * because the ladder resolves 'stand' first.
 */
export function activateTradingFloorSeat(seatIndex: number): boolean {
  if (_arming.seatArmedIndex !== seatIndex) return false;
  return activateTradingFloorUse();
}

/**
 * True while the Exchange panel owns the screen.
 *
 * Every in-world interaction yields to it. The controller's `isFrozen` gates the
 * KEYBOARD path upstream, but nothing gated the others, and that was the hole:
 * the touch USE button, the seat click volumes and the door click volume all
 * reach the world directly without passing the controller. With the panel open
 * and the door armed, USE requested an exit out from under it; while seated, it
 * toggled the seat. Read this at the point of action, never cached.
 */
export function tradingFloorInteractionsFrozen(): boolean {
  return useGameStore.getState().exchangeOpen;
}

export function activateTradingFloorUse(): boolean {
  switch (
    resolveTradingFloorInteraction(
      _arming,
      _seatedIndex,
      tradingFloorInteractionsFrozen(),
    )
  ) {
    case 'stand':
      _seatedIndex = -1;
      return true;
    case 'monitor':
      openTradingFloorMonitor();
      return true;
    case 'door':
      requestTradingFloorExit();
      return true;
    case 'sit':
      _seatedIndex = _arming.seatArmedIndex;
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Room GLB
//
// The hall ships at final scale, so there is no auto-fit, no pivot offset and
// no scale prop: the cloned scene is mounted at the identity and its matrices
// are frozen. Prop positions inside it (console module, holo dais, monitor
// station) are the numbers `trading-floor-room.ts` mirrors for collision and
// for the hotspot centres, read off the GLB with
// `scripts/trading-floor/inspect-glb.mjs`.
// ---------------------------------------------------------------------------

const HIDDEN_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });

const CONSOLE_NODE_NAME = 'TradingFloorConsoleModule';
const CHAIR_NODE_NAME = 'TradingFloorChairModule';

interface RowSlot {
  readonly x: number;
  readonly z: number;
  readonly rotY: number;
}

/**
 * Replace a single authored prop node with a placed row of it, drawn as ONE
 * `InstancedMesh`. Used for the six desks and the six chairs — one draw call
 * each.
 *
 * The authored node carries the uniform scale AND the base-seating Y offset the
 * asset was exported with, so both are READ OFF IT rather than hardcoded. That
 * is not a nicety: `KHR_mesh_quantization` normalises each mesh into [-1, 1]
 * and pushes the real scale and a Y centring term onto the node, so the numbers
 * are not the ones the build script typed and they move whenever the prop is
 * re-exported. Reading them makes the row track the asset.
 *
 * Returns null when the node is missing so a changed asset degrades to "no
 * desks" instead of throwing the whole scene away.
 */
function buildInstancedRow(
  root: THREE.Object3D,
  nodeName: string,
  rowName: string,
  slots: readonly RowSlot[],
  expected: { halfX: number; halfZ: number; nodeX: number; nodeZ: number },
): THREE.InstancedMesh | null {
  const authored = root.getObjectByName(nodeName) as THREE.Mesh | undefined;
  if (!authored?.isMesh) {
    console.warn(
      `[TradingFloor] interior GLB has no "${nodeName}" mesh — ${rowName} skipped`,
    );
    return null;
  }

  // BUILD-TIME ASSERT on the three things this row assumes about the asset.
  // The row places every instance AT its slot and `TRADING_FLOOR_SOLIDS` builds
  // the colliders from the same slot list, so a prop that moved under the
  // constants draws desks where the collision volumes are not. Nothing in the
  // renderer notices; it reads as "collision feels wrong here" and is near
  // undiagnosable from the symptom.
  //
  // The placement rule reads the NODE translation, NOT the geometry bbox centre.
  // An earlier revision measured the bbox centre and was a permanent no-op:
  // `KHR_mesh_quantization` centres every mesh into [-1, 1] and pushes the
  // centring term onto the node, so a quantized prop's bbox centre is
  // structurally zero on every axis. `validateAuthoredProp` carries the full
  // reasoning and the console's own y-axis proof.
  if (!authored.geometry.boundingBox) authored.geometry.computeBoundingBox();
  const bounds = authored.geometry.boundingBox;
  if (bounds) {
    const { problems, fatal } = validateAuthoredProp(nodeName, {
      scaleX: authored.scale.x,
      scaleY: authored.scale.y,
      scaleZ: authored.scale.z,
      minX: bounds.min.x,
      maxX: bounds.max.x,
      minZ: bounds.min.z,
      maxZ: bounds.max.z,
      expectedHalfX: expected.halfX,
      expectedHalfZ: expected.halfZ,
      nodeX: authored.position.x,
      nodeZ: authored.position.z,
      expectedNodeX: expected.nodeX,
      expectedNodeZ: expected.nodeZ,
    });
    for (const problem of problems) {
      console.warn(`[TradingFloor] ${problem} (3dStructure §9g/§9h)`);
    }
    // Fatal = the placement anchor moved. Drop the row down the same degrade
    // path a missing node takes, rather than drawing it where it does not belong.
    if (fatal) return null;
  }

  // MeshStandardMaterial from the GLB. NEVER a ShaderMaterial here:
  // InstancedMesh + ShaderMaterial is a silent WebGPU crash on Iris Xe.
  const row = new THREE.InstancedMesh(
    authored.geometry,
    authored.material,
    slots.length,
  );
  row.name = rowName;
  row.frustumCulled = false;

  const seatY = authored.position.y;
  _instanceScale.setScalar(authored.scale.x);

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    _instancePosition.set(slot.x, seatY, slot.z);
    _instanceQuaternion.setFromAxisAngle(_yAxis, slot.rotY);
    _instanceMatrix.compose(
      _instancePosition,
      _instanceQuaternion,
      _instanceScale,
    );
    row.setMatrixAt(index, _instanceMatrix);
  }
  row.instanceMatrix.needsUpdate = true;
  row.updateMatrix();
  row.matrixAutoUpdate = false;

  // Drop the authored copy so the prop is not drawn twice, once at the wrong
  // place. The geometry and material live on in the InstancedMesh.
  authored.removeFromParent();
  return row;
}

/** Chair placement comes from the SEAT list, so a chair and the avatar that
 *  takes that seat can never drift apart. `chairX/chairZ`, NOT `x/z`: the chair
 *  sits 120 wu BEHIND the standing avatar, because with no sit clip an avatar
 *  drawn at the chair's own origin passes through the seat pan and backrest. */
const CHAIR_SLOTS: readonly RowSlot[] = TRADING_FLOOR_SEATS.map((seat) => ({
  x: seat.chairX,
  z: seat.chairZ,
  rotY: seat.chairRotY,
}));

const INSTANCED_ROW_NAMES = [
  'TradingFloorConsoleRow',
  'TradingFloorChairRow',
] as const;

function RoomShell({ onReady }: { onReady: () => void }) {
  const { scene } = useGLTFWithKTX2(INTERIOR_GLB);

  const cloned = useMemo(() => {
    const next = scene.clone(true);
    makeObject3DWebGPUSafe(next);
    next.position.set(0, 0, 0);
    next.rotation.set(0, 0, 0);
    next.scale.set(1, 1, 1);
    next.updateMatrixWorld(true);
    // Swap the single authored props for their instanced rows BEFORE the
    // matrix freeze below, so the new nodes are frozen along with everything
    // else.
    const consoleRow = buildInstancedRow(
      next,
      CONSOLE_NODE_NAME,
      'TradingFloorConsoleRow',
      TRADING_FLOOR_CONSOLE_ROW,
      // Unrotated footprint: the slots carry the yaw, and the assert is about
      // the ASSET, which is authored at rotY 0. The expected node position is
      // slot 0 — `copyProp` in the build script parks the single authored copy
      // on the first slot of the row, so that IS the anchor the constants and
      // the asset have to agree on.
      {
        halfX: TRADING_FLOOR_CONSOLE_HALF_X,
        halfZ: TRADING_FLOOR_CONSOLE_HALF_Z,
        nodeX: TRADING_FLOOR_CONSOLE_ROW[0]!.x,
        nodeZ: TRADING_FLOOR_CONSOLE_ROW[0]!.z,
      },
    );
    if (consoleRow) next.add(consoleRow);
    const chairRow = buildInstancedRow(
      next,
      CHAIR_NODE_NAME,
      'TradingFloorChairRow',
      CHAIR_SLOTS,
      // The chair is authored at the origin, not on a slot — it is a loose prop
      // the build script never placed.
      {
        halfX: TRADING_FLOOR_CHAIR_HALF_X,
        halfZ: TRADING_FLOOR_CHAIR_HALF_Z,
        nodeX: 0,
        nodeZ: 0,
      },
    );
    if (chairRow) next.add(chairRow);
    // Freeze every matrix AFTER the world update, never before: clearing
    // matrixAutoUpdate first makes Three.js skip the recompute entirely and
    // the room renders at its authored micro-scale
    // (memory gotchas/matrixautoupdate-false-before-r3f-scale-prop).
    next.traverse((object) => {
      object.matrixAutoUpdate = false;
      object.updateMatrix();
    });
    return next;
  }, [scene]);

  // The two InstancedMeshes are the ONLY things here this component owns: each
  // allocates its own instance-matrix buffer. Their geometry and material are
  // shared with the useGLTF cache, and `InstancedMesh.dispose()` does not touch
  // those.
  useEffect(
    () => () => {
      for (const name of INSTANCED_ROW_NAMES) {
        const row = cloned.getObjectByName(name);
        if (row instanceof THREE.InstancedMesh) row.dispose();
      }
    },
    [cloned],
  );

  useEffect(() => {
    onReady();
  }, [cloned, onReady]);

  // The room itself is deliberately NOT disposed: `clone(true)` shares
  // geometries, materials and textures by reference with the useGLTF cache, and
  // the stage keeps this slot resident between visits.
  return <primitive object={cloned} />;
}

/**
 * Exactly three lights, no shadows — the Iris Xe budget (7+ point lights with
 * PCF shadows has cost us a GPU context loss before).
 *
 * v2 swaps the point light for a DIRECTIONAL key. The point light was measured
 * to do nothing: `decay: 1` at r = 1100 with a 3400 cutoff is a falloff of
 * 0.00089, so at 6.5 intensity it contributed 0.6% of one unit at the walls —
 * which is why the previous build sampled the SAME #3d627f on the ceiling, the
 * back wall and both side walls. Ambient is direction-independent and was
 * carrying the whole room, so no face could differ from any other face.
 *
 * The key is placed at +X, +Y, −Z so that:
 *   - the floor and the +Z-facing (door) wall take the most light,
 *   - the −X wall is lit and the +X wall sits at fill, which separates the two
 *     desk rows and gives the hall depth,
 *   - the BACK wall stays at fill, so the big board is the brightest thing on
 *     it rather than competing with a lit surface.
 * Ambient stays, at a third of its old value, purely so the unlit faces do not
 * crush to black.
 *
 * Hue is unchanged on purpose — the founder said the lighting was good. What
 * changed is where it comes from.
 */
function TradingFloorLighting() {
  return (
    <>
      <ambientLight color={0xb7cfe6} intensity={0.85} />
      {/* The GROUND colour is not decoration. A hemisphere light lights a
          surface by `mix(ground, sky, 0.5 * normal.y + 0.5)`, and the ceiling's
          normal is -Y, so the ground colour is ALL the ceiling ever receives —
          the directional key contributes nothing to it. The first v2 pass used
          0x2b2318 there and rendered a black void overhead. */}
      <hemisphereLight args={[0xa9cbe8, 0x585048, 1.15]} />
      <directionalLight
        position={[900, 1500, -1100]}
        color={0xfff0dc}
        intensity={1.15}
        castShadow={false}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Click hotspots — invisible boxes, no draw call, frozen matrices.
// ---------------------------------------------------------------------------

function ClickVolume({
  position,
  size,
  onActivate,
}: {
  position: [number, number, number];
  size: [number, number, number];
  onActivate: () => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const geometry = useMemo(
    () => new THREE.BoxGeometry(size[0], size[1], size[2]),
    [size],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
  }, []);
  return (
    <mesh
      ref={meshRef}
      position={position}
      geometry={geometry}
      material={HIDDEN_MATERIAL}
      onPointerOver={(event) => {
        event.stopPropagation();
        if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        if (typeof document !== 'undefined') document.body.style.cursor = 'default';
      }}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
    />
  );
}

// Sized to the kiosk plus a generous approach slab on its +Z face, so a click
// from normal walk-up distance lands without pixel-perfect aim.
const MONITOR_CLICK_POSITION: [number, number, number] = [
  TRADING_FLOOR_MONITOR.x,
  TRADING_FLOOR_MONITOR.height / 2,
  TRADING_FLOOR_MONITOR.z + TRADING_FLOOR_MONITOR.halfZ,
];
const MONITOR_CLICK_SIZE: [number, number, number] = [
  TRADING_FLOOR_MONITOR.halfX * 2 + 120,
  TRADING_FLOOR_MONITOR.height,
  TRADING_FLOOR_MONITOR.halfZ * 2 + 160,
];
const DOOR_CLICK_POSITION: [number, number, number] = [
  TRADING_FLOOR_DOOR.x,
  TRADING_FLOOR_DOOR.height / 2,
  TRADING_FLOOR_DOOR.z - 30,
];
const DOOR_CLICK_SIZE: [number, number, number] = [
  TRADING_FLOOR_DOOR.width,
  TRADING_FLOOR_DOOR.height,
  80,
];

/**
 * The seat click volumes. One box per desk, covering the standing spot AND the
 * chair behind it, so a mouse or a touch user can take a seat by tapping it.
 *
 * Without these the seats were KEYBOARD-ONLY: the monitor and the door had
 * click volumes from the first pass and the seats did not, so "walk up and sit
 * at a computer" was unreachable with a mouse. One `BoxGeometry` each, the
 * shared invisible material, matrices frozen after mount — no draw call, and
 * the raycast still hits because it is the MATERIAL that is invisible, not the
 * object.
 *
 * The box spans from the desk edge to just past the chair so the whole seating
 * area is one target: centre it midway between the avatar spot and the chair.
 */
const SEAT_CLICK_HEIGHT = 240;
const SEAT_CLICK_SIZE: [number, number, number] = [200, SEAT_CLICK_HEIGHT, 200];

function TradingFloorHotspots() {
  const seatVolumes = useMemo(
    () =>
      TRADING_FLOOR_SEATS.map((seat) => ({
        index: seat.index,
        position: [
          (seat.x + seat.chairX) / 2,
          SEAT_CLICK_HEIGHT / 2,
          (seat.z + seat.chairZ) / 2,
        ] as [number, number, number],
      })),
    [],
  );

  return (
    <>
      {/* Both of these called their action DIRECTLY and so bypassed the
          Exchange freeze exactly like the touch USE button did — a click on the
          door volume with the panel open requested an exit out from under it.
          The canvas may or may not be covered by the modal; relying on that is
          the assumption that produced the bug. Gate at the source. */}
      <ClickVolume
        position={MONITOR_CLICK_POSITION}
        size={MONITOR_CLICK_SIZE}
        onActivate={() => {
          if (tradingFloorInteractionsFrozen()) return;
          openTradingFloorMonitor();
        }}
      />
      <ClickVolume
        position={DOOR_CLICK_POSITION}
        size={DOOR_CLICK_SIZE}
        onActivate={() => {
          if (tradingFloorInteractionsFrozen()) return;
          requestTradingFloorExit();
        }}
      />
      {seatVolumes.map((volume) => (
        <ClickVolume
          key={volume.index}
          position={volume.position}
          size={SEAT_CLICK_SIZE}
          onActivate={() => activateTradingFloorSeat(volume.index)}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Floating prompts — DOM overlay labels (never drei <Text> on Iris Xe).
// ---------------------------------------------------------------------------

function makeAnchor(x: number, y: number, z: number): RefObject<THREE.Object3D | null> {
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);
  anchor.matrixAutoUpdate = false;
  anchor.updateMatrix();
  anchor.updateWorldMatrix(false, false);
  return { current: anchor } as RefObject<THREE.Object3D | null>;
}

// Anchor heights sit just ABOVE their prop, not near the ceiling: the chase
// camera looks at y=180, so a label at ceiling height lands off the top edge
// of the viewport (seen in the first local pass — the DOM node existed but was
// clipped).
const _monitorAnchorRef = makeAnchor(
  TRADING_FLOOR_MONITOR.x,
  TRADING_FLOOR_MONITOR.height + 20,
  TRADING_FLOOR_MONITOR.z,
);
/**
 * The exit prompt does NOT hang on the door, and it cannot.
 *
 * At the door the camera sits at its `z` clamp of 1088 while the DOOR plane is
 * at 1100 — the door is BEHIND the camera and out of frame entirely. That is
 * unavoidable with a chase rig at a wall, so a door-fixed anchor has nowhere
 * visible to be. The first version proved it twice over: at `DOOR.height - 40`
 * and `DOOR.z - 40` = (460, 1060) the anchor was first behind the camera plane
 * and culled, and then — once the camera bound was raised — still 96.6° off the
 * view axis and off the top of the viewport. Correct framing, no capsule.
 *
 * THE ANGLE IS THE WHOLE PROBLEM, and it is easy to underestimate because the
 * camera is itself pitched DOWN 14.6° (it sits at `above` 260 and looks at
 * `lookY` 180). An anchor's elevation from horizontal is therefore NOT its angle
 * from the view axis; the two differ by that pitch, which is what made an
 * apparently-safe 20.3° candidate land at 34.9° and still off-screen.
 *
 * So the anchor is placed against the APPROACH geometry rather than the door's
 * own dimensions: head height, just past where the player stops. Swept across
 * the whole hint band (body z 640 to the 920 clamp) and the pitch range, the
 * worst off-axis angle is 17.3° at default pitch and 22.3° at full pitch-down,
 * against a 30° half-FOV. Both numbers are derived, so moving the approach limit
 * carries the label with it. `trading-floor-seats.test.ts` pins the angle.
 */
const _doorAnchorRef = makeAnchor(
  TRADING_FLOOR_DOOR.x,
  AVATAR_TARGET_HEIGHT,
  TRADING_FLOOR_DOOR_APPROACH_Z - 40,
);

/**
 * ONE seat label, moved to whichever seat is in range, rather than six labels
 * registered with the overlay for the whole visit. Six entries would each cost
 * a projection every overlay pass forever, and only one can ever be visible:
 * the seat hint radius is 420 and the desks are 500 apart.
 */
const SEAT_LABEL_Y = 250;
const _seatAnchorRef = makeAnchor(0, SEAT_LABEL_Y, 0);

function moveSeatAnchor(seat: TradingFloorSeat): void {
  const anchor = _seatAnchorRef.current;
  if (!anchor) return;
  anchor.position.set(seat.x, SEAT_LABEL_Y, seat.z);
  anchor.updateMatrix();
  anchor.updateWorldMatrix(false, false);
}

function promptCapsule(name: string, hint: string, armed: boolean): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transform: 'translateY(-50%)',
      }}
    >
      <div
        style={{
          fontFamily:
            'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
          fontWeight: 520,
          fontSize: 15,
          color: '#bff4ff',
          padding: '7px 15px 9px',
          borderRadius: 999,
          background: 'rgba(6, 18, 30, 0.86)',
          border: '1px solid rgba(90, 226, 255, 0.55)',
          boxShadow:
            '0 0 22px rgba(90,226,255,0.45), 0 0 60px -10px rgba(90,226,255,0.4)',
          whiteSpace: 'nowrap',
          letterSpacing: '0.02em',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        {name}
        {armed && (
          <span
            style={{
              display: 'block',
              fontSize: 9,
              fontStyle: 'italic',
              fontFamily: 'var(--font-oxanium, sans-serif)',
              fontWeight: 400,
              color: '#ffe875',
              opacity: 0.9,
              marginTop: 2,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}

function TradingFloorLabels() {
  const [monitorHint, setMonitorHint] = useState(false);
  const [monitorArmed, setMonitorArmed] = useState(false);
  const [doorHint, setDoorHint] = useState(false);
  const [doorArmed, setDoorArmed] = useState(false);
  const [seatHintIndex, setSeatHintIndex] = useState(-1);
  const [seatArmed, setSeatArmed] = useState(false);
  const [seated, setSeated] = useState(false);

  const { divRef: monitorDivRef, setVisible: setMonitorVisible } = useWorldLabel({
    id: 'trading-floor-monitor',
    anchorRef: _monitorAnchorRef,
    initialVisible: false,
    occlude: false,
  });
  const { divRef: doorDivRef, setVisible: setDoorVisible } = useWorldLabel({
    id: 'trading-floor-door',
    anchorRef: _doorAnchorRef,
    initialVisible: false,
    occlude: false,
  });
  const { divRef: seatDivRef, setVisible: setSeatVisible } = useWorldLabel({
    id: 'trading-floor-seat',
    anchorRef: _seatAnchorRef,
    initialVisible: false,
    occlude: false,
  });

  // Poll the module-scope flags the player frame publishes; one setState per
  // transition, never per frame.
  useSceneFrame(() => {
    if (_arming.monitorHint !== monitorHint) {
      setMonitorHint(_arming.monitorHint);
      setMonitorVisible(_arming.monitorHint);
    }
    if (_arming.monitorArmed !== monitorArmed) setMonitorArmed(_arming.monitorArmed);
    if (_arming.doorHint !== doorHint) {
      setDoorHint(_arming.doorHint);
      setDoorVisible(_arming.doorHint);
    }
    if (_arming.doorArmed !== doorArmed) setDoorArmed(_arming.doorArmed);

    // The seat prompt yields to the monitor and the door, mirroring the E
    // priority in `resolveTradingFloorInteraction`: two prompts that both say
    // "press E" while only one of them can fire is the kind of lie the prompt
    // extraction exists to stop.
    const suppressed = _arming.monitorArmed || _arming.doorArmed;
    const nextSeatHint = suppressed ? -1 : _arming.seatHintIndex;
    if (nextSeatHint !== seatHintIndex) {
      if (nextSeatHint >= 0) {
        const seat = TRADING_FLOOR_SEATS[nextSeatHint];
        if (seat) moveSeatAnchor(seat);
      }
      setSeatHintIndex(nextSeatHint);
      setSeatVisible(nextSeatHint >= 0);
    }
    const nextSeatArmed = !suppressed && _arming.seatArmedIndex >= 0;
    if (nextSeatArmed !== seatArmed) setSeatArmed(nextSeatArmed);
    const nextSeated = _seatedIndex >= 0;
    if (nextSeated !== seated) setSeated(nextSeated);
  });

  return (
    <>
      <WorldLabel divRef={monitorDivRef}>
        {promptCapsule('Trading Monitor', 'press E to manage trades', monitorArmed)}
      </WorldLabel>
      <WorldLabel divRef={doorDivRef}>
        {promptCapsule('Exit', 'press E to leave', doorArmed)}
      </WorldLabel>
      <WorldLabel divRef={seatDivRef}>
        {promptCapsule(
          'Trading Desk',
          seated ? 'press E to stand' : 'press E to sit',
          seated || seatArmed,
        )}
      </WorldLabel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Player + chase camera
// ---------------------------------------------------------------------------

function TradingFloorAvatarMotion({
  children,
  baseY = 0,
  updateAnimation,
}: {
  children: ReactNode;
  baseY?: number;
  updateAnimation: (delta: number, moving: boolean, running: boolean) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const posX = useRef<number>(TRADING_FLOOR_PLAYER_SPAWN.x);
  const posZ = useRef<number>(TRADING_FLOOR_PLAYER_SPAWN.z);
  const cameraYaw = useRef(0);
  const cameraPitch = useRef(0);
  const snapCameraRef = useRef(true);
  const capabilities = useSlotCapabilities();
  const active = useSceneActive();
  // The slot's PERSISTENT camera. Reading the R3F default camera here can bind
  // another slot's camera during the stage swap window
  // (memory feedback_stage_default_camera_cross_scene_writers).
  const slotCamera = useSceneCamera();

  const space = useMemo<PlayerSpaceAdapter>(
    () => ({
      speedPerSec: TRADING_FLOOR_PLAYER_SPEED_WU_PER_SEC,
      readPosition: (out) => {
        out.x = posX.current;
        out.z = posZ.current;
      },
      clampMovement: (currentX, currentZ, desiredX, desiredZ, out) => {
        // Seated: the step is refused but the INTENT is not swallowed. The
        // controller still reports `moving: true` for this frame, which is what
        // `onAfterMove` reads to stand the avatar up — so the player is pinned
        // on the frame they ask to leave and walking on the next one. Freezing
        // through `isFrozen` instead would have swallowed the E key too
        // (the controller returns before the interact edge when frozen), and
        // then E could never stand them back up. The seat-aware branch lives in
        // `trading-floor-room.ts` so "WASD does not move a seated player" is a
        // real test, not a comment.
        clampTradingFloorMovementSeated(
          _seatedIndex,
          currentX,
          currentZ,
          desiredX,
          desiredZ,
          _moveScratch,
        );
        out.x = _moveScratch.x;
        out.z = _moveScratch.z;
        out.groundY = 0;
      },
      commitPosition: (result) => {
        posX.current = result.x;
        posZ.current = result.z;
      },
    }),
    [],
  );

  const resetToSpawn = useCallback(() => {
    posX.current = TRADING_FLOOR_PLAYER_SPAWN.x;
    posZ.current = TRADING_FLOOR_PLAYER_SPAWN.z;
    tradingFloorPlayerPositionRef.x = TRADING_FLOOR_PLAYER_SPAWN.x;
    tradingFloorPlayerPositionRef.z = TRADING_FLOOR_PLAYER_SPAWN.z;
    cameraYaw.current = 0;
    cameraPitch.current = 0;
    snapCameraRef.current = true;
    resetTradingFloorProximity();
    const group = groupRef.current;
    if (group) {
      group.position.set(
        TRADING_FLOOR_PLAYER_SPAWN.x,
        baseY,
        TRADING_FLOOR_PLAYER_SPAWN.z,
      );
      group.rotation.y = TRADING_FLOOR_POLICY.motion.initialFacing;
    }
  }, [baseY]);

  // Re-entering the room must start at the door again, not wherever the last
  // visit ended.
  useEffect(() => {
    if (!active) {
      resetTradingFloorProximity();
      return;
    }
    resetToSpawn();
  }, [active, resetToSpawn]);

  usePlayerCapabilityController({
    sceneId: 'trading-floor',
    capabilities,
    motion: TRADING_FLOOR_POLICY.motion,
    input: TRADING_FLOOR_POLICY.input,
    space,
    isDriving: () => true,
    // The Exchange panel owns the screen while it is up: no walking behind it,
    // no E re-firing the monitor or dropping the player out of the room.
    isFrozen: () => useGameStore.getState().exchangeOpen,
    onEscapeWhileFrozen: () => useGameStore.getState().closeExchange(),
    onActivationReset: resetToSpawn,
    // The keyboard E edge and the touch USE button run the SAME action. The
    // ladder itself lives in `activateTradingFloorUse` so a future fifth
    // interaction cannot reach one input and miss the other.
    onInteractEdge: () => {
      return activateTradingFloorUse() ? { consumeFrame: true } : undefined;
    },
    onAfterMove: (state) => {
      const safeDelta = state.integrationDelta;
      cameraYaw.current +=
        state.intent.cameraYawInput * TRADING_FLOOR_CAMERA.yawSpeed * safeDelta;
      cameraPitch.current = Math.max(
        TRADING_FLOOR_CAMERA.pitchMin,
        Math.min(
          TRADING_FLOOR_CAMERA.pitchMax,
          cameraPitch.current +
            state.intent.cameraPitchInput *
              TRADING_FLOOR_CAMERA.pitchSpeed *
              safeDelta,
        ),
      );

      // Walking out of a seat. The clamp pinned the avatar for this frame, so
      // the stand-up happens before the position is published and the avatar
      // never appears to slide out of the chair. Escape stands up too, which
      // is the habit the Exchange modal already teaches in this room.
      if (
        _seatedIndex >= 0 &&
        (state.intent.move.moving || state.intent.escapeEdge)
      ) {
        _seatedIndex = -1;
      }

      const seated =
        _seatedIndex >= 0 ? TRADING_FLOOR_SEATS[_seatedIndex] : undefined;
      const bodyX = seated ? seated.x : state.x;
      const bodyZ = seated ? seated.z : state.z;

      if (seated) {
        // Keep the space adapter's own position ON the seat every frame, not
        // just on the frame E was pressed. `activateTradingFloorUse` is a
        // module function with no access to these refs, and without this the
        // avatar would snap back to wherever it was standing the moment it
        // stood up.
        posX.current = seated.x;
        posZ.current = seated.z;
      }

      tradingFloorPlayerPositionRef.x = bodyX;
      tradingFloorPlayerPositionRef.z = bodyZ;

      const group = groupRef.current;
      if (group) {
        group.position.set(bodyX, baseY, bodyZ);
        group.rotation.y = seated ? seated.facing : state.facing;
      }

      // --- Hotspot arming (scalar, zero allocation, filled in place) --------
      computeTradingFloorArming(bodyX, bodyZ, _arming);

      // Seated framing. Every desk faces a side WALL, so a player who sits
      // down keeps whatever yaw they walked in with and can end up looking at
      // brickwork instead of the screens they came to use. Ease the yaw around
      // to the over-the-shoulder angle, but ONLY while the player is not
      // steering — easing against live input would fight them for the camera.
      if (seated && Math.abs(state.intent.cameraYawInput) < 1e-3) {
        const yawDelta = wrapTradingFloorAngle(
          tradingFloorSeatedCameraYaw(seated.facing) - cameraYaw.current,
        );
        cameraYaw.current += yawDelta * (1 - Math.exp(-6 * safeDelta));
      }

      // --- Chase camera, clamped inside the room ---------------------------
      const camera = slotCamera;
      if (camera) {
        // Authoritative look direction from the OWNED yaw — never read back off
        // the camera, which keeps whatever the previous visit left on it.
        _forwardScratch.set(
          Math.sin(cameraYaw.current),
          0,
          -Math.cos(cameraYaw.current),
        );
        _cameraScratch.set(
          bodyX - Math.sin(cameraYaw.current) * TRADING_FLOOR_CAMERA.behind,
          TRADING_FLOOR_CAMERA.above + cameraPitch.current,
          bodyZ + Math.cos(cameraYaw.current) * TRADING_FLOOR_CAMERA.behind,
        );
        clampCameraToRoom(_cameraScratch, ROOM_BOUNDS);
        // The room clamp knows the walls and nothing else, so it will park the
        // camera inside a prop — the holo dais swallowed it whole when the
        // player stood on the far side of the ring and pitched down. Pushing
        // the TARGET keeps the lerp converging somewhere legal; pushing the
        // POSITION after the lerp is what guarantees the frame actually drawn
        // is outside. Both are scalar and allocation-free.
        pushCameraOutOfSolids(
          _cameraScratch,
          TRADING_FLOOR_SOLIDS,
          TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
        );
        if (snapCameraRef.current) {
          camera.position.copy(_cameraScratch);
          snapCameraRef.current = false;
        } else {
          camera.position.lerp(_cameraScratch, 1 - Math.exp(-8 * safeDelta));
          // The lerp path can cut a corner the target does not, so the drawn
          // position gets the same treatment.
          pushCameraOutOfSolids(
            camera.position,
            TRADING_FLOOR_SOLIDS,
            TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
          );
        }
        _lookScratch.set(
          bodyX + _forwardScratch.x * TRADING_FLOOR_CAMERA.lookAhead,
          TRADING_FLOOR_CAMERA.lookY,
          bodyZ + _forwardScratch.z * TRADING_FLOOR_CAMERA.lookAhead,
        );
        camera.lookAt(_lookScratch);
      }

      // Seated reports NOT moving, which is what lets the sit one-shot chain
      // hold `sit_idle_m`. The clips themselves are driven by the VRM player's
      // own seat watcher, not from here: this callback has no animator and the
      // GLB avatar path has no clips at all.
      updateAnimation(
        safeDelta,
        seated ? false : state.moving,
        seated ? false : state.running,
      );
    },
  });

  return <group ref={groupRef}>{children}</group>;
}

function TradingFloorVRMPlayer({ reg }: { reg: ModelRegistryEntry }) {
  const vrm = useVRMInstance(reg.path, 'trading-floor-player');
  const { scale, offsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, AVATAR_TARGET_HEIGHT),
    [vrm, reg.animatorId],
  );
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);

  useEffect(
    () => () => disposeVRMInstance(reg.path, 'trading-floor-player'),
    [reg.path],
  );

  useEffect(() => {
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);
    animatorRef.current = animator;
    animator.init().catch((error) => {
      console.warn('[TradingFloor VRM] animator init failed:', error);
    });
    return () => {
      animatorRef.current = null;
      animator.dispose();
    };
  }, [vrm, reg.animatorId]);

  const updateAnimation = useCallback(
    (delta: number, moving: boolean, running: boolean) => {
      animatorRef.current?.update(delta, moving, running);
    },
    [],
  );

  // --- Sit clips + cushion pin ---------------------------------------------
  // Watches the module-scope seat state rather than taking a callback from the
  // motion component. A watch is what this needs: the seat also clears on
  // `resetToSpawn` (leave the room while seated, come back), and an event-based
  // hookup would miss that and leave the avatar holding a sit pose while
  // standing at the door.
  const sitGroupRef = useRef<THREE.Group>(null);
  const seatedRef = useRef(-1);
  const sitBlendRef = useRef(0);
  const sitOffsetRef = useRef(0);
  const hipsRef = useRef<THREE.Object3D | null>(null);

  useEffect(() => {
    hipsRef.current = vrm.humanoid?.getRawBoneNode('hips') ?? null;
    if (!hipsRef.current) {
      console.warn(
        '[TradingFloor VRM] no raw hips bone on',
        reg.path,
        '— seated height will not be pinned to the cushion',
      );
    }
    seatedRef.current = -1;
    sitBlendRef.current = 0;
    sitOffsetRef.current = 0;
  }, [vrm, reg.path]);

  useSceneFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const animator = animatorRef.current;
    const group = sitGroupRef.current;
    if (!group) return;

    // 1. Transition edges drive the clips.
    if (_seatedIndex !== seatedRef.current) {
      const wasSeated = seatedRef.current >= 0;
      seatedRef.current = _seatedIndex;
      if (animator) {
        if (_seatedIndex >= 0) {
          void animator.playOneShot(
            TRADING_FLOOR_SIT_CLIPS.enter,
            TRADING_FLOOR_SIT_CLIPS.hold,
            SIT_CLIP_TIME_SCALE,
          );
        } else if (wasSeated) {
          void animator.playOneShot(
            TRADING_FLOOR_SIT_CLIPS.exit,
            'idle',
            SIT_CLIP_TIME_SCALE,
          );
        }
      }
    }

    // 2. Blend toward 1 while seated, back to 0 while standing up, over the
    //    same span the clip takes. The blend is what keeps the cushion pin from
    //    POPPING: at blend 0 the avatar is exactly where the clip puts it.
    const target = seatedRef.current >= 0 ? 1 : 0;
    const step = delta / SIT_CLIP_SECONDS;
    sitBlendRef.current =
      target > sitBlendRef.current
        ? Math.min(target, sitBlendRef.current + step)
        : Math.max(target, sitBlendRef.current - step);

    if (sitBlendRef.current <= 0) {
      if (sitOffsetRef.current !== 0) {
        sitOffsetRef.current = 0;
        group.position.y = 0;
      }
      return;
    }

    // 3. Pin the hips to the measured cushion. The clips carry the cove chair's
    //    authored descent, not ours, so the residual is real — `holdem-table-
    //    room.tsx` pins its seated busts to a measured cushionY for the same
    //    reason. Subtracting the offset we already applied makes the reading
    //    the bone's INTRINSIC height, so this cannot feed back on itself.
    const hips = hipsRef.current;
    if (!hips) return;
    hips.getWorldPosition(_hipScratch);
    const intrinsicY = _hipScratch.y - sitOffsetRef.current;
    const desired = Math.max(
      -SIT_PIN_LIMIT,
      Math.min(SIT_PIN_LIMIT, TRADING_FLOOR_CHAIR_SEAT_Y - intrinsicY),
    );
    sitOffsetRef.current = desired * sitBlendRef.current;
    group.position.y = sitOffsetRef.current;
  });

  return (
    <TradingFloorAvatarMotion updateAnimation={updateAnimation}>
      <group ref={sitGroupRef}>
        <primitive
          object={vrm.scene}
          scale={[scale, scale, scale]}
          position={[0, offsetY, 0]}
        />
      </group>
    </TradingFloorAvatarMotion>
  );
}

const _glbBoundsScratch = new THREE.Box3();

function TradingFloorGLBPlayer({ reg }: { reg: ModelRegistryEntry }) {
  const { scene } = useGLTFWithKTX2(reg.path);
  const { cloned, scale, offsetY } = useMemo(() => {
    const next = scene.clone(true);
    makeObject3DWebGPUSafe(next);
    next.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      // Bind-pose bounding spheres cull animated GLBs at close range.
      mesh.frustumCulled = false;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
    });
    next.updateMatrixWorld(true);
    _glbBoundsScratch.setFromObject(next);
    const nativeHeight = Math.max(
      0.001,
      _glbBoundsScratch.max.y - _glbBoundsScratch.min.y,
    );
    const nativeFootprint = Math.max(
      0.001,
      _glbBoundsScratch.max.x - _glbBoundsScratch.min.x,
      _glbBoundsScratch.max.z - _glbBoundsScratch.min.z,
    );
    const renderScale = Math.min(
      AVATAR_TARGET_HEIGHT / nativeHeight,
      AVATAR_MAX_FOOTPRINT / nativeFootprint,
    );
    return {
      cloned: next,
      scale: renderScale,
      offsetY: -_glbBoundsScratch.min.y * renderScale,
    };
  }, [scene]);

  useEffect(
    () => () => {
      cloned.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => material.dispose());
        } else {
          mesh.material.dispose();
        }
      });
    },
    [cloned],
  );

  const updateAnimation = useCallback(() => undefined, []);

  return (
    <TradingFloorAvatarMotion updateAnimation={updateAnimation}>
      <primitive object={cloned} scale={scale} position={[0, offsetY, 0]} />
    </TradingFloorAvatarMotion>
  );
}

function TradingFloorPlayer() {
  const avatarModelKey = useGameStore((state) => state.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ??
    MODEL_REGISTRY.lobster;

  return reg.avatar_type === 'vrm' ? (
    <TradingFloorVRMPlayer reg={reg} />
  ) : (
    <TradingFloorGLBPlayer reg={reg} />
  );
}

// ---------------------------------------------------------------------------
// Default export — the whole interior
// ---------------------------------------------------------------------------

export interface TradingFloorInteriorSceneProps {
  /** True while this stage slot owns the canvas. */
  active?: boolean;
  /** Fired once the static room is mounted — the stage's warm gate. */
  onReady?: () => void;
}

export default function TradingFloorInteriorScene({
  active = true,
  onReady,
}: TradingFloorInteriorSceneProps = {}) {
  const handleReady = useCallback(() => {
    onReady?.();
  }, [onReady]);

  useEffect(() => {
    if (active) return;
    if (typeof document !== 'undefined') document.body.style.cursor = 'default';
    resetTradingFloorProximity();
  }, [active]);

  return (
    <>
      <TradingFloorLighting />
      <WorldLabelsOverlayMount />
      <RoomShell onReady={handleReady} />
      <TradingFloorScreen active={active} />
      <TradingFloorTradeTape active={active} />
      <TradingFloorHotspots />
      <TradingFloorLabels />
      {/* Mounted outside the room's tree so a cold VRM parse never delays the
          room appearing. */}
      <Suspense fallback={null}>
        <TradingFloorPlayer />
      </Suspense>
    </>
  );
}
