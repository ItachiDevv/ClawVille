'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useHoldemController, type HoldemPhase } from '@/lib/cove/holdem-controller';
import type {
  HoldemCard,
  HoldemRank,
  HoldemSuit,
  SeatState,
} from '@/lib/cove/holdem-types';
import { useCoveStore } from '@/stores/cove';

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
  x: number;
  z: number;
  faceYaw: number;
}

export interface TableCardLayout {
  /** Player's own hole cards — full-size, hinged toward the seated eye. */
  holeCardWidth: number;
  holeCardHeight: number;
  holePairGap: number;
  holeAnchorScale: number;
  holeHingeTiltRad: number;
  /** Community cards — perpendicular row, smaller so 5 fit the short felt axis. */
  boardCardWidth: number;
  boardCardHeight: number;
  boardSpacing: number;
  /** Push the row past table centre AWAY from the seat so the hinged hole
   * cards don't occlude it from the seated POV. */
  boardBackOffset: number;
  /** Opponent backs — presence markers, smallest of the three roles. */
  botCardWidth: number;
  botCardHeight: number;
  botPairGap: number;
  botAnchorScale: number;
  surfaceLift: number;
}

export interface TableCards3DProps {
  centerX: number;
  centerZ: number;
  feltTopY: number;
  seats: readonly TableCardSeat[];
  playerSeatIndex: number;
  layout: Readonly<TableCardLayout>;
}

export function TableCards3D({
  centerX,
  centerZ,
  feltTopY,
  seats: tableSeats,
  playerSeatIndex,
  layout,
}: TableCards3DProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({
    map: null,
    toneMapped: false,
    side: THREE.FrontSide,
    transparent: false,
    depthWrite: true,
  }), []);

  const phase = useHoldemController((state) => state.phase);
  const playerHoleCards = useHoldemController((state) => state.playerHoleCards);
  const communityCards = useHoldemController((state) => state.communityCards);
  const seats = useHoldemController((state) => state.seats);
  const live = useHoldemController((state) => state.live);
  const settled = useHoldemController((state) => state.settled);
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const hasHandState = phase !== 'idle' && (live !== null || settled !== null);
  const isVisible = seatedTable?.tableId === 'T1' && hasHandState;
  const cardStateSignature = handSignature(phase, playerHoleCards, communityCards, seats);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    if (!isVisible) {
      geometry.setDrawRange(0, 0);
      mesh.visible = false;
      return;
    }

    if (!material.map) {
      material.map = getCardAtlas();
      material.needsUpdate = true;
    }

    const controller = useHoldemController.getState();
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const cardY = feltTopY + layout.surfaceLift;

    for (let engineSeatIndex = 0; engineSeatIndex < tableSeats.length; engineSeatIndex += 1) {
      const tableSeat = tableSeats[engineSeatIndex];
      if (!tableSeat) continue;
      const seatState = controller.seats.find((seat) => seat.seatIndex === engineSeatIndex);
      const isPlayer = engineSeatIndex === playerSeatIndex;
      const holeCards = isPlayer ? controller.playerHoleCards : seatState?.holeCards ?? [];
      if (holeCards.length === 0) continue;

      const faceDown = !isPlayer && (
        controller.phase !== 'settled' || seatState?.status === 'folded'
      );
      const cardWidth = isPlayer ? layout.holeCardWidth : layout.botCardWidth;
      const cardHeight = isPlayer ? layout.holeCardHeight : layout.botCardHeight;
      const anchorScale = isPlayer ? layout.holeAnchorScale : layout.botAnchorScale;
      const pairCenterSpacing = cardWidth + (isPlayer ? layout.holePairGap : layout.botPairGap);
      const anchorX = centerX + tableSeat.x * anchorScale;
      const anchorZ = centerZ + tableSeat.z * anchorScale;
      const cosine = Math.cos(tableSeat.faceYaw);
      const sine = Math.sin(tableSeat.faceYaw);

      for (let cardIndex = 0; cardIndex < holeCards.length && cardIndex < 2; cardIndex += 1) {
        const card = holeCards[cardIndex]!;
        const across = (cardIndex - 0.5) * pairCenterSpacing;
        appendCardQuad(
          positions,
          uvs,
          indices,
          anchorX + across * cosine,
          cardY,
          anchorZ - across * sine,
          tableSeat.faceYaw,
          cardWidth,
          cardHeight,
          faceDown ? ATLAS_BACK_CELL : atlasCellForCard(card),
          isPlayer ? layout.holeHingeTiltRad : 0,
        );
      }
    }

    // Board row runs PERPENDICULAR to the player's sight line (along the
    // seated viewer's screen-horizontal), reading left-to-right from seat 0.
    // The old along-the-sight-axis row collided with the player's hole pair
    // and ran off the felt's long axis from the seated POV.
    const playerSeat = tableSeats[playerSeatIndex];
    const boardYaw = playerSeat?.faceYaw ?? 0;
    const boardRightX = -Math.cos(boardYaw);
    const boardRightZ = Math.sin(boardYaw);
    const boardAwayX = Math.sin(boardYaw) * layout.boardBackOffset;
    const boardAwayZ = Math.cos(boardYaw) * layout.boardBackOffset;
    for (let slotIndex = 0; slotIndex < controller.communityCards.length && slotIndex < 5; slotIndex += 1) {
      const card = controller.communityCards[slotIndex];
      if (!card) continue;
      const alongRow = (slotIndex - 2) * layout.boardSpacing;
      appendCardQuad(
        positions,
        uvs,
        indices,
        centerX + alongRow * boardRightX + boardAwayX,
        cardY,
        centerZ + alongRow * boardRightZ + boardAwayZ,
        boardYaw,
        layout.boardCardWidth,
        layout.boardCardHeight,
        atlasCellForCard(card),
        0,
      );
    }

    if (process.env.NODE_ENV !== 'production') {
      // Conservative on-felt bound: every vertex within ±140 x / ±80 z of the
      // table centre (green felt measured 182wu on the short axis).
      const feltHalfX = layout.boardSpacing * (140 / 34);
      const feltHalfZ = layout.boardSpacing * (80 / 34);
      for (let i = 0; i < positions.length; i += 3) {
        const dx = positions[i]! - centerX;
        const dz = positions[i + 2]! - centerZ;
        if (Math.abs(dx) > feltHalfX || Math.abs(dz) > feltHalfZ) {
          console.warn(
            `[TableCards3D] card vertex off felt: dx=${dx.toFixed(1)} dz=${dz.toFixed(1)} (bounds ±${feltHalfX.toFixed(0)}/±${feltHalfZ.toFixed(0)})`,
          );
          break;
        }
      }
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
  }, [
    cardStateSignature,
    centerX,
    centerZ,
    feltTopY,
    geometry,
    isVisible,
    layout,
    material,
    playerSeatIndex,
    tableSeats,
  ]);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      matrixAutoUpdate={false}
      visible={false}
      dispose={null}
    />
  );
}
