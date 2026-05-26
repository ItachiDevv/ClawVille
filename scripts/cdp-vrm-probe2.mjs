#!/usr/bin/env bun
// Probe 2: VRM init logs + effect logs + find VRM objects via searching their parents

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no tab'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const expr = `
(() => {
  const out = {};
  out.initCount = window.__VRM_INIT_COUNT ?? null;
  out.initLog = window.__VRM_INIT_LOG ? window.__VRM_INIT_LOG.slice(-30) : null;
  out.effectLog = window.__VRM_NPC_EFFECT_LOG ? window.__VRM_NPC_EFFECT_LOG.slice(-30) : null;

  const scene = window.__R3F.scene;

  // Find the unique ancestors that contain a Normalized_mixamorigHips
  const hipsNodes = [];
  scene.traverse(o => {
    if (o.name === 'Normalized_mixamorigHips') hipsNodes.push(o);
  });
  out.hipsCount = hipsNodes.length;

  // Walk up from each hips to find the "VRM root" — highest ancestor whose name isn't Scene
  const vrmRoots = [];
  hipsNodes.slice(0, 20).forEach(h => {
    let cur = h;
    let depth = 0;
    while (cur.parent && cur.parent !== scene && depth < 20) {
      cur = cur.parent;
      depth++;
    }
    vrmRoots.push({
      rootName: cur.name || '(noname)',
      rootType: cur.type,
      rootVisible: cur.visible,
      userDataKeys: Object.keys(cur.userData || {}),
      hasVrmInUserData: !!cur.userData?.vrm,
      directChildren: cur.children.map(c => ({ name: c.name, type: c.type, visible: c.visible })).slice(0, 8),
    });
  });
  out.vrmRoots = vrmRoots;

  // Count SkinnedMeshes in scene
  let smCount = 0;
  const smSamples = [];
  scene.traverse(o => {
    if (o.isSkinnedMesh) {
      smCount++;
      if (smSamples.length < 15) {
        const m = o.material;
        smSamples.push({
          name: o.name,
          visible: o.visible,
          parentName: o.parent?.name,
          matType: m?.constructor?.name || m?.type,
          matIsArray: Array.isArray(m),
          transparent: m?.transparent,
          opacity: m?.opacity,
          alphaTest: m?.alphaTest,
          renderOrder: o.renderOrder,
          hasMap: !!m?.map,
          mapName: m?.map?.name || m?.map?.source?.data?.src || null,
          hasSkeleton: !!o.skeleton,
          skeletonBones: o.skeleton?.bones?.length ?? null,
        });
      }
    }
  });
  out.skinnedMeshCount = smCount;
  out.skinnedSample = smSamples;

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
