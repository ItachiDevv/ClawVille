/**
 * DELETE /api/media/:id (MCP hub phase 3b; wallet proof after the Codex review
 * 2026-11-06): only the human owner of the active avatar deletes an item, and
 * only with a fresh signature from the linked wallet over the account, the
 * avatar, the media id and the action. A ledger-capable agent can hold a
 * `magic_link` cookie, so the session alone is refused. The agent header, an
 * agent-exchange cookie, no session and a guest are refused before any delete.
 * No DB: the session, the reads and the delete are fakes.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as realDatabase from '@clawville/database';
import * as realGuard from '../../middleware/require-non-guest';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realMedia from '../../services/studios-media';

const sessions = new Map<string, { userId: string; createdVia: string | null }>();
const deletes: Array<{ avatarId: string; id: string }> = [];
let guest = false;
const MEDIA = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const humanWallet = nacl.sign.keyPair();
const otherWallet = nacl.sign.keyPair();
let linkedWalletPubkey: string | null = null;

mock.module('../../lib/auth', () => ({
  resolveSessionCookieDomain: () => undefined,
  lucia: {
    readSessionCookie: (cookie: string) => /auth_session=([^;]+)/.exec(cookie)?.[1] ?? null,
    validateSession: async (id: string) => {
      const s = sessions.get(id);
      if (!s) return { session: null, user: null };
      return { session: { id, userId: s.userId, fresh: false, expiresAt: new Date(Date.now() + 60_000), createdVia: s.createdVia }, user: { id: s.userId } };
    },
    createSessionCookie: () => ({ serialize: () => 'auth_session=x' }),
    createBlankSessionCookie: () => ({ serialize: () => 'auth_session=' }),
  },
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realGuard,
  requireNonGuestUser: async (c: any, next: () => Promise<void>) => (guest ? c.json({ code: 'guest_not_allowed' }, 403) : next()),
}));
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: { query: {
    avatars: { findFirst: async () => ({ id: 'avatar-of-user' }) },
    users: { findFirst: async () => ({ linkedWalletPubkey }) },
  } },
}));
mock.module('../../services/studios-media', () => ({
  ...realMedia,
  deleteOwnMedia: async (avatarId: string, id: string) => {
    deletes.push({ avatarId, id });
    return id === MEDIA;
  },
}));

const { mediaRoutes } = await import('../media');
const app = new Hono().route('/api/media', mediaRoutes);
app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: 'x' }, 500)));

type Proof = { nonce: string; signature: string };

function headers(opts: { cookie?: string; agent?: boolean }) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) h.Cookie = `auth_session=${opts.cookie}`;
  if (opts.agent) h[realAgentAuth.AGENT_SESSION_HEADER] = 'agent-session';
  return h;
}

function del(id: string, opts: { cookie?: string; agent?: boolean; proof?: Proof } = {}) {
  const proof = opts.proof ? { nonce: opts.proof.nonce, signature: opts.proof.signature } : undefined;
  return app.request(`/api/media/${id}`, { method: "DELETE", headers: headers(opts), body: JSON.stringify(proof ? { proof } : {}) });
}

async function challenge(id: string, signer = humanWallet): Promise<Proof & { message: string }> {
  const res = await app.request(`/api/media/${id}/delete-challenge`, { method: 'POST', headers: headers({ cookie: 'human' }) });
  expect(res.status).toBe(200);
  const body = await res.json() as { nonce: string; messageToSign: string; walletPubkey: string };
  expect(body.walletPubkey).toBe(linkedWalletPubkey!);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(body.messageToSign), signer.secretKey));
  return { nonce: body.nonce, signature, message: body.messageToSign };
}

beforeEach(() => {
  sessions.clear();
  deletes.length = 0;
  guest = false;
  linkedWalletPubkey = bs58.encode(humanWallet.publicKey);
  sessions.set('human', { userId: 'u1', createdVia: 'password' });
  sessions.set('magic', { userId: 'u1', createdVia: 'magic_link' });
  sessions.set('exchanged', { userId: 'u1', createdVia: 'agent_exchange' });
});

describe('DELETE /api/media/:id', () => {
  it('the human owner deletes one item with a fresh linked-wallet signature that names the item', async () => {
    const proof = await challenge(MEDIA);
    expect(proof.message).toBe(`ClawVille media\naccount: u1\navatar: avatar-of-user\nmedia: ${MEDIA}\naction: delete\nnonce: ${proof.nonce}`);
    const res = await del(MEDIA, { cookie: 'human', proof });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, mediaId: MEDIA });
    expect(deletes).toEqual([{ avatarId: 'avatar-of-user', id: MEDIA }]);
  });

  it('a session alone (a magic-link cookie an agent can hold too) never deletes: no proof is 403', async () => {
    const res = await del(MEDIA, { cookie: 'magic' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('media_delete_needs_wallet_proof');
    expect(deletes).toEqual([]);
  });

  it('refuses another wallet, a replay, and a proof for another item', async () => {
    const wrong = await challenge(MEDIA, otherWallet);
    expect((await del(MEDIA, { cookie: 'human', proof: wrong })).status).toBe(401);
    const good = await challenge(MEDIA);
    expect((await del(MEDIA, { cookie: 'human', proof: good })).status).toBe(200);
    const replay = await del(MEDIA, { cookie: 'human', proof: good });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe('media_delete_invalid_wallet_proof');
    const forOther = await challenge(OTHER);
    expect((await del(MEDIA, { cookie: 'human', proof: forOther })).status).toBe(401);
    expect(deletes).toEqual([{ avatarId: 'avatar-of-user', id: MEDIA }]);
  });

  it('needs a linked wallet; an item that is not theirs is 404 after a valid proof', async () => {
    const proof = await challenge(OTHER);
    expect((await del(OTHER, { cookie: 'human', proof })).status).toBe(404);
    linkedWalletPubkey = null;
    const res = await app.request(`/api/media/${MEDIA}/delete-challenge`, { method: 'POST', headers: headers({ cookie: 'human' }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('media_delete_needs_wallet_link');
  });

  it('the agent header, an agent-exchange cookie, no session and a guest are refused before any delete or challenge', async () => {
    const proof = await challenge(MEDIA);
    const agent = await del(MEDIA, { cookie: 'human', agent: true, proof });
    expect(agent.status).toBe(403);
    expect(((await agent.json()) as { code: string }).code).toBe('media_delete_human_only');
    const agentChallenge = await app.request(`/api/media/${MEDIA}/delete-challenge`, { method: 'POST', headers: headers({ cookie: 'human', agent: true }) });
    expect(agentChallenge.status).toBe(403);
    expect((await del(MEDIA, { cookie: 'exchanged', proof })).status).toBe(403);
    expect((await del(MEDIA, { proof })).status).toBe(401);
    guest = true;
    expect((await del(MEDIA, { cookie: 'human', proof })).status).toBe(403);
    expect(deletes).toEqual([]);
  });
});
