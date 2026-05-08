import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';

const loader = new GLTFLoader();
const buf = readFileSync(process.argv[2]);
loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', (gltf) => {
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3(); box.getSize(size);
  console.log(`POST-TRANSFORM bbox of ${process.argv[2]}:`);
  console.log(`  size: x=${size.x.toFixed(2)} y=${size.y.toFixed(2)} z=${size.z.toFixed(2)}`);
  console.log(`  bbox: min(${box.min.x.toFixed(2)}, ${box.min.y.toFixed(2)}, ${box.min.z.toFixed(2)})`);
  console.log(`        max(${box.max.x.toFixed(2)}, ${box.max.y.toFixed(2)}, ${box.max.z.toFixed(2)})`);
  // Print scene tree with scales
  gltf.scene.traverse(o => {
    const s = o.scale;
    if (Math.abs(s.x - 1) > 0.001 || Math.abs(s.y - 1) > 0.001 || Math.abs(s.z - 1) > 0.001) {
      console.log(`  node "${o.name || '<unnamed>'}" scale=(${s.x.toFixed(3)}, ${s.y.toFixed(3)}, ${s.z.toFixed(3)})`);
    }
  });
}, (err) => { console.error('parse err', err); process.exit(1); });
