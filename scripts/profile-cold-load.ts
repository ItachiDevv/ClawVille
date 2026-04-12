#!/usr/bin/env bun
/**
 * profile-cold-load.ts — full cold-load profiling via CDP.
 *
 * Steps:
 *   1. Find the target tab by URL substring
 *   2. Enable Page + Runtime + Network domains
 *   3. Install a PerformanceObserver via Page.addScriptToEvaluateOnNewDocument
 *      (so it's live BEFORE the page's JS runs and catches mount long-tasks)
 *   4. Clear the browser cache
 *   5. Reload the tab
 *   6. Poll for scene readiness (window.__W3D.scene.children.length > 10)
 *   7. Read all captured metrics back via Runtime.evaluate
 *
 * Usage:
 *   bun run scripts/profile-cold-load.ts [url-substring]
 */

const CDP_HOST = 'http://localhost:9222';
const DEFAULT_URL_MATCH = 'clawville.world';
const READY_POLL_INTERVAL_MS = 200;
const READY_TIMEOUT_MS = 30_000;

interface CdpTab {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function fetchTabs(): Promise<CdpTab[]> {
  const res = await fetch(`${CDP_HOST}/json`);
  const tabs = (await res.json()) as CdpTab[];
  return tabs.filter((t) => t.type === 'page');
}

/**
 * The harness that runs inside the page on every navigation. It installs
 * three PerformanceObservers (long-task, paint, LCP) and stashes their
 * entries on window.__PROFILE__. Also records the first time window.__W3D
 * is set and the first time the scene has > 10 children (mount complete).
 */
const PAGE_HARNESS = `
(() => {
  if (window.__PROFILE__) return;
  const data = {
    longTasks: [],
    paints: [],
    lcp: null,
    sceneGlobalSetAt: null,
    sceneMountedAt: null,
    errors: [],
  };
  window.__PROFILE__ = data;

  try {
    const lt = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        data.longTasks.push({
          startTime: Math.round(e.startTime),
          duration: Math.round(e.duration),
          name: e.name,
          // Attribution tells you which iframe/script caused it
          attribution: (e).attribution?.map((a) => a.name) ?? [],
        });
      }
    });
    lt.observe({ type: 'longtask', buffered: true });
  } catch (err) { data.errors.push('longtask: ' + err.message); }

  try {
    const pp = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        data.paints.push({ name: e.name, startTime: Math.round(e.startTime) });
      }
    });
    pp.observe({ type: 'paint', buffered: true });
  } catch (err) { data.errors.push('paint: ' + err.message); }

  try {
    const lp = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        data.lcp = { startTime: Math.round(e.startTime), size: e.size };
      }
    });
    lp.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) { data.errors.push('lcp: ' + err.message); }

  // Poll for scene readiness markers
  let pollStart = performance.now();
  const poll = setInterval(() => {
    if (!data.sceneGlobalSetAt && window.__W3D) {
      data.sceneGlobalSetAt = Math.round(performance.now());
    }
    if (data.sceneGlobalSetAt && !data.sceneMountedAt) {
      const n = window.__W3D?.scene?.children?.length ?? 0;
      if (n > 10) {
        data.sceneMountedAt = Math.round(performance.now());
        clearInterval(poll);
      }
    }
    if (performance.now() - pollStart > 60_000) clearInterval(poll);
  }, 50);
})();
`;

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private eventHandlers = new Map<string, ((params: any) => void)[]>();
  public ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`ws error: ${String(e)}`));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const handlers = this.eventHandlers.get(msg.method) ?? [];
        for (const h of handlers) h(msg.params);
      }
    };
  }

  async send<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: any) => void) {
    const list = this.eventHandlers.get(method) ?? [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  const urlMatch = Bun.argv[2] ?? DEFAULT_URL_MATCH;

  console.error(`[profile] looking for tab matching '${urlMatch}'...`);
  const tabs = await fetchTabs();
  const tab = tabs.find((t) => t.url.includes(urlMatch));
  if (!tab) {
    console.error(`[profile] no tab found. Available:`);
    for (const t of tabs) console.error(`  ${t.url}`);
    process.exit(2);
  }
  console.error(`[profile] attaching to ${tab.url}`);

  const client = new CdpClient(tab.webSocketDebuggerUrl);
  await client.ready;

  // Enable the domains we need
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');

  // Install the harness to run on every new document
  console.error('[profile] installing perf harness...');
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HARNESS });

  // Clear browser cache for a true cold load
  console.error('[profile] clearing browser cache...');
  await client.send('Network.clearBrowserCache');

  // Promise that resolves on Page.loadEventFired
  let loadResolve: () => void;
  const loadPromise = new Promise<void>((resolve) => { loadResolve = resolve; });
  client.on('Page.loadEventFired', () => loadResolve());

  // Reload
  console.error('[profile] reloading tab...');
  const reloadStart = Date.now();
  await client.send('Page.reload', { ignoreCache: true });

  // Wait for load event
  await loadPromise;
  const loadWallTime = Date.now() - reloadStart;
  console.error(`[profile] load event fired after ${loadWallTime}ms wall-clock`);

  // Poll for scene mounted
  console.error('[profile] polling for scene mount...');
  const pollStart = Date.now();
  let mounted = false;
  while (Date.now() - pollStart < READY_TIMEOUT_MS) {
    const res = await client.send<any>('Runtime.evaluate', {
      expression: '(() => ({ hasW3D: !!window.__W3D, n: window.__W3D?.scene?.children?.length ?? 0 }))()',
      returnByValue: true,
    });
    const v = res.result?.value ?? {};
    if (v.hasW3D && v.n > 10) {
      mounted = true;
      break;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  if (!mounted) {
    console.error('[profile] WARNING: scene not mounted before timeout, reading partial data');
  }

  // Give it another 1.5s for frame stabilization + any late long-tasks
  await new Promise((r) => setTimeout(r, 1500));

  // Read the full profile data
  console.error('[profile] reading captured metrics...');
  const readExpr = `
    (() => {
      const p = window.__PROFILE__ || { error: 'no harness' };
      const nav = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource');

      // Resource breakdown
      const byType = {};
      const glbResources = [];
      for (const r of resources) {
        const k = r.initiatorType || 'other';
        if (!byType[k]) byType[k] = { count: 0, duration: 0, size: 0 };
        byType[k].count++;
        byType[k].duration += r.duration || 0;
        byType[k].size += r.transferSize || 0;
        if (r.name.endsWith('.glb')) {
          glbResources.push({
            name: r.name.split('/').pop().slice(0, 40),
            startTime: Math.round(r.startTime),
            duration: Math.round(r.duration),
            endTime: Math.round(r.responseEnd),
            transferSize: r.transferSize,
            decodedBodySize: r.decodedBodySize,
          });
        }
      }
      glbResources.sort((a, b) => a.startTime - b.startTime);

      // Long-task summary
      const ltSummary = {
        count: p.longTasks.length,
        totalMs: p.longTasks.reduce((a, b) => a + b.duration, 0),
        maxMs: p.longTasks.reduce((a, b) => Math.max(a, b.duration), 0),
        top5: [...p.longTasks].sort((a, b) => b.duration - a.duration).slice(0, 5),
      };

      return {
        harnessErrors: p.errors,
        navigation: nav ? {
          fetchStart: Math.round(nav.fetchStart),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          domInteractive: Math.round(nav.domInteractive),
          dcl: Math.round(nav.domContentLoadedEventEnd),
          load: Math.round(nav.loadEventEnd),
          transferSize: nav.transferSize,
        } : null,
        paints: p.paints,
        lcp: p.lcp,
        sceneGlobalSetAt: p.sceneGlobalSetAt,
        sceneMountedAt: p.sceneMountedAt,
        timeFromLoadToScene: p.sceneMountedAt && nav ? p.sceneMountedAt - Math.round(nav.loadEventEnd) : null,
        longTasks: ltSummary,
        resourceBreakdown: byType,
        glbLoadOrder: glbResources,
      };
    })()
  `;
  const res = await client.send<any>('Runtime.evaluate', {
    expression: readExpr,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log(JSON.stringify(res.result?.value ?? { error: 'no value', raw: res }, null, 2));
  client.close();
}

main().catch((err) => {
  console.error('[profile] ' + err.message);
  process.exit(1);
});
