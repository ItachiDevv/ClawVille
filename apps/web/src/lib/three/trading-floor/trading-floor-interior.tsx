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
 *     the Trading Arena paper leaderboard (contest header, prize line, top 8,
 *     tape row).
 *   - The TRADE TAPE (`TradingFloorTradeTape`), the arena's entries and exits
 *     as physical objects: one slab per tape row, drifting from the board wall
 *     toward the door in two lanes, entries left and exits right. ONE mesh, one
 *     draw call.
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
 *   - Draw calls (v5, 2026-10-01): 9 static from the room GLB (floor, walls,
 *     ceiling, trim, brass, plinth claws, granite plinth, seal + banners, kiosk) + 1
 *     instanced desk row + 1 instanced chair row + 1 board + 1 trade tape + 3
 *     decor meshes (`trading-floor-decor.tsx`: monitors, ticker ribbon, glow),
 *     = 16, plus the avatar. Every hotspot is `visible: false`, so they cost
 *     none.
 *   - 3 lights total (ambient + hemisphere + one non-shadow directional).
 */

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import * as THREE from 'three/webgpu';
import { useThree } from '@react-three/fiber';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { TRADING_FLOOR_SCENE_ID } from '@/components/three/world-stage/stage-scene-id';
import { withStageSlotFrustumCullingDisabledSync } from '@/components/three/world-stage/resource-ledger';
import {
  chainPostBootCompile,
} from '@/lib/three/boot-core-compile';
import { reportTradingFloorSeat, notifyTradingFloorSeatSettled } from '@/hooks/use-floor-arena';
import {
  applyTradingFloorSeatPose, tradingFloorSeatBones, tradingFloorManualSit,
  tradingFloorStandRequested, TRADING_FLOOR_SIT_TIME_SCALE,
  TRADING_FLOOR_MOVE_FADE_SECONDS, tradingFloorPinBlend, tradingFloorArmWeight,
} from './trading-floor-sit';
export { tradingFloorStandRequested } from './trading-floor-sit';
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
import { TradingFloorDecor } from './trading-floor-decor';
import {
  clampTradingFloorMovementSeated,
  computeTradingFloorArming,
  createTradingFloorArming,
  resetTradingFloorArming,
  resolveTradingFloorInteraction,
  tradingFloorDoorPromptVisible,
  tradingFloorSeatedCameraYaw,
  validateAuthoredProp,
  wrapTradingFloorAngle,
  TRADING_FLOOR_CAMERA,
  placeTradingFloorChaseCamera,
  smoothTradingFloorCameraArm,
  TRADING_FLOOR_CHAIR_HALF_X,
  TRADING_FLOOR_CHAIR_HALF_Z,
  TRADING_FLOOR_CHAIR_SEAT_Y,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_DOOR,
  TRADING_FLOOR_DOOR_APPROACH_Z,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_PLAYER_SPEED_WU_PER_SEC,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SEATS,
  type TradingFloorSeat,
} from './trading-floor-room';

/**
 * The authored hall. Built by `scripts/trading-floor/build-interior.mjs` and
 * documented in 3dStructure.md §9g and §9i: v5 is 340,820 B, 10,605 tris, 11
 * meshes, 11 materials, 7 ETC1S textures (measured from the shipped GLB JSON,
 * 2026-10-01), authored at 1 unit = 1 wu and ALREADY at final scale — it is
 * mounted with NO auto-fit (unlike `cove-interior.tsx`, whose GLB is
 * normalised to a target height). Two of those 11 meshes are props the scene
 * pulls out and re-draws as instanced rows, so the GLB costs 9 static draw
 * calls + 2 instanced rows = 11. The board, trade tape and decor add 5, for 16.
 *
 * v2 reached production on 2026-09-20. Serve the v5 bytes through a new query
 * because Cloudflare can keep the old path in its edge cache for one week.
 */
const INTERIOR_GLB = '/models/trading-floor/trading-floor-interior-opt1-mo-ktx.glb?v=5';

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
 * GLB avatars get null: they have no humanoid animator. The five hold'em
 * fallback rigs also use a manual seat pose instead of these sit clips.
 */
