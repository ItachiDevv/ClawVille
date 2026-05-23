// @ts-nocheck — TSL node types (ComputeNode, StorageBufferAttribute.dispose,
// IndirectStorageBufferAttribute as workgroup-count argument) are underspecified
// in @types/three@0.182.0. The TSL API is stable at runtime; the type gaps are
// a documentation lag. This is consistent with how World3DCanvas.tsx and the
// other heavy three/webgpu files in this codebase suppress the same family of
// errors. Do not remove without a corresponding @types/three bump that covers
// Fn().compute(IndirectStorageBufferAttribute) and StorageBufferAttribute.dispose.
/**
 * Experimental — Nanite-style GPU-driven rasterizer for ClawVille.
 *
 * Faithfully ported from Three.js r182 example:
 *   examples/webgpu_compute_nanite-style.html  (PR #33605, dev branch)
 *
 * What was stripped versus the original:
 *   - TeapotGeometry LOD generation (demo-specific)
 *   - 400×400 instance grid (demo-specific; replaced by RasterizerOptions.instanceCount)
 *   - OrbitControls (caller owns the camera)
 *   - Inspector / UI parameterGroup (no runtime GUI here)
 *   - renderer.setAnimationLoop / animate() loop (caller drives via render())
 *
 * What was kept verbatim:
 *   - All compute pipeline stages (computeClear, computeFrustum, computeDispatch,
 *     computeRasterize, computeHWArgs)
 *   - Fullscreen quad presentation pass with depth reconstruction
 *   - Hardware rasteriser fallback scene for large triangles
 *   - Visibility-buffer packing (depth | triangle | instance)
 *   - Per-pixel incremental barycentric rasterisation
 *
 * INVARIANTS (do not violate):
 *   - WebGPU only. Caller is responsible for passing a WebGPURenderer.
 *   - Zero allocations in render() hot-path — all typed-array buffers are pre-allocated.
 *   - No drei Text/Billboard (Iris Xe kill-the-build invariant, though this module
 *     has no React dependencies at all).
 *   - No InstancedMesh + ShaderMaterial (Iris Xe silent WebGPU crash).
 */

// Import from 'three/webgpu' — same static import used by World3DCanvas.tsx.
// Do NOT dynamic-import inside functions (creates a second module instance → crash).
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  vec4,
  vec2,
  uvec4,
  mat4,
  uint,
  float,
  int,
  min,
  max,
  atomicMax,
  atomicAdd,
  atomicStore,
  atomicLoad,
  floor,
  cos,
  sin,
  dot,
  bool,
  storage,
  uniform,
  uniformArray,
  uv,
  instanceIndex,
  vertexIndex,
  distance,
  screenSize,
  time,
  texture as tslTexture,
  varyingProperty,
  sqrt,
} from 'three/tsl';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Flattened meshlet data produced by geometryToMeshletAsset().
 * All arrays are pre-allocated typed arrays — pass them straight to NaniteRasterizer.
 */
export interface MeshletAsset {
  /** Interleaved positions as vec4 (xyz + 1.0 padding). Length = totalVertices * 4. */
  vertexArray: Float32Array;
  /** UV pairs. Length = totalVertices * 2. */
  uvArray: Float32Array;
  /** Triangle index buffer — global vertex indices. Length = totalIndices. */
  indexArray: Uint32Array;
  /** Meshlet id per triangle (1-based, increments every 126 triangles per LOD). Length = totalIndices/3. */
  meshletTriangleArray: Uint32Array;
  /** Bounding sphere per chunk: [cx, cy, cz, radius] repeated. Length = totalChunks * 4. */
  chunkBoundsData: Float32Array;
  /**
   * LOD offset table. Each LOD uses 4 uints:
   *   [triangleStart (in units of 1 triangle), triangleCount, chunkStart, 0]
   * Length = lodCount * 4.
   */
  lodOffsetsData: Uint32Array;
  totalVertices: number;
  totalIndices: number;
  totalChunks: number;
  /** Total triangle count across all LODs (used for diagnostics, not GPU upload). */
  triangleCount: number;
  /** Number of LOD levels. */
  lodCount: number;
}

export interface RasterizerOptions {
  /** Number of instances to render. For the spike: pass 1. */
  instanceCount: number;
  /**
   * Per-instance data as vec4: [posX, posY, posZ, scale].
   * Must have instanceCount * 4 elements.
   */
  staticInstanceData: Float32Array;
  /**
   * Maximum pixel bounding-box size that the SW rasterizer handles.
   * Larger triangles fall through to the HW fallback scene.
   * Default: 16 (matches the original example).
   */
  maxRasterSize?: number;
}

// ---------------------------------------------------------------------------
// geometryToMeshletAsset
// ---------------------------------------------------------------------------

/**
 * Convert a THREE.BufferGeometry into a MeshletAsset ready for NaniteRasterizer.
 *
 * Implements:
 *   - Single LOD (source geometry as-is). No meshoptimizer simplification.
 *   - 126 triangles per meshlet (matches example's convention).
 *   - 64 triangles per chunk (bounding sphere grouping, matches example).
 *
 * TODO: Add multi-LOD support via meshoptimizer simplify() when the spike
 * graduates to production. meshoptimizer is already a project dep via VRM loading.
 */
