// Systematic facing test: each cardinal direction, capture overlay values + screenshot
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

const fs = await import('fs');

await call('Page.bringToFront');
await new Promise(r => setTimeout(r, 300));

// Ensure we are in NPC Mode
const modeResult = await exec(`(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const npc = btns.find(b => b.textContent?.trim() === 'NPC Mode');
  if (npc && !npc.className.includes('bg-cyan-500')) { npc.click(); return 'clicked'; }
  return 'already-npc';
})()`);
console.log('mode:', modeResult);
await new Promise(r => setTimeout(r, 500));

// Override camera to a near-top-down view of the possessed NPC so head direction is obvious
const rigCam = `(() => {
  const cam = window.__W3D?.camera;
  const scene = window.__W3D?.scene;
  if (!cam || !scene) return 'no_cam';
  // Find possessed NPC by finding top-level group containing a group with a primitive that matches the lobster scale range
  let npc = null;
  scene.traverse((o) => {
    if (!o.isGroup || !o.children || o.children.length === 0) return;
    const c = o.children[0];
    if (!c?.scale || c.scale.x < 10 || c.scale.x > 120) return;
    // Possessed NPC is typically near origin in this test
    const d = Math.hypot(o.position.x, o.position.z);
    if (d < 800 && (!npc || d < Math.hypot(npc.position.x, npc.position.z))) npc = o;
  });
  if (!npc) return 'no_npc';
  // Near-top-down camera, slight tilt forward so we can see head clearly
  cam.position.set(npc.position.x, npc.position.y + 300, npc.position.z + 120);
  cam.lookAt(npc.position.x, npc.position.y + 20, npc.position.z);
  cam.updateProjectionMatrix();
  return { npcX: +npc.position.x.toFixed(0), npcZ: +npc.position.z.toFixed(0), camY: 300, camZ: +(npc.position.z + 120).toFixed(0) };
})()`;
console.log('rig:', await exec(rigCam));

// Send CDP keyboard events (not dom events - real key injection)
async function key(type, ch) {
  const codeMap = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD' };
  await call('Input.dispatchKeyEvent', {
    type,
    key: ch,
    code: codeMap[ch] || ch,
    windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
  });
}

async function testKey(label, ch) {
  // Focus canvas/window
  await exec(`document.querySelector('canvas')?.focus(); window.focus();`);
  await key('keyDown', ch);
  // Hold for 600ms while camera keeps pinned on the NPC every 150ms
  for (let t = 0; t < 4; t++) {
    await exec(rigCam);
    await new Promise(r => setTimeout(r, 150));
  }
  // Capture state + screenshot AT THE MOMENT keys are still down
  const state = await exec(`JSON.stringify(window.__FACING_DEBUG)`);
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`./screenshots/facing-${label}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`${label}:`, state);
  await key('keyUp', ch);
  await new Promise(r => setTimeout(r, 400));
}

await testKey('w', 'w');
await testKey('s', 's');
await testKey('a', 'a');
await testKey('d', 'd');

ws.close();
console.log('done');
