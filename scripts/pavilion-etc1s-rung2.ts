/**
 * pavilion-etc1s-rung2.ts
 *
 * One-off cold-load-diet (rung 2) experiment: regenerate the quest-bounty
 * pavilion's KTX2 sibling with normal maps encoded as ETC1S instead of UASTC.
 *
 * The shipped pipeline (scripts/compress-ktx2.ts) deliberately routes
 * `normalTexture` through UASTC so direction vectors survive compression
 * cleanly. UASTC+zstd is also by far the most expensive codec on the wire —
 * the pavilion's 18 normal maps are ~1.13MB of its 3.99MB. This script builds
 * the cheap-normals variant so the two can be compared on bytes and on looks.
 *
 * It is a faithful copy of compress-ktx2.ts's machinery with ONE behavioural
 * change: `normalTexture` moves from the UASTC slot set into the ETC1S slot
 * set, so there is no UASTC pass at all. Everything else — the WebP->PNG
 * remap, the ETC1S quality level, the meshopt restore, and the attribute
 * architecture assert — is unchanged.
 *
 * Usage from repo root:
 *   bun run scripts/pavilion-etc1s-rung2.ts
 *
 * Requirements:
 *   - toktx in PATH (Scoop: C:\Users\itachi\scoop\shims\toktx.exe)
 *   - @gltf-transform/cli available through bunx
 *
 * NAMING: the output MUST end in `-ktx.glb`. The web boot preloader routes on
 * that substring to attach the KTX2 transcoder; a KTX2-textured GLB named
 * anything else crashes the game at boot.
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
const SOURCE_REL = 'quest-bounty-pavilion.glb';
const OUTPUT_REL = 'quest-bounty-pavilion-etc1s-ktx.glb';

// Same quality level compress-ktx2.ts uses for its ETC1S pass.
const QLEVEL = 192;

// The only behavioural change vs compress-ktx2.ts: normalTexture is encoded
// as ETC1S here rather than UASTC, so the UASTC slot set is empty.
const ETC1S_SLOT_NAMES = [
  'baseColorTexture',
  'emissiveTexture',
  'metallicRoughnessTexture',
  'occlusionTexture',
  'diffuseTexture',
  'specularGlossinessTexture',
  'specularTexture',
  'specularColorTexture',
  'normalTexture',
] as const;

function buildSlotPattern(slotNames: readonly string[]): string {
  if (slotNames.length === 0) throw new Error('Texture slot pattern cannot be empty');
  return slotNames.length === 1 ? slotNames[0] : `{${slotNames.join(',')}}`;
}

const ETC1S_SLOTS = buildSlotPattern(ETC1S_SLOT_NAMES);
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const ETC1S_SLOT_SET = new Set<string>(ETC1S_SLOT_NAMES);
const ALLOWED_SLOTS = new Set<string>(ETC1S_SLOT_NAMES);

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

function formatBytes(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
  normalConverted: number;
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
  const normalTextureIndexes = [...slotsByTexture.entries()]
    .filter(([textureIndex, slots]) =>
      hasEligibleTexture(json, textureIndex, slots) && slots.has('normalTexture'),
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
    normalConverted: normalTextureIndexes.length,
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

/**
 * Every KTX2 payload in the output must be ETC1S — the whole point of the rung.
 * Reads the KTX2 supercompressionScheme + DFD colorModel straight out of the
 * embedded payloads, so a silently-UASTC normal map cannot pass unnoticed.
 */
function assertAllEtc1s(filePath: string): { etc1s: number; other: string[] } {
  const KTX2_ID = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { json, bin } = readGlb(filePath);
  let etc1s = 0;
  const other: string[] = [];

  json.images?.forEach((image: any, imageIndex: number) => {
    if (image.mimeType !== 'image/ktx2') return;
    const view = json.bufferViews?.[image.bufferView];
    if (!view) throw new Error(`image ${imageIndex} has no bufferView`);
    const byteOffset = view.byteOffset ?? 0;
    const bytes = bin.subarray(byteOffset, byteOffset + view.byteLength);
    if (!bytes.subarray(0, 12).equals(KTX2_ID)) throw new Error(`image ${imageIndex} is not KTX2`);

    const scheme = bytes.readUInt32LE(44); // 0 none · 1 BasisLZ(ETC1S) · 2 zstd
    const dfdOffset = bytes.readUInt32LE(48);
    const colorModel = dfdOffset > 0 && dfdOffset + 13 <= bytes.length
      ? bytes.readUInt8(dfdOffset + 12)
      : -1;
    // 163 = ETC1S/BasisLZ, 166 = UASTC.
    if (colorModel === 163 || scheme === 1) etc1s += 1;
    else other.push(`image ${imageIndex}: colorModel=${colorModel} scheme=${scheme}`);
  });

  return { etc1s, other };
}

