// cold-load-probe.mjs — cold-load waterfall + reveal-phase probe (v2).
//
// v2 (rung-0 review blockers 3+4):
//  - ONE clock: reveal is detected PAGE-SIDE (performance.now(), ms since nav
//    start) by an injected 50ms detector; network events are mapped onto the
//    same axis via the document request's CDP MonotonicTime (navMono):
//    pageMs(event) = (event.timestamp - navMono) * 1000. No host-clock guesses.
//  - Landed-byte split uses Network.dataReceived chunk timestamps, so a
//    request straddling the reveal contributes its bytes to each side.
//  - Full bounded frame series (ring, ~last 100s) instead of a global worst-N
//    list; the 10s acceptance window and the 3s stable-window rule are
//    computed exactly.
//  - FAIL CLOSED: a run is INVALID (exit 3) unless it is provably cold
//    (0 SW hits, 0 served-from-cache), observed the reveal, saw the ACTUAL
//    post-init backend, and had no failed/non-2xx/unfinished asset requests.
//    summary.valid + summary.invalidReasons carry the verdict.
//
// Part of docs/perf-cold-load-diet-2026-07-31.md rung 0.
// Usage: bun apps/web/scripts/cold-load-probe.mjs <cdp-ws-url> <target-url> <report-path>

const [wsUrl, targetUrl, reportPath] = process.argv.slice(2);
if (!wsUrl || !targetUrl || !reportPath) {
  console.error("usage: bun cold-load-probe.mjs <cdp-ws-url> <target-url> <report-path>");
  process.exit(2);
}

const POST_REVEAL_CAPTURE_MS = 60_000;
const FRAME_WINDOW_MS = 10_000;
const STABLE_WINDOW_MS = 3_000;
const STABLE_FRAME_LIMIT_MS = 100;
const NET_QUIESCE_MS = 5_000;
const HARD_CAP_MS = 210_000;
const POLL_MS = 500;

let msgId = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

// ---- state ----
const requests = new Map(); // requestId -> record
const servedFromCacheIds = new Set();
const events = []; // host-side poll timeline (informational only)
const t0 = Date.now();
let navMono = null; // CDP MonotonicTime (seconds) of the document request = page t=0
let session = null;
let finished = false;
let revealPageMs = null; // page-clock reveal (ms since nav start)

const monoToPageMs = (ts) => (navMono == null || ts == null ? null : (ts - navMono) * 1000);

function classify(url) {
  let u;
  try { u = new URL(url); } catch { return { cls: "OTHER", host: "?" }; }
  const p = u.pathname.toLowerCase();
  const host = u.host;
  const ext = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1) : "";
  let cls = "OTHER";
  if (ext === "vrm") cls = "VRM";
  else if (ext === "glb" || ext === "gltf" || ext === "bin") cls = "GLB";
  else if (ext === "ktx2" || ext === "basis") cls = "KTX2";
  else if (ext === "js" || ext === "mjs") cls = "JS";
  else if (ext === "css") cls = "CSS";
  else if (ext === "wasm") cls = "WASM";
  else if (["png", "jpg", "jpeg", "webp", "svg", "ico", "gif", "avif"].includes(ext)) cls = "IMG";
  else if (["woff", "woff2", "ttf", "otf"].includes(ext)) cls = "FONT";
  else if (["mp3", "ogg", "wav", "m4a"].includes(ext)) cls = "AUDIO";
  else if (ext === "json") cls = "JSON";
  else if (host.startsWith("api")) cls = "API";
  else if (p === "/game" || p === "/") cls = "HTML";
  return { cls, host };
}

// Asset classes that must complete cleanly for a run to be VALID. API/OTHER
// (SSE streams, blobs, RSC prefetches) legitimately stay open or fail.
const ASSET_CLASSES = new Set(["VRM", "GLB", "KTX2", "JS", "CSS", "WASM", "IMG", "FONT", "AUDIO", "HTML"]);

function initiatorBrief(init) {
  if (!init) return null;
  const top = init.stack?.callFrames?.[0];
  return {
    type: init.type,
    url: (init.url || top?.url || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 120) || undefined,
  };
}

