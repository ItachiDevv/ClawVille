#!/usr/bin/env node
/**
 * cdp-hairmodel-gap-probe.mjs
 *
 * Measures:
 * 1. Hairmodel native position.y and scale at load (local coords in head bone space)
 * 2. Crown vertex world position vs scalp vertex world position at idle
 * 3. Crown vertex world position at walk-peak head tilt (-0.10 rad)
 * 4. Current rotation.x value
 *
 * Run: node scripts/cdp-hairmodel-gap-probe.mjs
 */

import WebSocket from 'ws';

const CDP_LIST_URL = 'http://localhost:9222/json/list';

async function getPageWsUrl() {
  const res = await fetch(CDP_LIST_URL);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('clawville'));
  if (!page) throw new Error('No clawville page target found');

  console.log('Tab:', page.url);
  return page.webSocketDebuggerUrl;
}

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();

    ws.on('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const msgId = id++;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });

      const evaluate = (expr) =>
        send('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise: false,
          timeout: 10000,
        }).then(r => {
          if (r.exceptionDetails) {
            throw new Error((r.exceptionDetails.exception?.description) || JSON.stringify(r.exceptionDetails));
          }
          return r.result?.value;
        });

      resolve({ send, evaluate, ws });
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });

    ws.on('error', reject);
  });
}

