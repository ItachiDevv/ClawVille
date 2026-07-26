'use client';

import * as THREE from 'three/webgpu';

export interface ResourceLedgerCounts {
  textures: number;
  geometries: number;
  attributes: number;
  renderTargets: number;
  unknownTextures: number;
}

export interface ResourceLedgerResult {
  texturesBytes: number;
  geometryBytes: number;
  renderTargetsBytes: number;
  total: number;
  counts: ResourceLedgerCounts;
  accuracy: {
    exactCompressedMipBytes: number;
    estimatedTextureBytes: number;
    unknownTextureBytes: number;
  };
}

export interface StageSceneInventory {
  objects: number;
  meshes: number;
  geometryReferences: number;
  uniqueGeometries: number;
  meshesByNameType: Record<string, number>;
  geometriesByNameType: Record<string, number>;
}

const rootsByScene = new Map<string, THREE.Object3D>();

export function registerStageSlotRoot(
  sceneId: string,
  root: THREE.Object3D | null,
): void {
  if (root) {
    rootsByScene.set(sceneId, root);
  } else {
    rootsByScene.delete(sceneId);
  }
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function readStageSceneInventory(): Record<string, StageSceneInventory> {
  const inventory: Record<string, StageSceneInventory> = {};
  for (const [sceneId, root] of rootsByScene) {
    const meshesByNameType = new Map<string, number>();
    const geometriesByNameType = new Map<string, number>();
    const geometries = new Set<THREE.BufferGeometry>();
    let objects = 0;
    let meshes = 0;
    let geometryReferences = 0;

    root.traverse((object) => {
      objects += 1;
      const renderable = object as THREE.Mesh<THREE.BufferGeometry>;
      if (!renderable.isMesh) return;
      meshes += 1;
      const objectName = object.name || '(unnamed)';
      const meshKey = `${objectName} / ${object.type}`;
      meshesByNameType.set(meshKey, (meshesByNameType.get(meshKey) ?? 0) + 1);

      const geometry = renderable.geometry;
      if (!geometry?.isBufferGeometry) return;
      geometryReferences += 1;
      geometries.add(geometry);
      const geometryKey = `${objectName} / ${geometry.type}`;
      geometriesByNameType.set(
        geometryKey,
        (geometriesByNameType.get(geometryKey) ?? 0) + 1,
      );
    });

    inventory[sceneId] = {
      objects,
      meshes,
      geometryReferences,
      uniqueGeometries: geometries.size,
      meshesByNameType: sortedCounts(meshesByNameType),
      geometriesByNameType: sortedCounts(geometriesByNameType),
    };
  }
  return inventory;
}

export function readStageResourceLedger(): Record<
  string,
  ResourceLedgerResult
> {
  const ledger: Record<string, ResourceLedgerResult> = {};
  for (const [sceneId, root] of rootsByScene) {
    ledger[sceneId] = estimateSceneSlotResources(root);
  }
  return ledger;
}

interface TextureImage {
  width?: number;
  height?: number;
  depth?: number;
  data?: ArrayBufferView;
}

type TextureLike = THREE.Texture & {
  isCompressedTexture?: boolean;
  isCubeTexture?: boolean;
};

interface RenderTargetLike {
  isRenderTarget?: boolean;
  isWebGLRenderTarget?: boolean;
  width: number;
  height: number;
  depth?: number;
  textures?: THREE.Texture[];
  texture?: THREE.Texture;
  depthTexture?: THREE.Texture | null;
  samples?: number;
  depthBuffer?: boolean;
  stencilBuffer?: boolean;
}

function typeBytes(type: number): number {
  switch (type) {
    case THREE.ByteType:
    case THREE.UnsignedByteType:
      return 1;
    case THREE.ShortType:
    case THREE.UnsignedShortType:
    case THREE.HalfFloatType:
    case THREE.UnsignedShort4444Type:
    case THREE.UnsignedShort5551Type:
      return 2;
    case THREE.IntType:
    case THREE.UnsignedIntType:
    case THREE.FloatType:
    case THREE.UnsignedInt248Type:
      return 4;
    default:
      return 1;
  }
}

function formatChannels(format: number): number {
  switch (format) {
    case THREE.AlphaFormat:
    case THREE.RedFormat:
    case THREE.RedIntegerFormat:
    case 1024: // legacy LuminanceFormat
    case THREE.DepthFormat:
      return 1;
    case THREE.RGFormat:
    case THREE.RGIntegerFormat:
    case 1025: // legacy LuminanceAlphaFormat
    case THREE.DepthStencilFormat:
      return 2;
    case THREE.RGBFormat:
      return 3;
    case THREE.RGBAFormat:
    case THREE.RGBAIntegerFormat:
    default:
      return 4;
  }
}

function bytesPerTexel(format: number, type: number): number {
  if (
    type === THREE.UnsignedShort4444Type ||
    type === THREE.UnsignedShort5551Type
  ) {
    return 2;
  }
  if (
    type === THREE.UnsignedInt248Type ||
    type === THREE.UnsignedInt5999Type ||
    type === THREE.UnsignedInt101111Type
  ) {
    return 4;
  }
  return formatChannels(format) * typeBytes(type);
}

function hasGeneratedMipChain(texture: THREE.Texture): boolean {
  return (
    texture.generateMipmaps &&
    texture.minFilter !== THREE.NearestFilter &&
    texture.minFilter !== THREE.LinearFilter
  );
}

function imageDimensions(
  image: TextureImage | undefined,
): readonly [number, number, number] | null {
  const width = Number(image?.width ?? 0);
  const height = Number(image?.height ?? 0);
  const depth = Number(image?.depth ?? 1);
  if (width <= 0 || height <= 0 || depth <= 0) return null;
  return [width, height, depth];
}

function estimateTexture(texture: TextureLike): {
  bytes: number;
  exactCompressed: boolean;
  unknown: boolean;
} {
  const mipmaps = texture.mipmaps as Array<{
    data?: ArrayBufferView;
    width?: number;
    height?: number;
  }>;
  if (texture.isCompressedTexture && mipmaps.length > 0) {
    let bytes = 0;
    for (const mip of mipmaps) {
      bytes += mip.data?.byteLength ?? 0;
    }
    if (bytes > 0) {
      return { bytes, exactCompressed: true, unknown: false };
    }
  }

  const source = texture.source?.data as
    | TextureImage
    | TextureImage[]
    | undefined;
  const images = Array.isArray(source)
    ? source
    : texture.isCubeTexture && Array.isArray(texture.image)
      ? (texture.image as TextureImage[])
      : [source ?? (texture.image as TextureImage | undefined)];

  let bytes = 0;
  let knownImages = 0;
  for (const image of images) {
    const dimensions = imageDimensions(image);
    if (!dimensions) continue;
    knownImages += 1;
    const [width, height, depth] = dimensions;
    const baseBytes =
      image?.data?.byteLength ??
      width * height * depth * bytesPerTexel(texture.format, texture.type);

    let suppliedMipBytes = 0;
    let suppliedIncludesBase = false;
    for (const mip of mipmaps) {
      const mipWidth = Number(mip.width ?? 0);
      const mipHeight = Number(mip.height ?? 0);
      const mipBytes =
        mip.data?.byteLength ??
        (mipWidth > 0 && mipHeight > 0
          ? mipWidth *
            mipHeight *
            depth *
            bytesPerTexel(texture.format, texture.type)
          : 0);
      suppliedMipBytes += mipBytes;
      if (mipWidth === width && mipHeight === height) {
        suppliedIncludesBase = true;
      }
    }
    if (suppliedMipBytes > 0) {
      bytes += suppliedMipBytes;
      if (!suppliedIncludesBase) bytes += baseBytes;
    } else {
      bytes += hasGeneratedMipChain(texture)
        ? Math.ceil(baseBytes * (4 / 3))
        : baseBytes;
    }
  }

  return {
    bytes,
    exactCompressed: false,
    unknown: knownImages === 0,
  };
}

function isTexture(value: unknown): value is TextureLike {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { isTexture?: boolean }).isTexture,
  );
}

