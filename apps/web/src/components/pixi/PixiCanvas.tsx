'use client';

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Sprite, Assets, Text } from 'pixi.js';
import { useViewport } from '@/lib/pixi/use-viewport';
import { useCamera } from '@/lib/pixi/use-camera';
import { useGameLoop } from '@/lib/pixi/use-game-loop';
import { useGameStore } from '@/stores/game';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';
import { MAP_LOCATIONS } from '@clawville/shared';
import { SPECIES_SPRITE_MAP, COLOR_TINT_MAP, blendColors } from '@/lib/pixi/avatar-sprites';
import { drawBuilding } from '@/lib/pixi/building-renderer';
import type { AvatarColor, AvatarSpecies } from '@clawville/shared';
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
    const grassColors = [0x4caf50, 0x43a047, 0x388e3c];
    const baseColor = grassColors[tile] ?? 0x4caf50;
    const variedColor = blendColors(baseColor, tile === TILES.GRASS_2 ? 0x66bb6a : 0x2e7d32, rand * 0.15);

    g.rect(x, y, TILE_SIZE, TILE_SIZE);
    g.fill(variedColor);

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
    const baseColor = blendColors(0xbcaaa4, 0xa1887f, rand * 0.2);
    g.rect(x, y, TILE_SIZE, TILE_SIZE);
    g.fill(baseColor);
    for (let i = 0; i < 3; i++) {
      const px = x + 4 + seededRandom(col, row, i * 11) * (TILE_SIZE - 8);
      const py = y + 4 + seededRandom(col, row, i * 17) * (TILE_SIZE - 8);
      g.circle(px, py, 1 + seededRandom(col, row, i * 23) * 1.5);
      g.fill(blendColors(0x8d6e63, 0xbcaaa4, seededRandom(col, row, i * 29)));
    }
  } else if (tile === TILES.STONE_PATH) {
    g.rect(x, y, TILE_SIZE, TILE_SIZE);
    g.fill(0x9e9e9e);
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

  const baseColor = blendColors(0x1e88e5, 0x42a5f5, rand * 0.4);
  g.rect(x, y, TILE_SIZE, TILE_SIZE);
  g.fill(baseColor);

  g.ellipse(x + TILE_SIZE / 2, y + TILE_SIZE / 2, TILE_SIZE / 3, TILE_SIZE / 4);
  g.fill({ color: 0x64b5f6, alpha: 0.35 });

  g.arc(x + 10 + rand * 12, y + 10 + rand * 12, 4, 0, Math.PI);
  g.stroke({ color: 0xbbdefb, width: 0.6 });
}

// ---- Illustrated decoration drawing ----

function drawTreeDecoration(g: Graphics, col: number, row: number, tile: number) {
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const by = (row + 1) * TILE_SIZE;
  const rand = seededRandom(col, row);
  const isType2 = tile === TILES.TREE_2;

  g.ellipse(cx, by - 2, 8, 3);
  g.fill({ color: 0x000000, alpha: 0.15 });

  const trunkH = isType2 ? 16 : 13;
  g.roundRect(cx - 3, by - trunkH, 6, trunkH, 2);
  g.fill(0x795548);
  g.stroke({ color: 0x5d4037, width: 1 });

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

  g.moveTo(cx, by);
  g.lineTo(cx + (rand - 0.5) * 2, by - 10);
  g.stroke({ color: 0x4caf50, width: 1.5 });

  g.ellipse(cx + 3, by - 5, 3, 1.5);
  g.fill(0x66bb6a);

  const petalColor = isType2 ? 0xffca28 : 0xff7043;
  const centerColor = isType2 ? 0xff9800 : 0xffeb3b;
  const petalCount = 5;
  for (let i = 0; i < petalCount; i++) {
    const angle = (i / petalCount) * Math.PI * 2;
    g.circle(cx + Math.cos(angle) * 3.5, by - 12 + Math.sin(angle) * 3.5, 2.5);
    g.fill(petalColor);
  }
  g.circle(cx, by - 12, 2);
  g.fill(centerColor);
}

