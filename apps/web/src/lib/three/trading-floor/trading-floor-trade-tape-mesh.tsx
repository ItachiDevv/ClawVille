'use client';

/**
 * trading-floor-trade-tape-mesh.tsx
 *
 * The house traders' trades as objects in the hall — ONE mesh, ONE draw call.
 *
 * The rules (which trade, which lane, which colour, where it is at time t, what
 * its face says) all live in the pure `trading-floor-trade-tape.ts` with an
 * injected clock and a unit test. This file is the thin three.js half: it owns
 * the atlas canvas, the geometry buffers and the frame loop, and nothing else.
 *
 * THE `-mesh` SUFFIX IS LOAD-BEARING, not decoration. A `trading-floor-trade-tape.tsx`
 * beside `trading-floor-trade-tape.ts` is a resolution ambiguity: bun resolved
 * `./trading-floor-trade-tape` to the COMPONENT and every pure export vanished
 * with a bare "Export not found". Two files may not share a basename here.
 *
 * WHY ONE MESH AND NOT AN `InstancedMesh`. Each chip needs its OWN patch of the
 * texture atlas, and a per-instance UV offset needs a shader. `InstancedMesh` +
 * `ShaderMaterial` is a silent WebGPU crash on the Iris Xe floor, so that road
 * is closed. The alternative is what is here: N quads in one `BufferGeometry`,
 * static per-quad UVs, and 4 world-space corners per chip written into a
 * dynamic position attribute each frame. At 12 chips that is 144 position
 * floats and 192 colour floats per frame — about 1.3 KB of upload, against the
 * ~1.0 MB a single atlas repaint costs, which is why the atlas is repainted
 * only when the DATA changes and never from the frame loop.
 *
 * Per-chip colour rides on an RGBA vertex-colour attribute, `itemSize: 4`. Four
 * and not three deliberately: three's `vertexColor()` node is declared `vec4`,
 * so a three-component buffer would disagree with the node graph's own type on
 * the WebGPU path.
 *
 * Iris Xe invariants: no drei `<Text>`, no `<Billboard>`, no `InstancedMesh` +
 * `ShaderMaterial`, no shadow, no per-frame allocation (module-scope scratch
 * only), and the whole feature is +1 draw call.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';

import { useHouseTraders } from '@/hooks/use-trading-floor';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import {
  buildTapeSources,
  createTapeChipTransform,
  drawTapeAtlas,
  reconcileTapeChips,
  tapeCellUv,
  writeTapeChipTransform,
  TAPE_ATLAS_HEIGHT,
  TAPE_ATLAS_WIDTH,
  TAPE_BOB,
  TAPE_CHIP_HEIGHT,
  TAPE_CHIP_WIDTH,
  TAPE_LANE_X,
  TAPE_MAX_CHIPS,
  TAPE_POP_RISE,
  TAPE_Y,
  TAPE_Z_END,
  TAPE_Z_START,
  type TapeChip,
} from './trading-floor-trade-tape';

const VERTS_PER_QUAD = 4;
const TOTAL_VERTS = TAPE_MAX_CHIPS * VERTS_PER_QUAD;

/** One scratch transform, reused for every chip on every frame. */
const _transform = createTapeChipTransform();

interface TapeSurface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
}

function createSurface(): TapeSurface | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = TAPE_ATLAS_WIDTH;
  canvas.height = TAPE_ATLAS_HEIGHT;
  // `alpha: false` — the chips are additive, so the cell background is BLACK
  // and black contributes nothing. An alpha channel here would buy nothing and
  // cost a quarter of the upload.
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  // No mipmaps: the atlas is redrawn on every data change and a mip chain would
  // be regenerated with it, for 33% more upload on a surface that is only ever
  // seen inside one room.
  texture.generateMipmaps = false;
  return { canvas, context, texture };
}

function createGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  const positions = new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS * 4), 4);
  colors.setUsage(THREE.DynamicDrawUsage);
  const uvs = new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS * 2), 2);
  uvs.setUsage(THREE.DynamicDrawUsage);

  const indices = new Uint16Array(TAPE_MAX_CHIPS * 6);
  for (let quad = 0; quad < TAPE_MAX_CHIPS; quad++) {
    const base = quad * VERTS_PER_QUAD;
    const offset = quad * 6;
    // 0 bottom-left, 1 bottom-right, 2 top-left, 3 top-right.
    indices[offset] = base;
    indices[offset + 1] = base + 1;
    indices[offset + 2] = base + 2;
    indices[offset + 3] = base + 2;
    indices[offset + 4] = base + 1;
    indices[offset + 5] = base + 3;
  }

  geometry.setAttribute('position', positions);
  geometry.setAttribute('color', colors);
  geometry.setAttribute('uv', uvs);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // A STATIC bounding sphere, set once. The vertices are world-space and move
  // every frame, so an auto-computed sphere would be stale the frame after it
  // was built and the mesh would cull itself while still on screen. three only
  // computes one when the field is null, so assigning it here is also what
  // stops it being recomputed. The radius covers the whole flight volume plus
  // the bob and the pop rise.
  const centerZ = (TAPE_Z_START + TAPE_Z_END) / 2;
  const reachX = TAPE_LANE_X + TAPE_CHIP_WIDTH / 2;
  const reachY = TAPE_CHIP_HEIGHT / 2 + TAPE_BOB + TAPE_POP_RISE;
  const reachZ = (TAPE_Z_END - TAPE_Z_START) / 2 + TAPE_CHIP_WIDTH / 2;
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, TAPE_Y, centerZ),
    Math.hypot(reachX, reachY, reachZ),
  );

  return geometry;
}

