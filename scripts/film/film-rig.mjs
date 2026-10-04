#!/usr/bin/env node
// ClawVille film rig: a headed capture Chrome, an ffmpeg gfxcapture recorder, and a CDP step runner.
// Manual: scripts/film/README.md (+ docs/video-production.md). Local state lives in .film/ (git-ignored).
//
//   node scripts/film/film-rig.mjs chrome [url] [--fresh]  start (or reuse) the capture Chrome + title keeper
//   node scripts/film/film-rig.mjs rec <name> <seconds>    record the capture window -> .film/takes/<name>.mp4
//   node scripts/film/film-rig.mjs do <step>               run `export default async ({page, log, sleep, ...}) => {}`
//                                                          (<step> = a path, or a name in scripts/film/steps/ or .film/steps/)
//   node scripts/film/film-rig.mjs take <name> <s> <step>  rec + do together; the step starts with the footage
//   node scripts/film/film-rig.mjs check <name>            ffprobe, unique frames, freezes, luma, 3 stills
//   node scripts/film/film-rig.mjs status                  browser, pages, title keeper
//   node scripts/film/film-rig.mjs title-keeper            (internal) keep document.title = CV-CAPTURE
//
// rec and do never depend on each other. Claude Code runs two Bash calls in sequence, so use `take` to overlap them.
// Long-lived processes (Chrome, the title keeper) start through the managed launcher
// (~/.local/bin/itachi-dev.ps1) as RETAINED tasks: they survive the end of a turn, stop 120 minutes after
// the start, and stop when the owner session ends.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILM = join(ROOT, '.film');
const TAKES = join(FILM, 'takes');
const PROFILE = join(FILM, 'profile');
const LOG = join(FILM, 'rig.log');
const KEEPER_BEAT = join(FILM, 'title-keeper.json');
const PORT = Number(process.env.FILM_CDP_PORT || 9333);
const CDP = `http://127.0.0.1:${PORT}`;
const TITLE = 'CV-CAPTURE';
const TITLE_RE = `^${TITLE}`;
const CHROME = process.env.FILM_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LAUNCHER = join(homedir(), '.local', 'bin', 'itachi-dev.ps1');
const DEFAULT_URL = 'https://staging.clawville.world/game';

// Runs in every page: pins the window title so gfxcapture can find the capture window by regex.
const TITLE_SCRIPT = `(() => {
  if (window.__cvTitleTimer) return;
  const fix = () => { if (document.title !== ${JSON.stringify(TITLE)}) document.title = ${JSON.stringify(TITLE)}; };
  window.__cvTitleTimer = setInterval(fix, 500);
  document.addEventListener('DOMContentLoaded', fix);
  fix();
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(scope, msg) {
  mkdirSync(FILM, { recursive: true });
  const line = `${new Date().toISOString()} ${scope} ${msg}`;
  appendFileSync(LOG, line + '\n');
  console.log(line);
}

function playwright() {
  const req = createRequire(join(FILM, 'package.json'));
  try {
    return req('playwright-core');
  } catch {
    throw new Error('playwright-core is missing: run `npm i playwright-core` inside .film/');
  }
}

async function cdpVersion() {
  try {
    const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function cdpPages() {
  try {
    const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? (await res.json()).filter((t) => t.type === 'page') : [];
  } catch {
    return [];
  }
}

async function connect() {
  if (!(await cdpVersion())) throw new Error(`no capture Chrome on ${CDP}: run \`film-rig.mjs chrome\` first`);
  return playwright().chromium.connectOverCDP(CDP, { timeout: 15000 });
}

function pickPage(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages());
  return pages.find((p) => p.url().includes('clawville.world')) || pages[0] || null;
}

async function stampTitles(browser) {
  for (const page of browser.contexts().flatMap((c) => c.pages())) {
    await page.evaluate(TITLE_SCRIPT).catch(() => {});
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Starts a long-lived process under the managed launcher (a hook blocks detached shells).
// RetainMinutes is required: the dev-server-lifecycle hook runs `-Action Stop` at the end of EVERY
// Claude turn and stops each non-retained task (seen 2026-10-02 01:37:51Z). The launcher caps it at 120.
const RETAIN_MINUTES = Number(process.env.FILM_RETAIN_MINUTES || 120);
function launcherStart(name, file, args, cwd) {
  const sid = process.env.FILM_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) throw new Error('no session id: set FILM_SESSION_ID or run inside a Claude Code session');
  const ps =
    `$a = @(${args.map(psQuote).join(', ')}); ` +
    `& ${psQuote(LAUNCHER)} -Action Start -SessionId ${psQuote(sid)} -Name ${psQuote(name)} ` +
    `-FilePath ${psQuote(file)} -ArgumentList $a -WorkingDirectory ${psQuote(cwd)} -RetainMinutes ${RETAIN_MINUTES}`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`launcher refused ${name}: ${(r.stderr || r.stdout || '').trim()}`);
  try {
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  } catch {
    return { raw: r.stdout.trim() };
  }
}

