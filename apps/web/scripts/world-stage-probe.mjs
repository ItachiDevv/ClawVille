#!/usr/bin/env bun

import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
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
if (lane !== 'synthetic' && lane !== 'routes') {
  throw new Error(`Unsupported --lane=${lane}; expected synthetic or routes`);
}
const url =
  argv.get('url') ??
  (lane === 'routes'
    ? 'http://localhost:3000/cove'
    : 'http://localhost:3000/perf/stage?stage=1&webgpu=1');
const transitionCount =
  lane === 'routes'
    ? Number(argv.get('round-trips') ?? 30)
    : Math.max(100, Number(argv.get('transitions') ?? 102));
if (
  !Number.isInteger(transitionCount) ||
  transitionCount <= 0 ||
  (lane === 'routes' && transitionCount !== 30)
) {
  throw new Error(
    lane === 'routes'
      ? 'The real-route release lane requires exactly --round-trips=30'
      : '--transitions must be a positive integer',
  );
}
const outputPath = resolve(
  argv.get('output') ??
    (lane === 'routes'
      ? `${SCRIPT_DIR}/world-stage-route-summary.json`
      : `${SCRIPT_DIR}/world-stage-probe-summary.json`),
);
const chromePath =
  argv.get('chrome') ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const scenes = ['alpha', 'beta', 'cove-spike'];
const WORLD_ONLY_ASSET_PATTERN =
  /\/models\/(?:characters\/|(?:pineapple-house|chum-bucket|krusty-krab|salty-spitoon|boating-school|patty-building|building-lighthouse|arcade\/claw-arcade-exterior|cove\/cove-exterior|patricks-rock|squidward-house|coral-reef|kelp\.glb|building-shell|building-seashell|building-anchor|building-barrel|building-chest|building-lantern|crayfish|building-tower2|quest-bounty-pavilion|bazaar-merchant-stand|shisha-oasis))/i;

const summary = {
  pass: false,
  lane,
  url,
  backend: 'unknown',
  requestedTransitions:
    lane === 'routes' ? transitionCount * 2 : transitionCount,
  requestedRoundTrips: lane === 'routes' ? transitionCount : null,
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
    if (
      state.transitionPhase === 'error' ||
      state.transitionError
    ) {
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
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, 25),
    );
  }
  throw new Error(
    `transition to ${expectedScene} did not settle within 30000ms`,
  );
}

