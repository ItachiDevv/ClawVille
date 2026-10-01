'use client';

/**
 * trading-floor-decor.tsx
 *
 * The Trading Floor's runtime decor ("The Claw Exchange", 2026-10-01): a trader
 * rig of six monitors on every desk, six big wall screens, an NYSE-style LED
 * ticker ribbon around three walls, and soft glow pools. Purely visual: no
 * collider, no hotspot, no API, no new poll.
 *
 * THREE MESHES, THREE DRAW CALLS, all stock `MeshBasicMaterial`:
 *   1. TradingFloorDecorMonitors: banks, brass mounts and wall screens, one
 *      1024 x 1024 atlas drawn once. The charts move by sliding U windows
 *      across periodic bands (`trading-floor-decor-layout.ts`), so the motion
 *      costs a small uv range upload per frame and never a texture upload.
 *   2. TradingFloorDecorRibbon: one 4096 x 64 LED strip, crawled by UV. The
 *      strip is redrawn and re-uploaded only when its text changes. Its shape
 *      is a recorded deviation from the brief's 1024 x 1024 cap, accepted by
 *      the lead (reason in the `trading-floor-decor-art.ts` header).
 *   3. TradingFloorDecorGlow: one 128 x 128 sprite, additive, tinted per pool.
 *
 * The ribbon reads the arena tape through `useFloorArenaTape(ARENA_TAPE_LIMIT,
 * active)`, the SAME react-query key the big board and the 3D trade tape use,
 * so it adds no fetch and no interval.
 *
 * Iris Xe invariants: no drei `<Text>` / `<Billboard>`, no `InstancedMesh`, no
 * `ShaderMaterial`, no light, no shadow, and no allocation in a frame callback
 * (`trading-floor-decor.test.ts` reads this file to pin that).
 */

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';

import { useFloorArenaTape } from '@/hooks/use-floor-arena';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import {
  DECOR_ATLAS_SIZE,
  DECOR_MAX_FRAME_DELTA,
  DECOR_UV_FLOATS_PER_QUAD,
  GLOW_SPRITE_SIZE,
  RIBBON_CANVAS_HEIGHT,
  RIBBON_CANVAS_WIDTH,
  advanceDecorScroll,
  advanceRibbonOffset,
  buildGlowDecor,
  buildMonitorDecor,
  buildRibbonDecor,
  writeDecorScrollUvs,
  writeRibbonUvs,
  type DecorMeshData,
} from './trading-floor-decor-layout';
import {
  buildRibbonSegments,
  drawDecorAtlas,
  drawGlowSprite,
  drawRibbonStrip,
  ribbonSignature,
} from './trading-floor-decor-art';
import { ARENA_TAPE_LIMIT } from './trading-floor-trade-tape';

/** Pure layout, built once per module load; each mount copies what it mutates. */
const MONITOR_DECOR = buildMonitorDecor();
const RIBBON_DECOR = buildRibbonDecor();
const GLOW_DECOR = buildGlowDecor();
/** What the ribbon says before any tape: painted at creation and uploaded in
 *  the warm gate. */
const BRAND_ONLY_SEGMENTS = buildRibbonSegments({ data: undefined, isError: false });
const BRAND_ONLY_SIGNATURE = ribbonSignature(BRAND_ONLY_SEGMENTS);

/**
 * Anisotropic filtering for the two surfaces seen at a glancing angle (the
 * desk banks from the aisle, the ribbon along the walls). Both samplers are
 * all-linear, which WebGPU requires before it will honour anisotropy.
 */
const DECOR_ANISOTROPY = 4;

/** Scenery, never a hotspot: keeps all three meshes out of R3F's raycast. */
function skipRaycast(): void {}

interface CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
}

function createSurface(width: number, height: number, alpha: boolean): CanvasSurface | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha });
  if (!context) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, context, texture };
}

/**
 * Mipmapped, because unlike the big board these surfaces are minified 2-4x
 * from the aisle AND moving: without mips a scrolling chart or a crawling
 * letter shimmers. The board stays single-level because its ~5 px capitals sit
 * at the stroke-dropping limit, where mips only move the damage (memory
 * `canvas-texture-text-needs-mipmaps-and-bold-at-distance`). The ribbon's
 * capitals are ~10 screen px from the spawn's farthest wall run (see
 * `RIBBON_FONT`), about twice that limit. RepeatWrapping on S is what lets a U
 * window run past 1 into the start of its periodic band.
 */
function configureScrollingTexture(texture: THREE.CanvasTexture): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = DECOR_ANISOTROPY;
}

/**
 * One `BufferGeometry` from a layout. Positions are world space and STATIC, so
 * the bounding sphere is computed once and stays right; only UVs move.
 */
