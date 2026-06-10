#!/usr/bin/env bun
/**
 * Browser-side performance verification for the fidelity spike.
 *
 * Launches an isolated Chrome instance, opens /game, waits for the Three scene,
 * samples frame timing, captures resource/long-task data, and writes a JSON
 * report + screenshot + Markdown summary. Works against staging or any URL.
 *
 * Modes
 * -----
 * (default / load-phase)
 *   Navigate → wait for canvas → wait durationMs → snapshot and report.
 *   Measures load-phase long tasks, resource timing, and VRM load metrics.
 *   outDir prefix: browser-<label>
 *
 * --steady
 *   Navigate → wait for __W3D_READY && __W3D_TEXTURES_READY (up to
 *   --ready-timeout-s=120s, default 120) → settle 5 s → reset VRM frame
 *   metrics → inject pre-allocated RAF sampler → sample --sample-seconds
 *   (default 30) → report steady-state fps/frame-time/VRM-cost/gl-info.
 *   The RAF sampler writes into a pre-allocated Float64Array (no per-frame
 *   array growth). gl.info is sampled once/s (multi-frame average/min/max).
 *   outDir prefix: steady-<label>
 */

import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface Args {
  url: string;
  label: string;
  outDir: string;
  durationMs: number;
  width: number;
  height: number;
  chromePath: string;
  steady: boolean;
  readyTimeoutS: number;
  sampleSeconds: number;
}

const REPO_ROOT = process.cwd();

