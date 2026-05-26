/**
 * cdp-spring-probe.mjs
 *
 * Connects to Chrome DevTools Protocol on localhost:9222 and reads the
 * spring-bone joint settings from the first walking Milady NPC debug entry.
 *
 * Prerequisites:
 *   - Chrome launched with --remote-debugging-port=9222
 *   - /game page loaded with VRM NPCs visible
 *   - window.__VRM_NPC_DEBUG['hermes-mira'] must be set (arena-npcs.tsx populates it)
 *
 * Usage:
 *   node scripts/cdp-spring-probe.mjs
 */

import http from 'http';
import WebSocket from 'ws';

function cdpRequest(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // Find the /game tab
  const tabs = await cdpRequest('http://localhost:9222/json');
  const gameTab = tabs.find((t) => t.url && t.url.includes('/game'));
  if (!gameTab) {
    console.error('No /game tab found. Open https://clawville.world/game in Chrome.');
    process.exit(1);
  }
  console.log('Found tab:', gameTab.url);

  const ws = new WebSocket(gameTab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let msgId = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Evaluate in page context
  const expr = `
    (function() {
      const debug = window.__VRM_NPC_DEBUG;
      if (!debug) return { error: '__VRM_NPC_DEBUG not set — NPCs may not be loaded yet' };

      const keys = Object.keys(debug);
      if (keys.length === 0) return { error: 'No NPC debug entries found' };

      const results = {};
      for (const npcId of keys) {
        const entry = debug[npcId];
        const vrm = entry && entry.vrm;
        if (!vrm || !vrm.springBoneManager) {
          results[npcId] = { error: 'No springBoneManager' };
          continue;
        }
        const joints = Array.from(vrm.springBoneManager.joints);
        results[npcId] = {
          jointCount: joints.length,
          joints: joints.slice(0, 10).map((j, i) => ({
            index: i,
            boneName: j.bone && j.bone.name,
            stiffness:    j.settings.stiffness,
            dragForce:    j.settings.dragForce,
            gravityPower: j.settings.gravityPower,
            hitRadius:    j.settings.hitRadius,
          })),
        };
      }
      return results;
    })()
  `;

  const result = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
  });

  if (result.exceptionDetails) {
    console.error('JS exception:', result.exceptionDetails.text);
  } else {
    console.log('\nSpring bone joint settings:');
    console.log(JSON.stringify(result.result.value, null, 2));
  }

  ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