function isRenderTarget(value: unknown): value is RenderTargetLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as RenderTargetLike;
  return Boolean(candidate.isRenderTarget || candidate.isWebGLRenderTarget);
}

function collectMaterialResources(
  value: unknown,
  textures: Set<TextureLike>,
  renderTargets: Set<RenderTargetLike>,
  visited: Set<object>,
  depth = 0,
): void {
  if (!value || typeof value !== 'object' || depth > 4) return;
  if (isTexture(value)) {
    textures.add(value);
    return;
  }
  if (isRenderTarget(value)) {
    renderTargets.add(value);
    return;
  }
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      collectMaterialResources(
        child,
        textures,
        renderTargets,
        visited,
        depth + 1,
      );
    }
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectMaterialResources(
      child,
      textures,
      renderTargets,
      visited,
      depth + 1,
    );
  }
}

function attributeBytes(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  seenAttributes: Set<object>,
  seenInterleaved: Set<object>,
): { bytes: number; counted: boolean } {
  if (attribute instanceof THREE.InterleavedBufferAttribute) {
    const data = attribute.data;
    if (seenInterleaved.has(data)) {
      return { bytes: 0, counted: false };
    }
    seenInterleaved.add(data);
    return { bytes: data.array.byteLength, counted: true };
  }
  if (seenAttributes.has(attribute)) {
    return { bytes: 0, counted: false };
  }
  seenAttributes.add(attribute);
  return { bytes: attribute.array.byteLength, counted: true };
}

