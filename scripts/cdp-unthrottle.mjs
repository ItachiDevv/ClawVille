// Force the CDP-attached tab to act focused/visible so RAF is not throttled.
// Uses Emulation.setFocusEmulationEnabled + Page.bringToFront via raw CDP WS.
import WebSocket from 'ws';

const res = await fetch('http://localhost:9222/json');
const tabs = await res.json();
const tab = tabs.find(t => t.url?.includes('clawville.world'));
if (!tab) { console.error('no clawville tab'); process.exit(1); }
console.log('tab:', tab.url);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.on('open', r));

let id = 0;
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    const onMsg = (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.id === mid) {
        ws.off('message', onMsg);
        if (m.error) reject(m.error);
        else resolve(m.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

try {
  console.log('Page.bringToFront:', await send('Page.bringToFront'));
} catch (e) { console.log('bringToFront err:', e.message); }
try {
  console.log('Emulation.setFocusEmulationEnabled:', await send('Emulation.setFocusEmulationEnabled', { enabled: true }));
} catch (e) { console.log('focus err:', e.message); }
try {
  console.log('Emulation.setPageScaleFactor:', await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }));
} catch (e) {}

ws.close();
