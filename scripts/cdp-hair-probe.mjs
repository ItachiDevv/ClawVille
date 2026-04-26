/**
 * cdp-hair-probe.mjs
 *
 * Probes spring-bone joint state on live Milady NPCs during walk vs idle.
 * Run: node scripts/cdp-hair-probe.mjs
 *
 * Connects to Chrome at localhost:9222, samples joint _currentTail/_prevTail
 * and head bone world-pos every 50ms for 3s, computes tail velocity vs head
 * velocity to diagnose the bald-spot root cause.
 */

import WebSocket from 'ws';

const CDP_LIST_URL = 'http://localhost:9222/json/list';

async function getPageWsUrl() {
  const res = await fetch(CDP_LIST_URL);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('clawville'));
  if (!page) throw new Error('No clawville page target found');
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

      const evaluate = (expr, awaitPromise = false) =>
        send('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise,
          timeout: 10000,
        }).then(r => {
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
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

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const wsUrl = await getPageWsUrl();
  console.log('Connecting to', wsUrl);
  const { evaluate, ws } = await cdpSession(wsUrl);

  // 1. Check visibility state (background throttle guard)
  const vis = await evaluate(`document.visibilityState`);
  console.log('visibilityState:', vis);
  if (vis !== 'visible') {
    console.warn('WARNING: tab is hidden — RAF throttled to 1fps, bone probes may be stale');
  }

  // 2. Check which NPCs are in __VRM_NPC_DEBUG
  const npcKeys = await evaluate(`
    (function() {
      const d = window.__VRM_NPC_DEBUG;
      if (!d) return null;
      return Object.keys(d);
    })()
  `);
  console.log('VRM_NPC_DEBUG keys:', npcKeys);

  if (!npcKeys || npcKeys.length === 0) {
    console.error('No VRM NPCs in debug registry — VRMs may not be loaded yet');
    ws.close();
    return;
  }

  // Pick first available NPC
  const npcId = npcKeys[0];
  console.log(`\nProbing NPC: ${npcId}`);

  // 3. Check what joint names exist on this NPC
  const jointInfo = await evaluate(`
    (function() {
      const d = window.__VRM_NPC_DEBUG['${npcId}'];
      if (!d || !d.vrm || !d.vrm.springBoneManager) return 'no springBoneManager';
      const joints = [...d.vrm.springBoneManager.joints];
      return joints.map(j => ({
        name: j.bone?.name ?? 'no-name',
        stiffness: j.settings?.stiffness,
        dragForce: j.settings?.dragForce,
        gravityPower: j.settings?.gravityPower,
        boneLength: j._boneLength ?? j._bonelength ?? j.initialLocalChildPosition?.length() ?? null,
      }));
    })()
  `);

  if (typeof jointInfo === 'string') {
    console.error('Joint info error:', jointInfo);
    ws.close();
    return;
  }

  console.log('\n=== All joints ===');
  for (const j of jointInfo) {
    console.log(`  ${j.name.padEnd(35)} stiffness=${String(j.stiffness).padEnd(8)} drag=${String(j.dragForce).padEnd(6)} gravity=${j.gravityPower}  boneLen=${j.boneLength?.toFixed(2) ?? 'n/a'}`);
  }

  // Identify back-of-head hair joints (hair regex)
  const hairJoints = jointInfo.filter(j => /hair/i.test(j.name));
  const backHairJoints = hairJoints.filter(j => /back|rear|B_Hair|HairBack/i.test(j.name));
  const targetJoints = backHairJoints.length > 0 ? backHairJoints : hairJoints.slice(0, 4);
  console.log('\nTarget joints for probe:', targetJoints.map(j => j.name));

  // 4. Check head bone world position (exists?)
  const headCheck = await evaluate(`
    (function() {
      const d = window.__VRM_NPC_DEBUG['${npcId}'];
      if (!d?.vrm?.humanoid) return 'no humanoid';
      const head = d.vrm.humanoid.getNormalizedBoneNode('head');
      if (!head) return 'no head bone';
      const wp = new THREE.Vector3();
      head.getWorldPosition(wp);
      return { name: head.name, wx: wp.x, wy: wp.y, wz: wp.z };
    })()
  `);
  console.log('\nHead bone:', headCheck);

  // 5. Sample joints + head bone every 50ms for 3 seconds
  console.log('\n=== Sampling 60 frames (50ms intervals) ===');
  console.log('Watching NPC movement state...');

  const targetJointNames = targetJoints.slice(0, 3).map(j => j.name);
  const samples = [];

  for (let i = 0; i < 60; i++) {
    const sample = await evaluate(`
      (function() {
        const d = window.__VRM_NPC_DEBUG['${npcId}'];
        if (!d?.vrm) return null;
        const vrm = d.vrm;
        const THREE = window.THREE;

        // Head bone world position
        let headWx = 0, headWy = 0, headWz = 0;
        if (vrm.humanoid) {
          const head = vrm.humanoid.getNormalizedBoneNode('head');
          if (head) {
            const wp = new THREE.Vector3();
            head.getWorldPosition(wp);
            headWx = wp.x; headWy = wp.y; headWz = wp.z;
          }
        }

        // Sample target joints
        const jointNames = ${JSON.stringify(targetJointNames)};
        const jointData = [];
        if (vrm.springBoneManager) {
          for (const j of vrm.springBoneManager.joints) {
            if (!jointNames.includes(j.bone?.name)) continue;
            const curTail = j._currentTail ?? j.currentTail;
            const prevTail = j._prevTail ?? j.prevTail;
            // Parent bone world pos
            const parentWp = new THREE.Vector3();
            if (j.bone?.parent) j.bone.parent.getWorldPosition(parentWp);

            jointData.push({
              name: j.bone.name,
              curTx: curTail?.x ?? 0, curTy: curTail?.y ?? 0, curTz: curTail?.z ?? 0,
              prevTx: prevTail?.x ?? 0, prevTy: prevTail?.y ?? 0, prevTz: prevTail?.z ?? 0,
              parentWx: parentWp.x, parentWy: parentWp.y, parentWz: parentWp.z,
            });
          }
        }

        return { t: Date.now(), headWx, headWy, headWz, joints: jointData };
      })()
    `);

    if (sample) samples.push(sample);
    await sleep(50);
  }

  if (samples.length < 2) {
    console.error('Not enough samples collected');
    ws.close();
    return;
  }

  // 6. Analyze: compute per-frame velocities
  console.log('\n=== Velocity analysis ===');
  console.log('(Per-frame delta = difference between consecutive 50ms samples)');
  console.log('Expected at walk speed ~13-20wu/s: head Δ ≈ 0.65-1.0wu/sample\n');

  const headVels = [];
  const tailVelsByJoint = {};
  const parentVelsByJoint = {};

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const dt = (curr.t - prev.t) / 1000;

    // Head velocity magnitude
    const dhx = curr.headWx - prev.headWx;
    const dhy = curr.headWy - prev.headWy;
    const dhz = curr.headWz - prev.headWz;
    const headVelMag = Math.sqrt(dhx*dhx + dhy*dhy + dhz*dhz) / dt;
    headVels.push(headVelMag);

    // Joint velocities
    for (const j of curr.joints) {
      const pj = prev.joints.find(x => x.name === j.name);
      if (!pj) continue;
      if (!tailVelsByJoint[j.name]) tailVelsByJoint[j.name] = [];
      if (!parentVelsByJoint[j.name]) parentVelsByJoint[j.name] = [];

      const dtx = j.curTx - pj.curTx;
      const dty = j.curTy - pj.curTy;
      const dtz = j.curTz - pj.curTz;
      tailVelsByJoint[j.name].push(Math.sqrt(dtx*dtx + dty*dty + dtz*dtz) / dt);

      const dpx = j.parentWx - pj.parentWx;
      const dpy = j.parentWy - pj.parentWy;
      const dpz = j.parentWz - pj.parentWz;
      parentVelsByJoint[j.name].push(Math.sqrt(dpx*dpx + dpy*dpy + dpz*dpz) / dt);
    }
  }

  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
  const max = arr => arr.length ? Math.max(...arr) : 0;

  const avgHeadVel = avg(headVels);
  const maxHeadVel = max(headVels);
  console.log(`Head bone: avg_vel=${avgHeadVel.toFixed(2)}wu/s  max_vel=${maxHeadVel.toFixed(2)}wu/s`);

  for (const jname of Object.keys(tailVelsByJoint)) {
    const tVels = tailVelsByJoint[jname];
    const pVels = parentVelsByJoint[jname];
    const avgTail = avg(tVels);
    const avgParent = avg(pVels);
    const lag = avgParent > 0.01 ? (1 - avgTail / avgParent) : 0;
    console.log(`${jname.padEnd(35)} tail_vel=${avgTail.toFixed(2).padEnd(7)} parent_vel=${avgParent.toFixed(2).padEnd(7)} lag=${(lag*100).toFixed(1)}%`);
  }

  // 7. Check if currentTail === prevTail (frozen spring)
  console.log('\n=== Frozen spring check (first sample with joints) ===');
  const firstWithJoints = samples.find(s => s.joints.length > 0);
  if (firstWithJoints) {
    for (const j of firstWithJoints.joints) {
      const dx = j.curTx - j.prevTx;
      const dy = j.curTy - j.prevTy;
      const dz = j.curTz - j.prevTz;
      const delta = Math.sqrt(dx*dx + dy*dy + dz*dz);
      console.log(`  ${j.name.padEnd(35)} cur-prev delta=${delta.toFixed(4)}  cur=[${j.curTx.toFixed(2)},${j.curTy.toFixed(2)},${j.curTz.toFixed(2)}]  prev=[${j.prevTx.toFixed(2)},${j.prevTy.toFixed(2)},${j.prevTz.toFixed(2)}]`);
    }
  }

  // 8. NPC direction state
  const npcState = await evaluate(`
    (function() {
      const d = window.__VRM_NPC_DEBUG['${npcId}'];
      // Try to get store NPC state
      try {
        const store = window.__GAME_STORE_DEBUG || window.__zustandStores;
        return { animator_ready: d?.animator?.ready, species: d?.species };
      } catch(e) {
        return { animator_ready: d?.animator?.ready, species: d?.species };
      }
    })()
  `);
  console.log('\nNPC state:', npcState);

  // 9. Parent bone parenting check — is hair root parented to head bone?
  const parentCheck = await evaluate(`
    (function() {
      const d = window.__VRM_NPC_DEBUG['${npcId}'];
      if (!d?.vrm?.springBoneManager) return null;
      const results = [];
      for (const j of d.vrm.springBoneManager.joints) {
        if (!/hair/i.test(j.bone?.name)) continue;
        // Walk up parent chain until we find head or null
        let cur = j.bone;
        const chain = [];
        let depth = 0;
        while (cur && depth < 10) {
          chain.push(cur.name);
          if (/head/i.test(cur.name)) break;
          cur = cur.parent;
          depth++;
        }
        results.push({ joint: j.bone.name, chain });
        if (results.length >= 5) break; // cap
      }
      return results;
    })()
  `);
  console.log('\n=== Hair joint parent chains (checking head bone ancestry) ===');
  if (Array.isArray(parentCheck)) {
    for (const r of parentCheck) {
      console.log(`  ${r.joint}: ${r.chain.join(' -> ')}`);
    }
  } else {
    console.log(parentCheck);
  }

  ws.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
