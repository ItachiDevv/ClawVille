/**
 * Hosted-OpenClaw connected-agent END-TO-END harness (token-bound, REAL-CT) —
 * D-openclaw host-it-for-me (shared-inference onboarding 2026-07-08). The exact
 * mirror of hermes-e2e.ts for the GATEWAY-LESS 'openclaw' hosted case.
 *
 * Proves the gateway-less 'openclaw' identityType on the open connect path: an
 * OpenClaw agent connects as ITSELF with NO gatewayUrl (the ClawVille-HOSTED
 * case), gets a real-CT-bound avatar, is present in-world, and settles REAL
 * ClawTokens (E5 parity). The in-world wire protocol the server derives is
 * 'openclaw-local' WHEN the operator has flipped OPENCLAW_LOCAL_GATEWAY_ENABLED
 * (else the legacy 'openai-compat' fail-soft) — either way this harness's motion
 * + settlement legs are identical (cognition is the only gated part, proven in
 * the manual staging-box leg below).
 *
 * CONTRAST WITH hermes-e2e.ts: openclaw is SERVER-managed (not self-managed) and
 * NOT restorable from the row (auth_token isn't persisted for the identity), so a
 * hosted openclaw reconnects after an API restart rather than lazy-restoring. With
 * the session live in RAM, session-status still reports connected:true.
 *
 * Flow (mirrors hermes-e2e.ts):
 *   1. login as a staging test account            → auth_session cookie
 *   2. GET /api/auth/me + /api/avatars/me          → userId + avatarId + CT-before
 *   3. POST /api/agent/connect-token {avatarId,userId}  (human mints the bind token)
 *   4. POST /api/agent/connect {connectionToken, identityType:'openclaw'}  ← NO gatewayUrl
 *                                                  → sessionId + identityType echo
 *   5. GET  /api/agent/session-status?agentId=…    → connected:true
 *   6. GET  /api/agent/:sid/perception             → body present + buildings listed
 *   7. POST /api/agent/:sid/move {buildingId}      → path the body to a teacher
 *   8. poll perception until edgeDistance ≤ 1000
 *   9. POST /api/agent/:sid/visit-building         → tokenAwarded (real-CT credit)
 *  10. GET /api/avatars/me                         → CT-after; assert +tokenAwarded (E5)
 *
 * COGNITION LEG (--with-cognition): the host-it-for-me branch POSTs to a HARDCODED
 * localhost:8643 on the API box, so it CANNOT be driven from this harness's network
 * position. The flag prints the manual staging-box steps (mock-openclaw-server +
 * OPENCLAW_LOCAL_GATEWAY_ENABLED=true) instead of asserting.
 *
 * Usage:
 *   bun run apps/api/scripts/agent-connect/openclaw-local-e2e.ts \
 *     --api-base https://api-staging.clawville.world \
 *     --email landtest1@staging.clawville.test --password 'LandTest!2026' \
 *     --agent-id e2e-openclaw-001 [--with-cognition]
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
const WITH_COGNITION = args['with-cognition'] === 'true';

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
  console.log(`\n=== Hosted-OpenClaw connected-agent E2E (REAL-CT) → ${API} ===`);
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

  // 4. connect the OpenClaw agent BOUND to the token, GATEWAY-LESS ------------
  // Deliberately NO gatewayUrl and NO protocol: this is the ClawVille-HOSTED
  // case. The server derives the in-world wire protocol from identityType +
  // (absent) gateway: 'openclaw-local' when OPENCLAW_LOCAL_GATEWAY_ENABLED on the
  // API box, else the legacy fail-soft 'openai-compat'. Nothing this request can
  // supply requests the hosted wire — it is purely the operator gate + no gateway.
  const conn = await req('POST', '/api/agent/connect', {
    connectionToken: token,
    agentId: AGENT_ID,
    identityType: 'openclaw',
    mode: 'avatar',
    name: 'E2EOpenClaw',
    species: 'milady_official_1',
  });
  // Bearer hygiene: the 200 body contains the sessionId (the real-CT bearer) —
  // print it ONLY on failure (error bodies carry no bearer), never on success.
  ok(conn.status === 200, 'CONNECT 200', `status=${conn.status}${conn.status !== 200 ? ` body=${JSON.stringify(conn.json)?.slice(0, 200)}` : ''}`);
  const sessionId: string | undefined = conn.json?.sessionId;
  ok(!!sessionId, 'CONNECT returns sessionId (bearer)');
  ok(conn.json?.identityType === 'openclaw', 'CONNECT identityType=openclaw echoed', `got=${conn.json?.identityType}`);
  if (!sessionId) return finish();

  // 5. session-status → live + connected (session held in RAM) ---------------
  const st = await req('GET', `/api/agent/session-status?agentId=${encodeURIComponent(AGENT_ID)}`);
  ok(st.status === 200 && st.json?.connected === true, 'SESSION-STATUS connected:true', `status=${st.status} body=${JSON.stringify(st.json)?.slice(0, 200)}`);

  // 6. perception → body present + position ----------------------------------
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

  // 7. move toward the building (server-managed body walks) -------------------
  const mv = await req('POST', `/api/agent/${sessionId}/move`, { buildingId: targetBuildingId });
  ok(mv.status === 200, `MOVE toward ${targetBuildingId} 200`, `status=${mv.status} body=${JSON.stringify(mv.json)?.slice(0, 160)}`);

  // 8. poll perception until arrived (within radius of the building EDGE) -----
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

  // 9. visit-building → real-CT credit ---------------------------------------
  const visit = await req('POST', `/api/agent/${sessionId}/visit-building`, { buildingId: targetBuildingId });
  ok(visit.status === 200, `VISIT-BUILDING ${targetBuildingId} 200`, `status=${visit.status} body=${JSON.stringify(visit.json)?.slice(0, 200)}`);
  const tokenAwarded: number = visit.json?.tokenAwarded ?? 0;
  ok(tokenAwarded >= 1, 'VISIT awarded >=1 CT (real-CT credit fired)', `tokenAwarded=${tokenAwarded}`);

  // 10. CT delta on the BOUND avatar → proves REAL settlement -----------------
  const me2 = await req('GET', '/api/avatars/me');
  const av2 = me2.json?.avatar ?? null;
  const ctAfter: number | null = typeof av2?.clawTokens === 'number' ? av2.clawTokens : null;
  if (ctBefore !== null && ctAfter !== null) {
    ok(ctAfter - ctBefore >= tokenAwarded && tokenAwarded > 0, 'BOUND avatar CT increased by the award (E5 real-CT parity)', `${ctBefore} → ${ctAfter} (Δ=${ctAfter - ctBefore})`);
  } else {
    console.log(`   [warn] CT balance not readable from /avatars/me (before=${ctBefore} after=${ctAfter}) — tokenAwarded=${tokenAwarded} still proves the credit path`);
  }

  // cognition leg (manual — staging-box-local by design) ----------------------
  if (WITH_COGNITION) {
    console.log(`
--- COGNITION LEG (manual, staging-box-local) ---
The host-it-for-me branch POSTs to a HARDCODED http://localhost:8643 ON THE API
BOX (server-side constant — this harness cannot reach or redirect it). To prove it:
  1. ssh onto the staging API box and run:
       bun run apps/api/scripts/agent-connect/mock-openclaw-server.ts
  2. set OPENCLAW_LOCAL_GATEWAY_ENABLED=true on the staging API env + restart it.
  3. re-run this harness with a GATEWAY-LESS openclaw agent (keeps a body in-world),
     then wait for the sim to pull the body into an ambient NPC conversation.
  4. PROOF: the mock's stdout logs the POST, and the in-world reply contains the
     marker OPENCLAW_MOCK_REPLY_V1 — and because openclaw-local emitsInWorldActions,
     the [ACTION: emote(name=wave)] tag is dispatched as a real in-world wave.
Unset the env (or leave the mock down) and the body degrades fail-soft to silence.
--------------------------------------------------`);
  }

  // cleanup (best-effort, NOT asserted — mirrors hermes-e2e.ts) ---------------
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
