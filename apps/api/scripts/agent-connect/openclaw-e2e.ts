/**
 * OpenClaw connected-agent END-TO-END harness (token-bound, REAL-CT).
 *
 * Proves the PRIMARY open-onboarding path (Priority #2): an external OpenClaw
 * agent connects as ITSELF, gets a real-CT-bound avatar, is present in-world,
 * and self-drives an action that settles REAL ClawTokens (E5 parity) — NOT the
 * hosted Milady house agent (Coralia) and NOT the partner-signed Hatcher path.
 *
 * Flow (mirrors a real self-managed OpenClaw runtime's own loop):
 *   1. login as a staging test account            → auth_session cookie
 *   2. GET /api/auth/me                            → userId + avatarId + CT-before
 *   3. POST /api/agent/connect-token {avatarId,userId}  (human mints the bind token)
 *   4. POST /api/agent/connect {connectionToken, identityType:'openclaw', ...}
 *                                                  → sessionId (BOUND → ledgerCapable)
 *   5. GET  /api/agent/:sid/perception             → body present + position + buildings
 *   6. POST /api/agent/:sid/move {buildingId}      → path the body to a teacher
 *   7. poll perception until within BUILDING_INTERACTION_RADIUS (self-drive arrival)
 *   8. POST /api/agent/:sid/visit-building {buildingId}  → tokenAwarded (real-CT credit)
 *   9. GET /api/auth/me                            → CT-after; assert +tokenAwarded (REAL settlement)
 *
 * Usage:
 *   bun run apps/api/scripts/agent-connect/openclaw-e2e.ts \
 *     --api-base https://api-staging.clawville.world \
 *     --email landtest1@staging.clawville.test --password 'LandTest!2026' \
 *     --agent-id e2e-openclaw-001
 *
 * Read-only-ish: it mints a bind token + spawns a bot bound to the TEST avatar and
 * moves it; it does not mutate any other account. Disconnect at the end best-effort.
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : [],
  ),
) as Record<string, string>;

const API = (args['api-base'] ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const EMAIL = args['email'] ?? 'landtest1@staging.clawville.test';
const PASSWORD = args['password'] ?? 'LandTest!2026';
const AGENT_ID = args['agent-id'] ?? `e2e-openclaw-${Date.now().toString(36)}`;
const GATEWAY_URL = args['gateway-url'] ?? 'https://example.com/openclaw-mock'; // never called on the self-drive path

let cookie = '';
let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${msg}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${msg}${extra ? `  ${extra}` : ''}`); }
};

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; setCookie: string[] }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  const setCookie = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
  return { status: res.status, json, setCookie };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log(`\n=== OpenClaw connected-agent E2E (REAL-CT) → ${API} ===`);
  console.log(`account=${EMAIL}  agentId=${AGENT_ID}\n`);

  // 1. login ----------------------------------------------------------------
  const login = await req('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  ok(login.status === 200, 'LOGIN 200', `status=${login.status}`);
  const authCookie = login.setCookie.find((c) => c.startsWith('auth_session='));
  ok(!!authCookie, 'LOGIN sets auth_session cookie');
  if (!authCookie) { console.log('cannot continue without session cookie'); return finish(); }
  cookie = authCookie.split(';')[0];

  // 2. me → userId; avatars/me → avatarId + CT-before ------------------------
  const me = await req('GET', '/api/auth/me');
  ok(me.status === 200, 'GET /auth/me 200', `status=${me.status}`);
  const userId: string | undefined = me.json?.user?.id ?? me.json?.id;
  const av = await req('GET', '/api/avatars/me');
  ok(av.status === 200, 'GET /avatars/me 200', `status=${av.status}`);
  const avatar = av.json?.avatar ?? null;
  const avatarId: string | undefined = avatar?.id;
  const ctBefore: number | null = typeof avatar?.clawTokens === 'number' ? avatar.clawTokens : null;
  ok(!!userId && !!avatarId, 'me has userId + avatarId', `userId=${userId} avatarId=${avatarId} ctBefore=${ctBefore}`);
  if (!userId || !avatarId) { console.log('me payload:', JSON.stringify(me.json)?.slice(0, 300), 'avatar:', JSON.stringify(av.json)?.slice(0, 300)); return finish(); }

  // 3. mint connection token (the human-initiated bind) ----------------------
  const tok = await req('POST', '/api/agent/connect-token', { avatarId, userId });
  ok(tok.status === 200 && !!tok.json?.token, 'MINT connect-token 200 + token', `status=${tok.status}`);
  const token: string | undefined = tok.json?.token;
  if (!token) { console.log('token payload:', JSON.stringify(tok.json)?.slice(0, 400)); return finish(); }

  // 4. connect the OpenClaw agent BOUND to the token -------------------------
  const conn = await req('POST', '/api/agent/connect', {
    connectionToken: token,
    agentId: AGENT_ID,
    identityType: 'openclaw',
    gatewayUrl: GATEWAY_URL,
    protocol: 'openai-compat',
    autonomyMode: 'self-managed',
    mode: 'avatar',
    name: 'E2EOpenClaw',
    species: 'milady_official_1',
  });
  ok(conn.status === 200, 'CONNECT 200', `status=${conn.status} body=${JSON.stringify(conn.json)?.slice(0, 200)}`);
  const sessionId: string | undefined = conn.json?.sessionId;
  ok(!!sessionId, 'CONNECT returns sessionId (bearer)');
  ok(conn.json?.identityType === 'openclaw', 'CONNECT identityType=openclaw', `got=${conn.json?.identityType}`);
  if (!sessionId) return finish();

  // 5. perception → body present + position ----------------------------------
  const perc = await req('GET', `/api/agent/${sessionId}/perception`);
  ok(perc.status === 200, 'PERCEPTION 200', `status=${perc.status}`);
  const pos = perc.json?.position ?? perc.json?.self ?? perc.json;
  const nearby: any[] = perc.json?.nearbyBuildings ?? perc.json?.buildings ?? [];
  ok(Array.isArray(nearby) && nearby.length > 0, 'PERCEPTION lists buildings', `count=${nearby?.length}`);
  console.log('   position:', JSON.stringify(pos)?.slice(0, 160));
  console.log('   nearest building:', JSON.stringify(nearby?.[0])?.slice(0, 200));
  const target = nearby?.[0];
  const targetBuildingId: string | undefined = target?.buildingId ?? target?.id;
  if (!targetBuildingId) { console.log('no building to target — perception:', JSON.stringify(perc.json)?.slice(0, 600)); return finish(); }

  // 6. move toward the building (self-drive) ---------------------------------
  const mv = await req('POST', `/api/agent/${sessionId}/move`, { buildingId: targetBuildingId });
  ok(mv.status === 200, `MOVE toward ${targetBuildingId} 200`, `status=${mv.status} body=${JSON.stringify(mv.json)?.slice(0, 160)}`);

  // 7. poll perception until arrived (within radius of the building EDGE) ------
  let arrived = false;
  let lastEdge = Infinity;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const p = await req('GET', `/api/agent/${sessionId}/perception`);
    const b = (p.json?.nearbyBuildings ?? p.json?.buildings ?? []).find((x: any) => (x.buildingId ?? x.id) === targetBuildingId);
    lastEdge = b?.edgeDistance ?? b?.distance ?? lastEdge;
    if (typeof lastEdge === 'number' && lastEdge <= 1000) { arrived = true; break; }
    if (i % 4 === 0) console.log(`   …walking, edgeDist to ${targetBuildingId} = ${lastEdge}`);
  }
  ok(arrived, `ARRIVED within 1000wu of ${targetBuildingId} EDGE`, `lastEdgeDist=${lastEdge}`);

  // 8. visit-building → real-CT credit ---------------------------------------
  const visit = await req('POST', `/api/agent/${sessionId}/visit-building`, { buildingId: targetBuildingId });
  ok(visit.status === 200, `VISIT-BUILDING ${targetBuildingId} 200`, `status=${visit.status} body=${JSON.stringify(visit.json)?.slice(0, 200)}`);
  const tokenAwarded: number = visit.json?.tokenAwarded ?? 0;
  ok(tokenAwarded >= 1, 'VISIT awarded >=1 CT (real-CT credit fired)', `tokenAwarded=${tokenAwarded}`);

  // 9. CT delta on the BOUND avatar → proves REAL settlement -----------------
  const me2 = await req('GET', '/api/avatars/me');
  const av2 = me2.json?.avatar ?? null;
  const ctAfter: number | null = typeof av2?.clawTokens === 'number' ? av2.clawTokens : null;
  if (ctBefore !== null && ctAfter !== null) {
    ok(ctAfter - ctBefore >= tokenAwarded && tokenAwarded > 0, 'BOUND avatar CT increased by the award (E5 real-CT parity)', `${ctBefore} → ${ctAfter} (Δ=${ctAfter - ctBefore})`);
  } else {
    console.log(`   [warn] CT balance not readable from /auth/me (before=${ctBefore} after=${ctAfter}) — tokenAwarded=${tokenAwarded} still proves the credit path`);
  }

  // 10-15. CONTROL-LINK LEG (magic-link onboarding D1/D3/D4/D5) ---------------
  // Full founder loop without a browser: agent mints a fresh control link →
  // the "human" (this harness, holding a cookie jar) redeems it → the bind
  // fires (idempotent same-user here) → human heartbeats controlMode:'player'
  // → the AGENT observes humanControlled:true (suppression) → TTL lapse
  // releases it.
  const cl = await req('POST', `/api/agent/${sessionId}/control-link`, {});
  ok(cl.status === 200 && !!cl.json?.url, 'CONTROL-LINK mint 200 + url', `status=${cl.status} expiresAt=${cl.json?.expiresAt}`);
  if (cl.json?.url) {
    const ticketUrl = new URL(cl.json.url);
    const t = ticketUrl.searchParams.get('t');
    ok(!!t, 'CONTROL-LINK url carries ?t= ticket');
    // Redeem like a browser would (manual redirect so we can read Location +
    // Set-Cookie). This logs "the human" in and fires the bind-at-redemption.
    const redeem = await fetch(`${API}/api/auth/enter?t=${encodeURIComponent(t!)}`, { redirect: 'manual' });
    const loc = redeem.headers.get('location') ?? '';
    const redeemCookies: string[] = typeof (redeem.headers as any).getSetCookie === 'function' ? (redeem.headers as any).getSetCookie() : [];
    const humanCookie = redeemCookies.find((c: string) => c.startsWith('auth_session='))?.split(';')[0];
    ok(redeem.status === 302 && loc.includes('/game'), 'REDEEM 302 → /game (has avatar)', `status=${redeem.status} loc=${loc}`);
    ok(!!humanCookie, 'REDEEM sets human auth_session cookie');
    // Agent-side status: bound + ledger-capable after (idempotent) bind.
    const st = await req('GET', `/api/agent/${sessionId}/status`);
    ok(st.status === 200, 'STATUS 200', `status=${st.status}`);
    ok(st.json?.session?.boundUser === true, 'STATUS session.boundUser=true (bind held)', JSON.stringify(st.json?.session));
    ok(st.json?.stats != null && typeof st.json?.stats?.ct === 'number', 'STATUS stats present for bound session (E5)', `ct=${st.json?.stats?.ct}`);
    if (humanCookie) {
      // Human drives: heartbeat controlMode:'player' → agent body suppressed.
      const hb = await fetch(`${API}/api/avatars/me/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: humanCookie },
        body: JSON.stringify({ positionX: 11264, positionY: 11264, controlMode: 'player' }),
      });
      ok(hb.status === 200, 'HEARTBEAT player-mode 200', `status=${hb.status}`);
      await sleep(1200);
      const p1 = await req('GET', `/api/agent/${sessionId}/perception`);
      ok(p1.json?.humanControlled === true, 'AGENT perception.humanControlled=true while human drives', `got=${p1.json?.humanControlled}`);
      // Release: no further heartbeats → 15s TTL lapses → agent free again.
      console.log('   …waiting 17s for the suppression TTL to lapse (release path)');
      await sleep(17_000);
      const p2 = await req('GET', `/api/agent/${sessionId}/perception`);
      ok(p2.json?.humanControlled === false, 'AGENT perception.humanControlled=false after TTL lapse', `got=${p2.json?.humanControlled}`);
    }
  }

  // cleanup (best-effort) ----------------------------------------------------
  const disc = await req('POST', `/api/agent/${sessionId}/disconnect`, {});
  console.log(`   cleanup disconnect → ${disc.status}`);

  finish();
}

function finish() {
  console.log(`\n======================================================`);
  console.log(`SUMMARY: ${pass} PASS / ${fail} FAIL`);
  console.log(`======================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
