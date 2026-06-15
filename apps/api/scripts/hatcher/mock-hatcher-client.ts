/**
 * MOCK-HATCHER CLIENT — staging-only pre-ship harness (2026-06-12).
 *
 * WHY THIS EXISTS: the Hatcher partner regressions (docs/diagnostic-2026-06-12-
 * hatcher-regressions.md) shipped because NO end-to-end test ever drove the LIVE
 * `/api/partner/hatcher/*` binary through register → spawn → stats with a real
 * signed request. We cannot sign as Hatcher (we don't hold their key), so this
 * client generates its OWN ed25519 keypair and the API accepts it ONLY when the
 * staging-only `ALLOW_TEST_PARTNER_PUBKEY` env is set to this client's pubkey
 * (see services/partner-signature.ts). This is now a MANDATORY pre-ship gate for
 * anything touching agent/session/partner code (see run-mock-e2e.md).
 *
 * WHAT IT EXERCISES (against a live API base):
 *   1. POST   /api/partner/hatcher/agents            — register (write-signed)
 *   2. GET    /api/partner/hatcher/agents/:id/stats  — stats   (get-signed)
 *   3. DELETE /api/partner/hatcher/agents/:id         — cleanup (write-signed), opt
 *
 * It reproduces BYTE-FOR-BYTE the partner signing contract the server verifies:
 *   - WRITE: ed25519(sha256( "clawville-partner-write\nMETHOD\nPATH\nUNIX_MS\n
 *            sha256hex(rawBody)" )) — headers X-Hatcher-Issuer-Pubkey /
 *            -Signature / -Timestamp (all base58), +/- 5 min window.
 *   - GET:   ed25519(sha256( "clawville-partner-get\nGET\nPATH\nUNIX_MS" )).
 *   PATH is the request path WITHOUT scheme/host and WITHOUT query string
 *   (Hono `c.req.path` semantics) — sign exactly that.
 *
 * ASSERTIONS (exit 1 on any failure):
 *   - register → 200; body { ok:true, sessionId, agent:{...} }; sessionExpiresAt
 *     present on the agent record; publicAgentRecord shape (agentId echoed RAW,
 *     protocol pointer present, NO token fields leaked).
 *   - stats   → 200; registration/leaderboard/learning/recentInteractions blocks
 *     all present; registration.sessionExpiresAt present.
 *   - delete  → 200; { ok:true }.
 *
 * COGNITION CAVEAT: the API only CALLS the mock proxy (POST .../chat) when (a) the
 * proxyBaseUrl host is in HATCHER_PROXY_ALLOWED_HOSTS and (b) the proxy is
 * reachable from the API box. The register/stats/delete half is asserted
 * REGARDLESS of proxy reachability — register succeeds (the SSRF guard validates
 * the URL syntactically + DNS, it does NOT require the proxy to answer), and the
 * cognition callback fails soft on the server. So this client is useful even when
 * the proxy is unreachable. To prove cognition end-to-end, run mock-hatcher-proxy.ts
 * on an allowlisted host and watch its request log (see run-mock-e2e.md).
 *
 * KEYFILE: --keyfile points at a JSON file holding the base58 secret key. If it
 * does not exist it is GENERATED and written (so re-runs reuse the same pubkey —
 * which must match ALLOW_TEST_PARTNER_PUBKEY on the API). Print the pubkey so the
 * operator can set the env. NEVER commit a keyfile.
 *
 * Run:  bun run apps/api/scripts/hatcher/mock-hatcher-client.ts \
 *         --api-base https://api-staging.clawville.world \
 *         --agent-id mock-hatcher-001 \
 *         --keyfile /tmp/mock-hatcher.key.json \
 *         [--proxy-base https://<allowlisted-host>] [--identity-key mock-id-001] \
 *         [--no-delete] [--delete-only]
 * Exit: 0 all-pass, 1 any failure.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Arg parsing (tiny, dependency-free)
// ---------------------------------------------------------------------------
interface Args {
  apiBase: string;
  agentId: string;
  keyfile: string;
  proxyBase: string;
  identityKey: string | null;
  doDelete: boolean;
  deleteOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const apiBase = (get('--api-base') ?? process.env.MOCK_HATCHER_API_BASE ?? '').replace(/\/+$/, '');
  const agentId = get('--agent-id') ?? `mock-hatcher-${Date.now()}`;
  const keyfile = get('--keyfile') ?? './mock-hatcher.key.json';
  // Default proxy host is an allowlisted DEFAULT_ALLOWED_HOSTS entry so register
  // passes the SSRF hostname check even when no real proxy is running (the
  // server fails the cognition callback soft; register/stats still assert).
  const proxyBase = (get('--proxy-base') ?? 'https://api.hatcher.host').replace(/\/+$/, '');
  const identityKey = get('--identity-key'); // optional — binds a user → real CT parity
  const doDelete = !has('--no-delete');
  const deleteOnly = has('--delete-only');

  if (!apiBase) {
    console.error('FATAL: --api-base is required (e.g. https://api-staging.clawville.world)');
    process.exit(2);
  }
  return { apiBase, agentId, keyfile, proxyBase, identityKey, doDelete, deleteOnly };
}

// ---------------------------------------------------------------------------
// Keypair load-or-generate
// ---------------------------------------------------------------------------
function loadOrCreateKeypair(keyfile: string): nacl.SignKeyPair {
  if (existsSync(keyfile)) {
    try {
      const parsed = JSON.parse(readFileSync(keyfile, 'utf8')) as { secretKeyB58?: string };
      if (parsed.secretKeyB58) {
        const sk = bs58.decode(parsed.secretKeyB58);
        if (sk.length === 64) {
          return nacl.sign.keyPair.fromSecretKey(sk);
        }
      }
      console.error(`WARN: keyfile ${keyfile} is malformed — regenerating`);
    } catch {
      console.error(`WARN: keyfile ${keyfile} unreadable — regenerating`);
    }
  }
  const kp = nacl.sign.keyPair();
  writeFileSync(
    keyfile,
    JSON.stringify(
      {
        note: 'mock-hatcher test ed25519 keypair — NEVER commit; set pubkeyB58 as ALLOW_TEST_PARTNER_PUBKEY on staging',
        pubkeyB58: bs58.encode(kp.publicKey),
        secretKeyB58: bs58.encode(kp.secretKey),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.error(`Generated new keypair → ${keyfile}`);
  return kp;
}

// ---------------------------------------------------------------------------
// Signing — byte-for-byte the contract in services/partner-signature.ts
// ---------------------------------------------------------------------------
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function signDigest(material: string, sk: Uint8Array): string {
  const digest = createHash('sha256').update(material).digest();
  return bs58.encode(nacl.sign.detached(new Uint8Array(digest), sk));
}
function writeChallenge(method: string, path: string, tsMillis: string, rawBody: string): string {
  return `clawville-partner-write\n${method.toUpperCase()}\n${path}\n${tsMillis}\n${sha256hex(rawBody)}`;
}
function getChallenge(method: string, path: string, tsMillis: string): string {
  return `clawville-partner-get\n${method.toUpperCase()}\n${path}\n${tsMillis}`;
}

/** Path used in the signed challenge = the URL path only (no scheme/host/query). */
function signedPath(apiBase: string, fullPath: string): string {
  // fullPath already starts with '/api/...'; apiBase carries the origin. The
  // server signs c.req.path (origin-stripped, query-stripped), so we sign
  // fullPath verbatim — callers must pass a query-less path.
  void apiBase;
  return fullPath;
}

