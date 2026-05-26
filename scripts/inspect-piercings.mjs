import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();
const doc = await io.read('C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/piercings/piercings_2.glb');
const root = doc.getRoot();

console.log(`Meshes: ${root.listMeshes().length}`);
console.log(`Nodes: ${root.listNodes().length}`);
console.log(`Skins: ${root.listSkins().length}`);
console.log(`Materials: ${root.listMaterials().length}`);

console.log('\n--- NODE HIERARCHY ---');
function walk(node, depth = 0) {
  const mesh = node.getMesh();
  const t = node.getTranslation();
  const s = node.getScale();
  const pad = '  '.repeat(depth);
  let meshInfo = '';
  if (mesh) {
    let verts = 0, tris = 0;
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      const idx = p.getIndices();
      if (pos) verts += pos.getCount();
      if (idx) tris += idx.getCount() / 3;
    }
    meshInfo = ` [MESH verts=${verts} tris=${Math.round(tris)}]`;
  }
  console.log(`${pad}${node.getName() || '(unnamed)'} pos=[${t.map(v => v.toFixed(2)).join(',')}] scale=[${s.map(v => v.toFixed(2)).join(',')}]${meshInfo}`);
  for (const c of node.listChildren()) walk(c, depth + 1);
}
for (const scene of root.listScenes()) {
  console.log(`\nScene: ${scene.getName()}`);
  for (const n of scene.listChildren()) walk(n);
}

console.log('\n--- MESHES ---');
for (const m of root.listMeshes()) {
  const name = m.getName();
  let verts = 0, tris = 0;
  const box = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
  for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    const idx = p.getIndices();
    if (pos) {
      verts += pos.getCount();
      const arr = pos.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        for (let j = 0; j < 3; j++) {
          if (arr[i + j] < box.min[j]) box.min[j] = arr[i + j];
          if (arr[i + j] > box.max[j]) box.max[j] = arr[i + j];
        }
      }
    }
    if (idx) tris += idx.getCount() / 3;
  }
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  console.log(`  "${name}" verts=${verts} tris=${Math.round(tris)} size=${size.map(v => v.toFixed(3)).join('x')} min=[${box.min.map(v => v.toFixed(2)).join(',')}] max=[${box.max.map(v => v.toFixed(2)).join(',')}]`);
}