function parseArgs(): Args {
  const args = new Map<string, string>();
  for (const raw of Bun.argv.slice(2)) {
    const [k, ...rest] = raw.replace(/^--/, '').split('=');
    args.set(k!, rest.join('=') || '1');
  }
  const steady = args.get('steady') === '1' || args.has('steady');
  const label = args.get('label') ?? new Date().toISOString().replace(/[:.]/g, '-');
  const defaultPrefix = steady ? `steady-${label}` : `browser-${label}`;
  return {
    url: args.get('url') ?? 'https://staging.clawville.world/game?perf=1',
    label,
    outDir: path.resolve(args.get('out') ?? `docs/perf-fidelity-spike/${defaultPrefix}`),
    durationMs: Number(args.get('durationMs') ?? '30000'),
    width: Number(args.get('width') ?? '1920'),
    height: Number(args.get('height') ?? '1080'),
    chromePath: args.get('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    steady,
    readyTimeoutS: Number(args.get('ready-timeout-s') ?? '120'),
    sampleSeconds: Number(args.get('sample-seconds') ?? '30'),
  };
}

function formatMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return `${Math.round(n)}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Read git SHA + dirty flag. Returns 'unknown' on error (no git, bare repo, etc.). */
function readGitState(): { sha: string; dirty: boolean } {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: false };
  }
}

/**
 * Percentile of a sorted Float64Array slice [0, length).
 * p is 0–100. Returns 0 for empty arrays.
 */
function pct(sorted: Float64Array, length: number, p: number): number {
  if (length === 0) return 0;
  const idx = Math.min(length - 1, Math.floor((p / 100) * length));
  return sorted[idx]!;
}

async function main() {
  const cfg = parseArgs();
  const git = readGitState();
  await fs.mkdir(cfg.outDir, { recursive: true });
  const profileDir = path.join(cfg.outDir, '.chrome-profile');

  const browser = await puppeteer.launch({
    executablePath: cfg.chromePath,
    headless: true,
    userDataDir: profileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--enable-unsafe-webgpu',
      '--enable-webgpu',
      `--window-size=${cfg.width},${cfg.height}`,
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1 });

  const consoleMessages: Array<{ type: string; text: string }> = [];
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 1000) }));
  page.on('pageerror', (err) => consoleMessages.push({ type: 'pageerror', text: String(err).slice(0, 1000) }));

  await page.evaluateOnNewDocument(() => {
    // Enable VRM load metrics collection. This flag is read at vrm-loader.ts
    // module-init time (before any parse runs) via the IIFE that sets
    // VRM_METRICS_ENABLED. evaluateOnNewDocument runs BEFORE page scripts so
    // the flag is visible when the module initialises.
    (window as any).__CV_PERF_HARNESS__ = true;

    const data = {
      longTasks: [] as Array<{ startTime: number; duration: number; name: string }>,
      paints: [] as Array<{ name: string; startTime: number }>,
      lcp: null as null | { startTime: number; size: number },
      errors: [] as string[],
    };
    (window as any).__FIDELITY_PROFILE__ = data;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          data.longTasks.push({
            startTime: Math.round(e.startTime),
            duration: Math.round(e.duration),
            name: e.name,
          });
        }
      }).observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
    } catch (err) {
      data.errors.push(`longtask: ${String(err)}`);
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          data.paints.push({ name: e.name, startTime: Math.round(e.startTime) });
        }
      }).observe({ type: 'paint', buffered: true } as PerformanceObserverInit);
    } catch (err) {
      data.errors.push(`paint: ${String(err)}`);
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEntryList & Array<any>) {
          data.lcp = { startTime: Math.round(e.startTime), size: e.size ?? 0 };
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true } as PerformanceObserverInit);
    } catch (err) {
      data.errors.push(`lcp: ${String(err)}`);
    }
  });

  const startedAt = Date.now();
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // -------------------------------------------------------------------------
  // STEADY-STATE MODE
  // -------------------------------------------------------------------------
  if (cfg.steady) {
    // Step 1: wait for __W3D_READY && __W3D_TEXTURES_READY.
    const readyTimeoutMs = cfg.readyTimeoutS * 1000;
    const readyStart = Date.now();
    let timedOut = false;

    try {
      await page.waitForFunction(
        () => Boolean((window as any).__W3D_READY) && Boolean((window as any).__W3D_TEXTURES_READY),
        { timeout: readyTimeoutMs },
      );
    } catch {
      timedOut = true;
    }

    const timeToReadyMs = Date.now() - readyStart;

    if (timedOut) {
      // Write partial report and exit cleanly — do not throw.
      const screenshotPath = path.join(cfg.outDir, 'game.png');
      const jsonPath = path.join(cfg.outDir, 'metrics.json');
      const mdPath = path.join(cfg.outDir, 'summary.md');
      await page.screenshot({ path: screenshotPath, fullPage: false });
      const report = {
        generatedAt: new Date().toISOString(),
        wallMs: Date.now() - startedAt,
        config: cfg,
        git,
        steadyState: null,
        steadyStateNote: `Timed out after ${timeToReadyMs}ms waiting for __W3D_READY && __W3D_TEXTURES_READY`,
      };
      await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
      await fs.writeFile(
        mdPath,
        `# Steady-State Run: ${cfg.label}\n\n` +
        `Generated: ${new Date().toISOString()}\n\n` +
        `Git: \`${git.sha}\`${git.dirty ? ' (dirty)' : ''}\n\n` +
        `**TIMEOUT**: Scene did not reach ready state within ${cfg.readyTimeoutS}s.\n\n` +
        `timeToReadyMs: ${timeToReadyMs}ms\n\n` +
        `Screenshot: \`game.png\`\n`,
      );
      await browser.close();
      await fs.rm(profileDir, { recursive: true, force: true });
      console.log(JSON.stringify({ label: cfg.label, outDir: path.relative(REPO_ROOT, cfg.outDir).replace(/\\/g, '/'), steadyState: null, note: 'timed out' }, null, 2));
      return;
    }

    // Step 2: settle 5s.
    await new Promise((r) => setTimeout(r, 5000));

    // Step 3: reset VRM frame metrics accumulator.
    await page.evaluate(() => {
      const m = (window as any).__CV_VRM_FRAME_METRICS;
      if (m && typeof m.reset === 'function') m.reset();
    });

    // Step 4+5: inject pre-allocated RAF sampler and wait sampleSeconds.
    // The sampler writes frame deltas into a pre-allocated Float64Array.
    // NO per-frame array.push calls — just index-based writes.
    // We also sample gl.info once per second into a separate array.
    const sampleSeconds = cfg.sampleSeconds;
    const maxSamples = sampleSeconds * 150; // 150 = generous over 60fps ceiling

    const steadyResult = await page.evaluate(
      ({ sampleSec, maxSamples: maxS }: { sampleSec: number; maxSamples: number }) => {
        return new Promise<{
          frameDeltasMs: number[];
          glSnapshots: Array<{ calls: number; triangles: number; programs: number }>;
          sampleDurationMs: number;
        }>((resolve) => {
          // Pre-allocate fixed-size Float64Array — no growth during sampling.
          const deltas = new Float64Array(maxS);
          let deltaCount = 0;
          const glSnaps: Array<{ calls: number; triangles: number; programs: number }> = [];
          let lastFrameTs = -1;
          let lastGlSampleTs = -1;
          const endAt = performance.now() + sampleSec * 1000;
          const samplerStart = performance.now();

          function sampleGl() {
            const glInfo = (window as any).__CV_GL_INFO?.();
            if (glInfo) {
              glSnaps.push({ calls: glInfo.calls, triangles: glInfo.triangles, programs: glInfo.programs });
            } else {
              // Fall back to __W3D state.gl.info if __CV_GL_INFO not available.
              // Use drawCalls (per-frame on WebGPU) with fallback to calls (per-frame on WebGL).
              const state = (window as any).__W3D;
              if (state?.gl?.info) {
                const info = state.gl.info;
                glSnaps.push({
                  calls: (info.render?.drawCalls ?? info.render?.calls) ?? 0,
                  triangles: info.render?.triangles ?? 0,
                  programs: info.programs?.length ?? 0,
                });
              }
            }
          }

          function rafTick(now: number) {
            if (now >= endAt) {
              resolve({
                frameDeltasMs: Array.from(deltas.subarray(0, deltaCount)),
                glSnapshots: glSnaps,
                sampleDurationMs: performance.now() - samplerStart,
              });
              return;
            }

            // Record frame delta — no allocation.
            if (lastFrameTs >= 0 && deltaCount < maxS) {
              deltas[deltaCount++] = now - lastFrameTs;
            }
            lastFrameTs = now;

            // Sample gl.info once per second.
            if (lastGlSampleTs < 0 || now - lastGlSampleTs >= 1000) {
              sampleGl();
              lastGlSampleTs = now;
            }

            requestAnimationFrame(rafTick);
          }

          requestAnimationFrame(rafTick);
        });
      },
      { sampleSec: sampleSeconds, maxSamples },
    );

    // Step 6: read VRM frame metrics.
    const vrmFrameMetrics = await page.evaluate(() => {
      const m = (window as any).__CV_VRM_FRAME_METRICS;
      if (!m || typeof m.read !== 'function') return null;
      return m.read() as {
        mixerAvgMs: number; springAvgMs: number; fullAvgMs: number;
        mixerCalls: number; springCalls: number; fullCalls: number; epoch: number;
      };
    });

    // Compute FPS / frame-time stats. Sort a copy AFTER sampling ends.
    const deltas = steadyResult.frameDeltasMs;
    const frameCount = deltas.length;
    const sorted = new Float64Array(deltas).sort();
    const fpsAvg  = frameCount > 0 ? frameCount / (steadyResult.sampleDurationMs / 1000) : 0;
    const ftAvg   = frameCount > 0 ? deltas.reduce((s, d) => s + d, 0) / frameCount : 0;
    const ftP95   = pct(sorted, frameCount, 95);
    const ftP99   = pct(sorted, frameCount, 99);
    // p10 and p1 of FPS — derived from frame-time (lower frame-time = higher FPS).
    // We want the WORST (slowest) FPS bucket = highest frame-time percentile.
    const ftP90   = pct(sorted, frameCount, 90);  // p10 fps ↔ p90 frame-time
    const ftP99ft = pct(sorted, frameCount, 99);  // already computed above
    const fpsP10  = ftP90   > 0 ? 1000 / ftP90   : 0;
    const fpsP1   = ftP99ft > 0 ? 1000 / ftP99ft : 0;
    const droppedFrames = deltas.filter((d) => d > 33.33).length;

    // gl.info multi-frame stats.
    const glSnaps = steadyResult.glSnapshots;
    let glCallsMin = Infinity, glCallsMax = -Infinity, glCallsSum = 0;
    let glTriMin = Infinity, glTriMax = -Infinity, glTriSum = 0;
    for (const s of glSnaps) {
      glCallsMin = Math.min(glCallsMin, s.calls);
      glCallsMax = Math.max(glCallsMax, s.calls);
      glCallsSum += s.calls;
      glTriMin = Math.min(glTriMin, s.triangles);
      glTriMax = Math.max(glTriMax, s.triangles);
      glTriSum += s.triangles;
    }
    const glN = glSnaps.length;
    const glInfo = glN > 0 ? {
      callsMin:  glCallsMin,
      callsAvg:  Math.round(glCallsSum / glN),
      callsMax:  glCallsMax,
      triMin:    glTriMin,
      triAvg:    Math.round(glTriSum / glN),
      triMax:    glTriMax,
      snapshots: glN,
    } : null;

    // Per-frame VRM costs (spec step 6).
    // vrmFrameMetrics.mixerAvgMs etc. are per-CALL averages (total/calls).
    // updateMixerOnly runs once per near-NPC per frame (~13 VRMs in a full
    // world), so per-call cost understates the frame budget by ~calls/frameCount.
    // Multiply back: msPerFrame = avgMs * calls / frameCount.
    // Both the per-call and per-frame rows are kept in the report — per-call is
    // useful for per-VRM regression, per-frame is needed for frame-budget accounting.
    const vrmPerFrame = vrmFrameMetrics && frameCount > 0 ? {
      mixerMsPerFrame:      Math.round((vrmFrameMetrics.mixerAvgMs  * vrmFrameMetrics.mixerCalls  / frameCount) * 1000) / 1000,
      springMsPerFrame:     Math.round((vrmFrameMetrics.springAvgMs * vrmFrameMetrics.springCalls / frameCount) * 1000) / 1000,
      fullUpdateMsPerFrame: Math.round((vrmFrameMetrics.fullAvgMs   * vrmFrameMetrics.fullCalls   / frameCount) * 1000) / 1000,
    } : null;

    // Collect any remaining page state for the report.
    const pageState = await page.evaluate(() => {
      const state = (window as any).__W3D;
      return {
        ready: Boolean((window as any).__W3D_READY),
        texturesReady: Boolean((window as any).__W3D_TEXTURES_READY),
        qualityTier: (window as any).__W3D_QUALITY_TIER ?? null,
        dpr: state?.gl?.getPixelRatio?.() ?? null,
        vrmLoadMetrics: (window as any).__CV_VRM_LOAD_METRICS ?? [],
      };
    });

    const steadyState = {
      timeToReadyMs,
      settleMs: 5000,
      sampleSeconds,
      frameCount,
      fpsAvg:  Math.round(fpsAvg  * 10) / 10,
      fpsP10:  Math.round(fpsP10  * 10) / 10,
      fpsP1:   Math.round(fpsP1   * 10) / 10,
      ftAvgMs: Math.round(ftAvg   * 100) / 100,
      ftP95Ms: Math.round(ftP95   * 100) / 100,
      ftP99Ms: Math.round(ftP99   * 100) / 100,
      droppedFrames,
      vrmFrameMetrics,
      vrmPerFrame,
      glInfo,
      ready: pageState.ready,
      texturesReady: pageState.texturesReady,
      qualityTier: pageState.qualityTier,
      dpr: pageState.dpr,
    };

    const screenshotPath = path.join(cfg.outDir, 'game.png');
    const jsonPath = path.join(cfg.outDir, 'metrics.json');
    const mdPath = path.join(cfg.outDir, 'summary.md');
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const fullReport = {
      generatedAt: new Date().toISOString(),
      wallMs: Date.now() - startedAt,
      config: cfg,
      git,
      consoleMessages,
      steadyState,
      vrmLoadMetrics: pageState.vrmLoadMetrics,
    };
    await fs.writeFile(jsonPath, JSON.stringify(fullReport, null, 2));

    const vfm = steadyState.vrmFrameMetrics;
    const vfp = steadyState.vrmPerFrame;
    const gi  = steadyState.glInfo;
    const md = `# Steady-State Performance Run: ${cfg.label}

Generated: ${new Date().toISOString()}
Git: \`${git.sha}\`${git.dirty ? ' (dirty)' : ''}

- URL: ${cfg.url}
- Ready: ${steadyState.ready ? 'yes' : 'no'}; textures ready: ${steadyState.texturesReady ? 'yes' : 'no'}
- Time to ready: ${formatMs(steadyState.timeToReadyMs)}
- Quality tier: ${steadyState.qualityTier ?? '-'}
- DPR: ${steadyState.dpr ?? '-'}
- Sample window: ${steadyState.sampleSeconds}s (${steadyState.frameCount} frames)
- Screenshot: \`game.png\`

## RAF FPS

| Metric | Value |
|---|---:|
| avg FPS | ${steadyState.fpsAvg} |
| p10 FPS | ${steadyState.fpsP10} |
| p1 FPS | ${steadyState.fpsP1} |
| avg frame time | ${steadyState.ftAvgMs}ms |
| p95 frame time | ${steadyState.ftP95Ms}ms |
| p99 frame time | ${steadyState.ftP99Ms}ms |
| dropped frames (>33ms) | ${steadyState.droppedFrames} |

## VRM Frame Cost (from \`__CV_VRM_FRAME_METRICS\`)

Per-call columns measure cost per individual VRM update invocation (useful for per-VRM regression).
Per-frame columns multiply call count back by frame count and reflect actual frame-budget impact
(e.g. mixer runs once per near-NPC per frame, so per-call cost understates total by ~nearVrmCount).

${vfm ? `| Metric | per-call avg | per-frame total |
|---|---:|---:|
| mixer ms | ${(vfm.mixerAvgMs).toFixed(3)}ms | ${vfp ? vfp.mixerMsPerFrame.toFixed(3) + 'ms' : '-'} |
| spring ms | ${(vfm.springAvgMs).toFixed(3)}ms | ${vfp ? vfp.springMsPerFrame.toFixed(3) + 'ms' : '-'} |
| full update ms | ${(vfm.fullAvgMs).toFixed(3)}ms | ${vfp ? vfp.fullUpdateMsPerFrame.toFixed(3) + 'ms' : '-'} |
| mixer calls | ${vfm.mixerCalls} | — |
| spring calls | ${vfm.springCalls} | — |
| full update calls | ${vfm.fullCalls} | — |
| frame epoch | ${vfm.epoch} | — |` : '_VRM frame metrics not captured (VRM_METRICS_ENABLED=false or no VRMs updated during window)_'}

## Renderer Info (gl.info multi-frame, ${gi?.snapshots ?? 0} snapshots)

${gi ? `| Metric | min | avg | max |
|---|---:|---:|---:|
| draw calls | ${gi.callsMin} | ${gi.callsAvg} | ${gi.callsMax} |
| triangles | ${gi.triMin.toLocaleString()} | ${gi.triAvg.toLocaleString()} | ${gi.triMax.toLocaleString()} |` : '_gl.info not captured (__CV_GL_INFO not available — ensure VRM_METRICS_ENABLED and World3DCanvas.tsx patch applied)_'}

## Acceptance Gates

- Ready: ${steadyState.ready ? 'PASS' : 'FAIL'}
- Textures ready: ${steadyState.texturesReady ? 'PASS' : 'FAIL'}
- avg FPS ≥ 60: ${steadyState.fpsAvg >= 60 ? 'PASS' : `FAIL (${steadyState.fpsAvg})`}
- p1 FPS ≥ 30: ${steadyState.fpsP1 >= 30 ? 'PASS' : `FAIL (${steadyState.fpsP1})`}
`;

    await fs.writeFile(mdPath, md);
    await browser.close();
    await fs.rm(profileDir, { recursive: true, force: true });

    console.log(JSON.stringify({
      label: cfg.label,
      mode: 'steady',
      outDir: path.relative(REPO_ROOT, cfg.outDir).replace(/\\/g, '/'),
      screenshot: path.relative(REPO_ROOT, screenshotPath).replace(/\\/g, '/'),
      json: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/'),
      markdown: path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/'),
      git,
      summary: steadyState,
    }, null, 2));
    return;
  }

  // -------------------------------------------------------------------------
  // LOAD-PHASE MODE (original behaviour, unchanged)
  // -------------------------------------------------------------------------
  await page.waitForFunction(() => Boolean((window as any).__W3D || document.querySelector('canvas')), { timeout: 60_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, cfg.durationMs));

  const report = await page.evaluate(() => {
    const profile = (window as any).__FIDELITY_PROFILE__ ?? { longTasks: [], paints: [], lcp: null, errors: ['missing profile'] };
    const state = (window as any).__W3D;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];

    const buttons = [...document.querySelectorAll('button')].map((b) => {
      const rect = b.getBoundingClientRect();
      const style = getComputedStyle(b);
      return {
        text: (b.innerText || b.getAttribute('aria-label') || b.title || '').trim(),
        aria: b.getAttribute('aria-label'),
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    }).filter((b) => b.visible);

    const chunks: Record<string, number> = {};
    const primitiveBuildingMeshes: Array<{ name: string; geometry: string; buildingId: string }> = [];
    const proxyLike: Array<{ name: string; type: string; geometry: string; chunk: string | null }> = [];
    const geometryTypes: Record<string, number> = {};
    if (state?.scene) {
      state.scene.traverse((o: any) => {
        const chunk = o.userData?.perfChunk;
        if (chunk) chunks[chunk] = (chunks[chunk] ?? 0) + 1;
        if (o.isMesh) {
          const gt = o.geometry?.type ?? 'unknown';
          geometryTypes[gt] = (geometryTypes[gt] ?? 0) + 1;
          if (o.userData?.buildingId && (gt === 'BoxGeometry' || gt === 'ConeGeometry')) {
            primitiveBuildingMeshes.push({ name: o.name ?? '', geometry: gt, buildingId: o.userData.buildingId });
          }
        }
        const name = String(o.name ?? '');
        const lname = name.toLowerCase();
        if (lname.includes('proxy') || String(o.userData?.perfChunk ?? '').toLowerCase().includes('proxy')) {
          proxyLike.push({ name, type: o.type, geometry: o.geometry?.type ?? '', chunk: o.userData?.perfChunk ?? null });
        }
      });
    }

    const vrmMetrics = (window as any).__CV_VRM_LOAD_METRICS ?? [];
    const textureUploadMetrics = (window as any).__CV_TEXTURE_UPLOAD_METRICS ?? null;
    const resourceSummary = {
      count: resources.length,
      transferBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
      decodedBytes: resources.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0),
      glb: resources.filter((r) => /\.(glb|vrm)(?:\?|$)/i.test(r.name)).map((r) => ({
        name: r.name,
        startTime: Math.round(r.startTime),
        duration: Math.round(r.duration),
        transferSize: r.transferSize,
        decodedBodySize: r.decodedBodySize,
      })),
      scripts: resources.filter((r) => r.initiatorType === 'script').length,
      images: resources.filter((r) => r.initiatorType === 'img').length,
      fetch: resources.filter((r) => r.initiatorType === 'fetch').length,
    };

    const longTasks = profile.longTasks ?? [];
    return {
      url: location.href,
      title: document.title,
      ready: Boolean((window as any).__W3D_READY),
      canvasReady: Boolean((window as any).__W3D_CANVAS_READY),
      texturesReady: Boolean((window as any).__W3D_TEXTURES_READY),
      qualityTier: (window as any).__W3D_QUALITY_TIER ?? null,
      dpr: state?.gl?.getPixelRatio?.() ?? null,
      renderInfo: state?.gl?.info ? {
        calls: state.gl.info.render.calls,
        triangles: state.gl.info.render.triangles,
        lines: state.gl.info.render.lines,
        points: state.gl.info.render.points,
        programs: state.gl.info.programs?.length ?? null,
      } : null,
      buttonCount: buttons.length,
      buttons: buttons.slice(0, 40),
      bodyText: document.body.innerText.split('\n').map((s: string) => s.trim()).filter(Boolean).slice(0, 100),
      canvasCount: document.querySelectorAll('canvas').length,
      chunks,
      primitiveBuildingMeshCount: primitiveBuildingMeshes.length,
      primitiveBuildingMeshes: primitiveBuildingMeshes.slice(0, 20),
      proxyLikeCount: proxyLike.length,
      proxyLike: proxyLike.slice(0, 20),
      geometryTypes,
      vrmMetrics,
      textureUploadMetrics,
      profile: {
        errors: profile.errors ?? [],
        paints: profile.paints ?? [],
        lcp: profile.lcp ?? null,
        longTaskCount: longTasks.length,
        longTaskTotalMs: longTasks.reduce((sum: number, e: any) => sum + e.duration, 0),
        longTaskMaxMs: longTasks.reduce((max: number, e: any) => Math.max(max, e.duration), 0),
        longTaskTop: [...longTasks].sort((a: any, b: any) => b.duration - a.duration).slice(0, 10),
      },
      navigation: nav ? {
        ttfb: Math.round(nav.responseStart - nav.requestStart),
        domInteractive: Math.round(nav.domInteractive),
        dcl: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        transferSize: nav.transferSize,
      } : null,
      resources: resourceSummary,
    };
  });

  const screenshotPath = path.join(cfg.outDir, 'game.png');
  const jsonPath = path.join(cfg.outDir, 'metrics.json');
  const mdPath = path.join(cfg.outDir, 'summary.md');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await fs.writeFile(
    jsonPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      wallMs: Date.now() - startedAt,
      config: cfg,
      git,
      consoleMessages,
      report,
    }, null, 2),
  );

  const vrmMetrics = report.vrmMetrics ?? [];
  const textureUpload = report.textureUploadMetrics;
  const topVrmLoads = vrmMetrics
    .slice()
    .sort((a: any, b: any) => (b.totalMs ?? 0) - (a.totalMs ?? 0))
    .slice(0, 15);
  const textureSlices = textureUpload?.slices ?? [];
  const maxTextureSlice = textureSlices.reduce((max: number, s: any) => Math.max(max, s.durationMs ?? 0), 0);

  const md = `# Browser Performance Run: ${cfg.label}

Generated: ${new Date().toISOString()}
Git: \`${git.sha}\`${git.dirty ? ' (dirty)' : ''}

- URL: ${report.url}
- Ready: ${report.ready ? 'yes' : 'no'}; textures ready: ${report.texturesReady ? 'yes' : 'no'}
- Quality tier: ${report.qualityTier}
- DPR: ${report.dpr}
- Render calls: ${report.renderInfo?.calls ?? '-'}
- Triangles: ${report.renderInfo?.triangles?.toLocaleString?.() ?? '-'}
- Visible buttons: ${report.buttonCount}
- Primitive building proxy meshes: ${report.primitiveBuildingMeshCount}
- Proxy-like named nodes: ${report.proxyLikeCount} (names only; inspect JSON for false positives from GLB authoring)
- Long tasks: ${report.profile.longTaskCount}, total ${formatMs(report.profile.longTaskTotalMs)}, max ${formatMs(report.profile.longTaskMaxMs)}
- VRM loads captured: ${vrmMetrics.length}
- Texture upload: ${textureUpload ? `${textureUpload.totalTextures} textures via ${textureUpload.mode}, ${formatMs(textureUpload.durationMs)}, max slice ${formatMs(maxTextureSlice)}` : 'not captured'}
- Resource transfer: ${formatBytes(report.resources.transferBytes)}
- GLB/VRM resources: ${report.resources.glb.length}
- Screenshot: \`game.png\`

## Navigation

- TTFB: ${formatMs(report.navigation?.ttfb)}
- DOM interactive: ${formatMs(report.navigation?.domInteractive)}
- DCL: ${formatMs(report.navigation?.dcl)}
- Load: ${formatMs(report.navigation?.load)}

## Top Long Tasks

| Start | Duration | Name |
|---:|---:|---|
${report.profile.longTaskTop.map((t: any) => `| ${formatMs(t.startTime)} | ${formatMs(t.duration)} | ${t.name || '-'} |`).join('\n') || '| - | - | - |'}

## Slowest VRM Loads

| Asset | Total | Fetch wait | Parse | Normalise | Bytes | Meshes | Skinned |
|---|---:|---:|---:|---:|---:|---:|---:|
${topVrmLoads
  .map((m: any) => `| \`${String(m.path).split('/').pop()}\` | ${formatMs(m.totalMs)} | ${formatMs(m.fetchWaitMs)} | ${formatMs(m.parseMs)} | ${formatMs(m.normaliseMs)} | ${formatBytes(m.bytes || 0)} | ${m.sceneAfter?.meshes ?? '-'} | ${m.sceneAfter?.skinnedMeshes ?? '-'} |`)
  .join('\n') || '| - | - | - | - | - | - | - | - |'}

