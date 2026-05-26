#!/usr/bin/env bun
// Drill into the location NPCs group — report each child's bbox.

const JS = `
(() => {
  const s = window.__R3F?.scene;
  if (!s) return 'no scene';

  // Find the group with 10 kids that matches the location NPCs (not wandering).
  // Both groups have 10 kids. Distinguish by position/size — location NPCs are
  // ring-sized (~3600-8000 max dim).
  const candidates = [];
  for (let i = 0; i < s.children.length; i++) {
    const c = s.children[i];
    if (c.type !== 'Group' || c.children.length !== 10) continue;
    // Skip buildings group (idx 16 from earlier scan — 4087 wide)
    // location NPCs: 8711 wide — wider
    const inf = Infinity;
    const min = { x: inf, y: inf, z: inf };
    const max = { x: -inf, y: -inf, z: -inf };
    c.updateWorldMatrix(true, true);
    c.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry; if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox; if (!bb) return;
      const mw = o.matrixWorld.elements;
      for (let j = 0; j < 8; j++) {
        const x = j&1?bb.max.x:bb.min.x, y=j&2?bb.max.y:bb.min.y, z=j&4?bb.max.z:bb.min.z;
        const wx=mw[0]*x+mw[4]*y+mw[8]*z+mw[12], wy=mw[1]*x+mw[5]*y+mw[9]*z+mw[13], wz=mw[2]*x+mw[6]*y+mw[10]*z+mw[14];
        if(wx<min.x)min.x=wx; if(wx>max.x)max.x=wx;
        if(wy<min.y)min.y=wy; if(wy>max.y)max.y=wy;
        if(wz<min.z)min.z=wz; if(wz>max.z)max.z=wz;
      }
    });
    if (min.x === inf) continue;
    candidates.push({ idx: i, group: c, size: {x:max.x-min.x, y:max.y-min.y, z:max.z-min.z} });
  }
  // Sort by y (tall groups first). Location NPCs had sy=1361 > buildings sy=778.
  candidates.sort((a,b) => b.size.y - a.size.y);
  const locGroup = candidates[0]?.group;
  if (!locGroup) return 'no loc group';

  // Now measure each child individually
  const inf = Infinity;
  const per = [];
  for (let k = 0; k < locGroup.children.length; k++) {
    const child = locGroup.children[k];
    const min = { x: inf, y: inf, z: inf };
    const max = { x: -inf, y: -inf, z: -inf };
    let meshCount = 0;
    child.traverse((o) => {
      if (!o.isMesh) return;
      meshCount++;
      const g = o.geometry; if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox; if (!bb) return;
      const mw = o.matrixWorld.elements;
      for (let j = 0; j < 8; j++) {
        const x = j&1?bb.max.x:bb.min.x, y=j&2?bb.max.y:bb.min.y, z=j&4?bb.max.z:bb.min.z;
        const wx=mw[0]*x+mw[4]*y+mw[8]*z+mw[12], wy=mw[1]*x+mw[5]*y+mw[9]*z+mw[13], wz=mw[2]*x+mw[6]*y+mw[10]*z+mw[14];
        if(wx<min.x)min.x=wx; if(wx>max.x)max.x=wx;
        if(wy<min.y)min.y=wy; if(wy>max.y)max.y=wy;
        if(wz<min.z)min.z=wz; if(wz>max.z)max.z=wz;
      }
    });
    per.push({
      k,
      meshCount,
      sx: Math.round(max.x-min.x), sy: Math.round(max.y-min.y), sz: Math.round(max.z-min.z),
      cx: Math.round((min.x+max.x)/2), cy: Math.round((min.y+max.y)/2), cz: Math.round((min.z+max.z)/2),
      pos: [Math.round(child.position.x), Math.round(child.position.y), Math.round(child.position.z)],
      kidsInChild: child.children.length,
    });
  }
  per.sort((a,b) => b.sy - a.sy);
  return JSON.stringify(per, null, 2);
})()
`;

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const reply = await new Promise((r) => {
  ws.onmessage = (e) => r(JSON.parse(e.data));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: JS, returnByValue: true } }));
});
if (reply?.result?.exceptionDetails) { console.error('EX', JSON.stringify(reply.result.exceptionDetails)); process.exit(1); }
console.log(reply.result.result.value);
ws.close();
