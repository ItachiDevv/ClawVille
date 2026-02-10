'use client';

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Sprite, Assets, Text } from 'pixi.js';
import { useViewport } from '@/lib/pixi/use-viewport';
import { useGameStore } from '@/stores/game';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';
import { MAP_LOCATIONS } from '@legacyapp/shared';
import { SPECIES_SPRITE_MAP, blendColors } from '@/lib/pixi/pet-sprites';
import { drawBuilding } from '@/lib/pixi/building-renderer';
import type { PetSpecies } from '@legacyapp/shared';
import { useKeyboard } from '@/lib/pixi/use-keyboard';
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

// Seeded pseudo-random
function seededRandom(x: number, y: number, seed: number = 42): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 113.5) * 43758.5453;
  return n - Math.floor(n);
}

// Preload all pet sprites
async function preloadPetTextures() {
  const entries = Object.entries(SPECIES_SPRITE_MAP) as [PetSpecies, string][];
  await Promise.all(entries.map(([, path]) => Assets.load(path)));
}

interface ArenaNpcInfo {
  container: Container;
  sprite: Sprite;
  nameLabel: Text;
  hpBarBg: Graphics;
  hpBarFill: Graphics;
  swordGraphic: Graphics;
  bubbleContainer: Container;
  bubbleText: Text | null;
  glowRing: Graphics | null;
}

function createArenaNpcSprite(npc: NpcSpriteState): ArenaNpcInfo {
  const container = new Container();
  const targetH = 56;

  // Shadow
  const shadow = new Graphics();
  shadow.ellipse(0, 6, 12, 4);
  shadow.fill({ color: 0x000000, alpha: 0.2 });
  container.addChild(shadow);

  // Sprite
  const species = npc.species as PetSpecies;
  const texturePath = SPECIES_SPRITE_MAP[species] ?? SPECIES_SPRITE_MAP.cat;
  const texture = Assets.get(texturePath);
  const sprite = new Sprite(texture);
  const sc = targetH / sprite.texture.height;
  sprite.scale.set(sc);
  sprite.anchor.set(0.5, 0.85);
  if (npc.color) {
    sprite.tint = blendColors(0xffffff, npc.color, 0.4);
  }
  container.addChild(sprite);

  // Sword graphic (small blade attached to side)
  const swordGraphic = new Graphics();
  // Blade
  swordGraphic.rect(-1, -12, 2, 10);
  swordGraphic.fill(0xc0c0c0);
  // Guard
  swordGraphic.rect(-3, -2, 6, 2);
  swordGraphic.fill(0x8b7355);
  // Handle
  swordGraphic.rect(-1, 0, 2, 4);
  swordGraphic.fill(0x654321);
  swordGraphic.x = 18;
  swordGraphic.y = -20;
  container.addChild(swordGraphic);

  // HP bar background
  const hpBarBg = new Graphics();
  hpBarBg.roundRect(-20, -targetH - 2, 40, 5, 2);
  hpBarBg.fill(0x333333);
  container.addChild(hpBarBg);

  // HP bar fill
  const hpBarFill = new Graphics();
  container.addChild(hpBarFill);

  // Name label
  const nameLabel = new Text({
    text: npc.name,
    style: { fontSize: 9, fill: 0xffffff, fontFamily: 'Arial', fontWeight: 'bold', dropShadow: { distance: 1, color: 0x000000 } },
  });
  nameLabel.anchor.set(0.5, 1);
  nameLabel.y = -targetH - 8;
  container.addChild(nameLabel);

  // OpenClaw glow ring
  let glowRing: Graphics | null = null;
  if (npc.isOpenClaw) {
    glowRing = new Graphics();
    glowRing.circle(0, 0, 22);
    glowRing.stroke({ width: 2, color: 0x00e5ff, alpha: 0.6 });
    glowRing.y = -4;
    container.addChildAt(glowRing, 0); // Behind sprite

    // Update name to show [OC] tag
    nameLabel.text = `[OC] ${npc.name}`;
  }

  // Chat bubble
  const bubbleContainer = new Container();
  bubbleContainer.visible = false;
  bubbleContainer.y = -targetH - 18;
  container.addChild(bubbleContainer);

  container.x = npc.x;
  container.y = npc.y;

  return { container, sprite, nameLabel, hpBarBg, hpBarFill, swordGraphic, bubbleContainer, bubbleText: null, glowRing };
}

