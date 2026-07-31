// cold-load-probe.mjs — cold-load waterfall + reveal-phase probe.
//
// Connects to an agent-browser (or any Chrome) CDP endpoint, navigates to the
// target URL, and records:
//   - every network response: wire bytes, timing, initiator, initial/changed
//     priority, protocol, CF cache headers, service-worker/disk-cache flags
//   - the reveal moment (__W3D_READY + .claw-loading-overlay gone) and the
//     loader/canvas first-seen milestones
//   - the World3DCanvas warmup phase breakdown (__W3D_PHASES) + renderer
//     backend (__W3D_BACKEND) exported by the M0 instrumentation
//   - longtasks + rAF frame deltas (worst frame / over-budget counts in the
//     10s window after reveal)
//   - a network-quiesced marker (last asset byte + 5s of silence)
//
// Part of docs/perf-cold-load-diet-2026-07-31.md rung 0. The ratchet metrics
// are summary.preRevealMB and summary.revealMs; budgets are frozen per backend.
//
// Usage: bun apps/web/scripts/cold-load-probe.mjs <cdp-ws-url> <target-url> <report-path>
// The browser profile must be FRESH for a cold measurement (0 SW hits — the
// report's summary.fromSW count is the check).

const [wsUrl, targetUrl, reportPath] = process.argv.slice(2);
if (!wsUrl || !targetUrl || !reportPath) {
  console.error("usage: bun cold-load-probe.mjs <cdp-ws-url> <target-url> <report-path>");
  process.exit(2);
}

const POST_REVEAL_CAPTURE_MS = 60_000;
const FRAME_WINDOW_MS = 10_000;
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
const events = []; // reveal poll timeline
const t0 = Date.now();
let revealAt = null;
let loaderFirstSeenAt = null;
let canvasFirstSeenAt = null;
let lastAssetByteAt = null;
let session = null;
let finished = false;

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

function initiatorBrief(init) {
  if (!init) return null;
  const top = init.stack?.callFrames?.[0];
  return {
    type: init.type,
    url: (init.url || top?.url || "").replace(/^https:\/\/[^/]+/, "").slice(0, 120) || undefined,
  };
}

function onEvent(msg) {
  const { method, params } = msg;
  if (method === "Network.requestWillBeSent") {
    const { cls, host } = classify(params.request.url);
    if (!requests.has(params.requestId)) {
      requests.set(params.requestId, {
        url: params.request.url, cls, host,
        startMs: Date.now() - t0, endMs: null,
        wireBytes: 0, fromSW: false, fromCache: false, failed: false,
        type: params.type || "?",
        initiator: initiatorBrief(params.initiator),
        initialPriority: params.request.initialPriority,
      });
    }
  } else if (method === "Network.resourceChangedPriority") {
    const r = requests.get(params.requestId);
    if (r) r.finalPriority = params.newPriority;
  } else if (method === "Network.responseReceived") {
    const r = requests.get(params.requestId);
    if (r) {
      r.fromSW = !!params.response.fromServiceWorker;
      r.fromCache = !!params.response.fromDiskCache;
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
      r.endMs = Date.now() - t0;
      if (r.cls !== "API" && r.cls !== "OTHER") lastAssetByteAt = r.endMs;
    }
  } else if (method === "Network.loadingFailed") {
    const r = requests.get(params.requestId);
    if (r) { r.failed = true; r.endMs = Date.now() - t0; r.errorText = params.errorText; }
  }
}

const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject, method } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
    else resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    pageErrors.push({ t: Date.now() - t0, kind: "exception", text: `${d.text} ${d.exception?.description ?? ""}`.slice(0, 400) });
  } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
    const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (args) pageErrors.push({ t: Date.now() - t0, kind: msg.params.type, text: String(args).slice(0, 300) });
  } else if (msg.method) {
    onEvent(msg);
  }
};

ws.onerror = (e) => { console.error("ws error", e?.message || e); };

async function evalInPage(expr) {
  const res = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: false,
  }, session);
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
  // Longtask observer + rAF frame-delta recorder. The frame recorder keeps a
  // bounded worst-N list plus counters, so a long capture cannot grow unbounded.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__COLD_PROBE__={longtasks:[],frames:{count:0,worst:[],over33:0,over100:0,startedAt:performance.now()}};
