#!/usr/bin/env node
// Staging-only setup for the Trading Floor demo film: real accounts whose real
// paper agents trade on the arena board beside the house agents.
//
//   node scripts/film/demo-accounts.mjs demo            sign up + launch + seat the demo accounts
//   node scripts/film/demo-accounts.mjs film            sign up the film account only (it launches on camera)
//   node scripts/film/demo-accounts.mjs status          print each account's arena agent (no secrets)
//
// Secrets (passwords, session cookies, the one-time wallet secret) go to
// .film/accounts/<key>.json (git-ignored) and are never printed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const API = 'https://api-staging.clawville.world';
const ORIGIN = 'https://staging.clawville.world';
const DIR = join(process.cwd(), '.film', 'accounts');
mkdirSync(DIR, { recursive: true });

// Five demo players (a mix of templates, one rule edited where noted) + the film account.
const DEMO = [
  { key: 'demo-kelp', name: 'Kelp Capital', templateId: 'genesis', seatIndex: 1, edit: (p) => { p.exits.max_hold_s = 1200; } },
  { key: 'demo-coral', name: 'Coral Quant', templateId: 'dip-hunter', seatIndex: 3 },
  { key: 'demo-tidepool', name: 'Tidepool Trader', templateId: 'late-bloomer', seatIndex: 5 },
  { key: 'demo-deepblue', name: 'Deep Blue Desk', templateId: 'midcap-climber', seatIndex: 7 },
  { key: 'demo-brine', name: 'Brine Fund', templateId: 'genesis', seatIndex: 9, edit: (p) => { p.filters.mcap_max = 200000; } },
];
const FILM = { key: 'film', name: 'Reef Rookie' };

const emailOf = (key) => `cv-${key}-${Date.now().toString(36)}@clawville.guest`;
const load = (key) => (existsSync(join(DIR, `${key}.json`)) ? JSON.parse(readFileSync(join(DIR, `${key}.json`), 'utf8')) : null);
const save = (key, rec) => writeFileSync(join(DIR, `${key}.json`), JSON.stringify(rec, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function call(method, path, { cookie, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Origin: ORIGIN,
      Referer: ORIGIN + '/',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json, text, setCookie };
}

const cookieFrom = (setCookie) => setCookie.map((c) => c.split(';')[0]).filter((c) => c.includes('=') && !c.endsWith('=')).join('; ');

async function ensureAccount(spec) {
  let rec = load(spec.key);
  if (rec?.cookie) {
    const me = await call('GET', '/api/auth/me', { cookie: rec.cookie });
    if (me.status === 200 && me.json?.user) return rec;
    const login = await call('POST', '/api/auth/login', { body: { email: rec.email, password: rec.password } });
    if (login.status !== 200) throw new Error(`${spec.key}: login ${login.status} ${login.text.slice(0, 200)}`);
    rec.cookie = cookieFrom(login.setCookie);
    save(spec.key, rec);
    return rec;
  }
  const email = emailOf(spec.key);
  const password = randomBytes(18).toString('base64url');
  const res = await call('POST', '/api/auth/signup', { body: { email, password, name: spec.name } });
  if (res.status !== 200) throw new Error(`${spec.key}: signup ${res.status} ${res.text.slice(0, 200)}`);
  rec = { key: spec.key, email, password, name: spec.name, cookie: cookieFrom(res.setCookie), signup: res.json, createdAt: new Date().toISOString() };
  save(spec.key, rec);
  log(`${spec.key}: signed up (${email}), avatar ${res.json?.avatar?.id ?? '?'}`);
  return rec;
}

async function launchAndSeat(spec, rec, templates) {
  let me = await call('GET', '/api/floor/arena/me', { cookie: rec.cookie });
  if (me.status !== 200) throw new Error(`${spec.key}: /me ${me.status} ${me.text.slice(0, 200)}`);
  if (!me.json?.agent) {
    const tpl = templates.find((t) => t.id === spec.templateId);
    const params = structuredClone(tpl.params);
    spec.edit?.(params);
    const res = await call('POST', '/api/floor/arena/me/launch', {
      cookie: rec.cookie,
      body: { templateId: spec.templateId, params, mode: 'paper', name: spec.name },
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`${spec.key}: launch ${res.status} ${res.text.slice(0, 300)}`);
    log(`${spec.key}: launched ${spec.name} from ${spec.templateId}`);
    for (let i = 0; i < 3; i++) {
      me = await call('GET', '/api/floor/arena/me', { cookie: rec.cookie });
      const st = me.json?.provision?.state ?? me.json?.agent?.provisionState;
      if (st === 'ready' || st === 'failed') { log(`${spec.key}: provision ${st}`); break; }
      await sleep(5000); // the provisioning tick runs every 30 s; seating does not wait for it
    }
  }
  const seat = await call('POST', '/api/floor/arena/me/seat', { cookie: rec.cookie, body: { seated: true, seatIndex: spec.seatIndex } });
  if (seat.status !== 200) throw new Error(`${spec.key}: seat ${seat.status} ${seat.text.slice(0, 200)}`);
  return seat.json?.agent;
}

function summary(spec, agent) {
  if (!agent) return `${spec.key}: no arena agent`;
  const pick = (k) => agent[k] ?? agent[k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())];
  return `${spec.key}: ${pick('name')} id=${pick('id')} template=${pick('templateId')} seated=${pick('seated')} seat=${pick('seatIndex')} status=${pick('status')} provision=${pick('provisionState')}`;
}

const cmd = process.argv[2];
if (cmd === 'demo') {
  const t = await call('GET', '/api/floor/arena/templates');
  const templates = t.json.templates;
  for (const [i, spec] of DEMO.entries()) {
    if (i > 0 && !load(spec.key)) await sleep(13000); // signup limit: 5 per minute per IP
    const rec = await ensureAccount(spec);
    const agent = await launchAndSeat(spec, rec, templates);
    log(summary(spec, agent));
  }
} else if (cmd === 'film') {
  const rec = await ensureAccount(FILM);
  const me = await call('GET', '/api/floor/arena/me', { cookie: rec.cookie });
  log(`film: ${rec.email} /me ${me.status} agent=${me.json?.agent ? 'YES (cannot film the launch)' : 'none (ready to launch on camera)'}`);
} else if (cmd === 'status') {
  for (const spec of [...DEMO, FILM]) {
    const rec = load(spec.key);
    if (!rec) { log(`${spec.key}: no account`); continue; }
    const me = await call('GET', '/api/floor/arena/me', { cookie: rec.cookie });
    log(me.status === 200 ? `${summary(spec, me.json?.agent)} provisionState=${me.json?.provision?.state ?? '-'}` : `${spec.key}: /me ${me.status}`);
  }
} else {
  console.log('usage: demo-accounts.mjs demo | film | status');
}
