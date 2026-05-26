#!/usr/bin/env bun
// Probe 5: check other Normalized bones, check mixer._accuIndex/_actions private state

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no tab'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

async function evalExpr(expr, reqId) {
  return new Promise(resolve => {
    const handler = e => {
      const m = JSON.parse(e.data);
      if (m.id === reqId) {
        ws.removeEventListener('message', handler);
        resolve(m);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({
      id: reqId,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: 20000 }
    }));
  });
}

// Phase A: Sample MANY Normalized bones + arm bones — hips position=rest-pose for idle anim
//           But arms/spine should have rotations in an idle animation
const phaseA = `
(() => {
  const scene = window.__R3F.scene;
  const sample = {};
  const boneNamesOfInterest = [
    'Normalized_mixamorigLeftArm',
    'Normalized_mixamorigRightArm',
    'Normalized_mixamorigLeftForeArm',
    'Normalized_mixamorigRightForeArm',
    'Normalized_mixamorigLeftHand',
    'Normalized_mixamorigSpine',
    'Normalized_mixamorigSpine2',
    'Normalized_mixamorigHead',
    'Normalized_mixamorigLeftUpLeg',
    'Normalized_mixamorigRightUpLeg',
    'mixamorigLeftArm',
    'mixamorigLeftForeArm',
    'mixamorigSpine',
    // Native Milady skeleton bones (what the SkinnedMesh's skeleton uses):
    '_rootJoint',
    'Body_01',
    'R_eye_02',
    'Root_01',
    'Spine1_02',
    'Spine2_03',
  ];
  boneNamesOfInterest.forEach(name => {
    const nodes = [];
    scene.traverse(o => { if (o.name === name) nodes.push(o); });
    sample[name] = nodes.slice(0, 3).map(n => ({
      q: [n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w].map(v => v.toFixed(4)),
      parent: n.parent?.name,
      count: nodes.length,
    }));
  });
  window.__probe5A = sample;
  return sample;
})()
`;
console.log('--- Phase A (bone quaternion snapshot, MANY bones) ---');
const r1 = await evalExpr(phaseA, 1);
if (r1?.result?.exceptionDetails) { console.error(JSON.stringify(r1.result.exceptionDetails, null, 2)); process.exit(1); }
console.log(JSON.stringify(r1.result.result.value, null, 2));

await new Promise(r => setTimeout(r, 3000));

const phaseB = `
(() => {
  const scene = window.__R3F.scene;
  const prev = window.__probe5A;
  const sample = {};
  const boneNamesOfInterest = Object.keys(prev);
  boneNamesOfInterest.forEach(name => {
    const nodes = [];
    scene.traverse(o => { if (o.name === name) nodes.push(o); });
    const nowSample = nodes.slice(0, 3).map(n => [n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w]);
    const prevSample = (prev[name] || []).map(s => s.q.map(Number));
    const deltas = nowSample.map((now, i) => {
      const p = prevSample[i];
      if (!p) return 'no-prev';
      const d = [0,1,2,3].reduce((acc, j) => acc + Math.abs(now[j] - p[j]), 0);
      return d.toFixed(5);
    });
    sample[name] = { deltas, q0: nowSample[0]?.map(v => v.toFixed(4)) };
  });
  return sample;
})()
`;

console.log('\n--- Phase B (delta after 3s) ---');
const r2 = await evalExpr(phaseB, 2);
if (r2?.result?.exceptionDetails) { console.error(JSON.stringify(r2.result.exceptionDetails, null, 2)); }
else console.log(JSON.stringify(r2.result.result.value, null, 2));

// Phase C: Find the AnimationMixer via scene traversal, inspect its _actions and _bindings
const phaseC = `
(() => {
  const scene = window.__R3F.scene;
  // Find VRMHumanoidRig, walk up to a node that might hold userData.mixer.
  // Alt: look for the mixer via userData on any descendent of the Scene.
  let mixerHits = [];
  scene.traverse(o => {
    const ud = o.userData || {};
    if (ud.mixer) mixerHits.push({ name: o.name, type: o.type, mixerRoot: ud.mixer._root?.name });
    if (ud.animator) mixerHits.push({ name: o.name, type: o.type, hasAnimator: true });
    // Also inspect _listeners, _mixer fields (not standard three but possible)
    for (const k of Object.keys(o)) {
      if (k.toLowerCase().includes('mixer')) mixerHits.push({ name: o.name, key: k });
    }
  });

  // Also try: R3F internal frameloop status
  const r3f = window.__R3F;
  const r3fStoreKeys = Object.keys(r3f);

  // Peek at internals of @react-three/fiber via the canvas DOM node
  const canvases = document.querySelectorAll('canvas');
  const canvasInfo = Array.from(canvases).map(c => {
    const rect = c.getBoundingClientRect();
    return { w: rect.width, h: rect.height, w_attr: c.width, h_attr: c.height };
  });

  return { mixerHits: mixerHits.slice(0, 20), r3fStoreKeys, canvasInfo };
})()
`;

console.log('\n--- Phase C (mixer search + R3F internals) ---');
const r3 = await evalExpr(phaseC, 3);
if (r3?.result?.exceptionDetails) { console.error(JSON.stringify(r3.result.exceptionDetails, null, 2)); }
else console.log(JSON.stringify(r3.result.result.value, null, 2));

// Phase D: force-step 1s of useFrame by redispatching — cannot. But we CAN check if clock.elapsedTime is advancing
const phaseD = `
(() => {
  // Find any Three.js Clock... can't easily. Use renderer.info to see if frame count grows.
  const r3f = window.__R3F;
  const renderer = r3f?.gl;
  const info = renderer?.info;
  const frameCount = info?.render?.frame;
  return {
    frameCount,
    drawCalls: info?.render?.calls,
    renderFrameCalls: info?.render?.frameCalls,
    triangles: info?.render?.triangles,
    t: performance.now(),
  };
})()
`;
console.log('\n--- Phase D1 (frame counter now) ---');
const rD1 = await evalExpr(phaseD, 4);
console.log(JSON.stringify(rD1.result.result.value, null, 2));

await new Promise(r => setTimeout(r, 2000));

console.log('\n--- Phase D2 (frame counter after 2s) ---');
const rD2 = await evalExpr(phaseD, 5);
console.log(JSON.stringify(rD2.result.result.value, null, 2));

ws.close();