function createGeometry(data: DecorMeshData, dynamicUvs: boolean): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.positions), 3));
  const uvs = new THREE.BufferAttribute(new Float32Array(data.uvs), 2);
  if (dynamicUvs) uvs.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('uv', uvs);
  if (data.colors) geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.colors), 4));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(data.indices), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Upload a texture at MOUNT, inside the stage's warm gate, instead of on the
 * first frame that draws it.
 *
 * The decor mounts with the room: its effects run in the same commit as
 * RoomShell's `onReady`, and the stage only starts its warm (compileAsync,
 * direct render, then `ackReady` and the fade-in) after that commit. So an
 * `initTexture` here lands before the room is revealed whatever the warm path
 * does. Measured before this hook (r2, RTX 3080): every decor upload already
 * fell inside `warming`, but only because the warm render happened to draw
 * the decor. This makes it a property of the decor, not of the warm.
 *
 * `initTexture` THROWS when the backend is not initialised yet. The stage
 * renderer is initialised long before an interior mounts, so that is not
 * expected; if it ever happens, the warm render uploads the texture as before,
 * so the fallback is the old behaviour, not a missing texture.
 */
function useWarmUpload(texture: THREE.Texture | null): void {
  const gl = useThree((state) => state.gl) as unknown as {
    initTexture?: (texture: THREE.Texture) => void;
  };
  useEffect(() => {
    if (!texture || typeof gl.initTexture !== 'function') return;
    try {
      gl.initTexture(texture);
    } catch (error) {
      console.warn('[TradingFloorDecor] initTexture deferred to the warm render:', error);
    }
  }, [gl, texture]);
}

/** Freeze the identity matrix and drop out of raycasting. After mount, never as
 *  a JSX prop (memory gotchas/r3f-matrixautoupdate-false-strips-position-prop). */
function useStaticScenery(meshRef: { readonly current: THREE.Mesh | null }): void {
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.raycast = skipRaycast;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
  }, [meshRef]);
}

// ---------------------------------------------------------------------------
// 1. Monitors
// ---------------------------------------------------------------------------

function TradingFloorDecorMonitors({ active }: { active: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const surface = useMemo(() => {
    const next = createSurface(DECOR_ATLAS_SIZE, DECOR_ATLAS_SIZE, false);
    if (!next) return null;
    // Drawn ONCE. Nothing in this file ever sets `needsUpdate` on it again.
    drawDecorAtlas(next.context);
    configureScrollingTexture(next.texture);
    next.texture.needsUpdate = true;
    return next;
  }, []);
  const geometry = useMemo(() => createGeometry(MONITOR_DECOR.mesh, true), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: surface?.texture ?? null,
        // Emissive displays and their bezels: the room's grading and fog are
        // for lit surfaces, and fog washed the far-wall board out the same way.
        toneMapped: false,
        fog: false,
      }),
    [surface],
  );
  /**
   * Frame state, all allocated here. `offsets` is mutated in place; `range` is
   * the ONE update range the frame loop hands three: it covers only the
   * scrolling quads, which the layout emits first.
   */
  const frame = useMemo(() => {
    const uvAttribute = geometry.getAttribute('uv') as THREE.BufferAttribute;
    return {
      uvAttribute,
      uvArray: uvAttribute.array as Float32Array,
      offsets: new Float32Array(MONITOR_DECOR.scroll.phases),
      range: { start: 0, count: MONITOR_DECOR.scroll.count * DECOR_UV_FLOATS_PER_QUAD },
    };
  }, [geometry]);

  useStaticScenery(meshRef);
  useWarmUpload(surface?.texture ?? null);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      surface?.texture.dispose();
    },
    [geometry, material, surface],
  );

  useSceneFrame((_, rawDelta) => {
    if (!active) return;
    const delta = rawDelta < DECOR_MAX_FRAME_DELTA ? rawDelta : DECOR_MAX_FRAME_DELTA;
    const scroll = MONITOR_DECOR.scroll;
    advanceDecorScroll(frame.offsets, scroll.speeds, scroll.count, delta);
    writeDecorScrollUvs(frame.uvArray, scroll.widths, frame.offsets, scroll.count);
    // `addUpdateRange` would push a fresh object every frame. The range is
    // preallocated and pushed only when the renderer has consumed the last one
    // (both backends clear the list after uploading), so a culled frame cannot
    // grow it.
    const ranges = frame.uvAttribute.updateRanges;
    if (ranges.length === 0) ranges.push(frame.range);
    frame.uvAttribute.needsUpdate = true;
  });

  if (!surface) return null;
  return <mesh ref={meshRef} name="TradingFloorDecorMonitors" geometry={geometry} material={material} />;
}

// ---------------------------------------------------------------------------
// 2. Ticker ribbon
// ---------------------------------------------------------------------------

