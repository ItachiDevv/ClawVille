// @ts-nocheck
/**
 * build-buildings-atlas — pack N building diffuse textures into one shared
 * texture_2d atlas + remap each building's vertex UVs to its slot region.
 *
 * Used by BOTH the /game integration (use-merged-buildings-asset hook) AND
 * the /preview/meshlet-spike-all-12 standalone preview so that:
 *   1. Atlas behaviour stays in one place — fixing slot padding, mipmap
 *      bleeding, or sRGB handling fixes both call sites at once.
 *   2. The spike preview reflects production rendering exactly. Without this
 *      shared util the spike showed hashColor pastels while /game showed
 *      atlas textures — diverged tests are worse than no tests.
 *
 * Why an atlas over THREE.DataArrayTexture:
 *   r182 has an unfixed codegen bug in WGSLNodeBuilder.js's
 *   generateTextureGrad / generateTextureLevel — they accept a depthSnippet
 *   (array_index) param but never emit it, so any sampler chain that combines
 *   .depth(layer) with .grad(dx,dy) fails to compile for texture_2d_array.
 *   See nanite-rasterizer.ts MergedMeshletAsset.atlasTexture doc for details.
 *
 * Approach:
 *   - 4×3 grid of 1024px slots = 4096×3072 atlas (12 slots, supports up to
 *     12 buildings; ClawVille has 11 today). Well under the 8192 adapter cap.
 *   - 2px clamping padding inside each slot to prevent bilinear / mipmap
 *     fetches from reaching across slot boundaries (visible at distance as
 *     "leakage" of neighbour-slot colour). Inner draws + edge-replication
 *     copies into the gutter cover this.
 *   - Per-building UV remap: each vertex's UV [0,1]^2 → that slot's
 *     [u0+0.5/W..u0+(inner-0.5)/W, v0+0.5/H..v0+(inner-0.5)/H] range.
 *     fract() applied first so buildings whose textures tile (UVs > 1)
 *     collapse into a single slot copy instead of bleeding across slots.
 *   - Buildings whose largest-mesh diffuse can't be drawn to canvas (KTX2,
 *     CORS) get a solid-color slot fill using their fallbackColor — keeps
 *     atlas slots non-magenta so missing textures look intentional.
 */
'use client';

import * as THREE from 'three/webgpu';

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 3;
export const ATLAS_SLOT_SIZE = 1024;
export const ATLAS_SLOT_PAD = 2;
export const ATLAS_WIDTH = ATLAS_COLS * ATLAS_SLOT_SIZE;   // 4096
export const ATLAS_HEIGHT = ATLAS_ROWS * ATLAS_SLOT_SIZE;  // 3072
export const ATLAS_MAX_SLOTS = ATLAS_COLS * ATLAS_ROWS;    // 12

export interface AtlasBuildingInput {
  /** Original GLB scene root — searched for the largest-mesh diffuse texture. */
  scene: THREE.Object3D;
  /** Merged geometry whose UV attribute will be remapped in-place into the slot. */
  geometry: THREE.BufferGeometry;
  /** Fallback flat colour [0..1] when no drawable diffuse can be sampled. */
  fallbackColor: [number, number, number];
  /** Identifier used only for logging. */
  id: string;
}

export interface AtlasBuildResult {
  /** The shared THREE.Texture (canvas-backed) ready to attach to merged asset. */
  texture: THREE.Texture;
  /** Per-input report — useful for debug overlays. */
  perInput: Array<{ id: string; slotCol: number; slotRow: number; drawn: boolean }>;
  /** Count of slots that got a real drawn texture vs solid-colour fallback. */
  texturedSlots: number;
  solidSlots: number;
}

/**
 * Walk a GLTF scene and return the diffuse texture of the LARGEST mesh (by
 * vertex count). Largest mesh is usually the building's main body, whose
 * texture best represents the building when the atlas packs only one
 * diffuse per slot. krusty-krab has ~20 sub-meshes with distinct textures
 * — picking the dominant one is the standard atlas compromise.
 */
function pickLargestMeshDiffuse(root: THREE.Object3D): THREE.Texture | null {
  let bestTex: THREE.Texture | null = null;
  let bestVerts = -1;
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const posAttr = mesh.geometry?.attributes?.['position'] as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const verts = posAttr.count;
    if (verts <= bestVerts) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!mat) return;
    const map = (mat as any).map as THREE.Texture | undefined;
    if (!map) return;
    bestTex = map;
    bestVerts = verts;
  });
  return bestTex;
}

