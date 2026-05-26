#!/usr/bin/env bun
// List ALL groups and their children; explicitly find the outlier group.

const JS = `
(() => {
  const s = window.__R3F?.scene;
  if (!s) return 'no scene';
  const inf = Infinity;

  function bb(obj) {
    const min = { x: inf, y: inf, z: inf };
    const max = { x: -inf, y: -inf, z: -inf };
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry; if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const gbb = g.boundingBox; if (!gbb) return;
      const mw = o.matrixWorld.elements;
      for (let j = 0; j < 8; j++) {
        const x = j&1?gbb.max.x:gbb.min.x, y=j&2?gbb.max.y:gbb.min.y, z=j&4?gbb.max.z:gbb.min.z;
        const wx=mw[0]*x+mw[4]*y+mw[8]*z+mw[12], wy=mw[1]*x+mw[5]*y+mw[9]*z+mw[13], wz=mw[2]*x+mw[6]*y+mw[10]*z+mw[14];
        if(wx<min.x)min.x=wx; if(wx>max.x)max.x=wx;
        if(wy<min.y)min.y=wy; if(wy>max.y)max.y=wy;
        if(wz<min.z)min.z=wz; if(wz>max.z)max.z=wz;
      }
    });
    if (min.x === inf) return null;
    return { min, max, size:{x:max.x-min.x,y:max.y-min.y,z:max.z-min.z} };
  }

  // Find groups with sy > 1000
  const out = [];
  for (let i = 0; i < s.children.length; i++) {
    const c = s.children[i];
    const b = bb(c);
    if (!b) continue;
    if (b.size.y < 1000) continue;
    // Drill into each child
    const per = [];
    for (let k = 0; k < c.children.length; k++) {
      const kb = bb(c.children[k]);
      if (!kb) continue;
      per.push({
        k,
        sy: Math.round(kb.size.y),
        sx: Math.round(kb.size.x),
        sz: Math.round(kb.size.z),
        cy: Math.round((kb.min.y+kb.max.y)/2),
        cx: Math.round((kb.min.x+kb.max.x)/2),
        cz: Math.round((kb.min.z+kb.max.z)/2),
        pos: [Math.round(c.children[k].position.x), Math.round(c.children[k].position.y), Math.round(c.children[k].position.z)],
        innerKids: c.children[k].children.length,
        meshNames: [],
      });
      // Also capture mesh names of the tallest child (first 3)
      if (per.length <= 3 || kb.size.y > 200) {
        const names = [];
        c.children[k].traverse((o) => {
          if (o.isMesh && names.length < 3) {
            const mat = o.material;
            const matName = Array.isArray(mat) ? mat[0]?.name : mat?.name;
            names.push({ n: o.name || '(noname)', m: matName || '(nomat)', parent: o.parent?.name || '' });
          }
        });
        per[per.length-1].meshNames = names;
      }
    }
    per.sort((a,b)=>b.sy-a.sy);
    out.push({ parentIdx: i, parentSy: Math.round(b.size.y), parentSx: Math.round(b.size.x), parentCy: Math.round((b.min.y+b.max.y)/2), childCount: c.children.length, per });
  }
  return JSON.stringify(out, null, 2);
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
if (reply?.result?.exceptionDetails) { console.error('EX', JSON.stringify(reply.result.exceptionDetails).substring(0,500)); process.exit(1); }
console.log(reply.result.result.value);
ws.close();