function keeperAlive() {
  try {
    const beat = JSON.parse(readFileSync(KEEPER_BEAT, 'utf8'));
    return Date.now() - Date.parse(beat.at) < 15000 ? beat : null;
  } catch {
    return null;
  }
}

async function cmdChrome(argv) {
  const fresh = argv.includes('--fresh');
  const url = argv.find((a) => !a.startsWith('--')) || null;
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(TAKES, { recursive: true });

  if (fresh && (await cdpVersion())) {
    log('chrome', 'fresh: closing the running capture Chrome');
    const b = await connect();
    const s = await b.newBrowserCDPSession();
    await s.send('Browser.close').catch(() => {});
    for (let i = 0; i < 40 && (await cdpVersion()); i++) await sleep(250);
    rmSync(KEEPER_BEAT, { force: true });
  }

  let launched = null;
  if (await cdpVersion()) {
    log('chrome', `reuse: capture Chrome already on ${CDP}`);
  } else {
    const args = [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      '--use-angle=d3d11',
      '--window-size=1920,1080',
      '--window-position=0,0',
      ...(process.env.FILM_WINDOWED === '1' ? [] : ['--kiosk']),
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      url || DEFAULT_URL,
    ];
    launched = launcherStart('cv-film-chrome', CHROME, args, FILM);
    log('chrome', `launched via launcher: ${JSON.stringify({ id: launched.id, rootPid: launched.rootPid, expiry: launched.expiry })}`);
    for (let i = 0; i < 120 && !(await cdpVersion()); i++) await sleep(250);
    if (!(await cdpVersion())) throw new Error(`Chrome did not open ${CDP} within 30 s`);
  }

  if (!keeperAlive()) {
    rmSync(KEEPER_BEAT, { force: true });
    const k = launcherStart('cv-film-title', process.execPath, [fileURLToPath(import.meta.url), 'title-keeper'], ROOT);
    log('chrome', `title keeper via launcher: ${JSON.stringify({ id: k.id, rootPid: k.rootPid, expiry: k.expiry })}`);
    for (let i = 0; i < 60 && !keeperAlive(); i++) await sleep(250);
    if (!keeperAlive()) log('chrome', 'WARN title keeper has no heartbeat yet');
  }

  const browser = await connect();
  let page = pickPage(browser);
  if (!page) page = await browser.contexts()[0].newPage();
  if (url && !launched && page.url() !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.evaluate(TITLE_SCRIPT).catch(() => {});
  await sleep(1000);
  const s = await page.context().newCDPSession(page);
  const win = await s.send('Browser.getWindowForTarget').catch(() => null);
  const info = await page
    .evaluate(async () => {
      let gpu = 'no navigator.gpu';
      try {
        const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
        gpu = a ? `${a.info?.vendor || '?'} ${a.info?.architecture || ''} ${a.info?.description || ''}`.trim() : 'no adapter';
      } catch (e) {
        gpu = `adapter error: ${e}`;
      }
      return {
        url: location.href,
        title: document.title,
        inner: `${innerWidth}x${innerHeight}`,
        dpr: devicePixelRatio,
        screen: `${screen.width}x${screen.height}`,
        webgpu: gpu,
      };
    })
    .catch((e) => ({ error: String(e) }));
  log('chrome', `ready ${JSON.stringify({ ...info, window: win?.bounds || null })}`);
  process.exit(0);
}

async function cmdTitleKeeper() {
  const browser = await connect();
  const ctx = browser.contexts()[0];
  await ctx.addInitScript(TITLE_SCRIPT);
  await stampTitles(browser);
  ctx.on('page', (p) => p.evaluate(TITLE_SCRIPT).catch(() => {}));
  const beat = () => writeFileSync(KEEPER_BEAT, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  beat();
  log('title', `keeper attached pid=${process.pid}`);
  browser.on('disconnected', () => {
    rmSync(KEEPER_BEAT, { force: true });
    log('title', 'keeper: Chrome disconnected, exiting');
    process.exit(0);
  });
  for (;;) {
    await sleep(5000);
    beat();
    await stampTitles(browser);
  }
}

function runFfmpeg(args, onLine) {
  return new Promise((res) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let buf = '';
    p.stderr.on('data', (d) => {
      const t = d.toString();
      err += t;
      buf += t;
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop();
      for (const line of parts) onLine?.(line);
    });
    p.on('close', (code) => res({ code, err }));
  });
}

async function cmdRec(name, seconds) {
  if (!/^[A-Za-z0-9._-]+$/.test(name || '')) throw new Error('rec <name> <seconds>: name must be [A-Za-z0-9._-]+');
  const sec = Number(seconds);
  if (!(sec > 0)) throw new Error('rec <name> <seconds>: seconds must be > 0');
  mkdirSync(TAKES, { recursive: true });
  const out = join(TAKES, `${name}.mp4`);
  if (existsSync(out)) throw new Error(`${out} exists: pick a new take name (the rig never overwrites a take)`);
  const args = [
    '-hide_banner', '-nostdin',
    '-f', 'lavfi', '-i', `gfxcapture=window_title=${TITLE_RE}:max_framerate=60:capture_cursor=false`,
    '-vf', 'hwdownload,format=bgra,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=60',
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-t', String(sec), out,
  ];
  let stamped = false;
  for (let attempt = 1; attempt <= 40; attempt++) {
    log('rec', `spawn ${name} attempt=${attempt}`);
    let started = false;
    const r = await runFfmpeg(args, (line) => {
      if (!started && line.startsWith('Output #0')) {
        started = true;
        log('rec', `start ${name}`);
      }
    });
    writeFileSync(join(TAKES, `${name}.ffmpeg.log`), r.err);
    const size = existsSync(out) ? statSync(out).size : 0;
    if (r.code === 0 && size > 0) {
      const frames = [...r.err.matchAll(/frame=\s*(\d+)/g)].pop()?.[1] ?? '?';
      log('rec', `stop ${name} frames=${frames} bytes=${size} -> ${out}`);
      return;
    }
    if (/Failed to setup graphics capture/.test(r.err) && size === 0) {
      if (existsSync(out)) rmSync(out, { force: true });
      if (!stamped && (await cdpVersion())) {
        stamped = true;
        const b = await connect().catch(() => null);
        if (b) await stampTitles(b);
        log('rec', `no window /${TITLE_RE}/ yet: stamped the title over CDP, retrying`);
      }
      await sleep(500);
      continue;
    }
    log('rec', `FAIL ${name} exit=${r.code}: ${r.err.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
    process.exit(1);
  }
  log('rec', `FAIL ${name}: no window matching /${TITLE_RE}/ after 40 attempts`);
  process.exit(1);
}

async function cmdDo(stepPath) {
  process.exit(await runStep(stepPath));
}

// rec + do in ONE foreground call: Claude Code runs two Bash calls one after the other, not in parallel.
// The step starts when ffmpeg opens the output (the `rec start` line), so step time 0 ~= footage time 0.
async function cmdTake(name, seconds, stepPath) {
  if (!stepPath) throw new Error('take <name> <seconds> <step.mjs>');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'rec', name, seconds], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const recDone = new Promise((res) => child.on('close', res));
  const started = await new Promise((res) => {
    let buf = '';
    const timer = setTimeout(() => res(false), 30000);
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      buf += d.toString();
      if (buf.includes(` rec start ${name}`)) {
        clearTimeout(timer);
        res(true);
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      res(false);
    });
  });
  if (!started) {
    const code = await recDone;
    log('take', `FAIL ${name}: the recording did not start (rec exit=${code}); the step did not run`);
    process.exit(1);
  }
  const stepCode = await runStep(stepPath).catch((e) => {
    log('take', `step ERROR ${e?.message || e}`);
    return 1;
  });
  const recCode = await recDone;
  log('take', `${name} rec exit=${recCode} step exit=${stepCode}`);
  process.exit(recCode || stepCode);
}

// A step is a path (relative to the cwd), or a bare name found in scripts/film/steps/ (the tracked library)
// and then in .film/steps/ (git-ignored local scratch steps), with or without ".mjs".
function resolveStep(stepPath) {
  const tries = [resolve(process.cwd(), stepPath)];
  for (const dir of [join(ROOT, 'scripts', 'film', 'steps'), join(FILM, 'steps')]) {
    tries.push(join(dir, stepPath), join(dir, `${stepPath}.mjs`));
  }
  const hit = tries.find((p) => existsSync(p));
  if (!hit) throw new Error(`step not found: ${stepPath} (looked in the cwd, scripts/film/steps/, .film/steps/)`);
  return hit;
}

async function runStep(stepPath) {
  if (!stepPath) throw new Error('do <step.mjs>');
  const abs = resolveStep(stepPath);
  const mod = await import(pathToFileURL(abs).href);
  if (typeof mod.default !== 'function') throw new Error(`${abs} has no default export function`);
  const step = basename(abs).replace(/\.m?js$/, '');
  const browser = await connect();
  const page = pickPage(browser);
  if (!page) throw new Error('the capture Chrome has no page');
  const slog = (msg) => log(`do:${step}`, msg);
  const helpers = {
    page,
    browser,
    log: slog,
    sleep,
    async holdKey(key, ms) {
      slog(`holdKey ${key} down`);
      await page.keyboard.down(key);
      await sleep(ms);
      await page.keyboard.up(key);
      slog(`holdKey ${key} up (${ms} ms)`);
    },
    async press(key) {
      await page.keyboard.press(key);
      slog(`press ${key}`);
    },
    async clickText(text, opts = {}) {
      await page.getByText(text, { exact: !!opts.exact }).first().click({ timeout: opts.timeout ?? 10000 });
      slog(`clickText ${JSON.stringify(text)}`);
    },
    async waitText(text, timeoutMs = 15000) {
      await page.getByText(text).first().waitFor({ state: 'visible', timeout: timeoutMs });
      slog(`waitText ${JSON.stringify(text)} visible`);
    },
    // DOM panels only: a CDP screenshot cannot see the WebGPU canvas.
    async screenshotDom(name) {
      const file = join(TAKES, `${name}.dom.png`);
      await page.screenshot({ path: file });
      slog(`screenshotDom ${file}`);
      return file;
    },
    async goto(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.evaluate(TITLE_SCRIPT).catch(() => {});
      slog(`goto ${url}`);
    },
  };
  slog(`start url=${page.url()}`);
  try {
    await mod.default(helpers);
    slog('end');
    return 0;
  } catch (e) {
    slog(`ERROR ${e?.stack || e}`);
    return 1;
  }
}

async function cmdCheck(name) {
  const file = join(TAKES, `${name}.mp4`);
  if (!existsSync(file)) throw new Error(`${file} not found`);
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(pr.stdout);
  const st = j.streams[0];
  const dur = Number(j.format.duration);
  const nf = (args) => spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, ...args, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const unique = [...nf(['-vf', 'mpdecimate']).matchAll(/frame=\s*(\d+)/g)].pop()?.[1];
  const freezes = [...nf(['-vf', 'freezedetect=n=-60dB:d=0.5']).matchAll(/freeze_duration: ([\d.]+)/g)].map((m) => Number(m[1]));
  const yavg = [...nf(['-vf', 'scale=160:90,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG'])
    .matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const luma = yavg.length ? yavg.reduce((a, b) => a + b, 0) / yavg.length : NaN;
  const times = dur > 2 ? [1, Math.round(dur / 2), Math.floor(dur - 1)] : [0, dur / 2];
  const stills = times.map((t) => {
    const out = join(TAKES, `${name}-still-${t}s.png`);
    spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', out]);
    return out;
  });
  const report = {
    file, size: `${st.width}x${st.height}`, fps: st.avg_frame_rate, frames: Number(st.nb_read_frames),
    duration: dur, uniqueFrames: Number(unique), freezes: freezes.length, frozenSeconds: Number(freezes.reduce((a, b) => a + b, 0).toFixed(2)),
    meanLuma: Number(luma.toFixed(1)), stills,
  };
  log('check', `${name} ${JSON.stringify(report)}`);
}

async function cmdStatus() {
  const v = await cdpVersion();
  console.log(JSON.stringify({
    cdp: v ? { browser: v.Browser, port: PORT } : 'down',
    pages: (await cdpPages()).map((p) => ({ title: p.title, url: p.url })),
    titleKeeper: keeperAlive() || 'down',
    log: LOG,
  }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  chrome: () => cmdChrome(rest),
  rec: () => cmdRec(rest[0], rest[1]),
  do: () => cmdDo(rest[0]),
  take: () => cmdTake(rest[0], rest[1], rest[2]),
  check: () => cmdCheck(rest[0]),
  status: () => cmdStatus(),
  'title-keeper': () => cmdTitleKeeper(),
};
if (!commands[cmd]) {
  console.error('usage: film-rig.mjs chrome [url] [--fresh] | rec <name> <seconds> | do <step.mjs> | take <name> <seconds> <step.mjs> | check <name> | status');
  process.exit(2);
}
commands[cmd]().catch((e) => {
  log('rig', `ERROR ${cmd}: ${e?.message || e}`);
  process.exit(1);
});
