'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { ModelLoadBoundary } from '@/lib/three/model-load-boundary';
import { preloadClips } from '@/lib/three/vrm-character-animator';
import { MODEL_REGISTRY, type ModelKey, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import {
  BACK_CORNER_PERCH_LIFT,
  CHAIR_CUSHION_Y,
  CHIBI_TARGET_HEIGHT,
  DEFAULT_BOT_MODEL_KEYS,
  FrozenFigure,
  RiglessPerchFigure,
  SeatFigureSlot,
  SeatPlaceholderFigure,
  stableAvatarModelKey,
  TABLE_POSE_BY_BOT,
  TABLE_POSE_SAMPLE_AT,
  type HandPoseSample,
  type HandSampleHandler,
} from '@/lib/three/cove-seat-figures';
import {
  TableCards3D,
  type ResolvedTableCardSlots,
  type TableCards3DProps,
} from '@/lib/three/cove-table-cards';
import { useHoldemController } from '@/lib/cove/holdem-controller';
import { settlementNarration } from '@/lib/cove/holdem-settlement-narration';
import {
  beginTransition,
  buildHoldemFeltParity,
  completeTransition,
  encodeCardCode,
  publishFeltParity,
  type CardParityPayload,
  type HoldemFeltInput,
  type SlotStatus,
  type Surface,
} from '@/lib/cove/card-parity-mirror';
import type { CashSettledHandSnapshot } from '@clawville/shared';
import type { CashPokerCard, PublicTableStateResponse } from '@/lib/cove/cash-poker';
import {
  getHoldemBadgeRegistryVersion,
  getHoldemSeatBadgeElement,
  getHoldemTableRecenterEpoch,
  separateSeatBadges,
} from '@/lib/cove/holdem-table-view';
import { chainPostBootCompile } from '@/lib/three/boot-core-compile';
import {
  BOT_SEATS,
  buildCashCardState,
  CARD_LAYOUT,
  CHAIR_PELVIS_FORWARD_OFFSET,
  CHAIR_SCALE,
  FURNITURE_SCALE,
  S,
  SEATED_CAMERA_FOV,
  SEATED_CAM_EYE,
  SEATED_CAM_LOOK,
  TABLE_FOOTPRINT_SCALE,
  TABLE_TOP_Y,
  TABLE_XZ_SCALE,
  type RoomSeat,
} from '@/lib/three/holdem-table-layout';

const ROOM_PATH = '/models/cove-room-only.glb';
const TABLE_PATH = '/models/cove-table-clean.glb';
const CHAIR_PATH = '/models/cove-chair-clean.glb';
const PEEK_ENGINE_SEATS = [1, 4] as const;
preloadClips([...TABLE_POSE_BY_BOT, 'sit_idle_m']);

// SCALE UNIFICATION (2026-07-17 founder feedback): every figure renders at
// the SAME world-standard height the walkable cove uses for the player's
// own avatar (COVE_VRM_TARGET_HEIGHT = 160) — the earlier 108-bot/118-dealer
// mix read as "the dealer milady is a giant" and none of them matched the
// movable agent's scale. `S` converts avatar/seat constants authored at the
// original scale-2 basis. Round 8 grows only the table's XZ footprint.
const WORLD_AVATAR_HEIGHT = 160;
// Room shell scaled with the furniture so wall/ceiling proportions track.
const ROOM_SCALE = 1.45;
// Preserve the approved Y scale and translate the visual top from 91.6 to
// elbow-height 70. Round 8's XZ-only growth cannot change this relationship.
const TABLE_SOURCE_TOP_Y = 63.2 * S;
const TABLE_VISUAL_Y = TABLE_TOP_Y - TABLE_SOURCE_TOP_Y;
const BOT_TARGET_HEIGHT = WORLD_AVATAR_HEIGHT;
const DEALER_TARGET_HEIGHT = WORLD_AVATAR_HEIGHT;

function getSeatModelKeys(): readonly ModelKey[] {
  if (typeof window === 'undefined') return DEFAULT_BOT_MODEL_KEYS;
  const isLocalhost = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '[::1]';
  if (process.env.NODE_ENV === 'production' && !isLocalhost) return DEFAULT_BOT_MODEL_KEYS;
  const requested = new URLSearchParams(window.location.search)
    .get('seatModels')
    ?.split(',')
    .map((key) => key.trim());
  if (!requested?.length) return DEFAULT_BOT_MODEL_KEYS;
  return BOT_SEATS.map((_, index) => {
    const requestedKey = requested[index];
    return requestedKey && requestedKey in MODEL_REGISTRY
      ? requestedKey as ModelKey
      : DEFAULT_BOT_MODEL_KEYS[index]!;
  });
}

const BOT_MODEL_KEYS = getSeatModelKeys();
const FORCE_PEEK_CARDS = (() => {
  if (typeof window === 'undefined') return false;
  const isLocalhost = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '[::1]';
  return (process.env.NODE_ENV !== 'production' || isLocalhost)
    && new URLSearchParams(window.location.search).get('seatCards') === '1';
})();
const DEALER_MODEL_KEY = 'milady_official_6' as const;
const DEALER_PATH = (MODEL_REGISTRY[DEALER_MODEL_KEY] as ModelRegistryEntry).path;

function preparedClone(
  source: THREE.Group,
  scale: number | readonly [number, number, number],
): THREE.Group {
  const clone = source.clone(true);
  const bounds = new THREE.Box3().setFromObject(clone);
  const center = bounds.getCenter(new THREE.Vector3());
  const [scaleX, scaleY, scaleZ] = typeof scale === 'number' ? [scale, scale, scale] : scale;
  clone.scale.set(scaleX, scaleY, scaleZ);
  clone.position.set(-center.x * scaleX, -bounds.min.y * scaleY, -center.z * scaleZ);
  clone.updateMatrixWorld(true);
  return clone;
}

// FIRST-PERSON seated POV (founder spec 2026-07-17): the camera is the
// player avatar's EYES at the 6-o'clock seat — seated eye height for a
// 160wu body, just behind the near rail, gazing slightly down across the
// felt at the standing dealer. Neighbors appear at the frame edges the way
// they do from a real seat.
interface PoseAuditView {
  seat: number;
  eye: readonly [number, number, number];
  look: readonly [number, number, number];
}

/** Query-gated verification camera used only for the mandatory front+side
 * evidence set (`?poseSeat=1..5&poseView=front|side`). It reuses the real
 * SeatedLookCamera and room lighting while isolating one figure. */
const POSE_AUDIT_VIEW: PoseAuditView | null = (() => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const seatIndex = Number(params.get('poseSeat'));
  const view = params.get('poseView');
  const seat = BOT_SEATS.find((candidate) => candidate.engineSeatIndex === seatIndex);
  if (!seat || (view !== 'front' && view !== 'side')) return null;
  const distance = view === 'front' ? 165 : 150;
  const forwardX = Math.sin(seat.faceYaw);
  const forwardZ = Math.cos(seat.faceYaw);
  const eyeX = view === 'front'
    ? seat.chairX + forwardX * distance
    : seat.chairX + Math.cos(seat.faceYaw) * distance;
  const eyeZ = view === 'front'
    ? seat.chairZ + forwardZ * distance
    : seat.chairZ - Math.sin(seat.faceYaw) * distance;
  return {
    seat: seat.engineSeatIndex,
    eye: [eyeX, TABLE_TOP_Y + 58, eyeZ],
    look: [seat.chairX, TABLE_TOP_Y + 5, seat.chairZ],
  };
})();