function drawBushDecoration(g: Graphics, col: number, row: number) {
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const cy = row * TILE_SIZE + TILE_SIZE / 2 + 4;
  const rand = seededRandom(col, row);

  g.circle(cx - 4, cy, 7);
  g.fill(0x388e3c);
  g.circle(cx + 4, cy, 7);
  g.fill(0x43a047);
  g.circle(cx, cy - 3, 6);
  g.fill(0x4caf50);

  g.circle(cx - 4, cy, 7);
  g.stroke({ color: 0x2e7d32, width: 0.8 });
  g.circle(cx + 4, cy, 7);
  g.stroke({ color: 0x2e7d32, width: 0.8 });

  if (rand > 0.5) {
    g.circle(cx + 2, cy - 4, 1.5);
    g.fill(rand > 0.75 ? 0xf48fb1 : 0xffeb3b);
  }
}

function drawFenceDecoration(g: Graphics, col: number, row: number) {
  const x = col * TILE_SIZE;
  const y = row * TILE_SIZE;

  for (let i = 0; i < 3; i++) {
    const px = x + 4 + i * 12;
    g.rect(px, y + 6, 3, 22);
    g.fill(0x8d6e63);
    g.stroke({ color: 0x5d4037, width: 0.5 });
    g.circle(px + 1.5, y + 6, 2);
    g.fill(0x8d6e63);
  }
  g.rect(x + 2, y + 12, TILE_SIZE - 4, 2.5);
  g.fill(0xa1887f);
  g.rect(x + 2, y + 20, TILE_SIZE - 4, 2.5);
  g.fill(0xa1887f);
}

// ---- Preload all avatar sprites ----
async function preloadAvatarTextures() {
  const entries = Object.entries(SPECIES_SPRITE_MAP) as [AvatarSpecies, string][];
  const promises = entries.map(([, path]) => Assets.load(path));
  await Promise.all(promises);
}

// ---- NPC sprite helper ----
interface NpcSpriteInfo {
  container: Container;
  sprite: Sprite;
  nameLabel: Text;
  bubbleContainer: Container;
  bubbleText: Text | null;
  shadow: Graphics;
  lastDirection: string;
}

function createNpcSprite(npc: NpcSpriteState): NpcSpriteInfo {
  const container = new Container();

  // Shadow
  const shadow = new Graphics();
  shadow.ellipse(0, 6, 12, 4);
  shadow.fill({ color: 0x000000, alpha: 0.2 });
  container.addChild(shadow);

  // Sprite
  const species = npc.species as AvatarSpecies;
  const texturePath = SPECIES_SPRITE_MAP[species] ?? SPECIES_SPRITE_MAP.cat;
  const texture = Assets.get(texturePath);
  const sprite = new Sprite(texture);
  const targetH = 56; // NPCs slightly smaller than player avatar
  const sc = targetH / sprite.texture.height;
  sprite.scale.set(sc);
  sprite.anchor.set(0.5, 0.85);
  // Apply color tint
  if (npc.color) {
    sprite.tint = blendColors(0xffffff, npc.color, 0.4);
  }
  container.addChild(sprite);

  // Name label
  const nameLabel = new Text({
    text: npc.name,
    style: { fontSize: 10, fill: 0xffffff, fontFamily: 'Arial', fontWeight: 'bold', dropShadow: { distance: 1, color: 0x000000 } },
  });
  nameLabel.anchor.set(0.5, 1);
  nameLabel.y = -targetH + 8;
  container.addChild(nameLabel);

  // Chat bubble container (initially hidden)
  const bubbleContainer = new Container();
  bubbleContainer.visible = false;
  bubbleContainer.y = -targetH - 5;
  container.addChild(bubbleContainer);

  container.x = npc.x;
  container.y = npc.y;

  return { container, sprite, nameLabel, bubbleContainer, bubbleText: null, shadow, lastDirection: npc.direction };
}

