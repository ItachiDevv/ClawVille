#!/usr/bin/env node
// CDP driver: navigate tab to mixamo, set FBX file via DOM.setFileInputFiles
// Usage: node cdp-mixamo-upload.mjs <command> [args]
import { readFileSync } from 'fs';

const CDP_HOST = 'http://localhost:9222';

// Available FBX targets — keyed by short name passed as `node ... upload <name>`.
// Default (no name) is 'guide' for backward compat with prior pipeline.
const FBX_TARGETS = {
  guide: 'C:\\Users\\newma\\Documents\\Crypto\\ClawVille\\scripts\\blender-output\\guide-ready-for-mixamo.fbx',
};
const DEFAULT_FBX = FBX_TARGETS.guide;

async function listTabs() {
  const r = await fetch(`${CDP_HOST}/json`);
  return r.json();
}

async function pickTab(urlContains) {
  const tabs = await listTabs();
  const pages = tabs.filter(t => t.type === 'page');
  if (urlContains) {
    const match = pages.find(p => p.url.includes(urlContains));
    if (match) return match;
  }
  return pages[0];
}

// Multi-command session over a single WS (Node 24 native WebSocket)
async function withSession(tab, fn) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 60000);
    ws.addEventListener('open', async () => {
      const send = (m, p = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method: m, params: p }));
      });
      try {
        const out = await fn(send);
        clearTimeout(timer);
        ws.close();
        resolve(out);
      } catch (e) { clearTimeout(timer); ws.close(); reject(e); }
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (ev) => { clearTimeout(timer); reject(new Error('WS error')); });
  });
}

const cmd = process.argv[2];

async function main() {
  if (cmd === 'list') {
    const tabs = await listTabs();
    tabs.forEach(t => console.log(`${t.type} ${t.id.slice(0,8)} ${t.url}`));
    return;
  }

  if (cmd === 'navigate') {
    const tab = await pickTab();
    console.log(`Navigating ${tab.id.slice(0,8)} to mixamo.com`);
    await withSession(tab, async (send) => {
      await send('Page.enable');
      await send('Page.navigate', { url: 'https://www.mixamo.com/' });
    });
    console.log('Navigation sent');
    return;
  }

  if (cmd === 'eval') {
    const expr = process.argv[3];
    const tab = await pickTab('mixamo');
    const r = await withSession(tab, async (send) => {
      return send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'upload') {
    const target = process.argv[3];
    const fbxPath = target ? FBX_TARGETS[target] : DEFAULT_FBX;
    if (target && !fbxPath) {
      throw new Error(`Unknown target '${target}'. Known: ${Object.keys(FBX_TARGETS).join(', ')}`);
    }
    const tab = await pickTab('mixamo');
    console.log(`Using tab ${tab.id.slice(0,8)} — ${tab.url}`);
    const result = await withSession(tab, async (send) => {
      await send('DOM.enable');
      await send('Page.enable');

      // Get document root
      const doc = await send('DOM.getDocument');
      // Query for file input
      const q = await send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      });
      if (!q.nodeId) throw new Error('No file input found — is upload dialog open?');
      console.log(`Found file input nodeId=${q.nodeId}`);

      // Set the file
      await send('DOM.setFileInputFiles', {
        nodeId: q.nodeId,
        files: [fbxPath],
      });
      console.log(`Set file: ${fbxPath}`);
      return { ok: true };
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (cmd === 'screenshot') {
    const tab = await pickTab('mixamo');
    const out = process.argv[3] || 'screenshots/mixamo-cdp.png';
    const r = await withSession(tab, async (send) => {
      return send('Page.captureScreenshot', { format: 'png' });
    });
    const { writeFileSync } = await import('fs');
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(out, buf);
    console.log(`Saved screenshot: ${out} (${buf.length} bytes)`);
    return;
  }

  console.error(`Unknown cmd: ${cmd}`);
  console.error('Commands: list | navigate | eval <expr> | upload | screenshot [path]');
  process.exit(1);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