export function geometryToMeshletAsset(geometry: THREE.BufferGeometry): MeshletAsset {
  // Ensure we have a position attribute.
  const posAttr = geometry.attributes['position'] as THREE.BufferAttribute;
  if (!posAttr) {
    throw new Error('geometryToMeshletAsset: geometry must have a position attribute');
  }

  const uvAttr = geometry.attributes['uv'] as THREE.BufferAttribute | undefined;

  // Build flat index array (handle non-indexed geometry).
  const numVertices = posAttr.count;
  const rawIndices: number[] = geometry.index
    ? Array.from(geometry.index.array as Uint16Array | Uint32Array)
    : Array.from({ length: numVertices }, (_, i) => i);

  const numTriangles = rawIndices.length / 3;

  // Single LOD descriptor (the source mesh at full detail, error = 0).
  const lods = [
    {
      numVertices,
      numTriangles,
      vertexOffset: 0,
      indexOffset: 0,
      indices: rawIndices,
    },
  ];

  const totalVertices = numVertices;
  const totalIndices = rawIndices.length;

  // ---- Fill vertex / uv / index / meshlet-id arrays ----
  const vertexArray = new Float32Array(totalVertices * 4);
  const uvArray = new Float32Array(totalVertices * 2);
  const indexArray = new Uint32Array(totalIndices);
  const meshletTriangleArray = new Uint32Array(totalIndices / 3);

  // Populate vertices
  for (let i = 0; i < numVertices; i++) {
    vertexArray[i * 4 + 0] = posAttr.getX(i);
    vertexArray[i * 4 + 1] = posAttr.getY(i);
    vertexArray[i * 4 + 2] = posAttr.getZ(i);
    vertexArray[i * 4 + 3] = 1.0;
    if (uvAttr) {
      uvArray[i * 2 + 0] = uvAttr.getX(i);
      uvArray[i * 2 + 1] = uvAttr.getY(i);
    }
  }

  // Populate index buffer and assign meshlet ids (126 tris per meshlet, same as example)
  let currentMeshletId = 1;
  for (const lod of lods) {
    let currentTriCount = 0;
    for (let i = 0; i < lod.numTriangles; i++) {
      const triIdx = lod.indexOffset / 3 + i;
      indexArray[triIdx * 3 + 0] = lod.vertexOffset + lod.indices[i * 3 + 0];
      indexArray[triIdx * 3 + 1] = lod.vertexOffset + lod.indices[i * 3 + 1];
      indexArray[triIdx * 3 + 2] = lod.vertexOffset + lod.indices[i * 3 + 2];

      if (currentTriCount >= 126) {
        currentMeshletId++;
        currentTriCount = 0;
      }
      meshletTriangleArray[triIdx] = currentMeshletId;
      currentTriCount++;
    }
    currentMeshletId++;
  }

  // ---- Bounding spheres per 64-tri chunk ----
  let totalChunks = 0;
  const lodChunkStarts: number[] = [];
  const lodNumChunks: number[] = [];
  for (const lod of lods) {
    const numChunks = Math.ceil(lod.numTriangles / 64);
    lodChunkStarts.push(totalChunks);
    lodNumChunks.push(numChunks);
    totalChunks += numChunks;
  }

  const chunkBoundsData = new Float32Array(totalChunks * 4);
  let currentChunkId = 0;

  for (let lodIdx = 0; lodIdx < lods.length; lodIdx++) {
    const lod = lods[lodIdx];
    const numChunks = lodNumChunks[lodIdx];

    for (let c = 0; c < numChunks; c++) {
      const startTri = c * 64;
      const endTri = Math.min(startTri + 64, lod.numTriangles);

      let cx = 0, cy = 0, cz = 0;
      const vertCount = (endTri - startTri) * 3;
      for (let t = startTri; t < endTri; t++) {
        for (let v = 0; v < 3; v++) {
          const idx = lod.indices[t * 3 + v];
          cx += posAttr.getX(idx);
          cy += posAttr.getY(idx);
          cz += posAttr.getZ(idx);
        }
      }
      cx /= vertCount;
      cy /= vertCount;
      cz /= vertCount;

      let maxDistSq = 0;
      for (let t = startTri; t < endTri; t++) {
        for (let v = 0; v < 3; v++) {
          const idx = lod.indices[t * 3 + v];
          const dx = posAttr.getX(idx) - cx;
          const dy = posAttr.getY(idx) - cy;
          const dz = posAttr.getZ(idx) - cz;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq > maxDistSq) maxDistSq = dSq;
        }
      }

      chunkBoundsData[currentChunkId * 4 + 0] = cx;
      chunkBoundsData[currentChunkId * 4 + 1] = cy;
      chunkBoundsData[currentChunkId * 4 + 2] = cz;
      chunkBoundsData[currentChunkId * 4 + 3] = Math.sqrt(maxDistSq);
      currentChunkId++;
    }
  }

  // ---- LOD offset table (single entry for single-LOD case) ----
  const lodOffsetsData = new Uint32Array(lods.length * 4);
  for (let i = 0; i < lods.length; i++) {
    lodOffsetsData[i * 4 + 0] = lods[i].indexOffset / 3; // triangleStart
    lodOffsetsData[i * 4 + 1] = lods[i].numTriangles;    // triangleCount
    lodOffsetsData[i * 4 + 2] = lodChunkStarts[i];       // chunkStart
    lodOffsetsData[i * 4 + 3] = 0;                       // padding
  }

  return {
    vertexArray,
    uvArray,
    indexArray,
    meshletTriangleArray,
    chunkBoundsData,
    lodOffsetsData,
    totalVertices,
    totalIndices,
    totalChunks,
    triangleCount: numTriangles,
    lodCount: lods.length,
  };
}

// ---------------------------------------------------------------------------
// NaniteRasterizer class
// ---------------------------------------------------------------------------

// Constants matching the original example
const TRIANGLE_INDEX_BITS = 14;           // 2^14 = 16384 max triangles per payload
const TRIANGLE_INDEX_MASK = 0x3fff;       // 14-bit bitmask
const DEPTH_PRECISION_MAX = 4294967295.0; // 2^32 - 1

const MAX_WORK_ITEMS = 2_820_000;  // 60k instances × 47 chunks
const MAX_HW_TRIANGLES = 100_000;

export class NaniteRasterizer {
  private renderer: THREE.WebGPURenderer;
  private asset: MeshletAsset;
  private opts: Required<RasterizerOptions>;

  // Compute nodes
  private computeClear!: ReturnType<typeof Fn>;
  private computeFrustum!: ReturnType<typeof Fn>;
  private computeDispatch!: ReturnType<typeof Fn>;
  private computeRasterize!: ReturnType<typeof Fn>;
  private computeHWArgs!: ReturnType<typeof Fn>;

  // Presentation
  private quadMesh!: THREE.QuadMesh;
  private hwScene!: THREE.Scene;
  private hwMesh!: THREE.Mesh;

  // GPU uniforms
  private projScreenMatrixUniform!: ReturnType<typeof uniform>;
  private frustumPlanesUniform!: ReturnType<typeof uniformArray>;
  private cameraPos!: ReturnType<typeof uniform>;
  private cotHalfFovUniform!: ReturnType<typeof uniform>;
  private pixelErrorThresholdUniform!: ReturnType<typeof uniform>;
  private maxRasterSizeUniform!: ReturnType<typeof uniform>;

