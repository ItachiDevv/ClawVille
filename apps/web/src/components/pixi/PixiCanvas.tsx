'use client';

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text } from 'pixi.js';
import { useViewport } from '@/lib/pixi/use-viewport';
import { useCamera } from '@/lib/pixi/use-camera';
import { useGameLoop } from '@/lib/pixi/use-game-loop';
import { useGameStore, type MovementDirection } from '@/stores/game';
import { MAP_LOCATIONS } from '@legacyapp/shared';
import { getSpeciesConfig, blendColors, COLOR_TINT_MAP } from '@/lib/pixi/pet-sprites';
import type { PetColor } from '@legacyapp/shared';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  MAP_COLS,
  MAP_ROWS,
  TILES,
  groundLayer,
  pathLayer,
  decorationLayer,
  buildingLayer,
  buildingZones,
} from '@/lib/pixi/tilemap-data';

// Color palette for tile rendering
const TILE_COLORS: Record<number, number> = {
  [TILES.EMPTY]: 0x000000,
  [TILES.GRASS_1]: 0x4caf50,
  [TILES.GRASS_2]: 0x66bb6a,
  [TILES.GRASS_3]: 0x43a047,
  [TILES.DIRT_PATH]: 0xbcaaa4,
  [TILES.STONE_PATH]: 0x9e9e9e,
  [TILES.WATER]: 0x42a5f5,
  [TILES.TREE_1]: 0x2e7d32,
  [TILES.TREE_2]: 0x1b5e20,
  [TILES.FLOWER_1]: 0xff7043,
  [TILES.FLOWER_2]: 0xffca28,
  [TILES.BUSH]: 0x388e3c,
  [TILES.FENCE]: 0x8d6e63,
  [TILES.BUILDING_SHOP]: 0xffe0b2,
  [TILES.BUILDING_LARGE]: 0xffccbc,
  [TILES.BUILDING_SPECIAL]: 0xe1bee7,
  [TILES.BUILDING_SMALL]: 0xbbdefb,
  [TILES.ROOF_RED]: 0xef5350,
  [TILES.ROOF_BLUE]: 0x42a5f5,
  [TILES.ROOF_GREEN]: 0x66bb6a,
  [TILES.DOOR]: 0x6d4c41,
  [TILES.WINDOW]: 0x90caf9,
};

// Convert building zones from tile coords to pixel coords for game loop
const pixelZones = buildingZones.map((z) => ({
  id: z.id,
  x: z.x * TILE_SIZE,
  y: z.y * TILE_SIZE,
  width: z.width * TILE_SIZE,
  height: z.height * TILE_SIZE,
}));

function drawTileLayer(g: Graphics, tiles: number[], cols: number, rows: number) {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = tiles[row * cols + col];
      if (tile === TILES.EMPTY || tile === -1) continue;
      const color = TILE_COLORS[tile] ?? 0xff00ff;
      g.rect(col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      g.fill(color);
    }
  }
}

