'use client';

/**
 * trading-floor-screen.tsx
 *
 * The BIG BOARD on the Trading Floor's back wall — ONE plane, ONE draw call.
 *
 * Founder order 2026-09-19: "a big screen in the middle on the back wall that
 * shows a bunch of charts". Since 2026-10-02 (P15 T2) it shows the FIVE HOUSE
 * AGENTS, one column each (founder 2026-10-01: "all trading on the big screen
 * in the back of the room"). Players stay on the 3D tape, the LED ticker and
 * the Exchange panel.
 *
 * Data is two queries: the T1 house board (`use-floor-arena-house-board.ts`,
 * 15 s poll, no background refetch) and the existing contest query (60 s),
 * which is only the fallback contest window. The contest key is the one the
 * Exchange panel uses. The board no longer reads the leaderboard or the tape;
 * the 3D tape and the LED ticker keep their own tape query.
 * react-query context does reach inside the R3F canvas here —
 * `lib/three/land-state-hydrator.tsx` and `lib/three/cosmetic-loader.tsx`
 * already depend on that.
 *
 * REDRAW BUDGET — the load-bearing constraint. The canvas is redrawn ONLY when
 * something the board draws changes (`floorScreenSignature`, which ignores
 * `generatedAt` and every event time) or on a 30 s wall-clock tick that moves
 * the clock, the countdown and the P&L window. `texture.needsUpdate` is set in
 * that same place and nowhere else. There is deliberately no per-frame
 * callback in this file: a per-frame canvas redraw plus a
 * per-frame texture upload of the whole `FLOOR_SCREEN_CANVAS` RGBA buffer is
 * ~1.3 MB/frame over PCIe at the current size, four times that on the 2x
 * backing store a high-DPR display gets, which is exactly the class of cost
 * the Iris Xe floor cannot absorb. The magnitude is the point; the exact
 * figure moves with the board and is not repeated here. At the shipped cadence
 * it is one upload per data change (at most one per poll) plus one per 30 s
 * clock tick.
 *
 * Iris Xe invariants: no drei <Text>, no shadow, no InstancedMesh+ShaderMaterial,
 * no per-frame allocation. `MeshBasicMaterial` is unlit on purpose — the board
 * is an emissive display, and lighting it would make its legibility depend on
 * the room's rig.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';

import { useFloorArenaContest, useFloorArenaLeaderboard } from '@/hooks/use-floor-arena';
import { useFloorArenaHouseBoard } from '@/hooks/use-floor-arena-house-board';
import { TRADING_FLOOR_SCREEN } from './trading-floor-room';
import {
  buildFloorScreenData,
  floorScreenPage,
  floorScreenSignature,
} from './trading-floor-screen-data';
import {
  drawFloorScreen,
  FLOOR_SCREEN_CANVAS,
  FLOOR_SCREEN_PAGE_MS,
  pickCanvasScale,
} from './trading-floor-screen-texture';

/** Fire just after each page boundary, so the page read then is the new one. */
const PAGE_TICK_SLACK_MS = 20;

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
  // NO MIPMAPS — tried on 2026-09-30 and REVERTED the same night on real-GPU
  // evidence. From the spawn the plane shows about 0.52 screen px per canvas px
  // (1366 x 768), so a 15-16 px Courier capital is about 5 screen px tall:
  // an "E" needs five distinct rows there, and ANY 1.8:1 resample loses or
  // merges one of its bars depending on sub-pixel phase. Mips only moved the
  // damage. Without them, regular-weight cells broke ("GENZSIS", verifier B
  // b-02); with trilinear mips, bold cells that had read correctly broke
  // instead ("LANDTKST1", "NO PRIZR", local prod bundle c-10b vs staging
  // c-00b). The real-GPU shot of BOLD text WITHOUT mips (c-00b: every bold
  // cell correct at the spawn) is the best evidence we have, so the board is
  // bold everywhere and single-level. The durable fix was larger glyphs, a
  // layout change and not a filter: P15 T2 raised the floor to 22 px
  // (`BOARD_MIN_PX`, about 6.5 screen px a capital, projected, not measured).
  texture.generateMipmaps = false;
  return { canvas, context, texture };
}

export function TradingFloorScreen({ active }: { active: boolean }) {
  const houseBoard = useFloorArenaHouseBoard(active);
  const contest = useFloorArenaContest(active);
  // Page B (founder order 2026-10-02): the contest leaderboard, the same query
  // key the Exchange panel uses, as the pre-P15 board read it.
  const leaderboard = useFloorArenaLeaderboard('contest', active);
  const [pageTick, setPageTick] = useState(0);
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

  // Read on every render; the three query results are all the board needs.
  // The page comes from the clock, not from React state: the timer below only
  // re-renders at each page boundary, and the page is in the signature.
  const inputs = { houseBoard, contest, leaderboard };
  const page = floorScreenPage(Date.now());
  const signature = floorScreenSignature(inputs, page);

  // The ONLY redraw site. Runs on a data change of the shown page, on a page
  // change, and on every page tick (which also moves the clock and countdown).
  useEffect(() => {
    if (!surface) return;
    drawFloorScreen(surface.context, buildFloorScreenData(inputs, Date.now(), page));
    surface.texture.needsUpdate = true;
    // `inputs` is intentionally absent from the dep list: `signature` is its
    // drawable projection, and depending on the query objects' identity would
    // redraw on every refetch that changed nothing the board shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, signature, pageTick]);

  // One timer, aligned to the 15 s page boundaries: a page change every tick
  // (one redraw and one texture upload per 15 s), and the clock and countdown
  // move with it. No frame callback.
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    let handle = 0;
    const schedule = () => {
      const wait = FLOOR_SCREEN_PAGE_MS - (Date.now() % FLOOR_SCREEN_PAGE_MS) + PAGE_TICK_SLACK_MS;
      handle = window.setTimeout(() => {
        setPageTick((value) => value + 1);
        schedule();
      }, wait);
    };
    schedule();
    return () => window.clearTimeout(handle);
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
