/**
 * compress-ktx2.ts
 *
 * Converts selected world GLB textures to KTX2 (KHR_texture_basisu), writing
 * NEW sibling files named <name>-ktx.glb. Color/data maps use ETC1S; normal
 * maps use UASTC so their direction vectors survive compression cleanly.
 *
 * Source GLBs are the current shipped assets in apps/web/public/models. Most
 * source textures are embedded WebP; gltf-transform's texture commands cannot
 * encode WebP directly, so this script builds a temporary GLB that remaps every
 * eligible WebP texture slot to PNG before encoding.
 *
 * Usage from repo root:
 *   bun run scripts/compress-ktx2.ts
 *
 * Requirements:
 *   - toktx in PATH (Scoop: C:\Users\itachi\scoop\shims\toktx.exe)
 *   - @gltf-transform/cli available through bunx
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const MODELS_DIR = path.resolve('apps/web/public/models');
const QLEVEL = 192;
const ETC1S_SLOT_NAMES = [
  'baseColorTexture',
  'emissiveTexture',
  'metallicRoughnessTexture',
  'occlusionTexture',
  'diffuseTexture',
  'specularGlossinessTexture',
  'specularTexture',
  'specularColorTexture',
] as const;
const UASTC_SLOT_NAMES = ['normalTexture'] as const;

function buildSlotPattern(slotNames: readonly string[]): string {
  if (slotNames.length === 0) throw new Error('Texture slot pattern cannot be empty');
  return slotNames.length === 1 ? slotNames[0] : `{${slotNames.join(',')}}`;
}

const ETC1S_SLOTS = buildSlotPattern(ETC1S_SLOT_NAMES);
const UASTC_SLOTS = buildSlotPattern(UASTC_SLOT_NAMES);
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function resolveToktxBinDir(): string | null {
  const configured = process.env.KTX2_TOKTX_BIN;
  if (configured && fs.existsSync(path.join(configured, 'toktx.exe'))) return configured;

  const scoopAppDir = path.join(os.homedir(), 'scoop', 'apps', 'ktx-software');
  if (!fs.existsSync(scoopAppDir)) return null;
  const candidates = fs.readdirSync(scoopAppDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(scoopAppDir, entry.name, 'bin'))
    .filter((binDir) => fs.existsSync(path.join(binDir, 'toktx.exe')))
    .sort()
    .reverse();
  return candidates[0] ?? null;
}

type Status = 'ok' | 'skipped' | 'error';

interface Target {
  path: string;
  note?: string;
}

interface Result {
  source: string;
  output?: string;
  sizeBefore: number;
  sizeAfter: number;
  converted: number;
  skippedBySlot: Record<string, number>;
  status: Status;
  reason?: string;
}

const TARGETS: Target[] = [
  // arena-buildings.tsx BUILDING_MODELS.
  { path: 'pineapple-house-opt1.glb' },
  { path: 'chum-bucket-v2-opt1.glb' },
  { path: 'krusty-krab-v2-opt1.glb' },
  { path: 'sandy-treedome-v3-opt1.glb', note: 'referenced config, procedural at runtime' },
  { path: 'salty-spitoon-opt1.glb' },
  { path: 'boating-school-opt1.glb' },
  { path: 'patty-building-opt1.glb' },
  { path: 'building-lighthouse-opt1.glb' },
  { path: 'arcade/claw-arcade-exterior-opt1.glb' },
  { path: 'cove/cove-exterior-opt1.glb' },
  { path: 'patricks-rock-v2-opt1.glb' },
  { path: 'squidward-house-opt1.glb' },

  // Cove interior.
  { path: 'cove/cove-interior-cleaned-v1.glb' },

  // Town-center stalls / props. town-directory-sign.tsx is procedural.
  { path: 'bazaar-merchant-stand.glb' },
  { path: 'shisha-oasis.glb' },
  { path: 'quest-bounty-pavilion.glb' },

  // arena-terrain.tsx DECO_MODEL_PATHS.
  { path: 'coral-reef1.glb' },
  { path: 'coral-reef2.glb' },
  { path: 'coral-reef3.glb' },
  { path: 'kelp.glb' },
  { path: 'building-shell.glb' },
  { path: 'building-seashell.glb' },
  { path: 'building-anchor.glb' },
  { path: 'building-barrel.glb' },
  { path: 'building-chest.glb' },
  { path: 'building-lantern.glb' },
  { path: 'crayfish.glb' },
  { path: 'building-tower2.glb' },

  // arena-npcs.tsx SPECIES_MODEL / agent-model-registry.ts GLB species.
  { path: 'lobster.glb' },
  { path: 'sweet_crab_sketchfabweekly.glb' },
  { path: 'lobster_plush.glb' },
  { path: 'hermitcrab.glb' },
  { path: 'jellyfish.glb' },
  { path: 'octopus_toy.glb' },
  { path: 'sea_horse.glb' },

  // sea-creature-animator.ts dynamic rigged lobster paths.
  { path: 'sea-creatures/lobster/base.glb' },
  { path: 'sea-creatures/lobster/animations/idle.glb' },
  { path: 'sea-creatures/lobster/animations/swim.glb' },
  { path: 'sea-creatures/lobster/animations/hit.glb' },

  // Location-NPC teachers. Keep sandy-static-backup.glb as an untouched backup.
  { path: 'characters/spongebob.glb' },
  { path: 'characters/gary.glb' },
  { path: 'characters/squidward.glb' },
  { path: 'characters/flying-dutchman.glb' },
  { path: 'characters/pearl.glb' },
  { path: 'characters/mrs-puff.glb' },
  { path: 'characters/mr-krabs.glb' },
  { path: 'characters/plankton.glb' },
  { path: 'characters/karen.glb' },
  { path: 'characters/sandy.glb' },
  { path: 'characters/patrick.glb' },
];

const ETC1S_SLOT_SET = new Set<string>(ETC1S_SLOT_NAMES);
const UASTC_SLOT_SET = new Set<string>(UASTC_SLOT_NAMES);
const ALLOWED_SLOTS = new Set<string>([
  ...ETC1S_SLOT_NAMES,
  ...UASTC_SLOT_NAMES,
]);

function formatBytes(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function outputPathFor(sourceRel: string): string {
  const ext = path.extname(sourceRel);
  const base = sourceRel.slice(0, -ext.length);
  return `${base}-ktx${ext}`;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

interface GlbData {
  json: any;
  bin: Buffer;
}

function readGlb(filePath: string): GlbData {
  const buf = fs.readFileSync(filePath);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('bad GLB magic');
  }

  let offset = 12;
  let json: any | null = null;
  let bin: Buffer | null = null;

  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const chunk = buf.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) {
      const text = chunk.toString('utf8').replace(/\0+$/g, '').trimEnd();
      json = JSON.parse(text);
    } else if (type === BIN_CHUNK) {
      bin = Buffer.from(chunk);
    }
    offset += 8 + length;
  }

  if (!json) throw new Error('missing JSON chunk');
  if (!bin) bin = Buffer.alloc(0);
  return { json, bin };
}

function writeGlb(filePath: string, json: any, bin: Buffer): void {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPaddedLength = align4(jsonBytes.length);
  const binPaddedLength = align4(bin.length);
  const totalLength = 12 + 8 + jsonPaddedLength + (binPaddedLength ? 8 + binPaddedLength : 0);

  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);

  let offset = 12;
  out.writeUInt32LE(jsonPaddedLength, offset);
  out.writeUInt32LE(JSON_CHUNK, offset + 4);
  jsonBytes.copy(out, offset + 8);
  out.fill(0x20, offset + 8 + jsonBytes.length, offset + 8 + jsonPaddedLength);
  offset += 8 + jsonPaddedLength;

  if (binPaddedLength) {
    out.writeUInt32LE(binPaddedLength, offset);
    out.writeUInt32LE(BIN_CHUNK, offset + 4);
    bin.copy(out, offset + 8);
    out.fill(0x00, offset + 8 + bin.length, offset + 8 + binPaddedLength);
  }

  fs.writeFileSync(filePath, out);
}

function pushSlot(slotsByTexture: Map<number, Set<string>>, textureIndex: unknown, slot: string): void {
  if (typeof textureIndex !== 'number') return;
  if (!slotsByTexture.has(textureIndex)) slotsByTexture.set(textureIndex, new Set());
  slotsByTexture.get(textureIndex)!.add(slot);
}

function getTextureSlots(json: any): Map<number, Set<string>> {
  const slotsByTexture = new Map<number, Set<string>>();
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    pushSlot(slotsByTexture, pbr.baseColorTexture?.index, 'baseColorTexture');
    pushSlot(slotsByTexture, pbr.metallicRoughnessTexture?.index, 'metallicRoughnessTexture');
    pushSlot(slotsByTexture, material.normalTexture?.index, 'normalTexture');
    pushSlot(slotsByTexture, material.occlusionTexture?.index, 'occlusionTexture');
    pushSlot(slotsByTexture, material.emissiveTexture?.index, 'emissiveTexture');

    const specGloss = material.extensions?.KHR_materials_pbrSpecularGlossiness;
    pushSlot(slotsByTexture, specGloss?.diffuseTexture?.index, 'diffuseTexture');
    pushSlot(
      slotsByTexture,
      specGloss?.specularGlossinessTexture?.index,
      'specularGlossinessTexture',
    );

    const specular = material.extensions?.KHR_materials_specular;
    pushSlot(slotsByTexture, specular?.specularTexture?.index, 'specularTexture');
    pushSlot(slotsByTexture, specular?.specularColorTexture?.index, 'specularColorTexture');
  }
  return slotsByTexture;
}

function getTextureSource(json: any, textureIndex: number): number | null {
  const texture = json.textures?.[textureIndex];
  const webpSource = texture?.extensions?.EXT_texture_webp?.source;
  if (typeof webpSource === 'number') return webpSource;
  if (typeof texture?.source === 'number') return texture.source;
  return null;
}

function countSkippedSlots(slotsByTexture: Map<number, Set<string>>): Record<string, number> {
  const skipped: Record<string, number> = {};
  for (const slots of slotsByTexture.values()) {
    for (const slot of slots) {
      if (!ALLOWED_SLOTS.has(slot)) skipped[slot] = (skipped[slot] ?? 0) + 1;
    }
  }
  return skipped;
}

function normalizeTextureInfoExtensions(json: any): void {
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    for (const textureInfo of [
      pbr.baseColorTexture,
      pbr.metallicRoughnessTexture,
      material.normalTexture,
      material.occlusionTexture,
      material.emissiveTexture,
      material.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture,
      material.extensions?.KHR_materials_pbrSpecularGlossiness?.specularGlossinessTexture,
      material.extensions?.KHR_materials_specular?.specularTexture,
      material.extensions?.KHR_materials_specular?.specularColorTexture,
    ]) {
      if (textureInfo) textureInfo.extensions ??= {};
    }
  }
}

function hasEligibleTexture(json: any, textureIndex: number, slots: Set<string>): boolean {
  if (![...slots].some((slot) => ALLOWED_SLOTS.has(slot))) return false;
  const sourceIndex = getTextureSource(json, textureIndex);
  if (sourceIndex == null) return false;
  const mimeType = json.images?.[sourceIndex]?.mimeType;
  return mimeType === 'image/webp' || mimeType === 'image/png' || mimeType === 'image/jpeg';
}

async function prepareKtx2Input(sourceAbs: string, tempAbs: string): Promise<{
  converted: number;
  etc1sConverted: number;
  uastcConverted: number;
  hadMeshopt: boolean;
  skippedBySlot: Record<string, number>;
}> {
  const { json, bin } = readGlb(sourceAbs);
  const usedExtensions = new Set<string>([
    ...(json.extensionsUsed ?? []),
    ...(json.extensionsRequired ?? []),
  ]);

  if (
    usedExtensions.has('KHR_materials_clearcoat') &&
    usedExtensions.has('KHR_draco_mesh_compression')
  ) {
    throw new Error('skip: KHR_materials_clearcoat + KHR_draco_mesh_compression');
  }

  const slotsByTexture = getTextureSlots(json);
  const eligibleTextureIndexes = [...slotsByTexture.entries()]
    .filter(([textureIndex, slots]) => hasEligibleTexture(json, textureIndex, slots))
    .map(([textureIndex]) => textureIndex);

  const skippedBySlot = countSkippedSlots(slotsByTexture);
  if (!eligibleTextureIndexes.length) {
    throw new Error('skip: no supported PNG/JPEG/WebP texture slots');
  }

  const etc1sTextureIndexes = [...slotsByTexture.entries()]
    .filter(([textureIndex, slots]) =>
      hasEligibleTexture(json, textureIndex, slots) &&
      [...slots].some((slot) => ETC1S_SLOT_SET.has(slot)),
    )
    .map(([textureIndex]) => textureIndex);
  const uastcTextureIndexes = [...slotsByTexture.entries()]
    .filter(([textureIndex, slots]) =>
      hasEligibleTexture(json, textureIndex, slots) &&
      [...slots].some((slot) => UASTC_SLOT_SET.has(slot)),
    )
    .map(([textureIndex]) => textureIndex);

  let nextBin = Buffer.from(bin);
  const convertedImageIndexes = new Set<number>();

  for (const textureIndex of eligibleTextureIndexes) {
    const sourceIndex = getTextureSource(json, textureIndex);
    if (sourceIndex == null || convertedImageIndexes.has(sourceIndex)) continue;

    const image = json.images[sourceIndex];
    if (image.mimeType !== 'image/webp') {
      convertedImageIndexes.add(sourceIndex);
      continue;
    }

    const view = json.bufferViews?.[image.bufferView];
    if (!view || view.buffer !== 0) {
      throw new Error(`unsupported WebP image bufferView for texture ${textureIndex}`);
    }

    const byteOffset = view.byteOffset ?? 0;
    const webpBytes = bin.subarray(byteOffset, byteOffset + view.byteLength);
    const pngBytes = await sharp(webpBytes).png().toBuffer();

    const alignedOffset = align4(nextBin.length);
    if (alignedOffset > nextBin.length) {
      nextBin = Buffer.concat([nextBin, Buffer.alloc(alignedOffset - nextBin.length)]);
    }

    const newViewIndex = json.bufferViews.length;
    json.bufferViews.push({
      buffer: 0,
      byteOffset: alignedOffset,
      byteLength: pngBytes.length,
    });
    nextBin = Buffer.concat([nextBin, pngBytes]);
    image.bufferView = newViewIndex;
    image.mimeType = 'image/png';
    convertedImageIndexes.add(sourceIndex);
  }

  // A converted image can be shared by multiple glTF textures. Remap every
  // reference to it, not only the eligible slot that caused the conversion.
  for (const texture of json.textures ?? []) {
    const webpSource = texture?.extensions?.EXT_texture_webp?.source;
    if (typeof webpSource !== 'number' || !convertedImageIndexes.has(webpSource)) continue;
    texture.source = webpSource;
    if (texture.extensions?.EXT_texture_webp) {
      delete texture.extensions.EXT_texture_webp;
      if (!Object.keys(texture.extensions).length) delete texture.extensions;
    }
  }

  const stillUsesWebP = (json.textures ?? []).some(
    (texture: any) => texture.extensions?.EXT_texture_webp,
  );
  if (!stillUsesWebP) {
    json.extensionsUsed = (json.extensionsUsed ?? []).filter((ext: string) => ext !== 'EXT_texture_webp');
    json.extensionsRequired = (json.extensionsRequired ?? []).filter((ext: string) => ext !== 'EXT_texture_webp');
    if (!json.extensionsUsed.length) delete json.extensionsUsed;
    if (!json.extensionsRequired.length) delete json.extensionsRequired;
  }

  // gltf-transform 4.4.1's etc1s --slots path assumes texture.extensions is
  // present. Some older PNG/JPEG GLBs omit it, crashing with
  // "Cannot read properties of undefined (reading 'extensions')".
  for (const texture of json.textures ?? []) {
    texture.extensions ??= {};
  }
  normalizeTextureInfoExtensions(json);

  json.buffers ??= [];
  json.buffers[0] = {
    ...(json.buffers[0] ?? {}),
    byteLength: nextBin.length,
  };
  writeGlb(tempAbs, json, nextBin);

  return {
    converted: eligibleTextureIndexes.length,
    etc1sConverted: etc1sTextureIndexes.length,
    uastcConverted: uastcTextureIndexes.length,
    hadMeshopt: usedExtensions.has('EXT_meshopt_compression'),
    skippedBySlot,
  };
}

function run(command: string, args: string[], timeoutMs: number): string {
  const toktxBinDir = resolveToktxBinDir();
  const child = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PATH: [
        toktxBinDir,
        path.join(os.homedir(), 'scoop', 'shims'),
        process.env.PATH ?? '',
      ].filter(Boolean).join(path.delimiter),
    },
  });

  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${child.stdout}\n${child.stderr}`.trim());
  }
  return `${child.stdout}${child.stderr}`;
}

function assertGlb(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (magic.readUInt32LE(0) !== GLB_MAGIC) throw new Error('output is not a GLB');
}

function hasBasisu(filePath: string): boolean {
  const { json } = readGlb(filePath);
  return (json.extensionsUsed ?? []).includes('KHR_texture_basisu');
}

function accessorSignature(accessor: any): Record<string, unknown> | null {
  if (!accessor) return null;
  return {
    componentType: accessor.componentType,
    type: accessor.type,
    count: accessor.count,
    normalized: accessor.normalized ?? false,
  };
}

function collectAttributeArchitecture(json: any): unknown {
  const signatureForIndex = (index: unknown) =>
    typeof index === 'number' ? accessorSignature(json.accessors?.[index]) : null;
  return (json.meshes ?? []).map((mesh: any) =>
    (mesh.primitives ?? []).map((primitive: any) => ({
      mode: primitive.mode ?? 4,
      indices: signatureForIndex(primitive.indices),
      attributes: Object.fromEntries(
        Object.entries(primitive.attributes ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([semantic, index]) => [semantic, signatureForIndex(index)]),
      ),
      targets: (primitive.targets ?? []).map((target: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(target)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([semantic, index]) => [semantic, signatureForIndex(index)]),
        ),
      ),
    })),
  );
}

async function restoreMeshoptCompression(inputPath: string, outputPath: string): Promise<void> {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
  const document = await io.read(inputPath);
  document.createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(outputPath, document);
}

async function convertTarget(target: Target): Promise<Result> {
  const sourceAbs = path.join(MODELS_DIR, target.path);
  const outputRel = outputPathFor(target.path);
  const outputAbs = path.join(MODELS_DIR, outputRel);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawville-ktx2-'));
  const tempInput = path.join(tempDir, 'input.glb');
  const tempEtc1sOutput = path.join(tempDir, 'etc1s.glb');
  const tempTextureOutput = path.join(tempDir, 'textures.glb');
  const tempOutput = path.join(tempDir, 'output.glb');

  const result: Result = {
    source: target.path,
    output: outputRel,
    sizeBefore: fs.existsSync(sourceAbs) ? fs.statSync(sourceAbs).size : 0,
    sizeAfter: 0,
    converted: 0,
    skippedBySlot: {},
    status: 'ok',
  };

  try {
    if (!fs.existsSync(sourceAbs)) throw new Error('source file missing');

    const prep = await prepareKtx2Input(sourceAbs, tempInput);
    result.converted = prep.converted;
    result.skippedBySlot = prep.skippedBySlot;

    let currentInput = tempInput;
    if (prep.etc1sConverted > 0) {
      run(
        'bunx',
        [
          '@gltf-transform/cli',
          'etc1s',
          currentInput,
          tempEtc1sOutput,
          '--quality',
          String(QLEVEL),
          '--slots',
          ETC1S_SLOTS,
        ],
        600_000,
      );
      currentInput = tempEtc1sOutput;
    }

    if (prep.uastcConverted > 0) {
      run(
        'bunx',
        [
          '@gltf-transform/cli',
          'uastc',
          currentInput,
          tempTextureOutput,
          '--slots',
          UASTC_SLOTS,
        ],
        600_000,
      );
    } else {
      fs.copyFileSync(currentInput, tempTextureOutput);
    }

    // glTF Transform's texture commands decode EXT_meshopt_compression. Restore
    // it at write time without the CLI meshopt transform, which would reorder
    // and requantize geometry. Existing accessor arrays remain unchanged.
    if (prep.hadMeshopt) {
      await restoreMeshoptCompression(tempTextureOutput, tempOutput);
      const sourceArchitecture = collectAttributeArchitecture(readGlb(sourceAbs).json);
      const outputArchitecture = collectAttributeArchitecture(readGlb(tempOutput).json);
      if (JSON.stringify(sourceArchitecture) !== JSON.stringify(outputArchitecture)) {
        throw new Error('Meshopt restore changed mesh attribute architecture');
      }
    } else {
      fs.copyFileSync(tempTextureOutput, tempOutput);
    }

    if (!fs.existsSync(tempOutput)) throw new Error('gltf-transform produced no output');
    assertGlb(tempOutput);
    if (!hasBasisu(tempOutput)) throw new Error('output missing KHR_texture_basisu');

    fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
    fs.copyFileSync(tempOutput, outputAbs);
    result.sizeAfter = fs.statSync(outputAbs).size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.status = message.startsWith('skip:') ? 'skipped' : 'error';
    result.reason = message.replace(/^skip:\s*/, '');
  } finally {
    if (process.env.KTX2_KEEP_TEMP === '1' && result.status === 'error') {
      console.warn(`kept temp dir for ${target.path}: ${tempDir}`);
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return result;
}

async function main(): Promise<void> {
  console.log('=== ClawVille GLB Texture -> KTX2 ETC1S + UASTC ===');
  console.log(`Targets: ${TARGETS.length}`);
  console.log(`ETC1S qlevel: ${QLEVEL}`);
  console.log(`ETC1S slots: ${ETC1S_SLOTS}`);
  console.log(`UASTC slots: ${UASTC_SLOTS}`);
  run('toktx', ['--version'], 30_000);

  const targetFilter = process.env.KTX2_TARGET;
  const targets = targetFilter
    ? TARGETS.filter((target) => target.path.includes(targetFilter))
    : TARGETS;

  const results: Result[] = [];
  for (const target of targets) {
    process.stdout.write(`[${target.path}] `);
    const result = await convertTarget(target);
    results.push(result);
    if (result.status === 'ok') {
      console.log(`${formatBytes(result.sizeBefore)} -> ${formatBytes(result.sizeAfter)} (${result.converted} textures)`);
    } else {
      console.log(`${result.status.toUpperCase()}: ${result.reason}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log('GLB\tbefore\tafter\tconverted\tskippedSlots\tstatus');
  for (const r of results) {
    const skipped = Object.entries(r.skippedBySlot)
      .map(([slot, count]) => `${slot}:${count}`)
      .join(',') || '-';
    console.log([
      r.source,
      formatBytes(r.sizeBefore),
      r.sizeAfter ? formatBytes(r.sizeAfter) : '-',
      String(r.converted),
      skipped,
      r.status === 'ok' ? 'ok' : `${r.status}: ${r.reason}`,
    ].join('\t'));
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
