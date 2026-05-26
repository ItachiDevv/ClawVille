#!/usr/bin/env bun
// Probe 4: Deeper — find mixer via a global hook, inspect actions, inspect materials on a specific VRM

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

// Phase A: Discover any mixer/animator on the page (via THREE.AnimationMixer private state)
const phaseA = `
(() => {
  // There's no global mixer. Try to find one via scene property lookup.
  // A mixer typically has _root, _actions, time, timeScale properties.
  const scene = window.__R3F.scene;
  const mixerCandidates = [];
  const actionLog = [];

  // First: look at VRMHumanoidRig objects. If animator uses them as mixer root,
  // the mixer itself lives in closure — we can't reach it from the tree.
  // But init log shows bindings=42, boundToReal=42 — try walking its structure.

  // Alt path: check window.__VRM_INIT_LOG for the reference to mixer/action
  const log = window.__VRM_INIT_LOG || [];
  const detail = log.slice(-1).map(e => Object.keys(e));
  return {
    logEntryKeys: detail,
    logLast: log.slice(-1),
  };
})()
`;
console.log('--- Phase A (inspect init log keys) ---');
const r1 = await evalExpr(phaseA, 1);
if (r1?.result?.exceptionDetails) { console.error(JSON.stringify(r1.result.exceptionDetails, null, 2)); }
else console.log(JSON.stringify(r1.result.result.value, null, 2));

// Phase B: Walk from VRMHumanoidRig to find the Armature — sample a SPECIFIC NPC's full tree structure to locate mesh/bones
const phaseB = `
(() => {
  const scene = window.__R3F.scene;
  // Find all VRMHumanoidRig nodes
  const rigs = [];
  scene.traverse(o => { if (o.name === 'VRMHumanoidRig') rigs.push(o); });

  // For first rig, walk up to find its outer GLTF scene
  const first = rigs[0];
  if (!first) return { err: 'no rig' };
  let outer = first;
  let depth = 0;
  while (outer.parent && outer.parent !== scene && depth < 20) {
    outer = outer.parent;
    depth++;
  }

  // Report children of first VRM's outer scene
  const outerChildren = outer.children.map(c => ({
    name: c.name || '(noname)',
    type: c.type,
    kids: c.children.length,
    visible: c.visible,
  }));

  // And count skinned meshes under outer
  let skinnedMeshes = [];
  outer.traverse(o => {
    if (o.isSkinnedMesh) {
      const m = o.material;
      skinnedMeshes.push({
        name: o.name,
        parent: o.parent?.name,
        visible: o.visible,
        matClass: m?.constructor?.name,
        matType: m?.type,
        isMToon: m?.isMToonMaterial ?? m?.isMToonNodeMaterial ?? false,
        transparent: m?.transparent,
        opacity: m?.opacity,
        alphaTest: m?.alphaTest,
        alphaHash: m?.alphaHash,
        side: m?.side,
        depthWrite: m?.depthWrite,
        renderOrder: o.renderOrder,
        hasMap: !!m?.map,
        mapUUID: m?.map?.uuid,
        bones: o.skeleton?.bones?.length,
        geomAttribs: o.geometry ? Object.keys(o.geometry.attributes) : null,
        skeletonFirstBoneName: o.skeleton?.bones?.[0]?.name,
        skeletonBoneNameSample: o.skeleton?.bones?.slice(0, 5).map(b => b.name),
      });
    }
  });

  return {
    rigCount: rigs.length,
    outerType: outer.type,
    outerName: outer.name,
    outerKidCount: outer.children.length,
    outerChildren,
    skinnedMeshes,
  };
})()
`;

console.log('\n--- Phase B (first VRM full structure) ---');
const r2 = await evalExpr(phaseB, 2);
if (r2?.result?.exceptionDetails) { console.error(JSON.stringify(r2.result.exceptionDetails, null, 2)); }
else console.log(JSON.stringify(r2.result.result.value, null, 2));

// Phase C: force inspect materials at the class level — what's `rW`?
const phaseC = `
(() => {
  const scene = window.__R3F.scene;
  let firstSM = null;
  scene.traverse(o => { if (o.isSkinnedMesh && !firstSM) firstSM = o; });
  if (!firstSM) return { err: 'no sm' };
  const m = firstSM.material;

  // Dump every enumerable own + inherited property with primitive values
  const props = {};
  for (const k in m) {
    try {
      const v = m[k];
      if (v === null || typeof v !== 'object') props[k] = v;
      else if (typeof v === 'object' && v?.constructor?.name) props[k] = '[' + v.constructor.name + ']';
    } catch (e) {}
  }
  // prototype chain
  const chain = [];
  let p = Object.getPrototypeOf(m);
  while (p && chain.length < 8) {
    chain.push(p.constructor?.name || '(anon)');
    p = Object.getPrototypeOf(p);
  }

  return {
    matCtorName: m.constructor?.name,
    matType: m.type,
    protoChain: chain,
    isMToonMaterial: m.isMToonMaterial ?? false,
    isMToonNodeMaterial: m.isMToonNodeMaterial ?? false,
    isMeshStandardNodeMaterial: m.isMeshStandardNodeMaterial ?? false,
    isNodeMaterial: m.isNodeMaterial ?? false,
    isMeshBasicNodeMaterial: m.isMeshBasicNodeMaterial ?? false,
    // key props
    transparent: m.transparent,
    opacity: m.opacity,
    alphaTest: m.alphaTest,
    visible: firstSM.visible,
    hasMap: !!m.map,
    hasColorNode: !!m.colorNode,
    hasDiffuseColorNode: !!m.diffuseColorNode,
    // Count property names
    propKeys: Object.keys(props).slice(0, 40),
  };
})()
`;

console.log('\n--- Phase C (material class forensics) ---');
const r3 = await evalExpr(phaseC, 3);
if (r3?.result?.exceptionDetails) { console.error(JSON.stringify(r3.result.exceptionDetails, null, 2)); }
else console.log(JSON.stringify(r3.result.result.value, null, 2));

ws.close();