export function TradingFloorTradeTape({ active }: { active: boolean }) {
  // The SAME react-query key the board and the Exchange panel use. react-query
  // dedupes by key, so this adds no fetch, no interval and no route.
  const query = useHouseTraders(active);
  const meshRef = useRef<THREE.Mesh>(null);
  const chipsRef = useRef<TapeChip[]>([]);

  const surface = useMemo(() => createSurface(), []);
  const geometry = useMemo(() => createGeometry(), []);
  const material = useMemo(() => {
    return new THREE.MeshBasicMaterial({
      map: surface?.texture ?? null,
      vertexColors: true,
      transparent: true,
      // Additive is what makes these read as EMISSIVE slabs in a dark hall with
      // no extra light, no bloom pass and no second material — and it is also
      // the fade: a chip whose colour goes to black is gone. `depthWrite` off so
      // two chips overlapping in a lane do not punch holes in one another;
      // `depthTest` stays ON, so a desk or a wall still occludes them properly.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
  }, [surface]);

  /**
   * The chip list. Recomputed only when the query's data identity changes, and
   * `reconcileTapeChips` returns the previous array when nothing it draws has
   * moved — so a 15 s poll that changed nothing costs no atlas repaint and no
   * texture upload.
   *
   * The ref write is idempotent for a given `query.data`: reconciling an
   * already-reconciled list against the same sources returns it unchanged, so a
   * double invocation under StrictMode lands on the same result.
   */
  const chips = useMemo(() => {
    const sources = buildTapeSources(query.data);
    const next = reconcileTapeChips(chipsRef.current, sources, Date.now());
    chipsRef.current = next;
    return next;
  }, [query.data]);

  // The ONLY atlas repaint site, and the only place the UVs are written.
  useEffect(() => {
    if (!surface) return;
    drawTapeAtlas(surface.context, chips);
    surface.texture.needsUpdate = true;

    const uvs = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const array = uvs.array as Float32Array;
    for (let quad = 0; quad < TAPE_MAX_CHIPS; quad++) {
      const { u0, u1, vTop, vBottom } = tapeCellUv(quad);
      const offset = quad * VERTS_PER_QUAD * 2;
      array[offset] = u0;
      array[offset + 1] = vBottom;
      array[offset + 2] = u1;
      array[offset + 3] = vBottom;
      array[offset + 4] = u0;
      array[offset + 5] = vTop;
      array[offset + 6] = u1;
      array[offset + 7] = vTop;
    }
    uvs.needsUpdate = true;
  }, [surface, chips, geometry]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Scenery, never a hotspot. A no-op raycast keeps it out of R3F's
    // intersection list entirely rather than relying on "it has no handlers".
    mesh.raycast = () => undefined;
    // Vertices are already in world space, so the matrix is the identity and
    // freezing it saves a per-frame update. Frozen AFTER mount, never as a JSX
    // prop (memory gotchas/r3f-matrixautoupdate-false-strips-position-prop).
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      surface?.texture.dispose();
    },
    [geometry, material, surface],
  );

  useSceneFrame(() => {
    if (!active) return;
    const mesh = meshRef.current;
    if (!mesh) return;
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
    const positionArray = positions.array as Float32Array;
    const colorArray = colors.array as Float32Array;
    const list = chipsRef.current;
    const nowMs = Date.now();

    for (let quad = 0; quad < TAPE_MAX_CHIPS; quad++) {
      const base = quad * VERTS_PER_QUAD;
      const positionOffset = base * 3;
      const colorOffset = base * 4;
      const chip = quad < list.length ? list[quad] : undefined;

      if (!chip) {
        // Degenerate: all four corners on one point, so the two triangles have
        // zero area and never reach a fragment. Cheaper than a draw-range
        // change and it keeps every quad's index range fixed.
        for (let vertex = 0; vertex < VERTS_PER_QUAD; vertex++) {
          positionArray[positionOffset + vertex * 3] = 0;
          positionArray[positionOffset + vertex * 3 + 1] = TAPE_Y;
          positionArray[positionOffset + vertex * 3 + 2] = 0;
          colorArray[colorOffset + vertex * 4] = 0;
          colorArray[colorOffset + vertex * 4 + 1] = 0;
          colorArray[colorOffset + vertex * 4 + 2] = 0;
          colorArray[colorOffset + vertex * 4 + 3] = 0;
        }
        continue;
      }

      writeTapeChipTransform(chip, nowMs, _transform);
      const halfWidth = _transform.visible ? _transform.halfWidth : 0;
      const halfHeight = _transform.visible ? _transform.halfHeight : 0;
      const extentX = _transform.rightX * halfWidth;
      const extentZ = _transform.rightZ * halfWidth;
      const { x, y, z } = _transform;

      // 0 bottom-left, 1 bottom-right, 2 top-left, 3 top-right — the order the
      // index buffer and the UV writer both assume.
      positionArray[positionOffset] = x - extentX;
      positionArray[positionOffset + 1] = y - halfHeight;
      positionArray[positionOffset + 2] = z - extentZ;
      positionArray[positionOffset + 3] = x + extentX;
      positionArray[positionOffset + 4] = y - halfHeight;
      positionArray[positionOffset + 5] = z + extentZ;
      positionArray[positionOffset + 6] = x - extentX;
      positionArray[positionOffset + 7] = y + halfHeight;
      positionArray[positionOffset + 8] = z - extentZ;
      positionArray[positionOffset + 9] = x + extentX;
      positionArray[positionOffset + 10] = y + halfHeight;
      positionArray[positionOffset + 11] = z + extentZ;

      for (let vertex = 0; vertex < VERTS_PER_QUAD; vertex++) {
        colorArray[colorOffset + vertex * 4] = _transform.red;
        colorArray[colorOffset + vertex * 4 + 1] = _transform.green;
        colorArray[colorOffset + vertex * 4 + 2] = _transform.blue;
        colorArray[colorOffset + vertex * 4 + 3] = _transform.alpha;
      }
    }

    positions.needsUpdate = true;
    colors.needsUpdate = true;
  });

  if (!surface) return null;

  return (
    <mesh
      ref={meshRef}
      name="TradingFloorTradeTape"
      geometry={geometry}
      material={material}
    />
  );
}