// Round 8 raises and pulls back the seated eye. The 66-degree lens contains
// both extreme shoulders without fisheye looming while the low aim preserves
// the felt-level first-person read.
const CAM_EYE: readonly [number, number, number] = POSE_AUDIT_VIEW?.eye ?? SEATED_CAM_EYE;
const CAM_LOOK: readonly [number, number, number] = POSE_AUDIT_VIEW?.look ?? SEATED_CAM_LOOK;
const CAMERA_FOV = POSE_AUDIT_VIEW ? 48 : SEATED_CAMERA_FOV;

const LOOK_YAW_LIMIT = THREE.MathUtils.degToRad(75);
const LOOK_YAW_SPEED = THREE.MathUtils.degToRad(92);
const LOOK_EASE = 9;
const BASE_LOOK_DX = CAM_LOOK[0] - CAM_EYE[0];
const BASE_LOOK_DY = CAM_LOOK[1] - CAM_EYE[1];
const BASE_LOOK_DZ = CAM_LOOK[2] - CAM_EYE[2];
const BASE_LOOK_HORIZONTAL = Math.hypot(BASE_LOOK_DX, BASE_LOOK_DZ);
const BASE_LOOK_DISTANCE = Math.hypot(BASE_LOOK_DX, BASE_LOOK_DY, BASE_LOOK_DZ);
const BASE_LOOK_YAW = Math.atan2(BASE_LOOK_DX, BASE_LOOK_DZ);
const BASE_LOOK_PITCH = Math.atan2(BASE_LOOK_DY, BASE_LOOK_HORIZONTAL);
const BASE_LOOK_COS_PITCH = Math.cos(BASE_LOOK_PITCH);
const BASE_LOOK_SIN_PITCH = Math.sin(BASE_LOOK_PITCH);

const BADGE_TABLEWARD_OFFSET = 52 * S;
const CENTER_BADGE_LATERAL_OFFSET = -26 * S;
function tablewardBadgeAnchor(
  seat: RoomSeat,
  y: number,
  lateralX = 0,
): readonly [number, number, number] {
  const distance = Math.hypot(seat.x, seat.z);
  return [
    seat.x - (seat.x / distance) * BADGE_TABLEWARD_OFFSET + lateralX,
    y,
    seat.z - (seat.z / distance) * BADGE_TABLEWARD_OFFSET,
  ];
}

