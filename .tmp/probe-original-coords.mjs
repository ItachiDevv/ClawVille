import fs from 'node:fs';
import path from 'node:path';

const GLTF_BASE = 'C:/Users/newma/AppData/Local/npm-cache/_npx/a6797f7ff67bb1f2/node_modules/@gltf-transform';
const { NodeIO } = await import(`file:///${GLTF_BASE}/core/dist/index.cjs`);
const { KHRONOS_EXTENSIONS, EXTTextureWebP } = await import(`file:///${GLTF_BASE}/extensions/dist/index.cjs`);

const io = new NodeIO().registerExtensions([...KHRONOS_EXTENSIONS, EXTTextureWebP]);
const doc = await io.read(path.resolve('.tmp/casino-undraco.glb'));

console.log('Per-mesh bbox + position histograms in slot/table zones:\n');
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const posAcc = prim.getAttribute('POSITION');
    if (!posAcc) continue;
    const arr = posAcc.getArray();
    const n = arr.length / 3;
    let xmin=Infinity, xmax=-Infinity, ymin=Infinity, ymax=-Infinity, zmin=Infinity, zmax=-Infinity;
    let nNegZSlot = 0, nPosZSlot = 0, nDealerCenter = 0, nFrontPokerZone = 0, nBackPokerZone = 0;
    for (let v = 0; v < n; v++) {
      const x = arr[v*3], y = arr[v*3+1], z = arr[v*3+2];
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (z < zmin) zmin = z; if (z > zmax) zmax = z;
      // Diagnostic counts
      if (x >= -963 && x <= -478 && z >= -395 && z <= -210) nFrontPokerZone++;
      if (x >= -963 && x <= -478 && z >= -245 && z <= -65)  nBackPokerZone++;
      if (x >= -780 && x <= -660 && z >= -35  && z <= 35)   nDealerCenter++;
      if (z >= 100 && z < 400) nPosZSlot++;  // tentative slot zone
      if (z >= -400 && z < -100) nNegZSlot++;
    }
    const name = mesh.getName() || '(unnamed)';
    console.log(`${name.padEnd(20)} verts=${n.toString().padStart(6)}  bbox X[${xmin.toFixed(0)},${xmax.toFixed(0)}] Y[${ymin.toFixed(0)},${ymax.toFixed(0)}] Z[${zmin.toFixed(0)},${zmax.toFixed(0)}]`);
    console.log(`  • front-poker zone (Z[-395,-210]): ${nFrontPokerZone}`);
    console.log(`  • back-poker zone  (Z[-245,-65 ]): ${nBackPokerZone}`);
    console.log(`  • dealer center    (X[-780,-660] Z[-35,+35]): ${nDealerCenter}`);
    console.log(`  • positive-Z slots (Z[100,400]):    ${nPosZSlot}`);
    console.log(`  • negative-Z slots (Z[-400,-100]):  ${nNegZSlot}`);
  }
}
