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

export function makeObject3DWebGPUSafe(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      makeGeometryWebGPUSafe(mesh.geometry);
    }
  });
}