## Texture Upload Slices

${textureUpload ? `- Mode: ${textureUpload.mode}
- Textures: ${textureUpload.totalTextures}
- Duration: ${formatMs(textureUpload.durationMs)}
- Slices: ${textureSlices.length}
- Max slice: ${formatMs(maxTextureSlice)}` : '- Not captured'}

## Largest GLB/VRM Network Resources

| Resource | Transfer | Decoded | Duration |
|---|---:|---:|---:|
${report.resources.glb
  .slice()
  .sort((a: any, b: any) => (b.decodedBodySize || b.transferSize || 0) - (a.decodedBodySize || a.transferSize || 0))
  .slice(0, 20)
  .map((r: any) => `| \`${r.name.split('/').pop()}\` | ${formatBytes(r.transferSize || 0)} | ${formatBytes(r.decodedBodySize || 0)} | ${formatMs(r.duration)} |`)
  .join('\n') || '| - | - | - | - |'}

## Acceptance Notes

- Normal play must keep HUD/buttons visible.
- Normal play must not replace buildings with primitive blocks.
- Normal play must not replace recognizable characters with capsule/cylinder stand-ins.
`;
  await fs.writeFile(mdPath, md);
  await browser.close();
  await fs.rm(profileDir, { recursive: true, force: true });

  console.log(JSON.stringify({
    label: cfg.label,
    mode: 'load-phase',
    outDir: path.relative(REPO_ROOT, cfg.outDir).replace(/\\/g, '/'),
    screenshot: path.relative(REPO_ROOT, screenshotPath).replace(/\\/g, '/'),
    json: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/'),
    markdown: path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/'),
    git,
    summary: {
      ready: report.ready,
      buttons: report.buttonCount,
      calls: report.renderInfo?.calls,
      triangles: report.renderInfo?.triangles,
      primitiveBuildingMeshCount: report.primitiveBuildingMeshCount,
      longTaskMaxMs: report.profile.longTaskMaxMs,
      vrmLoads: vrmMetrics.length,
      textureUploadMs: textureUpload?.durationMs ?? null,
    },
  }, null, 2));
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
