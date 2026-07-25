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
const url =
  argv.get('url') ??
  'http://localhost:3000/perf/stage?stage=1&webgpu=1';
const transitionCount = Math.max(
  100,
  Number(argv.get('transitions') ?? 102),
);
const outputPath = resolve(
  argv.get('output') ??
    `${SCRIPT_DIR}/world-stage-probe-summary.json`,
);
const chromePath =
  argv.get('chrome') ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const scenes = ['alpha', 'beta', 'cove-spike'];

const summary = {
  pass: false,
  url,
  backend: 'unknown',
  requestedTransitions: transitionCount,
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
