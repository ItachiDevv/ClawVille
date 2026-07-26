#!/usr/bin/env bun

import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const argv = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, ...value] = raw.replace(/^--/, '').split('=');
    return [key, value.join('=') || '1'];
  }),
);
const lane = argv.get('lane') ?? 'synthetic';
if (lane !== 'synthetic' && lane !== 'routes' && lane !== 'soak') {
  throw new Error(
    `Unsupported --lane=${lane}; expected synthetic, routes, or soak`,
  );
}
const routeLane = lane === 'routes' || lane === 'soak';
const dwellTarget = argv.get('dwell') ?? null;
if (
  dwellTarget !== null &&
  (lane !== 'soak' || (dwellTarget !== 'game' && dwellTarget !== 'cove'))
) {
  throw new Error(
    '--dwell is supported only for --lane=soak and must be game or cove',
  );
}
const dwellSeconds = Number(argv.get('dwell-seconds') ?? 180);
if (
  dwellTarget !== null &&
  (!Number.isFinite(dwellSeconds) || dwellSeconds < 10 || dwellSeconds > 600)
) {
  throw new Error('--dwell-seconds must be between 10 and 600');
}
const dwellMode = dwellTarget !== null;
const forceWebGL = argv.has('webgl');
const requestedUrl =
  argv.get('url') ??
  (routeLane
    ? 'http://localhost:3000/cove'
    : 'http://localhost:3000/perf/stage?stage=1&webgpu=1');
const parsedUrl = new URL(requestedUrl);
if (forceWebGL) {
  parsedUrl.searchParams.delete('webgpu');
  parsedUrl.searchParams.set('webgl', '1');
}
const url = parsedUrl.toString();
const transitionCount = routeLane
  ? Number(argv.get('loops') ?? (lane === 'soak' ? 60 : 30))
  : Math.max(100, Number(argv.get('transitions') ?? 102));
