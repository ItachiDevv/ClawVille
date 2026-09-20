'use client';

/**
 * trading-floor-screen.tsx
 *
 * The BIG BOARD on the Trading Floor's back wall — ONE plane, ONE draw call.
 *
 * Founder order 2026-09-19: "a big screen in the middle on the back wall that
 * shows a bunch of charts ... maybe the screen shows the trading agents that we
 * have and their statuses."
 *
 * Data is the SAME `GET /api/floor/house-traders` query the Exchange panel's
 * "Watch the house traders" section uses (`useHouseTraders`), through the SAME
 * react-query key, so the board and the panel can never disagree and the board
 * adds no second poller: react-query dedupes by key and the 15 s `staleTime`
 * matches the route's own cache. react-query context does reach inside the R3F
 * canvas here — `lib/three/land-state-hydrator.tsx` and
 * `lib/three/cosmetic-loader.tsx` already depend on that.
 *
 * REDRAW BUDGET — the load-bearing constraint. The canvas is redrawn ONLY when
 * the query result changes (`floorScreenSignature`) or on a 30 s wall-clock
 * tick that refreshes the "LAST 4m ago" labels. `texture.needsUpdate` is set in
 * that same place and nowhere else. There is deliberately no `useFrame` in this
 * file: a per-frame canvas redraw plus a per-frame texture upload of the whole
 * `FLOOR_SCREEN_CANVAS` RGBA buffer is ~1.3 MB/frame over PCIe at the current
 * size, four times that on the 2x backing store a high-DPR display gets, which
 * is exactly the class of cost the Iris Xe floor cannot absorb. The magnitude
 * is the point; the exact figure moves with the board and is not repeated here. At the shipped cadence it is one upload per data
 * change, 15 s apart at the very most, plus one per 30 s clock tick.
 *
 * Iris Xe invariants: no drei <Text>, no shadow, no InstancedMesh+ShaderMaterial,
 * no per-frame allocation. `MeshBasicMaterial` is unlit on purpose — the board
 * is an emissive display, and lighting it would make its legibility depend on
 * the room's rig.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';

import { useHouseTraders } from '@/hooks/use-trading-floor';
import { TRADING_FLOOR_SCREEN } from './trading-floor-room';
import {
  buildFloorScreenData,
  floorScreenSignature,
} from './trading-floor-screen-data';
import {
  drawFloorScreen,
  FLOOR_SCREEN_CANVAS,
  pickCanvasScale,
} from './trading-floor-screen-texture';

/** Wall-clock redraw cadence, only to age the "LAST …" labels. */
const AGE_TICK_MS = 30_000;

interface ScreenSurface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
}

function createSurface(): ScreenSurface | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  // The backing store may be 2x on a high-DPR display; the drawing code always
  // works in the LOGICAL `FLOOR_SCREEN_CANVAS` space and never learns which it
  // got. Named, not spelled out: this sentence said "1024 x 392" through two
  // resizes it never matched, because deriving the CONSTANT fixed the values
  // and left the prose describing them untouched. The
  // transform is set once here rather than per redraw: `drawFloorScreen` never
  // touches the transform, so it survives every redraw.
  const scale = pickCanvasScale(
    typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  );
  canvas.width = FLOOR_SCREEN_CANVAS.width * scale;
  canvas.height = FLOOR_SCREEN_CANVAS.height * scale;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  // No mipmaps: the board is only ever seen roughly head-on from inside one
  // room, so a mip chain is 33% more upload for no visible gain, and every
  // redraw would have to regenerate it.
  texture.generateMipmaps = false;
  return { canvas, context, texture };
}

export function TradingFloorScreen({ active }: { active: boolean }) {
  const query = useHouseTraders(active);
  const [ageTick, setAgeTick] = useState(0);
  const meshRef = useRef<THREE.Mesh>(null);

  const surface = useMemo(() => createSurface(), []);
  const geometry = useMemo(
    () =>
      new THREE.PlaneGeometry(
        TRADING_FLOOR_SCREEN.width,
        TRADING_FLOOR_SCREEN.height,
      ),
    [],
  );
  const material = useMemo(() => {
    const next = new THREE.MeshBasicMaterial({
      map: surface?.texture ?? null,
      // The board is a display. Tone mapping and fog both exist to place a
      // surface in the room's atmosphere, which is the opposite of what a lit
      // panel needs: with fog on, the far-wall distance washed the counts out.
      toneMapped: false,
      fog: false,
    });
    return next;
  }, [surface]);

  const signature = floorScreenSignature(query.data, {
    isLoading: query.isLoading,
    isError: query.isError,
  });

  // The ONLY redraw site. Runs on a data change and on the 30 s age tick.
  useEffect(() => {
    if (!surface) return;
    drawFloorScreen(
      surface.context,
      buildFloorScreenData(
        query.data,
        { isLoading: query.isLoading, isError: query.isError },
        Date.now(),
      ),
    );
    surface.texture.needsUpdate = true;
    // `query.data` is intentionally absent from the dep list: `signature` is
    // its drawable projection, and depending on the array identity would
    // redraw on every refetch that changed nothing the board shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, signature, ageTick]);

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const handle = window.setInterval(
      () => setAgeTick((value) => value + 1),
      AGE_TICK_MS,
    );
    return () => window.clearInterval(handle);
  }, [active]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      surface?.texture.dispose();
    },
    [geometry, material, surface],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // The board is scenery, not a hotspot: the kiosk in front of it is the E
    // target. A no-op raycast keeps it out of R3F's intersection list entirely
    // rather than relying on "it has no handlers".
    mesh.raycast = () => undefined;
    // Frozen AFTER mount, never as a JSX prop: `matrixAutoUpdate={false}` on a
    // <mesh> stops R3F flushing `position` into the matrix and the plane would
    // render at the origin (memory
    // gotchas/r3f-matrixautoupdate-false-strips-position-prop).
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
  }, []);

  if (!surface) return null;

  return (
    <mesh
      ref={meshRef}
      name="TradingFloorBigBoard"
      position={[0, TRADING_FLOOR_SCREEN.centerY, TRADING_FLOOR_SCREEN.z]}
      geometry={geometry}
      material={material}
    />
  );
}
