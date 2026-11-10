/**
 * BrainChain human / bound-agent parity check against staging only.
 *
 * Creates one dedicated job account (no email is sent: the address uses the
 * reserved guest-email domain, the account itself is a normal non-guest user),
 * connects one agent through the account's own connect token, and checks that
 * both paths reach the same avatar on the BrainChain Office routes. The worker
 * binding uses a fresh in-memory EVM test key: a message signature only, no
 * funds, no transaction. Output: statuses, ids and hashes; never the password,
 * cookie, agent session, connect token or private key.
 *
 *   bun apps/api/scripts/brainchain/staging-parity.ts
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const API = 'https://api-staging.clawville.world';
const AGENT_HEADER = 'X-Clawville-Agent-Session';
const results: Array<{ check: string; pass: boolean; detail?: string }> = [];
const ok = (check: string, pass: boolean, detail?: string) => { results.push({ check, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${check}${detail ? ` (${detail})` : ''}`); };
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function call(method: string, path: string, opts: { cookie?: string; agent?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.agent) headers[AGENT_HEADER] = opts.agent;
  const response = await fetch(`${API}${path}`, { method, headers, redirect: 'error', signal: AbortSignal.timeout(path === '/api/brainchain/install' ? 120_000 : 30_000), // a first install lazy-starts the hosted runtime (~32 s on staging)
   
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json: any = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json, setCookie: response.headers.getSetCookie() };
}
const avatarInMessage = (message: unknown) => (typeof message === 'string' ? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(message.split('\n').find((line) => /avatar/i.test(line)) ?? '')?.[0] : undefined);

async function main() {
  const tag = randomBytes(4).toString('hex');
  const email = `bcparity-${tag}@clawville.guest`;
  const password = randomBytes(24).toString('base64url');

  // 1. Dedicated human account (password origin).
  const signup = await call('POST', '/api/auth/signup', { body: { email, password, name: `bcparity_${tag}` } });
  ok('human signup', signup.status === 200, `status=${signup.status}`);
  const cookie = signup.setCookie.find((c) => c.startsWith('auth_session='))?.split(';')[0];
  if (!cookie) return;
  const me = await call('GET', '/api/auth/me', { cookie });
  const userId: string | undefined = me.json?.user?.id ?? me.json?.id;
  const avatar = await call('GET', '/api/avatars/me', { cookie });
  const avatarId: string | undefined = avatar.json?.avatar?.id;
  ok('human session resolves user and avatar', me.status === 200 && avatar.status === 200 && !!userId && !!avatarId, `user=${userId} avatar=${avatarId}`);
  if (!userId || !avatarId) return;

  // 2. Bound agent through the account's own connect token.
  const token = await call('POST', '/api/agent/connect-token', { cookie, body: { avatarId, userId } });
  ok('connect token minted', token.status === 200 && typeof token.json?.token === 'string', `status=${token.status}`);
  const agentId = `bcparity-${randomUUID()}`;
  const connect = await call('POST', '/api/agent/connect', { body: { connectionToken: token.json?.token, agentId, identityType: 'openclaw', mode: 'avatar', name: `BcParity${tag}` } });
  const session: string | undefined = connect.json?.sessionId;
  ok('agent connect binds a session', connect.status === 200 && !!session, `status=${connect.status} protocol=${connect.json?.protocol?.version}`);
  if (!session) return;

  // 3. Public knowledge, then the same private reads on both paths.
  const knowledge = await call('GET', '/api/brainchain/knowledge');
  ok('public curriculum served', knowledge.status === 200 && typeof knowledge.json?.manual === 'string' && sha(knowledge.json.manual) === knowledge.json.contentHash,
    `version=${knowledge.json?.version} sha256=${knowledge.json?.contentHash}`);
  for (const [label, auth] of [['human', { cookie }], ['agent', { agent: session }]] as const) {
    const status = await call('GET', '/api/brainchain/status', auth);
    ok(`${label} status read`, status.status === 200, `status=${status.status}`);
  }
  const anonymous = await call('GET', '/api/brainchain/workers');
  ok('anonymous workers read refused', anonymous.status === 401, `status=${anonymous.status}`);
  const foreign = await call('GET', '/api/brainchain/workers', { agent: `forged-${randomUUID()}` });
  ok('forged agent session refused', foreign.status === 401 || foreign.status === 403, `status=${foreign.status}`);

  // 4. Challenges on both paths name the same avatar.
  const account = privateKeyToAccount(generatePrivateKey());
  const humanChallenge = await call('POST', '/api/brainchain/workers/challenge', { cookie, body: { environment: 'testnet', address: account.address } });
  const agentChallenge = await call('POST', '/api/brainchain/workers/challenge', { agent: session, body: { environment: 'testnet', address: account.address } });
  const humanAvatar = avatarInMessage(humanChallenge.json?.messageToSign);
  const agentAvatar = avatarInMessage(agentChallenge.json?.messageToSign);
  ok('human and agent challenges name the same avatar', humanChallenge.status === 200 && agentChallenge.status === 200 && humanAvatar === avatarId && agentAvatar === avatarId,
    `human=${humanAvatar} agent=${agentAvatar}`);

  // 5. The human binds a test worker; the agent sees that exact worker.
  const signature = await account.signMessage({ message: humanChallenge.json?.messageToSign ?? '' });
  const bind = await call('POST', '/api/brainchain/workers/bind', { cookie, body: { nonce: humanChallenge.json?.nonce, signature } });
  const workerId: string | undefined = bind.json?.worker?.id;
  ok('human binds a testnet worker with a wallet signature', bind.status === 200 && !!workerId, `status=${bind.status} worker=${workerId} address=${account.address}`);
  const humanWorkers = await call('GET', '/api/brainchain/workers', { cookie });
  const agentWorkers = await call('GET', '/api/brainchain/workers', { agent: session });
  const ids = (r: typeof humanWorkers) => (r.json?.workers ?? []).map((w: { id: string }) => w.id).sort().join(',');
  ok('agent sees the worker the human bound', humanWorkers.status === 200 && agentWorkers.status === 200 && !!workerId && ids(humanWorkers) === workerId && ids(agentWorkers) === workerId,
    `human=${ids(humanWorkers)} agent=${ids(agentWorkers)}`);

  // 6. Curriculum installation on both paths.
  for (const [label, auth] of [['human', { cookie }], ['agent', { agent: session }]] as const) {
    const install = await call('POST', '/api/brainchain/install', auth);
    ok(`${label} curriculum install`, install.status === 200 && install.json?.ok === true && install.json?.contentHash === `sha256:${knowledge.json?.contentHash}`,
      `status=${install.status} installed=${install.json?.installed} version=${install.json?.version}`);
  }

  console.log(JSON.stringify({ account: { email, userId, avatarId }, agentId, workerId, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length }));
}

main().catch((error) => { ok('script completed', false, error instanceof Error ? error.message : String(error)); }).finally(() => {
  process.exitCode = results.every((r) => r.pass) && results.length > 0 ? 0 : 1;
});
