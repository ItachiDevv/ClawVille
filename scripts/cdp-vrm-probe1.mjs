#!/usr/bin/env bun
// Probe 1: Discover scene root, R3F hook, global THREE, VRMs

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no tab'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const expr = `
(() => {
  const out = {};
  out.hasR3F = !!window.__R3F;
  out.r3fKeys = window.__R3F ? Object.keys(window.__R3F) : null;
  out.hasR3FRoots = !!window.__r3f;
  out.r3fRootsKeys = window.__r3f ? Object.keys(window.__r3f) : null;
  out.globalThreeKeys = ['THREE','three','__THREE'].filter(k => !!window[k]);

  let scene = window.__R3F?.scene || null;
  let renderer = window.__R3F?.gl || window.__R3F?.renderer || null;

  if (!scene && window.__r3f?.roots) {
    try {
      const first = window.__r3f.roots.values().next().value;
      if (first?.store?.getState) {
        const st = first.store.getState();
        scene = st.scene;
        renderer = st.gl;
      }
    } catch(e) { out.r3fRootsErr = String(e); }
  }

  out.sceneFound = !!scene;
  out.rendererFound = !!renderer;
  if (scene) {
    out.sceneChildren = scene.children.length;
    out.sceneTopLevelNames = scene.children.map(c => ({ name: c.name || '(noname)', type: c.type, visible: c.visible, kids: c.children.length })).slice(0, 40);
  }
  if (renderer) {
    out.info = renderer.info ? {
      memory: renderer.info.memory,
      render: renderer.info.render,
      programs: renderer.info.programs?.length ?? null,
    } : null;
    out.rendererType = renderer?.constructor?.name;
    out.hasIsWebGPURenderer = !!renderer.isWebGPURenderer;
  }

  out.debugKeys = Object.keys(window).filter(k => /vrm|three|r3f|clawville|debug|animator/i.test(k)).slice(0, 40);

  if (scene) {
    let normalizedCount = 0;
    let mixamoCount = 0;
    const normalizedNames = [];
    const mixamoNames = [];
    const vrmRoots = [];
    scene.traverse(o => {
      const n = o.name || '';
      if (n.startsWith('Normalized_')) {
        normalizedCount++;
        if (normalizedNames.length < 20) normalizedNames.push(n);
      }
      if (/mixamorig/i.test(n)) {
        mixamoCount++;
        if (mixamoNames.length < 20) mixamoNames.push(n);
      }
      if (o.userData && o.userData.vrm) {
        vrmRoots.push({ name: n, childType: o.type });
      }
    });
    out.normalizedCount = normalizedCount;
    out.mixamoCount = mixamoCount;
    out.normalizedSample = normalizedNames;
    out.mixamoSample = mixamoNames;
    out.vrmRootCount = vrmRoots.length;
    out.vrmRootSample = vrmRoots.slice(0, 10);
  }

  return out;
})()
`;

const reply = await new Promise(resolve => {
  ws.onmessage = e => resolve(JSON.parse(e.data));
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: 20000 }
  }));
});

if (reply?.result?.exceptionDetails) {
  console.error('EX:', JSON.stringify(reply.result.exceptionDetails, null, 2));
} else {
  console.log(JSON.stringify(reply.result.result.value, null, 2));
}
ws.close();
