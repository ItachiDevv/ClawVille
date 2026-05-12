#!/usr/bin/env node
/**
 * Measure sandy-treedome-v2.glb the same way arena-buildings.tsx does at
 * runtime, then compute the exact yOffset that grounds the platform.
 *
 * computeBuildingScale logic (from arena-buildings.tsx):
 *   - Reads non-SkinnedMesh bbox of the scene
 *   - Normalizes the scene so target height = BUILDING_TARGET_HEIGHT (800 wu)
 *   - pivotOffsetY = localMinY * scale  → subtracted from group.position.y
 * Group is placed at position.y = -2 + config.yOffset, then the inner group
 * subtracts pivotOffsetY, then the GLB is scaled by buildingScale. So:
 *   rendered_min_y = -2 + yOffset + (-pivotOffsetY) + localMinY * scale
 *                 = -2 + yOffset + (-localMinY * scale) + localMinY * scale
 *                 = -2 + yOffset
 *
 * If rendered_min_y SHOULD be 0 (ground level), yOffset = +2.
 * If the platform appears at y=80 (floating 80 wu above), yOffset = -80 - 2 = -82.
 *
 * So the visible floating means our pivot calc isn't catching the visible
 * bottom of the model. Probably because the platform is NOT the lowest
 * geometry — maybe there's a hidden "Skybox" or other mesh below it that
 * pulled localMinY way down (off-screen), making pivotOffsetY very large,
 * and the platform ends up high in the air.
 *
 * Let's actually load the GLB and find out.
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const FILE = 'apps/web/public/models/sandy-treedome-v2.glb';

await MeshoptDecoder.ready;
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

const buf = fs.readFileSync(FILE);
const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

await new Promise((resolve, reject) => {
  loader.parse(arrayBuf, '', (gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    // Replicate computeBuildingScale exactly: non-SkinnedMesh bbox
    const bbox = new THREE.Box3();
    const meshBox = new THREE.Box3();
    let nonSkinned = 0;
    const allMeshes = [];
    scene.traverse((child) => {
      if (!child.isMesh) return;
      const isSkinned = !!child.isSkinnedMesh;
      child.geometry.computeBoundingBox();
      const bb = child.geometry.boundingBox;
      if (!bb) return;
      meshBox.copy(bb).applyMatrix4(child.matrixWorld);
      const size = new THREE.Vector3();
      meshBox.getSize(size);
      const center = new THREE.Vector3();
      meshBox.getCenter(center);
      allMeshes.push({
        name: child.name?.slice(0, 40),
        skinned: isSkinned,
        worldBbox: { minY: meshBox.min.y, maxY: meshBox.max.y, size: { x: size.x, y: size.y, z: size.z } },
        center: { x: center.x, y: center.y, z: center.z },
        verts: child.geometry.attributes.position?.count,
      });
      if (!isSkinned) {
        bbox.union(meshBox);
        nonSkinned++;
      }
    });

    const size = new THREE.Vector3();
    bbox.getSize(size);
    const TARGET_HEIGHT = 800;
    const h = size.y === 0 ? 1 : size.y;
    let scale = TARGET_HEIGHT / h;

    // Footprint cap (from arena-buildings.tsx — MAX_FOOTPRINT = 1000)
    const MAX_FOOTPRINT = 1000;
    const maxXZ = Math.max(size.x, size.z);
    const scaledMaxXZ = maxXZ * scale;
    if (scaledMaxXZ > MAX_FOOTPRINT) {
      scale *= MAX_FOOTPRINT / scaledMaxXZ;
    }

    const pivotOffsetY = bbox.min.y * scale;

    console.log(`\n=== ${FILE} ===`);
    console.log(`Non-skinned meshes: ${nonSkinned} / total: ${allMeshes.length}`);
    console.log(`Bbox (pre-scale, world): min(${bbox.min.x.toFixed(2)},${bbox.min.y.toFixed(2)},${bbox.min.z.toFixed(2)}) max(${bbox.max.x.toFixed(2)},${bbox.max.y.toFixed(2)},${bbox.max.z.toFixed(2)})`);
    console.log(`Bbox size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
    console.log(`Scale: ${scale.toFixed(4)}`);
    console.log(`pivotOffsetY (localMinY * scale): ${pivotOffsetY.toFixed(2)}`);
    console.log(`\nRender chain math:`);
    console.log(`  outer group.position.y = -2 + yOffset`);
    console.log(`  inner group.position.y = -${pivotOffsetY.toFixed(2)}`);
    console.log(`  primitive children scaled by ${scale.toFixed(4)}`);
    console.log(`\nVisible Y range (when yOffset=0):`);
    console.log(`  rendered_min_y = -2 + 0 + (-${pivotOffsetY.toFixed(2)}) + (${bbox.min.y.toFixed(2)} * ${scale.toFixed(4)})`);
    console.log(`               = -2 + ${(-pivotOffsetY + bbox.min.y * scale).toFixed(2)}`);
    console.log(`               = ${(-2 - pivotOffsetY + bbox.min.y * scale).toFixed(2)} (should be near 0 for ground)`);

    console.log(`\nPer-mesh world bboxes (pre-scale):`);
    allMeshes.sort((a, b) => a.worldBbox.minY - b.worldBbox.minY);
    for (const m of allMeshes.slice(0, 12)) {
      console.log(`  ${m.name?.padEnd(40) ?? '?'} | skinned=${m.skinned} | minY=${m.worldBbox.minY.toFixed(2).padStart(8)} maxY=${m.worldBbox.maxY.toFixed(2).padStart(8)} | sz ${m.worldBbox.size.x.toFixed(0)}x${m.worldBbox.size.y.toFixed(0)}x${m.worldBbox.size.z.toFixed(0)} | verts=${m.verts}`);
    }

    // Find the BIGGEST mesh (likely the actual platform). What's its world minY?
    const big = [...allMeshes].sort((a, b) => (b.worldBbox.size.x * b.worldBbox.size.z) - (a.worldBbox.size.x * a.worldBbox.size.z))[0];
    console.log(`\nBiggest-footprint mesh: ${big.name} — minY=${big.worldBbox.minY.toFixed(2)} (scaled: ${(big.worldBbox.minY * scale).toFixed(2)})`);
    console.log(`To put THIS mesh's bottom at ground (y=0), yOffset should be:`);
    console.log(`  yOffset = 2 - (-pivotOffsetY + big_minY * scale)`);
    const wanted = 2 - (-pivotOffsetY + big.worldBbox.minY * scale);
    console.log(`         = ${wanted.toFixed(2)}`);

    resolve();
  }, reject);
});
