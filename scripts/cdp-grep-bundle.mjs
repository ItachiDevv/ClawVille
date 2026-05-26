// Grep deployed chunks for specific literal patterns
const res = await fetch('http://localhost:9222/json/list');
const tabs = await res.json();
const tab = tabs.find(t => t.url.includes('clawville.world/game'));
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
  const scripts = Array.from(document.querySelectorAll('script[src*="_next/static"]')).map(s => s.src);
  let hit550 = 0, hit320 = 0, hit200 = 0;
  for (const url of scripts) {
    try {
      const r = await fetch(url);
      const txt = await r.text();
      const m550 = [...txt.matchAll(/\\*550\\*/g)].length;
      const m320 = [...txt.matchAll(/\\*320\\*/g)].length;
      const m200 = [...txt.matchAll(/\\*200\\*/g)].length;
      hit550 += m550;
      hit320 += m320;
      hit200 += m200;
      if (m550 || m320) console.log(url.split('/').pop(), '550:', m550, '320:', m320, '200:', m200);
    } catch (e) {}
  }
  return { totalChunks: scripts.length, hit550, hit320, hit200 };
})()`;

const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log('result:', JSON.stringify(r.result?.result?.value));
console.log('console logs during eval:', r.result?.exceptionDetails);
ws.close();
