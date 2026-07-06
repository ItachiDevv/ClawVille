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
  /** Visual source from the GLB material. Dedupe is by image identity or color. */
  source: MaterialVisualSource;
}

export type MaterialVisualSource =
  | { kind: 'texture'; texture: THREE.Texture; tint?: [number, number, number, number]; label?: string }
  | { kind: 'solid'; color: [number, number, number, number]; label?: string };

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
  source: MaterialVisualSource;
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

export function canDrawTextureToCanvas(tex: THREE.Texture | null | undefined): boolean {
  const img = getDrawableTextureImage(tex);
  if (!img) return false;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  try {
    ctx.drawImage(img as any, 0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function textureDedupeKey(tex: THREE.Texture): object | string {
  const img = getDrawableTextureImage(tex) as any;
  const src = img?.currentSrc || img?.src || (tex as any).source?.data?.currentSrc || (tex as any).source?.data?.src;
  if (typeof src === 'string' && src.length > 0) return `src:${src}`;
  if (typeof tex.name === 'string' && tex.name.length > 0) return `name:${tex.name}`;
  return (img as object | null) ?? tex;
}

function visualSourceDedupeKey(source: MaterialVisualSource): object | string {
  if (source.kind === 'texture') {
    const key = textureDedupeKey(source.texture);
    const tint = source.tint ?? [1, 1, 1, 1];
    const tintKey = tint.map((v) => v.toFixed(5)).join(',');
    if (typeof key === 'string') return `${key}|tint:${tintKey}`;
    if (tintKey === '1.00000,1.00000,1.00000,1.00000') return key;
    return source.texture;
  }
  const [r, g, b, a] = source.color;
  return `solid:${r.toFixed(5)},${g.toFixed(5)},${b.toFixed(5)},${a.toFixed(5)}`;
}

function cssColorFromLinearRgba(color: [number, number, number, number]): string {
  const srgb = new THREE.Color(color[0], color[1], color[2]).convertLinearToSRGB();
  const r = Math.round(THREE.MathUtils.clamp(srgb.r, 0, 1) * 255);
  const g = Math.round(THREE.MathUtils.clamp(srgb.g, 0, 1) * 255);
  const b = Math.round(THREE.MathUtils.clamp(srgb.b, 0, 1) * 255);
  const a = THREE.MathUtils.clamp(color[3], 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function drawVisualSource(
  ctx: CanvasRenderingContext2D,
  source: MaterialVisualSource,
  innerX: number,
  innerY: number,
  innerSize: number,
): boolean {
  if (source.kind === 'solid') {
    ctx.fillStyle = cssColorFromLinearRgba(source.color);
    ctx.fillRect(innerX, innerY, innerSize, innerSize);
    return true;
  }

  const img = getDrawableTextureImage(source.texture);
  if (!img) return false;
  try {
    ctx.drawImage(img as any, innerX, innerY, innerSize, innerSize);
    const tint = source.tint ?? [1, 1, 1, 1];
    const needsTint = Math.abs(tint[0] - 1) > 1e-4 || Math.abs(tint[1] - 1) > 1e-4 || Math.abs(tint[2] - 1) > 1e-4;
    const needsOpacity = Math.abs(tint[3] - 1) > 1e-4;
    if (needsTint) {
      const tintColor = cssColorFromLinearRgba([tint[0], tint[1], tint[2], 1]);
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = tintColor;
      ctx.fillRect(innerX, innerY, innerSize, innerSize);
      ctx.restore();
    }
    if (needsOpacity) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = `rgba(0, 0, 0, ${THREE.MathUtils.clamp(tint[3], 0, 1)})`;
      ctx.fillRect(innerX, innerY, innerSize, innerSize);
      ctx.restore();
    }
    return true;
  } catch {
    return false;
  }
}

export function materialVisualSource(material: THREE.Material | null): MaterialVisualSource | null {
  if (!material) return null;
  const m = material as any;

  const color = m.color as THREE.Color | undefined;
  const opacity = typeof m.opacity === 'number' ? m.opacity : 1;
  const texture = (m.map as THREE.Texture | undefined) ?? null;
  if (texture && canDrawTextureToCanvas(texture)) {
    const tint = color?.isColor ? [color.r, color.g, color.b, opacity] as [number, number, number, number] : [1, 1, 1, opacity];
    return { kind: 'texture', texture, tint, label: 'map' };
  }

  if (color?.isColor) {
    return {
      kind: 'solid',
      color: [color.r, color.g, color.b, opacity],
      label: 'base-color',
    };
  }

  const secondaryTexture =
    (m.emissiveMap as THREE.Texture | undefined)
    ?? (m.specularColorMap as THREE.Texture | undefined)
    ?? (m.sheenColorMap as THREE.Texture | undefined)
    ?? null;
  if (secondaryTexture && canDrawTextureToCanvas(secondaryTexture)) {
    return { kind: 'texture', texture: secondaryTexture, tint: [1, 1, 1, opacity], label: 'secondary-map' };
  }

  return null;
}

export function canDrawMaterialVisualSource(source: MaterialVisualSource | null | undefined): boolean {
  if (!source) return false;
  return source.kind === 'solid' || canDrawTextureToCanvas(source.texture);
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

  const tex = input.source.kind === 'texture' ? input.source.texture : null;
  if (tex?.matrixAutoUpdate) tex.updateMatrix();
  const uv = new THREE.Vector2();

  for (let v = 0; v < uvAttr.count; v++) {
    uv.set(uvAttr.getX(v), uvAttr.getY(v));
    if (tex?.matrix) uv.applyMatrix3(tex.matrix);
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
  const textureInputs = new Map<object | string, { source: MaterialVisualSource; inputs: SubMeshInput[] }>();
  let failedTextureCount = 0;

  for (const input of inputs) {
    if (!canDrawMaterialVisualSource(input.source)) {
      failedTextureCount++;
      continue;
    }

    const key = visualSourceDedupeKey(input.source);
    let group = textureInputs.get(key);
    if (!group) {
      group = { source: input.source, inputs: [] };
      textureInputs.set(key, group);
    }
    group.inputs.push(input);
  }

  const candidateSlotCount = textureInputs.size;
  const rows = candidateSlotCount > ATLAS_BASE_MAX_SLOTS ? ATLAS_EXTENDED_ROWS : ATLAS_BASE_ROWS;
  const height = rows === ATLAS_BASE_ROWS ? ATLAS_BASE_HEIGHT : ATLAS_EXTENDED_HEIGHT;
  const capacity = ATLAS_COLS * rows;

  if (candidateSlotCount > ATLAS_EXTENDED_MAX_SLOTS) {
    throw new Error(
      `buildSubMeshAtlas: ${candidateSlotCount} atlas slots exceeds capacity ${ATLAS_EXTENDED_MAX_SLOTS}. ` +
      'The meshlet shader uses one texture_2d atlas; add a second atlas or reduce unique materials.',
    );
  }
  if (candidateSlotCount > ATLAS_BASE_MAX_SLOTS) {
    console.warn(
      `[atlas] ${candidateSlotCount} slots exceeds 8x8 capacity; using ${ATLAS_COLS}x${ATLAS_EXTENDED_ROWS} ` +
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

  const textureSlots = new Map<object | string, AtlasSlot>();
  const slots: AtlasSlot[] = [];

  for (const [key, group] of textureInputs) {
    const slot: AtlasSlot = { index: slots.length, source: group.source, drawn: false };
    const slotCol = slot.index % ATLAS_COLS;
    const slotRow = Math.floor(slot.index / ATLAS_COLS);
    const slotX = slotCol * ATLAS_SLOT_SIZE;
    const slotY = slotRow * ATLAS_SLOT_SIZE;
    const innerSize = ATLAS_SLOT_SIZE - ATLAS_SLOT_PAD * 2;
    const innerX = slotX + ATLAS_SLOT_PAD;
    const innerY = slotY + ATLAS_SLOT_PAD;

    slot.drawn = drawVisualSource(ctx, slot.source, innerX, innerY, innerSize);

    if (!slot.drawn) {
      failedTextureCount++;
      continue;
    }

    replicatePadding(ctx, slotX, slotY, innerX, innerY, innerSize);
    textureSlots.set(key, slot);
    slots.push(slot);
  }

  const perSubMesh = Array.from(textureInputs.entries()).flatMap(([key, group]) => {
    const slot = textureSlots.get(key);
    if (!slot) return [];
    return group.inputs.map((input) => {
      remapGeometryUvs(input, slot.index, ATLAS_WIDTH, height);
      return {
        id: input.id,
        slotIndex: slot.index,
        slotCol: slot.index % ATLAS_COLS,
        slotRow: Math.floor(slot.index / ATLAS_COLS),
        drawn: slot.drawn,
      };
    });
  });

  const texture = new THREE.Texture(canvas);
  // GLTFLoader sets glTF color textures to flipY=false. The meshlet atlas is
  // built from those same images and UVs, so it must use the same orientation.
  // Leaving the default flipY=true mirrors atlas rows at upload time, causing
  // sub-meshes to sample unrelated slots from other buildings.
  texture.flipY = false;
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
