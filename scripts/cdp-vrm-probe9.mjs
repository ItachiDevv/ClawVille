#!/usr/bin/env bun
// Probe 9: read console via CDP enable + buffer

const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
const page = tabs.find(t => t.type === 'page' && t.url.includes('clawville.world'));
if (!page) { console.error('no tab'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 1;
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Log.entryAdded' || m.method === 'Runtime.exceptionThrown') {
    logs.push(m);
  }
});

function send(method, params) {
  return new Promise(resolve => {
    const mid = id++;
    const onMsg = e => {
      const m = JSON.parse(e.data);
      if (m.id === mid) { ws.removeEventListener('message', onMsg); resolve(m); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

// Enable log streams
await send('Runtime.enable');
await send('Log.enable');

// Install a patch via injected IIFE that also captures console.warn/console.error
const patch = `
(() => {
  if (window.__LOG_CAPTURE) return 'already';
  window.__LOG_CAPTURE = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  ['warn','error','log'].forEach(k => {
    console[k] = function(...args) {
      try { window.__LOG_CAPTURE.push({ k, t: Date.now(), a: args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
      })}); } catch{}
      if (window.__LOG_CAPTURE.length > 300) window.__LOG_CAPTURE.splice(0, window.__LOG_CAPTURE.length - 300);
      return orig[k].apply(console, args);
    };
  });
  return 'installed';
})()
`;
const r = await send('Runtime.evaluate', { expression: patch, returnByValue: true });
console.log('Patch installed:', r.result.result.value);

// Wait 5s for animator-related log entries
await new Promise(r => setTimeout(r, 5000));

const readLogs = `
(() => {
  const all = window.__LOG_CAPTURE || [];
  const filtered = all.filter(l =>
    l.a && l.a.some(x => /VRM|Mixamo|retarget|animator|humanoid|normalize|track|binding|MToon/i.test(x))
  );
  return { totalLogs: all.length, filteredCount: filtered.length, filtered: filtered.slice(-50), tail: all.slice(-25) };
})()
`;
const rlogs = await send('Runtime.evaluate', { expression: readLogs, returnByValue: true });
console.log('\n--- Filtered + tail logs ---');
console.log(JSON.stringify(rlogs.result.result.value, null, 2));

// Also report CDP-streamed log messages
console.log('\n--- CDP event-stream log count ---');
console.log('events:', logs.length);
const relevant = logs.filter(m => {
  const args = m.params?.args || [];
  return args.some(a => a.value && /VRM|Mixamo|retarget|animator|humanoid|normalize|track|binding|MToon/i.test(String(a.value)));
});
console.log('relevant:', relevant.length);
console.log(JSON.stringify(relevant.slice(-20).map(m => ({ type: m.params?.type, args: m.params?.args?.map(a => a.value) })), null, 2));

ws.close();