interface HttpResult {
  status: number;
  json: unknown;
  text: string;
}

async function httpWriteSigned(
  kp: nacl.SignKeyPair,
  method: 'POST' | 'PATCH' | 'DELETE',
  apiBase: string,
  path: string,
  bodyObj: unknown | null,
): Promise<HttpResult> {
  const rawBody = bodyObj === null ? '' : JSON.stringify(bodyObj);
  const ts = String(Date.now());
  const challenge = writeChallenge(method, signedPath(apiBase, path), ts, rawBody);
  const sig = signDigest(challenge, kp.secretKey);
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Hatcher-Issuer-Pubkey': bs58.encode(kp.publicKey),
      'X-Hatcher-Signature': sig,
      'X-Hatcher-Timestamp': ts,
    },
    // Send the EXACT bytes we hashed (rawBody) — never re-stringify.
    body: method === 'DELETE' && rawBody === '' ? undefined : rawBody,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

async function httpGetSigned(
  kp: nacl.SignKeyPair,
  apiBase: string,
  path: string,
): Promise<HttpResult> {
  const ts = String(Date.now());
  const challenge = getChallenge('GET', signedPath(apiBase, path), ts);
  const sig = signDigest(challenge, kp.secretKey);
  const res = await fetch(`${apiBase}${path}`, {
    method: 'GET',
    headers: {
      'X-Hatcher-Issuer-Pubkey': bs58.encode(kp.publicKey),
      'X-Hatcher-Signature': sig,
      'X-Hatcher-Timestamp': ts,
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
let failures = 0;
function assert(name: string, cond: boolean, evidence: string): void {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`[${tag}] ${name}\n        ${evidence.replace(/\n/g, '\n        ')}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Token field names that must NEVER appear in any partner-facing response.
const FORBIDDEN_TOKEN_KEYS = ['proxyTokenEnc', 'proxyTokenIv', 'proxyTokenTag', 'scopedToken', 'authToken', 'proxyToken'];

function assertNoTokenLeak(name: string, payload: unknown): void {
  const serialized = JSON.stringify(payload ?? {});
  const leakedKey = FORBIDDEN_TOKEN_KEYS.find((k) => serialized.includes(`"${k}"`));
  assert(
    name,
    !leakedKey,
    leakedKey
      ? `LEAK: response contains forbidden token key "${leakedKey}"`
      : `no forbidden token key in response (checked ${FORBIDDEN_TOKEN_KEYS.join(', ')})`,
  );
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const kp = loadOrCreateKeypair(args.keyfile);
  const pubkeyB58 = bs58.encode(kp.publicKey);

  console.log('=== mock-Hatcher client (staging pre-ship harness) ===');
  console.log(`api-base   : ${args.apiBase}`);
  console.log(`agent-id   : ${args.agentId}`);
  console.log(`pubkey     : ${pubkeyB58}`);
  console.log(`            ^ set ALLOW_TEST_PARTNER_PUBKEY to this on the STAGING api box`);
  console.log(`proxy-base : ${args.proxyBase}`);
  console.log(`identity   : ${args.identityKey ?? '(none — anonymous, no real-CT avatar)'}`);
  console.log('');

  const statsPath = `/api/partner/hatcher/agents/${encodeURIComponent(args.agentId)}/stats`;
  const agentPath = `/api/partner/hatcher/agents/${encodeURIComponent(args.agentId)}`;

  // ----- DELETE-ONLY cleanup mode -----
  if (args.deleteOnly) {
    const del = await httpWriteSigned(kp, 'DELETE', args.apiBase, agentPath, null);
    assert(
      'DELETE (cleanup) returns 200 ok:true',
      del.status === 200 && isObj(del.json) && del.json.ok === true,
      `status=${del.status} body=${del.text.slice(0, 300)}`,
    );
    finish();
    return;
  }

  // ----- 1. REGISTER -----
  const registerBody: Record<string, unknown> = {
    agentId: args.agentId,
    mode: 'avatar',
    name: 'Mock Hatcher Agent',
    // species omitted → server applies DEFAULT_HATCHER_MODEL_KEY ('phanes').
    cognition: {
      backend: 'hatcher-proxy',
      proxyBaseUrl: `${args.proxyBase}`,
      scopedToken: `mock-scoped-token-${bs58.encode(nacl.randomBytes(16))}`,
    },
  };
  if (args.identityKey) registerBody.identityKey = args.identityKey;

  const reg = await httpWriteSigned(kp, 'POST', args.apiBase, '/api/partner/hatcher/agents', registerBody);
  assert(
    'REGISTER returns 200',
    reg.status === 200,
    `status=${reg.status} body=${reg.text.slice(0, 400)}`,
  );
  const regJson = isObj(reg.json) ? reg.json : {};
  assert(
    'REGISTER body has ok:true + sessionId',
    regJson.ok === true && typeof regJson.sessionId === 'string' && (regJson.sessionId as string).length > 0,
    `ok=${regJson.ok} sessionId=${typeof regJson.sessionId === 'string' ? (regJson.sessionId as string).slice(0, 12) + '…' : regJson.sessionId}`,
  );
  const agent = isObj(regJson.agent) ? regJson.agent : {};
  assert(
    'REGISTER agent record echoes RAW agentId (hatcher: prefix stripped)',
    agent.agentId === args.agentId,
    `agent.agentId=${JSON.stringify(agent.agentId)} expected=${JSON.stringify(args.agentId)}`,
  );
  const proto = isObj(agent.protocol) ? agent.protocol : null;
  assert(
    'REGISTER agent record carries protocol pointer (version + contentHash + url)',
    !!proto &&
      typeof proto.version === 'number' &&
      typeof proto.contentHash === 'string' &&
      (proto.contentHash as string).startsWith('sha256:') &&
      typeof proto.url === 'string',
    `protocol=${JSON.stringify(proto)}`,
  );
  assert(
    'REGISTER agent record carries sessionExpiresAt',
    agent.sessionExpiresAt !== undefined && agent.sessionExpiresAt !== null,
    `sessionExpiresAt=${JSON.stringify(agent.sessionExpiresAt)}`,
  );
  assert(
    'REGISTER agent record reports identityType=hatcher + cognitionBackend=hatcher-proxy',
    agent.identityType === 'hatcher' && agent.cognitionBackend === 'hatcher-proxy',
    `identityType=${JSON.stringify(agent.identityType)} cognitionBackend=${JSON.stringify(agent.cognitionBackend)}`,
  );
  if (args.identityKey) {
    assert(
      'REGISTER bound an identity (userId present) + avatarProvisioned=true (Rule E5 real-CT parity)',
      typeof agent.userId === 'string' && (agent.userId as string).length > 0 && regJson.avatarProvisioned === true,
      `userId=${JSON.stringify(agent.userId)} avatarProvisioned=${JSON.stringify(regJson.avatarProvisioned)}`,
    );
  }
  assertNoTokenLeak('REGISTER response leaks NO token fields', reg.json);

  // ----- 2. STATS (get-signed) -----
  const stats = await httpGetSigned(kp, args.apiBase, statsPath);
  assert('STATS returns 200', stats.status === 200, `status=${stats.status} body=${stats.text.slice(0, 300)}`);
  const statsJson = isObj(stats.json) ? stats.json : {};
  assert(
    'STATS has registration/leaderboard/learning/recentInteractions blocks',
    isObj(statsJson.registration) &&
      isObj(statsJson.leaderboard) &&
      isObj(statsJson.learning) &&
      Array.isArray(statsJson.recentInteractions),
    `keys=${JSON.stringify(Object.keys(statsJson))}`,
  );
  const statsReg = isObj(statsJson.registration) ? statsJson.registration : {};
  assert(
    'STATS registration echoes RAW agentId + cognitionBackend + sessionExpiresAt',
    statsReg.agentId === args.agentId &&
      statsReg.cognitionBackend === 'hatcher-proxy' &&
      statsReg.sessionExpiresAt !== undefined,
    `agentId=${JSON.stringify(statsReg.agentId)} cognitionBackend=${JSON.stringify(statsReg.cognitionBackend)} sessionExpiresAt=${JSON.stringify(statsReg.sessionExpiresAt)}`,
  );
  assertNoTokenLeak('STATS response leaks NO token fields', stats.json);

  // ----- 3. NEGATIVE: a tampered signature must 401 (proves the gate is live) -----
  {
    const ts = String(Date.now());
    const path = '/api/partner/hatcher/agents';
    const body = JSON.stringify({ agentId: args.agentId, cognition: registerBody.cognition });
    // Sign a DIFFERENT path, so the recomputed challenge can't match → 401.
    const badSig = signDigest(writeChallenge('POST', '/wrong/path', ts, body), kp.secretKey);
    const res = await fetch(`${args.apiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hatcher-Issuer-Pubkey': pubkeyB58,
        'X-Hatcher-Signature': badSig,
        'X-Hatcher-Timestamp': ts,
      },
      body,
    });
    assert(
      'NEGATIVE: a wrong-path signature is rejected with 401',
      res.status === 401,
      `status=${res.status} (expect 401 — the write-signature gate is live)`,
    );
  }

  // ----- 4. DELETE (cleanup) -----
  if (args.doDelete) {
    const del = await httpWriteSigned(kp, 'DELETE', args.apiBase, agentPath, null);
    assert(
      'DELETE (cleanup) returns 200 ok:true',
      del.status === 200 && isObj(del.json) && del.json.ok === true,
      `status=${del.status} body=${del.text.slice(0, 300)}`,
    );
  } else {
    console.log('[SKIP] DELETE — --no-delete passed; leaving the test agent in place (clean up with --delete-only)');
  }

  finish();
}

function finish(): never {
  console.log('');
  if (failures === 0) {
    console.log('=== ALL ASSERTIONS PASSED ===');
    process.exit(0);
  }
  console.log(`=== ${failures} ASSERTION(S) FAILED ===`);
  process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  process.exit(1);
});
