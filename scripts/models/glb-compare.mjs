// Before/after quality check for a compressed GLB.
// Usage: node scripts/models/glb-compare.mjs <before.glb> <after.glb> <out-dir> [--label name] [--kind building|avatar]
// Writes to <out-dir>:
//   <label>-compare.jpg           BEFORE | AFTER | DIFF x4 for every view (half size)
//   <label>-<view>.jpg            1:1 BEFORE over AFTER for the game-distance and worst-case views
//   <label>-textures-compare.jpg  the same sheet for the texture-only render
//   <label>-compare.json          render scores, structure, geometry error, flags, verdict
// Two renders: (1) BEFORE vs AFTER, what ships; (2) BEFORE vs BEFORE's geometry
// with AFTER's textures, so texture loss is measured with no geometry noise.
// Review flags come from render (2).
// Render: headless Chrome (WebGL) with the repo's own three.js build.
// Geometry: decoded vertices matched one to one (glb-breakdown.mjs geometryDiff).
// Exit 1 = a BLOCK (counts, bounds, geometry error over the limits, or a crash).
// Exit 0 = no block. The render scores are for review only: a person must
// still look at the images before a compressed model ships.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeGlb, structuralDiff, geometryDiff, texturesOnto } from './glb-breakdown.mjs';

// Geometry limits. i16 quantization stays far inside these; the i8 normals that
// Codex rejected on the pavilion (0.97 deg) do not.
const LIMITS = { posErrOfDiag: 1e-4, normalDeg: 0.1, uvErr: 1 / 8192 };
// Review flags (not blocks), from the texture-only render, on every non-empty
// view: one 16x16 area lost more than 10% of its fine detail, gained more than
// 25% (noise or artifacts), or a 64x64 area's SSIM fell under 0.98. On the
// pavilion boards (512 -> 256 px) the game view reads 0.90 and the worst view
// 0.82, and the softening is visible, so a flag means "look at this view".
const FLAG = { worstTileDetail: 0.9, maxTileDetail: 1.25, worstTileSsim: 0.98 };
// Full-render blocks: a real compression keeps SSIM >= 0.99 in every view (the
// worst accepted case so far is 0.994). Under 0.97, or a silhouette that grows or
// shrinks by more than 2% of the covered pixels, means the model itself changed.
const RENDER_BLOCK = { ssim: 0.97, coverage: 0.02 };

