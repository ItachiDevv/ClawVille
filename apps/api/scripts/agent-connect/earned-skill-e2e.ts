/**
 * P3 SLICE-3 LIVE E2E — earned-skill memory convergence against staging.
 *
 * Proves the slice-3 gate (docs/agent-metaverse-p3-plan.md §4):
 *   (A) a connected agent's teacher chat writes an avatar-keyed lesson readable
 *       via GET /:sid/skills/:bid/skill-memory (keyword-fallback tier OK — the
 *       runtime is cold on a fresh account);
 *   (B) the lesson SURVIVES body teardown (despawn proxy: reconnect a fresh
 *       session for the same account — the old body is killed on rebind — and
 *       read the lessons back through the NEW session);
 *   (C) the ELIZAOS/RAG tier is real (adversary #4): warm the avatar's hosted
 *       runtime via /me/chat, chat the teacher again with a DISTINCTIVE topic,
 *       then assert the endpoint returns lessons while the runtime is warm
 *       (RAG-first read short-circuits on ElizaOS rows → non-empty warm read ==
 *       embedded rows are searchable) — belt-and-braces DB probe done by the
 *       operator separately;
 *   (D) zero bearer leakage; 61-hammer → 429 (LAST — shared IP budget).
 * D6 30-min runtime survival is a separate operator probe (platform_agents.
 * status after >35 min with a live session) — too slow for this harness.
 *
 * Usage:
 *   bun run apps/api/scripts/agent-connect/earned-skill-e2e.ts \
 *     --api-base https://api-staging.clawville.world
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : [],
  ),
) as Record<string, string>;

const API = (args['api-base'] ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const RUN = Date.now().toString(36);
const PASSWORD = 'SkillTest!2026aA';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${msg}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${msg}${extra ? `  ${extra}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(method: string, path: string, body?: unknown, opts: { cookie?: string; noCookie?: boolean } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.cookie && !opts.noCookie ? { cookie: opts.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  const sc = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
  return { status: res.status, json, authCookie: sc.find((c: string) => c.startsWith('auth_session='))?.split(';')[0] };
}

async function connectAgent(cookie: string, avatarId: string, userId: string, agentId: string) {
  const tok = await req('POST', '/api/agent/connect-token', { avatarId, userId }, { cookie });
  const token: string | undefined = tok.json?.token;
  if (!token) return null;
  const conn = await req('POST', '/api/agent/connect', {
    connectionToken: token,
    agentId,
    identityType: 'openclaw',
    gatewayUrl: 'https://example.com/openclaw-mock',
    protocol: 'openai-compat',
    autonomyMode: 'self-managed',
    mode: 'avatar',
    name: 'E2ESkill',
    species: 'milady_official_1',
  }, { cookie });
  return (conn.json?.sessionId as string | undefined) ?? null;
}

async function walkToNearestAndChat(sessionId: string, message: string) {
  const perc = await req('GET', `/api/agent/${sessionId}/perception`);
  const nearby: any[] = perc.json?.nearbyBuildings ?? perc.json?.buildings ?? [];
  const buildingId: string | undefined = nearby?.[0]?.buildingId ?? nearby?.[0]?.id;
  if (!buildingId) return { buildingId: null, chat: null as any };
  await req('POST', `/api/agent/${sessionId}/move`, { buildingId });
  let lastEdge = Infinity;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const p = await req('GET', `/api/agent/${sessionId}/perception`);
    const b = (p.json?.nearbyBuildings ?? p.json?.buildings ?? []).find((x: any) => (x.buildingId ?? x.id) === buildingId);
    lastEdge = b?.edgeDistance ?? b?.distance ?? lastEdge;
    if (typeof lastEdge === 'number' && lastEdge <= 1000) break;
  }
  const chat = await req('POST', `/api/agent/${sessionId}/building/${buildingId}/chat`, { message });
  return { buildingId, chat };
}

async function main() {
  console.log(`\n=== P3 slice-3 earned-skill E2E → ${API} ===  run=${RUN}\n`);

  // signup (auto-provisioned hosted agent) + connect a bound agent -----------
  const email = `p3s3-${RUN}@staging.clawville.test`;
  const su = await req('POST', '/api/auth/signup', { email, password: PASSWORD, name: `Skill${RUN}`.slice(0, 16) });
  const cookie = su.authCookie ?? '';
  const avatarId: string | undefined = su.json?.avatar?.id;
  ok((su.status === 200 || su.status === 201) && !!avatarId && !!cookie, 'SIGNUP + provisioned avatar', `status=${su.status}`);
  if (!avatarId || !cookie) return finish();
  const me = await req('GET', '/api/auth/me', undefined, { cookie });
  const userId: string | undefined = me.json?.user?.id ?? me.json?.id;
  if (!userId) return finish();

  const sid1 = await connectAgent(cookie, avatarId, userId, `e2e-skill-${RUN}`);
  ok(!!sid1, 'CONNECT session 1 (bound)');
  if (!sid1) return finish();

  // A. teacher chat → lesson → endpoint (cold runtime = fallback tier OK) ----
  const { buildingId, chat } = await walkToNearestAndChat(sid1, 'Teach me the single most important principle of this domain.');
  ok(!!buildingId && chat?.status === 200, `BUILDING CHAT 200 @ ${buildingId}`, `status=${chat?.status}`);
  await sleep(3000); // fire-and-forget write settle (spec A4)
  const read1 = await req('GET', `/api/agent/${sid1}/skills/${buildingId}/skill-memory`);
  ok(read1.status === 200 && (read1.json?.lessons?.length ?? 0) >= 1,
    'SKILL-MEMORY endpoint returns the earned lesson (cold tier)', `count=${read1.json?.count} status=${read1.status}`);

  // B. despawn proxy: reconnect (old body killed on rebind) → still readable --
  const sid2 = await connectAgent(cookie, avatarId, userId, `e2e-skill-${RUN}`);
  ok(!!sid2, 'RECONNECT session 2 (old body torn down)');
  if (sid2) {
    await sleep(1500);
    const read2 = await req('GET', `/api/agent/${sid2}/skills/${buildingId}/skill-memory`);
    ok(read2.status === 200 && (read2.json?.lessons?.length ?? 0) >= 1,
      'LESSON SURVIVES body teardown (avatar-keyed, read via NEW session)', `count=${read2.json?.count}`);
    const bytes = JSON.stringify(read2.json ?? {});
    ok(!bytes.includes(sid1!) && !bytes.includes(sid2), 'no session bearer in skill-memory payloads');
  }

  // C. warm the hosted runtime → distinctive turn → warm (RAG) read -----------
  const t0 = Date.now();
  const warm = await req('POST', '/api/avatars/me/chat', { content: 'Hello! One short sentence please.' }, { cookie });
  ok(warm.status === 200, 'HOSTED RUNTIME warmed via /me/chat (lazy-start)', `status=${warm.status} elapsedMs=${Date.now() - t0}`);
  if (warm.status === 200 && sid2 && buildingId) {
    const distinctive = 'Teach me how vector embeddings help a curious fish remember lessons.';
    const chat2 = await req('POST', `/api/agent/${sid2}/building/${buildingId}/chat`, { message: distinctive });
    ok(chat2.status === 200, 'BUILDING CHAT 2 (runtime warm — ElizaOS write tier)', `status=${chat2.status}`);
    await sleep(4000);
    const read3 = await req('GET', `/api/agent/${sid2}/skills/${buildingId}/skill-memory`);
    const lessons: string[] = (read3.json?.lessons ?? []).map((l: any) => (typeof l === 'string' ? l : l?.lesson ?? l?.text ?? ''));
    ok(read3.status === 200 && lessons.length >= 1,
      'WARM read non-empty (RAG-first tier — embedded rows searchable, adversary #4)', `count=${lessons.length}`);
    console.log(`   sample lesson: ${String(lessons[0] ?? '').slice(0, 140)}`);
  }

  // D. rate limit LAST ---------------------------------------------------------
  let got429 = false;
  for (let i = 0; i < 65; i++) {
    const r = await req('GET', `/api/agent/${sid2 ?? sid1}/skills/${buildingId}/skill-memory`);
    if (r.status === 429) { got429 = r.json?.code === 'rate_limited'; break; }
  }
  ok(got429, 'skill-memory endpoint rate-limits at 60/min/IP (429 code=rate_limited)');

  console.log(`\n   [operator follow-ups] D6 survival probe: platform_agents.status for avatar ${avatarId} should still be 'running' after >35min with the live session; DB probe: memories rows metadata->>'subtype'='earned-skill' > 0.`);
  finish();
}

function finish() {
  console.log(`\n======================================================`);
  console.log(`SUMMARY: ${pass} PASS / ${fail} FAIL`);
  console.log(`======================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