async function main(): Promise<void> {
  const sourceAbs = path.join(MODELS_DIR, SOURCE_REL);
  const outputAbs = path.join(MODELS_DIR, OUTPUT_REL);

  if (!OUTPUT_REL.endsWith('-ktx.glb')) {
    throw new Error(`output name must end in -ktx.glb (boot preloader routes on it): ${OUTPUT_REL}`);
  }
  if (!fs.existsSync(sourceAbs)) throw new Error(`source file missing: ${sourceAbs}`);

  console.log('=== pavilion rung-2: ALL-ETC1S KTX2 (normals as ETC1S, not UASTC) ===');
  console.log(`source: ${SOURCE_REL}`);
  console.log(`output: ${OUTPUT_REL}`);
  console.log(`ETC1S qlevel: ${QLEVEL}`);
  console.log(`ETC1S slots: ${ETC1S_SLOTS}`);
  console.log(run('toktx', ['--version'], 30_000).trim());

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawville-pavilion-etc1s-'));
  const tempInput = path.join(tempDir, 'input.glb');
  const tempEtc1sOutput = path.join(tempDir, 'etc1s.glb');
  const tempOutput = path.join(tempDir, 'output.glb');

  try {
    const prep = await prepareKtx2Input(sourceAbs, tempInput);
    console.log(
      `prepared: ${prep.converted} eligible texture(s), ${prep.etc1sConverted} routed to ETC1S ` +
      `(of which ${prep.normalConverted} are normal maps), meshopt=${prep.hadMeshopt}`,
    );
    const skipped = Object.entries(prep.skippedBySlot)
      .map(([slot, count]) => `${slot}:${count}`)
      .join(',') || '-';
    console.log(`skipped slots: ${skipped}`);

    if (prep.normalConverted === 0) {
      throw new Error('no normal maps routed to ETC1S — the experiment would be a no-op');
    }

    run(
      'bunx',
      [
        '@gltf-transform/cli',
        'etc1s',
        tempInput,
        tempEtc1sOutput,
        '--quality',
        String(QLEVEL),
        '--slots',
        ETC1S_SLOTS,
      ],
      900_000,
    );

    // glTF Transform's texture commands decode EXT_meshopt_compression. Restore
    // it at write time without the CLI meshopt transform, which would reorder
    // and requantize geometry. Existing accessor arrays remain unchanged.
    if (prep.hadMeshopt) {
      await restoreMeshoptCompression(tempEtc1sOutput, tempOutput);
      const sourceArchitecture = collectAttributeArchitecture(readGlb(sourceAbs).json);
      const outputArchitecture = collectAttributeArchitecture(readGlb(tempOutput).json);
      if (JSON.stringify(sourceArchitecture) !== JSON.stringify(outputArchitecture)) {
        throw new Error('Meshopt restore changed mesh attribute architecture');
      }
      console.log('meshopt restored; attribute architecture identical to source');
    } else {
      fs.copyFileSync(tempEtc1sOutput, tempOutput);
    }

    if (!fs.existsSync(tempOutput)) throw new Error('gltf-transform produced no output');
    assertGlb(tempOutput);
    if (!hasBasisu(tempOutput)) throw new Error('output missing KHR_texture_basisu');

    const codecs = assertAllEtc1s(tempOutput);
    if (codecs.other.length) {
      throw new Error(`output has non-ETC1S KTX2 payloads:\n  ${codecs.other.join('\n  ')}`);
    }
    console.log(`codec assert: ${codecs.etc1s} KTX2 payload(s), all ETC1S`);

    fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
    fs.copyFileSync(tempOutput, outputAbs);

    const sizeBefore = fs.statSync(sourceAbs).size;
    const sizeAfter = fs.statSync(outputAbs).size;
    console.log(
      `\n${SOURCE_REL} ${formatBytes(sizeBefore)} -> ${OUTPUT_REL} ${formatBytes(sizeAfter)}`,
    );
    console.log(`wrote ${outputAbs}`);
  } finally {
    if (process.env.KTX2_KEEP_TEMP === '1') {
      console.warn(`kept temp dir: ${tempDir}`);
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
