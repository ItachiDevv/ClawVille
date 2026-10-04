import * as THREE from 'three';

const WEBGPU_SAFE_GEOMETRY = 'clawville:webgpu-safe-geometry';

function normalizedTypedValue(array: ArrayLike<number>, index: number, normalized: boolean): number {
  const value = array[index] ?? 0;
  if (!normalized) return value;

  if (array instanceof Uint8Array) return value / 255;
  if (array instanceof Uint16Array) return value / 65535;
  if (array instanceof Uint32Array) return value / 4294967295;
  if (array instanceof Int8Array) return Math.max(value / 127, -1);
  if (array instanceof Int16Array) return Math.max(value / 32767, -1);
  if (array instanceof Int32Array) return Math.max(value / 2147483647, -1);
  return value;
}

function attributeByteStride(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    const interleaved = attr as THREE.InterleavedBufferAttribute;
    return interleaved.data.stride * interleaved.data.array.BYTES_PER_ELEMENT;
  }
  return attr.itemSize * (attr as THREE.BufferAttribute).array.BYTES_PER_ELEMENT;
}

function shouldConvertAttribute(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): boolean {
  if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return true;
  if ((attr as THREE.BufferAttribute).array instanceof Float32Array) return false;
  return attributeByteStride(attr) % 4 !== 0;
}

function toFloat32Attribute(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): THREE.Float32BufferAttribute {
  const values = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < attr.itemSize; c++) {
      const dst = i * attr.itemSize + c;
      if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
        values[dst] = normalizedTypedValue(
          (attr as THREE.InterleavedBufferAttribute).data.array,
          i * (attr as THREE.InterleavedBufferAttribute).data.stride +
            (attr as THREE.InterleavedBufferAttribute).offset +
            c,
          attr.normalized,
        );
      } else {
        values[dst] = normalizedTypedValue(
          (attr as THREE.BufferAttribute).array,
          i * attr.itemSize + c,
          attr.normalized,
        );
      }
    }
  }
  return new THREE.Float32BufferAttribute(values, attr.itemSize);
}

export function makeGeometryWebGPUSafe<T extends THREE.BufferGeometry>(geometry: T): T {
  if (geometry.userData?.[WEBGPU_SAFE_GEOMETRY]) return geometry;

  for (const [name, attr] of Object.entries(geometry.attributes)) {
    if (attr && shouldConvertAttribute(attr)) {
      geometry.setAttribute(name, toFloat32Attribute(attr));
    }
  }

  const morphAttributes = geometry.morphAttributes as Record<
    string,
    Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>
  >;
  for (const [name, attrs] of Object.entries(morphAttributes)) {
    morphAttributes[name] = attrs.map((attr) =>
      shouldConvertAttribute(attr) ? toFloat32Attribute(attr) : attr,
    );
  }

  geometry.userData = {
    ...geometry.userData,
    [WEBGPU_SAFE_GEOMETRY]: true,
  };
  return geometry;
}

/**
 * three r185 WebGPU treats a texture with minFilter === magFilter === NearestFilter as
 * "unfilterable": WGSLNodeBuilder drops its sampler binding (textureLoad path). Material
 * maps go through ONE module-global MaterialReferenceNode per property, whose TextureNode
 * `.value` is re-pointed at whatever material renders next. compileAsync() builds with
 * buildAsync(), which yields between stages, so the sampler check at uniform registration
 * (bind-group layout) and at WGSL generation can read different textures. The result is a
 * layout without the sampler bindings while the shader declares them: "Binding doesn't exist
 * in [BindGroupLayout]", and the pipeline-error mesh is never drawn (WebGPUBackend.draw skips it).
 * Hit on prod by hermitcrab-ktx.glb (PaletteMaterial001); sea_horse-mo-ktx.glb has the same
 * sampler. Changing minFilter makes the texture filterable, so both checks agree.
 *
 * Visual effect: magnification is unchanged (magFilter stays NearestFilter). Minification changes:
 * - mip chain present or generated: NearestMipmapNearestFilter, i.e. the nearest texel of the
 *   nearest mip level. Far away this can read a coarser mip than plain Nearest (which always
 *   reads level 0), so distant surfaces shimmer less and lose some fine texel detail.
 * - single level: LinearFilter (bilinear when minified). A mipmap min filter is avoided here
 *   because a mutable single-level WebGL2 texture would be incomplete (black).
 * The mip test mirrors three r185 Textures.getMipLevels()/needsMipmaps(), which both backends use.
 *
 * Skipped: render-target, depth, cube, storage, framebuffer and video textures (not affected:
 * cube always gets a sampler, depth must stay non-filtering, the rest are not plain image maps).
 */
function hasMipChain(texture: THREE.Texture): boolean {
  const defined = texture.mipmaps?.length ?? 0;
  if (defined > 0) return defined > 1;
  return texture.generateMipmaps === true && !(texture as THREE.CompressedTexture).isCompressedTexture;
}

function makeTextureFilterable(texture: THREE.Texture): void {
  const t = texture as THREE.Texture & {
    isRenderTargetTexture?: boolean;
    isDepthTexture?: boolean;
    isCubeTexture?: boolean;
    isStorageTexture?: boolean;
    isFramebufferTexture?: boolean;
    isVideoTexture?: boolean;
  };
  if (
    t.isRenderTargetTexture || t.isDepthTexture || t.isCubeTexture ||
    t.isStorageTexture || t.isFramebufferTexture || t.isVideoTexture
  ) return;
  if (t.minFilter !== THREE.NearestFilter || t.magFilter !== THREE.NearestFilter) return;

  t.minFilter = hasMipChain(t) ? THREE.NearestMipmapNearestFilter : THREE.LinearFilter;
  // Both backends read filters only when texture.version changes (WebGPU: Sampler.update() ->
  // updateSampler(); WebGL2: Textures.updateTexture() -> setTextureParameters()). version > 0
  // means the data is ready (loaders set needsUpdate). A bump before the first upload still
  // gives ONE upload; after an upload it refreshes the sampler/texParameteri once. Version 0
  // (no data yet) is left alone so the texture is not marked ready too early.
  if (t.version > 0) t.needsUpdate = true;
}

function makeMaterialTexturesFilterable(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if ((value as THREE.Texture | null)?.isTexture) makeTextureFilterable(value as THREE.Texture);
  }
}

export function makeObject3DWebGPUSafe(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      makeGeometryWebGPUSafe(mesh.geometry);
    }
    // Every Object3D with a material (Mesh, SkinnedMesh, Points, Line, Sprite, ...).
    const material = (obj as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
    if (material) {
      for (const m of Array.isArray(material) ? material : [material]) {
        if (m) makeMaterialTexturesFilterable(m);
      }
    }
  });
}
