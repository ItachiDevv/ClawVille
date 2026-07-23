'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useHoldemController, type HoldemPhase } from '@/lib/cove/holdem-controller';
import type {
  HoldemCard,
  HoldemRank,
  HoldemSuit,
  SeatState,
} from '@/lib/cove/holdem-types';
import { useCoveStore } from '@/stores/cove';
import {
  getHoldemSettledRevealHandId,
  subscribeHoldemSettledReveal,
} from '@/lib/cove/holdem-table-view';
import type { SlotStatus } from '@/lib/cove/card-parity-mirror';

const ATLAS_CELL_WIDTH = 192;
const ATLAS_CELL_HEIGHT = 256;
const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 7;
const ATLAS_WIDTH = ATLAS_CELL_WIDTH * ATLAS_COLUMNS;
const ATLAS_HEIGHT = ATLAS_CELL_HEIGHT * ATLAS_ROWS;
const ATLAS_BACK_CELL = 52;
const ATLAS_UV_INSET = 2;
const MAX_CARD_QUADS = 17;

const SUITS: readonly HoldemSuit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS: readonly HoldemRank[] = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
];
const SUIT_SYMBOL: Record<HoldemSuit, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
};
const SUIT_COLOR: Record<HoldemSuit, string> = {
  clubs: '#111111',
  diamonds: '#c0202c',
  hearts: '#c0202c',
  spades: '#111111',
};
const SUIT_INDEX: Record<HoldemSuit, number> = {
  clubs: 0,
  diamonds: 1,
  hearts: 2,
  spades: 3,
};
const RANK_INDEX: Record<HoldemRank, number> = {
  '2': 0,
  '3': 1,
  '4': 2,
  '5': 3,
  '6': 4,
  '7': 5,
  '8': 6,
  '9': 7,
  '10': 8,
  J: 9,
  Q: 10,
  K: 11,
  A: 12,
};

let cardAtlasCache: THREE.CanvasTexture | null = null;

function traceRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawCardCorner(
  context: CanvasRenderingContext2D,
  rank: HoldemRank,
  symbol: string,
  color: string,
): void {
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.font = '800 42px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  context.fillText(rank, 30, 14);
  context.font = '36px Georgia, serif';
  context.fillText(symbol, 30, 58);
}

function drawFaceCell(
  context: CanvasRenderingContext2D,
  cellIndex: number,
  suit: HoldemSuit,
  rank: HoldemRank,
): void {
  const x = (cellIndex % ATLAS_COLUMNS) * ATLAS_CELL_WIDTH;
  const y = Math.floor(cellIndex / ATLAS_COLUMNS) * ATLAS_CELL_HEIGHT;
  const gradient = context.createLinearGradient(
    x,
    y,
    x + ATLAS_CELL_WIDTH,
    y + ATLAS_CELL_HEIGHT,
  );
  gradient.addColorStop(0, '#f0ead4');
  gradient.addColorStop(1, '#e8e0c8');
  context.fillStyle = gradient;
  context.fillRect(x, y, ATLAS_CELL_WIDTH, ATLAS_CELL_HEIGHT);

  context.strokeStyle = '#b0b8c4';
  context.lineWidth = 5;
  traceRoundedRect(context, x + 3, y + 3, ATLAS_CELL_WIDTH - 6, ATLAS_CELL_HEIGHT - 6, 14);
  context.stroke();

  const symbol = SUIT_SYMBOL[suit];
  const color = SUIT_COLOR[suit];
  context.save();
  context.translate(x, y);
  drawCardCorner(context, rank, symbol, color);
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '86px Georgia, serif';
  context.fillText(symbol, ATLAS_CELL_WIDTH / 2, ATLAS_CELL_HEIGHT / 2 + 5);
  context.restore();

  context.save();
  context.translate(x + ATLAS_CELL_WIDTH, y + ATLAS_CELL_HEIGHT);
  context.rotate(Math.PI);
  drawCardCorner(context, rank, symbol, color);
  context.restore();
}