function sameNumbers(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return (
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}

async function requestAndWait(page, sceneId) {
  await page.evaluate((target) => {
    window.__WORLD_STAGE_PROBE__.request(target);
  }, sceneId);
  await waitForSettled(page, sceneId);
}

async function navigateAndWait(page, pathname, sceneId) {
  await page.evaluate((target) => {
    const probe = window.__WORLD_STAGE_PROBE__;
    if (typeof probe?.navigate !== 'function') {
      throw new Error(
        'production stage probe bridge is missing navigate(pathname)',
      );
    }
    probe.navigate(target);
  }, pathname);
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

async function traverseHistoryAndWait(
  page,
  direction,
  pathname,
  sceneId,
) {
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

try {
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

  let collectingColdCoveAssets = lane === 'routes';
  if (lane === 'routes') {
    page.on('request', (request) => {
      if (!collectingColdCoveAssets) return;
      const requestUrl = request.url();
      let pathname;
      try {
        pathname = new URL(requestUrl).pathname;
      } catch {
        return;
      }
      if (!/\.(?:glb|gltf|ktx2|vrm)$/i.test(pathname)) return;
      summary.routes.coldCoveAssetRequests.push(requestUrl);
      if (WORLD_ONLY_ASSET_PATTERN.test(pathname)) {
        summary.routes.coldCoveWorldAssetRequests.push(requestUrl);
      }
    });

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
    await page.waitForFunction(
      () => Boolean(window.__WORLD_STAGE_PROBE__),
      { timeout: 30_000 },
    );
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
    await navigateAndWait(page, '/game', 'world');
    summary.warmupTransitions += 1;
    await navigateAndWait(page, '/cove', 'cove');
    summary.warmupTransitions += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));

    const warmSnapshot = await snapshot(page);
    summary.backend = warmSnapshot.backend;
    summary.listenerBaseline = warmSnapshot.listenerCount;
    try {
      const client = await page.createCDPSession();
      await client.send('HeapProfiler.collectGarbage');
    } catch {
      // Browser may not expose the HeapProfiler domain.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const baselineHeap = await page.evaluate(() => {
      const memory = performance.memory;
      return memory?.usedJSHeapSize ?? null;
    });
    if (typeof baselineHeap === 'number' && baselineHeap > 0) {
      summary.heap.available = true;
      summary.heap.baselineBytes = baselineHeap;
    }

    const hiddenStarts = new Map([
      ['world', warmSnapshot],
    ]);
    let transitionIndex = 0;
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
        ? await traverseHistoryAndWait(
            page,
            'back',
            '/game',
            'world',
          )
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
        ? await traverseHistoryAndWait(
            page,
            'forward',
            '/cove',
            'cove',
          )
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
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const end = await snapshot(page);
    summary.canvasMountCount = end.canvasMountCount;
    summary.listenerEnd = end.listenerCount;
    summary.listenerDelta =
      summary.listenerEnd - summary.listenerBaseline;
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
    try {
      const client = await page.createCDPSession();
      await client.send('HeapProfiler.collectGarbage');
    } catch {
      // Preserve the ordinary performance.memory measurement.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const endHeap = await page.evaluate(() => {
      const memory = performance.memory;
      return memory?.usedJSHeapSize ?? null;
    });
    if (
      summary.heap.available &&
      typeof endHeap === 'number' &&
      summary.heap.baselineBytes > 0
    ) {
      summary.heap.endBytes = endHeap;
      summary.heap.growthRatio =
        (endHeap - summary.heap.baselineBytes) /
        summary.heap.baselineBytes;
    }

    const expectedRouteTransitions = transitionCount * 2;
    summary.assertions = {
      exactly30RoundTrips:
        summary.completedRoundTrips === 30 &&
        summary.completedTransitions === expectedRouteTransitions,
      oneCanvas: summary.canvasMountCount === 1,
      hiddenFramesFrozen:
        summary.hiddenFrameViolations.length === 0 &&
        summary.hiddenWindowsChecked >= expectedRouteTransitions,
      hiddenCamerasFrozen:
        summary.hiddenCameraViolations.length === 0,
      hiddenStoresFrozen:
        summary.hiddenStoreViolations.length === 0,
      activeCallbacksAdvance:
        summary.activeGrowthViolations.length === 0,
      listenerDeltaZero: summary.listenerDelta === 0,
      listenerAccountingNeverUnderflowed:
        summary.listenerUnderflowCount === 0,
      zeroTransitionErrors: summary.transitionErrors.length === 0,
      zeroRecoveries: summary.recovery?.count === 0,
      returnsSkipSeaLoadingScreen:
        summary.routes.returnLoaderViolations.length === 0,
      browserHistoryUsesStage:
        summary.routes.historyTraversal.back &&
        summary.routes.historyTraversal.forward,
      coldCoveSkipsWorldAssets:
        summary.routes.coldCoveWorldAssetRequests.length === 0,
      gameCacheControlNonCacheable:
        summary.routes.cacheControl.game?.status === 200 &&
        cacheControlIsNonCacheable(
          summary.routes.cacheControl.game?.value,
        ),
      coveCacheControlNonCacheable:
        summary.routes.cacheControl.cove?.status === 200 &&
        cacheControlIsNonCacheable(
          summary.routes.cacheControl.cove?.value,
        ),
      heapBelow15Percent:
        !summary.heap.available ||
        (summary.heap.growthRatio !== null &&
          summary.heap.growthRatio < summary.heap.threshold),
    };
    summary.pass = Object.values(summary.assertions).every(Boolean);
  } else {
    await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => Boolean(window.__WORLD_STAGE_PROBE__),
    { timeout: 30_000 },
  );
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
  summary.listenerBaseline = warmSnapshot.listenerCount;
  try {
    const client = await page.createCDPSession();
    await client.send('HeapProfiler.collectGarbage');
  } catch {
    // Browser may not expose the HeapProfiler domain.
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const baselineHeap = await page.evaluate(() => {
    const memory = performance.memory;
    return memory?.usedJSHeapSize ?? null;
  });
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
        (hiddenStart.frames[target] ?? 0) !==
        (before.frames[target] ?? 0)
      ) {
        summary.hiddenFrameViolations.push({
          index,
          sceneId: target,
          start: hiddenStart.frames[target] ?? 0,
          end: before.frames[target] ?? 0,
        });
      }
      if (
        !sameNumbers(
          hiddenStart.cameras[target],
          before.cameras[target],
        )
      ) {
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
        startSlot?.frameInvocations !==
          endSlot?.frameInvocations
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
  summary.canvasMountCount = end.canvasMountCount;
  summary.listenerEnd = end.listenerCount;
  summary.listenerDelta =
    summary.listenerEnd - summary.listenerBaseline;
  summary.listenerUnderflowCount = end.listenerUnderflowCount;
  summary.recovery = {
    count: end.recoveryCount,
    lastReason: end.lastRecoveryReason,
  };
  summary.ledger = await page.evaluate(() =>
    window.__WORLD_STAGE_LEDGER(),
  );
  try {
    const client = await page.createCDPSession();
    await client.send('HeapProfiler.collectGarbage');
  } catch {
    // Preserve the ordinary performance.memory measurement.
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const endHeap = await page.evaluate(() => {
    const memory = performance.memory;
    return memory?.usedJSHeapSize ?? null;
  });
  if (
    summary.heap.available &&
    typeof endHeap === 'number' &&
    summary.heap.baselineBytes > 0
  ) {
    summary.heap.endBytes = endHeap;
    summary.heap.growthRatio =
      (endHeap - summary.heap.baselineBytes) /
      summary.heap.baselineBytes;
  }

  summary.assertions = {
    atLeast100Transitions: summary.completedTransitions >= 100,
    oneCanvas: summary.canvasMountCount === 1,
    hiddenFramesFrozen:
      summary.hiddenFrameViolations.length === 0 &&
      summary.hiddenWindowsChecked >= 100,
    hiddenCamerasFrozen:
      summary.hiddenCameraViolations.length === 0,
    hiddenStoresFrozen:
      summary.hiddenStoreViolations.length === 0,
    activeCallbacksAdvance:
      summary.activeGrowthViolations.length === 0,
    listenerDeltaZero: summary.listenerDelta === 0,
    listenerAccountingNeverUnderflowed:
      summary.listenerUnderflowCount === 0,
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
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
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
  summary.generatedAt = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}
