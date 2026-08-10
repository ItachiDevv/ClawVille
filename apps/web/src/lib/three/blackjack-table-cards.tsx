'use client';

import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import type {
  BlackjackCard,
  BlackjackRank,
  BlackjackSuit,
} from '@clawville/shared';
import type { SubHandView } from '@/lib/cove/use-blackjack-room-controller';

type HoldemCard = BlackjackCard;
type HoldemRank = BlackjackRank;
type HoldemSuit = BlackjackSuit;

const ATLAS_CELL_WIDTH = 192;
const ATLAS_CELL_HEIGHT = 256;
const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 7;
const ATLAS_WIDTH = ATLAS_CELL_WIDTH * ATLAS_COLUMNS;
const ATLAS_HEIGHT = ATLAS_CELL_HEIGHT * ATLAS_ROWS;
const ATLAS_BACK_CELL = 52;
const ATLAS_UV_INSET = 2;
const MAX_CARD_QUADS = 64;

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
  onCardOverflow?: () => void,
): void {
  if (indices.length / 6 >= MAX_CARD_QUADS) {
    onCardOverflow?.();
    console.error('[bj-cards] card quad overflow');
    return;
  }

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

export { atlasCellForCard, ATLAS_BACK_CELL, MAX_CARD_QUADS };

export interface BlackjackCardLayout {
  dealerRowZ: number;
  playerRowZ: number;
  dealerYaw: number;
  playerYaw: number;
  cardWidth: number;
  cardHeight: number;
  cardSpacing: number;
  splitHandGap: number;
  surfaceLift: number;
  hingeTiltRad: number;
}

export interface BlackjackTableCards3DProps {
  centerX: number;
  centerZ: number;
  feltTopY: number;
  layout: Readonly<BlackjackCardLayout>;
  dealerCards: BlackjackCard[];
  playerHands: SubHandView[];
  didSplit: boolean;
  activeSlot: 0 | 1;
  onCardOverflow?: () => void;
}

interface CardRenderResources {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
  highlightGeometry: THREE.PlaneGeometry;
  highlightMaterial: THREE.MeshBasicMaterial;
  highlightMesh: THREE.Mesh;
}

function handCenterX(
  centerX: number,
  didSplit: boolean,
  slot: number,
  splitHandGap: number,
): number {
  if (!didSplit) return centerX;
  return centerX + (slot === 0 ? -splitHandGap / 2 : splitHandGap / 2);
}

export function BlackjackTableCards3D({
  centerX,
  centerZ,
  feltTopY,
  layout,
  dealerCards,
  playerHands,
  didSplit,
  activeSlot,
  onCardOverflow,
}: BlackjackTableCards3DProps) {
  const groupRef = useRef<THREE.Group>(null);
  const resourcesRef = useRef<CardRenderResources | null>(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const geometry = new THREE.BufferGeometry();
    const material = new THREE.MeshBasicMaterial({
      map: getCardAtlas(),
      toneMapped: false,
      side: THREE.FrontSide,
      transparent: false,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'blackjack-card-quads';
    mesh.visible = false;

    const highlightGeometry = new THREE.PlaneGeometry(1, 1);
    const highlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const highlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
    highlightMesh.name = 'blackjack-active-subhand';
    highlightMesh.rotation.x = -Math.PI / 2;
    highlightMesh.visible = false;

    group.add(mesh, highlightMesh);
    resourcesRef.current = {
      geometry,
      material,
      mesh,
      highlightGeometry,
      highlightMaterial,
      highlightMesh,
    };

    return () => {
      resourcesRef.current = null;
      group.remove(mesh, highlightMesh);
      geometry.dispose();
      material.dispose();
      highlightGeometry.dispose();
      highlightMaterial.dispose();
      material.map?.dispose();
      if (cardAtlasCache === material.map) cardAtlasCache = null;
    };
  }, []);

  useLayoutEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const cardY = feltTopY + layout.surfaceLift;

    const appendRow = (
      cards: readonly BlackjackCard[],
      rowCenterX: number,
      rowCenterZ: number,
      yaw: number,
    ): void => {
      const cosine = Math.cos(yaw);
      const sine = Math.sin(yaw);
      for (let index = 0; index < cards.length; index += 1) {
        const alongRow = (index - (cards.length - 1) / 2) * layout.cardSpacing;
        appendCardQuad(
          positions,
          uvs,
          indices,
          rowCenterX + alongRow * cosine,
          cardY,
          rowCenterZ - alongRow * sine,
          yaw,
          layout.cardWidth,
          layout.cardHeight,
          atlasCellForCard(cards[index]!),
          layout.hingeTiltRad,
          onCardOverflow,
        );
      }
    };

    appendRow(
      dealerCards,
      centerX,
      centerZ + layout.dealerRowZ,
      layout.dealerYaw,
    );
    for (let slot = 0; slot < playerHands.length; slot += 1) {
      appendRow(
        playerHands[slot]!.cards,
        handCenterX(centerX, didSplit, slot, layout.splitHandGap),
        centerZ + layout.playerRowZ,
        layout.playerYaw,
      );
    }

    const positionAttribute = new THREE.Float32BufferAttribute(positions, 3);
    const uvAttribute = new THREE.Float32BufferAttribute(uvs, 2);
    positionAttribute.needsUpdate = true;
    uvAttribute.needsUpdate = true;
    resources.geometry.setAttribute('position', positionAttribute);
    resources.geometry.setAttribute('uv', uvAttribute);
    resources.geometry.setIndex(indices);
    resources.geometry.setDrawRange(0, indices.length);
    if (indices.length > 0) resources.geometry.computeBoundingSphere();
    resources.mesh.visible = indices.length > 0;

    const activeHand = playerHands[activeSlot];
    const showHighlight = didSplit && activeHand !== undefined;
    resources.highlightMesh.visible = showHighlight;
    if (showHighlight && activeHand) {
      const width = layout.cardWidth
        + Math.max(0, activeHand.cards.length - 1) * layout.cardSpacing
        + 8;
      resources.highlightMesh.position.set(
        handCenterX(centerX, true, activeSlot, layout.splitHandGap),
        feltTopY + layout.surfaceLift / 2,
        centerZ + layout.playerRowZ,
      );
      resources.highlightMesh.scale.set(width, layout.cardHeight + 8, 1);
    }
  }, [
    activeSlot,
    centerX,
    centerZ,
    dealerCards,
    didSplit,
    feltTopY,
    layout,
    onCardOverflow,
    playerHands,
  ]);

  return <group ref={groupRef} />;
}