export function tradingFloorSitClips(
  avatarType: ModelRegistryEntry['avatar_type'],
  animatorId?: string,
): Readonly<Record<'enter' | 'hold' | 'exit', AnimName>> | null {
  return avatarType === 'vrm' && !tradingFloorManualSit(animatorId) ? TRADING_FLOOR_SIT_CLIPS : null;
}

const AVATAR_TARGET_HEIGHT = 270;
/** Low, long GLB avatars (lobster) must not fill the aisle. */
const AVATAR_MAX_FOOTPRINT = 150;

// The pure placement function owns the shared envelope and casts one backward ray.
export { TRADING_FLOOR_CAMERA_BOUNDS } from './trading-floor-room';

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
let _sitShownIndex = -1;
let _seatGeneration = 0;
let _sitClipOwner = false;
/**
 * Z of the chase camera's forward vector, written by the camera frame and read
 * by the label poll (`tradingFloorDoorPromptVisible`). One number, no
 * allocation. 0 until the first camera frame of a visit, which keeps the Exit
 * HINT hidden rather than showing it for a frame off a previous visit's yaw.
 */
let _cameraForwardZ = 0;

/**
 * The ONE writer of `_seatedIndex` after init. Sit, stand, walking out of the
 * chair and leaving the room all pass through here, so the Trading Floor Arena
 * hears every transition exactly once: a sit seats the player's arena agent
 * and opens "My trader", a stand or a room exit frees the desk
 * (docs/trading-floor-arena.md D7). One call per transition, never per frame:
 * the walk-out stand runs inside the frame callback, but only on the frame the
 * player leaves the chair. The server write is a fire-and-forget fetch that
 * nothing here awaits.
 */
function setTradingFloorSeatedIndex(next: number): void {
  if (next === _seatedIndex) return;
  _seatedIndex = next;
  _sitShownIndex = -1;
  _seatGeneration++;
  reportTradingFloorSeat(next);
}

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
  setTradingFloorSeatedIndex(-1);
  _cameraForwardZ = 0;
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
      setTradingFloorSeatedIndex(-1);
      return true;
    case 'monitor':
      openTradingFloorMonitor();
      return true;
    case 'door':
      requestTradingFloorExit();
      return true;
    case 'sit':
      setTradingFloorSeatedIndex(_arming.seatArmedIndex);
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

/** Chair placement and seated body points share the SEAT list.
 *  `x/z` remain the separate stand points, clear of the chair. */
const CHAIR_SLOTS: readonly RowSlot[] = TRADING_FLOOR_SEATS.map((seat) => ({
  x: seat.chairX,
  z: seat.chairZ,
  rotY: seat.chairRotY,
}));

const INSTANCED_ROW_NAMES = [
  'TradingFloorConsoleRow',
  'TradingFloorChairRow',
] as const;

/** Room and avatar may commit in either order. The timer starts only at room mount. */
export function createTradingFloorReadyGate(
  onReady: () => void,
  hasAvatar = true,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
) {
  let roomMounted = false;
  let avatarMounted = false;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (fallback = false) => {
    if (fired || !roomMounted || (hasAvatar && !avatarMounted && !fallback)) return;
    fired = true;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    onReady();
  };
  return {
    roomMounted() {
      if (roomMounted) return;
      roomMounted = true;
      if (hasAvatar && !avatarMounted) {
        timer = schedule(() => {
          timer = undefined;
          fire(true); // bounded fallback, even if the load never settles
        }, 1500);
      }
      fire();
    },
    avatarMounted(): boolean {
      const late = fired;
      avatarMounted = true;
      fire();
      return late;
    },
    avatarUnmounted() {
      avatarMounted = false;
    },
    roomUnmounted() {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      roomMounted = false;
      fired = false;
    },
  };
}

