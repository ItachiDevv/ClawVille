#!/usr/bin/env node
// Capture a full-page screenshot via CDP and save to disk.
// Usage: node cdp-screenshot.mjs <url-substring> <output-path>

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const [, , urlSub, outPath] = process.argv;

const tabs = await (await fetch('http://localhost:9222/json')).json();
const tab = tabs.find((t) => t.type === 'page' && t.url.includes(urlSub));
if (!tab) throw new Error(`no tab matching ${urlSub}`);

const ws = await new Promise((res, rej) => {
  const s = new WebSocket(tab.webSocketDebuggerUrl);
  s.once('open', () => res(s));
  s.once('error', rej);
});

let id = 1;
function send(method, params) {
  return new Promise((res, rej) => {
    const mid = id++;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === mid) {
        ws.off('message', onMsg);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    ws.on('message', onMsg);
  });
}

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
console.log(`saved ${outPath} (${(shot.data.length / 1024).toFixed(0)}KB base64)`);
ws.close();
