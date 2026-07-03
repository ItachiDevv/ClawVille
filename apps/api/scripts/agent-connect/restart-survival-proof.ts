/**
 * LIVE RESTART-SURVIVAL PROOF (P0 gate — docs/agent-metaverse-p0-v2-refound.md §Gates).
 *
 * Proves, against a REAL staging API restart, the four lifecycle-truth claims:
 *   1. RESTORABLE (no-gateway class, e.g. hermes): the ORIGINAL bearer self-restores
 *      on the first authenticated call after restart (lazy restore) — no reconnect.
 *   2. session-status is RESTORE-AWARE: stays `connected:true` across the restart
 *      for a restorable type (never tells it to needlessly reconnect).
 *   3. Restore is FAIL-CLOSED NON-LEDGER: a session that was ledgerCapable before
 *      the restart comes back with `ledgerCapable:false` (real-CT only after a
 *      proof-carrying /connect or /reconnect).
 *   4. NON-RESTORABLE (real-gateway class, e.g. openclaw): the old bearer is DEAD
 *      (401) after restart, and the Phase 5.1 signed-challenge /reconnect cleanly
 *      replaces it — new sessionId works, old bearer stays dead, exactly ONE
 *      in-world body, and /api/npc/state leaks no `oc-` sessionId.
 *
 * TWO PHASES (the restart happens between them, via SSH — see runbook below):
 *   bun run apps/api/scripts/agent-connect/restart-survival-proof.ts --phase pre
 *     → connects agent A (hermes, token-bound → ledgerCapable) + agent B
 *       (openclaw real-gateway, token-bound on a VIRGIN account so first-connect
 *       returns the identity secretKey needed to sign the reconnect challenge),
 *       then writes state to --state-file.
 *   ssh …staging… "docker restart <api-container>"   (the operator does this)
 *   bun run … --phase post
 *     → asserts 1-4 with the surviving bearers, reconnects B, cleans up.
 *
 * SECURITY: agent B's identity secretKey is a STAGING TEST account credential;
 * it lives only in the --state-file (default: OS temp) and the file is deleted
 * on successful post-phase cleanup. Never run against prod.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { unlinkSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : [],
  ),
) as Record<string, string>;

const API = (args['api-base'] ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const PHASE = args['phase'];
const STATE_FILE = args['state-file'] ?? join(tmpdir(), 'clawville-restart-proof-state.json');
const EMAIL_A = args['email-a'] ?? 'landtest2@staging.clawville.test';
const EMAIL_B = args['email-b'] ?? 'landtest3@staging.clawville.test';
const PASSWORD = args['password'] ?? 'LandTest!2026';

if (API.includes('api.clawville.world')) {
  console.error('REFUSING: this proof restarts sessions — staging only, never prod.');
  process.exit(1);
}
if (PHASE !== 'pre' && PHASE !== 'post') {
  console.error('Usage: --phase pre | post   (restart the staging API between the two)');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${msg}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${msg}${extra ? `  ${extra}` : ''}`); }
};

async function req(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  const setCookie = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
  return { status: res.status, json, setCookie };
}

async function login(email: string): Promise<{ cookie: string; userId: string; avatarId: string }> {
  const l = await req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  const authCookie = l.setCookie.find((c: string) => c.startsWith('auth_session='));
  if (l.status !== 200 || !authCookie) throw new Error(`login failed for ${email}: ${l.status} ${JSON.stringify(l.json)?.slice(0, 200)}`);
  const cookie = authCookie.split(';')[0];
  const me = await req('GET', '/api/auth/me', { cookie });
  const av = await req('GET', '/api/avatars/me', { cookie });
  const userId = me.json?.user?.id ?? me.json?.id;
  const avatarId = av.json?.avatar?.id;
  if (!userId || !avatarId) throw new Error(`me/avatar missing for ${email} (userId=${userId} avatarId=${avatarId})`);
  return { cookie, userId, avatarId };
}

async function connectAgent(input: {
  cookie: string; userId: string; avatarId: string; agentId: string;
  identityType: 'hermes' | 'openclaw'; name: string;
}) {
  const tok = await req('POST', '/api/agent/connect-token', { cookie: input.cookie, body: { avatarId: input.avatarId, userId: input.userId } });
  if (tok.status !== 200 || !tok.json?.token) throw new Error(`connect-token failed: ${tok.status}`);
  const conn = await req('POST', '/api/agent/connect', {
    body: {
      connectionToken: tok.json.token,
      agentId: input.agentId,
      identityType: input.identityType,
      name: input.name,
      species: 'milady_official_1',
      autonomyMode: 'self-managed',
      mode: 'avatar',
      // real-gateway class needs a gateway; hermes (no-gateway class) ignores it.
      ...(input.identityType === 'openclaw'
        ? { gatewayUrl: 'https://example.com/openclaw-mock', protocol: 'openai-compat' as const }
        : {}),
    },
  });
  return conn;
}

interface ProofState {
  aSessionId: string; aAgentId: string;
  bSessionId: string; bAgentId: string; bUserId: string; bSecretKey: string;
  createdAt: string;
}

// ── PHASE PRE ────────────────────────────────────────────────────────────────
async function phasePre() {
  console.log(`\n=== RESTART-SURVIVAL PROOF — phase PRE → ${API} ===\n`);
  const runTag = Date.now().toString(36);

  // Agent A — RESTORABLE class (hermes ∈ NO_GATEWAY), token-bound → ledgerCapable.
  const a = await login(EMAIL_A);
  const aAgentId = `restart-proof-a-${runTag}`;
  const connA = await connectAgent({ ...a, agentId: aAgentId, identityType: 'hermes', name: 'RestartA' });
  ok(connA.status === 200 && !!connA.json?.sessionId, 'A CONNECT 200 (hermes, token-bound)', `status=${connA.status}`);
  const aSessionId: string = connA.json?.sessionId;
  if (!aSessionId) return finish();

  const aPerc = await req('GET', `/api/agent/${aSessionId}/perception`);
  ok(aPerc.status === 200, 'A PERCEPTION 200 pre-restart');
  const aStatus = await req('GET', `/api/agent/${aSessionId}/status`);
  ok(aStatus.json?.session?.ledgerCapable === true, 'A ledgerCapable=true pre-restart (token-bound)', JSON.stringify(aStatus.json?.session)?.slice(0, 140));

  // Agent B — NON-restorable real-gateway class, on the VIRGIN account so
  // first-connect issues the identity keypair (secretKey returned exactly once).
  const b = await login(EMAIL_B);
  const bAgentId = `restart-proof-b-${runTag}`;
  const connB = await connectAgent({ ...b, agentId: bAgentId, identityType: 'openclaw', name: 'RestartB' });
  ok(connB.status === 200 && !!connB.json?.sessionId, 'B CONNECT 200 (openclaw real-gateway, token-bound)', `status=${connB.status}`);
  const bSessionId: string = connB.json?.sessionId;
  const identity = connB.json?.identity;
  ok(identity?.isFirstTime === true && !!identity?.secretKey,
    'B first-connect returned identity secretKey (virgin account — needed to sign /reconnect)',
    `isFirstTime=${identity?.isFirstTime} hasSecret=${!!identity?.secretKey}`);
  if (!bSessionId || !identity?.secretKey) {
    console.log('   B connect payload keys:', Object.keys(connB.json ?? {}).join(','));
    return finish();
  }
  const bPerc = await req('GET', `/api/agent/${bSessionId}/perception`);
  ok(bPerc.status === 200, 'B PERCEPTION 200 pre-restart');

  const state: ProofState = {
    aSessionId, aAgentId, bSessionId, bAgentId,
    bUserId: identity.userId ?? b.userId, bSecretKey: identity.secretKey,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  console.log(`\nstate → ${STATE_FILE}`);
  console.log('NOW RESTART THE STAGING API CONTAINER, then run --phase post.\n');
  return finish();
}

// ── PHASE POST ───────────────────────────────────────────────────────────────
async function phasePost() {
  console.log(`\n=== RESTART-SURVIVAL PROOF — phase POST → ${API} ===\n`);
  const state: ProofState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  console.log(`state from ${state.createdAt} (A=${state.aAgentId} B=${state.bAgentId})\n`);

  // 1. RESTORABLE: A's ORIGINAL bearer self-restores on first authenticated call.
  const aPerc = await req('GET', `/api/agent/${state.aSessionId}/perception`);
  ok(aPerc.status === 200, 'A ORIGINAL bearer works post-restart (lazy restore, no reconnect)', `status=${aPerc.status}`);

  // 2. session-status restore-aware: connected:true for the restorable type.
  const aSS = await req('GET', `/api/agent/session-status?agentId=${encodeURIComponent(state.aAgentId)}`);
  ok(aSS.status === 200 && aSS.json?.connected === true,
    'A session-status connected:true post-restart (restore-aware, no needless reconnect)',
    `status=${aSS.status} connected=${aSS.json?.connected}`);

  // 3. FAIL-CLOSED NON-LEDGER: A was ledgerCapable pre-restart; restored session must not be.
  const aStatus = await req('GET', `/api/agent/${state.aSessionId}/status`);
  ok(aStatus.status === 200 && aStatus.json?.session?.ledgerCapable === false,
    'A restored session is NON-LEDGER (fail-closed: real-CT needs a proof-carrying connect)',
    JSON.stringify(aStatus.json?.session)?.slice(0, 140));

  // 4a. NON-restorable: B's old bearer is DEAD (404 — the gateway routes' designed
  // dead-session response: resolveSession → null → "Invalid or expired agent
  // session"; lazy restore returns null for real-gateway types).
  const bPerc = await req('GET', `/api/agent/${state.bSessionId}/perception`);
  ok(bPerc.status === 404, 'B (openclaw real-gateway) old bearer DEAD post-restart (404)', `status=${bPerc.status}`);

  // 4b. Signed-challenge /reconnect cleanly replaces it.
  const ch = await req('GET', '/api/agent/challenge');
  const nonce: string | undefined = ch.json?.nonce ?? ch.json?.challenge;
  ok(ch.status === 200 && !!nonce, 'CHALLENGE issued', `status=${ch.status}`);
  if (!nonce) return finish();
  const kp = nacl.sign.keyPair.fromSecretKey(bs58.decode(state.bSecretKey));
  const signature = bs58.encode(nacl.sign.detached(bs58.decode(nonce), kp.secretKey));
  const rec = await req('POST', '/api/agent/reconnect', { body: { userId: state.bUserId, nonce, signature } });
  ok(rec.status === 200 && !!rec.json?.sessionId, 'B RECONNECT 200 → fresh sessionId', `status=${rec.status}`);
  const bNewSid: string | undefined = rec.json?.sessionId;
  if (!bNewSid) { console.log('   reconnect payload:', JSON.stringify(rec.json)?.slice(0, 300)); return finish(); }

  const bNewPerc = await req('GET', `/api/agent/${bNewSid}/perception`);
  ok(bNewPerc.status === 200, 'B NEW bearer works');
  const bOldAgain = await req('GET', `/api/agent/${state.bSessionId}/perception`);
  ok(bOldAgain.status === 401, 'B OLD bearer STAYS dead after reconnect (no zombie session)', `status=${bOldAgain.status}`);

  // 4c. Exactly ONE in-world body for B + no oc- sessionId leak anywhere in npc/state.
  const world = await req('GET', '/api/npc/state');
  const raw = JSON.stringify(world.json ?? {});
  const bBodyId = `ocb-${Buffer.from(state.bAgentId).toString('base64url')}`;
  const bodyCount = (raw.match(new RegExp(bBodyId.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&'), 'g')) ?? []).length;
  ok(bodyCount >= 1, 'B has an in-world body after reconnect', `bodyId=${bBodyId} occurrences=${bodyCount}`);
  const npcIds: string[] = (world.json?.npcs ?? []).map((n: any) => String(n.npcId ?? n.id ?? ''));
  const dupBodies = npcIds.filter((id) => id === bBodyId).length;
  ok(dupBodies <= 1, 'NO double body for B (reconnect replaced, not duplicated)', `bodies=${dupBodies}`);
  const ocLeak = /(?<![A-Za-z0-9])oc-[A-Za-z0-9_-]{16,}/.test(raw);
  ok(!ocLeak, '/api/npc/state leaks NO oc- sessionId (bodies are ocb-<agentId>)');

  // Cleanup: disconnect both (best-effort) + delete the state file (holds B's secret).
  const dA = await req('POST', `/api/agent/${state.aSessionId}/disconnect`);
  const dB = await req('POST', `/api/agent/${bNewSid}/disconnect`);
  console.log(`\ncleanup: disconnect A=${dA.status} B(new)=${dB.status}`);
  if (fail === 0) { try { unlinkSync(STATE_FILE); console.log('state file deleted (held the test identity secret)'); } catch { /* already gone */ } }
  return finish();
}

function finish() {
  console.log(`\n======================================================`);
  console.log(`SUMMARY (${PHASE}): ${pass} PASS / ${fail} FAIL`);
  console.log(`======================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

(PHASE === 'pre' ? phasePre() : phasePost()).catch((e) => {
  console.error('PROOF ERROR:', e);
  process.exit(2);
});