try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__COLD_PROBE__.longtasks.push({s:Math.round(e.startTime),d:Math.round(e.duration)})}).observe({type:'longtask',buffered:true});}catch(e){}
(()=>{let last=performance.now();const f=window.__COLD_PROBE__.frames;const tick=(now)=>{const d=now-last;last=now;f.count++;if(d>33.4)f.over33++;if(d>100)f.over100++;if(f.worst.length<60||d>f.worst[f.worst.length-1].d){f.worst.push({t:Math.round(now),d:Math.round(d)});f.worst.sort((a,b)=>b.d-a.d);if(f.worst.length>60)f.worst.length=60;}requestAnimationFrame(tick);};requestAnimationFrame(tick);})();`,
  }, session);

  await send("Page.navigate", { url: targetUrl }, session);
  console.log(`[probe] navigating to ${targetUrl}`);

  const deadline = t0 + HARD_CAP_MS;
  while (Date.now() < deadline && !finished) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let st;
    try {
      st = await evalInPage(`JSON.stringify({ready:!!window.__W3D_READY,overlay:!!document.querySelector('.claw-loading-overlay'),prog:(window.__W3D_PROGRESS!=null?window.__W3D_PROGRESS:null),canvases:document.querySelectorAll('canvas').length,backend:window.__W3D_BACKEND||null})`);
    } catch { continue; }
    if (!st) continue;
    const s = JSON.parse(st);
    events.push({ t: Date.now() - t0, ...s });
    if (loaderFirstSeenAt == null && s.overlay) loaderFirstSeenAt = Date.now() - t0;
    if (canvasFirstSeenAt == null && s.canvases > 0) canvasFirstSeenAt = Date.now() - t0;
    if (!revealAt && s.ready && !s.overlay) {
      revealAt = Date.now() - t0;
      console.log(`[probe] WORLD REVEALED at +${(revealAt / 1000).toFixed(1)}s — capturing ${POST_REVEAL_CAPTURE_MS / 1000}s tail`);
      setTimeout(() => { finished = true; }, POST_REVEAL_CAPTURE_MS);
    }
  }
  if (!revealAt) console.log(`[probe] WARNING: reveal never observed within ${HARD_CAP_MS / 1000}s`);

  // Collect page-side telemetry
  let longtasks = [], frames = null, navTiming = null, phases = null, backend = null;
  try {
    const blob = await evalInPage(`JSON.stringify({lt:window.__COLD_PROBE__?window.__COLD_PROBE__.longtasks:[],fr:window.__COLD_PROBE__?window.__COLD_PROBE__.frames:null,ph:window.__W3D_PHASES||null,be:window.__W3D_BACKEND||null,nav:(()=>{const n=performance.getEntriesByType('navigation')[0];return n?{dcl:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),ttfb:Math.round(n.responseStart)}:null})()})`);
    const parsed = JSON.parse(blob || "{}");
    longtasks = parsed.lt || [];
    frames = parsed.fr || null;
    phases = parsed.ph || null;
    backend = parsed.be || null;
    navTiming = parsed.nav || null;
  } catch {}

  // ---- aggregate ----
  const all = [...requests.values()].filter((r) => !r.failed);
  const totalWire = all.reduce((a, r) => a + r.wireBytes, 0);
  const preReveal = revealAt == null ? all : all.filter((r) => (r.endMs ?? Infinity) <= revealAt);
  const postReveal = revealAt == null ? [] : all.filter((r) => (r.endMs ?? Infinity) > revealAt);

  const byClass = {};
  for (const r of all) {
    const b = (byClass[r.cls] ||= { count: 0, bytes: 0, preBytes: 0, postBytes: 0 });
    b.count++; b.bytes += r.wireBytes;
    if (revealAt != null && (r.endMs ?? Infinity) <= revealAt) b.preBytes += r.wireBytes; else b.postBytes += r.wireBytes;
  }

  const top = [...all].sort((a, b) => b.wireBytes - a.wireBytes).slice(0, 40)
    .map((r) => ({ mb: +(r.wireBytes / 1048576).toFixed(2), cls: r.cls, sw: r.fromSW, cf: r.cfCache, start: +(r.startMs / 1000).toFixed(1), end: r.endMs != null ? +(r.endMs / 1000).toFixed(1) : null, url: r.url.replace(/^https:\/\/[^/]+/, "") }));

  // Post-reveal frame window: worst frames whose timestamp falls in [reveal, reveal+10s].
  // Frame timestamps are page-performance.now()-based; map via the reveal poll's wall time
  // against navTiming — approximate alignment is fine at 10s granularity: page start ≈ t0+navLag.
  let postRevealFrames = null;
  if (frames && revealAt != null) {
    const inWindow = frames.worst.filter((f) => f.t >= revealAt - 1500 && f.t <= revealAt + FRAME_WINDOW_MS + 1500);
    postRevealFrames = {
      worstMs: inWindow.length ? Math.max(...inWindow.map((f) => f.d)) : null,
      over33Total: frames.over33, over100Total: frames.over100,
      worstInWindow: inWindow.slice(0, 10),
    };
  }

  const ltTotal = longtasks.reduce((a, e) => a + e.d, 0);
  const summary = {
    targetUrl, capturedAt: new Date().toISOString(),
    backend, phases, navTiming,
    revealMs: revealAt, loaderFirstSeenMs: loaderFirstSeenAt, canvasFirstSeenMs: canvasFirstSeenAt,
    networkQuiescedMs: lastAssetByteAt != null ? lastAssetByteAt + NET_QUIESCE_MS : null,
    lastAssetByteMs: lastAssetByteAt,
    totalRequests: all.length,
    totalWireMB: +(totalWire / 1048576).toFixed(2),
    preRevealMB: +(preReveal.reduce((a, r) => a + r.wireBytes, 0) / 1048576).toFixed(2),
    postRevealMB: +(postReveal.reduce((a, r) => a + r.wireBytes, 0) / 1048576).toFixed(2),
    fromSW: all.filter((r) => r.fromSW).length,
    byClass: Object.fromEntries(Object.entries(byClass).sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => [k, { count: v.count, mb: +(v.bytes / 1048576).toFixed(2), preMB: +(v.preBytes / 1048576).toFixed(2), postMB: +(v.postBytes / 1048576).toFixed(2) }])),
    longtasks: { count: longtasks.length, totalMs: ltTotal, over100ms: longtasks.filter((e) => e.d >= 100).length, worst: [...longtasks].sort((a, b) => b.d - a.d).slice(0, 10) },
    postRevealFrames,
    pageErrors: pageErrors.slice(0, 40),
  };

  await Bun.write(reportPath, JSON.stringify({ summary, top, requests: all, revealTimeline: events.filter((_, i) => i % 4 === 0) }, null, 2));
  console.log("[probe] ==== SUMMARY ====");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[probe] report: ${reportPath}`);
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("[probe] FATAL", e); process.exit(1); });