function TradingFloorDecorRibbon({ active }: { active: boolean }) {
  // The board's and the 3D tape's own key: react-query dedupes, no new poll.
  const tape = useFloorArenaTape(ARENA_TAPE_LIMIT, active);
  const meshRef = useRef<THREE.Mesh>(null);
  const offsetRef = useRef(0);

  // The brand-only strip is painted at CREATION, so the warm upload below
  // always carries a finished strip; a tape that arrives later is the only
  // upload left for after the reveal.
  const surface = useMemo(() => {
    const next = createSurface(RIBBON_CANVAS_WIDTH, RIBBON_CANVAS_HEIGHT, false);
    if (!next) return null;
    configureScrollingTexture(next.texture);
    drawRibbonStrip(next.context, BRAND_ONLY_SEGMENTS);
    next.texture.needsUpdate = true;
    return next;
  }, []);
  const drawnSignatureRef = useRef(BRAND_ONLY_SIGNATURE);
  const geometry = useMemo(() => createGeometry(RIBBON_DECOR.mesh, true), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: surface?.texture ?? null,
        toneMapped: false,
        fog: false,
      }),
    [surface],
  );
  // The crawling faces are the layout's FIRST quads; the underside quads after
  // them never change, so the range stops at the faces.
  const frame = useMemo(() => {
    const uvAttribute = geometry.getAttribute('uv') as THREE.BufferAttribute;
    return {
      uvAttribute,
      uvArray: uvAttribute.array as Float32Array,
      range: { start: 0, count: RIBBON_DECOR.segments.length * DECOR_UV_FLOATS_PER_QUAD },
    };
  }, [geometry]);

  const segments = buildRibbonSegments({ data: tape.data, isError: tape.isError });
  const signature = ribbonSignature(segments);

  // The ONLY strip repaint site, keyed on what the strip says. It skips the
  // text already on the canvas, so mounting with no tape costs no second
  // upload of the strip the memo just painted.
  useEffect(() => {
    if (!surface || signature === drawnSignatureRef.current) return;
    drawRibbonStrip(surface.context, segments);
    drawnSignatureRef.current = signature;
    surface.texture.needsUpdate = true;
    // `segments` is rebuilt every render; `signature` is its drawable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, signature]);

  // AFTER the repaint effect on purpose: effects run in order, so a tape that
  // is already cached at mount is painted first and uploaded once.
  useWarmUpload(surface?.texture ?? null);
  useStaticScenery(meshRef);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      surface?.texture.dispose();
    },
    [geometry, material, surface],
  );

  useSceneFrame((_, rawDelta) => {
    if (!active) return;
    const delta = rawDelta < DECOR_MAX_FRAME_DELTA ? rawDelta : DECOR_MAX_FRAME_DELTA;
    offsetRef.current = advanceRibbonOffset(offsetRef.current, delta);
    writeRibbonUvs(frame.uvArray, RIBBON_DECOR.pathStarts, RIBBON_DECOR.lengths, offsetRef.current);
    // Same preallocated-range rule as the monitors.
    const ranges = frame.uvAttribute.updateRanges;
    if (ranges.length === 0) ranges.push(frame.range);
    frame.uvAttribute.needsUpdate = true;
  });

  if (!surface) return null;
  return <mesh ref={meshRef} name="TradingFloorDecorRibbon" geometry={geometry} material={material} />;
}

// ---------------------------------------------------------------------------
// 3. Glow pools
// ---------------------------------------------------------------------------

function TradingFloorDecorGlow() {
  const meshRef = useRef<THREE.Mesh>(null);
  const surface = useMemo(() => {
    const next = createSurface(GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE, true);
    if (!next) return null;
    drawGlowSprite(next.context);
    next.texture.magFilter = THREE.LinearFilter;
    next.texture.minFilter = THREE.LinearFilter;
    next.texture.generateMipmaps = false;
    next.texture.needsUpdate = true;
    return next;
  }, []);
  const geometry = useMemo(() => createGeometry(GLOW_DECOR, false), []);
  useWarmUpload(surface?.texture ?? null);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: surface?.texture ?? null,
        vertexColors: true,
        transparent: true,
        // Light, not paint: additive cannot darken anything, and with depth
        // writes off two pools never cut holes in each other.
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    [surface],
  );

  useStaticScenery(meshRef);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      surface?.texture.dispose();
    },
    [geometry, material, surface],
  );

  if (!surface) return null;
  // renderOrder -1: transparents sort by renderOrder, THEN by bounding-sphere
  // depth. The glow's sphere centre and the trade tape's are both near the room
  // middle, so by depth alone the order flips as the camera moves, and a glow
  // drawn after a chip adds onto the chip's text (the chips write no depth).
  // Always first: every chip then paints over the light behind it.
  return (
    <mesh
      ref={meshRef}
      name="TradingFloorDecorGlow"
      geometry={geometry}
      material={material}
      renderOrder={-1}
    />
  );
}

export function TradingFloorDecor({ active }: { active: boolean }) {
  return (
    <>
      <TradingFloorDecorMonitors active={active} />
      <TradingFloorDecorRibbon active={active} />
      <TradingFloorDecorGlow />
    </>
  );
}
