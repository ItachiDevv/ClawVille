'use client';

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Sprite, Assets } from 'pixi.js';
import { useViewport } from '@/lib/pixi/use-viewport';
import { useCamera } from '@/lib/pixi/use-camera';
import { useGameLoop } from '@/lib/pixi/use-game-loop';
import { useGameStore } from '@/stores/game';
import { MAP_LOCATIONS } from '@elizapets/shared';
import { SPECIES_SPRITE_MAP, COLOR_TINT_MAP, blendColors } from '@/lib/pixi/pet-sprites';
import { drawBuilding } from '@/lib/pixi/building-renderer';
import type { PetColor, PetSpecies } from '@elizapets/shared';
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
  buildingZones,
} from '@/lib/pixi/tilemap-data';

// Convert building zones from tile coords to pixel coords for game loop
const pixelZones = buildingZones.map((z) => ({
  id: z.id,
  x: z.x * TILE_SIZE,
  y: z.y * TILE_SIZE,
  width: z.width * TILE_SIZE,
  height: z.height * TILE_SIZE,
}));

// ---- Illustrated ground tile drawing ----

// Seeded pseudo-random for consistent tile variation
function seededRandom(x: number, y: number, seed: number = 42): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 113.5) * 43758.5453;
  return n - Math.floor(n);
}

function drawGroundTile(g: Graphics, col: number, row: number, tile: number) {
  const x = col * TILE_SIZE;
  const y = row * TILE_SIZE;
  const rand = seededRandom(col, row);

  if (tile === TILES.GRASS_1 || tile === TILES.GRASS_2 || tile === TILES.GRASS_3) {
    // Base grass color with variation
    const grassColors = [0x4caf50, 0x43a047, 0x388e3c];
    const baseColor = grassColors[tile] ?? 0x4caf50;
    const variedColor = blendColors(baseColor, tile === TILES.GRASS_2 ? 0x66bb6a : 0x2e7d32, rand * 0.15);

    g.rect(x, y, TILE_SIZE, TILE_SIZE);
    g.fill(variedColor);

    // Grass blade strokes (2-3 per tile)
    const bladeCount = 2 + Math.floor(rand * 2);
    for (let i = 0; i < bladeCount; i++) {
      const bx = x + 4 + seededRandom(col, row, i * 7) * (TILE_SIZE - 8);
      const by = y + TILE_SIZE - 4;
      const bh = 4 + seededRandom(col, row, i * 13) * 6;
      const lean = (seededRandom(col, row, i * 19) - 0.5) * 4;
      g.moveTo(bx, by);
      g.lineTo(bx + lean, by - bh);
      g.stroke({ color: 0x2e7d32, width: 0.8 });
    }

    // Occasional tiny flower dot
    if (rand > 0.85) {
      const dotColors = [0xffeb3b, 0xffffff, 0xf48fb1];
      g.circle(x + 8 + rand * 16, y + 8 + seededRandom(col, row, 99) * 16, 1.2);
      g.fill(dotColors[Math.floor(rand * 3)]);
    }
  }
}

function drawPathTile(g: Graphics, col: number, row: number, tile: number) {
  const x = col * TILE_SIZE;
  const y = row * TILE_SIZE;
  const rand = seededRandom(col, row);

  if (tile === TILES.DIRT_PATH) {
    // Warm brown base
    const baseColor = blendColors(0xbcaaa4, 0xa1887f, rand * 0.2);
    g.rect(x, y, TILE_SIZE, TILE_SIZE);
    g.fill(baseColor);
    // Small pebble dots
    for (let i = 0; i < 3; i++) {
      const px = x + 4 + seededRandom(col, row, i * 11) * (TILE_SIZE - 8);
      const py = y + 4 + seededRandom(col, row, i * 17) * (TILE_SIZE - 8);
      g.circle(px, py, 1 + seededRandom(col, row, i * 23) * 1.5);
      g.fill(blendColors(0x8d6e63, 0xbcaaa4, seededRandom(col, row, i * 29)));
    }
  } else if (tile === TILES.STONE_PATH) {
    // Grey stone base
    g.rect(x, y, TILE_SIZE, TILE_SIZE);
    g.fill(0x9e9e9e);
    // Individual stone shapes
    const stonePositions = [
      [2, 2, 13, 13],
      [17, 2, 13, 13],
      [2, 17, 13, 13],
      [17, 17, 13, 13],
    ];
    for (const [sx, sy, sw, sh] of stonePositions) {
      const stoneColor = blendColors(0xbdbdbd, 0x9e9e9e, seededRandom(col + sx, row + sy) * 0.3);
      g.roundRect(x + sx, y + sy, sw, sh, 2);
      g.fill(stoneColor);
      g.stroke({ color: 0x757575, width: 0.6 });
    }
  }
}