function updateHpBar(info: ArenaNpcInfo, hp: number, maxHp: number) {
  const targetH = 56;
  info.hpBarFill.clear();
  const ratio = Math.max(0, hp / maxHp);
  const width = 38 * ratio;
  const color = ratio > 0.5 ? 0x4caf50 : ratio > 0.25 ? 0xff9800 : 0xf44336;
  info.hpBarFill.roundRect(-19, -targetH - 1, width, 3, 1);
  info.hpBarFill.fill(color);
}

export default function ArenaCanvas() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const scaleRef = useRef<number>(1);
  const npcSpritesRef = useRef<Map<string, ArenaNpcInfo>>(new Map());
  const npcContainerRef = useRef<Container | null>(null);
  const fxContainerRef = useRef<Container | null>(null);
  const viewport = useViewport();
  const keyboard = useKeyboard();

  // Keep viewport in a ref so the game loop closure always reads current values
  const viewportRef = useRef({ width: 800, height: 600 });
  viewportRef.current = { width: viewport.width, height: viewport.height };

  // Camera state for arena (spectator-style free camera)
  const camPosRef = useRef({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });

  useEffect(() => {
    if (!canvasRef.current || appRef.current) return;

    let destroyed = false;

    (async () => {
      // Start preloading pet textures in parallel (don't block canvas init)
      const texturesReady = preloadPetTextures();

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

      // ---- Draw tilemap layers (same as PixiCanvas but simplified - reuse tile functions) ----
      // Ground — solid fill first so no gaps are visible at edges
      const groundGraphics = new Graphics();
      groundGraphics.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      groundGraphics.fill(0x4caf50);
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          const tile = groundLayer[row * MAP_COLS + col];
          if (tile === TILES.EMPTY || tile === -1) continue;
          const x = col * TILE_SIZE;
          const y = row * TILE_SIZE;
          if (tile === TILES.WATER) {
            const rand = seededRandom(col, row);
            groundGraphics.rect(x, y, TILE_SIZE, TILE_SIZE);
            groundGraphics.fill(blendColors(0x1e88e5, 0x42a5f5, rand * 0.4));
          } else {
            const grassColors = [0x4caf50, 0x43a047, 0x388e3c];
            const rand = seededRandom(col, row);
            const baseColor = grassColors[tile] ?? 0x4caf50;
            const variedColor = blendColors(baseColor, 0x2e7d32, rand * 0.15);
            groundGraphics.rect(x, y, TILE_SIZE, TILE_SIZE);
            groundGraphics.fill(variedColor);
          }
        }
      }
      world.addChild(groundGraphics);

      // Paths
      const pathGraphics = new Graphics();
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          const tile = pathLayer[row * MAP_COLS + col];
          if (tile === TILES.EMPTY || tile === -1) continue;
          const x = col * TILE_SIZE;
          const y = row * TILE_SIZE;
          if (tile === TILES.DIRT_PATH) {
            pathGraphics.rect(x, y, TILE_SIZE, TILE_SIZE);
            pathGraphics.fill(0xbcaaa4);
          } else if (tile === TILES.STONE_PATH) {
            pathGraphics.rect(x, y, TILE_SIZE, TILE_SIZE);
            pathGraphics.fill(0x9e9e9e);
          }
        }
      }
      world.addChild(pathGraphics);

      // Buildings
      const buildingsContainer = new Container();
      for (const zone of buildingZones) {
        const loc = MAP_LOCATIONS.find((l) => l.id === zone.id);
        if (!loc) continue;
        const buildingContainer = drawBuilding(zone.id, zone.width, zone.height);
        buildingContainer.x = zone.x * TILE_SIZE;
        buildingContainer.y = zone.y * TILE_SIZE;
        buildingsContainer.addChild(buildingContainer);
      }
      world.addChild(buildingsContainer);

      // NPC container
      const npcContainer = new Container();
      world.addChild(npcContainer);
      npcContainerRef.current = npcContainer;

      // FX container (damage numbers, particles)
      const fxContainer = new Container();
      world.addChild(fxContainer);
      fxContainerRef.current = fxContainer;

      // Arena tint overlay (slight red/warm for battle atmosphere)
      const arenaOverlay = new Graphics();
      arenaOverlay.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      arenaOverlay.fill({ color: 0x330000, alpha: 0.05 });
      world.addChild(arenaOverlay);

      // Wait for textures to load in background; NPCs will be skipped until ready
      let spritesLoaded = false;
      texturesReady.then(() => { spritesLoaded = true; });

      let elapsedTime = 0;

      // Game loop
      app.ticker.add((ticker) => {
        const dt = ticker.deltaTime / 60;
        elapsedTime += dt;

        const currentScale = scaleRef.current;
        const cam = camPosRef.current;

        // Camera movement via keyboard
        const speed = 200;
        if (keyboard.isDown('w') || keyboard.isDown('arrowup')) cam.y -= speed * dt;
        if (keyboard.isDown('s') || keyboard.isDown('arrowdown')) cam.y += speed * dt;
        if (keyboard.isDown('a') || keyboard.isDown('arrowleft')) cam.x -= speed * dt;
        if (keyboard.isDown('d') || keyboard.isDown('arrowright')) cam.x += speed * dt;
        cam.x = Math.max(0, Math.min(MAP_WIDTH, cam.x));
        cam.y = Math.max(0, Math.min(MAP_HEIGHT, cam.y));

        // Apply camera (read from ref to avoid stale closure)
        const vp = viewportRef.current;
        const effectiveViewW = vp.width / currentScale;
        const effectiveViewH = vp.height / currentScale;
        const offsetX = -Math.max(0, Math.min(MAP_WIDTH - effectiveViewW, cam.x - effectiveViewW / 2));
        const offsetY = -Math.max(0, Math.min(MAP_HEIGHT - effectiveViewH, cam.y - effectiveViewH / 2));
        if (worldRef.current) {
          worldRef.current.x = offsetX * currentScale;
          worldRef.current.y = offsetY * currentScale;
        }

        // ---- NPC rendering ----
        const npcState = useNpcStore.getState();
        const npcMap = npcSpritesRef.current;
        const npcCont = npcContainerRef.current;
        const fxCont = fxContainerRef.current;

        if (npcCont) {
          for (const npc of npcState.npcs) {
            let info = npcMap.get(npc.id);

            if (!info) {
              // Skip NPC creation until pet sprite textures are loaded
              if (!spritesLoaded) continue;
              info = createArenaNpcSprite(npc);
              npcMap.set(npc.id, info);
              npcCont.addChild(info.container);
            }

            // Smooth position lerp
            info.container.x += (npc.x - info.container.x) * 0.15;
            info.container.y += (npc.y - info.container.y) * 0.15;

            // Direction / animation
            const npcTargetH = 56;
            const npcBaseScale = npcTargetH / info.sprite.texture.height;
            if (npc.direction === 'left') info.sprite.scale.x = npcBaseScale;
            else if (npc.direction === 'right') info.sprite.scale.x = -npcBaseScale;

            // Sword position follows direction
            info.swordGraphic.x = info.sprite.scale.x > 0 ? 18 : -18;

            // Walking/idle bob
            if (npc.direction !== 'idle') {
              info.sprite.y = Math.sin(elapsedTime * 10 + npc.x * 0.01) * 2;
            } else {
              info.sprite.y = Math.sin(elapsedTime * 3 + npc.x * 0.01) * 1.5;
            }

            // Combat sword animation
            if (npc.inCombat) {
              info.swordGraphic.rotation = Math.sin(elapsedTime * 8) * 0.5;
            } else {
              info.swordGraphic.rotation = 0;
            }

            // OpenClaw glow pulse
            if (info.glowRing) {
              info.glowRing.alpha = 0.3 + 0.4 * Math.sin(elapsedTime * 4);
            }

            // HP bar
            updateHpBar(info, npc.hp, npc.maxHp);

            // Dead/alive
            if (npc.isDead) {
              info.container.alpha = Math.max(0, info.container.alpha - 0.03);
            } else {
              info.container.alpha = Math.min(1, info.container.alpha + 0.05);
            }
          }

          // Combat FX: damage numbers
          if (fxCont) {
            const now = Date.now();
            for (const event of npcState.combatEvents) {
              if (event.expiresAt < now) continue;
              const defender = npcMap.get(event.defenderId);
              if (!defender) continue;

              // Check if we already spawned this FX
              const fxId = `dmg-${event.id}`;
              const existing = (fxCont as any)[fxId];
              if (existing) continue;

              // Damage number text
              const dmgText = new Text({
                text: `-${event.damage}`,
                style: { fontSize: 14, fill: 0xff4444, fontFamily: 'Arial', fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } },
              });
              dmgText.anchor.set(0.5, 0.5);
              dmgText.x = defender.container.x + (Math.random() - 0.5) * 20;
              dmgText.y = defender.container.y - 40;
              (dmgText as any)._life = 0;
              fxCont.addChild(dmgText);
              (fxCont as any)[fxId] = true;

              // Red flash on defender
              defender.sprite.tint = 0xff0000;
              setTimeout(() => {
                const npc = npcState.npcs.find((n) => n.id === event.defenderId);
                if (npc && defender.sprite) {
                  defender.sprite.tint = npc.color
                    ? blendColors(0xffffff, npc.color, 0.4)
                    : 0xffffff;
                }
              }, 200);
            }

            // Loot sparkle FX
            for (const event of npcState.lootEvents) {
              if (event.expiresAt < now) continue;
              const winner = npcMap.get(event.winnerId);
              if (!winner) continue;

              const sparkleId = `sparkle-${event.id}`;
              if ((fxCont as any)[sparkleId]) continue;
              (fxCont as any)[sparkleId] = true;

              // Gold sparkle particles
              for (let i = 0; i < 6; i++) {
                const sparkle = new Graphics();
                sparkle.circle(0, 0, 2);
                sparkle.fill(0xffd700);
                sparkle.x = winner.container.x + (Math.random() - 0.5) * 30;
                sparkle.y = winner.container.y - 10 - Math.random() * 20;
                (sparkle as any)._life = 0;
                (sparkle as any)._vy = -1 - Math.random() * 2;
                fxCont.addChild(sparkle);
              }
            }

            // Age and remove FX
            for (let i = fxCont.children.length - 1; i >= 0; i--) {
              const child = fxCont.children[i] as any;
              if (child._life === undefined) continue;
              child._life += dt;
              child.y += (child._vy ?? -1) * dt * 60;
              child.alpha = Math.max(0, 1 - child._life * 1.2);
              if (child._life > 1) {
                fxCont.removeChild(child);
                child.destroy();
              }
            }
          }

          // NPC chat bubbles
          const now2 = Date.now();
          for (const bubble of npcState.chatBubbles) {
            if (bubble.expiresAt < now2) continue;
            const info = npcMap.get(bubble.npcId);
            if (!info) continue;

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
            if (info.bubbleContainer.visible && info.bubbleText) {
              const matchingBubble = npcState.chatBubbles.find((b) => {
                const npcInfo = npcMap.get(b.npcId);
                return npcInfo === info && b.expiresAt > now2;
              });
              if (!matchingBubble) {
                info.bubbleContainer.visible = false;
                info.bubbleText = null;
              }
            }
          }
        }
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