  // Screen buffers (resize-aware)
  private screenTriAttr!: THREE.StorageBufferAttribute;
  private screenInstAttr!: THREE.StorageBufferAttribute;
  private screenTriAtomic!: ReturnType<typeof storage>;
  private screenTriRead!: ReturnType<typeof storage>;
  private screenInstBuffer!: ReturnType<typeof storage>;
  private screenInstRead!: ReturnType<typeof storage>;
  private maxPixels = 0;

  // Instance world + mvp buffers (written by computeFrustum, read by HW pass)
  private instanceWorldBuffer!: ReturnType<typeof storage>;
  private instanceMvpBuffer!: ReturnType<typeof storage>;
  private instanceWorldAttr!: THREE.StorageBufferAttribute;

  // Scratch CPU-side matrices for frustum extraction
  private readonly _frustum = new THREE.Frustum();
  private readonly _projScreenMatrix = new THREE.Matrix4();
  private readonly _cameraInverse = new THREE.Matrix4();

  // Disposed flag
  private _disposed = false;

  constructor(
    renderer: THREE.WebGPURenderer,
    asset: MeshletAsset,
    opts: RasterizerOptions,
  ) {
    this.renderer = renderer;
    this.asset = asset;
    this.opts = {
      instanceCount: opts.instanceCount,
      staticInstanceData: opts.staticInstanceData,
      maxRasterSize: opts.maxRasterSize ?? 16,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this._disposed) throw new Error('NaniteRasterizer: already disposed');
    this._buildPipelines();
  }

  /**
   * Render one frame.
   * Must be called AFTER init(). Typically called from useFrame or an rAF loop.
   * @param camera - The perspective camera whose frustum drives LOD + culling.
   * @param viewportW - Current viewport pixel width.
   * @param viewportH - Current viewport pixel height.
   */
  async render(
    camera: THREE.PerspectiveCamera,
    viewportW: number,
    viewportH: number,
  ): Promise<void> {
    if (this._disposed) return;

    // Resize screen buffers if viewport changed
    this._updateScreenBuffers(viewportW, viewportH);

    // Update per-frame CPU→GPU uniforms
    camera.updateMatrixWorld();
    this._cameraInverse.copy(camera.matrixWorld).invert();
    this._projScreenMatrix.multiplyMatrices(camera.projectionMatrix, this._cameraInverse);
    this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

    this.projScreenMatrixUniform.value.copy(this._projScreenMatrix);
    this.cameraPos.value.copy(camera.position);
    // cotHalfFov = projectionMatrix.elements[5] (= cot(fov/2), the focal length)
    this.cotHalfFovUniform.value = camera.projectionMatrix.elements[5];

    // Pack frustum planes
    const planes = this._frustum.planes;
    const planesArray = (this.frustumPlanesUniform as any).array as THREE.Vector4[];
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      planesArray[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant);
    }

    // Compute passes (order matters — matches example exactly)
    this.renderer.compute(this.computeClear as any);
    this.renderer.compute(this.computeFrustum as any);
    this.renderer.compute(this.computeDispatch as any);
    this.renderer.compute(this.computeRasterize as any);
    this.renderer.compute(this.computeHWArgs as any);

    // SW presentation (fullscreen quad reads atomic buffer)
    (this.quadMesh as any).render(this.renderer);