function drawWaterTile(g: Graphics, col: number, row: number) {
  const x = col * TILE_SIZE;
  const y = row * TILE_SIZE;
  const rand = seededRandom(col, row);

  // Blue gradient base
  const baseColor = blendColors(0x1e88e5, 0x42a5f5, rand * 0.4);
  g.rect(x, y, TILE_SIZE, TILE_SIZE);
  g.fill(baseColor);

  // Lighter center highlight
  g.ellipse(x + TILE_SIZE / 2, y + TILE_SIZE / 2, TILE_SIZE / 3, TILE_SIZE / 4);
  g.fill({ color: 0x64b5f6, alpha: 0.35 });

  // Ripple marks
  g.arc(x + 10 + rand * 12, y + 10 + rand * 12, 4, 0, Math.PI);
  g.stroke({ color: 0xbbdefb, width: 0.6 });
}

// ---- Illustrated decoration drawing ----

function drawTreeDecoration(g: Graphics, col: number, row: number, tile: number) {
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const by = (row + 1) * TILE_SIZE; // bottom of tile
  const rand = seededRandom(col, row);
  const isType2 = tile === TILES.TREE_2;

  // Shadow at base
  g.ellipse(cx, by - 2, 8, 3);
  g.fill({ color: 0x000000, alpha: 0.15 });

  // Trunk
  const trunkH = isType2 ? 16 : 13;
  g.roundRect(cx - 3, by - trunkH, 6, trunkH, 2);
  g.fill(0x795548);
  g.stroke({ color: 0x5d4037, width: 1 });

  // Leafy canopy — overlapping circles in varying greens
  const greens = isType2 ? [0x1b5e20, 0x2e7d32, 0x33691e] : [0x388e3c, 0x43a047, 0x4caf50];
  const canopyY = by - trunkH - 4;
  const r1 = 8 + rand * 3;
  g.circle(cx, canopyY, r1);
  g.fill(greens[0]);
  g.circle(cx - 5, canopyY + 3, r1 - 2);
  g.fill(greens[1]);
  g.circle(cx + 5, canopyY + 3, r1 - 2);
  g.fill(greens[2]);
  g.circle(cx, canopyY - 4, r1 - 3);
  g.fill(greens[1]);
}

function drawFlowerDecoration(g: Graphics, col: number, row: number, tile: number) {
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const by = (row + 1) * TILE_SIZE - 4;
  const isType2 = tile === TILES.FLOWER_2;
  const rand = seededRandom(col, row);

  // Stem
  g.moveTo(cx, by);
  g.lineTo(cx + (rand - 0.5) * 2, by - 10);
  g.stroke({ color: 0x4caf50, width: 1.5 });

  // Leaf
  g.ellipse(cx + 3, by - 5, 3, 1.5);
  g.fill(0x66bb6a);

  // Petals
  const petalColor = isType2 ? 0xffca28 : 0xff7043;
  const centerColor = isType2 ? 0xff9800 : 0xffeb3b;
  const petalCount = 5;
  for (let i = 0; i < petalCount; i++) {
    const angle = (i / petalCount) * Math.PI * 2;
    g.circle(cx + Math.cos(angle) * 3.5, by - 12 + Math.sin(angle) * 3.5, 2.5);
    g.fill(petalColor);
  }
  // Center
  g.circle(cx, by - 12, 2);
  g.fill(centerColor);
}

function drawBushDecoration(g: Graphics, col: number, row: number) {
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const cy = row * TILE_SIZE + TILE_SIZE / 2 + 4;
  const rand = seededRandom(col, row);

  // 2-3 overlapping green circles
  g.circle(cx - 4, cy, 7);
  g.fill(0x388e3c);
  g.circle(cx + 4, cy, 7);
  g.fill(0x43a047);
  g.circle(cx, cy - 3, 6);
  g.fill(0x4caf50);

  // Darker outline
  g.circle(cx - 4, cy, 7);
  g.stroke({ color: 0x2e7d32, width: 0.8 });
  g.circle(cx + 4, cy, 7);
  g.stroke({ color: 0x2e7d32, width: 0.8 });

  // Occasional small flower dot
  if (rand > 0.5) {
    g.circle(cx + 2, cy - 4, 1.5);
    g.fill(rand > 0.75 ? 0xf48fb1 : 0xffeb3b);
  }
}