const args = process.argv.slice(2);
const li = args.indexOf('--label');
const label = li >= 0 ? args.splice(li, 2)[1] : null;
const ki = args.indexOf('--kind');
const kind = ki >= 0 ? args.splice(ki, 2)[1] : 'building';
if (!['building', 'avatar'].includes(kind)) { console.error('--kind must be building or avatar'); process.exit(2); }
const [before, after, outDir] = args;
if (!before || !after || !outDir) {
  console.error('usage: glb-compare.mjs <before.glb> <after.glb> <out-dir> [--label name]');
  process.exit(2);
}
const name = label ?? basename(after, '.glb');
const here = dirname(fileURLToPath(import.meta.url));
const threeDir = resolve(here, '../../apps/web/node_modules/three');
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
for (const p of [before, after, threeDir, chromePath]) if (!existsSync(p)) { console.error(`missing: ${p}`); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const hybrid = join(mkdtempSync(join(tmpdir(), 'glbcmp-h-')), 'textures-only.glb');
let hybridError = null;
try { await texturesOnto(before, after, hybrid); } catch (e) { hybridError = String(e?.message ?? e); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.json': 'application/json' };
const routes = { '/a.glb': resolve(before), '/b.glb': resolve(after), '/h.glb': hybrid, '/': join(here, 'glb-compare.html') };
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = routes[url];
  if (!file && url.startsWith('/three/')) {
    file = resolve(threeDir, '.' + url.slice('/three'.length));
    if (!file.startsWith(threeDir)) file = null;
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const cdpPort = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'glbcmp-'))}`,
  '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1300,760', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
try {
  for (let i = 0; i < 80; i++) { try { await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; } catch { await sleep(250); } }
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
  await send('Page.enable');
  const render = async (b) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?a=/a.glb&b=${b}&kind=${kind}` });
    let title = '';
    for (let i = 0; i < 480 && !/^(done|err)/.test(title); i++) { await sleep(250); title = (await evaluate('document.title')) ?? ''; }
    if (title !== 'done') throw new Error(`page did not finish (${b}): "${title}"`);
    return JSON.parse(await evaluate('JSON.stringify(window.__result)'));
  };
  const res = await render('/b.glb');
  writeFileSync(join(outDir, `${name}-compare.jpg`), Buffer.from(res.sheet.split(',')[1], 'base64'));
  for (const [view, url] of Object.entries(res.pairs)) writeFileSync(join(outDir, `${name}-${view}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  delete res.sheet; delete res.pairs;
  if (hybridError) res.textureViews = [];
  else {
    const tex = await render('/h.glb');
    writeFileSync(join(outDir, `${name}-textures-compare.jpg`), Buffer.from(tex.sheet.split(',')[1], 'base64'));
    res.textureViews = tex.views;
  }
  const [da, db] = [await describeGlb(before), await describeGlb(after)];
  const structure = structuralDiff(da, db);
  const geometry = await geometryDiff(before, after);
  const blocks = [...structure.blocks];
  if (hybridError) blocks.push(`texture-only render not possible, texture loss not measured: ${hybridError}`);
  if (geometry.error) blocks.push(geometry.error);
  else {
    for (const [k, lim] of Object.entries(LIMITS)) if (geometry[k] > lim) blocks.push(`geometry ${k} ${geometry[k].toExponential(2)} > ${lim.toExponential(2)}`);
    if (geometry.triangleMismatch) blocks.push(`geometry: ${geometry.triangleMismatch} triangles differ from BEFORE (lost, moved or re-wound)`);
    if (geometry.unmatchedVertices) blocks.push(`geometry: ${geometry.unmatchedVertices} AFTER vertices have no BEFORE vertex nearby`);
    if (geometry.nonTrianglePrimitives) blocks.push(`geometry: ${geometry.nonTrianglePrimitives} non-triangle primitives (not checked)`);
  }
  for (const v of res.views) {
    if (v.empty) continue;
    if (v.ssim < RENDER_BLOCK.ssim) blocks.push(`render ${v.name}: SSIM ${v.ssim} < ${RENDER_BLOCK.ssim}`);
    const dc = Math.abs(v.coveredA - v.coveredB) / Math.max(1, v.coveredA);
    if (dc > RENDER_BLOCK.coverage) blocks.push(`render ${v.name}: covered pixels ${v.coveredA} -> ${v.coveredB}`);
  }
  if (res.views.every((v) => v.empty)) blocks.push('every view is empty: the cameras did not see the model');
  const span = Math.hypot(...res.boundsA[1].map((v, i) => v - res.boundsA[0][i])) || 1;
  const boundsDelta = Math.max(...res.boundsA.flatMap((v, i) => v.map((n, j) => Math.abs(n - res.boundsB[i][j])))) / span;
  if (boundsDelta > 1e-3) blocks.push(`bounds moved ${(boundsDelta * 100).toFixed(3)}% of the diagonal`);
  const flags = res.textureViews.filter((v) => !v.empty).flatMap((v) => [
    ...(v.worstTileDetail < FLAG.worstTileDetail ? [`${v.name}: an area kept ${(v.worstTileDetail * 100).toFixed(0)}% of its fine detail`] : []),
    ...(v.maxTileDetail > FLAG.maxTileDetail ? [`${v.name}: an area has ${(v.maxTileDetail * 100).toFixed(0)}% of its fine detail (noise or artifacts)`] : []),
    ...(v.worstTileSsim < FLAG.worstTileSsim ? [`${v.name}: worst-area SSIM ${v.worstTileSsim}`] : []),
  ]);
  Object.assign(res, { flags, kind, before: { path: before, bytes: da.bytes }, after: { path: after, bytes: db.bytes }, structure, geometry, limits: LIMITS, blocks });
  writeFileSync(join(outDir, `${name}-compare.json`), JSON.stringify(res, null, 2));
  console.log(`${name} (${kind}): ${da.bytes.toLocaleString('en-US')} -> ${db.bytes.toLocaleString('en-US')} bytes (${(da.bytes / 1e6).toFixed(3)} -> ${(db.bytes / 1e6).toFixed(3)} MB, ${(100 - (100 * db.bytes) / da.bytes).toFixed(1)}% smaller)`);
  if (!geometry.error) console.log(`geometry: position ${geometry.posErrOfDiag.toExponential(2)} of diagonal, normal ${geometry.normalDeg.toFixed(4)} deg, uv ${geometry.uvErr.toExponential(2)}, triangles differing ${geometry.triangleMismatch}`);
  for (const n of structure.notes) console.log(`note: ${n}`);
  const row = (v) => v.empty ? `  ${v.name.padEnd(15)} EMPTY (model under 0.5% of the frame)` : `  ${v.name.padEnd(15)} PSNR ${String(v.psnr).padStart(8)} dB  SSIM ${v.ssim.toFixed(4)}  worst tile ${v.worstTileSsim.toFixed(4)}  detail kept ${v.detailKept.toFixed(3)} (worst ${v.worstTileDetail.toFixed(3)}, max ${v.maxTileDetail.toFixed(3)})  changed ${v.changedPct}%`;
  console.log('render, before vs after:'); for (const v of res.views) console.log(row(v));
  console.log('render, textures only:'); for (const v of res.textureViews) console.log(row(v));
  for (const f of flags) console.log(`REVIEW: ${f}`);
  console.log(blocks.length ? ['VERDICT: BLOCK', ...blocks.map((b) => `  - ${b}`)].join('\n') : (flags.length ? 'VERDICT: no block, REVIEW flags above (look at those views)' : 'VERDICT: no block (images still need a person to look)'));
  ws.close();
  ok = blocks.length === 0;
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  chrome.kill();
  server.close();
}
process.exit(ok ? 0 : 1);
