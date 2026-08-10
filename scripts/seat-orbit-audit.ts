#!/usr/bin/env bun
// Seat-by-seat visual + metric audit of /cove/table.
// For each occupied seat: force the render camera to front / side / 3/4
// close-ups and capture PNGs; extract skeleton + stool + table metrics
// (hip height vs stool top, torso pitch/yaw, hip->stool offset, shoulder
// vs table rim) from the live scene. Front-only verification is banned.
const PORT = 9223;
const dir = import.meta.dir;

const bws = ((await (await fetch(`http://localhost:${PORT}/json/version`)).json()) as any).webSocketDebuggerUrl as string;
const bsock = new WebSocket(bws);
const bpend = new Map<number, any>(); let bid = 1;
bsock.onmessage = (ev) => { const m = JSON.parse(ev.data.toString()); if (m.id && bpend.has(m.id)) { bpend.get(m.id).resolve(m.result); bpend.delete(m.id); } };
await new Promise<void>((res, rej) => { bsock.onopen = () => res(); bsock.onerror = rej; });
const bcmd = (m: string, p: any = {}) => new Promise<any>((resolve, reject) => { const id = bid++; bpend.set(id, { resolve, reject }); bsock.send(JSON.stringify({ id, method: m, params: p })); });
const tgt = await bcmd('Target.createTarget', { url: 'about:blank' });
await new Promise((r) => setTimeout(r, 400));
const tabs = (await (await fetch(`http://localhost:${PORT}/json`)).json()) as any[];
const tab = tabs.find((x) => x.id === tgt.targetId);
bsock.close();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
const pending = new Map<number, any>(); let nextId = 1;
ws.onmessage = (ev) => { const m = JSON.parse(ev.data.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
const cmd = (m: string, p: any = {}) => new Promise<any>((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const evalJs = async (e: string) => { const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
await cmd('Page.enable');
await cmd('Runtime.enable');

// Hook Three devtools BEFORE page scripts: collect observed scene + patch render to allow camera forcing.
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
window.__cvAudit = { scenes: [], renderers: [] };
window.__THREE_DEVTOOLS__ = {
  dispatchEvent(ev) {
    try {
      const d = ev.detail;
      if (!d) return;
      if (d.isScene) window.__cvAudit.scenes.push(d);
      if (d.render && d.setSize) {
        window.__cvAudit.renderers.push(d);
        if (!d.__cvPatched) {
          d.__cvPatched = true;
          for (const method of ['render', 'renderAsync']) {
            if (typeof d[method] !== 'function') continue;
            const orig = d[method].bind(d);
            d[method] = function (scene, cam) {
              const ov = window.__cvCamOverride;
              if (ov && cam && cam.isPerspectiveCamera) {
                window.__cvForcedFrames = (window.__cvForcedFrames || 0) + 1;
                cam.position.set(ov.px, ov.py, ov.pz);
                cam.lookAt(ov.tx, ov.ty, ov.tz);
                cam.updateMatrixWorld(true);
              }
              return orig(scene, cam);
            };
          }
        }
      }
    } catch (e) { /* ignore */ }
  },
  addEventListener() {}, removeEventListener() {},
};
` });

await cmd('Page.navigate', { url: 'http://localhost:3001/cove/table?seatCards=1' });
await new Promise((r) => setTimeout(r, 18000));

const hookState = await evalJs(`JSON.stringify({ scenes: window.__cvAudit.scenes.length, renderers: window.__cvAudit.renderers.length })`);
console.error(`hook: ${hookState}`);

// ---- metrics extraction from the live scene ----
const metrics = await evalJs(`(() => {
  const scenes = window.__cvAudit.scenes;
  if (!scenes.length) return 'NO SCENE';
  // pick the scene with the most skinned meshes (the table room)
  let scene = scenes[0], best = -1;
  for (const s of scenes) { let n = 0; s.traverse((o) => { if (o.isSkinnedMesh) n++; }); if (n > best) { best = n; scene = s; } }
  const SEATS = [
    { seat: 1, x: -84.1, z: -60.9 }, { seat: 2, x: -149.35, z: -5.8 }, { seat: 3, x: -126.15, z: 72.5 },
    { seat: 4, x: 84.1, z: -60.9 }, { seat: 5, x: 149.35, z: -5.8 },
  ];
  const wp = (o) => { const e = o.matrixWorld.elements; return { x: e[12], y: e[13], z: e[14] }; };
  // collect skeleton roots (unique) and stools
  const skels = new Set(); const stools = [];
  scene.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) skels.add(o.skeleton);
    const nm = (o.name || '').toLowerCase();
    if (nm.includes('stool') && o.isMesh) stools.push(o);
  });
  scene.updateMatrixWorld(true);
  const stoolTops = stools.map((m) => {
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
    return { cx: (bb.min.x + bb.max.x) / 2, cz: (bb.min.z + bb.max.z) / 2, top: bb.max.y, bottom: bb.min.y, name: m.name };
  });
  const out = [];
  for (const sk of skels) {
    const bones = sk.bones;
    const find = (re) => bones.find((b) => re.test(b.name));
    const hips = find(/hips$/i) || find(/hips/i);
    const head = find(/head$/i);
    const spine = find(/spine$/i) || find(/spine/i);
    const lSh = bones.find((b) => /left/i.test(b.name) && /shoulder|upperarm|arm$/i.test(b.name));
    if (!hips) continue;
    const hp = wp(hips);
    // match to a seat by horizontal distance
    let seatIdx = null, seatD = 1e9, seatRef = null;
    for (const s of SEATS) { const d = Math.hypot(hp.x - s.x, hp.z - s.z); if (d < seatD) { seatD = d; seatIdx = s.seat; seatRef = s; } }
    if (seatD > 60) continue; // dealer / player remnants
    const hd = head ? wp(head) : null;
    const sp = spine ? wp(spine) : null;
    // torso pitch: angle of hips->head from vertical, projected fore/aft along the seat's facing dir
    let pitchDeg = null, yawOffDeg = null;
    if (hd) {
      const v = { x: hd.x - hp.x, y: hd.y - hp.y, z: hd.z - hp.z };
      const horiz = Math.hypot(v.x, v.z);
      pitchDeg = Math.atan2(horiz, v.y) * 180 / Math.PI;
      // is the lean toward the table (origin) or away?
      const toTable = { x: -hp.x, z: -hp.z }; const tl = Math.hypot(toTable.x, toTable.z);
      const dot = horiz > 0.01 ? (v.x * toTable.x / tl + v.z * toTable.z / tl) / horiz : 0;
      yawOffDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI; // 0 = leaning straight at table, 180 = away
    }
    // nearest stool
    let stool = null, stoolD = 1e9;
    for (const st of stoolTops) { const d = Math.hypot(hp.x - st.cx, hp.z - st.cz); if (d < stoolD) { stoolD = d; stool = st; } }
    const shoulderY = lSh ? wp(lSh).y : null;
    out.push({
      seat: seatIdx, hipY: +hp.y.toFixed(1), hipXZ: [+hp.x.toFixed(1), +hp.z.toFixed(1)],
      headY: hd ? +hd.y.toFixed(1) : null, shoulderY: shoulderY == null ? null : +shoulderY.toFixed(1),
      torsoPitchDeg: pitchDeg == null ? null : +pitchDeg.toFixed(1),
      leanDirVsTableDeg: yawOffDeg == null ? null : +yawOffDeg.toFixed(1),
      stoolTopY: stool ? +stool.top.toFixed(1) : null,
      hipToStoolCenterXZ: stool ? +stoolD.toFixed(1) : null,
      hipAboveStoolTop: stool ? +(hp.y - stool.top).toFixed(1) : null,
      distFromSeatAnchor: +seatD.toFixed(1),
    });
  }
  out.sort((a, b) => a.seat - b.seat);
  return JSON.stringify({ tableRimY: 70, stoolCount: stoolTops.length, figures: out }, null, 1);
})()`);
console.error(`METRICS:\n${metrics}`);

await evalJs(`(() => {
  const main = document.querySelector('main');
  if (!main) return false;
  for (let i = 1; i < main.children.length; i += 1) main.children[i].style.display = 'none';
  return true;
})()`);

// ---- forced-camera orbit captures ----
const setCam = async (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
  await evalJs(`(() => {
    window.__cvCamOverride = { px: ${px}, py: ${py}, pz: ${pz}, tx: ${tx}, ty: ${ty}, tz: ${tz} };
    window.__cvForcedFrames = 0;
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  const forced = await evalJs(`window.__cvForcedFrames || 0`);
  if (!forced) console.error('WARN: camera forcing NOT engaged (0 forced frames)');
};
const shot = async (name: string) => {
  const s = await cmd('Page.captureScreenshot', { format: 'png' });
  await Bun.write(`${dir}/${name}.png`, Buffer.from(s.data, 'base64'));
  console.error(`shot: ${name}.png`);
};

const seats = [
  { seat: 1, x: -84.1, z: -60.9 },
  { seat: 2, x: -149.35, z: -5.8 },
  { seat: 3, x: -126.15, z: 72.5 },
  { seat: 4, x: 84.1, z: -60.9 },
  { seat: 5, x: 149.35, z: -5.8 },
];
for (const s of seats) {
  const lookY = 72;
  // outward direction (from table center through the seat)
  const len = Math.hypot(s.x, s.z); const ox = s.x / len, oz = s.z / len;
  // tangent (perpendicular) for the side view
  const txd = -oz, tzd = ox;
  const R = 165, H = 112;
  // FRONT: from the table center side, looking outward at the figure
  await setCam(s.x - ox * R, H, s.z - oz * R, s.x, lookY, s.z);
  await shot(`audit-seat${s.seat}-front`);
  // SIDE: along the tangent
  await setCam(s.x + txd * R, H, s.z + tzd * R, s.x, lookY, s.z);
  await shot(`audit-seat${s.seat}-side`);
  // 3/4 high: shows chair contact + table edge relationship
  await setCam(s.x - ox * R * 0.7 + txd * R * 0.7, H + 55, s.z - oz * R * 0.7 + tzd * R * 0.7, s.x, lookY - 10, s.z);
  await shot(`audit-seat${s.seat}-34high`);
}
// wide references
await setCam(0, 190, -300, 0, 70, 0); await shot('audit-wide-player-side');
await setCam(0, 190, 300, 0, 70, 0); await shot('audit-wide-dealer-side');
await evalJs(`window.__cvCamOverride = null; 'released'`);
await fetch(`http://localhost:${PORT}/json/close/${tab.id}`).catch(() => null);
ws.close();
console.error('done');