/** Six static world anchors. Seat 0 stays in the screen-fixed private tray.
 * Opponent labels sit between torso and table, with a symmetric fixed height
 * stagger so projected neighbors cannot collapse into one stack. */
const SEAT_BADGE_WORLD_ANCHORS: readonly (readonly [number, number, number])[] = [
  [0, TABLE_TOP_Y + 14, -45 * TABLE_FOOTPRINT_SCALE],
  tablewardBadgeAnchor(BOT_SEATS[0]!, TABLE_TOP_Y + 25),
  tablewardBadgeAnchor(BOT_SEATS[1]!, TABLE_TOP_Y + 34),
  tablewardBadgeAnchor(BOT_SEATS[2]!, TABLE_TOP_Y + 9, CENTER_BADGE_LATERAL_OFFSET),
  tablewardBadgeAnchor(BOT_SEATS[3]!, TABLE_TOP_Y + 34),
  tablewardBadgeAnchor(BOT_SEATS[4]!, TABLE_TOP_Y + 25),
] as const;

// Module-scope scratch only: the yaw loop never allocates Three.js objects.
const CAMERA_LOOK_TARGET = new THREE.Vector3();
const BADGE_PROJECT_SCRATCH = new THREE.Vector3();
const BADGE_VIEW_PROJECTION = new THREE.Matrix4();
const BADGE_SLOT_COUNT = SEAT_BADGE_WORLD_ANCHORS.length;
const BADGE_LEFT = new Float64Array(BADGE_SLOT_COUNT);
const BADGE_TOP = new Float64Array(BADGE_SLOT_COUNT);
const BADGE_WIDTH = new Float64Array(BADGE_SLOT_COUNT);
const BADGE_HEIGHT = new Float64Array(BADGE_SLOT_COUNT);
const BADGE_SHOWN = new Uint8Array(BADGE_SLOT_COUNT);

let handCardBackTextureCache: THREE.CanvasTexture | null = null;
function getHandCardBackTexture(): THREE.CanvasTexture {
  if (handCardBackTextureCache) return handCardBackTextureCache;
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  // Bright, high-contrast back (matches the felt atlas back): the old dark
  // teal vanished against the green felt at the seated eye's range.
  const gradient = context.createLinearGradient(0, 0, 192, 256);
  gradient.addColorStop(0, '#f4ead0');
  gradient.addColorStop(1, '#e2d3ac');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 192, 256);
  context.fillStyle = '#b3202f';
  context.fillRect(12, 12, 168, 232);
  context.strokeStyle = '#f4ead0';
  context.lineWidth = 6;
  context.strokeRect(24, 24, 144, 208);
  context.fillStyle = '#f4ead0';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '800 92px ui-monospace, Consolas, monospace';
  context.fillText('?', 96, 132);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  handCardBackTextureCache = texture;
  return texture;
}