const pageErrors = [];
function onEvent(msg) {
  const { method, params } = msg;
  if (method === "Network.requestWillBeSent") {
    if (navMono == null && params.type === "Document") navMono = params.timestamp;
    const { cls, host } = classify(params.request.url);
    // Redirect chains re-emit requestWillBeSent with the same requestId — track
    // the FINAL url and reset per-request accumulators so stale records don't
    // carry over (blocker 3).
    requests.set(params.requestId, {
      url: params.request.url, cls, host,
      startPageMs: monoToPageMs(params.timestamp),
      endPageMs: null,
      wireBytes: 0, chunks: [], fromSW: false, fromCache: false, failed: false,
      status: null, finished: false,
      type: params.type || "?",
      initiator: initiatorBrief(params.initiator),
      initialPriority: params.request.initialPriority,
      redirected: requests.has(params.requestId) ? true : undefined,
    });
  } else if (method === "Network.requestServedFromCache") {
    servedFromCacheIds.add(params.requestId);
    const r = requests.get(params.requestId);
    if (r) r.fromCache = true;
  } else if (method === "Network.resourceChangedPriority") {
    const r = requests.get(params.requestId);
    if (r) r.finalPriority = params.newPriority;
  } else if (method === "Network.dataReceived") {
    const r = requests.get(params.requestId);
    if (r && params.encodedDataLength > 0) {
      r.chunks.push({ pageMs: monoToPageMs(params.timestamp), bytes: params.encodedDataLength });
    }
  } else if (method === "Network.responseReceived") {
    const r = requests.get(params.requestId);
    if (r) {
      r.fromSW = !!params.response.fromServiceWorker;
      r.fromCache = r.fromCache || !!params.response.fromDiskCache;
      r.mime = params.response.mimeType;
      r.status = params.response.status;
      r.protocol = params.response.protocol;
      const h = params.response.headers || {};
      const hget = (k) => h[k] ?? h[k.toLowerCase()] ?? h[k.toUpperCase()];
      const cf = hget("cf-cache-status");
      const age = hget("age");
      if (cf) r.cfCache = cf;
      if (age) r.cfAge = age;
    }
  } else if (method === "Network.loadingFinished") {
    const r = requests.get(params.requestId);
    if (r) {
      r.wireBytes = params.encodedDataLength || 0;
      r.endPageMs = monoToPageMs(params.timestamp);
      r.finished = true;
    }
  } else if (method === "Network.loadingFailed") {
    const r = requests.get(params.requestId);
    if (r) { r.failed = true; r.endPageMs = monoToPageMs(params.timestamp); r.errorText = params.errorText; }
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails;
    pageErrors.push({ t: Date.now() - t0, kind: "exception", text: `${d.text} ${d.exception?.description ?? ""}`.slice(0, 400) });
  } else if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning")) {
    const args = (params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (args) pageErrors.push({ t: Date.now() - t0, kind: params.type, text: String(args).slice(0, 300) });
  }
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject, method } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
    else resolve(msg.result);
  } else if (msg.method) {
    onEvent(msg);
  }
};

ws.onerror = (e) => { console.error("ws error", e?.message || e); };

async function evalInPage(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, session);
  return res?.result?.value;
}