export default function PixiCanvas() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const petGraphicRef = useRef<Graphics | null>(null);
  const markersRef = useRef<Container | null>(null);
  const viewport = useViewport();
  const updateCamera = useCamera(MAP_WIDTH, MAP_HEIGHT, viewport.width, viewport.height);
  const gameTick = useGameLoop({ mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT, buildingZones: pixelZones });

  useEffect(() => {
    if (!canvasRef.current || appRef.current) return;

    let destroyed = false;

    (async () => {
      const app = new Application();
      await app.init({
        width: viewport.width,
        height: viewport.height,
        backgroundColor: 0x1a1a2e,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });

      if (destroyed || !canvasRef.current) {
        app.destroy(true);
        return;
      }

      canvasRef.current.appendChild(app.canvas as HTMLCanvasElement);
      appRef.current = app;

      // Create world container
      const world = new Container();
      app.stage.addChild(world);
      worldRef.current = world;

      // Draw ground layer
      const groundGraphics = new Graphics();
      drawTileLayer(groundGraphics, groundLayer, MAP_COLS, MAP_ROWS);
      world.addChild(groundGraphics);

      // Draw path layer
      const pathGraphics = new Graphics();
      drawTileLayer(pathGraphics, pathLayer, MAP_COLS, MAP_ROWS);
      world.addChild(pathGraphics);

      // Draw decoration layer
      const decoGraphics = new Graphics();
      drawTileLayer(decoGraphics, decorationLayer, MAP_COLS, MAP_ROWS);
      world.addChild(decoGraphics);

      // Draw building layer
      const buildingGraphics = new Graphics();
      drawTileLayer(buildingGraphics, buildingLayer, MAP_COLS, MAP_ROWS);
      world.addChild(buildingGraphics);

      // Building markers (emoji + name labels)
      const markers = new Container();
      for (const zone of buildingZones) {
        const loc = MAP_LOCATIONS.find((l) => l.id === zone.id);
        if (!loc) continue;

        const markerContainer = new Container();
        markerContainer.x = (zone.x + zone.width / 2) * TILE_SIZE;
        markerContainer.y = zone.y * TILE_SIZE - 12;

        // Background pill
        const bg = new Graphics();
        bg.roundRect(-36, -14, 72, 28, 8);
        bg.fill({ color: 0x000000, alpha: 0.6 });
        markerContainer.addChild(bg);

        // Icon text
        const icon = new Text({ text: loc.icon, style: { fontSize: 16 } });
        icon.anchor.set(0.5);
        icon.x = 0;
        icon.y = 0;
        markerContainer.addChild(icon);

        // Name label below
        const label = new Text({
          text: loc.name,
          style: { fontSize: 10, fill: 0xffffff, fontFamily: 'Arial' },
        });
        label.anchor.set(0.5, 0);
        label.x = 0;
        label.y = 16;
        markerContainer.addChild(label);

        // Make interactive
        markerContainer.eventMode = 'static';
        markerContainer.cursor = 'pointer';
        markerContainer.on('pointerdown', () => {
          const store = useGameStore.getState();
          if (!store.movementFrozen) {
            store.enterBuilding(zone.id);
          }
        });
        markerContainer.on('pointerover', () => {
          markerContainer.scale.set(1.15);
        });
        markerContainer.on('pointerout', () => {
          markerContainer.scale.set(1.0);
        });

        markers.addChild(markerContainer);
      }
      world.addChild(markers);
      markersRef.current = markers;

      // Pet container (procedural sprite)
      const petContainer = new Container();
      world.addChild(petContainer);

      // Pet body graphics (will be redrawn each frame)
      const petBody = new Graphics();
      petContainer.addChild(petBody);
      petGraphicRef.current = petBody;

      let elapsedTime = 0;
      let lastSpecies = '';
      let lastColor = '';

      // --- Procedural drawing helpers ---

      function eyeOffset(dir: MovementDirection): { lx: number; rx: number; y: number } {
        switch (dir) {
          case 'left': return { lx: -6, rx: -2, y: -4 };
          case 'right': return { lx: 2, rx: 6, y: -4 };
          case 'up': return { lx: -4, rx: 4, y: -7 };
          default: return { lx: -4, rx: 4, y: -4 };
        }
      }

      function walkBounce(t: number, dir: MovementDirection): { by: number; lp: number } {
        if (dir === 'idle') {
          return { by: Math.sin(t * 2) * 1.5, lp: 0 };
        }
        return { by: Math.abs(Math.sin(t * 8)) * -3, lp: t * 8 };
      }

      function drawPetSprite(
        g: Graphics,
        species: string,
        color: string,
        dir: MovementDirection,
        time: number,
      ) {
        g.clear();
        const config = getSpeciesConfig(species);
        const tint = COLOR_TINT_MAP[color as PetColor] ?? 0xffeb3b;
        const bc = blendColors(config.baseColor, tint, 0.35);
        const ac = blendColors(config.accentColor, tint, 0.15);
        const { by, lp } = walkBounce(time, dir);
        const eyes = eyeOffset(dir);
        const showFace = dir !== 'up';

        // Shadow
        g.ellipse(0, 16, 11, 4);
        g.fill({ color: 0x000000, alpha: 0.25 });

        // Leg offsets for walk cycle
        const lo1 = Math.sin(lp) * 3;
        const lo2 = Math.sin(lp + Math.PI) * 3;
        const tailSide = dir === 'left' ? -1 : 1;

        switch (species) {
          case 'cat': {
            // Tail
            g.moveTo(tailSide * 8, by + 4);
            g.quadraticCurveTo(tailSide * 18, by - 6 + Math.sin(lp) * 4, tailSide * 14, by - 12);
            g.stroke({ color: bc, width: 3 });
            // Body
            g.ellipse(0, by, 12, 10);
            g.fill(bc);
            g.stroke({ color: 0x000000, width: 1.5 });
            // Belly
            g.ellipse(0, by + 3, 7, 5);
            g.fill(ac);
            // Ears
            g.moveTo(-8, by - 10); g.lineTo(-12, by - 20); g.lineTo(-4, by - 10);
            g.fill(bc);
            g.moveTo(-10, by - 14); g.lineTo(-9, by - 18); g.lineTo(-6, by - 13);
            g.fill(ac);
            g.moveTo(8, by - 10); g.lineTo(12, by - 20); g.lineTo(4, by - 10);
            g.fill(bc);
            g.moveTo(10, by - 14); g.lineTo(9, by - 18); g.lineTo(6, by - 13);
            g.fill(ac);
            // Face
            if (showFace) {
              g.circle(eyes.lx, by + eyes.y, 2.5); g.fill(0x000000);
              g.circle(eyes.rx, by + eyes.y, 2.5); g.fill(0x000000);
              g.circle(eyes.lx + 0.5, by + eyes.y - 0.5, 1); g.fill(0xffffff);
              g.circle(eyes.rx + 0.5, by + eyes.y - 0.5, 1); g.fill(0xffffff);
              g.circle(0, by, 1.5); g.fill(0xf48fb1);
              g.moveTo(-2, by + 2); g.lineTo(0, by + 1); g.lineTo(2, by + 2);
              g.stroke({ color: 0x000000, width: 0.8 });
              // Whiskers
              const wo = dir === 'left' ? -2 : dir === 'right' ? 2 : 0;
              g.moveTo(-3 + wo, by + 1); g.lineTo(-14 + wo, by - 2); g.stroke({ color: 0x000000, width: 0.6 });
              g.moveTo(-3 + wo, by + 2); g.lineTo(-14 + wo, by + 3); g.stroke({ color: 0x000000, width: 0.6 });
              g.moveTo(3 + wo, by + 1); g.lineTo(14 + wo, by - 2); g.stroke({ color: 0x000000, width: 0.6 });
              g.moveTo(3 + wo, by + 2); g.lineTo(14 + wo, by + 3); g.stroke({ color: 0x000000, width: 0.6 });
            }
            // Legs
            g.roundRect(-8, by + 6, 5, 8 + lo1, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.roundRect(3, by + 6, 5, 8 + lo2, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            break;
          }

          case 'dragon': {
            // Wings
            const wf = Math.sin(lp * 0.7) * 5;
            g.moveTo(-10, by - 4);
            g.lineTo(-22, by - 14 + wf); g.lineTo(-18, by - 4 + wf * 0.5);
            g.lineTo(-14, by - 10 + wf); g.lineTo(-10, by);
            g.fill(ac); g.stroke({ color: 0x000000, width: 1 });
            g.moveTo(10, by - 4);
            g.lineTo(22, by - 14 + wf); g.lineTo(18, by - 4 + wf * 0.5);
            g.lineTo(14, by - 10 + wf); g.lineTo(10, by);
            g.fill(ac); g.stroke({ color: 0x000000, width: 1 });
            // Tail
            g.moveTo(tailSide * 8, by + 6);
            g.quadraticCurveTo(tailSide * 20, by + 2 + Math.sin(lp) * 3, tailSide * 18, by - 4);
            g.stroke({ color: bc, width: 3 });
            g.moveTo(tailSide * 17, by - 3); g.lineTo(tailSide * 21, by - 8); g.lineTo(tailSide * 15, by - 6);
            g.fill(ac);
            // Body
            g.ellipse(0, by, 12, 12);
            g.fill(bc); g.stroke({ color: 0x000000, width: 1.5 });
            g.ellipse(0, by + 4, 6, 6); g.fill(ac);
            // Horns
            g.moveTo(-5, by - 12); g.lineTo(-8, by - 22); g.lineTo(-3, by - 14); g.fill(ac);
            g.moveTo(5, by - 12); g.lineTo(8, by - 22); g.lineTo(3, by - 14); g.fill(ac);
            // Spines
            for (let i = 0; i < 3; i++) {
              const sx = -2 + i * 2; const sy = by - 10 + i * 3;
              g.moveTo(sx, sy); g.lineTo(sx, sy - 5); g.lineTo(sx + 2, sy); g.fill(ac);
            }
            // Face
            if (showFace) {
              g.ellipse(eyes.lx, by + eyes.y, 3, 2.5); g.fill(0xffeb3b); g.stroke({ color: 0x000000, width: 0.8 });
              g.ellipse(eyes.rx, by + eyes.y, 3, 2.5); g.fill(0xffeb3b); g.stroke({ color: 0x000000, width: 0.8 });
              g.ellipse(eyes.lx, by + eyes.y, 1, 2); g.fill(0x000000);
              g.ellipse(eyes.rx, by + eyes.y, 1, 2); g.fill(0x000000);
              g.circle(-2, by + 2, 1); g.fill(0x000000);
              g.circle(2, by + 2, 1); g.fill(0x000000);
            }
            // Legs
            g.roundRect(-9, by + 8, 6, 7 + lo1, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.roundRect(3, by + 8, 6, 7 + lo2, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            break;
          }

          case 'fox': {
            // Bushy tail
            g.moveTo(tailSide * 6, by + 4);
            g.quadraticCurveTo(tailSide * 18, by, tailSide * 16, by - 10 + Math.sin(lp) * 3);
            g.quadraticCurveTo(tailSide * 14, by - 14 + Math.sin(lp) * 3, tailSide * 10, by - 8);
            g.fill(bc);
            g.circle(tailSide * 15, by - 10 + Math.sin(lp) * 3, 3); g.fill(ac);
            // Body
            g.ellipse(0, by, 11, 11); g.fill(bc); g.stroke({ color: 0x000000, width: 1.5 });
            g.ellipse(0, by + 3, 7, 6); g.fill(ac);
            // Ears
            g.moveTo(-7, by - 8); g.lineTo(-11, by - 20); g.lineTo(-3, by - 8);
            g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.moveTo(-9, by - 13); g.lineTo(-8, by - 18); g.lineTo(-5, by - 12); g.fill(ac);
            g.moveTo(7, by - 8); g.lineTo(11, by - 20); g.lineTo(3, by - 8);
            g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.moveTo(9, by - 13); g.lineTo(8, by - 18); g.lineTo(5, by - 12); g.fill(ac);
            // Face
            if (showFace) {
              g.circle(eyes.lx, by + eyes.y, 2.5); g.fill(0x000000);
              g.circle(eyes.rx, by + eyes.y, 2.5); g.fill(0x000000);
              g.circle(eyes.lx + 0.5, by + eyes.y - 0.5, 1); g.fill(0xffffff);
              g.circle(eyes.rx + 0.5, by + eyes.y - 0.5, 1); g.fill(0xffffff);
              g.circle(0, by + 1, 2); g.fill(0x333333);
            }
            // Legs + white paws
            g.roundRect(-8, by + 7, 5, 8 + lo1, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.roundRect(3, by + 7, 5, 8 + lo2, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.roundRect(-8, by + 13 + lo1, 5, 2, 1); g.fill(ac);
            g.roundRect(3, by + 13 + lo2, 5, 2, 1); g.fill(ac);
            break;
          }

          case 'owl': {
            // Wings
            const wt = Math.sin(lp * 0.5) * 2;
            g.ellipse(-12, by + 2, 5, 10 + wt); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.ellipse(12, by + 2, 5, 10 + wt); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            // Body
            g.circle(0, by, 13); g.fill(bc); g.stroke({ color: 0x000000, width: 1.5 });
            g.circle(0, by + 4, 8); g.fill(ac);
            // Belly chevrons
            for (let i = 0; i < 3; i++) {
              const py = by + 1 + i * 4;
              g.moveTo(-3, py); g.lineTo(0, py + 2); g.lineTo(3, py);
              g.stroke({ color: bc, width: 0.8 });
            }
            // Ear tufts
            g.moveTo(-7, by - 13); g.lineTo(-10, by - 21); g.lineTo(-5, by - 15); g.fill(bc);
            g.moveTo(7, by - 13); g.lineTo(10, by - 21); g.lineTo(5, by - 15); g.fill(bc);
            // Face
            if (showFace) {
              g.circle(eyes.lx, by + eyes.y, 5); g.fill(ac); g.stroke({ color: 0x000000, width: 1 });
              g.circle(eyes.rx, by + eyes.y, 5); g.fill(ac); g.stroke({ color: 0x000000, width: 1 });
              g.circle(eyes.lx, by + eyes.y, 3); g.fill(0xffab00);
              g.circle(eyes.rx, by + eyes.y, 3); g.fill(0xffab00);
              g.circle(eyes.lx, by + eyes.y, 1.5); g.fill(0x000000);
              g.circle(eyes.rx, by + eyes.y, 1.5); g.fill(0x000000);
              g.circle(eyes.lx + 1, by + eyes.y - 1, 0.8); g.fill(0xffffff);
              g.circle(eyes.rx + 1, by + eyes.y - 1, 0.8); g.fill(0xffffff);
              // Beak
              g.moveTo(-2, by + 2); g.lineTo(0, by + 5); g.lineTo(2, by + 2); g.fill(0xffc107);
            }
            // Feet
            const fo1 = Math.sin(lp) * 2; const fo2 = Math.sin(lp + Math.PI) * 2;
            g.moveTo(-5, by + 13); g.lineTo(-8 + fo1, by + 18); g.stroke({ color: 0xffc107, width: 2 });
            g.moveTo(-5, by + 13); g.lineTo(-5 + fo1, by + 19); g.stroke({ color: 0xffc107, width: 2 });
            g.moveTo(-5, by + 13); g.lineTo(-2 + fo1, by + 18); g.stroke({ color: 0xffc107, width: 2 });
            g.moveTo(5, by + 13); g.lineTo(2 + fo2, by + 18); g.stroke({ color: 0xffc107, width: 2 });
            g.moveTo(5, by + 13); g.lineTo(5 + fo2, by + 19); g.stroke({ color: 0xffc107, width: 2 });
            g.moveTo(5, by + 13); g.lineTo(8 + fo2, by + 18); g.stroke({ color: 0xffc107, width: 2 });
            break;
          }

          case 'wolf': {
            // Tail
            g.moveTo(tailSide * 8, by + 2);
            g.quadraticCurveTo(tailSide * 20, by - 6 + Math.sin(lp) * 3, tailSide * 16, by - 12);
            g.stroke({ color: bc, width: 4 });
            // Body
            g.ellipse(0, by, 12, 11); g.fill(bc); g.stroke({ color: 0x000000, width: 1.5 });
            g.ellipse(0, by + 2, 7, 7); g.fill(ac);
            // Ears
            g.moveTo(-8, by - 9); g.lineTo(-12, by - 21); g.lineTo(-4, by - 10);
            g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.moveTo(-10, by - 14); g.lineTo(-9, by - 19); g.lineTo(-6, by - 12); g.fill(ac);
            g.moveTo(8, by - 9); g.lineTo(12, by - 21); g.lineTo(4, by - 10);
            g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.moveTo(10, by - 14); g.lineTo(9, by - 19); g.lineTo(6, by - 12); g.fill(ac);
            // Snout
            if (showFace) {
              g.ellipse(0, by + 2, 5, 3.5); g.fill(ac); g.stroke({ color: 0x000000, width: 0.8 });
              g.circle(0, by + 0.5, 2); g.fill(0x333333);
              g.circle(eyes.lx, by + eyes.y, 2.5); g.fill(0xffab00); g.stroke({ color: 0x000000, width: 0.8 });
              g.circle(eyes.rx, by + eyes.y, 2.5); g.fill(0xffab00); g.stroke({ color: 0x000000, width: 0.8 });
              g.circle(eyes.lx, by + eyes.y, 1.2); g.fill(0x000000);
              g.circle(eyes.rx, by + eyes.y, 1.2); g.fill(0x000000);
            }
            // Legs
            g.roundRect(-9, by + 7, 6, 9 + lo1, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.roundRect(3, by + 7, 6, 9 + lo2, 2); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            break;
          }

          case 'bunny': {
            // Cotton tail
            g.circle(tailSide * 10, by + 6, 4); g.fill(ac); g.stroke({ color: 0x000000, width: 0.8 });
            // Body
            g.ellipse(0, by, 11, 12); g.fill(bc); g.stroke({ color: 0x000000, width: 1.5 });
            g.ellipse(0, by + 4, 7, 6); g.fill(ac);
            // Long ears with bounce
            const eb = Math.sin(lp * 0.8) * 2;
            g.ellipse(-5, by - 22 + eb, 4, 12); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.ellipse(-5, by - 22 + eb, 2.5, 9); g.fill(ac);
            g.ellipse(5, by - 21 + eb * 0.7, 4, 11); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.ellipse(5, by - 21 + eb * 0.7, 2.5, 8); g.fill(ac);
            // Face
            if (showFace) {
              g.circle(eyes.lx, by + eyes.y, 3); g.fill(0x000000);
              g.circle(eyes.rx, by + eyes.y, 3); g.fill(0x000000);
              g.circle(eyes.lx + 1, by + eyes.y - 1, 1.2); g.fill(0xffffff);
              g.circle(eyes.rx + 1, by + eyes.y - 1, 1.2); g.fill(0xffffff);
              g.circle(0, by + 1, 1.5); g.fill(0xf48fb1);
              // Buck teeth
              g.rect(-1.5, by + 2, 1.5, 2.5); g.fill(0xffffff); g.stroke({ color: 0x000000, width: 0.5 });
              g.rect(0, by + 2, 1.5, 2.5); g.fill(0xffffff); g.stroke({ color: 0x000000, width: 0.5 });
              // Whiskers
              g.moveTo(-3, by + 2); g.lineTo(-12, by); g.stroke({ color: 0x000000, width: 0.5 });
              g.moveTo(-3, by + 3); g.lineTo(-12, by + 4); g.stroke({ color: 0x000000, width: 0.5 });
              g.moveTo(3, by + 2); g.lineTo(12, by); g.stroke({ color: 0x000000, width: 0.5 });
              g.moveTo(3, by + 3); g.lineTo(12, by + 4); g.stroke({ color: 0x000000, width: 0.5 });
            }
            // Big feet
            g.ellipse(-5, by + 15 + lo1, 5, 3); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            g.ellipse(5, by + 15 + lo2, 5, 3); g.fill(bc); g.stroke({ color: 0x000000, width: 1 });
            break;
          }

          case 'phoenix': {
            const fl = Math.sin(lp * 1.5) * 2;
            // Tail flames
            for (let i = 0; i < 3; i++) {
              const sx = tailSide * (8 + i * 3);
              const sy = by + 4 - i * 2;
              const fh = 8 + Math.sin(lp + i) * 4;
              g.moveTo(sx, sy);
              g.quadraticCurveTo(sx + tailSide * 6, sy - fh, sx + tailSide * 2, sy - fh - 4);
              g.stroke({ color: i === 1 ? 0xffeb3b : ac, width: 2.5 - i * 0.5 });
            }
            // Wing flames
            const wfl = Math.sin(lp * 0.6) * 6;
            g.moveTo(-10, by - 2);
            g.quadraticCurveTo(-20, by - 12 + wfl, -16, by - 18 + wfl + fl);
            g.quadraticCurveTo(-14, by - 10 + wfl, -12, by - 14 + wfl + fl);
            g.quadraticCurveTo(-10, by - 6 + wfl, -8, by); g.fill(ac);
            g.moveTo(10, by - 2);
            g.quadraticCurveTo(20, by - 12 + wfl, 16, by - 18 + wfl + fl);
            g.quadraticCurveTo(14, by - 10 + wfl, 12, by - 14 + wfl + fl);
            g.quadraticCurveTo(10, by - 6 + wfl, 8, by); g.fill(ac);
            // Body
            g.ellipse(0, by, 11, 11); g.fill(bc); g.stroke({ color: 0x000000, width: 1.5 });
            g.ellipse(0, by + 2, 6, 6); g.fill(0xffeb3b);
            // Head crest flames
            g.moveTo(-3, by - 11);
            g.quadraticCurveTo(-4, by - 19 + fl, -1, by - 16 + fl); g.fill(ac);
            g.moveTo(0, by - 11);
            g.quadraticCurveTo(0, by - 21 + fl, 2, by - 17 + fl); g.fill(bc);
            g.moveTo(3, by - 11);
            g.quadraticCurveTo(4, by - 19 + fl, 1, by - 16 + fl); g.fill(0xffeb3b);
            // Face
            if (showFace) {
              g.circle(eyes.lx, by + eyes.y, 2.5); g.fill(0xffeb3b); g.stroke({ color: 0x000000, width: 0.8 });
              g.circle(eyes.rx, by + eyes.y, 2.5); g.fill(0xffeb3b); g.stroke({ color: 0x000000, width: 0.8 });
              g.circle(eyes.lx, by + eyes.y, 1); g.fill(0x000000);
              g.circle(eyes.rx, by + eyes.y, 1); g.fill(0x000000);
              g.moveTo(-2, by + 1); g.lineTo(0, by + 4); g.lineTo(2, by + 1); g.fill(0xff6f00);
            }
            // Feet
            const pf1 = Math.sin(lp) * 2; const pf2 = Math.sin(lp + Math.PI) * 2;
            g.moveTo(-4, by + 11); g.lineTo(-6 + pf1, by + 16); g.stroke({ color: 0xff6f00, width: 2 });
            g.moveTo(-4, by + 11); g.lineTo(-3 + pf1, by + 17); g.stroke({ color: 0xff6f00, width: 2 });
            g.moveTo(4, by + 11); g.lineTo(6 + pf2, by + 16); g.stroke({ color: 0xff6f00, width: 2 });
            g.moveTo(4, by + 11); g.lineTo(3 + pf2, by + 17); g.stroke({ color: 0xff6f00, width: 2 });
            break;
          }

          case 'turtle': {
            // Tail
            g.moveTo(tailSide * 14, by + 6);
            g.lineTo(tailSide * 18, by + 8);
            g.lineTo(tailSide * 16, by + 6); g.fill(ac);
            // Legs (slow)
            const tl1 = Math.sin(lp * 0.5) * 2;
            const tl2 = Math.sin(lp * 0.5 + Math.PI) * 2;
            g.roundRect(-14, by + 4, 6, 8 + tl1, 3); g.fill(ac); g.stroke({ color: 0x000000, width: 1 });
            g.roundRect(8, by + 4, 6, 8 + tl2, 3); g.fill(ac); g.stroke({ color: 0x000000, width: 1 });
            // Shell
            g.ellipse(0, by, 14, 12); g.fill(bc); g.stroke({ color: 0x000000, width: 2 });
            g.ellipse(0, by, 12, 10); g.stroke({ color: 0x000000, width: 0.8 });
            g.circle(0, by, 5); g.stroke({ color: 0x000000, width: 0.6 });
            for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) {
              g.moveTo(Math.cos(a) * 5, by + Math.sin(a) * 5);
              g.lineTo(Math.cos(a) * 10, by + Math.sin(a) * 10);
              g.stroke({ color: 0x000000, width: 0.6 });
            }
            // Head
            const hx = dir === 'left' ? -4 : dir === 'right' ? 4 : 0;
            const hy = dir === 'up' ? -4 : 0;
            g.circle(hx, by - 12 + hy, 6); g.fill(ac); g.stroke({ color: 0x000000, width: 1.2 });
            if (showFace) {
              g.circle(hx - 3, by - 14 + hy, 2); g.fill(0x000000);
              g.circle(hx + 3, by - 14 + hy, 2); g.fill(0x000000);
              g.circle(hx - 2.5, by - 14.5 + hy, 0.8); g.fill(0xffffff);
              g.circle(hx + 3.5, by - 14.5 + hy, 0.8); g.fill(0xffffff);
              g.moveTo(hx - 2, by - 11 + hy);
              g.quadraticCurveTo(hx, by - 9 + hy, hx + 2, by - 11 + hy);
              g.stroke({ color: 0x000000, width: 0.8 });
            }
            break;
          }

          default: {
            // Fallback circle
            g.ellipse(0, by, 12, 12); g.fill(bc); g.stroke({ color: 0x000000, width: 2 });
            if (showFace) {
              g.circle(-3, by - 3, 2); g.fill(0x000000);
              g.circle(3, by - 3, 2); g.fill(0x000000);
            }
            break;
          }
        }
      }

      // Game loop
      app.ticker.add((ticker) => {
        gameTick(ticker.deltaTime);

        const dt = ticker.deltaTime / 60;
        elapsedTime += dt;

        const state = useGameStore.getState();

        // Redraw pet procedural sprite each frame for smooth animation
        if (petGraphicRef.current) {
          drawPetSprite(
            petGraphicRef.current,
            state.petSpecies,
            state.petColor,
            state.movementDirection,
            elapsedTime,
          );
          lastSpecies = state.petSpecies;
          lastColor = state.petColor;
        }

        // Update pet container position
        petContainer.x = state.petPosition.x;
        petContainer.y = state.petPosition.y;

        // Update camera
        const cam = updateCamera();
        if (worldRef.current) {
          worldRef.current.x = cam.x;
          worldRef.current.y = cam.y;
        }
      });
    })();

    return () => {
      destroyed = true;
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle resize
  useEffect(() => {
    if (appRef.current) {
      appRef.current.renderer.resize(viewport.width, viewport.height);
    }
  }, [viewport.width, viewport.height]);

  return (
    <div
      ref={canvasRef}
      style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
    />
  );
}
