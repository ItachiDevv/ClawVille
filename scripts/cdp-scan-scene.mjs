#!/usr/bin/env bun
// Scan the live three.js scene for oversized objects.
// Relies on window.__R3F = { scene, camera, gl } which is exposed by
// apps/web/src/components/three/World3DCanvas.tsx PreCompilePipelines.

const JS = `
(() => {
  const r3f = window.__R3F;
  if (!r3f) return 'no __R3F';
  const scene = r3f.scene;

  // THREE is not on window; borrow from scene's constructor chain.
  // Every Object3D has Box3 imports via its internal methods — but Box3 itself
  // isn't exported. We'll compute bbox manually via vertex math for deterministic
  // control.

  // Get each TOP-LEVEL child group of the scene and its rendered bbox.
  const results = [];
  const inf = Infinity;

  function computeBBoxManual(obj) {
    const min = { x: inf, y: inf, z: inf };
    const max = { x: -inf, y: -inf, z: -inf };
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      // Transform bbox corners by world matrix
      const mw = o.matrixWorld.elements;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? bb.max.x : bb.min.x;
        const y = i & 2 ? bb.max.y : bb.min.y;
        const z = i & 4 ? bb.max.z : bb.min.z;
        const wx = mw[0]*x + mw[4]*y + mw[8]*z  + mw[12];
        const wy = mw[1]*x + mw[5]*y + mw[9]*z  + mw[13];
        const wz = mw[2]*x + mw[6]*y + mw[10]*z + mw[14];
        if (wx<min.x) min.x=wx; if (wx>max.x) max.x=wx;
        if (wy<min.y) min.y=wy; if (wy>max.y) max.y=wy;
        if (wz<min.z) min.z=wz; if (wz>max.z) max.z=wz;
      }
    });
    if (min.x === inf) return null;
    return { min, max, size: { x: max.x-min.x, y: max.y-min.y, z: max.z-min.z } };
  }

  // Walk direct children and record each, sorted by max dimension
  for (let i = 0; i < scene.children.length; i++) {
    const child = scene.children[i];
    const bb = computeBBoxManual(child);
    if (!bb) continue;
    const maxDim = Math.max(bb.size.x, bb.size.y, bb.size.z);
    results.push({
      idx: i,
      name: child.name || '(noname)',
      type: child.type,
      maxDim: Math.round(maxDim),
      sx: Math.round(bb.size.x),
      sy: Math.round(bb.size.y),
      sz: Math.round(bb.size.z),
      cx: Math.round((bb.min.x+bb.max.x)/2),
      cy: Math.round((bb.min.y+bb.max.y)/2),
      cz: Math.round((bb.min.z+bb.max.z)/2),
      kidCount: child.children.length,
    });
  }

  results.sort((a,b) => b.maxDim - a.maxDim);
  return JSON.stringify(results.slice(0, 25), null, 2);
})()
`;

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no page'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const reply = await new Promise((resolve) => {
  ws.onmessage = (e) => resolve(JSON.parse(e.data));
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: JS, returnByValue: true, awaitPromise: true, timeout: 20000 }
  }));
});

if (reply?.result?.exceptionDetails) {
  console.error('EX', JSON.stringify(reply.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(reply.result.result.value);
ws.close();
