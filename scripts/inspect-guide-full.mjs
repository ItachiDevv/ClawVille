import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();
const doc = await io.read('C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/guide.glb');
const root = doc.getRoot();

console.log('=== guide.glb full node inventory ===');
function walk(node, depth = 0) {
  const mesh = node.getMesh();
  const t = node.getTranslation();
  let info = `${'  '.repeat(depth)}"${node.getName() || '(unnamed)'}"`;
  if (mesh) {
    const primMats = mesh.listPrimitives().map(p => p.getMaterial()?.getName() || '(no mat)').join(', ');
    let verts = 0;
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      if (pos) verts += pos.getCount();
    }
    info += ` [MESH verts=${verts} mat=${primMats}]`;
  }
  console.log(info);
  for (const c of node.listChildren()) walk(c, depth + 1);
}
for (const scene of root.listScenes()) {
  for (const n of scene.listChildren()) walk(n);
}

console.log('\n=== Skeleton bones (from skins) ===');
for (const skin of root.listSkins()) {
  console.log(`Skin: ${skin.getName()}`);
  for (const joint of skin.listJoints()) {
    console.log(`  bone: ${joint.getName()}`);
  }
}
