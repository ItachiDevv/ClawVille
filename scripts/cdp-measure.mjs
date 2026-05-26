#!/usr/bin/env node
// Quick CDP eval over websocket to localhost:9222 — measures three.js scene sizes.
import WebSocket from 'ws';

const WS_URL = process.argv[2];
const JS = process.argv[3];
if (!WS_URL || !JS) {
  console.error('usage: cdp-measure.mjs <wsUrl> <js>');
  process.exit(2);
}

const ws = new WebSocket(WS_URL, { perMessageDeflate: false });
let id = 1;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = id++;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.on('open', async () => {
  try {
    const res = await send('Runtime.evaluate', {
      expression: JS,
      returnByValue: true,
      awaitPromise: true,
      timeout: 20000,
    });
    if (res?.result?.result?.value !== undefined) {
      console.log(typeof res.result.result.value === 'string' ? res.result.result.value : JSON.stringify(res.result.result.value, null, 2));
    } else if (res?.result?.exceptionDetails) {
      console.error('EXCEPTION:', JSON.stringify(res.result.exceptionDetails, null, 2));
      process.exit(1);
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
  } catch (e) {
    console.error('ERR', e);
    process.exit(1);
  } finally {
    ws.close();
    process.exit(0);
  }
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(msg.error);
    else resolve(msg);
  }
});

ws.on('error', (e) => { console.error('WS_ERR', e.message); process.exit(1); });
