import { NodeIO } from '@gltf-transform/core';
const io = new NodeIO();
for (const path of ['apps/web/public/avatars/animations/idle.glb', 'apps/web/public/avatars/animations/walk.glb']) {
  console.log('\n==', path);
  const doc = await io.read(path);
  const root = doc.getRoot();
  console.log('Animations:', root.listAnimations().length);
  for (const anim of root.listAnimations()) {
    const channels = anim.listChannels();
    const samplers = anim.listSamplers();
    console.log('  Clip:', JSON.stringify(anim.getName()), 'channels:', channels.length);
    // Duration
    let maxTime = 0;
    for (const s of samplers) {
      const input = s.getInput();
      if (input) {
        const arr = input.getArray();
        if (arr) maxTime = Math.max(maxTime, arr[arr.length - 1]);
      }
    }
    console.log('  Duration:', maxTime.toFixed(3), 's');
    const sample = channels.slice(0, 3).map(c => `${c.getTargetNode()?.getName()}.${c.getTargetPath()}`);
    console.log('  Sample tracks:', sample);
  }
}