function drawFenceDecoration(g: Graphics, col: number, row: number) {
  const x = col * TILE_SIZE;
  const y = row * TILE_SIZE;

  // Vertical posts
  for (let i = 0; i < 3; i++) {
    const px = x + 4 + i * 12;
    g.rect(px, y + 6, 3, 22);
    g.fill(0x8d6e63);
    g.stroke({ color: 0x5d4037, width: 0.5 });
    // Post cap
    g.circle(px + 1.5, y + 6, 2);
    g.fill(0x8d6e63);
  }
  // Horizontal rails
  g.rect(x + 2, y + 12, TILE_SIZE - 4, 2.5);
  g.fill(0xa1887f);
  g.rect(x + 2, y + 20, TILE_SIZE - 4, 2.5);
  g.fill(0xa1887f);
}

// ---- Preload all pet sprites ----
async function preloadPetTextures() {
  const entries = Object.entries(SPECIES_SPRITE_MAP) as [PetSpecies, string][];
  const promises = entries.map(([, path]) => Assets.load(path));
  await Promise.all(promises);
}

export default function PixiCanvas() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const petSpriteRef = useRef<Sprite | null>(null);
  const scaleRef = useRef<number>(1);
  const viewport = useViewport();
  const updateCamera = useCamera(MAP_WIDTH, MAP_HEIGHT, viewport.width, viewport.height);
  const gameTick = useGameLoop({ mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT, buildingZones: pixelZones });

  useEffect(() => {
    if (!canvasRef.current || appRef.current) return;

    let destroyed = false;

    (async () => {
      // Preload pet textures
      await preloadPetTextures();

      if (destroyed) return;

      const app = new Application();
      await app.init({
        width: viewport.width,
        height: viewport.height,
        backgroundColor: 0x2e7d32, // Green to match grass if visible at edges
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

      // Phase 2: Viewport scaling — scale world to fill screen
      const scale = Math.max(viewport.width / MAP_WIDTH, viewport.height / MAP_HEIGHT);
      world.scale.set(scale);
      scaleRef.current = scale;

      // ---- Draw ground layer (illustrated) ----
      const groundGraphics = new Graphics();
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          const tile = groundLayer[row * MAP_COLS + col];
          if (tile === TILES.EMPTY || tile === -1) continue;
          if (tile === TILES.WATER) {
            drawWaterTile(groundGraphics, col, row);
          } else {
            drawGroundTile(groundGraphics, col, row, tile);
          }
        }
      }
      world.addChild(groundGraphics);

      // ---- Draw path layer (illustrated) ----
      const pathGraphics = new Graphics();
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          const tile = pathLayer[row * MAP_COLS + col];
          if (tile === TILES.EMPTY || tile === -1) continue;
          drawPathTile(pathGraphics, col, row, tile);
        }
      }
      world.addChild(pathGraphics);

      // ---- Draw decoration layer (illustrated) ----
      const decoGraphics = new Graphics();
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          const tile = decorationLayer[row * MAP_COLS + col];
          if (tile === TILES.EMPTY || tile === -1) continue;
          if (tile === TILES.TREE_1 || tile === TILES.TREE_2) {
            drawTreeDecoration(decoGraphics, col, row, tile);
          } else if (tile === TILES.FLOWER_1 || tile === TILES.FLOWER_2) {
            drawFlowerDecoration(decoGraphics, col, row, tile);
          } else if (tile === TILES.BUSH) {
            drawBushDecoration(decoGraphics, col, row);
          } else if (tile === TILES.FENCE) {
            drawFenceDecoration(decoGraphics, col, row);
          }
        }
      }
      world.addChild(decoGraphics);

      // ---- Draw buildings (illustrated) ----
      const buildingsContainer = new Container();
      for (const zone of buildingZones) {
        const loc = MAP_LOCATIONS.find((l) => l.id === zone.id);
        if (!loc) continue;

        const buildingContainer = drawBuilding(zone.id, zone.width, zone.height);
        buildingContainer.x = zone.x * TILE_SIZE;
        buildingContainer.y = zone.y * TILE_SIZE;

        // Make interactive
        buildingContainer.eventMode = 'static';
        buildingContainer.cursor = 'pointer';
        buildingContainer.on('pointerdown', () => {
          const store = useGameStore.getState();
          if (!store.movementFrozen) {
            store.enterBuilding(zone.id);
          }
        });
        buildingContainer.on('pointerover', () => {
          buildingContainer.scale.set(1.08);
          buildingContainer.alpha = 0.95;
        });
        buildingContainer.on('pointerout', () => {
          buildingContainer.scale.set(1.0);
          buildingContainer.alpha = 1.0;
        });

        buildingsContainer.addChild(buildingContainer);
      }
      world.addChild(buildingsContainer);

      // ---- Pet PNG sprite ----
      const petContainer = new Container();
      world.addChild(petContainer);

      const state = useGameStore.getState();
      const species = (state.petSpecies || 'cat') as PetSpecies;
      const texturePath = SPECIES_SPRITE_MAP[species] ?? SPECIES_SPRITE_MAP.cat;
      const texture = Assets.get(texturePath);
      const petSprite = new Sprite(texture);

      // Scale to ~72px height
      const targetHeight = 72;
      const spriteScale = targetHeight / petSprite.texture.height;
      petSprite.scale.set(spriteScale);
      petSprite.anchor.set(0.5, 0.85); // feet near the bottom

      // Apply color tint
      const petColor = (state.petColor || 'blue') as PetColor;
      const tint = COLOR_TINT_MAP[petColor] ?? 0xffffff;
      if (tint !== 0xffffff) {
        petSprite.tint = blendColors(0xffffff, tint, 0.3);
      }

      petContainer.addChild(petSprite);
      petSpriteRef.current = petSprite;

      // Shadow under pet
      const petShadow = new Graphics();
      petShadow.ellipse(0, 6, 16, 5);
      petShadow.fill({ color: 0x000000, alpha: 0.2 });
      petContainer.addChildAt(petShadow, 0);

      let elapsedTime = 0;
      let lastSpecies: string = species;

      // Game loop
      app.ticker.add((ticker) => {
        gameTick(ticker.deltaTime);

        const dt = ticker.deltaTime / 60;
        elapsedTime += dt;

        const st = useGameStore.getState();
        const currentScale = scaleRef.current;

        // Update pet sprite if species changed
        if (st.petSpecies !== lastSpecies && petSpriteRef.current) {
          const newSpecies = (st.petSpecies || 'cat') as PetSpecies;
          const newPath = SPECIES_SPRITE_MAP[newSpecies] ?? SPECIES_SPRITE_MAP.cat;
          const newTex = Assets.get(newPath);
          if (newTex) {
            petSpriteRef.current.texture = newTex;
            const ns = targetHeight / newTex.height;
            petSpriteRef.current.scale.set(ns);
          }
          lastSpecies = st.petSpecies;
        }

        // Pet animation
        if (petSpriteRef.current) {
          const sprite = petSpriteRef.current;
          const dir = st.movementDirection;
          const isMoving = dir !== 'idle';

          // Direction flipping
          const baseScale = targetHeight / sprite.texture.height;
          if (dir === 'left') {
            sprite.scale.x = -baseScale;
          } else if (dir === 'right') {
            sprite.scale.x = baseScale;
          }
          // keep last direction for up/down/idle

          // Bobbing animation
          if (isMoving) {
            // Faster bob + slight tilt while walking
            sprite.y = Math.sin(elapsedTime * 12) * 3;
            sprite.rotation = Math.sin(elapsedTime * 8) * 0.05;
          } else {
            // Gentle idle bob
            sprite.y = Math.sin(elapsedTime * 3) * 2;
            sprite.rotation = 0;
          }
        }

        // Update pet container position
        petContainer.x = st.petPosition.x;
        petContainer.y = st.petPosition.y;

        // Update camera (scale-aware)
        const cam = updateCamera();
        if (worldRef.current) {
          worldRef.current.x = cam.x * currentScale;
          worldRef.current.y = cam.y * currentScale;
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
    if (appRef.current && worldRef.current) {
      appRef.current.renderer.resize(viewport.width, viewport.height);
      const scale = Math.max(viewport.width / MAP_WIDTH, viewport.height / MAP_HEIGHT);
      worldRef.current.scale.set(scale);
      scaleRef.current = scale;
    }
  }, [viewport.width, viewport.height]);

  return (
    <div
      ref={canvasRef}
      style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
    />
  );
}
