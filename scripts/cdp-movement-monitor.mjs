const EXPR = `(() => {
  const mm = document.querySelector("[aria-label=\\"Minimap\\"], .minimap, canvas");
  const petPosText = document.body.innerText.match(/\\d{3,4},\\d{3,4}/)?.[0];
  // Try to read store directly if exposed
  const r3f = window.__R3F;
  const cam = r3f?.camera ? {cx: r3f.camera.position.x, cy: r3f.camera.position.y, cz: r3f.camera.position.z} : null;
  // Scene graph pet position: find lobster in scene
  return {petPosText, cam, petMode: document.body.innerText.includes("TRAVELING")};
})()`;

import { spawnSync } from 'node:child_process';
for (let i = 1; i <= 8; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const res = spawnSync('bun', ['run', 'C:/Users/newma/.claude/skills/browser-live/cdp-eval.ts', EXPR, 'clawville.world'], { encoding: 'utf8' });
  console.log(`--- tick ${i} (${new Date().toISOString()}) ---`);
  console.log(res.stdout);
  if (res.stderr) console.error(res.stderr);
}
