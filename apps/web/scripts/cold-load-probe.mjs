// cold-load-probe.mjs — cold-load waterfall + reveal-phase probe (v3).
//
// v3 (rung-0 delta re-review blockers 1-2 + major 4):
//  - computeByteSplit: a request wholly finished before reveal contributes ALL
//    its bytes pre-reveal regardless of chunk coverage (the v2 chunk-residual
//    leak put 0.09MB "post-reveal" in runs whose network finished 10-15s before
//    reveal); only true straddlers apportion, with the chunk residual following
//    the request's end side.
//  - Frame-window inclusion by INTERVAL OVERLAP ([t-d, t] vs the window), so a
//    stall that starts inside the 10s window and ends outside it is counted.
//  - Validity v2: backend must be exactly the lane the URL requested
//    (?webgl=1 ⇒ webgl2, else webgpu); redirect legs retain ever-cached/ever-SW
//    evidence; fromPrefetchCache counts as cache; SW evidence counts failed
//    legs too; a finished http(s) asset with no observed status is invalid.
//  - Full evidence persisted: bounded frame ring + failed requests, not just
//    the convenience projections.
//  - Pure aggregation functions are EXPORTED for tests; the CLI runs only
//    under import.meta.main.
//
// Usage: bun apps/web/scripts/cold-load-probe.mjs <cdp-ws-url> <target-url> <report-path>

export const POST_REVEAL_CAPTURE_MS = 60_000;
export const FRAME_WINDOW_MS = 10_000;
export const STABLE_WINDOW_MS = 3_000;
export const STABLE_FRAME_LIMIT_MS = 100;
export const NET_QUIESCE_MS = 5_000;
const HARD_CAP_MS = 210_000;
const POLL_MS = 500;

// Asset classes that must complete cleanly for a run to be VALID. API/OTHER
// (SSE streams, blobs, RSC prefetches) legitimately stay open or fail. JSON is
// IN scope (re-review #2 blocker 2): a failed config/manifest fetch is a
// broken run, not ignorable noise.
export const ASSET_CLASSES = new Set(["VRM", "GLB", "KTX2", "JS", "CSS", "WASM", "IMG", "FONT", "AUDIO", "JSON", "HTML"]);

/**
 * Network-event reducer (re-review #2 blocker 1 — exported so event-sequence
 * fixtures can drive it). State: { requests: Map<id, rec>, legs: rec[] }.
 * On a redirect re-emission the PRIOR leg is closed from
 * `params.redirectResponse` (the CDP Response of the redirect hop: status,
 * encodedDataLength, cache/SW flags), persisted into `legs` so its wire bytes
 * and warmth cannot vanish, and the chain-wide coldness evidence carries onto
 * the new leg.
 */
