'use client';
import { useEffect, useRef, useState } from 'react';
import { Application, Container, Graphics, Sprite, Assets, Text, Texture, TilingSprite, Rectangle, UPDATE_PRIORITY } from 'pixi.js';
import { useViewport } from '@/lib/pixi/use-viewport';
import { useCamera } from '@/lib/pixi/use-camera';
import { useGameLoop } from '@/lib/pixi/use-game-loop';
import { pixiWorldScale, pixiHitSize, pixiSolidFootprint } from '@/lib/pixi/pixi-world-scale';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { BRAINCHAIN_OFFICE_WORLD_CENTER, BRAINCHAIN_OFFICE_HALF_X_WU, BRAINCHAIN_OFFICE_HALF_Z_WU, BRAINCHAIN_OFFICE_GUIDE_WORLD, WORLD_CENTER_PX } from '@clawville/shared';
import type { AvatarSpecies } from '@clawville/shared';
import { SPECIES_SPRITE_MAP } from '@/lib/pixi/avatar-sprites';
import { MODEL_KEY_TO_LEGACY_SPECIES, type ModelKey } from '@/lib/three/agent-model-registry';
import { getAllColliders } from '@/lib/three/collision/world-colliders';
import { drawBuilding } from '@/lib/pixi/building-renderer';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { CHARACTER_POSITIONS, COVE_EXIT_WORLD_X, COVE_EXIT_WORLD_Z } from '@/lib/three/character-positions';
import { TRADING_FLOOR_DOOR_WORLD } from '@/lib/three/trading-floor/trading-floor-location';
import { KELP_FOREST_EXIT_WORLD } from '@/lib/three/kelp-forest-location';
import { triggerCoveWalkIn, triggerTradingFloorWalkIn } from '@/lib/three/venue-walk-in';
import { triggerKelpForestWalkIn } from '@/lib/three/kelp-forest-transition';
import { NORI_WORLD_X, NORI_WORLD_Z } from '@/lib/three/town-guide-position';
import { approachBrainchainOffice } from '@/lib/three/brainchain-office-transition';
import { findPath } from '@/lib/pixi/client-pathfinding';
import { dispatchWorldInteraction, updateWorldProximity } from '@/lib/world-frame-interaction';
import { isWorldInputBlocked } from '@/lib/three/world-input-guard';
import { reloadWorldRenderer } from '@/lib/world-renderer-mode';

