#!/usr/bin/env node
/**
 * cdp-hair-structure-probe.mjs
 *
 * Deep diagnostic for VRM Hairmodel bald-spot:
 * Q1: Is Hairmodel a SkinnedMesh or a plain Mesh? Does it share skeleton with body?
 * Q2: What are the skin bone indices/weights on Hairmodel vertices?
 *     Are they weighted to head bone, or something else (hips/spine)?
 * Q3: Is there a separate "Hairmodel.Bone001" hierarchy not driven by head?
 * Q4: Track head-bone world Y and Hairmodel bbox center over 30 frames
 *     — does hair lag the head during walk animation?
 * Q5: In the VRM scene graph, what is Hairmodel's parent? Is it in vrm.scene root?
 *
 * Run: node scripts/cdp-hair-structure-probe.mjs
 */

import WebSocket from 'ws';

async function getPageWsUrl() {
  const res = await fetch('http://localhost:9222/json/list');
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('clawville'));
  if (!page) throw new Error('No clawville page target found. Open https://clawville.world/game in Chrome.');
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
        const mid = id++;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
      const evaluate = (expr, awaitPromise = false) =>
        send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, timeout: 15000 })
          .then(r => {
            if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description) || JSON.stringify(r.exceptionDetails));
            return r.result?.value;
          });
      resolve({ evaluate, ws });
    });

    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    ws.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const wsUrl = await getPageWsUrl();
  const { evaluate, ws } = await cdpSession(wsUrl);

  const vis = await evaluate(`document.visibilityState`);
  console.log('visibilityState:', vis);
  if (vis !== 'visible') console.warn('WARNING: hidden tab — RAF throttled, probes may be stale');

  // ── STEP 1: Full scene graph structure for one NPC ─────────────────────────
  console.log('\n====== STEP 1: Scene graph — find Hairmodel + parents ======');
  const step1 = await evaluate(`
    (function() {
      try {
        const debug = window.__VRM_NPC_DEBUG;
        if (!debug) return { error: 'no __VRM_NPC_DEBUG' };
        const npcId = Object.keys(debug)[0];
        if (!npcId) return { error: 'no NPCs' };
        const d = debug[npcId];
        if (!d?.vrm?.scene) return { error: 'no vrm.scene' };

        const results = [];
        d.vrm.scene.traverse((obj) => {
          // Capture all SkinnedMeshes AND any object whose name mentions hair/Hair
          const isHairRelated = /hair/i.test(obj.name);
          const isSkinned = obj.isSkinnedMesh;
          if (!isHairRelated && !isSkinned) return;

          // Walk up parent chain (max 8 levels)
          const chain = [];
          let cur = obj;
          for (let i = 0; i < 8 && cur; i++) {
            chain.push(cur.name || `[${cur.type}]`);
            cur = cur.parent;
          }

          const info = {
            name: obj.name,
            type: obj.type,
            isMesh: obj.isMesh,
            isSkinnedMesh: obj.isSkinnedMesh,
            parentChain: chain.slice(1), // skip self
            vertCount: obj.geometry?.attributes?.position?.count ?? null,
            // Skeleton info
            hasSkeleton: !!obj.skeleton,
            skeletonBoneCount: obj.skeleton?.bones?.length ?? null,
            bindMatrixPresent: !!obj.bindMatrix,
          };
          results.push(info);
        });

        return { npcId, results };
      } catch(e) { return { error: e.message, stack: e.stack?.slice(0,300) }; }
    })()
  `);
  console.log(JSON.stringify(step1, null, 2));

  // ── STEP 2: Hairmodel skeleton analysis ───────────────────────────────────
  console.log('\n====== STEP 2: Hairmodel skin weights — what bones control hair? ======');
  const step2 = await evaluate(`
    (function() {
      try {
        const debug = window.__VRM_NPC_DEBUG;
        const npcId = Object.keys(debug || {})[0];
        if (!npcId) return { error: 'no NPC' };
        const d = debug[npcId];
        if (!d?.vrm?.scene) return { error: 'no scene' };

        let hairmodel = null;
        d.vrm.scene.traverse(o => { if (o.name === 'Hairmodel') hairmodel = o; });
        if (!hairmodel) return { error: 'Hairmodel mesh not found' };

        const geo = hairmodel.geometry;
        if (!geo?.attributes?.skinIndex || !geo?.attributes?.skinWeight) {
          return {
            hairmodelFound: true,
            isSkinnedMesh: hairmodel.isSkinnedMesh,
            hasSkinAttributes: false,
            msg: 'Hairmodel has NO skinIndex/skinWeight attributes — it is NOT skinned',
            parentName: hairmodel.parent?.name ?? 'null',
            parentType: hairmodel.parent?.type ?? 'unknown',
          };
        }

        const si = geo.attributes.skinIndex;
        const sw = geo.attributes.skinWeight;
        const posAttr = geo.attributes.position;

        // Tally which bone indices dominate
        const boneTally = {};   // boneIdx -> total weight across all verts
        for (let i = 0; i < si.count; i++) {
          for (let j = 0; j < 4; j++) {
            const bIdx = si.getComponent(i, j);
            const w = sw.getComponent(i, j);
            if (w > 0) boneTally[bIdx] = (boneTally[bIdx] || 0) + w;
          }
        }

        // Sort by weight descending — top 12 bones
        const sorted = Object.entries(boneTally)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12);

        // Map bone index → bone name from the Hairmodel skeleton
        let boneNames = {};
        let sharedSkeletonWithBody = false;
        if (hairmodel.skeleton) {
          hairmodel.skeleton.bones.forEach((bone, idx) => {
            boneNames[idx] = bone.name;
          });
        }

        // Check if skeleton is same instance as body mesh skeleton
        let bodyMesh = null;
        d.vrm.scene.traverse(o => {
          if (o.isSkinnedMesh && !bodyMesh && /body/i.test(o.name)) bodyMesh = o;
        });
        if (bodyMesh?.skeleton && hairmodel.skeleton) {
          sharedSkeletonWithBody = bodyMesh.skeleton === hairmodel.skeleton;
        }

        // Find head bone index in Hairmodel's skeleton
        let headBoneIdx = -1;
        let headBoneName = null;
        if (hairmodel.skeleton) {
          hairmodel.skeleton.bones.forEach((bone, idx) => {
            if (/head/i.test(bone.name)) { headBoneIdx = idx; headBoneName = bone.name; }
          });
        }

        // Count verts with >50% weight on head bone
        let headWeightedVerts = 0;
        let headWeightedMaxLocalY = -Infinity;
        for (let i = 0; i < si.count; i++) {
          for (let j = 0; j < 4; j++) {
            const bIdx = si.getComponent(i, j);
            const w = sw.getComponent(i, j);
            if (bIdx === headBoneIdx && w > 0.5) {
              headWeightedVerts++;
              const ly = posAttr.getY(i);
              if (ly > headWeightedMaxLocalY) headWeightedMaxLocalY = ly;
            }
          }
        }

        return {
          hairmodelFound: true,
          isSkinnedMesh: hairmodel.isSkinnedMesh,
          hasSkinAttributes: true,
          totalVerts: si.count,
          sharedSkeletonWithBody,
          headBoneIdx,
          headBoneName,
          headWeightedVerts,
          headWeightedMaxLocalY: headWeightedVerts > 0 ? headWeightedMaxLocalY.toFixed(4) : null,
          topBonesByWeight: sorted.map(([idx, w]) => ({
            boneIdx: +idx,
            boneName: boneNames[+idx] ?? '(unknown)',
            totalWeight: w.toFixed(1),
          })),
          parentName: hairmodel.parent?.name ?? 'null',
          parentType: hairmodel.parent?.type ?? 'unknown',
        };
      } catch(e) { return { error: e.message, stack: e.stack?.slice(0,300) }; }
    })()
  `);
  console.log(JSON.stringify(step2, null, 2));

  // ── STEP 3: Hair as non-skinned mesh? Check parent hierarchy ─────────────
  console.log('\n====== STEP 3: All non-SkinnedMesh objects with "Hair" in name ======');
  const step3 = await evaluate(`
    (function() {
      try {
        const debug = window.__VRM_NPC_DEBUG;
        const npcId = Object.keys(debug || {})[0];
        const d = debug?.[npcId];
        if (!d?.vrm?.scene) return { error: 'no scene' };

        const found = [];
        d.vrm.scene.traverse((obj) => {
          if (!/hair/i.test(obj.name)) return;
          const chain = [];
          let cur = obj;
          for (let i = 0; i < 10 && cur; i++) {
            chain.push({ name: cur.name || '(anon)', type: cur.type });
            cur = cur.parent;
          }
          found.push({
            name: obj.name,
            type: obj.type,
            isSkinnedMesh: obj.isSkinnedMesh,
            isMesh: obj.isMesh,
            isBone: obj.isBone,
            visible: obj.visible,
            parentChain: chain.slice(1, 6),
          });
        });
        return found;
      } catch(e) { return { error: e.message }; }
    })()
  `);
  console.log(JSON.stringify(step3, null, 2));

  // ── STEP 4: Track head bone Y + Hairmodel bbox Y over 30 frames ──────────
  console.log('\n====== STEP 4: 30-frame tracking — does hair lag head during walk? ======');
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const s = await evaluate(`
      (function() {
        try {
          const debug = window.__VRM_NPC_DEBUG;
          const npcId = Object.keys(debug || {})[0];
          const d = debug?.[npcId];
          if (!d?.vrm?.scene) return null;

          // Head bone world Y
          let headBoneWorldY = null;
          let headBoneRotX = null;
          d.vrm.scene.traverse(obj => {
            if (obj.name === 'mixamorigHead') {
              const wp = new THREE.Vector3();
              obj.getWorldPosition(wp);
              headBoneWorldY = wp.y;
              headBoneRotX = obj.rotation.x;
            }
          });

          // Hairmodel bbox center world Y
          let hairCenterWorldY = null;
          d.vrm.scene.traverse(obj => {
            if (obj.name === 'Hairmodel') {
              const wp = new THREE.Vector3();
              obj.getWorldPosition(wp);
              hairCenterWorldY = wp.y;
            }
          });

          // NPC world X (to confirm movement)
          const npcGroup = d.group;
          let npcWorldX = null;
          if (npcGroup) {
            const wp = new THREE.Vector3();
            npcGroup.getWorldPosition(wp);
            npcWorldX = wp.x;
          }

          return {
            t: Date.now(),
            headBoneWorldY: headBoneWorldY?.toFixed(3),
            headBoneRotX: headBoneRotX?.toFixed(4),
            hairCenterWorldY: hairCenterWorldY?.toFixed(3),
            npcWorldX: npcWorldX?.toFixed(1),
          };
        } catch(e) { return { error: e.message }; }
      })()
    `);
    if (s) samples.push(s);
    await sleep(100); // 100ms = ~10Hz sampling over 3s
  }

  console.log('Samples (head Y, hair Y, head rotX, NPC X):');
  for (const s of samples) {
    if (s.error) { console.log(' ERROR:', s.error); continue; }
    const lagWu = (parseFloat(s.headBoneWorldY) - parseFloat(s.hairCenterWorldY)).toFixed(2);
    console.log(`  t=${s.t} headY=${s.headBoneWorldY} hairY=${s.hairCenterWorldY} lag=${lagWu}wu headRotX=${s.headBoneRotX} npcX=${s.npcWorldX}`);
  }

  // ── STEP 5: Screenshot ────────────────────────────────────────────────────
  console.log('\n====== STEP 5: Capturing screenshot ======');
  ws.close();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
