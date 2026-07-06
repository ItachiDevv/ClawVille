/**
 * P3 SLICE-2 LIVE E2E — chat-bar directives + goal stream against staging.
 *
 * Proves the slice-2 gate from docs/agent-metaverse-p3-plan.md §4:
 *   a human directive to their OWN hosted agent (a) persists, (b) rides the
 *   durable goal stream (agent.directive.set replayable by the connected
 *   session), (c) measurably biases the autonomous planner (the avatar paths
 *   toward the directed building), and (d) clears; guests 403, over-rate 429.
 *
 * Legs (two fresh signup accounts — P2 auto-provisions the hosted agent):
 *   A (directive + goal stream):
 *     1. signup → avatar + platformAgent (provisioned) → cookie
 *     2. POST /me/directive → 200 {ok, directive}
 *     3. connect-token → connect bound agent → sessionId
 *     4. set directive again → replay via the agent session shows
 *        agent.directive.set with the text; raw bearer appears NOWHERE
 *        (this also pins the A3 caveat: DB openclaw_bots.agentId == the sim
 *        agentId the replay resolves by)
 *   B (planner bias, NO connected agent — pure hosted):
 *     5. signup B → directive "walk to memory-rag" → one heartbeat (registers
 *        the avatar in the sim bridge) → go silent → 60s idle flips
 *        isAutonomous → planner reads the directive → observe the avatar
 *        moving toward memory-rag (center ~(9184,7648) game-px) via
 *        /api/npc/state autonomousAvatars (fallback /api/avatars/me position)
 *     6. POST /me/directive {clear:true} → 200 cleared
 *   C (gates):
 *     7. POST /api/auth/guest → guest cookie → directive → 403 guest_not_allowed
 *     8. hammer directive sets → 429 code=rate_limited (LAST — shared IP budget)
 *
 * The planner is an LLM decision — leg 5 allows several planning cycles and
 * passes on EITHER sustained distance decrease (≥800px) OR an
 * activity/position arrival at memory-rag within the watch window.
 *
 * Usage:
 *   bun run apps/api/scripts/agent-connect/directive-e2e.ts \
 *     --api-base https://api-staging.clawville.world
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : [],
  ),
) as Record<string, string>;

const API = (args['api-base'] ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const RUN = Date.now().toString(36);
const PASSWORD = 'DirTest!2026aA';
// memory-rag zone corner (8960,7424) + 448/2 → center in game-px.
const TARGET = { id: 'memory-rag', x: 9184, y: 7648 };

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${msg}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${msg}${extra ? `  ${extra}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(
  method: string,
  path: string,
  body?: unknown,
  opts: { cookie?: string; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  const setCookie = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
  const authCookie = setCookie.find((c: string) => c.startsWith('auth_session='))?.split(';')[0];
  return { status: res.status, json, authCookie };
}

async function signup(tag: string): Promise<{ cookie: string; userId: string; avatarId: string; agentId: string | null } | null> {
  const email = `p3s2-${tag}-${RUN}@staging.clawville.test`;
  const r = await req('POST', '/api/auth/signup', { email, password: PASSWORD, name: `Dir${tag}${RUN}`.slice(0, 18) });
  const cookie = r.authCookie ?? '';
  const avatarId: string | undefined = r.json?.avatar?.id;
  const userId: string | undefined = r.json?.user?.id ?? r.json?.userId;
  ok(r.status === 200 || r.status === 201, `SIGNUP ${tag} 2xx`, `status=${r.status}`);
  ok(!!avatarId, `SIGNUP ${tag} auto-provisioned avatar`, `agentId=${r.json?.agentId ?? 'n/a'}`);
  if (!cookie || !avatarId) { console.log(`   signup ${tag} body: ${JSON.stringify(r.json)?.slice(0, 300)}`); return null; }
  let uid = userId;
  if (!uid) {
    const me = await req('GET', '/api/auth/me', undefined, { cookie });
    uid = me.json?.user?.id ?? me.json?.id;
  }
  if (!uid) return null;
  return { cookie, userId: uid, avatarId, agentId: r.json?.agentId ?? null };
}

async function main() {
  console.log(`\n=== P3 slice-2 directive E2E → ${API} ===  run=${RUN}\n`);

  // ── A. directive + goal stream ────────────────────────────────────────────
  const A = await signup('a');
  if (!A) return finish();

  const d1 = await req('POST', '/api/avatars/me/directive', { directive: 'Explore the town square.' }, { cookie: A.cookie });
  ok(d1.status === 200 && d1.json?.ok === true && d1.json?.directive?.text === 'Explore the town square.',
    'DIRECTIVE set 200 + echo', `status=${d1.status}`);

  // bind a connected agent so the goal-stream event keys to it
  const tok = await req('POST', '/api/agent/connect-token', { avatarId: A.avatarId, userId: A.userId }, { cookie: A.cookie });
  const token: string | undefined = tok.json?.token;
  ok(tok.status === 200 && !!token, 'MINT connect-token 200');
  let sessionId: string | undefined;
  if (token) {
    const conn = await req('POST', '/api/agent/connect', {
      connectionToken: token,
      agentId: `e2e-dir-${RUN}`,
      identityType: 'openclaw',
      gatewayUrl: 'https://example.com/openclaw-mock',
      protocol: 'openai-compat',
      autonomyMode: 'self-managed',
      mode: 'avatar',
      name: 'E2EDirective',
      species: 'milady_official_1',
    }, { cookie: A.cookie });
    sessionId = conn.json?.sessionId;
    ok(conn.status === 200 && !!sessionId, 'CONNECT 200 + sessionId (bound)');
  }

  if (sessionId) {
    const d2 = await req('POST', '/api/avatars/me/directive', { directive: 'Visit the cove and watch the tables.' }, { cookie: A.cookie });
    ok(d2.status === 200, 'DIRECTIVE set (post-connect) 200', `status=${d2.status}`);
    await sleep(1500); // fire-and-forget event write
    const rep = await req('GET', `/api/agent/${sessionId}/events/replay?after=0&limit=500`);
    ok(rep.status === 200, 'REPLAY 200 via agent session', `events=${rep.json?.events?.length}`);
    const dirEvents = (rep.json?.events ?? []).filter((e: any) => e.eventType === 'agent.directive.set');
    ok(dirEvents.length >= 1, 'goal stream contains agent.directive.set (A3 agentId-equality pinned)', `count=${dirEvents.length}`);
    ok(dirEvents.some((e: any) => e.payload?.directive === 'Visit the cove and watch the tables.'),
      'directive text round-trips in the replayed payload');
    const bytes = JSON.stringify(rep.json ?? {});
    ok(!bytes.includes(sessionId), 'raw session bearer appears NOWHERE in the goal stream');
  }

  // ── B. planner bias (pure hosted, no connected agent) ─────────────────────
  const B = await signup('b');
  if (!B) return finish();

  const dB = await req('POST', '/api/avatars/me/directive',
    { directive: "Walk to Squidward's House, the memory-rag building, immediately and stay there." },
    { cookie: B.cookie });
  ok(dB.status === 200, 'DIRECTIVE B set 200', `status=${dB.status}`);

  // one heartbeat registers the avatar in the sim bridge; then SILENCE → 60s
  // idle threshold flips isAutonomous and the planner reads the directive.
  const spawn = { x: 11264, y: 11804 };
  const hb = await req('POST', '/api/avatars/me/heartbeat',
    { positionX: spawn.x, positionY: spawn.y, controlMode: 'player' }, { cookie: B.cookie });
  ok(hb.status === 200, 'HEARTBEAT B 200 (bridge-registered)', `status=${hb.status}`);

  const dist = (x: number, y: number) => Math.hypot(x - TARGET.x, y - TARGET.y);
  const d0 = dist(spawn.x, spawn.y);
  console.log(`   idle-waiting 70s for autonomy activation… startDist=${Math.round(d0)}`);
  await sleep(70_000);

  let best = d0;
  let arrived = false;
  let lastSeen = 'never';
  for (let i = 0; i < 14; i++) {
    // primary observable: the autonomous-avatar broadcast; fallback: DB position
    const st = await req('GET', '/api/npc/state');
    const mine = (st.json?.autonomousAvatars ?? []).find((a: any) => a.avatarId === B.avatarId || a.userId === B.userId);
    let x: number | undefined; let y: number | undefined;
    if (mine) { x = mine.x; y = mine.y; lastSeen = `broadcast(activity=${mine.activity ?? '?'} target=${mine.targetBuildingId ?? mine.currentBuildingId ?? '?'})`; }
    else {
      const me = await req('GET', '/api/avatars/me', undefined, { cookie: B.cookie });
      x = me.json?.avatar?.positionX; y = me.json?.avatar?.positionY;
      if (typeof x === 'number') lastSeen = 'avatars/me';
    }
    if (typeof x === 'number' && typeof y === 'number') {
      const d = dist(x, y);
      if (d < best) best = d;
      const targetHit = d < 900 || (mine && (mine.targetBuildingId === TARGET.id || mine.currentBuildingId === TARGET.id));
      if (i % 2 === 0) console.log(`   watch ${i}: pos=(${Math.round(x)},${Math.round(y)}) dist=${Math.round(d)} via=${lastSeen}`);
      if (targetHit) { arrived = true; break; }
    }
    await sleep(15_000);
  }
  const progressed = d0 - best >= 800;
  ok(arrived || progressed,
    'PLANNER BIAS: avatar measurably moves toward the directed building',
    `startDist=${Math.round(d0)} bestDist=${Math.round(best)} arrived=${arrived} via=${lastSeen}`);

  const clr = await req('POST', '/api/avatars/me/directive', { clear: true }, { cookie: B.cookie });
  ok(clr.status === 200 && clr.json?.cleared === true, 'DIRECTIVE clear 200 {cleared:true}', `status=${clr.status}`);

  // ── C. gates ───────────────────────────────────────────────────────────────
  const g = await req('POST', '/api/auth/guest', {});
  const guestCookie = g.authCookie ?? '';
  if (guestCookie) {
    const gd = await req('POST', '/api/avatars/me/directive', { directive: 'hi' }, { cookie: guestCookie });
    ok(gd.status === 403 && gd.json?.code === 'guest_not_allowed', 'GUEST directive → 403 guest_not_allowed', `status=${gd.status} code=${gd.json?.code}`);
  } else {
    console.log(`   [warn] guest mint unavailable (status=${g.status}) — guest leg skipped`);
  }

  let got429 = false;
  for (let i = 0; i < 25; i++) {
    const r = await req('POST', '/api/avatars/me/directive', { directive: `spam ${i}` }, { cookie: A.cookie });
    if (r.status === 429) { got429 = r.json?.code === 'rate_limited'; break; }
  }
  ok(got429, 'directive endpoint rate-limits at 20/min/IP (429 code=rate_limited)');

  finish();
}

function finish() {
  console.log(`\n======================================================`);
  console.log(`SUMMARY: ${pass} PASS / ${fail} FAIL`);
  console.log(`======================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
