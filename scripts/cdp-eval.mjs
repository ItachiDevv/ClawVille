#!/usr/bin/env bun
// Usage: bun run scripts/cdp-eval.mjs "<js expression>"
// Uses Bun's native WebSocket to run an expression in the first CDP page tab.

const JS = process.argv[2];
if (!JS) { console.error('usage: cdp-eval.mjs <js>'); process.exit(2); }

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no clawville page tab found'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const reply = await new Promise((resolve) => {
  ws.onmessage = (e) => resolve(JSON.parse(e.data));
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: JS, returnByValue: true, awaitPromise: true, timeout: 20000 }
  }));
});

if (reply?.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(reply.result.exceptionDetails, null, 2));
  process.exit(1);
}
const v = reply?.result?.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
ws.close();
