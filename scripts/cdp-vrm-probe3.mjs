#!/usr/bin/env bun
// Probe 3: Find the AnimationMixer state + sample bone quaternions over time

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

// Phase A: sample hips quaternion now
const phaseA = `
(() => {
  const scene = window.__R3F.scene;
  const hipsNodes = [];
  scene.traverse(o => { if (o.name === 'Normalized_mixamorigHips') hipsNodes.push(o); });
  const hipsSrcNodes = [];
  scene.traverse(o => { if (o.name === 'mixamorigHips') hipsSrcNodes.push(o); });
  const sample = hipsNodes.map((h, i) => ({
    idx: i,
    parent: h.parent?.name || null,
    q: [h.quaternion.x, h.quaternion.y, h.quaternion.z, h.quaternion.w],
    p: [h.position.x, h.position.y, h.position.z],
  }));
  const sampleSrc = hipsSrcNodes.map((h, i) => ({
    idx: i,
    parent: h.parent?.name || null,
    q: [h.quaternion.x, h.quaternion.y, h.quaternion.z, h.quaternion.w],
  }));
  // Stash for comparison
  window.__probeA = { t: Date.now(), hips: sample, hipsSrc: sampleSrc };
  return { hipsCount: hipsNodes.length, hipsSrcCount: hipsSrcNodes.length, sample: sample.slice(0,3), sampleSrc: sampleSrc.slice(0,3) };
})()
`;

console.log('--- Phase A (t=0) ---');
const r1 = await evalExpr(phaseA, 1);
if (r1?.result?.exceptionDetails) { console.error(JSON.stringify(r1.result.exceptionDetails, null, 2)); process.exit(1); }
console.log(JSON.stringify(r1.result.result.value, null, 2));

// Wait 3 seconds for animation ticks
await new Promise(r => setTimeout(r, 3000));

const phaseB = `
(() => {
  const scene = window.__R3F.scene;
  const hipsNodes = [];
  scene.traverse(o => { if (o.name === 'Normalized_mixamorigHips') hipsNodes.push(o); });
  const hipsSrcNodes = [];
  scene.traverse(o => { if (o.name === 'mixamorigHips') hipsSrcNodes.push(o); });
  const sample = hipsNodes.map((h, i) => ({
    idx: i,
    q: [h.quaternion.x, h.quaternion.y, h.quaternion.z, h.quaternion.w],
  }));
  const sampleSrc = hipsSrcNodes.map((h, i) => ({
    idx: i,
    q: [h.quaternion.x, h.quaternion.y, h.quaternion.z, h.quaternion.w],
  }));
  const prev = window.__probeA;
  const deltas = sample.map((s, i) => {
    const p = prev?.hips?.[i];
    if (!p) return { idx: i, delta: null };
    const dx = Math.abs(s.q[0] - p.q[0]);
    const dy = Math.abs(s.q[1] - p.q[1]);
    const dz = Math.abs(s.q[2] - p.q[2]);
    const dw = Math.abs(s.q[3] - p.q[3]);
    return { idx: i, sum: (dx+dy+dz+dw).toFixed(6), q: s.q.map(v => v.toFixed(4)) };
  });
  const deltasSrc = sampleSrc.map((s, i) => {
    const p = prev?.hipsSrc?.[i];
    if (!p) return { idx: i, delta: null };
    const dx = Math.abs(s.q[0] - p.q[0]);
    const dy = Math.abs(s.q[1] - p.q[1]);
    const dz = Math.abs(s.q[2] - p.q[2]);
    const dw = Math.abs(s.q[3] - p.q[3]);
    return { idx: i, sum: (dx+dy+dz+dw).toFixed(6), q: s.q.map(v => v.toFixed(4)) };
  });
  return { dtMs: Date.now() - (prev?.t || 0), deltasNormalized: deltas, deltasSource: deltasSrc };
})()
`;

console.log('\n--- Phase B (after 3s wait) — quaternion deltas ---');
const r2 = await evalExpr(phaseB, 2);
if (r2?.result?.exceptionDetails) { console.error(JSON.stringify(r2.result.exceptionDetails, null, 2)); process.exit(1); }
console.log(JSON.stringify(r2.result.result.value, null, 2));

// Phase C: walk up from hips to find the humanoid rig and its mixer
const phaseC = `
(() => {
  const scene = window.__R3F.scene;
  const hipsNodes = [];
  scene.traverse(o => { if (o.name === 'Normalized_mixamorigHips') hipsNodes.push(o); });

  const results = hipsNodes.slice(0, 5).map(h => {
    // Walk up to find VRMHumanoidRig or any node with userData.mixer
    let cur = h;
    const chain = [];
    while (cur && chain.length < 25) {
      chain.push({
        name: cur.name || '(noname)',
        type: cur.type,
        visible: cur.visible,
        udKeys: Object.keys(cur.userData || {}),
        hasMixer: !!cur.userData?.mixer,
        hasVrm: !!cur.userData?.vrm,
        hasAnimator: !!cur.userData?.animator,
      });
      cur = cur.parent;
    }
    return chain;
  });
  return results[0]; // first VRM's ancestor chain
})()
`;

console.log('\n--- Phase C (ancestor chain of first Normalized_Hips) ---');
const r3 = await evalExpr(phaseC, 3);
if (r3?.result?.exceptionDetails) { console.error(JSON.stringify(r3.result.exceptionDetails, null, 2)); process.exit(1); }
console.log(JSON.stringify(r3.result.result.value, null, 2));

ws.close();