interface PixiCanvasProps {
  isSpectator?: boolean;
}

export default function PixiCanvas({ isSpectator = false }: PixiCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const avatarSpriteRef = useRef<Sprite | null>(null);
  const avatarContainerRef = useRef<Container | null>(null);
  const scaleRef = useRef<number>(1);
  const npcSpritesRef = useRef<Map<string, NpcSpriteInfo>>(new Map());
  const npcContainerRef = useRef<Container | null>(null);
  const viewport = useViewport();
  const updateCamera = useCamera(MAP_WIDTH, MAP_HEIGHT, viewport.width, viewport.height);
  const gameTick = useGameLoop({ mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT, buildingZones: pixelZones, isSpectator });

  useEffect(() => {
    if (!canvasRef.current || appRef.current) return;

    let destroyed = false;

    (async () => {
      // Start preloading avatar textures in parallel (don't block canvas init)
      const texturesReady = preloadAvatarTextures();

      const viewW = window.innerWidth;
      const viewH = window.innerHeight;

      const app = new Application();
      await app.init({
        width: viewW,
        height: viewH,
        backgroundColor: 0x2e7d32,
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

      const world = new Container();
      app.stage.addChild(world);
      worldRef.current = world;

      const scale = Math.max(viewW / MAP_WIDTH, viewH / MAP_HEIGHT);
      world.scale.set(scale);
      scaleRef.current = scale;

      // ---- Draw ground layer ----
      const groundGraphics = new Graphics();
      // Solid fill first so no gaps are visible at edges
      groundGraphics.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      groundGraphics.fill(0x4caf50);
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

      // ---- Draw path layer ----
      const pathGraphics = new Graphics();
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          const tile = pathLayer[row * MAP_COLS + col];
          if (tile === TILES.EMPTY || tile === -1) continue;
          drawPathTile(pathGraphics, col, row, tile);
        }
      }
      world.addChild(pathGraphics);

      // ---- Draw decoration layer ----
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

      // ---- Draw buildings ----
      const buildingsContainer = new Container();
      for (const zone of buildingZones) {
        const loc = MAP_LOCATIONS.find((l) => l.id === zone.id);
        if (!loc) continue;

        const buildingContainer = drawBuilding(zone.id, zone.width, zone.height);
        buildingContainer.x = zone.x * TILE_SIZE;
        buildingContainer.y = zone.y * TILE_SIZE;

        if (!isSpectator) {
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
        }

        buildingsContainer.addChild(buildingContainer);
      }
      world.addChild(buildingsContainer);

      // ---- NPC container ----
      const npcContainer = new Container();
      world.addChild(npcContainer);
      npcContainerRef.current = npcContainer;

      // ---- Avatar PNG sprite (conditional) ----
      let avatarContainer: Container | null = null;
      let bubbleContainer: Container | null = null;
      let footstepContainer: Container | null = null;
      const targetHeight = 72;
      let idleTimer = 0;
      let bubbleTimer = 0;
      let lastMoving = false;
      let footstepTimer = 0;

      if (!isSpectator) {
        avatarContainer = new Container();
        world.addChild(avatarContainer);
        avatarContainerRef.current = avatarContainer;

        // Shadow + bubble + footsteps are created immediately (no texture needed)
        const avatarShadow = new Graphics();
        avatarShadow.ellipse(0, 6, 16, 5);
        avatarShadow.fill({ color: 0x000000, alpha: 0.2 });
        avatarContainer.addChild(avatarShadow);

        bubbleContainer = new Container();
        bubbleContainer.visible = false;
        avatarContainer.addChild(bubbleContainer);

        footstepContainer = new Container();
        world.addChild(footstepContainer);

        // Avatar sprite itself is created in the texturesReady callback above
      }

      // ---- Building proximity glow ----
      const glowContainer = new Container();
      world.addChildAt(glowContainer, world.children.indexOf(buildingsContainer));
      const buildingGlows: Map<string, Graphics> = new Map();
      for (const zone of pixelZones) {
        const glow = new Graphics();
        glow.roundRect(zone.x - 4, zone.y - 4, zone.width + 8, zone.height + 8, 6);
        glow.fill({ color: 0xffd700, alpha: 0 });
        glowContainer.addChild(glow);
        buildingGlows.set(zone.id, glow);
      }

      // ---- Day/night overlay ----
      const dayNightOverlay = new Graphics();
      dayNightOverlay.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      dayNightOverlay.fill({ color: 0x000033, alpha: 0 });
      world.addChild(dayNightOverlay);

      // Wait for textures to load in background; sprites guarded until ready
      let spritesLoaded = false;
      texturesReady.then(() => {
        spritesLoaded = true;
        // Create avatar sprite once textures are available
        if (!isSpectator && avatarContainer && !avatarSpriteRef.current) {
          const state = useGameStore.getState();
          const species = (state.avatarSpecies || 'cat') as AvatarSpecies;
          const texturePath = SPECIES_SPRITE_MAP[species] ?? SPECIES_SPRITE_MAP.cat;
          const texture = Assets.get(texturePath);
          if (texture) {
            const avatarSprite = new Sprite(texture);
            const spriteScale = targetHeight / avatarSprite.texture.height;
            avatarSprite.scale.set(spriteScale);
            avatarSprite.anchor.set(0.5, 0.85);
            const avatarColor = (state.avatarColor || 'blue') as AvatarColor;
            const tint = COLOR_TINT_MAP[avatarColor] ?? 0xffffff;
            if (tint !== 0xffffff) {
              avatarSprite.tint = blendColors(0xffffff, tint, 0.3);
            }
            avatarContainer.addChild(avatarSprite);
            avatarSpriteRef.current = avatarSprite;
          }
        }
      });

      let elapsedTime = 0;
      let lastSpecies: string = (useGameStore.getState().avatarSpecies || 'cat');

      const IDLE_PHRASES = [
        '...', 'Hmm...', '*yawns*', '*looks around*', 'Nice day!',
        'What\'s over there?', '*stretches*', 'I wonder...', '*hums*',
      ];

      // Game loop
      app.ticker.add((ticker) => {
        gameTick(ticker.deltaTime);

        const dt = ticker.deltaTime / 60;
        elapsedTime += dt;

        const st = useGameStore.getState();
        const currentScale = scaleRef.current;

        // ---- Avatar rendering (non-spectator only) ----
        if (!isSpectator && avatarContainer && avatarSpriteRef.current) {
          // Update avatar sprite if species changed
          if (st.avatarSpecies !== lastSpecies) {
            const newSpecies = (st.avatarSpecies || 'cat') as AvatarSpecies;
            const newPath = SPECIES_SPRITE_MAP[newSpecies] ?? SPECIES_SPRITE_MAP.cat;
            const newTex = Assets.get(newPath);
            if (newTex) {
              avatarSpriteRef.current.texture = newTex;
              const ns = targetHeight / newTex.height;
              avatarSpriteRef.current.scale.set(ns);
            }
            lastSpecies = st.avatarSpecies;
          }

          // Avatar animation
          const sprite = avatarSpriteRef.current;
          const dir = st.movementDirection;
          const isMoving = dir !== 'idle';

          const baseScale = targetHeight / sprite.texture.height;
          if (dir === 'left') sprite.scale.x = baseScale;
          else if (dir === 'right') sprite.scale.x = -baseScale;

          if (isMoving) {
            if (dir === 'up' || dir === 'down') {
              sprite.x = Math.sin(elapsedTime * 10) * 2;
              sprite.y = Math.abs(Math.sin(elapsedTime * 12)) * -3;
              sprite.rotation = Math.sin(elapsedTime * 10) * 0.03;
            } else {
              sprite.x = 0;
              sprite.y = Math.sin(elapsedTime * 12) * 3;
              sprite.rotation = Math.sin(elapsedTime * 8) * 0.05;
            }
          } else {
            sprite.x = 0;
            sprite.y = Math.sin(elapsedTime * 3) * 2;
            sprite.rotation = 0;
          }

          avatarContainer.x = st.avatarPosition.x;
          avatarContainer.y = st.avatarPosition.y;

          const avatarIsMoving = st.movementDirection !== 'idle';

          // Speech bubble logic
          if (bubbleContainer) {
            if (avatarIsMoving) {
              idleTimer = 0;
              bubbleTimer = 0;
              bubbleContainer.visible = false;
              lastMoving = true;
            } else {
              idleTimer += dt;
              if (bubbleContainer.visible) {
                bubbleTimer += dt;
                if (bubbleTimer > 2.5) {
                  bubbleContainer.visible = false;
                  bubbleTimer = 0;
                  idleTimer = 0;
                }
              } else if (idleTimer > 4 + Math.random() * 3) {
                const phrase = IDLE_PHRASES[Math.floor(Math.random() * IDLE_PHRASES.length)];
                bubbleContainer.removeChildren();

                const textWidth = phrase.length * 6 + 16;
                const bg = new Graphics();
                bg.roundRect(-textWidth / 2, -50, textWidth, 22, 8);
                bg.fill({ color: 0xffffff, alpha: 0.9 });
                bg.moveTo(-4, -28);
                bg.lineTo(0, -20);
                bg.lineTo(4, -28);
                bg.fill({ color: 0xffffff, alpha: 0.9 });
                bubbleContainer.addChild(bg);

                const bText = new Text({ text: phrase, style: { fontSize: 11, fill: 0x333333, fontFamily: 'Arial' } });
                bText.anchor.set(0.5, 0.5);
                bText.x = 0;
                bText.y = -39;
                bubbleContainer.addChild(bText);

                bubbleContainer.visible = true;
                idleTimer = 0;
              }
              lastMoving = false;
            }
          }

          // Footstep particles
          if (footstepContainer) {
            if (avatarIsMoving) {
              footstepTimer += dt;
              if (footstepTimer > 0.12) {
                footstepTimer = 0;
                const dust = new Graphics();
                const px = st.avatarPosition.x + (Math.random() - 0.5) * 10;
                const py = st.avatarPosition.y + 4 + Math.random() * 4;
                dust.circle(px, py, 2 + Math.random() * 2);
                dust.fill({ color: 0xb8946a, alpha: 0.5 });
                (dust as any)._life = 0;
                footstepContainer.addChild(dust);
              }
            }
            for (let i = footstepContainer.children.length - 1; i >= 0; i--) {
              const dust = footstepContainer.children[i] as any;
              dust._life += dt;
              dust.alpha = Math.max(0, 0.5 - dust._life * 0.8);
              dust.scale.set(1 + dust._life * 0.5);
              if (dust._life > 0.6) {
                footstepContainer.removeChild(dust);
                dust.destroy();
              }
            }
          }
        }

        // ---- Camera ----
        const cam = updateCamera();
        if (worldRef.current) {
          worldRef.current.x = cam.x * currentScale;
          worldRef.current.y = cam.y * currentScale;
        }

        // ---- NPC rendering ----
        const npcState = useNpcStore.getState();
        const npcMap = npcSpritesRef.current;
        const npcCont = npcContainerRef.current;

        if (npcCont) {
          // Create / update NPC sprites
          for (const npc of npcState.npcs) {
            let info = npcMap.get(npc.id);

            if (!info) {
              // Skip NPC creation until avatar sprite textures are loaded
              if (!spritesLoaded) continue;
              info = createNpcSprite(npc);
              npcMap.set(npc.id, info);
              npcCont.addChild(info.container);
            }

            // Update position (smooth lerp)
            info.container.x += (npc.x - info.container.x) * 0.15;
            info.container.y += (npc.y - info.container.y) * 0.15;

            // Update direction / animation
            const npcTargetH = 56;
            const npcBaseScale = npcTargetH / info.sprite.texture.height;
            if (npc.direction === 'left') info.sprite.scale.x = npcBaseScale;
            else if (npc.direction === 'right') info.sprite.scale.x = -npcBaseScale;

            // Walking bob
            if (npc.direction !== 'idle') {
              info.sprite.y = Math.sin(elapsedTime * 10 + npc.x * 0.01) * 2;
            } else {
              info.sprite.y = Math.sin(elapsedTime * 3 + npc.x * 0.01) * 1.5;
            }

            // Dead/alive visibility
            if (npc.isDead) {
              info.container.alpha = Math.max(0, info.container.alpha - 0.05);
            } else {
              info.container.alpha = Math.min(1, info.container.alpha + 0.05);
            }
          }

          // Update chat bubbles for NPCs
          const now = Date.now();
          for (const bubble of npcState.chatBubbles) {
            if (bubble.expiresAt < now) continue;
            const info = npcMap.get(bubble.npcId);
            if (!info) continue;

            // Show bubble if not already showing this text
            if (!info.bubbleContainer.visible || (info.bubbleText && info.bubbleText.text !== bubble.text)) {
              info.bubbleContainer.removeChildren();
              const text = bubble.text.slice(0, 60);
              const tw = Math.min(text.length * 5.5 + 16, 200);
              const bg = new Graphics();
              bg.roundRect(-tw / 2, -28, tw, 22, 8);
              bg.fill({ color: 0xffffff, alpha: 0.92 });
              bg.moveTo(-4, -6);
              bg.lineTo(0, 2);
              bg.lineTo(4, -6);
              bg.fill({ color: 0xffffff, alpha: 0.92 });
              info.bubbleContainer.addChild(bg);

              const bText = new Text({
                text,
                style: { fontSize: 9, fill: 0x333333, fontFamily: 'Arial', wordWrap: true, wordWrapWidth: tw - 12 },
              });
              bText.anchor.set(0.5, 0.5);
              bText.y = -17;
              info.bubbleContainer.addChild(bText);
              info.bubbleText = bText;
              info.bubbleContainer.visible = true;
            }
          }

          // Hide expired bubbles
          for (const [, info] of npcMap) {
            const hasBubble = npcState.chatBubbles.some(
              (b) => b.npcId === info.container.name && b.expiresAt > now
            );
            // Also check by matching position (container doesn't have name set)
            // Instead, let bubbles auto-hide after time
            if (info.bubbleContainer.visible && info.bubbleText) {
              const matchingBubble = npcState.chatBubbles.find(
                (b) => {
                  const npcInfo = npcMap.get(b.npcId);
                  return npcInfo === info && b.expiresAt > now;
                }
              );
              if (!matchingBubble) {
                info.bubbleContainer.visible = false;
                info.bubbleText = null;
              }
            }
          }
        }

        // ---- Building proximity glow ----
        if (!isSpectator) {
          const nearId = st.nearLocation;
          for (const [id, glow] of buildingGlows) {
            const targetAlpha = id === nearId ? 0.25 : 0;
            const currentAlpha = (glow as any)._curAlpha ?? 0;
            const newAlpha = currentAlpha + (targetAlpha - currentAlpha) * 0.1;
            (glow as any)._curAlpha = newAlpha;
            glow.alpha = newAlpha;
          }
        }

        // ---- Day/night cycle ----
        const dayPhase = (elapsedTime % 300) / 300;
        const nightAmount = Math.sin(dayPhase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
        dayNightOverlay.alpha = nightAmount * 0.15;
      });
    })();

    return () => {
      destroyed = true;
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
      npcSpritesRef.current.clear();
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
