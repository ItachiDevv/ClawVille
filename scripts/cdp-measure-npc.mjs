// Measure: possessed NPC rendered height + speed (position delta over 1s)
const res = await fetch('http://localhost:9222/json/list');
const tabs = await res.json();
const tab = tabs.find(t => t.url.includes('clawville.world/game'));
const WS = (await import('ws')).default;
const ws = new WS(tab.webSocketDebuggerUrl);
await new Promise(r => ws.on('open', r));
let id = 1;
function call(method, params = {}) {
  const reqId = id++;
  return new Promise((resolve) => {
    ws.on('message', function onMsg(m) {
      const d = JSON.parse(m.toString());
      if (d.id === reqId) { ws.off('message', onMsg); resolve(d); }
    });
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}
async function exec(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}

// Helper: find possessed NPC by searching for the NPC with facingAngle set non-null
// But we don't have npcStore exposed. Alternative: NPC mode follow camera targets the possessed NPC,
// and OrbitControls target is set to NPC pos. Just find the NPC nearest camera-target.
// Even better: measure ALL avatar-scale-groups and report sizes + positions.
const measureExpr = `(() => {
  const scene = window.__W3D?.scene;
  if (!scene) return { error: 'no scene' };
  // Find groups whose first child has avatar-like scale (10-120)
  const out = [];
  scene.traverse((o) => {
    if (!o.isGroup || !o.children || o.children.length === 0) return;
    const c = o.children[0];
    if (!c?.scale || c.scale.x < 10 || c.scale.x > 120) return;
    // Measure world-space bbox of this group
    o.updateMatrixWorld(true);
    let minY = Infinity, maxY = -Infinity;
    o.traverse((n) => {
      if (!n.isMesh || !n.geometry) return;
      if (n.isSkinnedMesh) return; // skeletal inflates bbox
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      const bb = n.geometry.boundingBox;
      if (!bb) return;
      // Transform bbox corners through matrixWorld
      const corners = [
        [bb.min.x, bb.min.y, bb.min.z],
        [bb.min.x, bb.min.y, bb.max.z],
        [bb.min.x, bb.max.y, bb.min.z],
        [bb.min.x, bb.max.y, bb.max.z],
        [bb.max.x, bb.min.y, bb.min.z],
        [bb.max.x, bb.min.y, bb.max.z],
        [bb.max.x, bb.max.y, bb.min.z],
        [bb.max.x, bb.max.y, bb.max.z],
      ];
      const m = n.matrixWorld.elements;
      for (const [x, y, z] of corners) {
        const wy = m[1]*x + m[5]*y + m[9]*z + m[13];
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
    });
    const h = (maxY === -Infinity) ? 0 : (maxY - minY);
    if (h > 5) {
      out.push({
        scale: +c.scale.x.toFixed(1),
        worldH: +h.toFixed(0),
        rotY: +(((o.rotation.y % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI)).toFixed(2),
        pos: [+o.position.x.toFixed(0), +o.position.z.toFixed(0)],
      });
    }
  });
  return { count: out.length, avatars: out.sort((a,b) => b.worldH - a.worldH).slice(0, 15) };
})()`;

// Activate game tab + bring to front for RAF
await call('Page.bringToFront');
await new Promise(r => setTimeout(r, 500));

// Make sure NPC Mode is active
const switchMode = `(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const npc = btns.find(b => b.textContent?.trim() === 'NPC Mode');
  if (npc && !npc.className.includes('bg-cyan-500')) { npc.click(); return 'clicked'; }
  return 'already-npc';
})()`;
console.log('mode:', await exec(switchMode));
await new Promise(r => setTimeout(r, 1000));

console.log('BEFORE (idle):');
console.log(JSON.stringify(await exec(measureExpr), null, 2));

// Send keydown via CDP Input.dispatchKeyEvent — more realistic than window.dispatchEvent
async function sendKey(type, key) {
  const codeMap = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD' };
  const code = codeMap[key] || key;
  await call('Input.dispatchKeyEvent', {
    type,
    key,
    code,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  });
}

// Get initial NPC position from avatar measurement
const avB = await exec(measureExpr);
const targetNpc = avB.avatars?.find(a => Math.hypot(a.pos[0], a.pos[1]) < 500); // near origin
if (!targetNpc) { console.log('no NPC near origin; avatars:', avB); ws.close(); process.exit(0); }
console.log('target NPC before:', targetNpc);

// Focus the canvas first
await exec(`document.querySelector('canvas')?.focus(); window.focus();`);
// Also close any tutorial/modal
await exec(`document.querySelectorAll('button').forEach(b => { if (/^(Got it|Close|Skip|×)$/i.test(b.textContent?.trim())) b.click(); })`);
await new Promise(r => setTimeout(r, 300));

await sendKey('keyDown', 'd');
await new Promise(r => setTimeout(r, 1000));
await sendKey('keyUp', 'd');
await new Promise(r => setTimeout(r, 200));

const avA = await exec(measureExpr);
const afterNpc = avA.avatars?.find(a => Math.abs(a.worldH - targetNpc.worldH) < 2 && Math.hypot(a.pos[0] - targetNpc.pos[0], a.pos[1] - targetNpc.pos[1]) < 1000);
console.log('after 1s of D:', afterNpc);
if (afterNpc) {
  const dx = afterNpc.pos[0] - targetNpc.pos[0];
  const dz = afterNpc.pos[1] - targetNpc.pos[1];
  console.log(`displacement: dx=${dx}, dz=${dz}, speed=${Math.hypot(dx, dz).toFixed(0)} units/sec (expected ~320 at SPEED=320)`);
}

ws.close();