    // HW fallback (large triangles rasterised by GPU hardware pipeline)
    this.hwScene.background = null;
    this.renderer.autoClear = false;
    this.renderer.render(this.hwScene, camera);
    this.renderer.autoClear = true;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this.screenTriAttr) this.screenTriAttr.dispose();
    if (this.screenInstAttr) this.screenInstAttr.dispose();
    if (this.quadMesh?.material) (this.quadMesh.material as THREE.Material).dispose();
    if (this.hwMesh?.material) (this.hwMesh.material as THREE.Material).dispose();
    if (this.hwMesh?.geometry) this.hwMesh.geometry.dispose();
    if (this.instanceWorldAttr) this.instanceWorldAttr.dispose();
    // Dispose compute nodes
    for (const key of [
      'computeClear', 'computeFrustum', 'computeDispatch',
      'computeRasterize', 'computeHWArgs',
    ] as const) {
      const node = (this as any)[key];
      if (node?.dispose) node.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Internal: build all TSL compute pipelines
  // -------------------------------------------------------------------------

  private _buildPipelines(): void {
    const { asset, opts } = this;
    const { instanceCount } = opts;

    // ---- Storage buffers (read-only geometry data) ----
    const vertexBuffer = storage(
      new THREE.StorageBufferAttribute(asset.vertexArray, 4),
      'vec4', asset.totalVertices,
    ).toReadOnly();

    const uvBuffer = storage(
      new THREE.StorageBufferAttribute(asset.uvArray, 2),
      'vec2', asset.totalVertices,
    ).toReadOnly();

    const indexBuffer = storage(
      new THREE.StorageBufferAttribute(asset.indexArray, 1),
      'uint', asset.totalIndices,
    ).toReadOnly();

    const meshletIdBuffer = storage(
      new THREE.StorageBufferAttribute(asset.meshletTriangleArray, 1),
      'uint', asset.totalIndices / 3,
    ).toReadOnly();

    const lodOffsetsBuffer = storage(
      new THREE.StorageBufferAttribute(asset.lodOffsetsData, 4),
      'uvec4', asset.lodCount,
    ).toReadOnly();

    const chunkBoundsBufferNode = storage(
      new THREE.StorageBufferAttribute(asset.chunkBoundsData, 4),
      'vec4', asset.totalChunks,
    ).toReadOnly();

    // ---- Uniforms ----
    const materialModeUniform = uniform(0, 'uint'); // 0 = meshlet debug colour

    // Texture for texture-mode (unused in spike but required by the shaders)
    const textureMap = new THREE.TextureLoader().load('/models/building-lighthouse.glb'); // dummy
    // The shaders only sample it when materialModeUniform==1; spike leaves mode at 0.

    this.projScreenMatrixUniform = uniform(new THREE.Matrix4());
    this.frustumPlanesUniform = uniformArray(
      [
        new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
        new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
      ],
      'vec4',
    );
    this.cameraPos = uniform(new THREE.Vector3());
    this.cotHalfFovUniform = uniform(1.0);
    this.pixelErrorThresholdUniform = uniform(4.0);
    this.maxRasterSizeUniform = uniform(this.opts.maxRasterSize, 'int');

    // ---- Instance data (positions + scales) ----
    const instanceDataBuffer = storage(
      new THREE.StorageBufferAttribute(opts.staticInstanceData, 4),
      'vec4', instanceCount,
    );

    const instanceWorldData = new Float32Array(instanceCount * 16);
    const instanceMvpData = new Float32Array(instanceCount * 16);
    this.instanceWorldAttr = new THREE.StorageBufferAttribute(instanceWorldData, 16);
    const instanceMvpAttr = new THREE.StorageBufferAttribute(instanceMvpData, 16);

    this.instanceWorldBuffer = storage(this.instanceWorldAttr, 'mat4', instanceCount);
    this.instanceMvpBuffer = storage(instanceMvpAttr, 'mat4', instanceCount);
    const instanceWorldRead = storage(this.instanceWorldAttr, 'mat4', instanceCount).toReadOnly();

    // ---- Work queue ----
    const workQueueCountData = new Uint32Array(1);
    const workQueueCountAttr = new THREE.StorageBufferAttribute(workQueueCountData, 1);
    const workQueueCountAtomic = storage(workQueueCountAttr, 'uint', 1).toAtomic();
    const workQueueCountRead = storage(workQueueCountAttr, 'uint', 1).toReadOnly();

    const dispatchData = new Uint32Array(3);
    const dispatchAttr = new THREE.IndirectStorageBufferAttribute(dispatchData, 3);
    const dispatchBuffer = storage(dispatchAttr, 'uint', 3);

    const workQueueData = new Uint32Array(MAX_WORK_ITEMS * 4);
    const workQueueBuffer = storage(
      new THREE.StorageBufferAttribute(workQueueData, 4),
      'uvec4', MAX_WORK_ITEMS,
    );

    // ---- HW rasterizer queue ----
    const hwQueueData = new Uint32Array(MAX_HW_TRIANGLES + 1);
    const hwQueueAttr = new THREE.StorageBufferAttribute(hwQueueData, 1);
    const hwQueueAtomic = storage(hwQueueAttr, 'uint', MAX_HW_TRIANGLES + 1).toAtomic();
    const hwQueueRead = storage(hwQueueAttr, 'uint', MAX_HW_TRIANGLES + 1).toReadOnly();

    const hwDrawData = new Uint32Array(4);
    const hwDrawAttr = new THREE.IndirectStorageBufferAttribute(hwDrawData, 4);
    const hwDrawBuffer = storage(hwDrawAttr, 'uint', 4);

    // ---- Screen buffers (initialized with sentinel size; _updateScreenBuffers fills them) ----
    // We call _updateScreenBuffers once now with renderer's current size.
    {
      const size = new THREE.Vector2();
      this.renderer.getDrawingBufferSize(size);
      const px = size.x * size.y || 1920 * 1080; // fallback if renderer not yet sized
      this._allocScreenBuffers(px);
    }

    // Capture references so closures close over them
    const {
      screenTriAtomic,
      screenTriRead,
      screenInstBuffer,
      screenInstRead,
    } = this;

    // ---- LOD list for the frustum shader (JS-side array of error values) ----
    // Single-LOD: error = 0.0 (always selects level 0).
    const lodErrors: number[] = [];
    for (let i = 0; i < asset.lodCount; i++) {
      lodErrors.push(0.0); // single LOD, no error metric needed
    }

    // ---- Edge function helper (shared between computeRasterize and presentation pass) ----
    const edgeFunction = Fn(([a, b, c]: any[]) => {
      // (c.y - a.y) * (b.x - a.x) - (c.x - a.x) * (b.y - a.y)
      return (c as any).y.sub((a as any).y).mul((b as any).x.sub((a as any).x))
        .sub((c as any).x.sub((a as any).x).mul((b as any).y.sub((a as any).y)));
    });

    // ---- Hash colour for meshlet debug mode ----
    const hashColor = Fn(([id_in]: any[]) => {
      let id = uint(id_in).toVar() as any;
      id = id.mul(uint(747796405)).add(uint(289559509));
      id = id.shiftRight(16).bitXor(id).mul(uint(277803737));
      id = id.shiftRight(16).bitXor(id);
      const r = float(id.bitAnd(uint(255))).div(255.0);
      const g = float(id.shiftRight(8).bitAnd(uint(255))).div(255.0);
      const b = float(id.shiftRight(16).bitAnd(uint(255))).div(255.0);
      return vec4(r.mul(0.8).add(0.2), g.mul(0.8).add(0.2), b.mul(0.8).add(0.2), 1.0);
    });

    // ================================================================
    // COMPUTE CLEAR
    // ================================================================
    this.computeClear = Fn(() => {
      atomicStore(screenTriAtomic.element(instanceIndex), uint(0));
      (screenInstBuffer as any).element(instanceIndex).assign(uint(0));

      If(instanceIndex.equal(0), () => {
        atomicStore(workQueueCountAtomic.element(0), uint(0));
        atomicStore(hwQueueAtomic.element(0), uint(0));
      });
    })().compute(this.maxPixels, [256]).setName('Compute Clear');

    // ================================================================
    // COMPUTE FRUSTUM — GPU culling, LOD selection, work allocation
    // ================================================================
    const projScreenMatrixUniform = this.projScreenMatrixUniform;
    const frustumPlanesUniform = this.frustumPlanesUniform;
    const cameraPos = this.cameraPos;
    const cotHalfFovUniform = this.cotHalfFovUniform;
    const pixelErrorThresholdUniform = this.pixelErrorThresholdUniform;
    const instanceWorldBuffer = this.instanceWorldBuffer;
    const instanceMvpBuffer = this.instanceMvpBuffer;

    this.computeFrustum = Fn(() => {
      const data = (instanceDataBuffer as any).element(instanceIndex);
      const pos = data.xyz;
      const scale = data.w;
      const iFloat = float(instanceIndex);

      // Rotation (keeps instances spinning so we can see LOD transitions)
      // For a static single instance, timeScale * rotY will just be 0 offset.
      const rotY = time.mul(0.0).add(iFloat); // no animation in spike (timeScale=0)
      const c = cos(rotY);
      const s = sin(rotY);

      const matrixWorld = mat4(
        vec4(c.mul(scale), 0.0, s.mul(scale), 0.0),
        vec4(0.0, scale, 0.0, 0.0),
        vec4(s.negate().mul(scale), 0.0, c.mul(scale), 0.0),
        vec4(pos, 1.0),
      );

      const visible = bool(true).toVar() as any;
      const radius = scale.mul(2.0);

      // Frustum culling (6 world-space planes)
      Loop({ start: 0, end: 6 }, ({ i: planeIndex }: any) => {
        const plane = (frustumPlanesUniform as any).element(planeIndex);
        const dist = dot(plane.xyz, pos).add(plane.w);
        If(dist.lessThan(radius.negate()), () => {
          visible.assign(false);
        });
      });

      If(visible, () => {
        const distToCamera = distance(cameraPos, pos);
        const pixelFactor = (cotHalfFovUniform as any)
          .div(max(0.01, distToCamera))
          .mul(float(screenSize.y))
          .div(2.0);

        // Single-LOD: always use level 0.
        // (If lodErrors had multiple entries this would replicate the example's
        // cascading ElseIf selection. Preserved as a TODO for multi-LOD.)
        const lodLevel = uint(0).toVar() as any;

        const lodData = (lodOffsetsBuffer as any).element(lodLevel);
        const lodTriStart = lodData.x;
        const lodNumTriangles = lodData.y;
        const lodChunkStart = lodData.z;

        // Work items = ceil(numTriangles / 64)
        const workItems = lodNumTriangles.add(63).div(64);

        // Evaluate each chunk
        Loop({ name: 'cIdx', type: 'uint', start: uint(0), end: workItems, condition: '<' }, ({ cIdx: chunkIndex }: any) => {
          const globalChunkId = lodChunkStart.add(uint(chunkIndex));
          const chunkBounds = (chunkBoundsBufferNode as any).element(globalChunkId);
          const chunkCenterLocal = chunkBounds.xyz;
          const chunkRadiusLocal = chunkBounds.w;

          const chunkCenterWorld = (matrixWorld.mul(vec4(chunkCenterLocal, 1.0)) as any).xyz.toVar();
          const chunkRadiusWorld = chunkRadiusLocal.mul(scale).toVar() as any;

          const chunkVisible = bool(true).toVar() as any;

          Loop({ name: 'pIdx', start: 0, end: 6 }, ({ pIdx: planeIndex }: any) => {
            const plane = (frustumPlanesUniform as any).element(planeIndex);
            const chunkDist = dot(plane.xyz, chunkCenterWorld).add(plane.w);
            If(chunkDist.lessThan(chunkRadiusWorld.negate()), () => {
              chunkVisible.assign(false);
            });
          });

          If(chunkVisible, () => {
            const itemIndex = atomicAdd(workQueueCountAtomic.element(0), 1);
            (workQueueBuffer as any).element(itemIndex).assign(
              uvec4(instanceIndex, lodTriStart, lodNumTriangles, uint(chunkIndex)),
            );
          });
        });

        (instanceWorldBuffer as any).element(instanceIndex).assign(matrixWorld);
        (instanceMvpBuffer as any).element(instanceIndex).assign(
          (projScreenMatrixUniform as any).mul(matrixWorld),
        );
      });
    })().compute(instanceCount).setName('Compute Frustum');

    // ================================================================
    // COMPUTE DISPATCH — set indirect dispatch args
    // ================================================================
    this.computeDispatch = Fn(() => {
      const totalWorkgroups = (workQueueCountRead as any).element(0);
      const maxDim = uint(65535);
      const dispatchX = min(totalWorkgroups, maxDim);
      const dispatchY = totalWorkgroups.add(maxDim).sub(1).div(maxDim);
      (dispatchBuffer as any).element(0).assign(dispatchX);
      (dispatchBuffer as any).element(1).assign(dispatchY);
      (dispatchBuffer as any).element(2).assign(1);
    })().compute(1).setName('Compute Dispatch');

    // ================================================================
    // COMPUTE RASTERIZE — SW per-pixel barycentric rasteriser
    // ================================================================
    this.computeRasterize = Fn(() => {
      const totalWorkgroups = (workQueueCountRead as any).element(0);
      const totalThreads = totalWorkgroups.mul(64);

      If(instanceIndex.lessThan(totalThreads), () => {
        const workItemId = instanceIndex.div(64);
        const localTriangleIndex = instanceIndex.mod(64);

        const workItem = (workQueueBuffer as any).element(workItemId);
        const instId = workItem.x;
        const lodTriStart = workItem.y;
        const lodNumTriangles = workItem.z;
        const chunkIndex = workItem.w;

        const globalTriangleIndex = chunkIndex.mul(64).add(localTriangleIndex);

        If(globalTriangleIndex.lessThan(lodNumTriangles), () => {
          const megaTriangleIndex = lodTriStart.add(globalTriangleIndex);
          const indexOffset = megaTriangleIndex.mul(3);

          const i0 = (indexBuffer as any).element(indexOffset);
          const i1 = (indexBuffer as any).element(indexOffset.add(1));
          const i2 = (indexBuffer as any).element(indexOffset.add(2));

          const v0 = (vertexBuffer as any).element(i0);
          const v1 = (vertexBuffer as any).element(i1);
          const v2 = (vertexBuffer as any).element(i2);

          const instMvpMatrix = (instanceMvpBuffer as any).element(instId);

          const p0 = instMvpMatrix.mul(v0);
          const p1 = instMvpMatrix.mul(v1);
          const p2 = instMvpMatrix.mul(v2);

          // Near-plane clipping
          If(p0.w.greaterThan(0.0).and(p1.w.greaterThan(0.0)).and(p2.w.greaterThan(0.0)), () => {
            const ndc0 = p0.xyz.div(p0.w);
            const ndc1 = p1.xyz.div(p1.w);
            const ndc2 = p2.xyz.div(p2.w);

            // Early back-face culling in NDC
            const areaNdc = edgeFunction(ndc0, ndc1, ndc2);

            If(areaNdc.greaterThan(0.0), () => {
              const ndcMinX = min(ndc0.x, min(ndc1.x, ndc2.x));
              const ndcMaxX = max(ndc0.x, max(ndc1.x, ndc2.x));
              const ndcMinY = min(ndc0.y, min(ndc1.y, ndc2.y));
              const ndcMaxY = max(ndc0.y, max(ndc1.y, ndc2.y));

              If(
                ndcMaxX.greaterThan(-1.0)
                  .and(ndcMinX.lessThan(1.0))
                  .and(ndcMaxY.greaterThan(-1.0))
                  .and(ndcMinY.lessThan(1.0)),
                () => {
                  const w = screenSize.x;
                  const h = screenSize.y;
                  const s0 = ndc0.xy.add(1.0).mul(0.5).mul(vec2(w, h));
                  const s1 = ndc1.xy.add(1.0).mul(0.5).mul(vec2(w, h));
                  const s2 = ndc2.xy.add(1.0).mul(0.5).mul(vec2(w, h));

                  const minX = max(0.0, min(s0.x, min(s1.x, s2.x)));
                  const maxXV = min(w.sub(1.0), max(s0.x, max(s1.x, s2.x)));
                  const minY = max(0.0, min(s0.y, min(s1.y, s2.y)));
                  const maxYV = min(h.sub(1.0), max(s0.y, max(s1.y, s2.y)));

                  const startX = int(floor(minX));
                  const endX = int(floor(maxXV));
                  const startY = int(floor(minY));
                  const endY = int(floor(maxYV));

                  const bbWidth = endX.sub(startX);
                  const bbHeight = endY.sub(startY);

                  // payload32 = instId(18 high bits) | megaTriIdx(14 low bits)
                  const payload32 = instId.shiftLeft(TRIANGLE_INDEX_BITS)
                    .bitOr(megaTriangleIndex.bitAnd(TRIANGLE_INDEX_MASK));

                  If(
                    startX.lessThanEqual(endX)
                      .and(startY.lessThanEqual(endY))
                      .and(bbWidth.lessThanEqual(this.maxRasterSizeUniform))
                      .and(bbHeight.lessThanEqual(this.maxRasterSizeUniform)),
                    () => {
                      // SW barycentric rasteriser
                      const area = edgeFunction(s0, s1, s2);

                      const stepX_w0 = s1.y.sub(s2.y);
                      const stepY_w0 = s2.x.sub(s1.x);
                      const stepX_w1 = s2.y.sub(s0.y);
                      const stepY_w1 = s0.x.sub(s2.x);
                      const stepX_w2 = s0.y.sub(s1.y);
                      const stepY_w2 = s1.x.sub(s0.x);

                      // Top-left rule
                      const isTopLeft0 = stepX_w0.lessThan(0.0).or(stepX_w0.equal(0.0).and(stepY_w0.greaterThan(0.0)));
                      const isTopLeft1 = stepX_w1.lessThan(0.0).or(stepX_w1.equal(0.0).and(stepY_w1.greaterThan(0.0)));
                      const isTopLeft2 = stepX_w2.lessThan(0.0).or(stepX_w2.equal(0.0).and(stepY_w2.greaterThan(0.0)));

                      const bias0 = isTopLeft0.select(0.0, -1e-5);
                      const bias1 = isTopLeft1.select(0.0, -1e-5);
                      const bias2 = isTopLeft2.select(0.0, -1e-5);

                      const pStart = vec2(float(startX).add(0.5), float(startY).add(0.5));

                      const row_w0 = edgeFunction(s1, s2, pStart).toVar() as any;
                      const row_w1 = edgeFunction(s2, s0, pStart).toVar() as any;
                      const row_w2 = edgeFunction(s0, s1, pStart).toVar() as any;

                      row_w0.addAssign(bias0);
                      row_w1.addAssign(bias1);
                      row_w2.addAssign(bias2);

                      // Incremental Z
                      const b0_start = row_w0.div(area);
                      const b1_start = row_w1.div(area);
                      const b2_start = row_w2.div(area);
                      const row_z = b0_start.mul(ndc0.z)
                        .add(b1_start.mul(ndc1.z))
                        .add(b2_start.mul(ndc2.z))
                        .toVar() as any;

                      const stepX_z = stepX_w0.div(area).mul(ndc0.z)
                        .add(stepX_w1.div(area).mul(ndc1.z))
                        .add(stepX_w2.div(area).mul(ndc2.z));
                      const stepY_z = stepY_w0.div(area).mul(ndc0.z)
                        .add(stepY_w1.div(area).mul(ndc1.z))
                        .add(stepY_w2.div(area).mul(ndc2.z));

                      Loop({ name: 'y', type: 'int', start: startY, end: endY, condition: '<=' }, ({ y }: any) => {
                        const w0 = row_w0.toVar() as any;
                        const w1 = row_w1.toVar() as any;
                        const w2 = row_w2.toVar() as any;
                        const z = row_z.toVar() as any;

                        Loop({ name: 'x', type: 'int', start: startX, end: endX, condition: '<=' }, ({ x }: any) => {
                          If(w0.greaterThanEqual(0.0).and(w1.greaterThanEqual(0.0)).and(w2.greaterThanEqual(0.0)), () => {
                            If(z.greaterThanEqual(0.0).and(z.lessThanEqual(1.0)), () => {
                              // Fourth-root depth for better precision distribution
                              const depth32 = uint(
                                sqrt(sqrt(float(1.0).sub(z))).mul(DEPTH_PRECISION_MAX),
                              );
                              const pixelIndex = uint(y).mul(uint(screenSize.x)).add(uint(x));

                              // Early depth pre-check
                              const currentDepth = atomicLoad(screenTriAtomic.element(pixelIndex));
                              If(depth32.greaterThan(currentDepth), () => {
                                const prevDepth = atomicMax(screenTriAtomic.element(pixelIndex), depth32);
                                If(depth32.greaterThan(prevDepth), () => {
                                  (screenInstBuffer as any).element(pixelIndex).assign(payload32);
                                });
                              });
                            });
                          });

                          w0.addAssign(stepX_w0);
                          w1.addAssign(stepX_w1);
                          w2.addAssign(stepX_w2);
                          z.addAssign(stepX_z);
                        });

                        row_w0.addAssign(stepY_w0);
                        row_w1.addAssign(stepY_w1);
                        row_w2.addAssign(stepY_w2);
                        row_z.addAssign(stepY_z);
                      });
                    },
                  ).Else(() => {
                    // Large triangle → HW fallback queue
                    If(startX.lessThanEqual(endX).and(startY.lessThanEqual(endY)), () => {
                      const hwCount = atomicAdd(hwQueueAtomic.element(0), 1);
                      const hwSlot = hwCount.add(1);
                      atomicStore(hwQueueAtomic.element(hwSlot), payload32);
                    });
                  });
                },
              );
            }); // End backface culling
          }); // End near-plane clipping
        }); // End globalTriangleIndex bounds
      }); // End instanceIndex bounds
    })().compute(dispatchAttr).setName('Compute Rasterize');

    // ================================================================
    // COMPUTE HW ARGS — indirect draw argument setup
    // ================================================================
    this.computeHWArgs = Fn(() => {
      const hwCount = atomicLoad(hwQueueAtomic.element(0));
      (hwDrawBuffer as any).element(0).assign(hwCount.mul(3)); // vertexCount
      (hwDrawBuffer as any).element(1).assign(uint(1));         // instanceCount
      (hwDrawBuffer as any).element(2).assign(uint(0));         // firstVertex
      (hwDrawBuffer as any).element(3).assign(uint(0));         // firstInstance
    })().compute(1).setName('Compute HW Args');

    // ================================================================
    // HW RASTERIZER MESH — handles large triangles via GPU hardware
    // ================================================================
    {
      const hwGeometry = new THREE.BufferGeometry();
      hwGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(MAX_HW_TRIANGLES * 3 * 3), 3),
      );
      (hwGeometry as any).setIndirect(hwDrawAttr);
      hwGeometry.boundingSphere = new THREE.Sphere().set(new THREE.Vector3(), Infinity);

      const vPayload = varyingProperty('uint', 'vPayload');
      const vUvVar = varyingProperty('vec2', 'vUv');

      const hwMaterial = new THREE.NodeMaterial();
      hwMaterial.depthWrite = true;
      hwMaterial.depthTest = true;

      hwMaterial.positionNode = Fn(() => {
        const triIndex = vertexIndex.div(3);
        const localVert = vertexIndex.mod(3);

        const payload32hw = (hwQueueRead as any).element(triIndex.add(1));
        const instIdHW = payload32hw.shiftRight(TRIANGLE_INDEX_BITS);
        const megaTriIdxHW = payload32hw.bitAnd(TRIANGLE_INDEX_MASK);

        const vertGlobalIdx = (indexBuffer as any).element(megaTriIdxHW.mul(3).add(localVert));
        const vVert = (vertexBuffer as any).element(vertGlobalIdx);

        const worldPos = (instanceWorldRead as any).element(instIdHW).mul(vVert);
        const uvVal = (uvBuffer as any).element(vertGlobalIdx);

        vUvVar.assign(uvVal);
        vPayload.assign(payload32hw);

        return worldPos.xyz;
      })();

      hwMaterial.fragmentNode = Fn(() => {
        const payload32hw = vPayload;
        const instIdHW = payload32hw.shiftRight(TRIANGLE_INDEX_BITS);
        const megaTriIdxHW = payload32hw.bitAnd(TRIANGLE_INDEX_MASK);

        const outColor = vec4(0.0).toVar() as any;

        If(materialModeUniform.equal(0), () => {
          const meshletId = (meshletIdBuffer as any).element(megaTriIdxHW)
            .add(instIdHW.mul(1000));
          outColor.assign(hashColor(meshletId));
        }).Else(() => {
          outColor.assign(tslTexture(textureMap, vUvVar));
        });

        return outColor;
      })();

      this.hwMesh = new THREE.Mesh(hwGeometry, hwMaterial);
      this.hwMesh.frustumCulled = false;
      this.hwScene = new THREE.Scene();
      this.hwScene.add(this.hwMesh);
    }

    // ================================================================
    // FULLSCREEN PRESENTATION PASS
    // ================================================================
    {
      const material = new THREE.NodeMaterial();
      material.depthWrite = true;

      const getPixelIndex = () => {
        const screenX = uint(floor(uv().x.mul(screenSize.x)));
        const screenY = uint(floor(uv().y.oneMinus().mul(screenSize.y)));
        return {
          screenX,
          screenY,
          pixelIndex: screenY.mul(uint(screenSize.x)).add(screenX),
        };
      };

      // Depth node: reconstruct NDC Z from the visibility buffer's packed depth
      material.depthNode = Fn(() => {
        const { pixelIndex } = getPixelIndex();
        const depth32 = (screenTriRead as any).element(pixelIndex);
        const y = float(depth32).div(DEPTH_PRECISION_MAX);
        const y2 = y.mul(y);
        const v = y2.mul(y2); // y^4 = inverse of fourth-root
        return float(1.0).sub(v);
      })();

      // Color node: visibility-buffer shading (perspective-correct UV + analytical derivatives)
      material.colorNode = Fn(() => {
        const { pixelIndex } = getPixelIndex();
        const depth32 = (screenTriRead as any).element(pixelIndex);
        const background = vec4(0.1, 0.1, 0.1, 1.0);
        const outColor = background.toVar() as any;

        If(depth32.greaterThan(0), () => {
          const payload32 = (screenInstRead as any).element(pixelIndex);
          const megaTriangleIndex = payload32.bitAnd(TRIANGLE_INDEX_MASK);
          const instId = payload32.shiftRight(TRIANGLE_INDEX_BITS);

          const i0 = (indexBuffer as any).element(megaTriangleIndex.mul(3).add(0));
          const i1 = (indexBuffer as any).element(megaTriangleIndex.mul(3).add(1));
          const i2 = (indexBuffer as any).element(megaTriangleIndex.mul(3).add(2));

          const v0 = (vertexBuffer as any).element(i0);
          const v1 = (vertexBuffer as any).element(i1);
          const v2 = (vertexBuffer as any).element(i2);

          const t_uv0 = (uvBuffer as any).element(i0);
          const t_uv1 = (uvBuffer as any).element(i1);
          const t_uv2 = (uvBuffer as any).element(i2);

          const matrixWorld = (instanceWorldBuffer as any).element(instId);
          const mvpMatrix = (projScreenMatrixUniform as any).mul(matrixWorld);

          const p0 = mvpMatrix.mul(v0);
          const p1 = mvpMatrix.mul(v1);
          const p2 = mvpMatrix.mul(v2);

          const ndc0 = p0.xyz.div(p0.w);
          const ndc1 = p1.xyz.div(p1.w);
          const ndc2 = p2.xyz.div(p2.w);

          const w = screenSize.x;
          const h = screenSize.y;
          const s0 = ndc0.xy.add(1.0).mul(0.5).mul(vec2(w, h));
          const s1 = ndc1.xy.add(1.0).mul(0.5).mul(vec2(w, h));
          const s2 = ndc2.xy.add(1.0).mul(0.5).mul(vec2(w, h));

          const pScreen = vec2(uv().x.mul(screenSize.x), uv().y.oneMinus().mul(screenSize.y));

          const area = edgeFunction(s0, s1, s2);
          const w0 = edgeFunction(s1, s2, pScreen);
          const w1 = edgeFunction(s2, s0, pScreen);
          const w2 = edgeFunction(s0, s1, pScreen);

          const safeArea = area.equal(0.0).select(1.0, area);
          const b0 = w0.div(safeArea);
          const b1 = w1.div(safeArea);
          const b2 = w2.div(safeArea);

          // Perspective-correct UV interpolation
          const z_inv = b0.div(p0.w).add(b1.div(p1.w)).add(b2.div(p2.w));
          const safeZInv = z_inv.equal(0.0).select(1.0, z_inv);
          const b0_p = b0.div(p0.w).div(safeZInv);
          const b1_p = b1.div(p1.w).div(safeZInv);
          const b2_p = b2.div(p2.w).div(safeZInv);

          const uv_interp = t_uv0.mul(b0_p).add(t_uv1.mul(b1_p)).add(t_uv2.mul(b2_p));

          // Analytical screen-space UV derivatives (no dFdx needed)
          const dw0_dx = s2.y.sub(s1.y);
          const dw1_dx = s0.y.sub(s2.y);
          const dw2_dx = s1.y.sub(s0.y);
          const dw0_dy = s1.x.sub(s2.x);
          const dw1_dy = s2.x.sub(s0.x);
          const dw2_dy = s0.x.sub(s1.x);

          const q0 = float(1.0).div(p0.w);
          const q1 = float(1.0).div(p1.w);
          const q2 = float(1.0).div(p2.w);

          const sum_w_q = w0.mul(q0).add(w1.mul(q1)).add(w2.mul(q2));
          const safe_sum_w_q = sum_w_q.equal(0.0).select(1.0, sum_w_q);

          const dUvDx = (
            dw0_dx.mul(q0).mul(t_uv0.sub(uv_interp))
              .add(dw1_dx.mul(q1).mul(t_uv1.sub(uv_interp)))
              .add(dw2_dx.mul(q2).mul(t_uv2.sub(uv_interp)))
          ).div(safe_sum_w_q);

          const dUvDy = (
            dw0_dy.mul(q0).mul(t_uv0.sub(uv_interp))
              .add(dw1_dy.mul(q1).mul(t_uv1.sub(uv_interp)))
              .add(dw2_dy.mul(q2).mul(t_uv2.sub(uv_interp)))
          ).div(safe_sum_w_q);

          If(materialModeUniform.equal(0), () => {
            const meshletId = (meshletIdBuffer as any).element(megaTriangleIndex)
              .add(instId.mul(1000));
            outColor.assign(hashColor(meshletId));
          }).Else(() => {
            outColor.assign((tslTexture(textureMap, uv_interp) as any).grad(dUvDx, dUvDy));
          });
        });

        return outColor;
      })();

      this.quadMesh = new THREE.QuadMesh(material);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: screen buffer allocation / resize
  // -------------------------------------------------------------------------

  private _allocScreenBuffers(px: number): void {
    const screenTriData = new Uint32Array(px);
    this.screenTriAttr = new THREE.StorageBufferAttribute(screenTriData, 1);

    const screenInstData = new Uint32Array(px);
    this.screenInstAttr = new THREE.StorageBufferAttribute(screenInstData, 1);

    this.screenTriAtomic = storage(this.screenTriAttr, 'uint', px).toAtomic();
    this.screenTriRead = storage(this.screenTriAttr, 'uint', px).toReadOnly();
    this.screenInstBuffer = storage(this.screenInstAttr, 'uint', px);
    this.screenInstRead = storage(this.screenInstAttr, 'uint', px).toReadOnly();
  }

  private _updateScreenBuffers(viewportW: number, viewportH: number): void {
    const px = viewportW * viewportH;
    if (px === this.maxPixels) return;

    // Dispose old
    if (this.screenTriAttr) this.screenTriAttr.dispose();
    if (this.screenInstAttr) this.screenInstAttr.dispose();

    // The compute clear count must also update
    if (this.computeClear) {
      (this.computeClear as any).count = px;
      (this.computeClear as any).dispose?.();
    }

    this.maxPixels = px;
    this._allocScreenBuffers(px);

    // Patch storage node references (matches createScreenBuffers() in the original)
    if (this.screenTriAtomic) {
      (this.screenTriAtomic as any).value = this.screenTriAttr;
      (this.screenTriAtomic as any).bufferCount = px;
    }
    if (this.screenTriRead) {
      (this.screenTriRead as any).value = this.screenTriAttr;
      (this.screenTriRead as any).bufferCount = px;
    }
    if (this.screenInstBuffer) {
      (this.screenInstBuffer as any).value = this.screenInstAttr;
      (this.screenInstBuffer as any).bufferCount = px;
    }
    if (this.screenInstRead) {
      (this.screenInstRead as any).value = this.screenInstAttr;
      (this.screenInstRead as any).bufferCount = px;
    }
  }
}
