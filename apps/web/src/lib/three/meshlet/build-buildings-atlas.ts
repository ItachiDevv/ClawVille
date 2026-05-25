// @ts-nocheck
/**
 * build-buildings-atlas — pack per-sub-mesh diffuse textures into one shared
 * texture_2d atlas + remap each sub-mesh geometry's vertex UVs to its slot.
 *
 * Why an atlas over THREE.DataArrayTexture:
 *   r182 has an unfixed codegen bug in WGSLNodeBuilder.js's
 *   generateTextureGrad / generateTextureLevel. They accept a depthSnippet
 *   (array_index) param but never emit it, so sampler chains combining
 *   .depth(layer) with .grad(dx,dy) fail to compile for texture_2d_array.
 */
'use client';

import * as THREE from 'three/webgpu';

export const ATLAS_COLS = 8;
export const ATLAS_BASE_ROWS = 8;
export const ATLAS_EXTENDED_ROWS = 16;
export const ATLAS_SLOT_SIZE = 512;
export const ATLAS_SLOT_PAD = 2;
export const ATLAS_WIDTH = ATLAS_COLS * ATLAS_SLOT_SIZE; // 4096
export const ATLAS_BASE_HEIGHT = ATLAS_BASE_ROWS * ATLAS_SLOT_SIZE; // 4096
export const ATLAS_EXTENDED_HEIGHT = ATLAS_EXTENDED_ROWS * ATLAS_SLOT_SIZE; // 8192
export const ATLAS_BASE_MAX_SLOTS = ATLAS_COLS * ATLAS_BASE_ROWS; // 64
export const ATLAS_EXTENDED_MAX_SLOTS = ATLAS_COLS * ATLAS_EXTENDED_ROWS; // 128

export interface SubMeshInput {
  /** Stable diagnostic id, e.g. "mcp-tool-use/roof". */
  id: string;
  /** Geometry whose UV attribute will be remapped in-place into its atlas slot. */
  geometry: THREE.BufferGeometry;
  /** Drawable diffuse/albedo map from the GLB material. Dedupe is by image identity. */
  diffuse: THREE.Texture;
}

export interface SubMeshAtlasResult {
  texture: THREE.Texture;
  uniqueTextureCount: number;
  failedTextureCount: number;
  slotCount: number;
  cols: number;
  rows: number;
  slotSize: number;
  width: number;
  height: number;
  capacity: number;
  perSubMesh: Array<{
    id: string;
    slotIndex: number;
    slotCol: number;
    slotRow: number;
    drawn: boolean;
  }>;
}

interface AtlasSlot {
  index: number;
  diffuse: THREE.Texture;
  drawn: boolean;
}

function fract(v: number): number {
  return ((v % 1) + 1) % 1;
}

export function getDrawableTextureImage(tex: THREE.Texture | null | undefined):
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | ImageBitmap
  | null {
  if (!tex) return null;
  const img = ((tex as any).image ?? (tex as any).source?.data) as any;
  if (!img || !img.width || !img.height) return null;
  return img;
}

function textureDedupeKey(tex: THREE.Texture): object | string {
  const img = getDrawableTextureImage(tex) as any;
  const src = img?.currentSrc || img?.src || (tex as any).source?.data?.currentSrc || (tex as any).source?.data?.src;
  if (typeof src === 'string' && src.length > 0) return `src:${src}`;
  if (typeof tex.name === 'string' && tex.name.length > 0) return `name:${tex.name}`;
  return (img as object | null) ?? tex;
}

function replicatePadding(
  ctx: CanvasRenderingContext2D,
  slotX: number,
  slotY: number,
  innerX: number,
  innerY: number,
  innerSize: number,
) {
  const canvas = ctx.canvas as HTMLCanvasElement;
  ctx.drawImage(canvas, innerX, innerY, innerSize, 1, innerX, slotY, innerSize, ATLAS_SLOT_PAD);
  ctx.drawImage(canvas, innerX, innerY + innerSize - 1, innerSize, 1, innerX, innerY + innerSize, innerSize, ATLAS_SLOT_PAD);
  ctx.drawImage(canvas, innerX, innerY, 1, innerSize, slotX, innerY, ATLAS_SLOT_PAD, innerSize);
  ctx.drawImage(canvas, innerX + innerSize - 1, innerY, 1, innerSize, innerX + innerSize, innerY, ATLAS_SLOT_PAD, innerSize);
  ctx.drawImage(canvas, innerX, innerY, 1, 1, slotX, slotY, ATLAS_SLOT_PAD, ATLAS_SLOT_PAD);
  ctx.drawImage(canvas, innerX + innerSize - 1, innerY, 1, 1, innerX + innerSize, slotY, ATLAS_SLOT_PAD, ATLAS_SLOT_PAD);
  ctx.drawImage(canvas, innerX, innerY + innerSize - 1, 1, 1, slotX, innerY + innerSize, ATLAS_SLOT_PAD, ATLAS_SLOT_PAD);
  ctx.drawImage(canvas, innerX + innerSize - 1, innerY + innerSize - 1, 1, 1, innerX + innerSize, innerY + innerSize, ATLAS_SLOT_PAD, ATLAS_SLOT_PAD);
}

