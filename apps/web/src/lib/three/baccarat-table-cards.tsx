'use client';

import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import type {
  BaccaratBet,
  BaccaratCard,
  BaccaratRank,
  BaccaratSuit,
  SerializedBaccaratCoup,
} from '@clawville/shared';
import type {
  BaccaratDealStep,
  BaccaratRoomPhase,
} from '@/lib/cove/baccarat-room-controller';
import {
  buildBaccaratRoomParityRevision,
  maskOutcomeToStep,
} from '@/lib/cove/baccarat-room-controller';
import {
  beginTransition,
  completeTransition,
  getParitySnapshot,
  publishFeltParity,
  type CardParityRoot,
} from '@/lib/cove/card-parity-mirror';

type HoldemCard = BaccaratCard & { hidden?: boolean };
type HoldemRank = BaccaratRank;
type HoldemSuit = BaccaratSuit;

const ATLAS_CELL_WIDTH = 192;
const ATLAS_CELL_HEIGHT = 256;
const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 7;
const ATLAS_WIDTH = ATLAS_CELL_WIDTH * ATLAS_COLUMNS;
const ATLAS_HEIGHT = ATLAS_CELL_HEIGHT * ATLAS_ROWS;
const ATLAS_BACK_CELL = 52;
const ATLAS_UV_INSET = 2;
const MAX_CARD_QUADS = 6;

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

export function baccaratAtlasUvSequence(cell: number): readonly number[] {
  const column = cell % ATLAS_COLUMNS;
  const row = Math.floor(cell / ATLAS_COLUMNS);
  const u0 = (column * ATLAS_CELL_WIDTH + ATLAS_UV_INSET) / ATLAS_WIDTH;
  const u1 = ((column + 1) * ATLAS_CELL_WIDTH - ATLAS_UV_INSET) / ATLAS_WIDTH;
  const vTop = 1 - (row * ATLAS_CELL_HEIGHT + ATLAS_UV_INSET) / ATLAS_HEIGHT;
  const vBottom = 1 - ((row + 1) * ATLAS_CELL_HEIGHT - ATLAS_UV_INSET) / ATLAS_HEIGHT;
  return [u1, vBottom, u1, vTop, u0, vTop, u0, vBottom];
}

export const BACCARAT_CARD_INDICES = Object.freeze([0, 1, 2, 0, 2, 3] as const);
export const BACCARAT_CARD_CORNERS = Object.freeze([
  [-1, -1],
  [-1, 1],
  [1, 1],
  [1, -1],
] as const);

export interface BaccaratHandLayout {
  playerCenter: readonly [number, number];
  bankerCenter: readonly [number, number];
  cardWidth: number;
  cardHeight: number;
  cardSpacing: number;
  surfaceLift: number;
  yaw: number;
}

export interface BaccaratRenderView {
  instanceId: string;
  coup: SerializedBaccaratCoup | null;
  revealedStep: number;
  dealSteps: readonly BaccaratDealStep[];
  phase: BaccaratRoomPhase;
  bet: BaccaratBet;
  stake: number;
  correlation: CardParityRoot['correlation'];
  bannerText?: string;
  betzoneSelected?: string;
}

export interface BaccaratTableCards3DProps {
  feltTopY: number;
  layout: Readonly<BaccaratHandLayout>;
  view: BaccaratRenderView;
}

interface CardRenderResources {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
  positions: THREE.BufferAttribute;
  uvs: THREE.BufferAttribute;
  indices: THREE.BufferAttribute;
}

function dealStepFor(view: BaccaratRenderView): string {
  if (view.phase === 'settled' || view.phase === 'leaving') return 'settled';
  if (view.revealedStep <= 0) return 'deal';
  return view.dealSteps[Math.min(view.revealedStep, view.dealSteps.length) - 1]?.token
    ?? 'deal';
}