if (
  !Number.isInteger(transitionCount) ||
  transitionCount <= 0 ||
  (lane === 'soak' &&
    !dwellMode &&
    (transitionCount < 20 || transitionCount > 100))
) {
  throw new Error(
    lane === 'soak'
      ? 'The soak lane requires integer --loops between 20 and 100'
      : '--transitions must be a positive integer',
  );
}
const outputPath = resolve(
  argv.get('output') ??
    (routeLane
      ? lane === 'soak'
        ? `${SCRIPT_DIR}/world-stage-soak-summary.json`
        : `${SCRIPT_DIR}/world-stage-route-summary.json`
      : `${SCRIPT_DIR}/world-stage-probe-summary.json`),
);
const chromePath =
  argv.get('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const scenes = ['alpha', 'beta', 'cove-spike'];
const WORLD_ONLY_ASSET_PATTERN =
  /\/models\/(?:characters\/|(?:pineapple-house|chum-bucket|krusty-krab|salty-spitoon|boating-school|patty-building|building-lighthouse|arcade\/claw-arcade-exterior|cove\/cove-exterior|patricks-rock|squidward-house|coral-reef|kelp\.glb|building-shell|building-seashell|building-anchor|building-barrel|building-chest|building-lantern|crayfish|building-tower2|quest-bounty-pavilion|bazaar-merchant-stand|shisha-oasis))/i;

const summary = {
  pass: false,
  lane,
  url,
  backend: 'unknown',
  requestedTransitions: routeLane
    ? dwellMode
      ? 0
      : transitionCount * 2
    : transitionCount,
  requestedRoundTrips: routeLane ? (dwellMode ? 0 : transitionCount) : null,
  experiment: {
    mode: dwellMode ? `dwell-${dwellTarget}` : 'crossings',
    dwellSeconds: dwellMode ? dwellSeconds : null,
    sampleIntervalSeconds: dwellMode ? 10 : null,
  },
  completedRoundTrips: 0,
  completedTransitions: 0,
  warmupTransitions: 0,
  canvasMountCount: null,
  hiddenWindowsChecked: 0,
  hiddenFrameViolations: [],
  hiddenCameraViolations: [],
  hiddenStoreViolations: [],
  activeGrowthViolations: [],
  listenerBaseline: null,
  listenerEnd: null,
  listenerDelta: null,
  listenerUnderflowCount: null,
  transitionErrors: [],
  recovery: null,
  heap: {
    available: false,
    baselineBytes: null,
    endBytes: null,
    growthRatio: null,
    threshold: 0.15,
    midpointBytes: null,
    secondHalfGrowthRatio: null,
    secondHalfThreshold: 0.03,
  },
  renderer: {
    samples: [],
  },
  series: [],
  inventory: {
    early: null,
    late: null,
    diff: null,
  },
  ledger: null,
  routes: {
    cacheControl: {
      game: null,
      cove: null,
    },
    coldCoveAssetRequests: [],
    coldCoveWorldAssetRequests: [],
    pathSequence: [],
    returnLoaderViolations: [],
    historyTraversal: {
      back: false,
      forward: false,
    },
    network: {
      phase: 'cold-cove',
      joins: {
        coldCove: 0,
        firstGame: 0,
        afterFirstGame: 0,
      },
      streams: {
        coldCove: 0,
        firstGame: 0,
        afterFirstGame: 0,
      },
      events: [],
      stubUnhandled: {},
    },
    coldInit: null,
  },
  console: {
    errors: [],
    warnings: [],
  },
  assertions: {},
  failure: null,
  generatedAt: new Date().toISOString(),
};

let browser;
let worldProbeServer;

async function startWorldProbeServer() {
  const streams = new Set();
  const server = createServer((request, response) => {
    const origin = request.headers.origin ?? 'http://localhost:3000';
    const corsHeaders = {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers':
        request.headers['access-control-request-headers'] ?? 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }

    const pathname = new URL(request.url ?? '/', 'http://localhost:4000')
      .pathname;
    if (request.method === 'POST' && pathname === '/api/world/join') {
      response.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/json',
      });
      response.end(
        JSON.stringify({
          roomId: 'world-stage-probe',
          id: 'world-stage-probe-session',
          roomTicket: 'world-stage-probe-ticket',
        }),
      );
      return;
    }
    if (
      request.method === 'GET' &&
      pathname === '/api/world/world-stage-probe/stream'
    ) {
      response.writeHead(200, {
        ...corsHeaders,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      response.write('event: snapshot\ndata: {"npcs":[],"players":[]}\n\n');
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/research/stream') {
      response.writeHead(200, {
        ...corsHeaders,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      response.write(': world-stage-probe ready\n\n');
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }
    const tutorialClaim = pathname.match(
      /^\/api\/quests\/tutorial\/([^/]+)\/claim$/,
    );
    if (request.method === 'POST' && tutorialClaim) {
      response.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/json',
      });
      response.end(
        JSON.stringify({
          ok: true,
          questId: decodeURIComponent(tutorialClaim[1]),
          credited: 0,
          balance: 0,
        }),
      );
      return;
    }
    if (request.method === 'GET' && pathname === '/api/land/parcels') {
      response.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/json',
      });
      response.end('[]');
      return;
    }
    if (
      request.method === 'POST' &&
      (pathname === '/api/world/position' ||
        pathname === '/api/world/leave' ||
        pathname === '/api/world/watch-heartbeat' ||
        pathname === '/api/npc/watch')
    ) {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }
    const unhandledKey = `${request.method ?? 'UNKNOWN'} ${pathname}`;
    summary.routes.network.stubUnhandled[unhandledKey] =
      (summary.routes.network.stubUnhandled[unhandledKey] ?? 0) + 1;
    response.writeHead(404, corsHeaders);
    response.end();
  });
  await new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(4000, () => {
      server.off('error', rejectStart);
      resolveStart();
    });
  });
  return {
    async close() {
      for (const stream of streams) stream.end();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

async function snapshot(page) {
  const state = await page.evaluate(() =>
    window.__WORLD_STAGE_PROBE__.snapshot(),
  );
  for (const error of state.transitionErrors ?? []) {
    if (!summary.transitionErrors.includes(error)) {
      summary.transitionErrors.push(error);
    }
  }
  return state;
}

async function waitForSettled(page, expectedScene) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await snapshot(page);
    if (state.transitionPhase === 'error' || state.transitionError) {
      throw new Error(
        state.transitionError ??
          `transition entered error for ${expectedScene}`,
      );
    }
    if (
      state.activeScene === expectedScene &&
      state.transitionPhase === 'idle'
    ) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(
    `transition to ${expectedScene} did not settle within 30000ms`,
  );
}

function sameNumbers(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function requestAndWait(page, sceneId) {
  await page.evaluate((target) => {
    window.__WORLD_STAGE_PROBE__.request(target);
  }, sceneId);
  await waitForSettled(page, sceneId);
}

async function navigateAndWait(page, pathname, sceneId) {
  const accepted = await page.evaluate((target) => {
    const probe = window.__WORLD_STAGE_PROBE__;
    if (typeof probe?.navigate !== 'function') {
      throw new Error(
        'production stage probe bridge is missing navigate(pathname)',
      );
    }
    return probe.navigate(target);
  }, pathname);
  if (accepted !== true) {
    throw new Error(
      `production stage probe bridge declined navigation to ${pathname}`,
    );
  }
  await waitForSettled(page, sceneId);
  const state = await snapshot(page);
  if (state.pathname !== pathname) {
    throw new Error(
      `route navigation settled on ${String(state.pathname)}; expected ${pathname}`,
    );
  }
  summary.routes.pathSequence.push(pathname);
  return state;
}

async function traverseHistoryAndWait(page, direction, pathname, sceneId) {
  if (direction === 'back') {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  } else {
    await page.goForward({
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  }
  await waitForSettled(page, sceneId);
  const state = await snapshot(page);
  if (state.pathname !== pathname) {
    throw new Error(
      `history ${direction} settled on ${String(state.pathname)}; expected ${pathname}`,
    );
  }
  summary.routes.historyTraversal[direction] = true;
  summary.routes.pathSequence.push(`${direction}:${pathname}`);
  return state;
}

function recordHiddenWindow(index, sceneId, start, end) {
  summary.hiddenWindowsChecked += 1;
  if ((start.frames[sceneId] ?? 0) !== (end.frames[sceneId] ?? 0)) {
    summary.hiddenFrameViolations.push({
      index,
      sceneId,
      start: start.frames[sceneId] ?? 0,
      end: end.frames[sceneId] ?? 0,
    });
  }
  if (!sameNumbers(start.cameras[sceneId], end.cameras[sceneId])) {
    summary.hiddenCameraViolations.push({ index, sceneId });
  }
  const startSlot = start.slots[sceneId];
  const endSlot = end.slots[sceneId];
  if (
    startSlot?.status !== endSlot?.status ||
    startSlot?.generation !== endSlot?.generation ||
    startSlot?.frameInvocations !== endSlot?.frameInvocations
  ) {
    summary.hiddenStoreViolations.push({
      index,
      sceneId,
      start: startSlot,
      end: endSlot,
    });
  }
}

function cacheControlIsNonCacheable(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return (
    /(?:no-store|no-cache|private|max-age=0)/i.test(value) &&
    !/(?:^|,)\s*public(?:,|$)|s-maxage\s*=\s*[1-9]/i.test(value)
  );
}

async function collectGarbage(page) {
  let client;
  try {
    client = await page.createCDPSession();
    await client.send('HeapProfiler.collectGarbage');
  } catch {
    await page.evaluate(() => {
      if (typeof globalThis.gc === 'function') globalThis.gc();
    });
  } finally {
    await client?.detach().catch(() => {});
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
}

async function readHeapBytes(page) {
  return page.evaluate(() => {
    const memory = performance.memory;
    return memory?.usedJSHeapSize ?? null;
  });
}

function recordRendererSample(label, loop, state) {
  summary.renderer.samples.push({
    label,
    loop,
    ...(state.renderer ?? { backend: state.backend ?? 'unknown' }),
  });
}

async function readSceneInventory(page) {
  return page.evaluate(() => {
    const probe = window.__WORLD_STAGE_PROBE__;
    if (typeof probe?.sceneInventory !== 'function') {
      throw new Error('production stage probe is missing sceneInventory()');
    }
    return probe.sceneInventory();
  });
}

function diffCountRecord(early = {}, late = {}) {
  const diff = {};
  for (const key of new Set([...Object.keys(early), ...Object.keys(late)])) {
    const delta = (late[key] ?? 0) - (early[key] ?? 0);
    if (delta !== 0) diff[key] = delta;
  }
  return diff;
}

function diffSceneInventory(early, late) {
  const diff = {};
  for (const sceneId of new Set([
    ...Object.keys(early ?? {}),
    ...Object.keys(late ?? {}),
  ])) {
    const earlyScene = early?.[sceneId] ?? {};
    const lateScene = late?.[sceneId] ?? {};
    diff[sceneId] = {
      objects: (lateScene.objects ?? 0) - (earlyScene.objects ?? 0),
      meshes: (lateScene.meshes ?? 0) - (earlyScene.meshes ?? 0),
      geometryReferences:
        (lateScene.geometryReferences ?? 0) -
        (earlyScene.geometryReferences ?? 0),
      uniqueGeometries:
        (lateScene.uniqueGeometries ?? 0) - (earlyScene.uniqueGeometries ?? 0),
      meshesByNameType: diffCountRecord(
        earlyScene.meshesByNameType,
        lateScene.meshesByNameType,
      ),
      geometriesByNameType: diffCountRecord(
        earlyScene.geometriesByNameType,
        lateScene.geometriesByNameType,
      ),
    };
  }
  return diff;
}

async function recordSeriesSample(
  page,
  { kind, index, loop = null, elapsedMs, forceGc = false, state = null },
) {
  if (forceGc) await collectGarbage(page);
  const sampledState = state ?? (await snapshot(page));
  const heapBytes = await readHeapBytes(page);
  const renderer = sampledState.renderer ?? {
    backend: sampledState.backend ?? 'unknown',
  };
  const sample = {
    kind,
    index,
    loop,
    elapsedMs,
    pathname: sampledState.pathname ?? null,
    forcedGc: forceGc,
    heapBytes,
    heapMB: typeof heapBytes === 'number' ? heapBytes / (1024 * 1024) : null,
    backend: renderer.backend ?? sampledState.backend ?? 'unknown',
    textures: renderer.textures ?? null,
    geometries: renderer.geometries ?? null,
    drawCalls: renderer.drawCallsFrame ?? null,
    texturesSizeBytes: renderer.texturesSizeBytes ?? null,
    memoryTotalBytes: renderer.memoryTotalBytes ?? null,
    renderCallsLifetime: renderer.renderCallsLifetime ?? null,
  };
  summary.series.push(sample);
  return { sample, state: sampledState };
}

async function runColdInitProbe(browser, routeOrigin) {
  const coldPage = await browser.newPage();
  try {
    await coldPage.setViewport({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
    });
    const coldUrl = new URL('/cove', routeOrigin);
    coldUrl.searchParams.set('stageColdInit', '/game');
    coldUrl.searchParams.set(forceWebGL ? 'webgl' : 'webgpu', '1');
    await coldPage.goto(coldUrl.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await coldPage.waitForFunction(
      () => Boolean(window.__WORLD_STAGE_PROBE__),
      { timeout: 30_000 },
    );
    await waitForSettled(coldPage, 'world');
    const state = await snapshot(coldPage);
    return {
      accepted: state.coldInit?.accepted === true,
      midwayCount: state.coldInit?.midwayCount ?? null,
      target: state.coldInit?.target ?? null,
      pathname: state.pathname,
      landedExactlyOnce:
        state.coldInit?.accepted === true &&
        state.coldInit?.midwayCount === 1 &&
        state.pathname === '/game',
    };
  } finally {
    await coldPage.close();
  }
}

try {
  if (routeLane) {
    worldProbeServer = await startWorldProbeServer();
  }
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--enable-unsafe-webgpu',
      '--enable-webgpu',
      '--expose-gc',
      '--window-size=1280,720',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
  });
  page.on('console', (message) => {
    const text = message.text().slice(0, 1_000);
    if (message.type() === 'error') summary.console.errors.push(text);
    if (message.type() === 'warn') summary.console.warnings.push(text);
  });
  page.on('pageerror', (error) => {
    summary.console.errors.push(String(error).slice(0, 1_000));
  });

  let collectingColdCoveAssets = routeLane;
  page.on('request', (request) => {
    const requestUrl = request.url();
    let pathname;
    try {
      pathname = new URL(requestUrl).pathname;
    } catch {
      return;
    }

    if (routeLane) {
      const phase = summary.routes.network.phase;
      const phaseKey =
        phase === 'cold-cove'
          ? 'coldCove'
          : phase === 'first-game'
            ? 'firstGame'
            : 'afterFirstGame';
      const method = request.method();
      let type = null;
      if (method === 'POST' && pathname === '/api/world/join') {
        summary.routes.network.joins[phaseKey] += 1;
        type = 'join';
      } else if (
        method === 'GET' &&
        /^\/api\/world\/[^/]+\/stream$/.test(pathname)
      ) {
        summary.routes.network.streams[phaseKey] += 1;
        type = 'stream';
      }
      if (type) {
        summary.routes.network.events.push({
          type,
          phase,
          method,
          url: requestUrl,
        });
      }
    }

    if (
      collectingColdCoveAssets &&
      /\.(?:glb|gltf|ktx2|vrm)$/i.test(pathname)
    ) {
      summary.routes.coldCoveAssetRequests.push(requestUrl);
      if (WORLD_ONLY_ASSET_PATTERN.test(pathname)) {
        summary.routes.coldCoveWorldAssetRequests.push(requestUrl);
      }
    }
  });

  if (routeLane) {
    const routeOrigin = new URL(url).origin;
    for (const [routeName, pathname] of [
      ['cove', '/cove'],
      ['game', '/game'],
    ]) {
      const response = await fetch(`${routeOrigin}${pathname}`, {
        redirect: 'manual',
      });
      summary.routes.cacheControl[routeName] = {
        status: response.status,
        value: response.headers.get('cache-control'),
      };
    }

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForFunction(() => Boolean(window.__WORLD_STAGE_PROBE__), {
      timeout: 30_000,
    });
    await waitForSettled(page, 'cove');
    const coldCove = await snapshot(page);
    if (coldCove.pathname !== '/cove') {
      throw new Error(
        `cold Cove stage settled on ${String(coldCove.pathname)} instead of /cove`,
      );
    }
    summary.routes.pathSequence.push('/cove');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    collectingColdCoveAssets = false;

    // Warm both real slots before measuring retention. The first /game visit
    // is intentionally excluded because its SeaLoadingScreen is still the
    // required first-world-boot path.
    summary.routes.network.phase = 'first-game';
    await navigateAndWait(page, '/game', 'world');
    summary.warmupTransitions += 1;
    summary.routes.network.phase = 'after-first-game';
    await navigateAndWait(page, '/cove', 'cove');
    summary.warmupTransitions += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));

    if (dwellTarget === 'game') {
      await navigateAndWait(page, '/game', 'world');
      summary.warmupTransitions += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    }

    const experimentStartedAt = Date.now();
    const baseline = await recordSeriesSample(page, {
      kind: 'baseline',
      index: 0,
      loop: 0,
      elapsedMs: 0,
      forceGc: true,
    });
    const warmSnapshot = baseline.state;
    summary.backend = warmSnapshot.backend;
    recordRendererSample('post-warmup', 0, warmSnapshot);
    summary.listenerBaseline = warmSnapshot.listenerCount;
    const baselineHeap = baseline.sample.heapBytes;
    if (typeof baselineHeap === 'number' && baselineHeap > 0) {
      summary.heap.available = true;
      summary.heap.baselineBytes = baselineHeap;
    }
    summary.inventory.early = await readSceneInventory(page);

    if (dwellMode) {
      const dwellStartedAt = Date.now();
      const dwellEndsAt = dwellStartedAt + dwellSeconds * 1_000;
      const dwellSampleCount = Math.ceil(dwellSeconds / 10);
      const midpointSample = Math.ceil(dwellSampleCount / 2);
      for (
        let sampleIndex = 1;
        sampleIndex <= dwellSampleCount;
        sampleIndex += 1
      ) {
        const sampleAt = Math.min(
          dwellStartedAt + sampleIndex * 10_000,
          dwellEndsAt,
        );
        const delayMs = Math.max(0, sampleAt - Date.now());
        if (delayMs > 0) {
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, delayMs),
          );
        }
        const forceGc =
          sampleIndex % 5 === 0 ||
          sampleIndex === midpointSample ||
          sampleIndex === dwellSampleCount;
        const dwellSample = await recordSeriesSample(page, {
          kind: 'dwell',
          index: sampleIndex,
          elapsedMs: Date.now() - experimentStartedAt,
          forceGc,
        });
        if (sampleIndex === midpointSample) {
          summary.heap.midpointBytes = dwellSample.sample.heapBytes;
        }
      }
    } else {
      const hiddenStarts = new Map([['world', warmSnapshot]]);
      let transitionIndex = 0;
      const midpointLoop = Math.floor(transitionCount / 2);
      for (let roundTrip = 0; roundTrip < transitionCount; roundTrip += 1) {
        const beforeWorld = await snapshot(page);
        const hiddenWorldStart = hiddenStarts.get('world');
        if (hiddenWorldStart) {
          recordHiddenWindow(
            transitionIndex,
            'world',
            hiddenWorldStart,
            beforeWorld,
          );
        }
        const worldFramesBefore = beforeWorld.frames.world ?? 0;
        const exerciseHistory = roundTrip === transitionCount - 1;
        const afterWorld = exerciseHistory
          ? await traverseHistoryAndWait(page, 'back', '/game', 'world')
          : await navigateAndWait(page, '/game', 'world');
        summary.completedTransitions += 1;
        transitionIndex += 1;
        if ((afterWorld.frames.world ?? 0) <= worldFramesBefore) {
          summary.activeGrowthViolations.push({
            index: transitionIndex,
            sceneId: 'world',
            before: worldFramesBefore,
            after: afterWorld.frames.world ?? 0,
          });
        }
        const loaderPresent = await page.evaluate(() =>
          Boolean(document.querySelector('[aria-label="Loading ClawVille"]')),
        );
        if (loaderPresent) {
          summary.routes.returnLoaderViolations.push({
            roundTrip,
            pathname: '/game',
          });
        }
        hiddenStarts.set('cove', afterWorld);
        hiddenStarts.delete('world');

        const beforeCove = await snapshot(page);
        const hiddenCoveStart = hiddenStarts.get('cove');
        if (hiddenCoveStart) {
          recordHiddenWindow(
            transitionIndex,
            'cove',
            hiddenCoveStart,
            beforeCove,
          );
        }
        const coveFramesBefore = beforeCove.frames.cove ?? 0;
        const afterCove = exerciseHistory
          ? await traverseHistoryAndWait(page, 'forward', '/cove', 'cove')
          : await navigateAndWait(page, '/cove', 'cove');
        summary.completedTransitions += 1;
        transitionIndex += 1;
        if ((afterCove.frames.cove ?? 0) <= coveFramesBefore) {
          summary.activeGrowthViolations.push({
            index: transitionIndex,
            sceneId: 'cove',
            before: coveFramesBefore,
            after: afterCove.frames.cove ?? 0,
          });
        }
        hiddenStarts.set('world', afterCove);
        hiddenStarts.delete('cove');
        summary.completedRoundTrips += 1;

        const completedLoop = summary.completedRoundTrips;
        const forceGc =
          completedLoop % 5 === 0 || completedLoop === midpointLoop;
        const loopSample = await recordSeriesSample(page, {
          kind: 'round-trip',
          index: completedLoop,
          loop: completedLoop,
          elapsedMs: Date.now() - experimentStartedAt,
          forceGc,
          state: forceGc ? null : afterCove,
        });
        if (lane === 'soak' && completedLoop === 20) {
          recordRendererSample('loop-20', 20, loopSample.state);
        }
        if (lane === 'soak' && completedLoop === midpointLoop) {
          summary.heap.midpointBytes = loopSample.sample.heapBytes;
        }
      }
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const finalSeries = await recordSeriesSample(page, {
      kind: 'final',
      index: summary.series.length,
      loop: dwellMode ? null : transitionCount,
      elapsedMs: Date.now() - experimentStartedAt,
      forceGc: true,
    });
    const end = finalSeries.state;
    recordRendererSample('final', dwellMode ? null : transitionCount, end);
    summary.canvasMountCount = end.canvasMountCount;
    summary.listenerEnd = end.listenerCount;
    summary.listenerDelta = summary.listenerEnd - summary.listenerBaseline;
    summary.listenerUnderflowCount = end.listenerUnderflowCount;
    summary.recovery = {
      count: end.recoveryCount,
      lastReason: end.lastRecoveryReason,
    };
    summary.ledger = await page.evaluate(() =>
      typeof window.__WORLD_STAGE_LEDGER === 'function'
        ? window.__WORLD_STAGE_LEDGER()
        : null,
    );
    const endHeap = finalSeries.sample.heapBytes;
    if (
      summary.heap.available &&
      typeof endHeap === 'number' &&
      summary.heap.baselineBytes > 0
    ) {
      summary.heap.endBytes = endHeap;
      summary.heap.growthRatio =
        (endHeap - summary.heap.baselineBytes) / summary.heap.baselineBytes;
    }
    if (
      typeof summary.heap.midpointBytes === 'number' &&
      summary.heap.midpointBytes > 0 &&
      typeof endHeap === 'number'
    ) {
      summary.heap.secondHalfGrowthRatio =
        (endHeap - summary.heap.midpointBytes) / summary.heap.midpointBytes;
    }
    summary.inventory.late = await readSceneInventory(page);
    summary.inventory.diff = diffSceneInventory(
      summary.inventory.early,
      summary.inventory.late,
    );

    summary.routes.coldInit = await runColdInitProbe(browser, routeOrigin);

    const expectedRouteTransitions = dwellMode ? 0 : transitionCount * 2;
    const loop20Renderer = summary.renderer.samples.find(
      (sample) => sample.label === 'loop-20',
    );
    const finalRenderer = summary.renderer.samples.find(
      (sample) => sample.label === 'final',
    );
    const soakCountsPlateau =
      lane !== 'soak' ||
      dwellMode ||
      (typeof loop20Renderer?.textures === 'number' &&
        loop20Renderer.textures === finalRenderer?.textures &&
        typeof loop20Renderer?.geometries === 'number' &&
        loop20Renderer.geometries === finalRenderer?.geometries);
    const soakBytesPlateau =
      lane !== 'soak' ||
      dwellMode ||
      finalRenderer?.backend === 'webgl' ||
      (typeof loop20Renderer?.texturesSizeBytes === 'number' &&
        loop20Renderer.texturesSizeBytes === finalRenderer?.texturesSizeBytes &&
        typeof loop20Renderer?.memoryTotalBytes === 'number' &&
        loop20Renderer.memoryTotalBytes === finalRenderer?.memoryTotalBytes);
    const commonAssertions = {
      oneCanvas: summary.canvasMountCount === 1,
      listenerDeltaZero: summary.listenerDelta === 0,
      listenerAccountingNeverUnderflowed: summary.listenerUnderflowCount === 0,
      zeroTransitionErrors: summary.transitionErrors.length === 0,
      zeroRecoveries: summary.recovery?.count === 0,
      coldCoveSkipsWorldAssets:
        summary.routes.coldCoveWorldAssetRequests.length === 0,
      coldCoveJoinsZero: summary.routes.network.joins.coldCove === 0,
      firstGameJoinsOnce: summary.routes.network.joins.firstGame === 1,
      joinsAfterFirstGameZero:
        summary.routes.network.joins.afterFirstGame === 0,
      oneInitialWorldStream:
        summary.routes.network.streams.coldCove === 0 &&
        summary.routes.network.streams.firstGame === 1,
      noRouteCorrelatedStreamReopens:
        summary.routes.network.streams.afterFirstGame === 0,
      coldInitBridgeLandsExactlyOnce:
        summary.routes.coldInit?.landedExactlyOnce === true,
      gameCacheControlNonCacheable:
        summary.routes.cacheControl.game?.status === 200 &&
        cacheControlIsNonCacheable(summary.routes.cacheControl.game?.value),
      coveCacheControlNonCacheable:
        summary.routes.cacheControl.cove?.status === 200 &&
        cacheControlIsNonCacheable(summary.routes.cacheControl.cove?.value),
      bothSlotInventoriesCaptured:
        Boolean(summary.inventory.early?.world) &&
        Boolean(summary.inventory.early?.cove) &&
        Boolean(summary.inventory.late?.world) &&
        Boolean(summary.inventory.late?.cove),
    };
    summary.assertions = dwellMode
      ? {
          ...commonAssertions,
          dwellStayedOnTarget: end.pathname === `/${dwellTarget}`,
          dwellSamplesComplete:
            summary.series.filter((sample) => sample.kind === 'dwell')
              .length === Math.ceil(dwellSeconds / 10),
        }
      : {
          ...commonAssertions,
          exactlyRequestedRoundTrips:
            summary.completedRoundTrips === transitionCount &&
            summary.completedTransitions === expectedRouteTransitions,
          hiddenFramesFrozen:
            summary.hiddenFrameViolations.length === 0 &&
            summary.hiddenWindowsChecked >= expectedRouteTransitions,
          hiddenCamerasFrozen: summary.hiddenCameraViolations.length === 0,
          hiddenStoresFrozen: summary.hiddenStoreViolations.length === 0,
          activeCallbacksAdvance: summary.activeGrowthViolations.length === 0,
          returnsSkipSeaLoadingScreen:
            summary.routes.returnLoaderViolations.length === 0,
          browserHistoryUsesStage:
            summary.routes.historyTraversal.back &&
            summary.routes.historyTraversal.forward,
          heapBelow15Percent:
            !summary.heap.available ||
            (summary.heap.growthRatio !== null &&
              summary.heap.growthRatio < summary.heap.threshold),
          soakRendererCountsPlateau: soakCountsPlateau,
          soakRendererBytesPlateau: soakBytesPlateau,
          soakSecondHalfHeapBelow3Percent:
            lane !== 'soak' ||
            !summary.heap.available ||
            (summary.heap.secondHalfGrowthRatio !== null &&
              summary.heap.secondHalfGrowthRatio <=
                summary.heap.secondHalfThreshold),
        };
    summary.pass = Object.values(summary.assertions).every(Boolean);
  } else {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForFunction(() => Boolean(window.__WORLD_STAGE_PROBE__), {
      timeout: 30_000,
    });
    await waitForSettled(page, 'alpha');

    for (const sceneId of scenes) {
      const current = await snapshot(page);
      if (current.activeScene !== sceneId) {
        await requestAndWait(page, sceneId);
      }
      summary.warmupTransitions += 1;
    }
    await requestAndWait(page, 'alpha');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));

    const warmSnapshot = await snapshot(page);
    summary.backend = warmSnapshot.backend;
    recordRendererSample('post-warmup', 0, warmSnapshot);
    summary.listenerBaseline = warmSnapshot.listenerCount;
    await collectGarbage(page);
    const baselineHeap = await readHeapBytes(page);
    if (typeof baselineHeap === 'number' && baselineHeap > 0) {
      summary.heap.available = true;
      summary.heap.baselineBytes = baselineHeap;
    }

    const hiddenStarts = new Map();
    let prior = await snapshot(page);
    for (const sceneId of scenes) {
      if (sceneId !== prior.activeScene) {
        hiddenStarts.set(sceneId, prior);
      }
    }

    for (let index = 0; index < transitionCount; index += 1) {
      const target = scenes[(index + 1) % scenes.length];
      const before = await snapshot(page);
      const hiddenStart = hiddenStarts.get(target);
      if (hiddenStart) {
        summary.hiddenWindowsChecked += 1;
        if (
          (hiddenStart.frames[target] ?? 0) !== (before.frames[target] ?? 0)
        ) {
          summary.hiddenFrameViolations.push({
            index,
            sceneId: target,
            start: hiddenStart.frames[target] ?? 0,
            end: before.frames[target] ?? 0,
          });
        }
        if (!sameNumbers(hiddenStart.cameras[target], before.cameras[target])) {
          summary.hiddenCameraViolations.push({
            index,
            sceneId: target,
          });
        }
        const startSlot = hiddenStart.slots[target];
        const endSlot = before.slots[target];
        if (
          startSlot?.status !== endSlot?.status ||
          startSlot?.generation !== endSlot?.generation ||
          startSlot?.frameInvocations !== endSlot?.frameInvocations
        ) {
          summary.hiddenStoreViolations.push({
            index,
            sceneId: target,
            start: startSlot,
            end: endSlot,
          });
        }
      }

      const previousActive = before.activeScene;
      const targetFramesBefore = before.frames[target] ?? 0;
      await requestAndWait(page, target);
      const after = await snapshot(page);
      summary.completedTransitions += 1;
      if ((after.frames[target] ?? 0) <= targetFramesBefore) {
        summary.activeGrowthViolations.push({
          index,
          sceneId: target,
          before: targetFramesBefore,
          after: after.frames[target] ?? 0,
        });
      }
      if (previousActive && previousActive !== target) {
        hiddenStarts.set(previousActive, after);
      }
      hiddenStarts.delete(target);
      prior = after;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const end = await snapshot(page);
    recordRendererSample('final', transitionCount, end);
    summary.canvasMountCount = end.canvasMountCount;
    summary.listenerEnd = end.listenerCount;
    summary.listenerDelta = summary.listenerEnd - summary.listenerBaseline;
    summary.listenerUnderflowCount = end.listenerUnderflowCount;
    summary.recovery = {
      count: end.recoveryCount,
      lastReason: end.lastRecoveryReason,
    };
    summary.ledger = await page.evaluate(() => window.__WORLD_STAGE_LEDGER());
    await collectGarbage(page);
    const endHeap = await readHeapBytes(page);
    if (
      summary.heap.available &&
      typeof endHeap === 'number' &&
      summary.heap.baselineBytes > 0
    ) {
      summary.heap.endBytes = endHeap;
      summary.heap.growthRatio =
        (endHeap - summary.heap.baselineBytes) / summary.heap.baselineBytes;
    }

    summary.assertions = {
      atLeast100Transitions: summary.completedTransitions >= 100,
      oneCanvas: summary.canvasMountCount === 1,
      hiddenFramesFrozen:
        summary.hiddenFrameViolations.length === 0 &&
        summary.hiddenWindowsChecked >= 100,
      hiddenCamerasFrozen: summary.hiddenCameraViolations.length === 0,
      hiddenStoresFrozen: summary.hiddenStoreViolations.length === 0,
      activeCallbacksAdvance: summary.activeGrowthViolations.length === 0,
      listenerDeltaZero: summary.listenerDelta === 0,
      listenerAccountingNeverUnderflowed: summary.listenerUnderflowCount === 0,
      zeroTransitionErrors: summary.transitionErrors.length === 0,
      heapBelow15Percent:
        !summary.heap.available ||
        (summary.heap.growthRatio !== null &&
          summary.heap.growthRatio < summary.heap.threshold),
    };
    summary.pass = Object.values(summary.assertions).every(Boolean);
  }
} catch (error) {
  summary.failure =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      const closeFailure =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      summary.failure = summary.failure
        ? `${summary.failure} | browser close: ${closeFailure}`
        : `browser close: ${closeFailure}`;
      summary.pass = false;
    }
  }
  if (worldProbeServer) {
    try {
      await worldProbeServer.close();
    } catch (error) {
      const closeFailure =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      summary.failure = summary.failure
        ? `${summary.failure} | world probe server close: ${closeFailure}`
        : `world probe server close: ${closeFailure}`;
      summary.pass = false;
    }
  }
  summary.generatedAt = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}
