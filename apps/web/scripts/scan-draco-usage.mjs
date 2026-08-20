#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

const DRACO_EXTENSION = 'KHR_draco_mesh_compression';
const DRACO_BYTES = Buffer.from(DRACO_EXTENSION, 'utf8');
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const workspaceRoot = resolve(import.meta.dirname, '../../..');
const scanRoots = [
  resolve(workspaceRoot, 'apps/web/public/models'),
  resolve(workspaceRoot, 'apps/web/public/avatars'),
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function parseGlbJson(buffer, file) {
  if (buffer.length < 12) throw new Error(`${file}: truncated GLB header`);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength > buffer.length) {
    throw new Error(`${file}: GLB declares ${declaredLength} bytes but has ${buffer.length}`);
  }

  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > declaredLength) throw new Error(`${file}: truncated GLB chunk`);
    if (chunkType === GLB_JSON_CHUNK) {
      const jsonText = buffer.subarray(chunkStart, chunkEnd).toString('utf8').replace(/\0+$/u, '').trimEnd();
      return { document: JSON.parse(jsonText), jsonStart: chunkStart, jsonEnd: chunkEnd };
    }
    offset = chunkEnd;
  }
  throw new Error(`${file}: GLB has no JSON chunk`);
}

function analyzeDracoUsage(document) {
  const declared =
    (Array.isArray(document?.extensionsUsed)
      && document.extensionsUsed.includes(DRACO_EXTENSION))
    || (Array.isArray(document?.extensionsRequired)
      && document.extensionsRequired.includes(DRACO_EXTENSION));
  let compressedPrimitives = 0;
  if (Array.isArray(document?.meshes)) {
    for (const mesh of document.meshes) {
      if (!Array.isArray(mesh?.primitives)) continue;
      for (const primitive of mesh.primitives) {
        if (
          primitive?.extensions
          && Object.hasOwn(primitive.extensions, DRACO_EXTENSION)
        ) {
          compressedPrimitives += 1;
        }
      }
    }
  }
  return { declared, compressedPrimitives };
}

function countOccurrences(buffer, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = buffer.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

const files = (await Promise.all(scanRoots.map(collectFiles))).flat();
const matches = [];
const inconclusive = [];
let parsedDocuments = 0;

for (const file of files) {
  const displayPath = relative(workspaceRoot, file).replaceAll('\\', '/');
  const buffer = await readFile(file);
  const isGlb = buffer.length >= 4 && buffer.readUInt32LE(0) === GLB_MAGIC;
  const extension = extname(file).toLowerCase();

  try {
    if (isGlb) {
      const { document, jsonStart, jsonEnd } = parseGlbJson(buffer, displayPath);
      parsedDocuments += 1;
      const usage = analyzeDracoUsage(document);
      if (usage.compressedPrimitives > 0) {
        matches.push(
          `${displayPath} (${usage.compressedPrimitives} compressed primitive${usage.compressedPrimitives === 1 ? '' : 's'})`,
        );
      } else if (usage.declared) {
        inconclusive.push(`${displayPath} (extension declared without a compressed primitive)`);
      } else {
        const wholeFileHits = countOccurrences(buffer, DRACO_BYTES);
        const jsonHits = countOccurrences(buffer.subarray(jsonStart, jsonEnd), DRACO_BYTES);
        if (wholeFileHits > jsonHits) {
          inconclusive.push(`${displayPath} (text hit outside parsed GLB JSON chunk)`);
        } else if (jsonHits > 0) {
          inconclusive.push(`${displayPath} (text hit in JSON, but not an extension key/value)`);
        }
      }
      continue;
    }

    if (extension === '.gltf' || extension === '.json') {
      const document = JSON.parse(buffer.toString('utf8'));
      parsedDocuments += 1;
      const usage = analyzeDracoUsage(document);
      if (usage.compressedPrimitives > 0) {
        matches.push(
          `${displayPath} (${usage.compressedPrimitives} compressed primitive${usage.compressedPrimitives === 1 ? '' : 's'})`,
        );
      } else if (usage.declared) {
        inconclusive.push(`${displayPath} (extension declared without a compressed primitive)`);
      } else if (buffer.includes(DRACO_BYTES)) {
        inconclusive.push(`${displayPath} (text hit in JSON, but not an extension key/value)`);
      }
      continue;
    }

    if (buffer.includes(DRACO_BYTES)) {
      inconclusive.push(`${displayPath} (text hit in a non-glTF file)`);
    }
  } catch (error) {
    inconclusive.push(`${displayPath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

console.log(`scanned ${files.length} files; parsed ${parsedDocuments} glTF/GLB documents`);
if (matches.length === 0) console.log('zero matches');
else {
  console.log(`Draco usage (${matches.length}):`);
  for (const match of matches) console.log(match);
}

if (inconclusive.length > 0) {
  console.log(`inconclusive (${inconclusive.length}):`);
  for (const item of inconclusive) console.log(item);
  process.exitCode = 2;
}