function drawBackCell(context: CanvasRenderingContext2D): void {
  const x = (ATLAS_BACK_CELL % ATLAS_COLUMNS) * ATLAS_CELL_WIDTH;
  const y = Math.floor(ATLAS_BACK_CELL / ATLAS_COLUMNS) * ATLAS_CELL_HEIGHT;
  const gradient = context.createLinearGradient(
    x,
    y,
    x + ATLAS_CELL_WIDTH,
    y + ATLAS_CELL_HEIGHT,
  );
  gradient.addColorStop(0, '#0d3a4a');
  gradient.addColorStop(1, '#0a2d3a');
  context.fillStyle = gradient;
  context.fillRect(x, y, ATLAS_CELL_WIDTH, ATLAS_CELL_HEIGHT);

  context.strokeStyle = 'rgba(0, 200, 180, 0.25)';
  context.lineWidth = 5;
  traceRoundedRect(context, x + 3, y + 3, ATLAS_CELL_WIDTH - 6, ATLAS_CELL_HEIGHT - 6, 14);
  context.stroke();
  context.strokeStyle = 'rgba(0, 200, 180, 0.14)';
  context.lineWidth = 3;
  traceRoundedRect(context, x + 18, y + 18, ATLAS_CELL_WIDTH - 36, ATLAS_CELL_HEIGHT - 36, 10);
  context.stroke();
  context.fillStyle = 'rgba(0, 200, 180, 0.18)';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '800 92px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  context.fillText('?', x + ATLAS_CELL_WIDTH / 2, y + ATLAS_CELL_HEIGHT / 2 + 4);
}

function getCardAtlas(): THREE.CanvasTexture {
  if (cardAtlasCache) return cardAtlasCache;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = ATLAS_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('TableCards3D could not create its card atlas canvas');

  for (let suitIndex = 0; suitIndex < SUITS.length; suitIndex += 1) {
    for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
      const suit = SUITS[suitIndex]!;
      const rank = RANKS[rankIndex]!;
      drawFaceCell(context, suitIndex * RANKS.length + rankIndex, suit, rank);
    }
  }
  drawBackCell(context);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  cardAtlasCache = texture;
  return texture;
}

function atlasCellForCard(card: HoldemCard): number {
  if (card.hidden) return ATLAS_BACK_CELL;
  return SUIT_INDEX[card.suit] * RANKS.length + RANK_INDEX[card.rank];
}

function appendCardQuad(
  positions: number[],
  uvs: number[],
  indices: number[],
  centerX: number,
  centerY: number,
  centerZ: number,
  yaw: number,
  cardWidth: number,
  cardHeight: number,
  atlasCell: number,
  hingeTiltRad: number,
): void {
  if (indices.length / 6 >= MAX_CARD_QUADS) return;

  const halfWidth = cardWidth / 2;
  const halfHeight = cardHeight / 2;
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  const tiltCos = Math.cos(hingeTiltRad);
  const tiltSin = Math.sin(hingeTiltRad);
  const vertexOffset = positions.length / 3;
  const corners = [
    [-halfWidth, -halfHeight],
    [-halfWidth, halfHeight],
    [halfWidth, halfHeight],
    [halfWidth, -halfHeight],
  ] as const;

  for (const [localX, localZ] of corners) {
    // Hinge about the NEAR edge (local -Z, the edge toward the seat): the far
    // edge lifts off the felt so the face tips toward the seated eye and no
    // corner ever dips below the surface. hingeTiltRad=0 keeps the card flat.
    const hingeDist = localZ + halfHeight;
    const tiltedZ = -halfHeight + hingeDist * tiltCos;
    positions.push(
      centerX + localX * cosine + tiltedZ * sine,
      centerY + hingeDist * tiltSin,
      centerZ - localX * sine + tiltedZ * cosine,
    );
  }

  const column = atlasCell % ATLAS_COLUMNS;
  const row = Math.floor(atlasCell / ATLAS_COLUMNS);
  const u0 = (column * ATLAS_CELL_WIDTH + ATLAS_UV_INSET) / ATLAS_WIDTH;
  const u1 = ((column + 1) * ATLAS_CELL_WIDTH - ATLAS_UV_INSET) / ATLAS_WIDTH;
  const vTop = 1 - (row * ATLAS_CELL_HEIGHT + ATLAS_UV_INSET) / ATLAS_HEIGHT;
  const vBottom = 1 - ((row + 1) * ATLAS_CELL_HEIGHT - ATLAS_UV_INSET) / ATLAS_HEIGHT;
  // u runs HIGH→LOW across local +X: for a +Y-facing quad in the XZ plane,
  // the straight u0→u1 order horizontally mirrors the face (caught live in
  // P3.1 — a "3" rendered as "Ɛ" from the seat; overhead symmetric pips hid
  // it). Swapped order renders every glyph unmirrored, upright for the
  // viewer the card's yaw faces (texture top pointing away from them).
  uvs.push(u1, vBottom, u1, vTop, u0, vTop, u0, vBottom);
  indices.push(
    vertexOffset,
    vertexOffset + 1,
    vertexOffset + 2,
    vertexOffset,
    vertexOffset + 2,
    vertexOffset + 3,
  );
}

