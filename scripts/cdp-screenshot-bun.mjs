#!/usr/bin/env bun
// Screenshot via CDP (Bun-native WebSocket).
// Usage: bun run scripts/cdp-screenshot-bun.mjs <url-substring> <output-path>

import { writeFileSync } from 'fs';

// Bun: argv = [bunPath, scriptPath, ...args]
const [, , urlSub, outPath] = process.argv;

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const tab = tabs.find(t => t.type === 'page' && t.url.includes(urlSub));
if (!tab) { console.error('no tab'); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const reply = await new Promise(resolve => {
  ws.onmessage = e => resolve(JSON.parse(e.data));
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true } }));
});

if (reply.error) { console.error(JSON.stringify(reply.error)); process.exit(1); }
writeFileSync(outPath, Buffer.from(reply.result.data, 'base64'));
console.log(`saved ${outPath}`);
ws.close();
