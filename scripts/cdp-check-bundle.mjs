// Check deployed JS bundle for expected constants
const res = await fetch('http://localhost:9222/json/list');
const tabs = await res.json();
const tab = tabs.find(t => t.url.includes('clawville.world/game'));
if (!tab) { console.error('no game tab'); process.exit(1); }
const WS = (await import('ws')).default;
const ws = new WS(tab.webSocketDebuggerUrl);
await new Promise(r => ws.on('open', r));
let id = 1;
function call(method, params = {}) {
  const reqId = id++;
  return new Promise((resolve) => {
    ws.on('message', function onMsg(m) {
      const d = JSON.parse(m.toString());
      if (d.id === reqId) { ws.off('message', onMsg); resolve(d); }
    });
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}

const expr = `(async () => {
  const scripts = Array.from(document.querySelectorAll('script[src*="_next/static/chunks"]')).map(s => s.src);
  const hits = [];
  for (const url of scripts) {
    try {
      const r = await fetch(url);
      const txt = await r.text();
      // Find ALL atan2 occurrences and grab context
      let idx = -1;
      while ((idx = txt.indexOf('atan2(-', idx + 1)) >= 0) {
        const ctx = txt.slice(Math.max(0, idx - 100), idx + 280);
        hits.push({ file: url.split('/').pop(), idx, ctx: ctx.replace(/\\s+/g, ' ').slice(0, 380) });
      }
      // Also look for SPEED multiplication patterns: "*320*" or "*200*"
      const speed320 = [...txt.matchAll(/\\*320\\*/g)].length;
      const speed200 = [...txt.matchAll(/\\*200\\*/g)].length;
      if (speed320 || speed200) hits.push({ file: url.split('/').pop(), speed320, speed200 });
    } catch (e) {}
  }
  return { count: hits.length, hits };
})()`;

const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result?.result?.value, null, 2));
ws.close();