function cardSignature(card: HoldemCard | null): string {
  if (!card) return '-';
  return card.hidden ? 'back' : `${card.suit}:${card.rank}`;
}

function handSignature(
  phase: HoldemPhase,
  playerHoleCards: HoldemCard[],
  communityCards: (HoldemCard | null)[],
  seats: SeatState[],
): string {
  if (phase === 'idle') return 'idle';
  const player = playerHoleCards.map(cardSignature).join(',');
  const board = communityCards.map(cardSignature).join(',');
  const opponents = seats.map((seat) => (
    `${seat.seatIndex}:${seat.status}:${seat.holeCards?.map(cardSignature).join(',') ?? '-'}`
  )).join('|');
  return `${phase};p=${player};b=${board};s=${opponents}`;
}

export interface TableCardSeat {
  engineSeatIndex: number;
  x: number;
  z: number;
  faceYaw: number;
}

export interface TableCardLayout {
  /** Public board row anchor/yaw in table-local world coordinates. */
  boardX: number;
  boardZ: number;
  boardYaw: number;
  /** Community cards — real-proportioned and small enough for all five. */
  boardCardWidth: number;
  boardCardHeight: number;
  boardSpacing: number;
  /** Opponent backs/faces — presence markers in front of bot seats. */
  botCardWidth: number;
  botCardHeight: number;
  botPairGap: number;
  botAnchorScale: number;
  surfaceLift: number;
  /** Conservative card-layer audit envelope in table-local world units. */
  feltHalfX: number;
  feltHalfZ: number;
}

export interface TableCards3DProps {
  centerX: number;
  centerZ: number;
  feltTopY: number;
  seats: readonly TableCardSeat[];
  layout: Readonly<TableCardLayout>;
  suppressSeatIndices?: readonly number[];
  /** Cash-ring-table projection. When present, this public-only state replaces
   * the legacy practice controller as the felt source. Opponent cards are
   * represented only by a count and therefore can never render face-up. */
  externalState?: Readonly<{
    active: boolean;
    board: readonly HoldemCard[];
    seats: readonly Readonly<{
      seatIndex: number;
      status: 'active' | 'folded' | 'allin' | 'sitting_out' | 'busted';
      holeCardCount: number;
    }>[];
  }>;
  /** Exact card decisions consumed by the geometry build. The room remains
   * the sole publisher because it also owns the separate PeekHandCards. */
  onResolvedSlots?: (resolved: ResolvedTableCardSlots) => void;
  onMuckFadeStart?: (resolved: ResolvedTableCardSlots) => number;
  onMuckFadeComplete?: (spanToken: number) => void;
}

export interface ResolvedTableCardOpponent {
  seatIndex: number;
  status: SlotStatus;
  holeCardCount: number;
  cards: [HoldemCard, HoldemCard] | null;
  faceDown: boolean;
}

export interface ResolvedTableCardSlots {
  board: readonly (HoldemCard | null)[];
  opponents: readonly ResolvedTableCardOpponent[];
  onFelt: boolean;
}

function practiceSlotStatus(status: SeatState['status'] | undefined): SlotStatus {
  if (status === 'folded') return 'folded';
  if (status === 'allin') return 'allin';
  if (status === 'out') return 'busted';
  return 'active';
}