export function reduceNetworkEvent(state, msg, monoToPageMs, classifyFn = classify) {
  const { method, params } = msg;
  if (method === "Network.requestWillBeSent") {
    const { cls, host } = classifyFn(params.request.url);
    const prev = state.requests.get(params.requestId);
    let chainFromCache = prev?.everFromCache ?? false;
    let chainFromSW = prev?.everFromSW ?? false;
    if (prev && params.redirectResponse) {
      const rr = params.redirectResponse;
      const legFromCache = !!rr.fromDiskCache || !!rr.fromPrefetchCache;
      const legFromSW = !!rr.fromServiceWorker;
      chainFromCache = chainFromCache || legFromCache;
      chainFromSW = chainFromSW || legFromSW;
      state.legs.push({
        ...prev,
        isRedirectLeg: true,
        finished: true,
        status: rr.status,
        wireBytes: rr.encodedDataLength || 0,
        endPageMs: monoToPageMs(params.timestamp),
        everFromCache: prev.everFromCache || legFromCache,
        everFromSW: prev.everFromSW || legFromSW,
      });
    }
    state.requests.set(params.requestId, {
      url: params.request.url, cls, host,
      startPageMs: monoToPageMs(params.timestamp),
      endPageMs: null,
      wireBytes: 0, chunks: [], failed: false,
      status: null, finished: false,
      everFromCache: chainFromCache,
      everFromSW: chainFromSW,
      redirectLegs: (prev?.redirectLegs ?? 0) + (prev ? 1 : 0),
      type: params.type || "?",
      initiator: prev?.initiator ?? state.initiatorOf?.(params.initiator) ?? null,
      initialPriority: params.request.initialPriority,
    });
  } else if (method === "Network.requestServedFromCache") {
    const r = state.requests.get(params.requestId);
    if (r) r.everFromCache = true;
  } else if (method === "Network.resourceChangedPriority") {
    const r = state.requests.get(params.requestId);
    if (r) r.finalPriority = params.newPriority;
  } else if (method === "Network.dataReceived") {
    const r = state.requests.get(params.requestId);
    if (r && params.encodedDataLength > 0) {
      r.chunks.push({ pageMs: monoToPageMs(params.timestamp), bytes: params.encodedDataLength });
    }
  } else if (method === "Network.responseReceived") {
    const r = state.requests.get(params.requestId);
    if (r) {
      r.everFromSW = r.everFromSW || !!params.response.fromServiceWorker;
      r.everFromCache = r.everFromCache || !!params.response.fromDiskCache || !!params.response.fromPrefetchCache;
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
    const r = state.requests.get(params.requestId);
    if (r) {
      r.wireBytes = params.encodedDataLength || 0;
      r.endPageMs = monoToPageMs(params.timestamp);
      r.finished = true;
    }
  } else if (method === "Network.loadingFailed") {
    const r = state.requests.get(params.requestId);
    if (r) {
      r.failed = true;
      r.endPageMs = monoToPageMs(params.timestamp);
      r.errorText = params.errorText;
      // Retain the best-known partial wire bytes (chunk sum) so failed bytes
      // cannot disappear from the accounting (re-review #2 blocker 2).
      if (!r.wireBytes) r.wireBytes = (r.chunks ?? []).reduce((a, c) => a + c.bytes, 0);
    }
  }
}

/** All records the aggregation/validity consume: live legs + closed redirect legs. */
export function collectorRecords(state) {
  return [...state.legs, ...state.requests.values()];
}

export function classify(url) {
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

/**
 * Split one request's wire bytes across the reveal boundary.
 * Rules (delta-review blocker 1):
 *  - finished at/before reveal  → all bytes PRE (chunk coverage irrelevant)
 *  - started after reveal       → all bytes POST
 *  - straddler                  → chunks land on their own sides; the residual
 *    (wireBytes − Σchunks) follows the END side; pre is capped at wireBytes.
 */
export function computeByteSplit(r, revealMs) {
  if (revealMs == null) return { pre: r.wireBytes, post: 0 };
  const start = r.startPageMs ?? -Infinity;
  const end = r.endPageMs ?? Infinity;
  if (end <= revealMs) return { pre: r.wireBytes, post: 0 };
  if (start > revealMs) return { pre: 0, post: r.wireBytes };
  // Straddler: chunks land on their own sides; the residual (wireBytes −
  // Σchunks) follows the END side, which for a straddler is post-reveal.
  let preChunks = 0;
  for (const c of r.chunks ?? []) {
    if ((c.pageMs ?? Infinity) <= revealMs) preChunks += c.bytes;
  }
  const pre = Math.min(r.wireBytes, preChunks);
  return { pre, post: r.wireBytes - pre };
}

/**
 * Frame acceptance metrics over [reveal, reveal+FRAME_WINDOW_MS].
 * A frame belongs to the window if its INTERVAL [t−d, t] overlaps it
 * (delta-review blocker 1: a stall beginning inside the window must count).
 */
export function computeFrameMetrics(frames, revealMs, windowMs = FRAME_WINDOW_MS) {
  if (revealMs == null || !frames.length) return null;
  const winStart = revealMs, winEnd = revealMs + windowMs;
  const inWindow = frames.filter((f) => f.t >= winStart && f.t - f.d <= winEnd);
  const worst = inWindow.length ? Math.max(...inWindow.map((f) => f.d)) : null;
  let stableStart = null;
  let runStart = revealMs;
  for (const f of frames.filter((x) => x.t >= revealMs)) {
    if (f.d > STABLE_FRAME_LIMIT_MS) { runStart = f.t; continue; }
    if (f.t - runStart >= STABLE_WINDOW_MS) { stableStart = runStart; break; }
  }
  return {
    worstFrameMsIn10s: worst,
    framesOver33In10s: inWindow.filter((f) => f.d > 33.4).length,
    framesOver100In10s: inWindow.filter((f) => f.d > STABLE_FRAME_LIMIT_MS).length,
    stableWindowStartMsAfterReveal: stableStart != null ? Math.round(stableStart - revealMs) : null,
    seriesKept: frames.length,
  };
}

/**
 * Fail-closed validity (delta-review blocker 2). `all` includes FAILED legs.
 * expectedBackend derives from the test lane (?webgl=1 ⇒ 'webgl2', else 'webgpu').
 */
export function computeValidity({ all, revealMs, backend, expectedBackend, waiveBackend = false }) {
  const wireReasons = [];
  const perfReasons = [];
  let backendWaived = false;
  const isNetworkUrl = (u) => u.startsWith("http://") || u.startsWith("https://");
  const swHits = all.filter((r) => r.everFromSW).length;
  if (swHits > 0) wireReasons.push(`not cold: ${swHits} service-worker hits`);
  // Cold criterion: the FIRST leg of each network URL must not be ever-cached
  // (disk, memory-dedupe on later duplicates is fine, prefetch cache is NOT).
  // Redirect legs carry their own everFromCache from redirectResponse.
  const firstByUrl = new Map();
  for (const r of all) {
    if (!isNetworkUrl(r.url)) continue;
    const prev = firstByUrl.get(r.url);
    if (!prev || (r.startPageMs ?? Infinity) < (prev.startPageMs ?? Infinity)) firstByUrl.set(r.url, r);
  }
  const warmFirsts = [...firstByUrl.values()].filter((r) => r.everFromCache).length;
  if (warmFirsts > 0) wireReasons.push(`not cold: ${warmFirsts} first-occurrence cache hits`);
  if (revealMs == null) wireReasons.push("reveal never observed");
  // Backend: a PERFORMANCE requirement always; a WIRE requirement unless the
  // explicit uninstrumented-bundle waiver applies. Only a true null/undefined
  // stamp is waivable — ''/false/other falsy stamps are present-but-wrong.
  if (backend !== "webgpu" && backend !== "webgl2") {
    perfReasons.push(`backend not actual: ${backend}`);
    if (waiveBackend && backend == null) backendWaived = true;
    else wireReasons.push(`backend not actual: ${backend}`);
  } else if (expectedBackend && backend !== expectedBackend) {
    perfReasons.push(`backend ${backend} != requested lane ${expectedBackend}`);
    wireReasons.push(`backend ${backend} != requested lane ${expectedBackend}`);
  }
  const assetFailures = all.filter((r) => ASSET_CLASSES.has(r.cls) && r.failed);
  if (assetFailures.length) wireReasons.push(`${assetFailures.length} failed asset requests`);
  // EVERY persisted network redirect leg must be 3xx — independent of URL
  // class, since a redirect target's extension says nothing about the hop
  // (re-review #3 residue: an extensionless 200 "redirect" leg escaped the
  // class-filtered check).
  const badLegs = all.filter((r) => r.isRedirectLeg && isNetworkUrl(r.url) && (r.status == null || r.status < 300 || r.status >= 400));
  if (badLegs.length) wireReasons.push(`${badLegs.length} redirect legs without a 3xx status`);
  const netAssets = all.filter((r) => ASSET_CLASSES.has(r.cls) && !r.failed && isNetworkUrl(r.url));
  const terminal = netAssets.filter((r) => !r.isRedirectLeg);
  const badStatus = terminal.filter((r) => r.status != null && (r.status < 200 || r.status >= 300));
  if (badStatus.length) wireReasons.push(`${badStatus.length} non-2xx asset responses (incl. 304 = warm)`);
  const noStatus = terminal.filter((r) => r.finished && r.status == null);
  if (noStatus.length) wireReasons.push(`${noStatus.length} finished network assets with no observed status`);
  const unfinished = terminal.filter((r) => !r.finished);
  if (unfinished.length) wireReasons.push(`${unfinished.length} unfinished asset requests at capture end`);

  const validForWireLedger = wireReasons.length === 0;
  // Performance validity is STRICT: every wire reason plus the un-waived
  // backend requirement. Budget/canary consumers use THIS and must also
  // reject backendWaived reports.
  const validForPerformance = validForWireLedger && perfReasons.length === 0;
  return {
    validForWireLedger,
    validForPerformance,
    reasons: [...new Set([...wireReasons, ...perfReasons])],
    swHits, warmFirsts, backendWaived,
  };
}

/**
 * Performance-evidence completeness (re-review #3 blocking 2): a report may
 * only claim validForPerformance when every metric a paired gate consumes is
 * present and finite. Missing frames, a null stable window, or an unclaimed
 * quiescence marker make the run unusable as performance evidence.
 */
export function assessPerformanceEvidence({ revealMs, frameMetrics, longtaskSeries, networkQuiescedMs }) {
  const reasons = [];
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  if (!finite(revealMs)) reasons.push("no finite revealMs");
  if (!frameMetrics) reasons.push("no frame metrics captured");
  else {
    if (!finite(frameMetrics.worstFrameMsIn10s)) reasons.push("no finite worst-frame metric");
    if (!finite(frameMetrics.stableWindowStartMsAfterReveal)) reasons.push("no stable window observed");
    if (!finite(frameMetrics.framesOver100In10s)) reasons.push("no frame-count metric");
  }
  // An ABSENT series is not a legitimately-empty one (re-review #4 finding 3):
  // extraction preserves absence as null; a real capture is an array whose
  // entries are all finite {s, d}.
  if (!Array.isArray(longtaskSeries)) reasons.push("no longtask series captured");
  else if (longtaskSeries.some((e) => !finite(e?.s) || !finite(e?.d))) reasons.push("malformed longtask entries");
  if (!finite(networkQuiescedMs)) reasons.push("network never quiesced within capture");
  return { complete: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const cliArgs = process.argv.slice(2);
  const waiveBackend = cliArgs.includes("--allow-uninstrumented-backend");
  const [wsUrl, targetUrl, reportPath] = cliArgs.filter((a) => !a.startsWith("--"));
  if (!wsUrl || !targetUrl || !reportPath) {
    console.error("usage: bun cold-load-probe.mjs <cdp-ws-url> <target-url> <report-path> [--allow-uninstrumented-backend]");
    process.exit(2);
  }
  const expectedBackend = targetUrl.includes("webgl=1") ? "webgl2" : "webgpu";

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

  const events = [];
  const pageErrors = [];
  const t0 = Date.now();
  let navMono = null;
  let session = null;
  let finished = false;
  let revealPageMs = null;
  const monoToPageMs = (ts) => (navMono == null || ts == null ? null : (ts - navMono) * 1000);

  const initiatorBrief = (init) => {
    if (!init) return null;
    const top = init.stack?.callFrames?.[0];
    return {
      type: init.type,
      url: (init.url || top?.url || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 120) || undefined,
    };
  };
  // Collector state — Network events go through the exported reducer so the
  // exact ingestion path is what the event-sequence fixtures exercise.
  const collector = { requests: new Map(), legs: [], initiatorOf: initiatorBrief };

  function onEvent(msg) {
    const { method, params } = msg;
    if (method === "Network.requestWillBeSent" && navMono == null && params.type === "Document") {
      navMono = params.timestamp;
    }
    if (method?.startsWith("Network.")) {
      reduceNetworkEvent(collector, msg, monoToPageMs);
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

  const evalInPage = async (expr) => {
    const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, session);
    return res?.result?.value;
  };

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
        st = await evalInPage(`JSON.stringify({reveal:(window.__COLD_PROBE__?window.__COLD_PROBE__.revealAt:null),overlay:!!document.querySelector('.claw-loading-overlay'),prog:(window.__W3D_PROGRESS!=null?window.__W3D_PROGRESS:null),canvases:document.querySelectorAll('canvas').length,backend:(window.__W3D_BACKEND===undefined?null:window.__W3D_BACKEND)})`);
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

    let longtasks = [], longtasksSeries = null, frames = [], navTiming = null, phases = null, backend = null;
    try {
      const blob = await evalInPage(`JSON.stringify({lt:window.__COLD_PROBE__.longtasks,fr:window.__COLD_PROBE__.frames,ph:window.__W3D_PHASES||null,be:(window.__W3D_BACKEND===undefined?null:window.__W3D_BACKEND),nav:(()=>{const n=performance.getEntriesByType('navigation')[0];return n?{dcl:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),ttfb:Math.round(n.responseStart)}:null})()})`);
      const parsed = JSON.parse(blob || "{}");
      // Preserve ABSENCE: a missing series must not launder to a valid empty
      // capture (re-review #4 finding 3).
      longtasksSeries = Array.isArray(parsed.lt) ? parsed.lt : null;
      longtasks = longtasksSeries ?? [];
      frames = parsed.fr || [];
      phases = parsed.ph || null;
      // Preserve falsy-but-present stamps ('' / false): only true absence is
      // null — anything else must fail the backend check, never launder to a
      // waivable null (re-review #3 residue).
      backend = parsed.be === undefined ? null : parsed.be;
      navTiming = parsed.nav || null;
    } catch {}

    const all = collectorRecords(collector);
    const ok = all.filter((r) => !r.failed);
    const totalWire = ok.reduce((a, r) => a + r.wireBytes, 0);

    const byClass = {};
    let preTotal = 0, postTotal = 0;
    for (const r of ok) {
      const { pre, post } = computeByteSplit(r, revealPageMs);
      preTotal += pre; postTotal += post;
      const b = (byClass[r.cls] ||= { count: 0, bytes: 0, preBytes: 0, postBytes: 0 });
      b.count++; b.bytes += r.wireBytes; b.preBytes += pre; b.postBytes += post;
    }

    const verdict = computeValidity({ all, revealMs: revealPageMs, backend, expectedBackend, waiveBackend });
    const lastAssetEnd = Math.max(0, ...ok.filter((r) => ASSET_CLASSES.has(r.cls) && r.endPageMs != null).map((r) => r.endPageMs));
    const captureEndPageMs = revealPageMs != null ? revealPageMs + POST_REVEAL_CAPTURE_MS : null;
    const unfinishedAssets = ok.filter((r) => ASSET_CLASSES.has(r.cls) && !r.finished && (r.url.startsWith("http://") || r.url.startsWith("https://"))).length;
    const networkQuiescedPageMs =
      captureEndPageMs != null && unfinishedAssets === 0 && lastAssetEnd + NET_QUIESCE_MS <= captureEndPageMs
        ? lastAssetEnd + NET_QUIESCE_MS
        : null;

    const frameMetrics = computeFrameMetrics(frames, revealPageMs);
    const perfEvidence = assessPerformanceEvidence({
      revealMs: revealPageMs,
      frameMetrics,
      longtaskSeries: longtasksSeries,
      networkQuiescedMs: networkQuiescedPageMs,
    });
    const preRevealLongtaskMs = longtasks.filter((e) => revealPageMs == null || e.s <= revealPageMs).reduce((a, e) => a + e.d, 0);
    const top = [...ok].sort((a, b) => b.wireBytes - a.wireBytes).slice(0, 40)
      .map((r) => ({ mb: +(r.wireBytes / 1048576).toFixed(2), cls: r.cls, sw: r.everFromSW, cf: r.cfCache, start: r.startPageMs != null ? +(r.startPageMs / 1000).toFixed(1) : null, end: r.endPageMs != null ? +(r.endPageMs / 1000).toFixed(1) : null, url: r.url.replace(/^https?:\/\/[^/]+/, "") }));

    const summary = {
      targetUrl, capturedAt: new Date().toISOString(),
      // Scoped validity (re-review #2 finding 3): the wire ledger accepts
      // validForWireLedger; budget/canary consumers require the STRICT
      // validForPerformance AND backendWaived === false. `valid` mirrors the
      // wire verdict for exit-code compatibility.
      valid: verdict.validForWireLedger,
      validForWireLedger: verdict.validForWireLedger,
      // Performance validity additionally requires COMPLETE metric evidence
      // (re-review #3 blocking 2) — strict validity with a null stable window
      // or missing frames is not usable performance evidence.
      validForPerformance: verdict.validForPerformance && perfEvidence.complete,
      performanceEvidenceReasons: perfEvidence.reasons,
      invalidReasons: verdict.reasons, backendWaived: verdict.backendWaived,
      backend, expectedBackend, phases, navTiming,
      revealMs: revealPageMs,
      loaderFirstSeenHostMs: loaderFirstSeenAt, canvasFirstSeenHostMs: canvasFirstSeenAt,
      networkQuiescedMs: networkQuiescedPageMs, lastAssetByteMs: lastAssetEnd || null,
      totalRequests: all.length, failedRequestCount: all.length - ok.length,
      totalWireMB: +(totalWire / 1048576).toFixed(2),
      preRevealMB: +(preTotal / 1048576).toFixed(2),
      postRevealMB: +(postTotal / 1048576).toFixed(2),
      fromSW: verdict.swHits, fromCacheFirstOccurrence: verdict.warmFirsts,
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

    await Bun.write(reportPath, JSON.stringify({
      summary, top,
      requests: ok.map(({ chunks, ...rest }) => rest),
      failedRequests: all.filter((r) => r.failed).map(({ chunks, ...rest }) => rest),
      longtasks, // full series (evidence — summary.longtasks.worst is a projection)
      frames, // full bounded ring (evidence; framesWindow is the projection)
      framesWindow: revealPageMs != null ? frames.filter((f) => f.t >= revealPageMs - 2000 && f.t <= revealPageMs + 15_000) : [],
      revealTimeline: events.filter((_, i) => i % 4 === 0),
    }, null, 2));
    console.log("[probe] ==== SUMMARY ====");
    console.log(JSON.stringify(summary, null, 2));
    console.log(`[probe] report: ${reportPath}`);
    if (!verdict.validForWireLedger) {
      console.log(`[probe] RUN INVALID: ${verdict.reasons.join("; ")}`);
      ws.close();
      process.exit(3);
    }
    ws.close();
    process.exit(0);
  }

  main().catch((e) => { console.error("[probe] FATAL", e); process.exit(1); });
}
