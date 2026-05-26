#!/usr/bin/env node
// QA verification eval - runs JS in clawville tab via CDP
// Usage: node scripts/cdp-qa-eval.mjs '<expression>'

import WebSocket from 'ws';

const JS = process.argv[2];
const URL_SUB = process.argv[3] || 'clawville.world';
if (!JS) { console.error('usage: cdp-qa-eval.mjs <js> [url-substring]'); process.exit(2); }

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const tab = tabs.find(t => t.type === 'page' && t.url.includes(URL_SUB));
if (!tab) { console.error(`no tab matching ${URL_SUB}`); process.exit(1); }

const ws = await new Promise((res, rej) => {
  const s = new WebSocket(tab.webSocketDebuggerUrl);
  s.once('open', () => res(s));
  s.once('error', rej);
});

let idCounter = 1;
function send(method, params) {
  return new Promise((res, rej) => {
    const id = idCounter++;
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.id === id) {
          ws.off('message', onMsg);
          if (m.error) rej(new Error(JSON.stringify(m.error)));
          else res(m.result);
        }
      } catch (e) {}
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { ws.off('message', onMsg); rej(new Error(`timeout ${method}`)); }, 30000);
  });
}

try {
  // Activate first
  await send('Page.bringToFront').catch(() => {});
  const r = await send('Runtime.evaluate', {
    expression: JS,
    returnByValue: true,
    awaitPromise: true,
    timeout: 25000,
    userGesture: true
  });
  if (r.exceptionDetails) {
    console.error('EXCEPTION:', JSON.stringify(r.exceptionDetails, null, 2));
    process.exit(1);
  }
  const v = r.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
} catch (e) {
  console.error('ERR:', e.message);
  process.exit(1);
} finally {
  ws.close();
}
