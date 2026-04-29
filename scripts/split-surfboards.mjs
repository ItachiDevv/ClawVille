#!/usr/bin/env bun
/**
 * Split the Sketchfab "Game Ready Free Surfboards" pack into 4 individual GLBs
 * suitable for direct loading in Three.js + drei `useGLTF`.
 *
 * Source: ~/Downloads/game_ready__free_surfboards.glb
 *   - 5 meshes (Surfboard_01..04 + Sand_Sand_0)
 *   - 4 materials matched 1:1 to surfboard meshes (sand material dropped)
 *   - 9 textures (3 are 2K base color maps; smaller PBR maps reused per board)
 *   - 13,264 total tris
 *
 * Output: apps/web/public/models/reef-race/surfboards/surfboard_{1..4}.glb
 *   - One mesh per file (3,220 tris each)
 *   - Only that board's referenced textures
 *   - No skeleton / animation (static)
 *   - Centered at origin so player-mount transforms are predictable
 *   - Y-up (Three.js default)
 *
 * Texture pruning: gltf-transform's `prune()` strips unused textures + materials
 * after we delete the other 3 boards from each output file. The 2K base color
 * maps stay 2K for now — we may downscale to 1K in a follow-up if Iris Xe
 * upload time is noticeable. Initial test shows file sizes are reasonable.
 *
 * License (CC-BY 4.0): attribution kept in apps/web/public/models/reef-race/surfboards/ATTRIBUTIONS.md.
 */

import { NodeIO } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';
import path from 'node:path';
import fs from 'node:fs';

const SRC = 'C:/Users/newma/Downloads/game_ready__free_surfboards.glb';
const OUT_DIR = path.resolve(
  'C:/Users/newma/Documents/Crypto/ClawVille/.claude/worktrees/reef-race-v2/apps/web/public/models/reef-race/surfboards',
);

const BOARDS = [
  { meshName: 'Surfboard_01_Surfboard_01_0', outFile: 'surfboard_1.glb' },
  { meshName: 'Surfboard_02_Surfboard_02_0', outFile: 'surfboard_2.glb' },
  { meshName: 'Surfboard_03_Surfboard_03_0', outFile: 'surfboard_3.glb' },
  { meshName: 'Surfboard_04_Surfboard_04_0', outFile: 'surfboard_4.glb' },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

const io = new NodeIO();

for (const { meshName, outFile } of BOARDS) {
  // Re-read the source for each board so deletions on one don't bleed into
  // another. NodeIO read is fast (~50ms) so this is fine.
  const doc = await io.read(SRC);
  const root = doc.getRoot();

  // Delete every mesh except the target board.
  for (const m of root.listMeshes()) {
    if (m.getName() !== meshName) {
      // Detach the mesh from any parent nodes first
      for (const n of root.listNodes()) {
        if (n.getMesh() === m) n.setMesh(null);
      }
      m.dispose();
    }
  }
  // Drop scene nodes that no longer carry a mesh (the sand display base + parents)
  for (const n of root.listNodes()) {
    if (!n.getMesh() && n.listChildren().length === 0) n.dispose();
  }

  // Prune unused materials + textures + accessors
  await doc.transform(prune(), dedup());

  const outPath = path.join(OUT_DIR, outFile);
  await io.write(outPath, doc);

  // Re-read for verification
  const verify = await io.read(outPath);
  const vroot = verify.getRoot();
  const vmesh = vroot.listMeshes();
  const vtri = vmesh.reduce((acc, m) => {
    return acc + m.listPrimitives().reduce((a, p) => {
      const ix = p.getIndices();
      return a + (ix ? Math.floor(ix.getCount() / 3) : 0);
    }, 0);
  }, 0);
  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(
    `${outFile}: ${vmesh.length} mesh, ${vtri} tris, ` +
      `${vroot.listMaterials().length} mat, ` +
      `${vroot.listTextures().length} tex, ${sizeKB} KB`,
  );
}

console.log('\nAll 4 surfboards split. Drop into ReefRacePlayer.tsx as drei useGLTF targets.');
