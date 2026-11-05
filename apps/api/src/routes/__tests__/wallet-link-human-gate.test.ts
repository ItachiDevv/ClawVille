/**
 * POST /api/wallet/link{,/challenge} (phase 1b, 2026-11-05). The linked wallet
 * approves spend-rule raises and receives market payouts, so:
 *   - only a human session can link (agent header, agent-exchanged cookie,
 *     guest and pre-0089 sessions are refused);
 *   - changing an existing link needs a signature from the CURRENT wallet.
 *
 * The REAL auth, guest and human-session middleware run. Lucia's session store,
 * the database and the trading-wallet sync are stubbed.
 */

const HEX32 = '0'.repeat(64);
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = HEX32;
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import * as realDatabase from '@clawville/database';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import { buildWalletChangeMessage } from '../../services/wallet-link-challenge';

const AGENT_HEADER = realAgentAuth.AGENT_SESSION_HEADER;

const sessions = new Map<string, { userId: string; createdVia: string | null }>();
const linked = new Map<string, string>();
const updates: Array<{ userId: string; pubkey: string }> = [];
let currentUserId: string | null = null;

mock.module('../../lib/auth', () => ({
  resolveSessionCookieDomain: () => undefined,
  lucia: {
    readSessionCookie: (cookie: string) => /auth_session=([^;]+)/.exec(cookie)?.[1] ?? null,
    validateSession: async (id: string) => {
      const s = sessions.get(id);
      if (!s) return { session: null, user: null };
      return {
        session: { id, userId: s.userId, fresh: false, expiresAt: new Date(Date.now() + 60_000), createdVia: s.createdVia },
        user: { id: s.userId },
      };
    },
    createSessionCookie: () => ({ serialize: () => 'auth_session=x' }),
    createBlankSessionCookie: () => ({ serialize: () => 'auth_session=' }),
  },
}));

function tx() {
  const chain = { from: () => chain, where: () => chain, limit: async () => [] };
  return {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes('FOR UPDATE')) return [{ linked_wallet_pubkey: linked.get(currentUserId ?? '') ?? null }];
      return [];
    },
    select: () => chain,
    update: () => ({
      set: (values: { linkedWalletPubkey?: string }) => ({
        where: async () => {
          if (values.linkedWalletPubkey && currentUserId) {
            linked.set(currentUserId, values.linkedWalletPubkey);
            updates.push({ userId: currentUserId, pubkey: values.linkedWalletPubkey });
          }
        },
      }),
    }),
  };
}

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: {
    query: {
      users: {
        findFirst: async () => ({ isGuest: false, linkedWalletPubkey: linked.get(currentUserId ?? '') ?? null }),
      },
    },
    transaction: async (fn: (t: ReturnType<typeof tx>) => Promise<unknown>) => fn(tx()),
  },
}));
mock.module('../../services/trading-wallets', () => ({ syncLinkedTradingWallet: async () => {} }));
mock.module('../../services/linked-wallet-clv-balance', () => ({
  getLinkedWalletClvBalance: async () => ({ clv: { available: false } }),
  invalidateClvBalanceCache: () => {},
}));

const { walletLinkRoutes } = await import('../wallet-link');
const app = new Hono();
app.route('/api/wallet/link', walletLinkRoutes);

