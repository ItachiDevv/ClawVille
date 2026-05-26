#!/usr/bin/env bun
// Probe live scene for Pearl + Mrs. Puff group nodes.
// Measures native bbox height, applied scale, rendered bbox height.
// Usage: bun run scripts/cdp-npc-scale-probe.mjs

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville'));
if (!page) { console.error('no clawville tab found'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

function evalJs(expr) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== id) return;
      ws.removeEventListener('message', handler);
      resolve(d?.result?.result?.value ?? d?.result?.exceptionDetails?.text ?? null);
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        expression: expr,
        returnByValue: true,
        awaitPromise: false,
        timeout: 10000,
      },
    }));
  });
}

const js = `
(function() {
  const THREE = window.__THREE__ || (window.THREE);
  if (!THREE) return JSON.stringify({ error: 'THREE not on window' });

  // Find the R3F root scene
  let rootScene = null;
  const canvases = document.querySelectorAll('canvas');
  for (const c of canvases) {
    const fiber = c._reactFiber || c.__r3f || (c._reactRootContainer && c._reactRootContainer._internalRoot);
    if (fiber) {
      // Walk fiber tree looking for the R3F scene
    }
  }

  // Use __r3f internals or walk global scene references
  // R3F exposes scene on the gl.domElement._gl context or via internals
  // Try to find the scene in globalThis or __THREE_DEVTOOLS__
  let scene = null;

  // Walk through all Three.js scenes via renderer info if accessible
  if (typeof window.__clawvilleScene !== 'undefined') {
    scene = window.__clawvilleScene;
  }

  // Try __THREE_DEVTOOLS__ if available
  if (!scene && window.__THREE_DEVTOOLS__) {
    const scenes = window.__THREE_DEVTOOLS__.scenes;
    if (scenes && scenes.length > 0) scene = scenes[0];
  }

  if (!scene) return JSON.stringify({ error: 'no scene found — try visiting /game first' });

  const results = {};
  const targets = ['Pearl', 'Mrs. Puff'];

  scene.traverse((obj) => {
    for (const name of targets) {
      // Look for Html label divs near the group — we can't see HTML labels from scene graph
      // but the NpcMesh group structure is: outer group (position) > inner group (scale+rotation) > animGroup > primitive
      // The primitive object is the cloned GLB scene named after the model
      // We identify by the group's children having a scale matching npcScale
      if (obj.isGroup && obj.parent && !obj.__r3f_labeled) {
        // Check children for the scaled sub-group
        const scaled = obj.children.find(c => c.isGroup && c.scale && c.scale.x > 0 && c.scale.x === c.scale.y);
        if (scaled) {
          const scale = scaled.scale.x;
          // Scan primitives inside for user data naming
          let modelName = '';
          scaled.traverse((child) => {
            if (child.isObject3D && child.name && !modelName) {
              // Sketchfab models name their root differently
              modelName = child.name;
            }
          });
          // If scale is in range 1-150 and this is a potential character group
          if (scale > 0.5 && scale < 200) {
            const box = new THREE.Box3().setFromObject(obj);
            const renderedH = box.max.y - box.min.y;
            const key = obj.uuid.slice(0, 8) + '_scale' + scale.toFixed(2);
            if (renderedH > 10 && renderedH < 5000) {
              results[key] = {
                scale,
                renderedH: renderedH.toFixed(1),
                posY: obj.position.y.toFixed(1),
                modelName: modelName.slice(0, 30),
              };
            }
          }
        }
      }
    }
  });

  return JSON.stringify(results);
})()
`;

const raw = await evalJs(js);
console.log('Raw result:', raw);
ws.close();
