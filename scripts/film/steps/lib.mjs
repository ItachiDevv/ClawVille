// Shared helpers for the film steps (scripts/film/steps; local state stays in the git-ignored .film/).
export const LOADER_RE = /dropping in|riding the current/i;

// Wait until the page shows its HUD and no loader text.
export async function waitReady(page, sleep, { hud = /SONAR|Trading Floor/, timeoutMs = 45000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (hud.test(t) && !LOADER_RE.test(t)) return Date.now() - t0;
    await sleep(250);
  }
  throw new Error(`page not ready after ${timeoutMs} ms`);
}

// Hold several keys at once (e.g. ['w', 'ArrowLeft']) for ms, then release in reverse order.
export async function hold(page, keys, ms, log, sleep) {
  for (const k of keys) await page.keyboard.down(k);
  log?.(`hold ${keys.join('+')} ${ms} ms`);
  await sleep(ms);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

// SONAR map pixels on /game (world = px - 11264).
export async function sonar(page) {
  const t = await page.evaluate(() => document.body.innerText).catch(() => '');
  const m = t.match(/SONAR\s+(\d+),(\d+)/);
  return m ? { px: +m[1], py: +m[2], x: +m[1] - 11264, z: +m[2] - 11264 } : null;
}

export const MAP_SIZE = 22528;
export const MAP_HALF = 11264;

// Click the SONAR minimap at a WORLD point (x, z). The game path-finds and walks there;
// a point inside a building zone also triggers that building on arrival.
export async function minimapClickWorld(page, x, z) {
  const pt = await page.evaluate(({ mx, my, size }) => {
    const svgs = [...document.querySelectorAll('svg[viewBox]')].filter((s) => {
      const p = s.closest('div');
      return p && /CLICK TO MOVE/i.test(p.parentElement?.innerText || p.innerText || '');
    });
    const svg = svgs.find((s) => s.getBoundingClientRect().width > 50) || null;
    if (!svg) return null;
    const vb = svg.viewBox.baseVal;
    const p = svg.createSVGPoint();
    p.x = (mx * vb.width) / size;
    p.y = (my * vb.height) / size;
    const c = p.matrixTransform(svg.getScreenCTM());
    return { x: c.x, y: c.y };
  }, { mx: MAP_HALF + x, my: MAP_HALF + z, size: MAP_SIZE });
  if (!pt) throw new Error('minimap svg not found');
  await page.mouse.click(pt.x, pt.y);
  return pt;
}

// Poll SONAR until the avatar is within tol of (x, z) or stops moving.
export async function waitArrive(page, sleep, x, z, { tol = 120, timeoutMs = 30000 } = {}) {
  const t0 = Date.now();
  let last = null;
  let still = 0;
  while (Date.now() - t0 < timeoutMs) {
    const s = await sonar(page);
    if (s && Math.hypot(s.x - x, s.z - z) <= tol) return { ...s, ms: Date.now() - t0, arrived: true };
    if (s && last && s.x === last.x && s.z === last.z) still++;
    else still = 0;
    if (still >= 8) return { ...s, ms: Date.now() - t0, arrived: false };
    last = s;
    await sleep(250);
  }
  return { ...(last || {}), ms: Date.now() - t0, arrived: false };
}

// Hold keys until pred(sonar) is true (closed loop on SONAR), max timeoutMs.
export async function holdUntil(page, sleep, keys, pred, { timeoutMs = 10000 } = {}) {
  for (const k of keys) await page.keyboard.down(k);
  const t0 = Date.now();
  let s = null;
  try {
    while (Date.now() - t0 < timeoutMs) {
      s = await sonar(page);
      if (s && pred(s)) return { ...s, ms: Date.now() - t0, ok: true };
      await sleep(50);
    }
    return { ...(s || {}), ms: Date.now() - t0, ok: false };
  } finally {
    for (const k of [...keys].reverse()) await page.keyboard.up(k);
  }
}

// Trading Floor player position from the scene hook (probe-install.mjs must have run since the last reload).
export async function tfPlayer(page) {
  return page.evaluate(() => {
    for (const s of window.__cvScenes || []) {
      const rig = s.getObjectByName('VRMHumanoidRig');
      if (rig) {
        let root = rig; while (root.parent && root.parent.type !== 'Scene') root = root.parent;
        const p = rig.getWorldPosition(rig.position.clone());
        const q = rig.getWorldQuaternion(rig.quaternion.clone());
        const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
        return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), yawDeg: Math.round((yaw * 180) / Math.PI) };
      }
    }
    return null;
  });
}

// Hold keys until pred(player) is true (closed loop on the Trading Floor scene), max timeoutMs.
export async function tfHoldUntil(page, sleep, keys, pred, { timeoutMs = 8000, trace = null } = {}) {
  for (const k of keys) await page.keyboard.down(k);
  const t0 = Date.now();
  let p = null;
  try {
    while (Date.now() - t0 < timeoutMs) {
      p = await tfPlayer(page);
      trace?.push({ t: Date.now() - t0, ...p });
      if (p && pred(p)) return { ...p, ms: Date.now() - t0, ok: true };
      await sleep(40);
    }
    return { ...(p || {}), ms: Date.now() - t0, ok: false };
  } finally {
    for (const k of [...keys].reverse()) await page.keyboard.up(k);
  }
}

// HARD SAFETY for the film account: abort any launch / seat write while this step runs,
// and log every non-GET arena request. One arena agent per account: a rehearsal launch kills the shot.
// guard(page, log, { allow: true }) only logs (the REAL launch/sit, FILM_LAUNCH=GO); it never aborts then.
export async function guard(page, log, { allow = false } = {}) {
  if (allow) log('GUARD OFF (FILM_LAUNCH=GO): launch and seat writes go through');
  else await page.route(/\/api\/floor\/arena\/me\/(launch|seat)/, (route) => {
    const r = route.request();
    if (r.method() !== 'GET') { log(`GUARD ABORTED ${r.method()} ${r.url()}`); return route.abort(); }
    return route.continue();
  });
  page.on('response', (r) => {
    if (/\/api\/floor\/arena\/me\/(launch|seat)/.test(r.url()) && r.request().method() !== 'GET') log(`NET RESPONSE ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on('request', (r) => {
    if (/\/api\/floor\//.test(r.url()) && r.method() !== 'GET') log(`NET ${r.method()} ${r.url()}`);
  });
}

export const E_HOLD_MS = 150; // a sub-frame press is missed by the per-frame input edge
export async function pressKey(page, sleep, key) {
  await page.keyboard.down(key);
  await sleep(E_HOLD_MS);
  await page.keyboard.up(key);
}
export async function pressE(page, sleep) { await pressKey(page, sleep, 'e'); }
export async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
}
export async function waitFor(page, sleep, fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await sleep(50);
  }
  return -1;
}
export function clock() {
  const t0 = Date.now();
  return () => `t+${((Date.now() - t0) / 1000).toFixed(2)}`;
}
// Text of the smallest element whose text matches re (for panels and pop-ups).
export async function panelText(page, selectorOrRe) {
  return page.evaluate((s) => {
    let el = null;
    if (s.sel) el = document.querySelector(s.sel);
    else {
      const re = new RegExp(s.re, 'i');
      el = [...document.querySelectorAll('div,section,aside,dialog')]
        .filter((d) => re.test(d.innerText || ''))
        .sort((a, b) => a.innerText.length - b.innerText.length)[0] || null;
    }
    return el ? el.innerText.replace(/\s+/g, ' ').slice(0, 2000) : '';
  }, selectorOrRe);
}
