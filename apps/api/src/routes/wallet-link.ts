/**
 * Tokenomics Phase A / Slice A1 (2026-07-07) — self-custody wallet link.
 *
 *   POST /api/wallet/link/challenge — issue a nonce bound to the caller.
 *   POST /api/wallet/link           — prove wallet control (sign the nonce) → link.
 *   GET  /api/wallet/link           — read the linked wallet + its CLV balance.
 *
 * The user proves they control a self-custody wallet by signing a server-issued
 * challenge with that wallet's key — the SAME signed-challenge shape as the Phase
 * 5.1 agent reconnect (`agent-gateway.ts /reconnect`), reused here. We verify the
 * ed25519 signature against the CLAIMED wallet pubkey, then persist the pubkey as
 * a POINTER on `users.linked_wallet_pubkey`. The wallet's CLV never leaves it and
 * we never touch its private key — this is a non-custodial balance-read link
 * (Kintara's pattern), the basis for the hold-tier / seller-license / land
 * hold-to-keep checks.
 *
 * PARITY (Rule E5): the human path is these three routes (Lucia session). The
 * AGENT path — a connected/hosted agent linking its OWNER's wallet — follows in
 * Phase C (agent-owner wallet linking), per the Phase A plan; the balance service
 * (`linked-wallet-clv-balance.ts`) is already agent-agnostic (keyed by userId), so
 * Phase C only adds the agent-session write path, not a second balance reader.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db, users, eq } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import {
  issueWalletLinkChallenge,
  consumeWalletLinkChallenge,
} from '../services/wallet-link-challenge';
import {
  getLinkedWalletClvBalance,
  invalidateClvBalanceCache,
} from '../services/linked-wallet-clv-balance';
import type { AppContext } from '../types';

export const walletLinkRoutes = new Hono<AppContext>();

walletLinkRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// POST /challenge — issue a nonce bound to the caller
// ---------------------------------------------------------------------------
walletLinkRoutes.post('/challenge', requireAuth, requireNonGuestUser, async (c) => {
  const user = c.get('user') as { id: string };
  const issued = issueWalletLinkChallenge(user.id);
  return c.json(issued);
});

// ---------------------------------------------------------------------------
// POST / — prove wallet control (sign the nonce with the wallet key) → link
// ---------------------------------------------------------------------------
// 32-byte base58 pubkey → 43–44 chars (min 32 for the leading-zero edge case);
// 32-byte base58 nonce → 43–44 chars; 64-byte base58 signature → 86–88 chars.
const linkSchema = z.object({
  walletPubkey: z.string().min(32).max(44),
  nonce: z.string().min(32).max(64),
  signature: z.string().min(80).max(96),
});

walletLinkRoutes.post('/', requireAuth, requireNonGuestUser, async (c) => {
  const user = c.get('user') as { id: string };

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
  }
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
      400,
    );
  }
  const { walletPubkey, nonce, signature } = parsed.data;

  // 1) Consume the nonce FOR this user (single-use + cross-account replay guard).
  //    Generic 401 so a caller can't distinguish missing / expired / wrong-user.
  if (!consumeWalletLinkChallenge(nonce, user.id)) {
    return c.json({ error: 'invalid_or_expired_challenge', code: 'invalid_challenge' }, 401);
  }

  // 2) Verify the ed25519 signature of the RAW 32-byte nonce against the CLAIMED
  //    wallet pubkey. `nacl.sign.detached.verify` returns false on any malformed
  //    input; we bs58-decode first + length-check so a garbage pubkey is a clean
  //    400 (not a link to an un-spendable key).
  let nonceBytes: Uint8Array;
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    nonceBytes = bs58.decode(nonce);
    sigBytes = bs58.decode(signature);
    pubBytes = bs58.decode(walletPubkey);
  } catch {
    return c.json({ error: 'invalid_signature', code: 'invalid_signature' }, 400);
  }
  if (pubBytes.length !== 32) {
    return c.json({ error: 'invalid_wallet_pubkey', code: 'invalid_wallet_pubkey' }, 400);
  }
  if (sigBytes.length !== 64) {
    return c.json({ error: 'invalid_signature', code: 'invalid_signature' }, 400);
  }
  const ok = nacl.sign.detached.verify(nonceBytes, sigBytes, pubBytes);
  if (!ok) {
    return c.json({ error: 'signature_verification_failed', code: 'invalid_signature' }, 401);
  }

  // 3) Persist the link (re-linking REPLACES the prior pubkey). The partial
  //    UNIQUE index (users_linked_wallet_pubkey_unique) is the hard guard that
  //    one wallet backs at most one account; a collision surfaces as a clean 409.
  try {
    await db
      .update(users)
      .set({ linkedWalletPubkey: walletPubkey, linkedWalletAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '23505') {
      return c.json(
        { error: 'wallet_already_linked', code: 'wallet_already_linked' },
        409,
      );
    }
    console.error('[wallet-link] persist failed:', (err as Error).message);
    return c.json({ error: 'link_failed', code: 'link_failed' }, 500);
  }

  // Fresh balance on the next GET (the new pubkey may have a cached zero from a
  // pre-link probe by another user; drop it so this link reads live).
  invalidateClvBalanceCache(walletPubkey);

  const result = await getLinkedWalletClvBalance(user.id);
  return c.json({ ok: true, linked: true, walletPubkey, clv: result.clv });
});

// ---------------------------------------------------------------------------
// GET / — read the linked wallet + its (cached) CLV balance
// ---------------------------------------------------------------------------
walletLinkRoutes.get('/', requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const result = await getLinkedWalletClvBalance(user.id);
  return c.json(result);
});

export default walletLinkRoutes;
