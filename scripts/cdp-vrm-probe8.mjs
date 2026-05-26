#!/usr/bin/env bun
// Probe 8: Find THREE.AnimationMixer constructor via introspection, then install the patch AFTER animators get created

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no tab'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

async function evalExpr(expr, reqId) {
  return new Promise(resolve => {
    const handler = e => {
      const m = JSON.parse(e.data);
      if (m.id === reqId) { ws.removeEventListener('message', handler); resolve(m); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({
      id: reqId,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: 20000 }
    }));
  });
}

// Phase A: walk the VRMHumanoidRig and see if any of its children or any of the VRM scenes have a direct ref to an AnimationMixer
// THREE's AnimationMixer has a distinctive signature: an object with `_actions`, `_bindings`, `_nActiveActions`, `_accuIndex`, and `time` properties
const phaseA = `
(() => {
  const scene = window.__R3F.scene;

  // Exhaustive search for AnimationMixer-like objects
  const candidates = [];
  const seen = new WeakSet();
  function inspect(obj, path, depth) {
    if (!obj || depth > 3 || seen.has(obj)) return;
    if (typeof obj !== 'object') return;
    seen.add(obj);

    // Signature match
    if (Array.isArray(obj._actions) && Array.isArray(obj._bindings) && typeof obj.time === 'number' && typeof obj._accuIndex === 'number') {
      candidates.push({
        path,
        rootName: obj._root?.name || obj._root?.type,
        actions: obj._actions.length,
        bindings: obj._bindings.length,
        time: obj.time,
        timeScale: obj.timeScale,
        firstAction: obj._actions[0] ? {
          clipName: obj._actions[0]._clip?.name,
          running: typeof obj._actions[0].isRunning === 'function' ? obj._actions[0].isRunning() : null,
          enabled: obj._actions[0].enabled,
          paused: obj._actions[0].paused,
          weight: obj._actions[0].weight,
          time: obj._actions[0].time,
          _startTime: obj._actions[0]._startTime,
        } : null,
      });
      return;
    }

    for (const key in obj) {
      try {
        if (key === 'parent' || key === 'children' || key === '_listener' || key === '_listeners') continue;
        const v = obj[key];
        if (v && typeof v === 'object') inspect(v, path + '.' + key, depth + 1);
      } catch {}
    }
  }

  // Inspect Scene and VRMHumanoidRigs userData, renderer info
  scene.traverse(o => {
    if (o.userData) inspect(o.userData, o.name + '.userData', 0);
  });
  inspect(scene.userData || {}, 'scene.userData', 0);
  inspect(window.__R3F, '__R3F', 0);

  return { candidatesFound: candidates.length, candidates: candidates.slice(0, 10) };
})()
`;
console.log('--- Hunt for AnimationMixer by shape signature ---');
const rA = await evalExpr(phaseA, 1);
if (rA?.result?.exceptionDetails) console.error(JSON.stringify(rA.result.exceptionDetails, null, 2));
else console.log(JSON.stringify(rA.result.result.value, null, 2));

// Phase B: try exposing THREE via script-level search for a SkinnedMesh's prototype chain
const phaseB = `
(() => {
  const scene = window.__R3F.scene;
  let sm;
  scene.traverse(o => { if (!sm && o.isSkinnedMesh) sm = o; });
  if (!sm) return { err: 'no sm' };

  // Walk the prototype chain
  const chain = [];
  let p = Object.getPrototypeOf(sm);
  while (p && chain.length < 10) {
    chain.push(p.constructor?.name || '(anon)');
    p = Object.getPrototypeOf(p);
  }

  // Try to find THREE via module constants on the global namespace
  const allCtors = {};
  // Scan all window properties for Object3D-related classes
  for (const k of Object.getOwnPropertyNames(window)) {
    try {
      const v = window[k];
      if (typeof v === 'function' && v.prototype && v.prototype.isObject3D !== undefined) allCtors[k] = 'has isObject3D proto';
    } catch {}
  }

  return { smCtor: sm.constructor?.name, protoChain: chain, o3dCtors: Object.keys(allCtors).slice(0, 10) };
})()
`;
console.log('\n--- Prototype chain of SkinnedMesh ---');
const rB = await evalExpr(phaseB, 2);
console.log(JSON.stringify(rB.result.result.value, null, 2));

ws.close();