function spritePath(species: string): string {
  const legacy = MODEL_KEY_TO_LEGACY_SPECIES[species as ModelKey] ?? species;
  return SPECIES_SPRITE_MAP[legacy as AvatarSpecies] ?? SPECIES_SPRITE_MAP.cat;
}
export interface PixiCanvasProps { onFrame?: () => void; onMount?: () => void; onFailure?: () => void; }
export default function PixiCanvas({ onFrame, onMount, onFailure }: PixiCanvasProps) {
  const holder = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const [error, setError] = useState(false);
  const viewport = useViewport();
  const camera = useCamera(MAP_WIDTH, MAP_HEIGHT, viewport.width, viewport.height);
  const tick = useGameLoop({ mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT });
  const callbacks = useRef({ tick, camera, onFrame, onMount, onFailure }); callbacks.current = { tick, camera, onFrame, onMount, onFailure };
  useEffect(() => {
    let cancelled = false;
    let ownedApp: Application | undefined;
    let groundTexture: Texture | undefined;
    const npcSprites = new Map<string, { container: Container; sprite: Sprite; label: Text }>();
    async function start() {
      const app = new Application(); ownedApp = app;
      await app.init({ width: window.innerWidth, height: window.innerHeight, preference: 'webgl', backgroundColor: 0x27636a, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true, antialias: false });
      if (cancelled || !holder.current) { app.destroy(true, { children: true }); return; }
      holder.current.appendChild(app.canvas as HTMLCanvasElement); appRef.current = app;
      const world = new Container(); worldRef.current = world; app.stage.addChild(world);
      world.scale.set(pixiWorldScale(window.innerWidth, window.innerHeight));
      // One small reusable texture and one quad, independent of map area.
      const tile = document.createElement('canvas'); tile.width = tile.height = 64;
      const context = tile.getContext('2d');
      if (!context) throw new Error('No 2D texture context');
      context.fillStyle = '#27636a'; context.fillRect(0, 0, 64, 64);
      context.fillStyle = '#32717a'; context.fillRect(9, 14, 3, 3); context.fillRect(42, 47, 2, 2);
      groundTexture = Texture.from(tile);
      const ground = new TilingSprite({ texture: groundTexture, width: MAP_WIDTH, height: MAP_HEIGHT });
      ground.eventMode = 'static'; ground.cursor = 'crosshair';
      ground.on('pointerdown', (event) => { const point = world.toLocal(event.global); walkTo(point.x, point.y, null); });
      world.addChild(ground);
      const targets: Container[] = [];
      let lastHitScale = 0;
      function canAct() { const s = useGameStore.getState(); return !s.movementFrozen && s.controlMode !== 'autonomous' && !isWorldInputBlocked(); }
      function walkTo(x: number, y: number, target: string | null) {
        if (!canAct()) return;
        const s = useGameStore.getState();
        if (s.controlMode === 'explore') { s.requestCameraFocus(x, y); return; }
        updateWorldProximity(avatarPositionRef.x - MAP_WIDTH / 2, avatarPositionRef.y - MAP_HEIGHT / 2, s.controlMode === 'npc');
        if (target && dispatchWorldInteraction(target)) return;
        const path = findPath(avatarPositionRef.x, avatarPositionRef.y, x, y);
        if (path.length) s.setClickPath(path, target);
      }
      function marker(text: string, x: number, y: number, color: number, action: () => void) {
        const c = new Container(); c.position.set(x, y);
        c.addChild(new Graphics().circle(0, 0, 55).fill(color));
        const label = new Text({ text, style: { fontFamily: 'Arial', fontSize: 28, fill: 0xffffff, stroke: { color: 0x112f36, width: 4 } } });
        label.anchor.set(0.5, 1); label.y = -65; c.addChild(label);
        c.eventMode = 'static'; c.cursor = 'pointer'; c.on('pointerdown', (e) => { e.stopPropagation(); if (canAct()) action(); });
        targets.push(c); world.addChild(c); return c;
      }
      const footprints = new Map(getAllColliders().flatMap((collider) => {
        const footprint = pixiSolidFootprint(collider, WORLD_CENTER_PX.x, WORLD_CENTER_PX.y);
        return footprint ? [[collider.id, footprint] as const] : [];
      }));
      const solidGraphics = new Graphics(); solidGraphics.eventMode = 'none';
      for (const footprint of footprints.values()) {
        solidGraphics.rect(footprint.x, footprint.y, footprint.width, footprint.height)
          .fill(footprint.kind === 'building' ? 0x456773 : 0x607a72)
          .stroke({ color: 0xe1c68c, width: 6, alignment: 1 });
        if (footprint.kind === 'prop' && !footprint.id.startsWith('brainchain') && footprint.width > 150) {
          const label = new Text({ text: footprint.id.replaceAll('-', ' '), style: { fontFamily: 'Arial', fontSize: 28, fill: 0xffffff, wordWrap: true, wordWrapWidth: footprint.width - 20 } });
          label.anchor.set(0.5); label.position.set(footprint.x + footprint.width / 2, footprint.y + footprint.height / 2); world.addChild(label);
        }
      }
      world.addChildAt(solidGraphics, 1);
      for (const zone of buildingZones) {
        const building = drawBuilding(zone.id, zone.width, zone.height);
        const footprint = footprints.get(zone.id);
        if (footprint) {
          const bounds = building.getLocalBounds();
          const fit = Math.min(footprint.width / Math.max(1, bounds.width), footprint.height / Math.max(1, bounds.height));
          building.scale.set(fit);
          building.position.set(footprint.x + (footprint.width - bounds.width * fit) / 2 - bounds.x * fit, footprint.y + (footprint.height - bounds.height * fit) / 2 - bounds.y * fit);
        } else building.position.set(zone.x * TILE_SIZE, zone.y * TILE_SIZE);
        world.addChild(building);
        const resident = CHARACTER_POSITIONS[zone.id];
        if (resident) {
          const x = WORLD_CENTER_PX.x + resident.worldX, y = WORLD_CENTER_PX.y + resident.worldZ;
          building.eventMode = 'static'; building.cursor = 'pointer';
          building.on('pointerdown', (e) => { e.stopPropagation(); walkTo(x, y, zone.id); });
          marker(resident.characterName, x, y, 0xffc373, () => walkTo(x, y, zone.id));
        }
      }
      const office = new Container(); office.position.set(WORLD_CENTER_PX.x + BRAINCHAIN_OFFICE_WORLD_CENTER.x, WORLD_CENTER_PX.y + BRAINCHAIN_OFFICE_WORLD_CENTER.z);
      office.addChild(new Graphics().roundRect(-BRAINCHAIN_OFFICE_HALF_X_WU, -BRAINCHAIN_OFFICE_HALF_Z_WU, BRAINCHAIN_OFFICE_HALF_X_WU * 2, BRAINCHAIN_OFFICE_HALF_Z_WU * 2, 32).fill(0x80c0b8).stroke({ color: 0xf581b4, width: 14 }));
      const title = new Text({ text: 'BrainChain Office', style: { fontFamily: 'Arial', fontSize: 48, fill: 0x29262b, fontWeight: 'bold' } }); title.anchor.set(0.5); office.addChild(title);
      office.eventMode = 'static'; office.cursor = 'pointer'; office.on('pointerdown', (e) => { e.stopPropagation(); if (canAct()) approachBrainchainOffice(); }); world.addChild(office);
      marker('BrainChain guide', WORLD_CENTER_PX.x + BRAINCHAIN_OFFICE_GUIDE_WORLD.x, WORLD_CENTER_PX.y + BRAINCHAIN_OFFICE_GUIDE_WORLD.z, 0xf581b4, () => approachBrainchainOffice(true));
      marker('Cove (3D)', WORLD_CENTER_PX.x + COVE_EXIT_WORLD_X, WORLD_CENTER_PX.y + COVE_EXIT_WORLD_Z, 0xc197fc, triggerCoveWalkIn);
      marker('Trading Floor (3D)', WORLD_CENTER_PX.x + TRADING_FLOOR_DOOR_WORLD.x, WORLD_CENTER_PX.y + TRADING_FLOOR_DOOR_WORLD.z, 0xc197fc, triggerTradingFloorWalkIn);
      marker('Kelp (3D)', WORLD_CENTER_PX.x + KELP_FOREST_EXIT_WORLD.x, WORLD_CENTER_PX.y + KELP_FOREST_EXIT_WORLD.z, 0xc197fc, triggerKelpForestWalkIn);
      marker('Nori', WORLD_CENTER_PX.x + NORI_WORLD_X, WORLD_CENTER_PX.y + NORI_WORLD_Z, 0xffdc6b, () => {
        const s = useGameStore.getState();
        if (s.nearGuide) s.openGuideChat();
        else walkTo(WORLD_CENTER_PX.x + NORI_WORLD_X, WORLD_CENTER_PX.y + NORI_WORLD_Z + 150, null);
      });
      const avatar = new Container(); world.addChild(avatar);
      avatar.addChild(new Graphics().ellipse(0, 9, 22, 8).fill({ color: 0x000000, alpha: 0.25 }));
      const avatarMarker = new Graphics().circle(0, 0, 30).fill(0xffffff); avatar.addChild(avatarMarker);
      let avatarSprite: Sprite | null = null;
      let texturesLoaded = false;
      // Fixed pool: no Graphics allocation during a frame.
      const dust = Array.from({ length: 8 }, () => { const g = new Graphics().circle(0, 0, 5).fill(0xd5b99c); g.visible = false; world.addChild(g); return { g, life: 1 }; });
      let dustIndex = 0, dustTime = 0;
      void Promise.all(Object.values(SPECIES_SPRITE_MAP).map((path) => Assets.load(path))).then(() => {
        if (cancelled) return;
        texturesLoaded = true;
        avatarSprite = new Sprite(Assets.get(spritePath(useGameStore.getState().avatarSpecies)));
        avatarSprite.anchor.set(0.5, 0.85); avatar.addChild(avatarSprite); avatarMarker.visible = false;
      }).catch(() => { /* Geometric avatar stays visible if sprite fetch fails. */ });
      callbacks.current.onMount?.();
      app.ticker.add((ticker) => {
        if (cancelled) return;
        const targetFPS = window.location.pathname === '/game' ? 60 : 10;
        if (app.ticker.maxFPS !== targetFPS) app.ticker.maxFPS = targetFPS;
        callbacks.current.tick(ticker.deltaTime);
        const s = useGameStore.getState(), scale = world.scale.x;
        const cam = callbacks.current.camera(); world.position.set(cam.x * scale, cam.y * scale);
        if (lastHitScale !== scale) {
          lastHitScale = scale;
          const size = Math.max(110, pixiHitSize(scale));
          for (const target of targets) target.hitArea = new Rectangle(-size / 2, -size / 2, size, size);
        }
        avatar.visible = s.controlMode === 'player'; avatar.position.set(avatarPositionRef.x, avatarPositionRef.y);
        if (avatarSprite) { avatarSprite.texture = Assets.get(spritePath(s.avatarSpecies)); const size = 100 / avatarSprite.texture.height; avatarSprite.scale.set(s.movementDirection === 'right' ? -size : size, size); }
        const dt = Math.min(ticker.deltaMS / 1000, 0.1); dustTime += dt;
        if (avatar.visible && s.movementDirection !== 'idle' && dustTime >= 0.12) {
          dustTime = 0; const p = dust[dustIndex++ % dust.length]; p.life = 0; p.g.position.set(avatarPositionRef.x, avatarPositionRef.y + 12);
        }
        for (const p of dust) { p.life += dt; p.g.visible = p.life < 0.6; p.g.alpha = Math.max(0, 0.5 - p.life * 0.8); }
        const npcs = useNpcStore.getState().npcs;
        for (const [id, info] of npcSprites) if (!npcs.some((n) => n.id === id)) { info.container.destroy({ children: true }); npcSprites.delete(id); }
        for (const npc of npcs) {
          if (!texturesLoaded) break;
          let info = npcSprites.get(npc.id);
          if (!info) {
            const container = new Container(), sprite = new Sprite(Assets.get(spritePath(npc.species)));
            sprite.anchor.set(0.5, 0.85); container.addChild(sprite);
            const label = new Text({ text: npc.name, style: { fontSize: 24, fill: 0xffffff, stroke: { color: 0x112f36, width: 3 } } }); label.anchor.set(0.5); label.y = -110; container.addChild(label);
            world.addChild(container); info = { container, sprite, label }; npcSprites.set(npc.id, info);
          }
          info.container.position.set(npc.x, npc.y); info.container.visible = !npc.isDead;
          const size = 100 / info.sprite.texture.height; info.sprite.scale.set(npc.direction === 'right' ? -size : size, size);
        }
      });
      // Pixi renders at LOW priority. Acknowledge only after that rendered frame.
      app.ticker.add(() => callbacks.current.onFrame?.(), undefined, UPDATE_PRIORITY.LOW - 1);
    }
    void start().catch(() => { if (!cancelled) { setError(true); callbacks.current.onFailure?.(); if (appRef.current) { appRef.current.destroy(true, { children: true }); appRef.current = null; } } });
    return () => { cancelled = true; if (appRef.current === ownedApp) { ownedApp?.destroy(true, { children: true }); appRef.current = null; } worldRef.current = null; groundTexture?.destroy(true); };
  }, []);
  useEffect(() => {
    appRef.current?.renderer.resize(viewport.width, viewport.height);
    worldRef.current?.scale.set(pixiWorldScale(viewport.width, viewport.height));
  }, [viewport.width, viewport.height]);
  return <div ref={holder} className="absolute inset-0" data-world-renderer="2d">
    {error && <div role="alert" className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-slate-950 p-6 text-white">
      <p>This browser cannot start the 2D world. The BrainChain Office page remains available.</p>
      <a href="/brainchain?view=2d" className="min-h-12 rounded border p-3">Open BrainChain Office</a>
      <button className="min-h-12 rounded border p-3" onClick={() => reloadWorldRenderer('3d')}>Try 3D view</button>
    </div>}
  </div>;
}
