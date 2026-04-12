#!/usr/bin/env bun
/**
 * cdp-eval.ts — evaluate JavaScript in the user's real foreground Chrome
 * tab via the Chrome DevTools Protocol at localhost:9222.
 *
 * The user launches Chrome with
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\clawville-dev
 * which opens a fresh isolated profile whose tabs are scriptable over CDP.
 * This script attaches to whatever tab matches a URL substring, runs a
 * JS expression in its context, and prints the JSON-serialised result.
 *
 * Usage:
 *   bun run scripts/cdp-eval.ts '<expression>' [url-substring]
 *
 * Defaults to matching the first tab whose URL contains 'clawville.world'.
 * With no expression, lists available tabs instead.
 *
 * Example:
 *   bun run scripts/cdp-eval.ts 'window.__W3D?.gl?.info?.render?.calls'
 *   bun run scripts/cdp-eval.ts '({fps: window.__W3D_STATUS?.loopTicks, draws: window.__W3D?.gl?.info?.render?.calls})'
 */

const CDP_HOST = 'http://localhost:9222';
const DEFAULT_URL_MATCH = 'clawville.world';

interface CdpTab {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function fetchTabs(): Promise<CdpTab[]> {
  const res = await fetch(`${CDP_HOST}/json`);
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  const tabs = (await res.json()) as CdpTab[];
  return tabs.filter((t) => t.type === 'page');
}

async function pickTab(urlMatch: string): Promise<CdpTab> {
  const tabs = await fetchTabs();
  const hit = tabs.find((t) => t.url.includes(urlMatch));
  if (!hit) {
    console.error(`No page tab matching '${urlMatch}'. Available tabs:`);
    for (const t of tabs) console.error(`  ${t.id}  ${t.url}`);
    process.exit(2);
  }
  return hit;
}

async function evalInTab(tab: CdpTab, expression: string): Promise<unknown> {
  // Long default so multi-step profiling / experiment scripts have room.
  // Override with CDP_EVAL_TIMEOUT=<ms> env var for tighter budgets.
  const TIMEOUT_MS = Number(Bun.env.CDP_EVAL_TIMEOUT ?? 180_000);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP Runtime.evaluate timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true,
          },
        }),
      );
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) {
        reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
      } else if (msg.result?.exceptionDetails) {
        reject(
          new Error(
            `Runtime exception: ${msg.result.exceptionDetails.exception?.description ?? JSON.stringify(msg.result.exceptionDetails)}`,
          ),
        );
      } else {
        resolve(msg.result?.result?.value);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${String(err)}`));
    };
  });
}

async function main() {
  const [, , expr, urlMatchArg] = Bun.argv;
  const urlMatch = urlMatchArg ?? DEFAULT_URL_MATCH;

  if (!expr) {
    const tabs = await fetchTabs();
    console.log(JSON.stringify(tabs.map(({ id, title, url }) => ({ id, title, url })), null, 2));
    return;
  }

  const tab = await pickTab(urlMatch);
  const value = await evalInTab(tab, expr);
  console.log(JSON.stringify(value, null, 2));
}

main().catch((err) => {
  console.error(`[cdp-eval] ${err.message}`);
  process.exit(1);
});