function remapGeometryUvs(input: SubMeshInput, slotIndex: number, width: number, height: number) {
  const uvAttr = input.geometry.attributes['uv'] as THREE.BufferAttribute | undefined;
  if (!uvAttr) return;

  const slotCol = slotIndex % ATLAS_COLS;
  const slotRow = Math.floor(slotIndex / ATLAS_COLS);
  const slotX = slotCol * ATLAS_SLOT_SIZE;
  const slotY = slotRow * ATLAS_SLOT_SIZE;
  const innerSize = ATLAS_SLOT_SIZE - ATLAS_SLOT_PAD * 2;
  const innerX = slotX + ATLAS_SLOT_PAD;
  const innerY = slotY + ATLAS_SLOT_PAD;
  const uvSlotU0 = (innerX + 0.5) / width;
  const uvSlotV0 = (innerY + 0.5) / height;
  const uvSlotW = (innerSize - 1) / width;
  const uvSlotH = (innerSize - 1) / height;

  const tex = input.diffuse;
  if (tex.matrixAutoUpdate) tex.updateMatrix();
  const uv = new THREE.Vector2();

  for (let v = 0; v < uvAttr.count; v++) {
    uv.set(uvAttr.getX(v), uvAttr.getY(v));
    if (tex.matrix) uv.applyMatrix3(tex.matrix);
    uvAttr.setXY(v, uvSlotU0 + fract(uv.x) * uvSlotW, uvSlotV0 + fract(uv.y) * uvSlotH);
  }
  uvAttr.needsUpdate = true;
}

/**
 * Build the shared atlas + remap each input's UVs into its assigned slot.
 *
 * Mutates inputs[].geometry's UV attribute in-place. Returns a configured
 * THREE.Texture ready to attach to `MergedMeshletAsset.atlasTexture`.
 */
export function buildSubMeshAtlas(inputs: SubMeshInput[]): SubMeshAtlasResult {
  const textureSlots = new Map<object | string, AtlasSlot>();
  const slots: AtlasSlot[] = [];

  const reserveSlot = (diffuse: THREE.Texture): AtlasSlot => {
    const slot: AtlasSlot = { index: slots.length, diffuse, drawn: false };
    slots.push(slot);
    return slot;
  };

  const inputSlots = inputs.map((input) => {
    const img = getDrawableTextureImage(input.diffuse);
    if (!img) {
      throw new Error(`buildSubMeshAtlas: ${input.id} missing drawable diffuse texture`);
    }

    const key = textureDedupeKey(input.diffuse);
    let slot = textureSlots.get(key);
    if (!slot) {
      slot = reserveSlot(input.diffuse);
      textureSlots.set(key, slot);
    }
    return slot;
  });

  const rows = slots.length > ATLAS_BASE_MAX_SLOTS ? ATLAS_EXTENDED_ROWS : ATLAS_BASE_ROWS;
  const height = rows === ATLAS_BASE_ROWS ? ATLAS_BASE_HEIGHT : ATLAS_EXTENDED_HEIGHT;
  const capacity = ATLAS_COLS * rows;

  if (slots.length > ATLAS_EXTENDED_MAX_SLOTS) {
    throw new Error(
      `buildSubMeshAtlas: ${slots.length} atlas slots exceeds capacity ${ATLAS_EXTENDED_MAX_SLOTS}. ` +
      'The meshlet shader uses one texture_2d atlas; add a second atlas or reduce unique materials.',
    );
  }
  if (slots.length > ATLAS_BASE_MAX_SLOTS) {
    console.warn(
      `[atlas] ${slots.length} slots exceeds 8x8 capacity; using ${ATLAS_COLS}x${ATLAS_EXTENDED_ROWS} ` +
      `${ATLAS_WIDTH}x${ATLAS_EXTENDED_HEIGHT} atlas`,
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildSubMeshAtlas: 2D canvas context unavailable');

  // Empty atlas pixels stay transparent black. Used sub-mesh slots are populated
  // only from real GLB diffuse images.
  ctx.clearRect(0, 0, ATLAS_WIDTH, height);

  let failedTextureCount = 0;
  for (const slot of slots) {
    const slotCol = slot.index % ATLAS_COLS;
    const slotRow = Math.floor(slot.index / ATLAS_COLS);
    const slotX = slotCol * ATLAS_SLOT_SIZE;
    const slotY = slotRow * ATLAS_SLOT_SIZE;
    const innerSize = ATLAS_SLOT_SIZE - ATLAS_SLOT_PAD * 2;
    const innerX = slotX + ATLAS_SLOT_PAD;
    const innerY = slotY + ATLAS_SLOT_PAD;

    const img = getDrawableTextureImage(slot.diffuse);
    if (img) {
      try {
        ctx.drawImage(img as any, innerX, innerY, innerSize, innerSize);
        slot.drawn = true;
      } catch {
        failedTextureCount++;
      }
    } else {
      failedTextureCount++;
    }

    if (!slot.drawn) {
      throw new Error(`buildSubMeshAtlas: texture slot ${slot.index} was not drawable`);
    }

    replicatePadding(ctx, slotX, slotY, innerX, innerY, innerSize);
  }

  const perSubMesh = inputs.map((input, idx) => {
    const slot = inputSlots[idx];
    remapGeometryUvs(input, slot.index, ATLAS_WIDTH, height);
    return {
      id: input.id,
      slotIndex: slot.index,
      slotCol: slot.index % ATLAS_COLS,
      slotRow: Math.floor(slot.index / ATLAS_COLS),
      drawn: slot.drawn,
    };
  });

  const texture = new THREE.Texture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  console.log(
    `[atlas] ${textureSlots.size} unique textures packed ` +
    `grid=${ATLAS_COLS}x${rows} slots=${slots.length}/${capacity}`,
  );

  return {
    texture,
    uniqueTextureCount: textureSlots.size,
    failedTextureCount,
    slotCount: slots.length,
    cols: ATLAS_COLS,
    rows,
    slotSize: ATLAS_SLOT_SIZE,
    width: ATLAS_WIDTH,
    height,
    capacity,
    perSubMesh,
  };
}
