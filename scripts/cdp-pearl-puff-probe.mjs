#!/usr/bin/env bun
// Probes the live Three.js scene for Pearl + Mrs. Puff NPC groups.
// Reports: scale applied, rendered bbox height, position Y.
// Usage: bun scripts/cdp-pearl-puff-probe.mjs

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville'));
if (!page) { console.error('no clawville tab'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

function evalJs(id, expr) {
  return new Promise((resolve) => {
    const handler = (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== id) return;
      ws.removeEventListener('message', handler);
      const val = d?.result?.result?.value;
      const exc = d?.result?.exceptionDetails;
      resolve(exc ? { error: exc.text || JSON.stringify(exc) } : val);
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: false, timeout: 10000 },
    }));
  });
}

// First get a reference to a Three.js scene
const sceneJs = `
(function() {
  // R3F stores renderer on canvas.__r3f.gl; scene accessible via gl.renderLists
  // Better: walk canvas element's __reactFiber for the R3F state
  // Simplest reliable approach: find window.__THREE_DEVTOOLS__ or scan globalThis
  let scenes = [];

  // Try THREE devtools hook (set by Three.js internals)
  if (window.__THREE_DEVTOOLS__) {
    window.__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent('observe', { detail: {} }));
  }

  // R3F root state is stored on canvas elements via __r3f
  const canvases = [...document.querySelectorAll('canvas')];
  for (const c of canvases) {
    const r3f = c.__r3f;
    if (r3f && r3f.scene) { scenes.push(r3f.scene); }
    // Also try the fiber root
    for (const key of Object.keys(c)) {
      if (key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) {
        let fiber = c[key];
        // Walk stateNode chain looking for R3F store
        let limit = 300;
        while (fiber && limit-- > 0) {
          if (fiber.stateNode && fiber.stateNode.scene && fiber.stateNode.gl) {
            scenes.push(fiber.stateNode.scene);
            break;
          }
          fiber = fiber.return || fiber.child;
        }
      }
    }
  }

  return scenes.length;
})()
`;

const sceneCount = await evalJs(1, sceneJs);
console.log('Scenes found:', sceneCount);

const probeJs = `
(function() {
  const THREE = window.THREE;
  if (!THREE) return JSON.stringify({ error: 'THREE not global' });

  // Collect all scenes via canvas.__r3f
  const scenes = [];
  for (const c of document.querySelectorAll('canvas')) {
    if (c.__r3f && c.__r3f.scene) scenes.push(c.__r3f.scene);
    // Also fiber walk
    for (const key of Object.keys(c)) {
      if (key.startsWith('__reactFiber')) {
        let f = c[key];
        let lim = 200;
        while (f && lim-- > 0) {
          if (f.stateNode && f.stateNode.scene) { scenes.push(f.stateNode.scene); break; }
          f = f.return;
        }
      }
    }
  }

  if (!scenes.length) return JSON.stringify({ error: 'no scenes via canvas.__r3f' });

  const results = [];

  for (const scene of scenes) {
    scene.traverse((obj) => {
      // NpcMesh outer group structure: group (worldXYZ pos) > group (scale+rot) > group (animGroup) > primitive
      // Key signature: outer group has 2 children — scaled inner group + Html portal
      // Inner group has scale.x === scale.y === scale.z in range [1, 150]
      if (!obj.isGroup) return;
      const children = obj.children;
      if (children.length < 1) return;
      const scaled = children.find(c => c.isGroup && c.scale.x > 1 && c.scale.x < 200 && Math.abs(c.scale.x - c.scale.y) < 0.001);
      if (!scaled) return;
      const s = scaled.scale.x;

      // Now measure rendered height of the whole group
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const h = box.max.y - box.min.y;
      if (h < 5 || h > 10000) return; // filter noise

      // Get all descendant mesh names to identify which character this is
      const names = [];
      scaled.traverse((ch) => {
        if (ch.name && ch.name.length > 1 && names.length < 5) names.push(ch.name);
      });

      results.push({
        scale: +s.toFixed(4),
        renderedH: +h.toFixed(2),
        posY: +obj.position.y.toFixed(2),
        bboxMinY: +box.min.y.toFixed(2),
        bboxMaxY: +box.max.y.toFixed(2),
        meshNames: names.slice(0, 3).join(','),
      });
    });
  }

  // Sort by scale to help identify Pearl (scale=80) and Mrs. Puff (scale=1.45)
  results.sort((a, b) => a.scale - b.scale);
  return JSON.stringify(results);
})()
`;

const raw = await evalJs(2, probeJs);
console.log('\nNPC groups found:');
try {
  const arr = JSON.parse(raw);
  if (Array.isArray(arr)) {
    for (const r of arr) {
      console.log(`  scale=${r.scale} renderedH=${r.renderedH} posY=${r.posY} names="${r.meshNames}"`);
    }
  } else {
    console.log(raw);
  }
} catch (e) {
  console.log('raw:', raw);
}

ws.close();