function PeekHandCards({ seat, sample }: { seat: RoomSeat; sample: HandPoseSample }) {
  const texture = useMemo(() => getHandCardBackTexture(), []);
  const center = useMemo(() => [
    (sample.left[0] + sample.right[0]) / 2 + Math.sin(seat.faceYaw) * 4,
    (sample.left[1] + sample.right[1]) / 2 + 2.5,
    (sample.left[2] + sample.right[2]) / 2 + Math.cos(seat.faceYaw) * 4,
  ] as const, [sample, seat.faceYaw]);
  const cardWidth = CARD_LAYOUT.botCardWidth * 0.9;
  const cardHeight = CARD_LAYOUT.botCardHeight * 0.9;
  return (
    <group position={center} rotation={[0, seat.faceYaw, 0]}>
      {([-1, 1] as const).map((fan, index) => (
        <mesh
          key={`peek-card-${seat.engineSeatIndex}-${index}`}
          position={[fan * cardWidth * 0.34, fan * 0.12, 0]}
          rotation={[THREE.MathUtils.degToRad(-8), 0, THREE.MathUtils.degToRad(fan * 9)]}
        >
          <planeGeometry args={[cardWidth, cardHeight]} />
          <meshBasicMaterial map={texture} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

let dealerPlateCache: THREE.CanvasTexture | null = null;
function getDealerPlate(): THREE.CanvasTexture {
  if (dealerPlateCache) return dealerPlateCache;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10, 14, 16, 0.88)';
  ctx.beginPath();
  (ctx as CanvasRenderingContext2D & { roundRect?: (...a: number[]) => void }).roundRect?.(6, 6, 500, 116, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 205, 120, 0.85)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = '#ffd88a';
  ctx.font = '700 64px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('DEALER', 256, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  dealerPlateCache = tex;
  return tex;
}

/** Floating DEALER nameplate above the dealer's head, facing the player
 *  camera (founder item 4: make it obvious who the dealer is). */
function DealerPlate({ position }: { position: readonly [number, number, number] }) {
  const tex = useMemo(() => getDealerPlate(), []);
  return (
    <mesh position={[position[0], position[1], position[2]]} rotation={[0, Math.PI, 0]}>
      <planeGeometry args={[52, 13]} />
      <meshBasicMaterial map={tex} transparent toneMapped={false} />
    </mesh>
  );
}

function SeatedLookCamera() {
  const { camera, size } = useThree();
  const heldRef = useRef({ left: false, right: false });
  const viewRef = useRef({
    yaw: 0,
    targetYaw: 0,
    snapCenter: true,
    lastProjectedYaw: Number.NaN,
    lastWidth: 0,
    lastHeight: 0,
    badgeVersion: -1,
    recenterEpoch: getHoldemTableRecenterEpoch(),
  });

  useEffect(() => {
    camera.position.set(...CAM_EYE);
    camera.lookAt(...CAM_LOOK);
    camera.updateProjectionMatrix();

    if (POSE_AUDIT_VIEW) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      if (event.key === 'ArrowLeft') {
        heldRef.current.left = true;
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        heldRef.current.right = true;
        event.preventDefault();
      } else if (event.key === 'Home') {
        viewRef.current.targetYaw = 0;
        viewRef.current.snapCenter = true;
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') heldRef.current.left = false;
      else if (event.key === 'ArrowRight') heldRef.current.right = false;
    };
    const onBlur = () => {
      heldRef.current.left = false;
      heldRef.current.right = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [camera]);

  useFrame((_, delta) => {
    if (POSE_AUDIT_VIEW) return;
    const view = viewRef.current;
    const held = heldRef.current;
    const recenterEpoch = getHoldemTableRecenterEpoch();
    if (recenterEpoch !== view.recenterEpoch) {
      view.recenterEpoch = recenterEpoch;
      view.targetYaw = 0;
    }

    const lookDirection = Number(held.left) - Number(held.right);
    if (lookDirection !== 0) {
      view.targetYaw = THREE.MathUtils.clamp(
        view.targetYaw + lookDirection * LOOK_YAW_SPEED * Math.min(delta, 0.05),
        -LOOK_YAW_LIMIT,
        LOOK_YAW_LIMIT,
      );
    }

    if (view.snapCenter) {
      view.snapCenter = false;
      view.yaw = 0;
      view.targetYaw = 0;
    } else {
      const ease = 1 - Math.exp(-LOOK_EASE * Math.min(delta, 0.05));
      view.yaw += (view.targetYaw - view.yaw) * ease;
      if (Math.abs(view.targetYaw - view.yaw) < 0.00005) view.yaw = view.targetYaw;
    }

    const badgeVersion = getHoldemBadgeRegistryVersion();
    const cameraChanged = view.yaw !== view.lastProjectedYaw;
    const viewportChanged = size.width !== view.lastWidth || size.height !== view.lastHeight;
    const registryChanged = badgeVersion !== view.badgeVersion;
    if (!cameraChanged && !viewportChanged && !registryChanged) return;

    view.lastProjectedYaw = view.yaw;
    view.lastWidth = size.width;
    view.lastHeight = size.height;
    view.badgeVersion = badgeVersion;

    const lookYaw = BASE_LOOK_YAW + view.yaw;
    CAMERA_LOOK_TARGET.set(
      CAM_EYE[0] + Math.sin(lookYaw) * BASE_LOOK_COS_PITCH * BASE_LOOK_DISTANCE,
      CAM_EYE[1] + BASE_LOOK_SIN_PITCH * BASE_LOOK_DISTANCE,
      CAM_EYE[2] + Math.cos(lookYaw) * BASE_LOOK_COS_PITCH * BASE_LOOK_DISTANCE,
    );
    camera.position.set(...CAM_EYE);
    camera.lookAt(CAMERA_LOOK_TARGET);
    camera.updateMatrixWorld();

    BADGE_VIEW_PROJECTION.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (let seat = 0; seat < BADGE_SLOT_COUNT; seat += 1) {
      BADGE_SHOWN[seat] = 0;
      const element = getHoldemSeatBadgeElement(seat);
      if (!element) continue;
      const anchor = SEAT_BADGE_WORLD_ANCHORS[seat]!;
      BADGE_PROJECT_SCRATCH.set(anchor[0], anchor[1], anchor[2]).applyMatrix4(BADGE_VIEW_PROJECTION);
      const left = (BADGE_PROJECT_SCRATCH.x * 0.5 + 0.5) * size.width;
      const top = (-BADGE_PROJECT_SCRATCH.y * 0.5 + 0.5) * size.height + 10;
      const visible = BADGE_PROJECT_SCRATCH.z > -1
        && BADGE_PROJECT_SCRATCH.z < 1
        && left > 58
        && left < size.width - 58
        && top > 44
        && top < size.height - 84;
      BADGE_LEFT[seat] = left;
      BADGE_TOP[seat] = top;
      BADGE_WIDTH[seat] = element.offsetWidth;
      BADGE_HEIGHT[seat] = element.offsetHeight;
      BADGE_SHOWN[seat] = visible ? 1 : 0;
      element.style.setProperty('--seat-visible', visible ? '1' : '0');
    }
    separateSeatBadges(BADGE_LEFT, BADGE_TOP, BADGE_WIDTH, BADGE_HEIGHT, BADGE_SHOWN);
    for (let seat = 0; seat < BADGE_SLOT_COUNT; seat += 1) {
      const element = getHoldemSeatBadgeElement(seat);
      if (!element) continue;
      element.style.left = BADGE_LEFT[seat] + 'px';
      element.style.top = BADGE_TOP[seat] + 'px';
    }
  });

  return null;
}

function Precompile() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    // R3-2 arbiter: routed through the boot-compile FIFO + poison registry.
    let unmounted = false;
    const raf = requestAnimationFrame(() => {
      const renderer = gl as unknown as { compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<void> };
      if (typeof renderer.compileAsync === 'function') {
        void chainPostBootCompile({
          gl,
          compile: () => renderer.compileAsync!(scene, camera),
          label: 'holdem-table',
          isCancelled: () => unmounted,
        });
      }
    });
    return () => {
      unmounted = true;
      cancelAnimationFrame(raf);
    };
  }, [camera, gl, scene]);
  return null;
}

export interface LiveTableRoomState {
  table: PublicTableStateResponse | null;
  /** The server seat placed at the six-o'clock POV. Spectators use seat 0. */
  povSeatIndex: number;
  settled: CashSettledHandSnapshot | null;
  /**
   * The viewer's OWN hole cards, drawn face up on the felt at the POV position.
   * Source: `state-for-agent` `view.holeCards` (the only card-bearing surface;
   * the public snapshot never carries them). `handNumber` is the hand those
   * cards belong to (`view.handNumber`): the room draws them only while it
   * equals the live (or settled) hand's number, so a stale selfView from the
   * previous hand can never paint wrong cards on the felt. Keep passing it
   * through the settle window so the cards stay up for the showdown.
   */
  ownHole?: { handNumber: number; cards: readonly [CashPokerCard, CashPokerCard] } | null;
}

interface ResolvedCashFigureSeat {
  seatIndex: number;
  avatarId: string;
}

export function HoldemTableRoomScene({
  instanceId,
  liveTable,
}: {
  instanceId: string;
  liveTable?: LiveTableRoomState;
}) {
  const roomGltf = useGLTF(ROOM_PATH);
  const tableGltf = useGLTF(TABLE_PATH);
  const chairGltf = useGLTF(CHAIR_PATH);
  const room = useMemo(() => preparedClone(roomGltf.scene, ROOM_SCALE), [roomGltf.scene]);
  const table = useMemo(
    () => preparedClone(tableGltf.scene, [TABLE_XZ_SCALE, FURNITURE_SCALE, TABLE_XZ_SCALE]),
    [tableGltf.scene],
  );
  const chairs = useMemo(
    () => BOT_SEATS.map(() => preparedClone(chairGltf.scene, CHAIR_SCALE)),
    [chairGltf.scene],
  );
  const phase = useHoldemController((state) => state.phase);
  const live = useHoldemController((state) => state.live);
  const practiceSettled = useHoldemController((state) => state.settled);
  const publicSeats = useHoldemController((state) => state.seats);
  const cashLive = liveTable?.table?.live ?? null;
  const cashSettled = liveTable?.settled ?? null;
  const roomSeats = useMemo<readonly RoomSeat[]>(() => {
    if (!liveTable) return BOT_SEATS;
    return BOT_SEATS.map((seat, index) => ({
      ...seat,
      engineSeatIndex: (liveTable.povSeatIndex + index + 1) % 6,
    }));
  }, [liveTable]);
  const [handSamples, setHandSamples] = useState<Readonly<Record<number, HandPoseSample | null>>>({});
  const onHandSample = useCallback<HandSampleHandler>((engineSeatIndex, sample) => {
    setHandSamples((current) => ({ ...current, [engineSeatIndex]: sample }));
  }, []);
  const inHandPeekSeats = useMemo(() => {
    const peekSeatIndices = roomSeats
      .filter((_, index) => index === 0 || index === 3)
      .map((seat) => seat.engineSeatIndex);
    if (FORCE_PEEK_CARDS) {
      return peekSeatIndices.filter((engineSeatIndex) => handSamples[engineSeatIndex] != null);
    }
    if (liveTable) {
      if (cashSettled) return [];
      if (!cashLive) return [];
      return peekSeatIndices.filter((engineSeatIndex) => {
        const seat = cashLive.seats.find((candidate) => candidate.seatIndex === engineSeatIndex);
        return handSamples[engineSeatIndex] != null
          && (seat?.status === 'active' || seat?.status === 'allin');
      });
    }
    if (!live || phase === 'idle' || phase === 'settled') return [];
    return PEEK_ENGINE_SEATS.filter((engineSeatIndex) => {
      const seat = publicSeats.find((candidate) => candidate.seatIndex === engineSeatIndex);
      return handSamples[engineSeatIndex] != null
        && seat?.status !== 'folded'
        && (seat?.holeCards?.length ?? 0) > 0;
    });
  }, [cashLive, cashSettled, handSamples, live, liveTable, phase, publicSeats, roomSeats]);
  const ownHole = liveTable?.ownHole ?? null;
  const povSeatIndex = liveTable?.povSeatIndex ?? 0;
  const cashCardState = useMemo<NonNullable<TableCards3DProps['externalState']> | undefined>(
    () => (liveTable
      ? buildCashCardState({ cashLive, cashSettled, ownHole, povSeatIndex })
      : undefined),
    [cashLive, cashSettled, liveTable, ownHole, povSeatIndex],
  );
  const lastResolvedSlotsRef = useRef<ResolvedTableCardSlots | null>(null);
  const paritySurface: Surface = liveTable ? 'holdem-felt-3d' : 'holdem-felt-practice';
  const publishResolvedFelt = useCallback((resolved: ResolvedTableCardSlots) => {
    const peekOpponents = inHandPeekSeats.map((seatIndex) => {
      const cashSeat = cashLive?.seats.find((seat) => seat.seatIndex === seatIndex);
      const practiceSeat = publicSeats.find((seat) => seat.seatIndex === seatIndex);
      const status: SlotStatus = cashSeat
        ? cashSeat.status === 'folded'
          ? 'folded'
          : cashSeat.status === 'allin'
            ? 'allin'
            : cashSeat.status === 'busted'
              ? 'busted'
              : cashSeat.status === 'sitting_out'
                ? 'resolved'
                : 'active'
        : practiceSeat?.status === 'folded'
          ? 'folded'
          : practiceSeat?.status === 'allin'
            ? 'allin'
            : practiceSeat?.status === 'out'
              ? 'busted'
              : 'active';
      return {
        seatIndex,
        status,
        count: 2,
        peek: true,
      };
    });
    const boardCount = resolved.board.filter((card) => card !== null).length;
    const boardDealStep = boardCount >= 5
      ? 'river'
      : boardCount >= 4
        ? 'turn'
        : boardCount >= 3
          ? 'flop'
          : 'hole';
    const dealStep = liveTable
      ? cashSettled ? 'showdown' : boardDealStep
      : phase === 'settled' ? 'showdown' : boardDealStep;
    let input: HoldemFeltInput;
    if (liveTable) {
      const handNumber = cashSettled?.handNumber ?? cashLive?.handNumber ?? null;
      const correlationHand = cashSettled
        ? `${cashSettled.tableId}:${cashSettled.handNumber}`
        : handNumber == null
          ? ''
          : `${liveTable.table?.table.id ?? ''}:${handNumber}`;
      input = {
        kind: 'cash',
        board: resolved.board.filter((card): card is NonNullable<typeof card> => card !== null),
        opponents: [
          ...resolved.opponents.map((opponent) => ({
            seatIndex: opponent.seatIndex,
            status: opponent.status,
            count: opponent.holeCardCount,
            peek: false,
          })),
          ...peekOpponents,
        ],
        settled: cashSettled,
        correlation: {
          hand: correlationHand,
          handNumber,
        },
        dealStep,
        phase: cashSettled ? 'settled' : cashLive?.street ?? 'idle',
        transition: 'idle',
        ownSeatIndex: liveTable.povSeatIndex,
        ...(cashSettled ? {
          bannerText: cashSettled.endedAt === 'showdown'
            ? 'Showdown'
            : 'Hand won without showdown',
        } : {}),
      };
    } else {
      const controllerHand = live ?? practiceSettled;
      const narration = practiceSettled
        ? settlementNarration(practiceSettled)
        : null;
      input = {
        kind: 'practice',
        board: [...resolved.board],
        opponents: [
          ...resolved.opponents.map((opponent) => ({
            seatIndex: opponent.seatIndex,
            status: opponent.status,
            cards: opponent.faceDown ? null : opponent.cards,
            count: opponent.holeCardCount,
            peek: false,
          })),
          ...peekOpponents.map((opponent) => ({ ...opponent, cards: null })),
        ],
        correlation: {
          hand: controllerHand?.handId ?? '',
          handNumber: controllerHand?.handIndex ?? null,
        },
        dealStep,
        phase,
        transition: 'idle',
        settled: practiceSettled,
        ...(narration ? { bannerText: narration.headline } : {}),
      };
    }
    const built = buildHoldemFeltParity(input);
    // Own cards drawn face up on the felt are mirrored in `meta['own-felt-cards']`
    // (rendered as `data-own-felt-cards`) so the parity DOM states exactly what
    // the felt shows. They cannot be slots: the felt surface cap is 16 and a
    // full 5-opponent table already publishes 15 (SURFACE_SLOT_CAP in
    // card-parity-mirror.ts). The key is absent when no own card is drawn.
    const ownFeltCodes = (resolved.ownCards ?? [])
      .map((card) => encodeCardCode(card))
      .flatMap((encoded) => (encoded.facing === 'up' ? [encoded.card as string] : []));
    const payload: CardParityPayload = {
      ...built,
      meta: {
        ...built.meta,
        'on-felt': String(resolved.onFelt),
        ...(ownFeltCodes.length === 2 ? { 'own-felt-cards': ownFeltCodes.join(',') } : {}),
      },
    };
    publishFeltParity(instanceId, payload);
  }, [
    cashLive,
    cashSettled,
    inHandPeekSeats,
    instanceId,
    live,
    liveTable,
    phase,
    practiceSettled,
    publicSeats,
  ]);
  const onResolvedSlots = useCallback((resolved: ResolvedTableCardSlots) => {
    lastResolvedSlotsRef.current = resolved;
    publishResolvedFelt(resolved);
  }, [publishResolvedFelt]);
  const onMuckFadeStart = useCallback((_resolved: ResolvedTableCardSlots) => {
    return beginTransition(instanceId, paritySurface, 'muck-fading');
  }, [instanceId, paritySurface]);
  const onMuckFadeComplete = useCallback((spanToken: number) => {
    completeTransition(instanceId, paritySurface, spanToken);
  }, [instanceId, paritySurface]);

  useEffect(() => {
    const resolved = lastResolvedSlotsRef.current;
    if (resolved) publishResolvedFelt(resolved);
  }, [publishResolvedFelt]);

  return (
    <>
      <SeatedLookCamera />
      <ambientLight intensity={0.85} color={0xffe6cf} />
      <directionalLight position={[-70, 130, 80]} intensity={2.2} color={0xffd2a1} />
      <directionalLight position={[85, 85, 25]} intensity={1.35} color={0x7fd6ff} />
      <pointLight position={[0, 115, -55]} intensity={1150} distance={260} decay={2} color={0xffb86b} />
      {/* Dealer key — the dealer stands at the +Z flat edge; keep that
          zone lit or she reads as a silhouette. */}
      <pointLight position={[0, 150, 110]} intensity={900} distance={260} decay={2} color={0xffd9b0} />

      <primitive object={room} />
      {/* Procedural floor/backdrop guarantees a clean modal-like stage even
          where the extracted shell opens beyond the fixed camera frustum.
          Backdrop sits BEHIND THE DEALER (+Z, facing the camera at -Z) —
          after the perspective flip the old -Z plane sat behind the camera,
          leaving the shell's dark far-wall openings as black voids. */}
      <mesh position={[0, -0.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[700, 700]} />
        <meshStandardMaterial color={0x241a26} roughness={0.92} metalness={0.04} />
      </mesh>
      <mesh position={[0, 120, 185]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[800, 280]} />
        <meshStandardMaterial color={0x43283a} roughness={0.9} metalness={0.02} />
      </mesh>
      {/* Table unrotated: its baked dealer-station cutout faces -Z — which
          is where the dealer now STANDS (first-person restage). Betting
          spots face +Z, in front of the player camera and the near seats. */}
      <group position={[0, TABLE_VISUAL_Y, 0]}>
        <primitive object={table} />
      </group>

      {/* Round-10 table chairs share each body's faceYaw. Their measured
          y=50.32 cushion pins every humanoid hip and rigless perch profile. */}
      {roomSeats.map((seat, index) => {
        const resolvedSeat: ResolvedCashFigureSeat | undefined = cashLive?.seats.find(
          (candidate) => candidate.seatIndex === seat.engineSeatIndex,
        ) ?? (cashLive === null
          ? liveTable?.table?.seats.find(
            (candidate) => candidate.status !== 'left'
              && candidate.seatIndex === seat.engineSeatIndex,
          )
          : undefined);
        const modelKey = resolvedSeat
          ? stableAvatarModelKey(resolvedSeat.avatarId)
          : BOT_MODEL_KEYS[index]!;
        const reg = MODEL_REGISTRY[modelKey] as ModelRegistryEntry;
        const usesScale100SitFallback = reg.animatorId === 'hermes-female'
          || reg.animatorId === 'hermes-male'
          || reg.animatorId === 'tekk'
          || reg.animatorId === 'adinero';
        const usesChibiSitFallback = reg.animatorId === 'chibi';
        const usesManualSit = usesScale100SitFallback || usesChibiSitFallback;
        const handSampleSeat = index === 0 || index === 3
          ? seat.engineSeatIndex
          : undefined;
        const figureVisible = !liveTable || Boolean(resolvedSeat);
        const figureId = `holdem-room-seat-${seat.engineSeatIndex}-${resolvedSeat?.avatarId ?? modelKey}`;
        return (
          <group
            key={`holdem-seat-${seat.engineSeatIndex}`}
            name={`holdem-seat-${seat.engineSeatIndex}`}
            visible={!POSE_AUDIT_VIEW || POSE_AUDIT_VIEW.seat === seat.engineSeatIndex}
          >
            <group position={[seat.chairX, 0, seat.chairZ]} rotation={[0, seat.faceYaw, 0]}>
              <primitive object={chairs[index]!} />
            </group>
            {/* Optional figure: a seat model (VRM or rigless GLB) that fails
                every retry is skipped with one console.error. The chair,
                cards, badges and seat actions keep running; a failed peek
                seat drops its hand sample so its cards return to the felt. */}
            {figureVisible && (
              <SeatFigureSlot
                key={`${figureId}|${reg.path}`}
                assetUrl={reg.path}
                label={`holdem-seat:${seat.engineSeatIndex}`}
                // Id AND path: one avatar id can keep its id after a model
                // change; a failed first model must not hide the new one.
                resetKey={`${figureId}|${reg.path}`}
                placeholder={(
                  <SeatPlaceholderFigure
                    engineSeatIndex={seat.engineSeatIndex}
                    position={[seat.x, 0, seat.z]}
                    yaw={seat.faceYaw}
                  />
                )}
                onModelFailed={handSampleSeat === undefined
                  ? undefined
                  : () => onHandSample(handSampleSeat, null)}
              >
                {reg.avatar_type === 'glb' ? (
                  <RiglessPerchFigure
                    reg={reg}
                    modelKey={modelKey}
                    position={[seat.x, 0, seat.z]}
                    yaw={seat.faceYaw}
                    lift={index === 1 || index === 3 ? BACK_CORNER_PERCH_LIFT : 0}
                  />
                ) : (
                  <FrozenFigure
                    reg={reg}
                    instanceId={figureId}
                    pose={usesChibiSitFallback
                      ? 'idle'
                      : usesScale100SitFallback ? 'sit_idle_m' : TABLE_POSE_BY_BOT[index]!}
                    position={[seat.x, 0, seat.z]}
                    yaw={seat.faceYaw}
                    targetHeight={usesChibiSitFallback ? CHIBI_TARGET_HEIGHT : BOT_TARGET_HEIGHT}
                    cushionY={CHAIR_CUSHION_Y}
                    sampleAt={usesManualSit ? 0.2 : TABLE_POSE_SAMPLE_AT}
                    manualSeat={usesManualSit}
                    relaxManualUpperBody={usesScale100SitFallback}
                    handSampleSeat={handSampleSeat}
                    onHandSample={onHandSample}
                  />
                )}
              </SeatFigureSlot>
            )}
          </group>
        );
      })}

      {inHandPeekSeats.map((engineSeatIndex) => {
        const seat = roomSeats.find((candidate) => candidate.engineSeatIndex === engineSeatIndex);
        const sample = handSamples[engineSeatIndex];
        return seat && sample
          ? <PeekHandCards key={`peek-hand-${engineSeatIndex}`} seat={seat} sample={sample} />
          : null;
      })}

      {/* Dealer STANDS at the MEASURED flat edge (+Z, the 251wu straight
          side), facing the player at the arc (-Z ⇒ yaw π). */}
      <group visible={!POSE_AUDIT_VIEW}>
        <ModelLoadBoundary assetUrl={DEALER_PATH} label="holdem-dealer" resetKey={DEALER_PATH}>
          <FrozenFigure
            reg={MODEL_REGISTRY[DEALER_MODEL_KEY] as ModelRegistryEntry}
            instanceId="holdem-room-dealer"
            pose="idle"
            position={[0, 0, 78 * TABLE_FOOTPRINT_SCALE]}
            yaw={Math.PI}
            targetHeight={DEALER_TARGET_HEIGHT}
          />
        </ModelLoadBoundary>
        <DealerPlate position={[0, DEALER_TARGET_HEIGHT + 18, 78 * TABLE_FOOTPRINT_SCALE]} />
      </group>

      <TableCards3D
        centerX={0}
        centerZ={0}
        feltTopY={TABLE_TOP_Y}
        seats={roomSeats}
        layout={CARD_LAYOUT}
        suppressSeatIndices={inHandPeekSeats}
        externalState={cashCardState}
        onResolvedSlots={onResolvedSlots}
        onMuckFadeStart={onMuckFadeStart}
        onMuckFadeComplete={onMuckFadeComplete}
      />
      <Precompile />
    </>
  );
}

export default function HoldemTableRoomCanvas({
  instanceId,
  liveTable,
}: {
  instanceId: string;
  liveTable?: LiveTableRoomState;
}) {
  return (
    <Canvas
      key="holdem-table-room"
      dpr={[0.65, 1]}
      frameloop="always"
      camera={{ fov: CAMERA_FOV, near: 0.5, far: 900, position: [CAM_EYE[0], CAM_EYE[1], CAM_EYE[2]] }}
      gl={{ antialias: false, powerPreference: 'low-power' }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x100b16); }}
    >
      <KTX2LoaderSetup />
      <Suspense fallback={null}>
        <HoldemTableRoomScene instanceId={instanceId} liveTable={liveTable} />
      </Suspense>
    </Canvas>
  );
}

useGLTF.preload(ROOM_PATH);
useGLTF.preload(TABLE_PATH);
useGLTF.preload(CHAIR_PATH);
