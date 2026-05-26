import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();
for (const path of ['C:/Users/newma/Downloads/skirt_03.glb', 'C:/Users/newma/Downloads/skirt_9.glb']) {
  const doc = await io.read(path);
  const root = doc.getRoot();
  const name = path.split(/[\/]/).pop();
  console.log(`\n=== ${name} ===`);
  console.log(`Meshes: ${root.listMeshes().length}`);
  console.log(`Nodes: ${root.listNodes().length}`);
  console.log(`Skins: ${root.listSkins().length}`);
  console.log(`Animations: ${root.listAnimations().length}`);
  console.log(`Materials: ${root.listMaterials().length}`);
  let totalVerts = 0, totalTris = 0;
  for (const m of root.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      const idx = p.getIndices();
      if (pos) totalVerts += pos.getCount();
      if (idx) totalTris += idx.getCount() / 3;
    }
  }
  console.log(`Total verts: ${totalVerts}, tris: ${Math.round(totalTris)}`);
  const box = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
  for (const m of root.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      for (let i=0; i<arr.length; i+=3) {
        for (let j=0; j<3; j++) {
          if (arr[i+j] < box.min[j]) box.min[j] = arr[i+j];
          if (arr[i+j] > box.max[j]) box.max[j] = arr[i+j];
        }
      }
    }
  }
  const size = [box.max[0]-box.min[0], box.max[1]-box.min[1], box.max[2]-box.min[2]];
  console.log(`BBox min: [${box.min.map(v=>v.toFixed(3)).join(', ')}]`);
  console.log(`BBox max: [${box.max.map(v=>v.toFixed(3)).join(', ')}]`);
  console.log(`Size: ${size.map(v=>v.toFixed(3)).join(' x ')}`);
  for (const n of root.listNodes()) {
    console.log(`  Node "${n.getName()}" children=${n.listChildren().length}`);
  }
}