async function main() {
  await new Promise((res, rej) => { ws.onopen = res; setTimeout(() => rej(new Error("ws open timeout")), 10_000); });

  if (wsUrl.includes("/devtools/browser")) {
    const { targetInfos } = await send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    const att = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    session = att.sessionId;
  }

  await send("Network.enable", { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 50_000_000 }, session);
  await send("Page.enable", {}, session);
  await send("Runtime.enable", {}, session);
  // Page-side instrumentation: longtasks, a bounded frame ring (~last 100s at
  // 60Hz), and the page-clock reveal detector (50ms cadence).
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__COLD_PROBE__={longtasks:[],frames:[],revealAt:null};
try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__COLD_PROBE__.longtasks.push({s:Math.round(e.startTime),d:Math.round(e.duration)})}).observe({type:'longtask',buffered:true});}catch(e){}
(()=>{const P=window.__COLD_PROBE__;let last=performance.now();const tick=(now)=>{P.frames.push({t:Math.round(now),d:Math.round(now-last)});last=now;if(P.frames.length>6000)P.frames.splice(0,P.frames.length-6000);requestAnimationFrame(tick);};requestAnimationFrame(tick);})();
(()=>{const P=window.__COLD_PROBE__;const iv=setInterval(()=>{try{if(P.revealAt==null&&window.__W3D_READY===true&&!document.querySelector('.claw-loading-overlay')){P.revealAt=Math.round(performance.now());clearInterval(iv);}}catch(e){}},50);})();`,
  }, session);

  await send("Page.navigate", { url: targetUrl }, session);
  console.log(`[probe] navigating to ${targetUrl}`);

  const deadline = t0 + HARD_CAP_MS;
  let loaderFirstSeenAt = null, canvasFirstSeenAt = null;
  while (Date.now() < deadline && !finished) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let st;
    try {
      st = await evalInPage(`JSON.stringify({reveal:(window.__COLD_PROBE__?window.__COLD_PROBE__.revealAt:null),overlay:!!document.querySelector('.claw-loading-overlay'),prog:(window.__W3D_PROGRESS!=null?window.__W3D_PROGRESS:null),canvases:document.querySelectorAll('canvas').length,backend:window.__W3D_BACKEND||null})`);
    } catch { continue; }
    if (!st) continue;
    const s = JSON.parse(st);
    events.push({ t: Date.now() - t0, ...s });
    if (loaderFirstSeenAt == null && s.overlay) loaderFirstSeenAt = Date.now() - t0;
    if (canvasFirstSeenAt == null && s.canvases > 0) canvasFirstSeenAt = Date.now() - t0;
    if (revealPageMs == null && s.reveal != null) {
      revealPageMs = s.reveal;
      console.log(`[probe] WORLD REVEALED at +${(revealPageMs / 1000).toFixed(1)}s (page clock) — capturing ${POST_REVEAL_CAPTURE_MS / 1000}s tail`);
      setTimeout(() => { finished = true; }, POST_REVEAL_CAPTURE_MS);
    }
  }
  if (revealPageMs == null) console.log(`[probe] WARNING: reveal never observed within ${HARD_CAP_MS / 1000}s`);

  // Collect page-side telemetry
  let longtasks = [], frames = [], navTiming = null, phases = null, backend = null;
  try {
    const blob = await evalInPage(`JSON.stringify({lt:window.__COLD_PROBE__.longtasks,fr:window.__COLD_PROBE__.frames,ph:window.__W3D_PHASES||null,be:window.__W3D_BACKEND||null,nav:(()=>{const n=performance.getEntriesByType('navigation')[0];return n?{dcl:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),ttfb:Math.round(n.responseStart)}:null})()})`);
    const parsed = JSON.parse(blob || "{}");
    longtasks = parsed.lt || [];
    frames = parsed.fr || [];
    phases = parsed.ph || null;
    backend = parsed.be || null;
    navTiming = parsed.nav || null;
  } catch {}

  // ---- aggregate (page clock everywhere) ----
  const all = [...requests.values()];
  const ok = all.filter((r) => !r.failed);
  const totalWire = ok.reduce((a, r) => a + r.wireBytes, 0);

  // Landed-byte reveal split via dataReceived chunks; a chunkless finished
  // request (SW/cache/tiny) falls back to its endPageMs side, capped at the
  // authoritative loadingFinished total.
  const splitBytes = (r) => {
    if (revealPageMs == null) return { pre: r.wireBytes, post: 0 };
    if (r.chunks.length > 0) {
      let pre = 0;
      for (const c of r.chunks) if ((c.pageMs ?? Infinity) <= revealPageMs) pre += c.bytes;
      pre = Math.min(pre, r.wireBytes);
      return { pre, post: r.wireBytes - pre };
    }
    return (r.endPageMs ?? Infinity) <= revealPageMs
      ? { pre: r.wireBytes, post: 0 }
      : { pre: 0, post: r.wireBytes };
  };

  const byClass = {};
  let preTotal = 0, postTotal = 0;
  for (const r of ok) {
    const { pre, post } = splitBytes(r);
    preTotal += pre; postTotal += post;
    const b = (byClass[r.cls] ||= { count: 0, bytes: 0, preBytes: 0, postBytes: 0 });
    b.count++; b.bytes += r.wireBytes; b.preBytes += pre; b.postBytes += post;
  }

  // ---- validity (fail closed — blocker 4) ----
  const invalidReasons = [];
  const swHits = ok.filter((r) => r.fromSW).length;
  const cacheHits = ok.filter((r) => r.fromCache).length + servedFromCacheIds.size;
  if (swHits > 0) invalidReasons.push(`not cold: ${swHits} service-worker hits`);
  if (cacheHits > 0) invalidReasons.push(`not cold: ${cacheHits} cache hits`);
  if (revealPageMs == null) invalidReasons.push("reveal never observed");
  if (!backend || String(backend).endsWith("-requested")) invalidReasons.push(`backend not actual: ${backend}`);
  const assetFailures = all.filter((r) => ASSET_CLASSES.has(r.cls) && r.failed);
  if (assetFailures.length) invalidReasons.push(`${assetFailures.length} failed asset requests`);
  const assetBadStatus = ok.filter((r) => ASSET_CLASSES.has(r.cls) && r.status != null && (r.status < 200 || r.status >= 300));
  if (assetBadStatus.length) invalidReasons.push(`${assetBadStatus.length} non-2xx asset responses (incl. 304 = warm)`);
  const assetUnfinished = ok.filter((r) => ASSET_CLASSES.has(r.cls) && !r.finished);
  if (assetUnfinished.length) invalidReasons.push(`${assetUnfinished.length} unfinished asset requests at capture end`);
  const valid = invalidReasons.length === 0;

  // networkQuiesced: only claim if a full observed silence window exists
  // strictly inside the capture (blocker 4).
  const lastAssetEnd = Math.max(0, ...ok.filter((r) => ASSET_CLASSES.has(r.cls) && r.endPageMs != null).map((r) => r.endPageMs));
  const captureEndPageMs = revealPageMs != null ? revealPageMs + POST_REVEAL_CAPTURE_MS : null;
  const networkQuiescedPageMs =
    captureEndPageMs != null && assetUnfinished.length === 0 && lastAssetEnd + NET_QUIESCE_MS <= captureEndPageMs
      ? lastAssetEnd + NET_QUIESCE_MS
      : null;

  // ---- frame acceptance metrics (blocker 6 rule) ----
  let frameMetrics = null;
  if (revealPageMs != null && frames.length) {
    const win = frames.filter((f) => f.t >= revealPageMs && f.t <= revealPageMs + FRAME_WINDOW_MS);
    const worstInWindow = win.length ? Math.max(...win.map((f) => f.d)) : null;
    // First contiguous 3s window with no frame >100ms, starting at/after reveal.
    let stableStart = null;
    let runStart = revealPageMs;
    for (const f of frames.filter((x) => x.t >= revealPageMs)) {
      if (f.d > STABLE_FRAME_LIMIT_MS) { runStart = f.t; continue; }
      if (f.t - runStart >= STABLE_WINDOW_MS) { stableStart = runStart; break; }
    }
    frameMetrics = {
      worstFrameMsIn10s: worstInWindow,
      framesOver33In10s: win.filter((f) => f.d > 33.4).length,
      framesOver100In10s: win.filter((f) => f.d > STABLE_FRAME_LIMIT_MS).length,
      stableWindowStartMsAfterReveal: stableStart != null ? Math.round(stableStart - revealPageMs) : null,
      seriesKept: frames.length,
    };
  }

  const preRevealLongtaskMs = longtasks.filter((e) => revealPageMs == null || e.s <= revealPageMs).reduce((a, e) => a + e.d, 0);
  const top = [...ok].sort((a, b) => b.wireBytes - a.wireBytes).slice(0, 40)
    .map((r) => ({ mb: +(r.wireBytes / 1048576).toFixed(2), cls: r.cls, sw: r.fromSW, cf: r.cfCache, start: r.startPageMs != null ? +(r.startPageMs / 1000).toFixed(1) : null, end: r.endPageMs != null ? +(r.endPageMs / 1000).toFixed(1) : null, url: r.url.replace(/^https?:\/\/[^/]+/, "") }));

  const summary = {
    targetUrl, capturedAt: new Date().toISOString(),
    valid, invalidReasons,
    backend, phases, navTiming,
    revealMs: revealPageMs,
    loaderFirstSeenHostMs: loaderFirstSeenAt, canvasFirstSeenHostMs: canvasFirstSeenAt,
    networkQuiescedMs: networkQuiescedPageMs, lastAssetByteMs: lastAssetEnd || null,
    totalRequests: all.length, failedRequests: all.length - ok.length,
    totalWireMB: +(totalWire / 1048576).toFixed(2),
    preRevealMB: +(preTotal / 1048576).toFixed(2),
    postRevealMB: +(postTotal / 1048576).toFixed(2),
    fromSW: swHits, fromCache: cacheHits,
    byClass: Object.fromEntries(Object.entries(byClass).sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => [k, { count: v.count, mb: +(v.bytes / 1048576).toFixed(2), preMB: +(v.preBytes / 1048576).toFixed(2), postMB: +(v.postBytes / 1048576).toFixed(2) }])),
    longtasks: {
      count: longtasks.length,
      totalMs: longtasks.reduce((a, e) => a + e.d, 0),
      preRevealTotalMs: preRevealLongtaskMs,
      over100ms: longtasks.filter((e) => e.d >= 100).length,
      worst: [...longtasks].sort((a, b) => b.d - a.d).slice(0, 10),
    },
    frameMetrics,
    pageErrors: pageErrors.slice(0, 40),
  };

  const framesWindow = revealPageMs != null
    ? frames.filter((f) => f.t >= revealPageMs - 2000 && f.t <= revealPageMs + 15_000)
    : [];
  await Bun.write(reportPath, JSON.stringify({
    summary, top,
    requests: ok.map(({ chunks, ...rest }) => rest),
    framesWindow,
    revealTimeline: events.filter((_, i) => i % 4 === 0),
  }, null, 2));
  console.log("[probe] ==== SUMMARY ====");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[probe] report: ${reportPath}`);
  if (!valid) {
    console.log(`[probe] RUN INVALID: ${invalidReasons.join("; ")}`);
    ws.close();
    process.exit(3);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("[probe] FATAL", e); process.exit(1); });