/**
 * Build the shared atlas + remap each input's UVs into its slot.
 *
 * Mutates inputs[].geometry's UV attribute in-place. Returns a fully-configured
 * THREE.Texture (sRGB color space, mipmaps enabled, clamp wrap, anisotropy 4)
 * ready to attach to the merged asset's `atlasTexture` field.
 */
export function buildBuildingsAtlas(inputs: AtlasBuildingInput[]): AtlasBuildResult {
  if (inputs.length > ATLAS_MAX_SLOTS) {
    throw new Error(
      `buildBuildingsAtlas: ${inputs.length} inputs exceeds atlas capacity ${ATLAS_MAX_SLOTS}. ` +
      `Bump ATLAS_COLS/ATLAS_ROWS or migrate to a larger atlas / DataArrayTexture once r182 TSL bug is fixed.`,
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = ATLAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildBuildingsAtlas: 2D canvas context unavailable');

  // Magenta default fills unused slots + flags any draw-failure visually.
  ctx.fillStyle = 'rgb(255,0,255)';
  ctx.fillRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);

  const perInput: AtlasBuildResult['perInput'] = [];
  let texturedSlots = 0;
  let solidSlots = 0;

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const slotCol = i % ATLAS_COLS;
    const slotRow = Math.floor(i / ATLAS_COLS);
    const slotX = slotCol * ATLAS_SLOT_SIZE;
    const slotY = slotRow * ATLAS_SLOT_SIZE;
    const innerSize = ATLAS_SLOT_SIZE - ATLAS_SLOT_PAD * 2;
    const innerX = slotX + ATLAS_SLOT_PAD;
    const innerY = slotY + ATLAS_SLOT_PAD;

    const dominant = pickLargestMeshDiffuse(inp.scene);
    let drawn = false;
    if (dominant) {
      const img = (dominant as any).image as
        | HTMLImageElement
        | ImageBitmap
        | HTMLCanvasElement
        | undefined;
      if (img && (img as any).width && (img as any).height) {
        try {
          ctx.drawImage(img as any, innerX, innerY, innerSize, innerSize);
          drawn = true;
          texturedSlots++;
        } catch {
          // drawImage throws on KTX2 / CORS — fall through to solid.
        }
      }
    }
    if (!drawn) {
      solidSlots++;
      const [r, g, b] = inp.fallbackColor;
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fillRect(innerX, innerY, innerSize, innerSize);
    }

    // Replicate inner top/bottom edges into the 2px padding band so sampling
    // at the slot boundary returns slot pixels, not magenta gutter. Note:
    // this is intentionally TOP/BOTTOM only because horizontal padding for
    // texture-edge wrap would need a Y-axis copy pass — the dominant
    // mip-leak failure mode in screen-space is vertical (buildings stand
    // upright; top/bottom of the texture spans the largest screen extent).
    ctx.drawImage(
      canvas,
      innerX, innerY, innerSize, 1,
      slotX, slotY, ATLAS_SLOT_SIZE, ATLAS_SLOT_PAD,
    );
    ctx.drawImage(
      canvas,
      innerX, innerY + innerSize - 1, innerSize, 1,
      slotX, slotY + ATLAS_SLOT_SIZE - ATLAS_SLOT_PAD, ATLAS_SLOT_SIZE, ATLAS_SLOT_PAD,
    );

    // Remap vertex UVs in-place to this slot's inner region.
    const uvAttr = inp.geometry.attributes['uv'] as THREE.BufferAttribute | undefined;
    if (uvAttr) {
      const uvSlotU0 = (innerX + 0.5) / ATLAS_WIDTH;
      const uvSlotV0 = (innerY + 0.5) / ATLAS_HEIGHT;
      const uvSlotW = (innerSize - 1) / ATLAS_WIDTH;
      const uvSlotH = (innerSize - 1) / ATLAS_HEIGHT;
      for (let v = 0; v < uvAttr.count; v++) {
        const ou = uvAttr.getX(v);
        const ov = uvAttr.getY(v);
        const wu = ((ou % 1) + 1) % 1;
        const wv = ((ov % 1) + 1) % 1;
        uvAttr.setXY(v, uvSlotU0 + wu * uvSlotW, uvSlotV0 + wv * uvSlotH);
      }
      uvAttr.needsUpdate = true;
    }

    perInput.push({ id: inp.id, slotCol, slotRow, drawn });
  }

  const texture = new THREE.Texture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace; // PNG/JPG diffuses are sRGB
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return { texture, perInput, texturedSlots, solidSlots };
}
