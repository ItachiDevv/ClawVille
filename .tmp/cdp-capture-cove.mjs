/**
 * Connect to the open cove tab on localhost:9222, subscribe to
 * Runtime.consoleAPICalled, trigger a reload, capture logs for 15s,
 * print everything matching /cove-interior/ or any error/warning.
 */
import WebSocket from 'ws';

const TABS = await (await fetch('http://localhost:9222/json')).json();
const tab = TABS.find(t => t.type === 'page' && (t.url.includes('clawville.world') || t.url.includes('localhost:3000')));
if (!tab) {
  console.error('No clawville.world tab open');
  process.exit(1);
}

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
function send(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

const logs = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args || []).map(a => {
      if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
      if (a.description) return a.description;
      return '';
    }).join(' ');
    logs.push({ type: msg.params.type, ts: msg.params.timestamp, msg: args });
  }
});

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });

console.log('Reloading + capturing for 15s…');
await new Promise(r => setTimeout(r, 15000));

ws.close();

console.log(`\n=== ${logs.length} log lines captured ===\n`);
for (const l of logs) {
  if (/cove-interior|✓SLOT|Material|rejected|skipped|cabinets/.test(l.msg)) {
    console.log(`[${l.type}] ${l.msg}`);
  }
}
console.log('\n=== filtered relevant lines above ===');
