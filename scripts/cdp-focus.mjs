#!/usr/bin/env node
// Send raw CDP commands to focus a tab and optionally dispatch keyboard input.
// Usage: node cdp-focus.mjs focus <url-substring>
//        node cdp-focus.mjs key <url-substring> <keydown|keyup> <code>

import WebSocket from 'ws';

const CDP_HOST = 'localhost:9222';

async function listTabs() {
  const r = await fetch(`http://${CDP_HOST}/json`);
  return r.json();
}

async function pickTab(urlSubstring) {
  const tabs = await listTabs();
  const match = tabs.find(
    (t) => t.type === 'page' && (!urlSubstring || t.url.includes(urlSubstring))
  );
  if (!match) throw new Error(`No page tab matching '${urlSubstring}'`);
  return match;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function sendCmd(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id, method, params: params || {} });
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(payload);
  });
}

async function main() {
  const [, , op, urlSub, ...rest] = process.argv;
  const tab = await pickTab(urlSub);
  const ws = await connect(tab.webSocketDebuggerUrl);
  let nextId = 1;

  if (op === 'focus') {
    // 1. Bring the TAB to front within its window
    await sendCmd(ws, nextId++, 'Page.bringToFront');
    // 2. Emulate focus on the target — CDP tells Chrome to treat this page as
    //    focused even if the OS window isn't actually foregrounded.
    await sendCmd(ws, nextId++, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    // 3. Inject a pre-load script that spoofs visibilityState='visible' so the
    //    app itself (and R3F's frameloop) starts even when the OS window isn't
    //    actually visible. Runs on every new document, so survives reloads.
    await sendCmd(ws, nextId++, 'Page.enable');
    await sendCmd(ws, nextId++, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // Override at Document.prototype so every consumer sees visible.
        try {
          Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
          Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
        } catch (e) {}
        // Also defensively define on document instance once it exists.
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        // Un-throttle RAF so R3F's kickRenderLoop actually ticks when the OS window is hidden.
        const _origRAF = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (fn) => setTimeout(() => { try { fn(performance.now()); } catch(e) {} }, 16);
        window.__rafPatched = true;
      `,
    });
    console.log(JSON.stringify({ focused: tab.url, focusEmulation: true, visibilitySpoofed: true }));
  } else if (op === 'key') {
    const [phase, code] = rest;
    // CDP Input.dispatchKeyEvent
    const keyMap = {
      Space: { key: ' ', keyCode: 32, windowsVirtualKeyCode: 32, text: ' ' },
      KeyW:  { key: 'w', keyCode: 87, windowsVirtualKeyCode: 87, text: 'w' },
      KeyE:  { key: 'e', keyCode: 69, windowsVirtualKeyCode: 69, text: 'e' },
    };
    const km = keyMap[code];
    if (!km) throw new Error(`Unknown code: ${code}`);
    const type =
      phase === 'keydown' ? 'keyDown' :
      phase === 'keyup' ? 'keyUp' :
      phase === 'rawkeydown' ? 'rawKeyDown' :
      (() => { throw new Error(`phase must be keydown|keyup|rawkeydown`); })();
    await sendCmd(ws, nextId++, 'Input.dispatchKeyEvent', {
      type,
      code,
      key: km.key,
      keyCode: km.keyCode,
      windowsVirtualKeyCode: km.windowsVirtualKeyCode,
      ...(type === 'keyDown' ? { text: km.text } : {}),
    });
    console.log(JSON.stringify({ dispatched: { phase, code } }));
  } else {
    throw new Error(`usage: focus <url> | key <url> <keydown|keyup> <code>`);
  }

  ws.close();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