export function estimateSceneSlotResources(
  root: THREE.Object3D,
): ResourceLedgerResult {
  const textures = new Set<TextureLike>();
  const renderTargets = new Set<RenderTargetLike>();
  const geometries = new Set<THREE.BufferGeometry>();
  const attributes = new Set<object>();
  const interleaved = new Set<object>();
  const visitedMaterialValues = new Set<object>();
  let geometryBytes = 0;
  let attributeCount = 0;

  root.traverse((object) => {
    const renderable = object as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.Material | THREE.Material[]
    >;
    const geometry = renderable.geometry;
    if (geometry?.isBufferGeometry && !geometries.has(geometry)) {
      geometries.add(geometry);
      const geometryAttributes = [
        geometry.index,
        ...Object.values(geometry.attributes),
        ...Object.values(geometry.morphAttributes).flat(),
      ].filter(
        (
          attribute,
        ): attribute is
          | THREE.BufferAttribute
          | THREE.InterleavedBufferAttribute => Boolean(attribute),
      );
      for (const attribute of geometryAttributes) {
        const estimate = attributeBytes(attribute, attributes, interleaved);
        geometryBytes += estimate.bytes;
        if (estimate.counted) attributeCount += 1;
      }
    }

    const instanced = object as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const instanceAttributes = [
        instanced.instanceMatrix,
        instanced.instanceColor,
      ].filter((attribute): attribute is THREE.InstancedBufferAttribute =>
        Boolean(attribute),
      );
      for (const attribute of instanceAttributes) {
        const estimate = attributeBytes(attribute, attributes, interleaved);
        geometryBytes += estimate.bytes;
        if (estimate.counted) attributeCount += 1;
      }
    }

    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material
        ? [renderable.material]
        : [];
    for (const material of materials) {
      collectMaterialResources(
        material,
        textures,
        renderTargets,
        visitedMaterialValues,
      );
    }
    collectMaterialResources(
      object.userData,
      textures,
      renderTargets,
      visitedMaterialValues,
    );
  });

  const renderTargetTextures = new Set<TextureLike>();
  for (const target of renderTargets) {
    for (const texture of target.textures ??
      (target.texture ? [target.texture] : [])) {
      renderTargetTextures.add(texture as TextureLike);
    }
    if (target.depthTexture) {
      renderTargetTextures.add(target.depthTexture as TextureLike);
    }
  }

  let texturesBytes = 0;
  let exactCompressedMipBytes = 0;
  let estimatedTextureBytes = 0;
  let unknownTextureBytes = 0;
  for (const texture of textures) {
    if (renderTargetTextures.has(texture)) continue;
    const estimate = estimateTexture(texture);
    texturesBytes += estimate.bytes;
    if (estimate.exactCompressed) {
      exactCompressedMipBytes += estimate.bytes;
    } else {
      estimatedTextureBytes += estimate.bytes;
    }
    if (estimate.unknown) unknownTextureBytes += 1;
  }

  let renderTargetsBytes = 0;
  const countedRenderTargetTextures = new Set<TextureLike>();
  for (const target of renderTargets) {
    const colorTextures =
      target.textures ?? (target.texture ? [target.texture] : []);
    for (const texture of colorTextures) {
      const textureLike = texture as TextureLike;
      if (countedRenderTargetTextures.has(textureLike)) continue;
      countedRenderTargetTextures.add(textureLike);
      const baseBytes =
        target.width *
        target.height *
        Math.max(1, target.depth ?? 1) *
        bytesPerTexel(texture.format, texture.type);
      const samples = Math.max(0, target.samples ?? 0);
      const resolveFactor = hasGeneratedMipChain(texture) ? 4 / 3 : 1;
      renderTargetsBytes += Math.ceil(baseBytes * (samples + resolveFactor));
    }
    if (target.depthTexture) {
      const depthTexture = target.depthTexture as TextureLike;
      if (!countedRenderTargetTextures.has(depthTexture)) {
        countedRenderTargetTextures.add(depthTexture);
        const samples = Math.max(0, target.samples ?? 0);
        renderTargetsBytes +=
          target.width *
          target.height *
          Math.max(1, target.depth ?? 1) *
          bytesPerTexel(target.depthTexture.format, target.depthTexture.type) *
          (samples + 1);
      }
    } else if (target.depthBuffer !== false) {
      const samples = Math.max(0, target.samples ?? 0);
      renderTargetsBytes +=
        target.width *
        target.height *
        Math.max(1, target.depth ?? 1) *
        4 *
        Math.max(1, samples);
    }
  }

  return {
    texturesBytes,
    geometryBytes,
    renderTargetsBytes,
    total: texturesBytes + geometryBytes + renderTargetsBytes,
    counts: {
      textures: [...textures].filter(
        (texture) => !renderTargetTextures.has(texture),
      ).length,
      geometries: geometries.size,
      attributes: attributeCount,
      renderTargets: renderTargets.size,
      unknownTextures: unknownTextureBytes,
    },
    accuracy: {
      exactCompressedMipBytes,
      estimatedTextureBytes,
      unknownTextureBytes,
    },
  };
}
