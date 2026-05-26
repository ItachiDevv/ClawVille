#!/usr/bin/env node
// QA screenshot - activates tab first, then captures
// Usage: node scripts/cdp-qa-screenshot.mjs <url-substring> <output-path>

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const [, , urlSub, outPath] = process.argv;
if (!urlSub || !outPath) { console.error('usage: cdp-qa-screenshot.mjs <url-sub> <out-path>'); process.exit(2); }

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const tab = tabs.find(t => t.type === 'page' && t.url.includes(urlSub));
if (!tab) { console.error(`no tab matching ${urlSub}`); process.exit(1); }

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
  await send('Page.enable');
  await send('Page.bringToFront').catch(() => {});
  // Tiny delay to let frame buffer flip
  await new Promise(r => setTimeout(r, 500));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${outPath} (${(shot.data.length / 1024).toFixed(0)}KB)`);
} catch (e) {
  console.error('ERR:', e.message);
  process.exit(1);
} finally {
  ws.close();
}
