import { NodeIO } from '@gltf-transform/core';
const io = new NodeIO();
const doc = await io.read('apps/web/public/models/guide-rigged.glb');
const root = doc.getRoot();
console.log('Animations:', root.listAnimations().length);
for (const anim of root.listAnimations()) {
  console.log('\n== Clip:', JSON.stringify(anim.getName()));
  const channels = anim.listChannels();
  console.log('  channels:', channels.length);
  for (let i = 0; i < Math.min(3, channels.length); i++) {
    const ch = channels[i];
    const target = ch.getTargetNode();
    const path = ch.getTargetPath();
    console.log('   target:', JSON.stringify(target?.getName()), '.' + path);
  }
}