async function main() {
  const wsUrl = await getPageWsUrl();
  const { evaluate, ws } = await cdpSession(wsUrl);

  console.log('visibilityState:', await evaluate(`document.visibilityState`));

  // Step 1: Find the Hairmodel mesh in the scene graph via __VRM_NPC_DEBUG or scene traversal
  const probe = await evaluate(`
    (function() {
      try {
        // Try VRM debug registry first
        const debug = window.__VRM_NPC_DEBUG;
        if (!debug) return { error: 'no __VRM_NPC_DEBUG' };

        const npcIds = Object.keys(debug);
        if (!npcIds.length) return { error: 'no NPCs registered' };

        const results = [];

        for (const npcId of npcIds.slice(0, 3)) {
          const d = debug[npcId];
          if (!d?.vrm?.scene) continue;

          let hairmodel = null;
          let headBone = null;

          // Find Hairmodel mesh and head bone
          d.vrm.scene.traverse((obj) => {
            if (obj.name === 'Hairmodel') hairmodel = obj;
            if (obj.name === 'mixamorigHead') headBone = obj;
          });

          if (!hairmodel) {
            results.push({ npcId, error: 'Hairmodel not found' });
            continue;
          }

          // Local position/rotation/scale (in head bone space)
          const localPos = hairmodel.position;
          const localRot = hairmodel.rotation;
          const localScale = hairmodel.scale;

          // World position of Hairmodel origin
          const hairWP = new THREE.Vector3();
          hairmodel.getWorldPosition(hairWP);

          // World position of head bone (if found)
          let headWP = null;
          if (headBone) {
            headWP = new THREE.Vector3();
            headBone.getWorldPosition(headWP);
          }

          // Get geometry bbox to find crown vertex (max Y in local space)
          let crownLocalY = null;
          let crownWorldY = null;
          let vertCount = 0;
          const geo = hairmodel.geometry;
          if (geo?.attributes?.position) {
            const pos = geo.attributes.position;
            vertCount = pos.count;
            let maxLocalY = -Infinity;
            // Find crown-back verts: high Y AND negative Z (back of head)
            let crownBackCount = 0;
            let crownBackMaxLocalY = -Infinity;
            for (let i = 0; i < pos.count; i++) {
              const lx = pos.getX(i);
              const ly = pos.getY(i);
              const lz = pos.getZ(i);
              if (ly > maxLocalY) maxLocalY = ly;
              // Crown-back: high Y (>0.3) and back Z (<-0.2)
              if (ly > 0.3 && lz < -0.2) {
                crownBackCount++;
                if (ly > crownBackMaxLocalY) crownBackMaxLocalY = ly;
              }
            }
            crownLocalY = maxLocalY;

            // Convert crown local Y to world Y using Hairmodel's matrixWorld
            const crownLocalVec = new THREE.Vector3(0, maxLocalY, -0.5); // back-crown approx
            crownLocalVec.applyMatrix4(hairmodel.matrixWorld);
            crownWorldY = crownLocalVec.y;

            results.push({
              npcId,
              localPos: { x: localPos.x.toFixed(4), y: localPos.y.toFixed(4), z: localPos.z.toFixed(4) },
              localRot: { x: localRot.x.toFixed(4), y: localRot.y.toFixed(4), z: localRot.z.toFixed(4) },
              localScale: { x: localScale.x.toFixed(4), y: localScale.y.toFixed(4), z: localScale.z.toFixed(4) },
              hairmodelWorldY: hairWP.y.toFixed(2),
              headBoneWorldY: headWP ? headWP.y.toFixed(2) : null,
              crownLocalY: crownLocalY?.toFixed(4),
              crownWorldY: crownWorldY?.toFixed(2),
              vertCount,
              // Check parent chain
              parentName: hairmodel.parent?.name ?? 'no parent',
              parentType: hairmodel.parent?.type ?? 'unknown',
            });
          } else {
            results.push({ npcId, error: 'no geometry' });
          }
        }

        return results;
      } catch(e) {
        return { error: e.message, stack: e.stack?.slice(0,300) };
      }
    })()
  `);

  console.log('\n=== Hairmodel Probe ===');
  console.log(JSON.stringify(probe, null, 2));

  // Step 2: Find scalp/body top vertex world Y to measure the gap
  const scalpProbe = await evaluate(`
    (function() {
      try {
        const debug = window.__VRM_NPC_DEBUG;
        if (!debug) return { error: 'no debug' };
        const npcIds = Object.keys(debug);
        if (!npcIds.length) return { error: 'no npcs' };

        const d = debug[npcIds[0]];
        if (!d?.vrm?.scene) return { error: 'no vrm scene' };

        let bodyMesh = null;
        d.vrm.scene.traverse((obj) => {
          // SkinnedMesh with 'Body' or high vert count
          if (obj.isSkinnedMesh && !bodyMesh) {
            const name = obj.name ?? '';
            if (/body/i.test(name) || name.includes('36338')) bodyMesh = obj;
          }
        });

        if (!bodyMesh) {
          // Fallback: find skinned mesh with most verts
          d.vrm.scene.traverse((obj) => {
            if (obj.isSkinnedMesh && (!bodyMesh || obj.geometry?.attributes?.position?.count > bodyMesh.geometry?.attributes?.position?.count)) {
              bodyMesh = obj;
            }
          });
        }

        if (!bodyMesh?.geometry?.attributes?.position) return { error: 'no body mesh' };

        // Find head-bone index
        const skinIndices = bodyMesh.geometry.attributes.skinIndex;
        const skinWeights = bodyMesh.geometry.attributes.skinWeight;
        const pos = bodyMesh.geometry.attributes.position;

        // Find bone named mixamorigHead in skeleton
        let headBoneIdx = -1;
        if (bodyMesh.skeleton) {
          bodyMesh.skeleton.bones.forEach((bone, idx) => {
            if (bone.name === 'mixamorigHead' || bone.name === 'Normalized_mixamorigHead') headBoneIdx = idx;
          });
        }

        // Find the highest vertex on body that is 100% weighted to head bone
        let scalpMaxLocalY = -Infinity;
        let scalpVertCount = 0;
        for (let i = 0; i < pos.count; i++) {
          const ly = pos.getY(i);
          // Check if any weight goes to head bone
          let isHeadWeighted = false;
          if (headBoneIdx >= 0 && skinIndices && skinWeights) {
            for (let j = 0; j < 4; j++) {
              const bIdx = skinIndices.getComponent(i, j);
              const w = skinWeights.getComponent(i, j);
              if (bIdx === headBoneIdx && w > 0.5) { isHeadWeighted = true; break; }
            }
          } else {
            // no skeleton found — just take overall max
            isHeadWeighted = true;
          }
          if (isHeadWeighted) {
            scalpVertCount++;
            if (ly > scalpMaxLocalY) scalpMaxLocalY = ly;
          }
        }

        // Get head bone world matrix to convert scalp local Y to world Y
        let headBone = null;
        d.vrm.scene.traverse((obj) => {
          if (obj.name === 'mixamorigHead' || obj.name === 'Normalized_mixamorigHead') headBone = obj;
        });

        let scalpWorldY = null;
        if (headBone) {
          const sv = new THREE.Vector3(0, scalpMaxLocalY, 0);
          sv.applyMatrix4(bodyMesh.matrixWorld);
          scalpWorldY = sv.y;
        }

        return {
          bodyMeshName: bodyMesh.name,
          headBoneIdx,
          scalpVertCount,
          scalpMaxLocalY: scalpMaxLocalY.toFixed(4),
          scalpWorldY: scalpWorldY?.toFixed(2),
        };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  console.log('\n=== Scalp Probe ===');
  console.log(JSON.stringify(scalpProbe, null, 2));

  // Step 3: Measure crown-back vertex world positions more precisely
  const crownGapProbe = await evaluate(`
    (function() {
      try {
        const debug = window.__VRM_NPC_DEBUG;
        const npcIds = Object.keys(debug || {});
        if (!npcIds.length) return null;
        const d = debug[npcIds[0]];
        if (!d?.vrm?.scene) return null;

        let hairmodel = null;
        d.vrm.scene.traverse((obj) => { if (obj.name === 'Hairmodel') hairmodel = obj; });
        if (!hairmodel?.geometry) return { error: 'no hairmodel geo' };

        const pos = hairmodel.geometry.attributes.position;
        const mw = hairmodel.matrixWorld;

        // Find the topmost back-crown vertex (high Y, negative Z in local space)
        let topBackVert = null;
        let topBackVertLocalY = -Infinity;
        let topBackVertLocalZ = 0;

        for (let i = 0; i < pos.count; i++) {
          const lx = pos.getX(i);
          const ly = pos.getY(i);
          const lz = pos.getZ(i);
          // Crown-back zone: Y > 0.4, Z < -0.1
          if (ly > 0.4 && lz < -0.1) {
            if (ly > topBackVertLocalY) {
              topBackVertLocalY = ly;
              topBackVertLocalZ = lz;
              topBackVert = new THREE.Vector3(lx, ly, lz);
            }
          }
        }

        if (!topBackVert) return { error: 'no crown-back vertex found' };

        // Convert to world position
        const worldVert = topBackVert.clone().applyMatrix4(mw);

        // Also get current head bone rotation
        let headBone = null;
        d.vrm.scene.traverse((obj) => {
          if (obj.name === 'mixamorigHead') headBone = obj;
        });

        return {
          crownBackLocalY: topBackVertLocalY.toFixed(4),
          crownBackLocalZ: topBackVertLocalZ.toFixed(4),
          crownBackWorldY: worldVert.y.toFixed(2),
          crownBackWorldX: worldVert.x.toFixed(2),
          crownBackWorldZ: worldVert.z.toFixed(2),
          hairmodelRotX: hairmodel.rotation.x.toFixed(4),
          hairmodelScaleY: hairmodel.scale.y.toFixed(4),
          hairmodelLocalPosY: hairmodel.position.y.toFixed(4),
          headBoneRotX: headBone ? headBone.rotation.x.toFixed(4) : null,
        };
      } catch(e) {
        return { error: e.message };
      }
    })()
  `);

  console.log('\n=== Crown Gap Probe ===');
  console.log(JSON.stringify(crownGapProbe, null, 2));

  ws.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