function RoomShell({ onMounted }: { onMounted: () => () => void }) {
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

  useEffect(() => onMounted(), [cloned, onMounted]);

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
 * v3 warms the three existing lights so walnut stays brown and brass stays
 * gold. The ground fill stays bright enough to reveal the navy ceiling.
 */
function TradingFloorLighting() {
  return (
    <>
      <ambientLight color={0xe8dac4} intensity={0.78} />
      {/* The GROUND colour is not decoration. A hemisphere light lights a
          surface by `mix(ground, sky, 0.5 * normal.y + 0.5)`, and the ceiling's
          normal is -Y, so the ground colour is ALL the ceiling ever receives —
          the directional key contributes nothing to it. The first v2 pass used
          0x2b2318 there and rendered a black void overhead. The warm v3
          ground fill keeps the navy coffers visible. */}
      <hemisphereLight args={[0xd9d9d1, 0x888077, 1.12]} />
      <directionalLight
        position={[900, 1500, -1100]}
        color={0xffdfac}
        intensity={1.2}
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
 *
 * ON SCREEN IS NOT ENOUGH (2026-09-30). That sweep is a player FACING THE BOARD,
 * and in that pose this anchor projects onto the bottom edge of the big board
 * (y 243 against the board's 245 at the spawn, 1350 x 805), so the capsule sat
 * on the board's basis line and ticker from the moment a player arrived.
 * Visibility is therefore `tradingFloorDoorPromptVisible`: the hint shows only
 * while the camera faces the door half-space, the armed prompt always.
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
 *
 * 360, not 250 (2026-10-01): each desk now carries a 3 x 2 monitor rig whose
 * top is 332 wu, under a 335 wu cap (`trading-floor-decor-layout.ts`). From
 * the seated camera a 250 wu anchor at the seat projected onto the middle of
 * that rig, so the "PRESS E TO STAND" capsule covered the screens the player
 * sat down to look at. 360 puts the capsule above the rig in the seated view
 * and above the avatar's head when standing.
 */
const SEAT_LABEL_Y = 360;
const _seatAnchorRef = makeAnchor(0, SEAT_LABEL_Y, 0);

function moveSeatAnchor(seat: TradingFloorSeat): void {
  const anchor = _seatAnchorRef.current;
  if (!anchor) return;
  anchor.position.set(
    _seatedIndex === seat.index ? seat.sitX : seat.x,
    SEAT_LABEL_Y,
    _seatedIndex === seat.index ? seat.sitZ : seat.z,
  );
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
  const [doorPrompt, setDoorPrompt] = useState(false);
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
    // NOT `doorHint` alone: facing the board inside the hint band (the spawn
    // is inside it) put the capsule over the board's footer. See
    // `tradingFloorDoorPromptVisible`.
    const nextDoorPrompt = tradingFloorDoorPromptVisible(
      _arming.doorArmed,
      _arming.doorHint,
      _cameraForwardZ,
    );
    if (nextDoorPrompt !== doorPrompt) {
      setDoorPrompt(nextDoorPrompt);
      setDoorVisible(nextDoorPrompt);
    }
    if (_arming.doorArmed !== doorArmed) setDoorArmed(_arming.doorArmed);

    // The seat prompt yields to the monitor and the door, mirroring the E
    // priority in `resolveTradingFloorInteraction`: two prompts that both say
    // "press E" while only one of them can fire is the kind of lie the prompt
    // extraction exists to stop.
    const suppressed = _arming.monitorArmed || _arming.doorArmed;
    const nextSeatHint = suppressed ? -1 : _arming.seatHintIndex;
    // E can stand immediately, including while the sit clips still prepare.
    const nextSeated = _seatedIndex >= 0;
    if (nextSeatHint >= 0 && (nextSeatHint !== seatHintIndex || nextSeated !== seated)) {
      const seat = TRADING_FLOOR_SEATS[nextSeatHint];
      if (seat) moveSeatAnchor(seat);
    }
    if (nextSeatHint !== seatHintIndex) {
      setSeatHintIndex(nextSeatHint);
      setSeatVisible(nextSeatHint >= 0);
    }
    const nextSeatArmed = !suppressed && _arming.seatArmedIndex >= 0;
    if (nextSeatArmed !== seatArmed) setSeatArmed(nextSeatArmed);
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
  const bodySeatRef = useRef(-1);
  const cameraYaw = useRef(0);
  const cameraPitch = useRef(0);
  const snapCameraRef = useRef(true);
  const cameraArm = useRef<number>(TRADING_FLOOR_CAMERA.behind);
  const frozenLastRef = useRef(false);
  const frozenPrevRef = useRef(false);
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
        // E consumes its controller frame; restore before the next movement step.
        if (bodySeatRef.current >= 0 && _seatedIndex < 0) {
          const stand = TRADING_FLOOR_SEATS[bodySeatRef.current]!;
          posX.current = stand.x;
          posZ.current = stand.z;
          bodySeatRef.current = -1;
        }
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
    bodySeatRef.current = -1;
    posX.current = TRADING_FLOOR_PLAYER_SPAWN.x;
    posZ.current = TRADING_FLOOR_PLAYER_SPAWN.z;
    tradingFloorPlayerPositionRef.x = TRADING_FLOOR_PLAYER_SPAWN.x;
    tradingFloorPlayerPositionRef.z = TRADING_FLOOR_PLAYER_SPAWN.z;
    cameraYaw.current = 0;
    cameraPitch.current = 0;
    snapCameraRef.current = true;
    cameraArm.current = TRADING_FLOOR_CAMERA.behind;
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
    onFrameStart: () => {
      frozenPrevRef.current = frozenLastRef.current;
      frozenLastRef.current = useGameStore.getState().exchangeOpen;
      // Consumed E frames and modal frames cannot retain stale movement.
      updateAnimation(0, false, false);
    },
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

      // Ignore the Escape edge from the modal's last frozen frame.
      if (tradingFloorStandRequested(
        _seatedIndex, state.intent.move.moving, state.intent.escapeEdge, frozenPrevRef.current,
      )) {
        setTradingFloorSeatedIndex(-1);
      }

      const seated =
        _seatedIndex >= 0 ? TRADING_FLOOR_SEATS[_seatedIndex] : undefined;
      // Escape can stand without a movement clamp. Return to the stand point.
      const stand = !seated && bodySeatRef.current >= 0
        ? TRADING_FLOOR_SEATS[bodySeatRef.current] : undefined;
      const bodyX = seated ? seated.sitX : stand ? stand.x : state.x;
      const bodyZ = seated ? seated.sitZ : stand ? stand.z : state.z;

      if (seated || stand) {
        // Keep the space adapter's own position ON the seat every frame, not
        // just on the frame E was pressed. `activateTradingFloorUse` is a
        // module function with no access to these refs, and without this the
        // avatar would snap back to wherever it was standing the moment it
        // stood up.
        posX.current = bodyX;
        posZ.current = bodyZ;
      }
      bodySeatRef.current = seated?.index ?? -1;

      tradingFloorPlayerPositionRef.x = bodyX;
      tradingFloorPlayerPositionRef.z = bodyZ;

      const group = groupRef.current;
      if (group) {
        group.position.set(bodyX, baseY, bodyZ);
        group.rotation.y = seated ? seated.facing : state.facing;
      }
      // Snap avatars notify only AFTER the controller places the body on the chair.
      if (seated && !_sitClipOwner && _sitShownIndex !== _seatedIndex) {
        _sitShownIndex = _seatedIndex;
        notifyTradingFloorSeatSettled(_seatedIndex);
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

      // --- Chase camera, one backward spring arm ---------------------------
      const camera = slotCamera;
      if (camera) {
        // Authoritative look direction from the OWNED yaw — never read back off
        // the camera, which keeps whatever the previous visit left on it.
        _forwardScratch.set(
          Math.sin(cameraYaw.current),
          0,
          -Math.cos(cameraYaw.current),
        );
        // Published for the Exit capsule: its HINT needs the camera to face
        // the door half-space (see `tradingFloorDoorPromptVisible`). A number
        // write, no allocation; the label poll does the setState on change.
        _cameraForwardZ = _forwardScratch.z;
        const rawArm = placeTradingFloorChaseCamera(
          bodyX, bodyZ, cameraYaw.current, cameraPitch.current, _cameraScratch,
        );
        cameraArm.current = smoothTradingFloorCameraArm(
          cameraArm.current, rawArm, safeDelta, snapCameraRef.current,
        );
        placeTradingFloorChaseCamera(
          bodyX, bodyZ, cameraYaw.current, cameraPitch.current, _cameraScratch, cameraArm.current,
        );
        camera.position.copy(_cameraScratch);
        snapCameraRef.current = false;
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

type AvatarMountCallback = () => boolean;

function useTradingFloorAvatarWarm(
  root: THREE.Object3D,
  wrapperRef: RefObject<THREE.Group | null>,
  onAvatarMounted: AvatarMountCallback,
  onAvatarUnmounted: () => void,
) {
  const get = useThree((state) => state.get);
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !root.parent) {
      if (wrapper) wrapper.visible = true;
      if (root.parent) {
        onAvatarMounted();
        return () => onAvatarUnmounted();
      }
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const late = onAvatarMounted();
    if (!late) {
      wrapper.visible = true;
    } else {
      // Keep the wrapper hidden, but compile the visible model root. An
      // invisible compile root produces an empty Three.js render list.
      wrapper.visible = false;
      const startCompile = () => {
        if (cancelled) return;
        unsubscribe?.();
        unsubscribe = undefined;
        const { gl, camera, scene } = get();
        if (typeof (gl as { compileAsync?: unknown }).compileAsync !== 'function') {
          wrapper.visible = true;
          return;
        }
        revealTimer = setTimeout(() => {
          revealTimer = undefined;
          if (!cancelled) wrapper.visible = true;
        }, 5000);
        void chainPostBootCompile({
          gl,
          label: 'trading-floor-late-avatar',
          timeoutMs: 5000,
          isCancelled: () => cancelled,
          compile: () =>
            withStageSlotFrustumCullingDisabledSync(TRADING_FLOOR_SCENE_ID, () =>
              (
                gl as unknown as {
                  compileAsync: (
                    root: THREE.Object3D,
                    camera: THREE.Camera,
                    scene: THREE.Scene,
                  ) => Promise<void>;
                }
              ).compileAsync(root, camera, scene),
            ),
        }).then(() => {
          if (revealTimer !== undefined) clearTimeout(revealTimer);
          revealTimer = undefined;
          if (!cancelled) wrapper.visible = true;
        });
      };
      // A fallback avatar can arrive while the stage warm still owns the
      // renderer. Wait until its direct draw and GPU drain have finished.
      const stageReady = () => {
        const state = useStageStore.getState();
        const status = state.scenes[TRADING_FLOOR_SCENE_ID]?.status;
        return state.activeScene === TRADING_FLOOR_SCENE_ID &&
          (status === 'ready' || status === 'resident');
      };
      if (stageReady()) startCompile();
      else {
        unsubscribe = useStageStore.subscribe(() => {
          if (stageReady()) startCompile();
        });
        if (stageReady()) startCompile();
      }
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (revealTimer !== undefined) clearTimeout(revealTimer);
      onAvatarUnmounted();
    };
  }, [get, onAvatarMounted, onAvatarUnmounted, root, wrapperRef]);
}

function TradingFloorVRMPlayer({
  reg,
  onAvatarMounted,
  onAvatarUnmounted,
}: {
  reg: ModelRegistryEntry;
  onAvatarMounted: AvatarMountCallback;
  onAvatarUnmounted: () => void;
}) {
  const active = useSceneActive();
  const vrm = useVRMInstance(reg.path, 'trading-floor-player');
  const { scale, offsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, AVATAR_TARGET_HEIGHT),
    [vrm, reg.animatorId],
  );
  const animatorRef = useRef<VRMCharacterAnimator | null>(null);
  const warmWrapperRef = useRef<THREE.Group>(null);
  useTradingFloorAvatarWarm(vrm.scene, warmWrapperRef, onAvatarMounted, onAvatarUnmounted);

  useEffect(
    () => () => disposeVRMInstance(reg.path, 'trading-floor-player'),
    [reg.path],
  );

  const locomotionRef = useRef({ moving: false, running: false });
  const clipsReadyRef = useRef(false);
  const standClipRef = useRef(false);
  const fastStandRef = useRef(false);
  const armWeightRef = useRef(0);
  const seatBones = useMemo(() => tradingFloorSeatBones(vrm.humanoid), [vrm]);
  const manualSeat = tradingFloorManualSit(reg.animatorId);

  useEffect(() => {
    let cancelled = false;
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);
    animatorRef.current = animator;
    _sitClipOwner = !manualSeat;
    clipsReadyRef.current = false;
    animator.init().then(async () => {
      if (cancelled) return;
      if (!manualSeat) await animator.prepareClips([
        TRADING_FLOOR_SIT_CLIPS.enter, TRADING_FLOOR_SIT_CLIPS.hold, TRADING_FLOOR_SIT_CLIPS.exit,
      ]);
      if (!cancelled) clipsReadyRef.current = true;
    }).catch((error) => {
      if (!cancelled) _sitClipOwner = false;
      console.warn('[TradingFloor VRM] animator preparation failed:', error);
    });
    return () => {
      cancelled = true;
      _sitClipOwner = false;
      animatorRef.current = null;
      animator.dispose();
    };
  }, [vrm, reg.animatorId, manualSeat]);

  const updateAnimation = useCallback(
    (_delta: number, moving: boolean, running: boolean) => {
      locomotionRef.current.moving = moving;
      locomotionRef.current.running = running;
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

  useEffect(() => {
    if (active) return;
    seatedRef.current = -1;
    standClipRef.current = false;
    fastStandRef.current = false;
    armWeightRef.current = 0;
    sitBlendRef.current = 0;
    sitOffsetRef.current = 0;
    if (sitGroupRef.current) sitGroupRef.current.position.y = 0;
    animatorRef.current?.returnToLocomotion(false, false, 0);
  }, [active]);

  useSceneFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const animator = animatorRef.current;
    const group = sitGroupRef.current;
    if (!group) return;

    const frozen = useGameStore.getState().exchangeOpen;
    const moving = !frozen && _seatedIndex < 0 && locomotionRef.current.moving;
    const running = moving && locomotionRef.current.running;

    // Wait for preparation so the first E frame does not retarget two clips.
    if ((!_sitClipOwner || clipsReadyRef.current) && _seatedIndex !== seatedRef.current) {
      const wasSeated = seatedRef.current >= 0;
      seatedRef.current = _seatedIndex;
      const seat = _seatedIndex;
      const generation = _seatGeneration;
      if (seat >= 0) {
        standClipRef.current = false;
        fastStandRef.current = false;
        if (_sitClipOwner && animator) {
          void animator.playOneShot(
            TRADING_FLOOR_SIT_CLIPS.enter, TRADING_FLOOR_SIT_CLIPS.hold, TRADING_FLOOR_SIT_TIME_SCALE,
            {
              onStart: () => {
                if (_seatGeneration === generation && _seatedIndex === seat) _sitShownIndex = seat;
              },
              onFinish: () => {
                if (_seatGeneration === generation && _seatedIndex === seat) notifyTradingFloorSeatSettled(seat);
              },
            },
          ).then((started) => {
            // The controller's next snap frame supplies label + completion.
            if (!started && _seatGeneration === generation) _sitClipOwner = false;
          });
        }
      } else if (wasSeated && animator) {
        fastStandRef.current = moving;
        if (moving || !_sitClipOwner) {
          animator.returnToLocomotion(moving, running, TRADING_FLOOR_MOVE_FADE_SECONDS);
        } else {
          standClipRef.current = true;
          void animator.playOneShot(
            TRADING_FLOOR_SIT_CLIPS.exit, undefined, TRADING_FLOOR_SIT_TIME_SCALE,
            { onFinish: () => { if (_seatGeneration === generation) standClipRef.current = false; } },
          ).then((started) => { if (!started && _seatGeneration === generation) standClipRef.current = false; });
        }
      }
    }
    if (standClipRef.current && moving && animator) {
      standClipRef.current = false;
      fastStandRef.current = true;
      animator.returnToLocomotion(true, running, TRADING_FLOOR_MOVE_FADE_SECONDS);
    }

    // Exactly one mixer tick per room frame, including modal/frozen frames.
    animator?.update(delta, moving, running);

    // The bundle's arms do not produce a lap pose on all target rigs.
    // Override only inside this room; the mixer supplies locomotion on release.
    const poseActive = _sitShownIndex >= 0 || standClipRef.current;
    armWeightRef.current = tradingFloorArmWeight(armWeightRef.current, poseActive, delta, fastStandRef.current);
    const snapSeat = !_sitClipOwner && _sitShownIndex >= 0;
    if (armWeightRef.current > 0 || snapSeat) {
      applyTradingFloorSeatPose(seatBones, armWeightRef.current, snapSeat, reg.animatorId !== 'chibi');
      vrm.humanoid.update();
      vrm.scene.updateMatrixWorld(true);
      animator?.flushSkeletonUpdates();
    }

    const target = _sitShownIndex >= 0 ? 1 : 0;
    sitBlendRef.current = tradingFloorPinBlend(sitBlendRef.current, target, delta, _sitClipOwner, fastStandRef.current);

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
        <group ref={warmWrapperRef}>
          <primitive
            object={vrm.scene}
            scale={[scale, scale, scale]}
            position={[0, offsetY, 0]}
          />
        </group>
      </group>
    </TradingFloorAvatarMotion>
  );
}

const _glbBoundsScratch = new THREE.Box3();

function TradingFloorGLBPlayer({
  reg,
  onAvatarMounted,
  onAvatarUnmounted,
}: {
  reg: ModelRegistryEntry;
  onAvatarMounted: AvatarMountCallback;
  onAvatarUnmounted: () => void;
}) {
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
  const warmWrapperRef = useRef<THREE.Group>(null);
  useTradingFloorAvatarWarm(cloned, warmWrapperRef, onAvatarMounted, onAvatarUnmounted);

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
      <group ref={warmWrapperRef}>
        <primitive object={cloned} scale={scale} position={[0, offsetY, 0]} />
      </group>
    </TradingFloorAvatarMotion>
  );
}

function TradingFloorPlayer({
  onAvatarMounted,
  onAvatarUnmounted,
}: {
  onAvatarMounted: AvatarMountCallback;
  onAvatarUnmounted: () => void;
}) {
  const avatarModelKey = useGameStore((state) => state.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ??
    MODEL_REGISTRY.lobster;

  return reg.avatar_type === 'vrm' ? (
    <TradingFloorVRMPlayer reg={reg} onAvatarMounted={onAvatarMounted} onAvatarUnmounted={onAvatarUnmounted} />
  ) : (
    <TradingFloorGLBPlayer reg={reg} onAvatarMounted={onAvatarMounted} onAvatarUnmounted={onAvatarUnmounted} />
  );
}

class TradingFloorAvatarErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn('[TradingFloor] avatar failed to load; continuing without it', error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
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
  const readyCallbackRef = useRef(onReady);
  readyCallbackRef.current = onReady;
  const readyGateRef = useRef<ReturnType<typeof createTradingFloorReadyGate> | null>(null);
  if (!readyGateRef.current) {
    readyGateRef.current = createTradingFloorReadyGate(() => readyCallbackRef.current?.());
  }
  const handleRoomMounted = useCallback(() => {
    readyGateRef.current!.roomMounted();
    return () => readyGateRef.current!.roomUnmounted();
  }, []);
  const handleAvatarMounted = useCallback(
    () => readyGateRef.current!.avatarMounted(),
    [],
  );
  const handleAvatarUnmounted = useCallback(
    () => readyGateRef.current!.avatarUnmounted(),
    [],
  );

  useEffect(() => {
    if (active) return;
    if (typeof document !== 'undefined') document.body.style.cursor = 'default';
    resetTradingFloorProximity();
  }, [active]);

  return (
    <>
      <TradingFloorLighting />
      <WorldLabelsOverlayMount />
      <RoomShell onMounted={handleRoomMounted} />
      <TradingFloorScreen active={active} />
      <TradingFloorTradeTape active={active} />
      <TradingFloorDecor active={active} />
      <TradingFloorHotspots />
      <TradingFloorLabels />
      {/* Mounted outside the room's tree so a cold VRM parse never delays the
          room appearing. */}
      <Suspense fallback={null}>
        <TradingFloorAvatarErrorBoundary>
          <TradingFloorPlayer
            onAvatarMounted={handleAvatarMounted}
            onAvatarUnmounted={handleAvatarUnmounted}
          />
        </TradingFloorAvatarErrorBoundary>
      </Suspense>
    </>
  );
}
