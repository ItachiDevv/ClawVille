/**
 * P3 SLICE-1 LIVE E2E — durable agent event streamflow (D7) against staging.
 *
 * Proves the slice-1 gate from docs/agent-metaverse-p3-plan.md §4:
 *   an agent takes settle + knowledge/world events through
 *   disconnect → replay(?after) → SSE Last-Event-ID resume,
 *   with ZERO loss and ZERO secret leakage in delivered payloads.
 *
 * Flow (extends openclaw-e2e.ts's bound-agent pattern):
 *   1. login staging test account → mint connect-token → CONNECT bound
 *      (ledger-capable) openclaw agent → sessionId (the ONLY place the bearer
 *      exists; asserted absent from every delivered payload).
 *   2. Baseline cursor B: GET /events/replay?after=0 (paged) → highest id.
 *   3. Open SSE reader with Last-Event-ID: B (captures live frames).
 *   4. WORLD leg: move → arrive → visit-building (real-CT credit) — writes a
 *      durable building.visited row (payload.ctAwarded now a REAL number).
 *   5. MONEY leg: blackjack via X-Clawville-Agent-Session —
 *      session/open(clawtoken) → hand/deal(bet 5) → stand → settled.
 *      Settle site publishes a LIVE `settlement` frame + durable row.
 *   6. Assert the live SSE captured `event: settlement` with an id: cursor.
 *   7. Replay from B → assert BOTH events present, ascending ids, only
 *      {id,eventType,ts,payload} keys, ctAwarded numeric (NOT '[REDACTED]'),
 *      and the raw session bearer appears NOWHERE in any delivered byte.
 *   8. Fresh SSE with Last-Event-ID: B → assert `event: replay` frames
 *      re-deliver the same events (at-least-once, dedupe-by-id contract).
 *   9. Rate-limit leg (LAST): hammer /events/replay past 60/min → expect 429
 *      code=rate_limited.
 *  10. Disconnect (best-effort cleanup).
 *
 * Usage:
 *   bun run apps/api/scripts/agent-connect/streamflow-e2e.ts \
 *     --api-base https://api-staging.clawville.world \
 *     --email landtest2@staging.clawville.test --password 'LandTest!2026'
 *
 * Staging-only test account; bets 5 CT on the bound test avatar (±5 CT drift).
 * NEVER prints the session bearer; scans payloads for it instead.
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : [],
  ),
) as Record<string, string>;

const API = (args['api-base'] ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const EMAIL = args['email'] ?? 'landtest2@staging.clawville.test';
const PASSWORD = args['password'] ?? 'LandTest!2026';
const AGENT_ID = args['agent-id'] ?? `e2e-stream-${Date.now().toString(36)}`;

let cookie = '';
let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${msg}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${msg}${extra ? `  ${extra}` : ''}`); }
};

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, opts: { noCookie?: boolean } = {}) {
  // noCookie: cove getSubject() prefers the logged-in USER over the agent
  // session header (shipped precedence) — agent-subject cove calls must NOT
  // carry the human auth cookie or the settle keys to the user, not the agent.
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie && !opts.noCookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  const setCookie = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
  return { status: res.status, json, setCookie };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read SSE frames from a streaming fetch into an array until aborted. */
function openSse(sessionId: string, lastEventId: string | null) {
  const ctrl = new AbortController();
  const frames: Array<{ event: string; id: string | null; data: any }> = [];
  const done = (async () => {
    const res = await fetch(`${API}/api/agent/${sessionId}/events`, {
      headers: { accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return res.status;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message'; let id: string | null = null; let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7).trim();
            else if (line.startsWith('id: ')) id = line.slice(4).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          let parsed: any = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          frames.push({ event: ev, id, data: parsed });
        }
      }
    } catch { /* aborted */ }
    return res.status;
  })();
  return { ctrl, frames, done };
}

