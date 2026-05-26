#!/usr/bin/env node
// QA verifier - drives user's real browser through a reef race for camera/icon/debug verification.
// Run: node scripts/qa-race-verify.mjs
import WebSocket from 'ws';
import { writeFileSync } from 'fs';

async function listTabs() { return await (await fetch('http://localhost:9222/json')).json(); }
async function getCookies() {
  const ws = await connectBrowser();
  const r = await callBrowser(ws, 'Storage.getCookies', {});
  ws.close();
  return r.cookies;
}
async function connectBrowser() {
  const ver = await (await fetch('http://localhost:9222/json/version')).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));
  return ws;
}
function callBrowser(ws, method, params) {
  const id = Date.now() + Math.floor(Math.random()*1000);
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.id === id) { ws.off('message', onMsg); m.error?reject(m.error):resolve(m.result); }
      } catch {}
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error(`timeout ${method}`)); }, 60000);
  });
}

async function pickClawvilleTab() {
  const tabs = await listTabs();
  return tabs.find(t => t.type === 'page' && t.url?.includes('clawville'));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function send(ws, method, params={}, timeoutMs=60000) {
  const id = Date.now() + Math.floor(Math.random()*1000);
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.id === id) { ws.off('message', onMsg); m.error?reject(m.error):resolve(m.result); }
      } catch {}
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error(`timeout ${method}`)); }, timeoutMs);
  });
}

async function evalJs(ws, expression, timeoutMs=10000) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs - 500, userGesture: true
  }, timeoutMs);
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r.result?.value;
}

async function screenshot(ws, outPath) {
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`  saved ${outPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'verify';

  const tab = await pickClawvilleTab();
  if (!tab) throw new Error('no clawville tab');
  console.log('tab:', tab.url);
  const ws = await connect(tab.webSocketDebuggerUrl);

  try {
    console.log('  Page.enable...');
    await Promise.race([send(ws, 'Page.enable'), new Promise((_,j) => setTimeout(()=>j(new Error('Page.enable timeout 5s')), 5000))]);
    console.log('  Page.bringToFront...');
    await Promise.race([send(ws, 'Page.bringToFront'), new Promise((_,j) => setTimeout(()=>j(new Error('btf timeout 5s')), 5000))]).catch(e => console.log('   skip btf:', e.message));
    console.log('  setFocusEmulationEnabled...');
    await Promise.race([send(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }), new Promise((_,j) => setTimeout(()=>j(new Error('focus timeout 5s')), 5000))]).catch(e => console.log('   skip focus:', e.message));
    console.log('  addScriptToEvaluateOnNewDocument...');
    await Promise.race([send(ws, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `try{Object.defineProperty(Document.prototype,'visibilityState',{get:()=>'visible',configurable:true});Object.defineProperty(Document.prototype,'hidden',{get:()=>false,configurable:true});}catch(e){}`
    }), new Promise((_,j) => setTimeout(()=>j(new Error('addScript timeout 5s')), 5000))]).catch(e => console.log('   skip addScript:', e.message));
    console.log('  setup done');

    if (cmd === 'queue') {
      // Queue + wait for match
      console.log('1) Queueing reef-race...');
      const queueRes = await evalJs(ws, `(async()=>{const r=await fetch('https://api.clawville.world/api/activities/reef-race/queue',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({allowBotBackfill:true})});return JSON.stringify({s:r.status,b:await r.text()});})()`, 15000);
      console.log('  queue:', queueRes);
      console.log('2) Polling for match...');
      let roomId = null, shortCode = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const status = await evalJs(ws, `(async()=>{const r=await fetch('https://api.clawville.world/api/activities/reef-race/queue-status',{credentials:'include'});return await r.json();})()`, 8000);
        console.log(`  poll ${i}:`, JSON.stringify(status).slice(0,200));
        if (status.matchedRoomId) { roomId = status.matchedRoomId; shortCode = status.matchedRoomShortCode; break; }
      }
      if (!roomId) { console.error('NO MATCH'); process.exit(1); }
      console.log('3) Navigating to room', roomId);
      await send(ws, 'Page.navigate', { url: `https://clawville.world/activity/reef-race/${roomId}?shortCode=${shortCode}&debug=1` });
      console.log('4) Waiting 18s for race scene to load + start...');
      await new Promise(r => setTimeout(r, 18000));
      // Check state
      const stateRes = await evalJs(ws, `JSON.stringify({u:document.URL,vis:document.visibilityState,dbg:typeof window.__reefDebug,hasGl:!!window.__reefDebug?.gl,sceneCh:window.__reefDebug?.scene?.children?.length,frame:window.__reefDebug?.gl?.info?.render?.frame,tris:window.__reefDebug?.gl?.info?.render?.triangles,ent:window.__reefDebug?.entities?.size,raceText:document.body.innerText.match(/RACE\\s*\\d+%/)?.[0],bodyAll:document.body.innerText.replace(/\\s+/g,' ').slice(0,300)})`);
      console.log('STATE:', stateRes);
      // Screenshot mid-race
      await screenshot(ws, 'C:/Users/newma/Documents/Crypto/ClawVille/screenshots/qa-2026-04-29/race-midrace.png');
      // Wait for race to finish or 60s
      console.log('5) Waiting 30s for race progress...');
      await new Promise(r => setTimeout(r, 30000));
      const stateRes2 = await evalJs(ws, `JSON.stringify({frame:window.__reefDebug?.gl?.info?.render?.frame,ent:window.__reefDebug?.entities?.size,raceText:document.body.innerText.match(/RACE\\s*\\d+%/)?.[0],bodyAll:document.body.innerText.replace(/\\s+/g,' ').slice(0,400)})`);
      console.log('STATE2:', stateRes2);
      await screenshot(ws, 'C:/Users/newma/Documents/Crypto/ClawVille/screenshots/qa-2026-04-29/race-30s-later.png');
      // Wait for results modal
      console.log('6) Waiting up to 90s for results modal...');
      let modalSeen = false;
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 8000));
        const modal = await evalJs(ws, `JSON.stringify({modal:!!document.querySelector('[role=dialog],[class*=modal],[class*=Modal],[class*=Results]'),text:document.body.innerText.replace(/\\s+/g,' ').slice(0,400),emojis:Array.from(document.body.innerText.matchAll(/[\\u{1F300}-\\u{1F9FF}\\u{1F600}-\\u{1F64F}\\u{2700}-\\u{27BF}\\u{1F680}-\\u{1F6FF}]/gu)).map(m=>m[0]).slice(0,20)})`);
        console.log(`  modal-poll ${i}:`, modal.slice(0, 250));
        if (modal.includes('"modal":true')) { modalSeen = true; await screenshot(ws, `C:/Users/newma/Documents/Crypto/ClawVille/screenshots/qa-2026-04-29/race-results-modal.png`); break; }
      }
      console.log('Modal seen:', modalSeen);
    } else if (cmd === 'snapshot') {
      const expr = args[1] || `JSON.stringify({u:document.URL,dbg:typeof window.__reefDebug,scCh:window.__reefDebug?.scene?.children?.length})`;
      const r = await evalJs(ws, expr);
      console.log(r);
    } else if (cmd === 'screenshot') {
      await screenshot(ws, args[1]);
    }
  } finally {
    ws.close();
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