export function BaccaratTableCards3D({
  feltTopY,
  layout,
  view,
}: BaccaratTableCards3DProps) {
  const groupRef = useRef<THREE.Group>(null);
  const resourcesRef = useRef<CardRenderResources | null>(null);
  const revealSpanRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(
      new Float32Array(MAX_CARD_QUADS * 4 * 3),
      3,
    );
    const uvs = new THREE.BufferAttribute(
      new Float32Array(MAX_CARD_QUADS * 4 * 2),
      2,
    );
    const indices = new THREE.BufferAttribute(
      new Uint16Array(MAX_CARD_QUADS * 6),
      1,
    );
    geometry.setAttribute('position', positions);
    geometry.setAttribute('uv', uvs);
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 70, 0), 260);
    const material = new THREE.MeshBasicMaterial({
      map: getCardAtlas(),
      toneMapped: false,
      side: THREE.FrontSide,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'baccarat-card-quads';
    mesh.visible = false;
    group.add(mesh);
    resourcesRef.current = { geometry, material, mesh, positions, uvs, indices };
    return () => {
      resourcesRef.current = null;
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      material.map?.dispose();
      if (cardAtlasCache === material.map) cardAtlasCache = null;
    };
  }, []);

  useLayoutEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;

    // This single masked value is the source for both the visible merged mesh
    // and the hidden render-state parity payload.
    const masked = view.coup
      ? maskOutcomeToStep(view.coup, view.revealedStep)
      : null;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const cardY = feltTopY + layout.surfaceLift;

    const appendRow = (
      cards: readonly BaccaratCard[],
      center: readonly [number, number],
      fullHandLength: number,
    ) => {
      const cosine = Math.cos(layout.yaw);
      const sine = Math.sin(layout.yaw);
      for (let index = 0; index < cards.length; index += 1) {
        const alongRow = (index - (fullHandLength - 1) / 2) * layout.cardSpacing;
        appendCardQuad(
          positions,
          uvs,
          indices,
          center[0] + alongRow * cosine,
          cardY,
          center[1] - alongRow * sine,
          layout.yaw,
          layout.cardWidth,
          layout.cardHeight,
          atlasCellForCard(cards[index]!),
          0,
        );
      }
    };
    appendRow(
      masked?.player.cards ?? [],
      layout.playerCenter,
      view.coup?.player.cards.length ?? 0,
    );
    appendRow(
      masked?.banker.cards ?? [],
      layout.bankerCenter,
      view.coup?.banker.cards.length ?? 0,
    );

    (resources.positions.array as Float32Array).fill(0);
    (resources.uvs.array as Float32Array).fill(0);
    (resources.indices.array as Uint16Array).fill(0);
    (resources.positions.array as Float32Array).set(positions);
    (resources.uvs.array as Float32Array).set(uvs);
    (resources.indices.array as Uint16Array).set(indices);
    resources.positions.needsUpdate = true;
    resources.uvs.needsUpdate = true;
    resources.indices.needsUpdate = true;
    resources.geometry.setDrawRange(0, indices.length);
    resources.mesh.visible = indices.length > 0;

    const dealStep = dealStepFor(view);
    const finalFrame = view.phase === 'settled' || view.phase === 'leaving';
    const buildPayload = (transition: 'idle' | 'revealing') => {
      return buildBaccaratRoomParityRevision({
        maskedOutcome: masked,
        bet: view.bet,
        stake: view.stake,
        correlation: view.correlation,
        dealStep,
        phase: view.phase,
        transition,
        ...(finalFrame && view.bannerText !== undefined
          ? { bannerText: view.bannerText }
          : {}),
        ...(view.betzoneSelected !== undefined
          ? { betzoneSelected: view.betzoneSelected }
          : {}),
      });
    };

    if (view.phase === 'revealing') {
      if (revealSpanRef.current === null) {
        const snapshot = getParitySnapshot('baccarat-3d');
        if (!snapshot || snapshot.instanceId !== view.instanceId) {
          publishFeltParity(view.instanceId, buildPayload('idle'));
        }
        revealSpanRef.current = beginTransition(
          view.instanceId,
          'baccarat-3d',
          'revealing',
        );
      }
      publishFeltParity(view.instanceId, buildPayload('revealing'));
      return;
    }

    if (finalFrame && revealSpanRef.current !== null) {
      publishFeltParity(view.instanceId, buildPayload('revealing'));
      const span = revealSpanRef.current;
      revealSpanRef.current = null;
      completeTransition(view.instanceId, 'baccarat-3d', span);
      return;
    }

    revealSpanRef.current = null;
    publishFeltParity(view.instanceId, buildPayload('idle'));
  }, [feltTopY, layout, view]);

  return <group ref={groupRef} />;
}
