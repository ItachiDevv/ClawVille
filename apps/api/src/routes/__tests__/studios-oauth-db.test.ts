/**
 * Executed contract of Studios sign-in (migration 0094) against DATABASE_URL:
 * the human gates + linked-wallet proof on challenge/start/unlink, the
 * callback (single use, expiry, wrong user, wrong or missing iss, replay,
 * denied, token exchange errors), an unlink that cancels a sign-in in flight,
 * tokens encrypted at rest in user_vendor_oauth_links, status without tokens,
 * refresh claimed before the request (one network call for concurrent
 * callers; an unknown outcome or invalid_grant -> broken, never a second use
 * of a refresh token), revoke on unlink, and the API key table untouched.
 * Studios is a fake fetch: no live call.
 *
 * Skips when DATABASE_URL is absent or migration 0094 is not applied.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as dbMod from '@clawville/database';
import {
  STUDIOS_OAUTH_TOKEN_URL,
  STUDIOS_OAUTH_REVOKE_URL,
  StudiosOAuthError,
  getAccessToken,
  hashOAuthState,
  pkceChallengeS256,
  readStudiosOAuthStatus,
} from '../../services/vendors/studios-oauth';
import { _resetStudiosSignInNoncesForTest } from '../../services/vendors/studios-oauth-proof';
import { decryptToken } from '../../services/keypair-vault';
import { loadVendorKey, readVendorKeyStatus, saveVendorKey } from '../../services/vendor-credentials';
import { resetStudiosOAuthRateLimit, vendorStudiosOAuthRoutes } from '../vendor-studios-oauth';

if (!process.env.VANITY_ENCRYPTION_KEY) process.env.VANITY_ENCRYPTION_KEY = 'b'.repeat(64);

const { db, sql } = dbMod;

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('fixture query returned no row');
  return row;
}

let schemaReady = false;
if (process.env.DATABASE_URL) {
  try {
    const t = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name IN ('vendor_oauth_states', 'user_vendor_oauth_links')`,
    );
    schemaReady = Number(first(t).n) === 2;
  } catch {
    schemaReady = false;
  }
  if (!schemaReady) console.warn('[studios-oauth-db] SKIPPING: migration 0094 is not applied to this DATABASE_URL yet.');
}
const describeIfSchema = schemaReady ? describe : describe.skip;

type FetchCall = { url: string; method: string; body: URLSearchParams; headers: Headers };

describeIfSchema('studios sign-in: executed DB contract', () => {
  const tag = `so${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  const savedCors = process.env.CORS_ORIGIN;
  const savedWeb = process.env.WEB_ORIGIN;
  const realFetch = globalThis.fetch;
  const app = new Hono();
  app.route('/api/vendors/studios/oauth', vendorStudiosOAuthRoutes);
  const wallet = nacl.sign.keyPair();
  const otherWallet = nacl.sign.keyPair();

  let userId = '';
  let avatarId = '';
  let otherUserId = '';
  let guestUserId = '';
  const cookie = `auth_session=${tag}-human`;
  const otherCookie = `auth_session=${tag}-other`;
  const exchangeCookie = `auth_session=${tag}-exchange`;
  const guestCookie = `auth_session=${tag}-guest`;
  let calls: FetchCall[] = [];

  async function makeUser(suffix: string, guest: boolean, walletPubkey: string | null): Promise<{ userId: string; avatarId: string }> {
    const uid = first(await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name, is_guest, linked_wallet_pubkey)
          VALUES (${`${tag}${suffix}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Studios OAuth DB Test', ${guest}, ${walletPubkey}) RETURNING id`,
    )).id;
    const aid = first(await db.execute<{ id: string }>(
      sql`INSERT INTO avatars (user_id, name, species, color, gender, archetype, personality, stats, claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES (${uid}, ${`${tag}${suffix}`}, 'cat', 'green', 'male', 'brave-adventurer',
            ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
            ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb, 0, 0, 0, 0, true, ${guest})
          RETURNING id`,
    )).id;
    return { userId: uid, avatarId: aid };
  }

  async function makeSession(id: string, uid: string, createdVia: string) {
    await db.execute(sql`INSERT INTO sessions (id, user_id, expires_at, created_via) VALUES (${id}, ${uid}, now() + interval '2 days', ${createdVia})`);
  }

  beforeAll(async () => {
    process.env.CORS_ORIGIN = 'https://staging.clawville.world';
    delete process.env.WEB_ORIGIN;
    ({ userId, avatarId } = await makeUser('', false, bs58.encode(wallet.publicKey)));
    otherUserId = (await makeUser('o', false, null)).userId;
    guestUserId = (await makeUser('g', true, null)).userId;
    await makeSession(`${tag}-human`, userId, 'magic_link');
    await makeSession(`${tag}-other`, otherUserId, 'password');
    await makeSession(`${tag}-exchange`, userId, 'agent_exchange');
    await makeSession(`${tag}-guest`, guestUserId, 'password');
  });

  beforeEach(() => {
    resetStudiosOAuthRateLimit();
    _resetStudiosSignInNoncesForTest();
    calls = [];
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await db.execute(sql`DELETE FROM user_vendor_oauth_links WHERE avatar_id = ${avatarId}`);
    await db.execute(sql`DELETE FROM user_vendor_credentials WHERE avatar_id = ${avatarId}`);
    await db.execute(sql`DELETE FROM vendor_oauth_states WHERE user_id IN (${userId}, ${otherUserId}, ${guestUserId})`);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (savedCors === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = savedCors;
    if (savedWeb !== undefined) process.env.WEB_ORIGIN = savedWeb;
    for (const uid of [userId, otherUserId, guestUserId]) {
      await db.execute(sql`DELETE FROM sessions WHERE user_id = ${uid}`).catch(() => {});
      await db.execute(sql`DELETE FROM vendor_oauth_states WHERE user_id = ${uid}`).catch(() => {});
      await db.execute(sql`DELETE FROM avatars WHERE user_id = ${uid}`).catch(() => {});
      await db.execute(sql`DELETE FROM users WHERE id = ${uid}`).catch(() => {});
    }
  });

  /** Fake Studios: the token and revoke endpoints answer from `handler`; anything else fails the test. */
  function fakeStudios(handler: (call: FetchCall) => Promise<Response> | Response) {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const call = { url: u, method: init?.method ?? 'GET', body: new URLSearchParams(String(init?.body ?? '')), headers: new Headers(init?.headers) };
      calls.push(call);
      if (u !== STUDIOS_OAUTH_TOKEN_URL && u !== STUDIOS_OAUTH_REVOKE_URL) throw new Error(`unexpected fetch ${u}`);
      return handler(call);
    }) as typeof fetch;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  /** A linked-wallet proof for `action`, from the challenge route. */
  async function proof(action: 'link' | 'unlink', signer = wallet): Promise<{ nonce: string; signature: string }> {
    const res = await app.request('/api/vendors/studios/oauth/challenge', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { nonce: string; messageToSign: string; walletPubkey: string };
    expect(body.walletPubkey).toBe(bs58.encode(wallet.publicKey));
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(body.messageToSign), signer.secretKey));
    return { nonce: body.nonce, signature };
  }

  function post(path: string, body: unknown, cookieHeader = cookie, extra: Record<string, string> = {}) {
    return app.request(`/api/vendors/studios/oauth${path}`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
  }

  function unlinkRequest(body: unknown, extra: Record<string, string> = {}) {
    return app.request('/api/vendors/studios/oauth', {
      method: 'DELETE',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
  }

  async function start(): Promise<{ state: string; challenge: string; url: URL }> {
    const res = await post('/start', { proof: await proof('link') });
    expect(res.status).toBe(200);
    const body = await res.json() as { authorizeUrl: string };
    const url = new URL(body.authorizeUrl);
    return { state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')!, url };
  }

  /** Studios always sends `iss` (RFC 9207); pass `omitIss` to test a reply without it. */
  async function callback(query: Record<string, string>, cookieHeader = cookie, omitIss = false): Promise<URL> {
    if (!omitIss && !('iss' in query)) query = { ...query, iss: 'https://mystudios.fun' };
    const res = await app.request(`/api/vendors/studios/oauth/callback?${new URLSearchParams(query)}`, { headers: { Cookie: cookieHeader } });
    expect(res.status).toBe(302);
    return new URL(res.headers.get('location')!);
  }

  function reasonOf(location: URL): string | null {
    return location.searchParams.get('studios') === 'linked' ? 'linked' : location.searchParams.get('reason');
  }

  async function link(tokens: Record<string, unknown> = { access_token: 'acc-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref-1', scope: 'studio offline_access' }) {
    const { state } = await start();
    fakeStudios(() => json(200, tokens));
    expect(reasonOf(await callback({ code: 'code-1', state }))).toBe('linked');
    calls = [];
  }

  async function expireAccess() {
    await db.execute(sql`UPDATE user_vendor_oauth_links SET access_expires_at = now() WHERE avatar_id = ${avatarId}`);
  }

  async function linkStatus(): Promise<string> {
    return first(await db.execute<{ status: string }>(sql`SELECT status FROM user_vendor_oauth_links WHERE avatar_id = ${avatarId}`)).status;
  }

  // ---- gates + wallet proof ------------------------------------------------

  it('start: refuses an agent header (403), no session (401), an agent-exchange cookie (403) and a guest (403)', async () => {
    const agent = await post('/start', { proof: { nonce: 'n', signature: 's' } }, cookie, { 'X-Clawville-Agent-Session': 'x' });
    expect(agent.status).toBe(403);
    expect((await agent.json() as { code: string }).code).toBe('studios_signin_human_only');
    const agentChallenge = await post('/challenge', { action: 'link' }, cookie, { 'X-Clawville-Agent-Session': 'x' });
    expect(agentChallenge.status).toBe(403);
    expect((await app.request('/api/vendors/studios/oauth/start', { method: 'POST' })).status).toBe(401);
    const exchanged = await post('/start', {}, exchangeCookie);
    expect(exchanged.status).toBe(403);
    expect((await exchanged.json() as { code: string }).code).toBe('studios_signin_human_only');
    expect((await post('/start', {}, guestCookie)).status).toBe(403);
  });

  it('start: a magic-link session without a wallet signature is refused', async () => {
    const res = await post('/start', {});
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('studios_signin_needs_wallet_proof');
    expect(await db.execute(sql`SELECT 1 FROM vendor_oauth_states WHERE user_id = ${userId}`).then((r) => Array.from(r).length)).toBe(0);
  });

  it('start: no linked wallet -> studios_signin_needs_wallet_link', async () => {
    for (const path of ['/challenge', '/start']) {
      const res = await post(path, path === '/challenge' ? { action: 'link' } : {}, otherCookie);
      expect(res.status).toBe(403);
      expect((await res.json() as { code: string }).code).toBe('studios_signin_needs_wallet_link');
    }
  });

  it('start: a wrong wallet, a replayed nonce and an unlink proof are refused (401)', async () => {
    const wrong = await post('/start', { proof: await proof('link', otherWallet) });
    expect(wrong.status).toBe(401);
    expect((await wrong.json() as { code: string }).code).toBe('studios_signin_invalid_wallet_proof');

    const good = await proof('link');
    expect((await post('/start', { proof: good })).status).toBe(200);
    const replay = await post('/start', { proof: good });
    expect(replay.status).toBe(401);
    expect((await replay.json() as { code: string }).code).toBe('studios_signin_invalid_wallet_proof');

    expect((await post('/start', { proof: await proof('unlink') })).status).toBe(401);
  });

  it('unlink: refuses an agent header, no proof, a wrong wallet and a replayed nonce', async () => {
    await link();
    expect((await unlinkRequest({ proof: await proof('unlink') }, { 'X-Clawville-Agent-Session': 'x' })).status).toBe(403);
    const none = await unlinkRequest({});
    expect(none.status).toBe(403);
    expect((await none.json() as { code: string }).code).toBe('studios_signin_needs_wallet_proof');
    expect((await unlinkRequest({ proof: await proof('unlink', otherWallet) })).status).toBe(401);
    expect((await unlinkRequest({ proof: await proof('link') })).status).toBe(401);
    expect(await readStudiosOAuthStatus(avatarId)).toMatchObject({ linked: true });

    fakeStudios(() => new Response(null, { status: 200 }));
    const good = await proof('unlink');
    expect((await unlinkRequest({ proof: good })).status).toBe(200);
    expect((await unlinkRequest({ proof: good })).status).toBe(401);
  });

  // ---- start + callback ----------------------------------------------------

  it('start: builds the authorize URL with PKCE S256, the resource and the env redirect; stores only the state hash', async () => {
    const { state, challenge, url } = await start();
    expect(`${url.origin}${url.pathname}`).toBe('https://mystudios.fun/connect/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'https://api-staging.clawville.world/.well-known/oauth-client/studios.json',
      redirect_uri: 'https://api-staging.clawville.world/api/vendors/studios/oauth/callback',
      scope: 'studio offline_access',
      code_challenge_method: 'S256',
      resource: 'https://mcp.mystudios.fun/mcp',
    });
    expect(state.length).toBeGreaterThanOrEqual(43);
    const row = first(await db.execute<{ state_hash: string; verifier_enc: string; verifier_iv: string; verifier_tag: string; ttl_s: number; avatar_id: string }>(
      sql`SELECT state_hash, verifier_enc, verifier_iv, verifier_tag, avatar_id, EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl_s FROM vendor_oauth_states WHERE user_id = ${userId}`,
    ));
    expect(row.state_hash).toBe(hashOAuthState(state));
    expect(row.avatar_id).toBe(avatarId);
    expect(Number(row.ttl_s)).toBe(600);
    expect(pkceChallengeS256(decryptToken(row.verifier_enc, row.verifier_iv, row.verifier_tag))).toBe(challenge);
  });

  it('callback: exchanges code + verifier once, stores tokens encrypted, redirects to /game?studios=linked', async () => {
    const { state } = await start();
    const verifierRow = first(await db.execute<{ verifier_enc: string; verifier_iv: string; verifier_tag: string }>(
      sql`SELECT verifier_enc, verifier_iv, verifier_tag FROM vendor_oauth_states WHERE user_id = ${userId}`,
    ));
    const verifier = decryptToken(verifierRow.verifier_enc, verifierRow.verifier_iv, verifierRow.verifier_tag);
    fakeStudios(() => json(200, { access_token: 'acc-1', token_type: 'bearer', expires_in: 3600, refresh_token: 'ref-1', scope: 'studio offline_access' }));
    const loc = await callback({ code: 'code-1', state });
    expect(loc.toString()).toBe('https://staging.clawville.world/game?studios=linked');
    expect(calls.length).toBe(1);
    expect(calls[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(calls[0].body)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://api-staging.clawville.world/api/vendors/studios/oauth/callback',
      client_id: 'https://api-staging.clawville.world/.well-known/oauth-client/studios.json',
      code_verifier: verifier,
      resource: 'https://mcp.mystudios.fun/mcp',
    });
    const stored = first(await db.execute<Record<string, string | number | null>>(
      sql`SELECT status, access_enc, refresh_enc, scope, generation FROM user_vendor_oauth_links WHERE avatar_id = ${avatarId}`,
    ));
    expect(stored).toMatchObject({ status: 'active', scope: 'studio offline_access', generation: 1 });
    expect(String(stored.access_enc)).not.toContain('acc-1');
    expect(String(stored.refresh_enc)).not.toContain('ref-1');
    expect(await getAccessToken(avatarId)).toBe('acc-1');
    expect(calls.length).toBe(1);
  });

  it('callback: a replayed state is refused (single use) and does not call Studios again', async () => {
    const { state } = await start();
    fakeStudios(() => json(200, { access_token: 'acc-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref-1' }));
    expect(reasonOf(await callback({ code: 'code-1', state }))).toBe('linked');
    expect(reasonOf(await callback({ code: 'code-1', state }))).toBe('state_used');
    expect(calls.length).toBe(1);
  });

  it('callback: refuses an unknown state, an expired state, another user, a wrong iss and a missing iss, and burns the state', async () => {
    fakeStudios(() => json(200, { access_token: 'x', token_type: 'Bearer' }));
    expect(reasonOf(await callback({ code: 'c', state: 'not-a-real-state' }))).toBe('invalid_state');
    expect(reasonOf(await callback({ code: 'c' }))).toBe('invalid_state');

    const expired = await start();
    await db.execute(sql`UPDATE vendor_oauth_states SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE state_hash = ${hashOAuthState(expired.state)}`);
    expect(reasonOf(await callback({ code: 'c', state: expired.state }))).toBe('state_expired');

    const stolen = await start();
    expect(reasonOf(await callback({ code: 'c', state: stolen.state }, otherCookie))).toBe('wrong_user');
    expect(reasonOf(await callback({ code: 'c', state: stolen.state }))).toBe('state_used');

    const forged = await start();
    expect(reasonOf(await callback({ code: 'c', state: forged.state, iss: 'https://evil.example' }))).toBe('wrong_issuer');
    expect(reasonOf(await callback({ code: 'c', state: forged.state }))).toBe('state_used');

    const noIss = await start();
    expect(reasonOf(await callback({ code: 'c', state: noIss.state }, cookie, true))).toBe('wrong_issuer');
    expect(reasonOf(await callback({ code: 'c', state: noIss.state }))).toBe('state_used');

    expect(calls.length).toBe(0);
    expect(await readStudiosOAuthStatus(avatarId)).toEqual({ linked: false, status: null, scope: null, linkedAt: null });
  });

  it('callback: a denied consent and a session problem redirect with a reason code only', async () => {
    const denied = await start();
    const loc = await callback({ error: 'access_denied', error_description: '<script>steal()</script>', state: denied.state });
    expect(loc.toString()).toBe('https://staging.clawville.world/game?studios=error&reason=denied');
    const noSession = await app.request('/api/vendors/studios/oauth/callback?code=c&state=s');
    expect(new URL(noSession.headers.get('location')!).searchParams.get('reason')).toBe('needs_login');
    expect(reasonOf(await callback({ code: 'c', state: 's' }, exchangeCookie))).toBe('human_only');
    expect(reasonOf(await callback({ code: 'c', state: 's' }, guestCookie))).toBe('guest');
  });

  it('callback: maps token endpoint failures and refuses a non-bearer token or a reply without studio scope', async () => {
    const cases: Array<[Response, string]> = [
      [json(400, { error: 'invalid_grant', error_description: 'code used' }), 'exchange_failed'],
      [json(400, { error: 'invalid_client' }), 'exchange_failed'],
      [json(503, { error: 'busy' }), 'unavailable'],
      [json(200, { access_token: 'a', token_type: 'mac' }), 'exchange_failed'],
      [json(200, { access_token: 'a', token_type: 'Bearer', scope: 'profile' }), 'exchange_failed'],
      [new Response('not json', { status: 200 }), 'exchange_failed'],
      [new Response('x'.repeat(70_000), { status: 200 }), 'unavailable'],
    ];
    for (const [response, reason] of cases) {
      const { state } = await start();
      fakeStudios(() => response);
      const loc = await callback({ code: 'c', state });
      expect(reasonOf(loc)).toBe(reason);
      expect(loc.toString()).not.toContain('code used');
    }
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const { state } = await start();
    expect(reasonOf(await callback({ code: 'c', state }))).toBe('unavailable');
    expect(await readStudiosOAuthStatus(avatarId)).toMatchObject({ linked: false });
  });

  // ---- unlink vs a sign-in in progress -------------------------------------

  it('start, unlink, then the callback arrives: the state is cancelled, nothing is installed', async () => {
    const { state } = await start();
    fakeStudios(() => new Response(null, { status: 200 }));
    expect((await unlinkRequest({ proof: await proof('unlink') })).status).toBe(200);
    calls = [];
    fakeStudios(() => json(200, { access_token: 'late', token_type: 'Bearer', refresh_token: 'late-r' }));
    expect(reasonOf(await callback({ code: 'c', state }))).toBe('state_used');
    expect(calls.length).toBe(0);
    expect(await readStudiosOAuthStatus(avatarId)).toMatchObject({ linked: false });
  });

  it('an unlink during the token exchange stops the install and revokes the new tokens', async () => {
    const { state } = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
    fakeStudios(async (call) => {
      if (call.url === STUDIOS_OAUTH_TOKEN_URL) {
        exchangeStarted();
        await gate;
        return json(200, { access_token: 'race-a', token_type: 'Bearer', expires_in: 3600, refresh_token: 'race-r' });
      }
      return new Response(null, { status: 200 });
    });
    const pending = callback({ code: 'c', state });
    await started;
    expect((await unlinkRequest({ proof: await proof('unlink') })).status).toBe(200);
    release();
    expect(reasonOf(await pending)).toBe('cancelled');
    expect(await readStudiosOAuthStatus(avatarId)).toMatchObject({ linked: false });
    const revoke = calls.find((c) => c.url === STUDIOS_OAUTH_REVOKE_URL);
    expect(revoke?.body.get('token')).toBe('race-r');
  });

  // ---- status --------------------------------------------------------------

  it('status: reads linked/status/scope/linkedAt and never a token', async () => {
    await link();
    const res = await app.request('/api/vendors/studios/oauth', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('acc-1');
    expect(text).not.toContain('ref-1');
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(['linked', 'linkedAt', 'scope', 'status']);
    expect(body).toMatchObject({ linked: true, status: 'active', scope: 'studio offline_access' });
    expect((await app.request('/api/vendors/studios/oauth')).status).toBe(401);
  });

  // ---- refresh -------------------------------------------------------------

  it('refresh: rotates the pair when the access token expires within 60 s', async () => {
    await link();
    await db.execute(sql`UPDATE user_vendor_oauth_links SET access_expires_at = now() + interval '30 seconds' WHERE avatar_id = ${avatarId}`);
    fakeStudios(() => json(200, { access_token: 'acc-2', token_type: 'Bearer', expires_in: 1800, refresh_token: 'ref-2', scope: 'studio offline_access' }));
    expect(await getAccessToken(avatarId)).toBe('acc-2');
    expect(Object.fromEntries(calls[0].body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'ref-1',
      client_id: 'https://api-staging.clawville.world/.well-known/oauth-client/studios.json',
      resource: 'https://mcp.mystudios.fun/mcp',
    });
    expect(await linkStatus()).toBe('active');
    await expireAccess();
    calls = [];
    fakeStudios(() => json(200, { access_token: 'acc-3', token_type: 'Bearer', expires_in: 1800 }));
    expect(await getAccessToken(avatarId)).toBe('acc-3');
    expect(calls[0].body.get('refresh_token')).toBe('ref-2');
    // A server that does not rotate keeps the old refresh token.
    await expireAccess();
    calls = [];
    fakeStudios(() => json(200, { access_token: 'acc-4', token_type: 'Bearer', expires_in: 1800 }));
    expect(await getAccessToken(avatarId)).toBe('acc-4');
    expect(calls[0].body.get('refresh_token')).toBe('ref-2');
  });

  it('refresh: concurrent callers make ONE network call (claim under the row lock)', async () => {
    await link();
    await expireAccess();
    fakeStudios(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return json(200, { access_token: 'acc-c', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref-c' });
    });
    const tokens = await Promise.all([getAccessToken(avatarId), getAccessToken(avatarId), getAccessToken(avatarId)]);
    expect(tokens).toEqual(['acc-c', 'acc-c', 'acc-c']);
    expect(calls.filter((c) => c.url === STUDIOS_OAUTH_TOKEN_URL).length).toBe(1);
  });

  it('refresh: the refreshing mark is committed before the request is sent', async () => {
    await link();
    await expireAccess();
    let seenStatus = '';
    fakeStudios(async () => {
      seenStatus = await linkStatus();
      return json(200, { access_token: 'acc-m', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref-m' });
    });
    expect(await getAccessToken(avatarId)).toBe('acc-m');
    expect(seenStatus).toBe('refreshing');
  });

  it('refresh: a rejected token is refreshed once even with time left; a replaced one is returned as is', async () => {
    await link();
    fakeStudios(() => json(200, { access_token: 'acc-r', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref-r' }));
    expect(await getAccessToken(avatarId, { rejectedToken: 'acc-1' })).toBe('acc-r');
    expect(await getAccessToken(avatarId, { rejectedToken: 'acc-1' })).toBe('acc-r');
    expect(calls.length).toBe(1);
  });

  const unknownOutcomes: Array<[string, () => Promise<Response> | Response]> = [
    ['invalid_grant', () => json(400, { error: 'invalid_grant' })],
    ['a timeout', () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }],
    ['a network error', () => { throw new TypeError('fetch failed'); }],
    ['a bad JSON reply', () => new Response('{"access_token":', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['a 2xx without a token', () => json(200, { token_type: 'Bearer' })],
    ['a 5xx', () => json(502, {})],
  ];
  for (const [label, reply] of unknownOutcomes) {
    it(`refresh: ${label} marks the link broken and the refresh token is never sent again`, async () => {
      await link();
      await expireAccess();
      fakeStudios(reply);
      const err = await getAccessToken(avatarId).catch((e) => e);
      expect(err).toBeInstanceOf(StudiosOAuthError);
      expect((err as StudiosOAuthError).code).toBe('studios_oauth_relink_required');
      expect(await linkStatus()).toBe('broken');
      expect(await readStudiosOAuthStatus(avatarId)).toMatchObject({ linked: true, status: 'broken' });
      const again = await getAccessToken(avatarId).catch((e) => e);
      expect((again as StudiosOAuthError).code).toBe('studios_oauth_relink_required');
      expect(calls.filter((c) => c.url === STUDIOS_OAUTH_TOKEN_URL).length).toBe(1);
    });
  }

  it('refresh: a 429 releases the claim (Studios did not use the token) and keeps the link active', async () => {
    await link();
    await expireAccess();
    fakeStudios(() => json(429, { error: 'slow_down' }));
    expect(((await getAccessToken(avatarId).catch((e) => e)) as StudiosOAuthError).code).toBe('studios_oauth_unavailable');
    expect(await linkStatus()).toBe('active');
  });

  it('refresh: a stale refreshing mark (lost outcome) -> broken, with no network call', async () => {
    await link();
    await db.execute(sql`UPDATE user_vendor_oauth_links SET status = 'refreshing', refresh_started_at = now() - interval '1 minute', access_expires_at = now() WHERE avatar_id = ${avatarId}`);
    fakeStudios(() => json(200, { access_token: 'never', token_type: 'Bearer' }));
    expect(((await getAccessToken(avatarId).catch((e) => e)) as StudiosOAuthError).code).toBe('studios_oauth_relink_required');
    expect(await linkStatus()).toBe('broken');
    expect(calls.length).toBe(0);
  });

  it('getAccessToken: no link -> studios_oauth_not_linked', async () => {
    expect(((await getAccessToken(avatarId).catch((e) => e)) as StudiosOAuthError).code).toBe('studios_oauth_not_linked');
  });

  // ---- unlink ----------------------------------------------------------------

  it('unlink: revokes the refresh token at Studios, then deletes the link; the API key stays', async () => {
    await saveVendorKey(avatarId, 'studios', userId, `chk_${tag}abcdefghijklmnop9876`);
    await link();
    expect(await readVendorKeyStatus(avatarId, 'studios')).toMatchObject({ linked: true, last4: '9876' });
    fakeStudios(() => new Response(null, { status: 200 }));
    const res = await unlinkRequest({ proof: await proof('unlink') });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false, status: null, scope: null, linkedAt: null });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(STUDIOS_OAUTH_REVOKE_URL);
    expect(Object.fromEntries(calls[0].body)).toEqual({
      token: 'ref-1',
      token_type_hint: 'refresh_token',
      client_id: 'https://api-staging.clawville.world/.well-known/oauth-client/studios.json',
    });
    expect(await loadVendorKey(avatarId, 'studios')).toBe(`chk_${tag}abcdefghijklmnop9876`);
  });

  it('unlink: deletes the link even when Studios does not answer', async () => {
    await link();
    const good = await proof('unlink');
    globalThis.fetch = (async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const res = await unlinkRequest({ proof: good });
    expect(res.status).toBe(200);
    expect(await readStudiosOAuthStatus(avatarId)).toMatchObject({ linked: false });
  });
});
