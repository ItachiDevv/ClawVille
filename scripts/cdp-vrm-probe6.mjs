#!/usr/bin/env bun
// Probe 6: Inspect VRMHumanoidRig children and how the mixer root sees bones

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

// Directly from VRMHumanoidRig: list children and check if bones are DIRECT children
const phaseA = `
(() => {
  const scene = window.__R3F.scene;
  const rigs = [];
  scene.traverse(o => { if (o.name === 'VRMHumanoidRig') rigs.push(o); });

  const first = rigs[0];
  if (!first) return { err: 'no rig' };

  // Direct children
  const direct = first.children.map(c => ({ name: c.name, type: c.type, kidCount: c.children.length }));

  // Deep traversal to check where Normalized_mixamorigHips lives relative to rig
  const hips = [];
  first.traverse(o => { if (o.name === 'Normalized_mixamorigHips') hips.push(o); });
  const hipsInRig = hips.length;

  // Use THREE.PropertyBinding.findNode to verify lookup
  // We cannot import — try to replicate: does first.getObjectByName find hips?
  const byName = first.getObjectByName('Normalized_mixamorigHips');
  const byNameResult = byName ? { name: byName.name, parent: byName.parent?.name } : null;

  // Count all descendants of the rig
  let descendants = 0;
  first.traverse(() => descendants++);

  return {
    rigCount: rigs.length,
    rigChildrenCount: first.children.length,
    rigChildrenDirect: direct,
    hipsInRig,
    hipsByName: byNameResult,
    descendants,
    rigParent: first.parent?.name || first.parent?.type,
  };
})()
`;

console.log('--- VRMHumanoidRig inspection ---');
const r = await evalExpr(phaseA, 1);
if (r?.result?.exceptionDetails) console.error(JSON.stringify(r.result.exceptionDetails, null, 2));
else console.log(JSON.stringify(r.result.result.value, null, 2));

// Try to find the animator instance directly: invoke a method on the mixer via introspection
const phaseB = `
(() => {
  // Use THREE.PropertyBinding.findNode via window.THREE if exposed
  const hasThree = !!window.THREE;
  const hasTHREE = !!window.__THREE__;

  // Sniff VRMHumanoidRig matrixAutoUpdate status — if it's set false somehow, bones won't update world matrices
  const scene = window.__R3F.scene;
  const rigs = [];
  scene.traverse(o => { if (o.name === 'VRMHumanoidRig') rigs.push(o); });

  const info = rigs.slice(0, 3).map(r => {
    const rigHipsBone = r.children[0]?.children?.[0];
    return {
      rigName: r.name,
      rigMatrixAutoUpdate: r.matrixAutoUpdate,
      rigMatrixWorldAutoUpdate: r.matrixWorldAutoUpdate,
      rigVisible: r.visible,
      rigMatrixWorldNeedsUpdate: r.matrixWorldNeedsUpdate,
      // First bone chain inspection
      rigFirstChildName: r.children[0]?.name,
      rigFirstChildType: r.children[0]?.type,
      rigFirstChildAutoUpdate: r.children[0]?.matrixAutoUpdate,
    };
  });

  // Try to locate a mixer hanging off any Object3D userData (some libs stash it there)
  let mixers = [];
  scene.traverse(o => {
    const ud = o.userData || {};
    for (const k in ud) {
      const v = ud[k];
      if (v?.isAnimationMixer || (v?._actions && v?._bindings)) {
        mixers.push({ nodeName: o.name, key: k, actionsLen: v._actions?.length, bindingsLen: v._bindings?.length, time: v.time });
      }
    }
  });

  return { hasThree, hasTHREE, info, mixerFoundInUserData: mixers };
})()
`;

console.log('\n--- Rig matrix/auto-update state ---');
const r2 = await evalExpr(phaseB, 2);
if (r2?.result?.exceptionDetails) console.error(JSON.stringify(r2.result.exceptionDetails, null, 2));
else console.log(JSON.stringify(r2.result.result.value, null, 2));

// Critical: manually step the mixer by writing a quaternion to a Normalized bone and seeing if vrm.update propagates it to native skeleton
const phaseC = `
(() => {
  const scene = window.__R3F.scene;
  const hipsNodes = [];
  scene.traverse(o => { if (o.name === 'Normalized_mixamorigHips') hipsNodes.push(o); });
  const first = hipsNodes[0];
  if (!first) return { err: 'no hips' };

  // Write a nonzero quaternion and see if vrm.update propagates it (i.e. is the node even connected?)
  const before = { x: first.quaternion.x, y: first.quaternion.y, z: first.quaternion.z, w: first.quaternion.w };

  // Pose: 45deg rotation around Y
  first.quaternion.set(0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8));
  first.updateMatrix();

  // Wait one frame via requestAnimationFrame promise
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Check if the rotation was overwritten (indicates mixer is writing) or preserved
        const after = { x: first.quaternion.x, y: first.quaternion.y, z: first.quaternion.z, w: first.quaternion.w };

        // Also check the native skeleton's hips-equivalent bone
        let mixamoHips;
        scene.traverse(o => { if (!mixamoHips && o.name === 'mixamorigHips') mixamoHips = o; });
        const mixamoHipsQ = mixamoHips ? {
          x: mixamoHips.quaternion.x,
          y: mixamoHips.quaternion.y,
          z: mixamoHips.quaternion.z,
          w: mixamoHips.quaternion.w,
        } : null;

        // And Body_01 (native skeleton root of mesh)
        let bodyNode;
        scene.traverse(o => { if (!bodyNode && o.name === 'Body_01') bodyNode = o; });
        const bodyQ = bodyNode ? {
          x: bodyNode.quaternion.x,
          y: bodyNode.quaternion.y,
          z: bodyNode.quaternion.z,
          w: bodyNode.quaternion.w,
        } : null;

        resolve({
          before,
          injected: { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) },
          after,
          mixamoHipsAfter: mixamoHipsQ,
          bodyAfter: bodyQ,
          preserved: (Math.abs(after.y - Math.sin(Math.PI/8)) < 0.001),
        });
      });
    });
  });
})()
`;

console.log('\n--- Manual inject test: set Normalized_Hips quat, check propagation ---');
const r3 = await evalExpr(phaseC, 3);
if (r3?.result?.exceptionDetails) console.error(JSON.stringify(r3.result.exceptionDetails, null, 2));
else console.log(JSON.stringify(r3.result.result.value, null, 2));

ws.close();