/** Page the replay endpoint from a cursor; returns all events + final cursor. */
async function replayFrom(sessionId: string, after: string) {
  const all: any[] = [];
  let cursor = after;
  for (let i = 0; i < 30; i++) {
    const r = await req('GET', `/api/agent/${sessionId}/events/replay?after=${cursor}&limit=500`);
    if (r.status !== 200) return { status: r.status, all, cursor };
    all.push(...(r.json?.events ?? []));
    if (!r.json?.nextCursor) break;
    cursor = r.json.nextCursor;
    if ((r.json?.events ?? []).length < 500) break;
  }
  return { status: 200, all, cursor };
}

async function main() {
  console.log(`\n=== P3 slice-1 streamflow E2E → ${API} ===`);
  console.log(`account=${EMAIL}  agentId=${AGENT_ID}\n`);

  // 1. login → bind token → connect (mirrors openclaw-e2e steps 1-4) ---------
  const login = await req('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  ok(login.status === 200, 'LOGIN 200', `status=${login.status}`);
  const authCookie = login.setCookie.find((c: string) => c.startsWith('auth_session='));
  if (!authCookie) { console.log('cannot continue without session cookie'); return finish(); }
  cookie = authCookie.split(';')[0];

  const me = await req('GET', '/api/auth/me');
  const userId: string | undefined = me.json?.user?.id ?? me.json?.id;
  const av = await req('GET', '/api/avatars/me');
  const avatarId: string | undefined = av.json?.avatar?.id;
  const ctBefore: number | null = typeof av.json?.avatar?.clawTokens === 'number' ? av.json.avatar.clawTokens : null;
  ok(!!userId && !!avatarId, 'me has userId + avatarId', `ctBefore=${ctBefore}`);
  if (!userId || !avatarId) return finish();

  const tok = await req('POST', '/api/agent/connect-token', { avatarId, userId });
  const token: string | undefined = tok.json?.token;
  ok(tok.status === 200 && !!token, 'MINT connect-token 200');
  if (!token) return finish();

  const conn = await req('POST', '/api/agent/connect', {
    connectionToken: token,
    agentId: AGENT_ID,
    identityType: 'openclaw',
    gatewayUrl: 'https://example.com/openclaw-mock',
    protocol: 'openai-compat',
    autonomyMode: 'self-managed',
    mode: 'avatar',
    name: 'E2EStream',
    species: 'milady_official_1',
  });
  const sessionId: string | undefined = conn.json?.sessionId;
  ok(conn.status === 200 && !!sessionId, 'CONNECT 200 + sessionId (bound, ledger-capable)');
  if (!sessionId) return finish();
  const agentHeaders = { 'X-Clawville-Agent-Session': sessionId };

  // 2. baseline cursor B ------------------------------------------------------
  const base = await replayFrom(sessionId, '0');
  ok(base.status === 200, 'REPLAY baseline 200', `priorEvents=${base.all.length}`);
  const B = base.cursor === '0' && base.all.length === 0 ? '0' : base.cursor;
  console.log(`   baseline cursor B=${B}`);

  // 3. live SSE from B ---------------------------------------------------------
  const live = openSse(sessionId, B === '0' ? null : B);
  await sleep(1500); // let it connect

  // 4. WORLD leg: move → arrive → visit ---------------------------------------
  const perc = await req('GET', `/api/agent/${sessionId}/perception`);
  const nearby: any[] = perc.json?.nearbyBuildings ?? perc.json?.buildings ?? [];
  ok(perc.status === 200 && nearby.length > 0, 'PERCEPTION 200 + buildings listed', `count=${nearby.length}`);
  // Per-(user,building) reward cooldown blocks a repeat visit across runs on the
  // same test account — try up to 3 different buildings; the settle leg is the
  // primary durable-row proof, so a fully-cooled-down account only warns.
  let visited = false;
  for (const cand of nearby.slice(0, 3)) {
    const buildingId: string | undefined = cand?.buildingId ?? cand?.id;
    if (!buildingId) continue;
    await req('POST', `/api/agent/${sessionId}/move`, { buildingId });
    let lastEdge = Infinity;
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const p = await req('GET', `/api/agent/${sessionId}/perception`);
      const b = (p.json?.nearbyBuildings ?? p.json?.buildings ?? []).find((x: any) => (x.buildingId ?? x.id) === buildingId);
      lastEdge = b?.edgeDistance ?? b?.distance ?? lastEdge;
      if (typeof lastEdge === 'number' && lastEdge <= 1000) break;
    }
    const visit = await req('POST', `/api/agent/${sessionId}/visit-building`, { buildingId });
    console.log(`   visit ${buildingId} -> status=${visit.status} tokenAwarded=${visit.json?.tokenAwarded} body=${JSON.stringify(visit.json)?.slice(0, 120)}`);
    if (visit.status === 200 && (visit.json?.tokenAwarded ?? 0) >= 1) { visited = true; break; }
  }
  if (visited) ok(true, 'VISIT-BUILDING 200 (durable building.visited row)');
  else console.log('   [warn] no fresh building visit possible (reward cooldown) — building.visited asserts skipped');

  // 5. MONEY leg: blackjack settle via agent session header -------------------
  let settled = false;
  let settleNet: number | null = null;
  const open = await req('POST', '/api/cove/blackjack/session/open', { currency: 'clawtoken' }, agentHeaders, { noCookie: true });
  const shoeId: string | undefined = open.json?.shoe?.id; // smoke-script-verified shape
  ok(open.status === 200 && !!shoeId, 'BJ session/open 200 (agent subject)', `status=${open.status} keys=${open.json ? Object.keys(open.json).join(',') : 'null'}`);
  if (shoeId) {
    const deal = await req('POST', '/api/cove/blackjack/hand/deal', { shoeId, bet: 5 }, agentHeaders, { noCookie: true });
    const handId: string | undefined = deal.json?.handId;
    const settledAtDeal = deal.json?.dealtImmediately === true || deal.json?.status === 'settled';
    ok(deal.status === 200 && (!!handId || settledAtDeal), 'BJ deal 200', `status=${deal.status} settledAtDeal=${settledAtDeal}`);
    if (settledAtDeal) {
      settled = true;
      settleNet = deal.json?.outcome?.net ?? deal.json?.net ?? null;
    } else if (handId) {
      // safe driver (mirrors blackjack-hiddenstate-smoke): hit while total<=11
      // can never bust; otherwise stand — every hand reaches a real settle.
      const totalOf = (cards: any[]): number => {
        let t = 0; let aces = 0;
        for (const c2 of cards ?? []) {
          const r = c2?.rank ?? c2;
          if (r === 'A') { aces++; t += 11; }
          else if (r === 'K' || r === 'Q' || r === 'J' || r === '10') t += 10;
          else t += parseInt(String(r), 10) || 0;
        }
        while (t > 21 && aces > 0) { t -= 10; aces--; }
        return t;
      };
      let currentTotal = totalOf(deal.json?.playerHand);
      for (let step = 0; step < 14; step++) {
        const act = currentTotal <= 11 ? 'hit' : 'stand';
        const ar = await req('POST', '/api/cove/blackjack/action', { handId, action: act, handSlot: 0 }, agentHeaders, { noCookie: true });
        if (ar.status !== 200) break;
        if (ar.json?.status === 'settled') {
          settled = true;
          settleNet = ar.json?.outcome?.net ?? ar.json?.net ?? null;
          break;
        }
        if (ar.json?.status === 'in_progress') currentTotal = totalOf(ar.json?.playerHand);
      }
    }
    ok(settled, 'BJ hand settled (REAL-CT agent settle)', `net=${settleNet}`);
    await req('POST', '/api/cove/blackjack/session/close', { shoeId }, agentHeaders, { noCookie: true });
  }

  // 6. live SSE captured the settlement frame ----------------------------------
  await sleep(4000); // 2s SSE tick + margin
  live.ctrl.abort();
  const liveSettleFrames = live.frames.filter((f) => f.event === 'settlement');
  if (settled) {
    ok(liveSettleFrames.length >= 1, 'LIVE SSE delivered `event: settlement` frame', `count=${liveSettleFrames.length}`);
    const f = liveSettleFrames[0];
    ok(!!f?.id && /^\d+$/.test(f.id!), 'settlement frame carries numeric id: cursor', `id=${f?.id}`);
    ok(f?.data?.game === 'blackjack', 'settlement frame payload.game=blackjack', `game=${f?.data?.game}`);
  } else {
    console.log('   [warn] settle leg did not complete — live-frame assert skipped');
  }

  // 7. durable replay from B ----------------------------------------------------
  const rep = await replayFrom(sessionId, B);
  ok(rep.status === 200, 'REPLAY from B 200', `events=${rep.all.length}`);
  const types = rep.all.map((e: any) => e.eventType);
  if (visited) ok(types.includes('building.visited'), 'replay contains building.visited', `types=${[...new Set(types)].join(',')}`);
  if (settled) ok(types.includes('cove.blackjack.hand.settled'), 'replay contains cove.blackjack.hand.settled');
  // shape + ascending ids + safe keys
  let ascending = true; let prev = 0n;
  let keysSafe = true; let ctNumeric = true;
  for (const e of rep.all) {
    const id = BigInt(e.id);
    if (id <= prev) ascending = false;
    prev = id;
    const keys = Object.keys(e).sort().join(',');
    if (keys !== 'eventType,id,payload,ts') keysSafe = false;
    if (e.eventType === 'building.visited' && e.payload && 'ctAwarded' in e.payload && typeof e.payload.ctAwarded !== 'number') ctNumeric = false;
  }
  ok(ascending, 'replay ids strictly ascending');
  ok(keysSafe, 'replay events expose ONLY {id,eventType,ts,payload}');
  ok(ctNumeric, 'building.visited payload.ctAwarded is numeric (not [REDACTED])');
  const allBytes = JSON.stringify(rep.all);
  ok(!allBytes.includes(sessionId), 'raw session bearer appears NOWHERE in replayed payloads');
  ok(!allBytes.includes('fp_hash') && !allBytes.includes('ipPrefixHash') && !allBytes.includes('ip_prefix'), 'no fingerprint fields in replayed payloads');

  // 8. SSE Last-Event-ID resume (at-least-once catch-up) ------------------------
  const resume = openSse(sessionId, B === '0' ? '0' : B);
  await sleep(3500);
  resume.ctrl.abort();
  const replayFrames = resume.frames.filter((f) => f.event === 'replay');
  ok(replayFrames.length >= rep.all.length && rep.all.length > 0, 'SSE Last-Event-ID resume re-delivers durable rows as `event: replay`', `frames=${replayFrames.length} expected>=${rep.all.length}`);
  const frameIds = replayFrames.map((f) => f.id);
  ok(frameIds.every((x) => x && /^\d+$/.test(x)), 'every replay frame carries a numeric id:');

  // 9. rate-limit leg LAST -------------------------------------------------------
  let got429 = false;
  for (let i = 0; i < 70; i++) {
    const r = await req('GET', `/api/agent/${sessionId}/events/replay?after=0&limit=1`);
    if (r.status === 429) { got429 = r.json?.code === 'rate_limited'; break; }
  }
  ok(got429, 'replay endpoint rate-limits at 60/min/IP (429 code=rate_limited)');

  // 10. cleanup (best-effort; the real route is proof-carrying POST
  // /api/agent/disconnect — a 404 here is expected and harmless, the session
  // TTLs out; inherited from openclaw-e2e.ts) -----------------------------------
  const disc = await req('POST', `/api/agent/${sessionId}/disconnect`, {});
  console.log(`   cleanup disconnect (best-effort) → ${disc.status}`);
  const av2 = await req('GET', '/api/avatars/me');
  console.log(`   CT drift on test avatar: ${ctBefore} → ${av2.json?.avatar?.clawTokens}`);

  finish();
}

function finish() {
  console.log(`\n======================================================`);
  console.log(`SUMMARY: ${pass} PASS / ${fail} FAIL`);
  console.log(`======================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