function post(path: string, opts: { cookie?: string; agent?: string; body?: unknown }) {
  currentUserId = opts.cookie ? sessions.get(opts.cookie)?.userId ?? null : null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `auth_session=${opts.cookie}`;
  if (opts.agent) headers[AGENT_HEADER] = opts.agent;
  return app.request(`/api/wallet/link${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

function sign(message: string, secretKey: Uint8Array): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secretKey));
}

async function challenge(cookie: string) {
  const res = await post('/challenge', { cookie });
  expect(res.status).toBe(200);
  return await res.json() as { nonce: string; messageToSign: string };
}

beforeEach(() => {
  sessions.clear();
  linked.clear();
  updates.length = 0;
  sessions.set('pw', { userId: 'user-1', createdVia: 'password' });
  sessions.set('exchanged', { userId: 'user-1', createdVia: 'agent_exchange' });
  sessions.set('legacy', { userId: 'user-1', createdVia: null });
});

describe('wallet link human gate', () => {
  it('refuses an agent header, an agent-exchanged cookie and a pre-0089 session', async () => {
    for (const path of ['/challenge', '']) {
      const agent = await post(path, { agent: 'any', cookie: 'pw' });
      expect(agent.status).toBe(403);
      expect(await agent.json()).toMatchObject({ code: 'wallet_link_human_only' });
      const exchanged = await post(path, { cookie: 'exchanged' });
      expect(exchanged.status).toBe(403);
      expect(await exchanged.json()).toMatchObject({ code: 'wallet_link_human_only' });
      const legacy = await post(path, { cookie: 'legacy' });
      expect(legacy.status).toBe(403);
      expect(await legacy.json()).toMatchObject({ code: 'wallet_link_needs_human_login' });
    }
    expect(updates).toHaveLength(0);
  });

  it('links a first wallet with its own signature', async () => {
    const wallet = nacl.sign.keyPair();
    const walletPubkey = bs58.encode(wallet.publicKey);
    const c = await challenge('pw');
    const res = await post('', { cookie: 'pw', body: { walletPubkey, nonce: c.nonce, signature: sign(c.messageToSign, wallet.secretKey) } });
    expect(res.status).toBe(200);
    expect(linked.get('user-1')).toBe(walletPubkey);
  });
});

describe('wallet change needs the current wallet', () => {
  const oldWallet = nacl.sign.keyPair();
  const newWallet = nacl.sign.keyPair();
  const oldPubkey = bs58.encode(oldWallet.publicKey);
  const newPubkey = bs58.encode(newWallet.publicKey);

  it('answers 409 with the message to sign, and keeps the nonce live', async () => {
    linked.set('user-1', oldPubkey);
    const c = await challenge('pw');
    const signature = sign(c.messageToSign, newWallet.secretKey);
    const first = await post('', { cookie: 'pw', body: { walletPubkey: newPubkey, nonce: c.nonce, signature } });
    expect(first.status).toBe(409);
    const body = await first.json() as { code: string; fromPubkey: string; messageToSign: string };
    expect(body).toMatchObject({ code: 'wallet_change_needs_old_signature', fromPubkey: oldPubkey });
    expect(body.messageToSign).toBe(buildWalletChangeMessage('user-1', c.nonce, oldPubkey, newPubkey));
    expect(linked.get('user-1')).toBe(oldPubkey);

    const second = await post('', {
      cookie: 'pw',
      body: { walletPubkey: newPubkey, nonce: c.nonce, signature, previousSignature: sign(body.messageToSign, oldWallet.secretKey) },
    });
    expect(second.status).toBe(200);
    expect(linked.get('user-1')).toBe(newPubkey);
  });

  it('refuses a change signed by any wallet other than the current one', async () => {
    linked.set('user-1', oldPubkey);
    const c = await challenge('pw');
    const forged = sign(buildWalletChangeMessage('user-1', c.nonce, oldPubkey, newPubkey), newWallet.secretKey);
    const res = await post('', {
      cookie: 'pw',
      body: { walletPubkey: newPubkey, nonce: c.nonce, signature: sign(c.messageToSign, newWallet.secretKey), previousSignature: forged },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'invalid_old_wallet_signature' });
    expect(linked.get('user-1')).toBe(oldPubkey);
  });

  it('lets the same wallet link again without an extra signature', async () => {
    linked.set('user-1', oldPubkey);
    const c = await challenge('pw');
    const res = await post('', { cookie: 'pw', body: { walletPubkey: oldPubkey, nonce: c.nonce, signature: sign(c.messageToSign, oldWallet.secretKey) } });
    expect(res.status).toBe(200);
  });
});
