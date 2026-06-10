#!/usr/bin/env bun
/**
 * Browser-side performance verification for the fidelity spike.
 *
 * Launches an isolated Chrome instance, opens /game, waits for the Three scene,
 * samples frame timing, captures resource/long-task data, and writes a JSON
 * report + screenshot + Markdown summary. Works against staging or any URL.
 */

import puppeteer from 'puppeteer-core';
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
}

const REPO_ROOT = process.cwd();

function parseArgs(): Args {
  const args = new Map<string, string>();
  for (const raw of Bun.argv.slice(2)) {
    const [k, ...rest] = raw.replace(/^--/, '').split('=');
    args.set(k, rest.join('=') || '1');
  }
  const label = args.get('label') ?? new Date().toISOString().replace(/[:.]/g, '-');
  return {
    url: args.get('url') ?? 'https://staging.clawville.world/game?perf=1',
    label,
    outDir: path.resolve(args.get('out') ?? `docs/perf-fidelity-spike/browser-${label}`),
    durationMs: Number(args.get('durationMs') ?? '30000'),
    width: Number(args.get('width') ?? '1920'),
    height: Number(args.get('height') ?? '1080'),
    chromePath: args.get('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
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

async function main() {
  const cfg = parseArgs();
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

    const frameSamples = (window as any).__FIDELITY_FRAME_SAMPLES__ ?? [];
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
      bodyText: document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 100),
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
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), wallMs: Date.now() - startedAt, config: cfg, consoleMessages, report }, null, 2));

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
    outDir: path.relative(REPO_ROOT, cfg.outDir).replace(/\\/g, '/'),
    screenshot: path.relative(REPO_ROOT, screenshotPath).replace(/\\/g, '/'),
    json: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/'),
    markdown: path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/'),
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