function cashSlotStatus(
  status: NonNullable<TableCards3DProps['externalState']>['seats'][number]['status'] | undefined,
): SlotStatus {
  if (status === 'folded') return 'folded';
  if (status === 'allin') return 'allin';
  if (status === 'busted') return 'busted';
  if (status === 'sitting_out') return 'resolved';
  return 'active';
}

export function TableCards3D({
  centerX,
  centerZ,
  feltTopY,
  seats: tableSeats,
  layout,
  suppressSeatIndices = [],
  externalState,
  onResolvedSlots,
  onMuckFadeStart,
  onMuckFadeComplete,
}: TableCards3DProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const muckMeshRef = useRef<THREE.Mesh>(null);
  const muckFadeRef = useRef({ active: false, elapsed: 0 });
  const muckSpanTokenRef = useRef<number | null>(null);
  const resolvedCallbackRef = useRef(onResolvedSlots);
  const muckStartCallbackRef = useRef(onMuckFadeStart);
  const muckCompleteCallbackRef = useRef(onMuckFadeComplete);
  resolvedCallbackRef.current = onResolvedSlots;
  muckStartCallbackRef.current = onMuckFadeStart;
  muckCompleteCallbackRef.current = onMuckFadeComplete;
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  const muckGeometry = useMemo(() => new THREE.BufferGeometry(), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({
    map: null,
    toneMapped: false,
    side: THREE.FrontSide,
    transparent: false,
    depthWrite: true,
  }), []);
  const muckMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    map: null,
    toneMapped: false,
    side: THREE.FrontSide,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  }), []);

  const phase = useHoldemController((state) => state.phase);
  const playerHoleCards = useHoldemController((state) => state.playerHoleCards);
  const communityCards = useHoldemController((state) => state.communityCards);
  const seats = useHoldemController((state) => state.seats);
  const live = useHoldemController((state) => state.live);
  const settled = useHoldemController((state) => state.settled);
  const revealHandId = useSyncExternalStore(
    subscribeHoldemSettledReveal,
    getHoldemSettledRevealHandId,
    getHoldemSettledRevealHandId,
  );
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const hasHandState = externalState
    ? externalState.active
    : phase !== 'idle' && (live !== null || settled !== null);
  const isVisible = externalState
    ? externalState.active
    : seatedTable?.tableId === 'T1' && hasHandState;
  const settleCueReady = phase === 'settled' && settled?.handId === revealHandId;
  const revealShowdown = settleCueReady && settled?.outcome.endedAt === 'showdown';
  const cardStateSignature = externalState
    ? `cash:${externalState.active ? 'live' : 'idle'};b=${externalState.board.map(cardSignature).join(',')};s=${externalState.seats.map((seat) => `${seat.seatIndex}:${seat.status}:${seat.holeCardCount}`).join('|')}`
    : handSignature(phase, playerHoleCards, communityCards, seats);
  const suppressedSeatSignature = suppressSeatIndices.join(',');

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    const muckMesh = muckMeshRef.current;
    if (!mesh || !muckMesh) return;

    // A card-state rebuild interrupts the currently rendered fade. Detach its
    // token now; once the new geometry is resolved below, either a new fade
    // supersedes it or the token-guarded completion closes it.
    const interruptedSpanToken = muckSpanTokenRef.current;
    muckSpanTokenRef.current = null;

    if (!isVisible) {
      geometry.setDrawRange(0, 0);
      muckGeometry.setDrawRange(0, 0);
      mesh.visible = false;
      muckMesh.visible = false;
      muckFadeRef.current.active = false;
      if (interruptedSpanToken !== null) {
        muckCompleteCallbackRef.current?.(interruptedSpanToken);
      }
      resolvedCallbackRef.current?.({
        board: [null, null, null, null, null],
        opponents: [],
        onFelt: true,
      });
      return;
    }

    if (!material.map) {
      material.map = getCardAtlas();
      material.needsUpdate = true;
    }
    if (!muckMaterial.map) {
      muckMaterial.map = getCardAtlas();
      muckMaterial.needsUpdate = true;
    }

    const controller = useHoldemController.getState();
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const muckPositions: number[] = [];
    const muckUvs: number[] = [];
    const muckIndices: number[] = [];
    const resolvedOpponents: ResolvedTableCardOpponent[] = [];
    const cardY = feltTopY + layout.surfaceLift;

    for (const tableSeat of tableSeats) {
      if (suppressSeatIndices.includes(tableSeat.engineSeatIndex)) continue;
      const externalSeat = externalState?.seats.find(
        (seat) => seat.seatIndex === tableSeat.engineSeatIndex,
      );
      const seatState = externalState
        ? null
        : controller.seats.find((seat) => seat.seatIndex === tableSeat.engineSeatIndex);
      const holeCardCount = externalState
        ? externalSeat?.holeCardCount ?? 0
        : seatState?.holeCards?.length ?? 0;
      const foldedAtSettle = !externalState
        && controller.phase === 'settled'
        && seatState?.status === 'folded';
      const faceDown = externalState ? true : !revealShowdown;
      const resolvedFaceDown = faceDown || foldedAtSettle;
      const resolvedCards = !resolvedFaceDown
        && seatState?.holeCards?.length === 2
        ? [seatState.holeCards[0], seatState.holeCards[1]] as [HoldemCard, HoldemCard]
        : null;
      resolvedOpponents.push({
        seatIndex: tableSeat.engineSeatIndex,
        status: externalState
          ? cashSlotStatus(externalSeat?.status)
          : practiceSlotStatus(seatState?.status),
        holeCardCount,
        cards: resolvedCards,
        faceDown: resolvedFaceDown || resolvedCards === null,
      });
      if (holeCardCount === 0) continue;

      const targetPositions = settleCueReady && foldedAtSettle ? muckPositions : positions;
      const targetUvs = settleCueReady && foldedAtSettle ? muckUvs : uvs;
      const targetIndices = settleCueReady && foldedAtSettle ? muckIndices : indices;
      const cardWidth = layout.botCardWidth;
      const cardHeight = layout.botCardHeight;
      const anchorScale = layout.botAnchorScale;
      const pairCenterSpacing = cardWidth + layout.botPairGap;
      const anchorX = centerX + tableSeat.x * anchorScale;
      const anchorZ = centerZ + tableSeat.z * anchorScale;
      const cosine = Math.cos(tableSeat.faceYaw);
      const sine = Math.sin(tableSeat.faceYaw);

      for (let cardIndex = 0; cardIndex < holeCardCount && cardIndex < 2; cardIndex += 1) {
        const card = seatState?.holeCards?.[cardIndex];
        const across = (cardIndex - 0.5) * pairCenterSpacing;
        appendCardQuad(
          targetPositions,
          targetUvs,
          targetIndices,
          anchorX + across * cosine,
          cardY,
          anchorZ - across * sine,
          tableSeat.faceYaw,
          cardWidth,
          cardHeight,
          faceDown || foldedAtSettle || !card ? ATLAS_BACK_CELL : atlasCellForCard(card),
          0,
        );
      }
    }

    // Placement is supplied by the dedicated room, whose camera/table axes
    // are code-owned. Player hole cards intentionally have no 3D path.
    const boardRightX = Math.cos(layout.boardYaw);
    const boardRightZ = -Math.sin(layout.boardYaw);
    const renderedBoard = externalState?.board ?? controller.communityCards;
    for (let slotIndex = 0; slotIndex < renderedBoard.length && slotIndex < 5; slotIndex += 1) {
      const card = renderedBoard[slotIndex];
      if (!card) continue;
      const alongRow = (slotIndex - 2) * layout.boardSpacing;
      appendCardQuad(
        positions,
        uvs,
        indices,
        centerX + layout.boardX + alongRow * boardRightX,
        cardY,
        centerZ + layout.boardZ + alongRow * boardRightZ,
        layout.boardYaw,
        layout.boardCardWidth,
        layout.boardCardHeight,
        atlasCellForCard(card),
        0,
      );
    }

    if (process.env.NODE_ENV !== 'production') {
      // The layout owns this conservative XZ envelope. surfaceLift is only a
      // Y offset, and card-spacing tuning must not silently resize the gate.
      for (let i = 0; i < positions.length; i += 3) {
        const dx = positions[i]! - centerX;
        const dz = positions[i + 2]! - centerZ;
        if (Math.abs(dx) > layout.feltHalfX || Math.abs(dz) > layout.feltHalfZ) {
          console.warn(
            `[TableCards3D] card vertex off felt: dx=${dx.toFixed(1)} dz=${dz.toFixed(1)} (bounds ±${layout.feltHalfX.toFixed(0)}/±${layout.feltHalfZ.toFixed(0)})`,
          );
          break;
        }
      }
    }

    let onFelt = true;
    for (const vertexPositions of [positions, muckPositions]) {
      for (let index = 0; index < vertexPositions.length; index += 3) {
        const dx = vertexPositions[index]! - centerX;
        const dz = vertexPositions[index + 2]! - centerZ;
        if (Math.abs(dx) > layout.feltHalfX || Math.abs(dz) > layout.feltHalfZ) {
          onFelt = false;
          break;
        }
      }
      if (!onFelt) break;
    }

    const positionAttribute = new THREE.Float32BufferAttribute(positions, 3);
    const uvAttribute = new THREE.Float32BufferAttribute(uvs, 2);
    positionAttribute.needsUpdate = true;
    uvAttribute.needsUpdate = true;
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('uv', uvAttribute);
    geometry.setIndex(indices);
    geometry.setDrawRange(0, indices.length);
    geometry.computeBoundingSphere();
    mesh.visible = indices.length > 0;

    const muckPositionAttribute = new THREE.Float32BufferAttribute(muckPositions, 3);
    const muckUvAttribute = new THREE.Float32BufferAttribute(muckUvs, 2);
    muckPositionAttribute.needsUpdate = true;
    muckUvAttribute.needsUpdate = true;
    muckGeometry.setAttribute('position', muckPositionAttribute);
    muckGeometry.setAttribute('uv', muckUvAttribute);
    muckGeometry.setIndex(muckIndices);
    muckGeometry.setDrawRange(0, muckIndices.length);
    muckGeometry.computeBoundingSphere();
    muckMaterial.opacity = 1;
    muckMesh.visible = muckIndices.length > 0;
    muckFadeRef.current.elapsed = 0;
    muckFadeRef.current.active = muckIndices.length > 0;
    const resolved: ResolvedTableCardSlots = {
      board: Array.from({ length: 5 }, (_, index) => renderedBoard[index] ?? null),
      opponents: resolvedOpponents,
      onFelt,
    };
    if (muckIndices.length > 0) {
      muckSpanTokenRef.current = muckStartCallbackRef.current?.(resolved) ?? null;
      if (muckSpanTokenRef.current === null && interruptedSpanToken !== null) {
        muckCompleteCallbackRef.current?.(interruptedSpanToken);
      }
    } else if (interruptedSpanToken !== null) {
      muckCompleteCallbackRef.current?.(interruptedSpanToken);
    }
    resolvedCallbackRef.current?.(resolved);
  }, [
    cardStateSignature,
    centerX,
    centerZ,
    feltTopY,
    geometry,
    externalState,
    isVisible,
    layout,
    material,
    muckGeometry,
    muckMaterial,
    revealShowdown,
    settleCueReady,
    suppressedSeatSignature,
    tableSeats,
  ]);

  useFrame((_, delta) => {
    const fade = muckFadeRef.current;
    const mesh = muckMeshRef.current;
    if (!fade.active || !mesh) return;
    fade.elapsed += Math.min(delta, 0.05);
    const progress = Math.min(1, fade.elapsed / 0.65);
    muckMaterial.opacity = 1 - progress * progress;
    if (progress >= 1) {
      fade.active = false;
      mesh.visible = false;
      const spanToken = muckSpanTokenRef.current;
      muckSpanTokenRef.current = null;
      if (spanToken !== null) muckCompleteCallbackRef.current?.(spanToken);
    }
  });

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
    muckGeometry.dispose();
    muckMaterial.dispose();
  }, [geometry, material, muckGeometry, muckMaterial]);

  return (
    <>
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={material}
        matrixAutoUpdate={false}
        visible={false}
        dispose={null}
      />
      <mesh
        ref={muckMeshRef}
        geometry={muckGeometry}
        material={muckMaterial}
        matrixAutoUpdate={false}
        visible={false}
        renderOrder={1}
        dispose={null}
      />
    </>
  );
}
