/**
 * recon-building-materials.mjs
 *
 * Phase 2 recon: inspect all 12 building GLBs to count materials, textures,
 * identify duplicates (by content hash), and surface UV-tiling ranges.
 *
 * Usage:
 *   node scripts/recon-building-materials.mjs
 *
 * Output:
 *   - Console summary
 *   - docs/perf-phase2-recon-2026-05-22.md
 *
 * Requires @gltf-transform/core + @gltf-transform/extensions (already in repo).
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3d';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(REPO_ROOT, 'apps/web/public/models');
const OUTPUT_DOC = path.join(REPO_ROOT, 'docs/perf-phase2-recon-2026-05-22.md');

// The 12 active building GLBs (mirrors asset-preload-manifest.ts BUILDING_GLBS)
const BUILDING_GLBS = [
  'pineapple-house.glb',
  'chum-bucket-v2.glb',
  'krusty-krab-v2.glb',
  'sandy-treedome-v3.glb',
  'salty-spitoon.glb',
  'boating-school.glb',
  'patty-building.glb',
  'building-lighthouse.glb',
  'arcade/claw-arcade-exterior.glb',
  'cove/cove-exterior.glb',
  'patricks-rock-v2.glb',
  'squidward-house.glb',
];

function sha256Head(bytes) {
  // Hash the first 256 bytes (or all bytes if shorter) for dedup detection.
  const slice = bytes.slice(0, 256);
  return crypto.createHash('sha256').update(slice).digest('hex').slice(0, 16);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// UV range check — returns {minU, maxU, minV, maxV} for a primitive's UVs
function uvRange(primitive) {
  const uvAttr = primitive.getAttribute('TEXCOORD_0');
  if (!uvAttr) return null;
  const arr = uvAttr.getArray();
  if (!arr) return null;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < arr.length; i += 2) {
    const u = arr[i], v = arr[i + 1];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { minU, maxU, minV, maxV };
}

async function analyzeGlb(relPath) {
  const fullPath = path.join(MODELS_DIR, relPath);
  if (!fs.existsSync(fullPath)) {
    return { relPath, error: 'FILE NOT FOUND' };
  }
  const fileBytes = fs.statSync(fullPath).size;

  // Wire meshopt decoder — required for EXT_meshopt_compression GLBs
  await MeshoptDecoder.ready;
  // Wire Draco decoder — required for KHR_draco_mesh_compression GLBs
  const dracoDecoder = await draco3d.createDecoderModule({});
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'draco3d.decoder': dracoDecoder,
    });
  let doc;
  try {
    doc = await io.read(fullPath);
  } catch (e) {
    return { relPath, error: `parse error: ${e.message}` };
  }

  const root = doc.getRoot();
  const materials = root.listMaterials();
  const textures = root.listTextures();

  // Build texture info map: texture index → {slot, resolution, format, bytes, hash}
  const texInfoMap = new Map();
  for (const tex of textures) {
    const imageData = tex.getImage();
    if (!imageData) {
      texInfoMap.set(tex, { slot: 'unknown', resolution: 'N/A', format: 'N/A', bytes: 0, hash: 'empty' });
      continue;
    }
    const bytes = imageData.byteLength;
    const hash = sha256Head(new Uint8Array(imageData));
    const mimeType = tex.getMimeType() || 'unknown';
    const format = mimeType.includes('webp') ? 'webp'
      : mimeType.includes('png') ? 'png'
      : mimeType.includes('jpeg') ? 'jpg'
      : mimeType.includes('ktx2') ? 'ktx2'
      : mimeType;

    // Try to read image dimensions via the image size header bytes
    let resolution = 'unknown';
    const ib = new Uint8Array(imageData);
    if (ib[0] === 0x89 && ib[1] === 0x50) {
      // PNG: width at byte 16, height at byte 20 (big-endian uint32)
      const w = (ib[16] << 24 | ib[17] << 16 | ib[18] << 8 | ib[19]) >>> 0;
      const h = (ib[20] << 24 | ib[21] << 16 | ib[22] << 8 | ib[23]) >>> 0;
      resolution = `${w}×${h}`;
    } else if (ib[0] === 0xFF && ib[1] === 0xD8) {
      // JPEG: scan for SOF0/SOF1/SOF2 marker
      let i = 2;
      while (i < ib.length - 8) {
        if (ib[i] !== 0xFF) { i++; continue; }
        const marker = ib[i + 1];
        if (marker >= 0xC0 && marker <= 0xC3) {
          const h = (ib[i + 5] << 8 | ib[i + 6]);
          const w = (ib[i + 7] << 8 | ib[i + 8]);
          resolution = `${w}×${h}`;
          break;
        }
        const segLen = (ib[i + 2] << 8 | ib[i + 3]);
        i += 2 + segLen;
      }
    } else if (ib[0] === 0x52 && ib[1] === 0x49 && ib[2] === 0x46 && ib[3] === 0x46) {
      // WEBP: width+1 at bytes 26-27, height+1 at 28-29 (little-endian)
      const w = (ib[26] | ib[27] << 8) + 1;
      const h = (ib[28] | ib[29] << 8) + 1;
      resolution = `${w}×${h}`;
    }
    texInfoMap.set(tex, { bytes, hash, format, resolution });
  }

  // Per-material: list texture slots + UV ranges
  const matInfos = [];
  for (const mat of materials) {
    const name = mat.getName() || '(unnamed)';
    const slots = {};

    // Helper: extract texture + UV range from a texture info object
    function getSlotInfo(texInfo, slotName) {
      if (!texInfo) return;
      const tex = texInfo.getTexture();
      if (!tex) return;
      const info = texInfoMap.get(tex);
      slots[slotName] = info || { bytes: 0, hash: 'no-data', format: 'N/A', resolution: 'N/A' };
    }

    getSlotInfo(mat.getBaseColorTextureInfo ? { getTexture: () => mat.getBaseColorTexture() } : null, 'baseColor');
    // Use direct texture getters from gltf-transform Material
    const baseColorTex = mat.getBaseColorTexture?.();
    if (baseColorTex) slots['baseColor'] = texInfoMap.get(baseColorTex);

    const normalTex = mat.getNormalTexture?.();
    if (normalTex) slots['normal'] = texInfoMap.get(normalTex);

    const metallicRoughnessTex = mat.getMetallicRoughnessTexture?.();
    if (metallicRoughnessTex) slots['metallicRoughness'] = texInfoMap.get(metallicRoughnessTex);

    const occlusionTex = mat.getOcclusionTexture?.();
    if (occlusionTex) slots['occlusion'] = texInfoMap.get(occlusionTex);

    const emissiveTex = mat.getEmissiveTexture?.();
    if (emissiveTex) slots['emissive'] = texInfoMap.get(emissiveTex);

    // UV tiling range: check all primitives using this material
    const meshes = root.listMeshes();
    let uvMin = Infinity, uvMax = -Infinity;
    let tilingWarning = false;
    for (const mesh of meshes) {
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMaterial() === mat) {
          const range = uvRange(prim);
          if (range) {
            const overall = Math.max(range.maxU, range.maxV);
            const overallMin = Math.min(range.minU, range.minV);
            if (overall > uvMax) uvMax = overall;
            if (overallMin < uvMin) uvMin = overallMin;
          }
        }
      }
    }
    if (uvMax > 1.01 || uvMin < -0.01) tilingWarning = true;

    matInfos.push({ name, slots, uvMin: uvMin === Infinity ? 0 : uvMin, uvMax: uvMax === -Infinity ? 1 : uvMax, tilingWarning });
  }

  return { relPath, fileBytes, matInfos, texInfoMap };
}

async function main() {
  console.log('Phase 2 recon — analyzing 12 building GLBs...\n');

  const results = [];
  for (const glb of BUILDING_GLBS) {
    process.stdout.write(`  ${glb} ... `);
    const r = await analyzeGlb(glb);
    results.push(r);
    if (r.error) {
      console.log(`ERROR: ${r.error}`);
    } else {
      console.log(`${r.matInfos.length} materials, ${r.texInfoMap.size} textures, ${formatBytes(r.fileBytes)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Cross-building texture dedup analysis
  // -------------------------------------------------------------------------

  // Global hash → [{ glb, matName, slotName, resolution, bytes }]
  const hashRegistry = new Map();

  for (const r of results) {
    if (r.error) continue;
    for (const mat of r.matInfos) {
      for (const [slot, info] of Object.entries(mat.slots)) {
        if (!info) continue;
        const key = info.hash;
        if (!hashRegistry.has(key)) hashRegistry.set(key, []);
        hashRegistry.get(key).push({
          glb: r.relPath,
          matName: mat.name,
          slot,
          resolution: info.resolution,
          bytes: info.bytes,
          format: info.format,
        });
      }
    }
  }

  // Textures that appear in 2+ distinct GLBs (cross-building duplicates)
  const crossBuildingDups = [];
  for (const [hash, entries] of hashRegistry) {
    const distinctGlbs = new Set(entries.map((e) => e.glb));
    if (distinctGlbs.size >= 2) {
      crossBuildingDups.push({ hash, entries, count: entries.length, glbCount: distinctGlbs.size });
    }
  }
  crossBuildingDups.sort((a, b) => b.glbCount - a.glbCount);

  // Also find same-GLB duplicates (materials within the same file sharing a texture hash)
  // This is the Strategy 2A target.
  const sameBuildingDups = [];
  for (const r of results) {
    if (r.error) continue;
    const localHashes = new Map();
    for (const mat of r.matInfos) {
      for (const [slot, info] of Object.entries(mat.slots)) {
        if (!info) continue;
        if (!localHashes.has(info.hash)) localHashes.set(info.hash, []);
        localHashes.get(info.hash).push({ matName: mat.name, slot, resolution: info.resolution });
      }
    }
    let localDups = 0;
    for (const [, entries] of localHashes) {
      if (entries.length > 1) localDups++;
    }
    sameBuildingDups.push({ glb: r.relPath, localDupCount: localDups });
  }

  // -------------------------------------------------------------------------
  // Tiling warnings
  // -------------------------------------------------------------------------
  const tilingWarnings = [];
  for (const r of results) {
    if (r.error) continue;
    for (const mat of r.matInfos) {
      if (mat.tilingWarning) {
        tilingWarnings.push({ glb: r.relPath, matName: mat.name, uvMin: mat.uvMin.toFixed(3), uvMax: mat.uvMax.toFixed(3) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Summary stats
  // -------------------------------------------------------------------------
  let totalMaterials = 0;
  let totalTextures = 0;
  const matCounts = [];
  for (const r of results) {
    if (r.error) { matCounts.push({ glb: r.relPath, mats: 'ERROR', texes: 'ERROR' }); continue; }
    totalMaterials += r.matInfos.length;
    totalTextures += r.texInfoMap.size;
    matCounts.push({ glb: r.relPath, mats: r.matInfos.length, texes: r.texInfoMap.size, bytes: r.fileBytes });
  }

  // Top-10 duplicated textures by cross-building occurrence
  const top10Dups = crossBuildingDups.slice(0, 10);

  // -------------------------------------------------------------------------
  // Strategy decision matrix
  // -------------------------------------------------------------------------
  // Strategy 2A: dedup — gltf-transform dedup on materials + textures within each GLB
  //   Win: cross-material sharing within a GLB (same texture referenced by 2 materials counts once)
  //   Also: cross-GLB dedup is NOT possible with per-file dedup (gltf-transform dedup is per-document)
  //
  // Strategy 2B: cross-building texture atlas
  //   Win: share textures across buildings → fewer draw calls
  //   Risk: UV tiling outside [0,1] breaks atlasing
  //
  // Strategy 2C: replace decorative sub-meshes with shared simple material
  //   Win: low complexity
  //   Risk: quality loss

  const crossDupCount = crossBuildingDups.length;
  const tilingWarnCount = tilingWarnings.length;

  // Estimate material reduction from 2A (within-file dedup)
  let estimated2AWin = 0;
  for (const r of results) {
    if (r.error) continue;
    // Count unique texture hashes across all slot maps in this GLB
    const seen = new Set();
    let dupsInFile = 0;
    for (const mat of r.matInfos) {
      for (const info of Object.values(mat.slots)) {
        if (!info) continue;
        if (seen.has(info.hash)) dupsInFile++;
        seen.add(info.hash);
      }
    }
    estimated2AWin += dupsInFile;
  }

  // -------------------------------------------------------------------------
  // Generate report
  // -------------------------------------------------------------------------
  let md = `# Phase 2 Recon — Building Material Audit\n`;
  md += `\n**Date:** 2026-05-22  \n**Scope:** 12 active building GLBs (from \`BUILDING_GLBS\` in \`asset-preload-manifest.ts\`)\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Total materials across 12 buildings | ${totalMaterials} |\n`;
  md += `| Total texture objects | ${totalTextures} |\n`;
  md += `| Cross-building duplicate textures (same hash, ≥2 buildings) | ${crossDupCount} |\n`;
  md += `| Materials with UV tiling outside [0,1] | ${tilingWarnCount} |\n`;
  md += `| Estimated within-file dedup win (Strategy 2A) | ~${estimated2AWin} texture refs saved |\n\n`;

  md += `## Per-Building Material Count\n\n`;
  md += `| GLB | File size | Materials | Textures |\n|---|---|---|---|\n`;
  for (const r of matCounts) {
    md += `| ${r.glb} | ${r.bytes !== undefined ? formatBytes(r.bytes) : 'N/A'} | ${r.mats} | ${r.texes} |\n`;
  }
  md += `\n`;

  md += `## Per-Building Material Details\n\n`;
  for (const r of results) {
    if (r.error) {
      md += `### ${r.relPath}\n\nERROR: ${r.error}\n\n`;
      continue;
    }
    md += `### ${r.relPath} (${r.matInfos.length} materials)\n\n`;
    for (const mat of r.matInfos) {
      md += `**${mat.name}**`;
      if (mat.tilingWarning) md += ` ⚠️ UV tiling outside [0,1] (min=${mat.uvMin.toFixed(3)}, max=${mat.uvMax.toFixed(3)})`;
      md += `\n`;
      for (const [slot, info] of Object.entries(mat.slots)) {
        if (!info) continue;
        md += `  - ${slot}: ${info.format} ${info.resolution} ${formatBytes(info.bytes)} hash=${info.hash}\n`;
      }
    }
    md += `\n`;
  }

  md += `## Cross-Building Texture Duplicates (hash matches across ≥2 buildings)\n\n`;
  if (crossBuildingDups.length === 0) {
    md += `No cross-building texture duplicates found.\n\n`;
  } else {
    md += `Found ${crossBuildingDups.length} texture(s) shared across multiple buildings:\n\n`;
    for (const { hash, entries, glbCount } of crossBuildingDups.slice(0, 20)) {
      md += `**hash=${hash}** (${glbCount} buildings, ${entries.length} total refs)\n`;
      for (const e of entries) {
        md += `  - ${e.glb} / ${e.matName} / ${e.slot} (${e.resolution} ${e.format} ${formatBytes(e.bytes)})\n`;
      }
    }
    md += `\n`;
  }

  md += `## UV Tiling Warnings (materials with UV outside [0,1] — would break atlas)\n\n`;
  if (tilingWarnings.length === 0) {
    md += `No UV tiling issues detected. All materials have UVs in [0,1].\n\n`;
  } else {
    md += `| GLB | Material | UV min | UV max |\n|---|---|---|---|\n`;
    for (const w of tilingWarnings) {
      md += `| ${w.glb} | ${w.matName} | ${w.uvMin} | ${w.uvMax} |\n`;
    }
    md += `\n`;
    md += `> Materials with UV tiling outside [0,1] MUST be excluded from any atlas strategy.\n\n`;
  }

  md += `## Strategy Decision Matrix\n\n`;
  md += `| Strategy | Estimated material reduction | Risk | Recommendation |\n|---|---|---|---|\n`;
  md += `| 2A — within-file \`gltf-transform dedup\` (materials + textures) | ~${estimated2AWin} duplicate texture refs eliminated; material count unchanged unless two materials are byte-identical | Low — no UV rewrite | `;
  if (crossDupCount < 10) {
    md += `**CHOSEN** — cross-building duplication is low (${crossDupCount}); within-file dedup is safe and non-zero |\n`;
  } else {
    md += `Consider as first pass |\n`;
  }
  md += `| 2B — cross-building texture atlas | Potentially collapse ${crossDupCount} cross-building textures → shared atlas | High — UV rewrite needed; ${tilingWarnCount} materials with UV>1 must be excluded | `;
  if (crossDupCount < 10 || tilingWarnCount > 5) {
    md += `Not recommended — low ROI or too many tiling exclusions |\n`;
  } else {
    md += `Consider if 2A insufficient |\n`;
  }
  md += `| 2C — replace decorative sub-meshes with shared simple material | Low (affects only untextured sub-meshes) | Medium — visual quality loss on detailed buildings | Not recommended as primary |\n`;
  md += `\n`;

  if (crossDupCount < 10) {
    md += `### Decision: Strategy 2A — Within-file material + texture dedup\n\n`;
    md += `**Rationale:** Cross-building texture duplicates = ${crossDupCount} (below the 10-threshold for atlas ROI). `;
    md += `Within-file dedup via \`gltf-transform dedup\` consolidates duplicate texture references within each GLB `;
    md += `and merges byte-identical materials, reducing GPU texture cache pressure. `;
    md += `UV tiling issues (${tilingWarnCount} warnings) are irrelevant for this strategy since no atlas is created. `;
    md += `Risk: near-zero — dedup is a lossless structural operation.\n\n`;
    md += `**Implementation:** \`scripts/dedup-buildings.mjs\` — runs \`dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.TEXTURE, PropertyType.ACCESSOR] })\` `;
    md += `on each of the 12 building GLBs and writes \`<name>-optN.glb\` (keeping originals as \`<name>.glb.preopt.bak\`).\n\n`;
  } else {
    md += `### Decision: Strategy 2B — Cross-building texture atlas\n\n`;
    md += `**Rationale:** ${crossDupCount} cross-building texture duplicates found — atlas ROI is high. `;
    md += `${tilingWarnCount} tiling-warning materials will be excluded from atlasing.\n\n`;
  }

  fs.writeFileSync(OUTPUT_DOC, md, 'utf8');
  console.log(`\nRecon report written to: ${OUTPUT_DOC}`);

  // Print decision to stdout
  console.log(`\n=== DECISION ===`);
  console.log(`Total materials: ${totalMaterials}`);
  console.log(`Cross-building dups: ${crossDupCount}`);
  console.log(`UV tiling warnings: ${tilingWarnCount}`);
  console.log(`Within-file dedup win: ~${estimated2AWin} texture refs`);
  if (crossDupCount < 10) {
    console.log(`→ Strategy 2A (within-file dedup) selected`);
  } else {
    console.log(`→ Strategy 2B (cross-building atlas) selected`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
