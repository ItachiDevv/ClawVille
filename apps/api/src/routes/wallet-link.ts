/**
 * Tokenomics Phase A / Slice A1 (2026-07-07) — self-custody wallet link.
 *
 *   POST /api/wallet/link/challenge — issue a nonce bound to the caller.
 *   POST /api/wallet/link           — prove wallet control (sign the nonce) → link.
 *   GET  /api/wallet/link           — read the linked wallet + its CLV balance.
 *
 * The user proves they control a self-custody wallet by signing a server-issued
 * challenge with that wallet's key. UNLIKE the Phase 5.1 agent reconnect (raw
 * nonce — fine for agent-owned keys with no wallet-UI phishing surface), HUMAN
 * wallet linking signs an ACCOUNT-BOUND human-readable message (SIWS-lite; see
 * buildWalletLinkMessage) so a blind-signed blob phished on another site can
 * never link a victim's wallet to an attacker's account. We verify the
 * ed25519 signature against the CLAIMED wallet pubkey, then persist the pubkey as
 * a POINTER on `users.linked_wallet_pubkey`. The wallet's CLV never leaves it and
 * we never touch its private key — this is a non-custodial balance-read link
 * (Kintara's pattern), the basis for the hold-tier / seller-license / land
 * hold-to-keep checks.
 *
 * PARITY (Rule E5): the human path is these three Lucia-session routes. A human
 * can explicitly enrol the linked wallet for Trading Floor observation. An agent
 * cannot enrol its owner's personal linked wallet. Agents use signature,
 * custodial, or server-internal ClawPump trading-wallet binds instead.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { and, db, eq, isNull, sql, tradingWallets, users } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import {
  refuseAgentHeader,
  requireHumanSessionOrigin,
  type HumanGateCopy,
} from '../middleware/require-human-session';
import { noStorePrivate } from '../middleware/no-store';
import {
  issueWalletLinkChallenge,
  consumeWalletLinkChallenge,
  buildWalletLinkMessage,
  buildWalletChangeMessage,
  peekWalletLinkChallenge,
} from '../services/wallet-link-challenge';
import {
  getLinkedWalletClvBalance,
  invalidateClvBalanceCache,
} from '../services/linked-wallet-clv-balance';
import type { AppContext } from '../types';
import { syncLinkedTradingWallet } from '../services/trading-wallets';

export const walletLinkRoutes = new Hono<AppContext>();

walletLinkRoutes.use('*', sessionMiddleware);

// Linking is an owner act (phase 1b, 2026-11-05): the linked wallet approves
// spend-rule raises and receives market payouts, so an agent request, an
// agent-exchanged cookie, a guest session and a pre-0089 session are refused.
const GATE: HumanGateCopy = {
  humanOnlyCode: 'wallet_link_human_only',
  humanOnlyMessage: 'Only the human owner can link a wallet, from their own browser sign-in.',
  needsLoginCode: 'wallet_link_needs_human_login',
  needsLoginMessage: 'Sign in again in your browser, then link your wallet.',
};
const humanOnly = [refuseAgentHeader(GATE), requireAuth, requireHumanSessionOrigin(GATE), requireNonGuestUser] as const;

class OldWalletProofError extends Error {}

function verifyEd25519(message: string, signature: string, pubkey: string): boolean {
  try {
    const sig = bs58.decode(signature);
    const pub = bs58.decode(pubkey);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /challenge — issue a nonce bound to the caller
// ---------------------------------------------------------------------------
walletLinkRoutes.post('/challenge', ...humanOnly, async (c) => {
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
  /** Signature of buildWalletChangeMessage by the CURRENTLY linked wallet; needed only to change it. */
  previousSignature: z.string().min(80).max(96).optional(),
}).strict();

walletLinkRoutes.post('/', ...humanOnly, async (c) => {
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
  const { walletPubkey, nonce, signature, previousSignature } = parsed.data;

  // 1) The nonce must be live FOR this user. It is consumed below, after the
  //    wallet-change check, so a 409 lets the caller retry with the same nonce.
  //    Generic 401 so a caller can't distinguish missing / expired / wrong-user.
  if (!peekWalletLinkChallenge(nonce, user.id)) {
    return c.json({ error: 'invalid_or_expired_challenge', code: 'invalid_challenge' }, 401);
  }

  // 2) Verify the ed25519 signature of the ACCOUNT-BOUND human-readable message
  //    (SIWS-lite, reconstructed server-side from THIS user's id + the nonce —
  //    see buildWalletLinkMessage for the blind-signing attack this closes)
  //    against the CLAIMED wallet pubkey. `nacl.sign.detached.verify` returns
  //    false on any malformed input; we bs58-decode + length-check first so a
  //    garbage pubkey is a clean 400 (not a link to an un-spendable key).
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
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
  const messageBytes = new TextEncoder().encode(buildWalletLinkMessage(user.id, nonce));
  const ok = nacl.sign.detached.verify(messageBytes, sigBytes, pubBytes);
  if (!ok) {
    return c.json({ error: 'signature_verification_failed', code: 'invalid_signature' }, 401);
  }

  // 2b) Changing an existing link needs the CURRENT wallet's approval. A magic
  //     link passes through the agent, so the session alone must not swap it.
  const existing = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { linkedWalletPubkey: true },
  });
  const fromPubkey = existing?.linkedWalletPubkey ?? null;
  if (fromPubkey && fromPubkey !== walletPubkey && !previousSignature) {
    return c.json({
      error: 'wallet_change_needs_old_signature',
      code: 'wallet_change_needs_old_signature',
      fromPubkey,
      messageToSign: buildWalletChangeMessage(user.id, nonce, fromPubkey, walletPubkey),
      message: 'Your current linked wallet must approve this change.',
    }, 409);
  }

  if (!consumeWalletLinkChallenge(nonce, user.id)) {
    return c.json({ error: 'invalid_or_expired_challenge', code: 'invalid_challenge' }, 401);
  }

  // 3) Persist the link (re-linking REPLACES the prior pubkey). The partial
  //    UNIQUE index (users_linked_wallet_pubkey_unique) is the hard guard that
  //    one wallet backs at most one account; a collision surfaces as a clean 409.
  try {
    await db.transaction(async (tx) => {
      // Re-read the link under a row lock so a concurrent change cannot slip past
      // the old-wallet check.
      const locked = await tx.execute<{ linked_wallet_pubkey: string | null }>(
        sql`SELECT linked_wallet_pubkey FROM users WHERE id = ${user.id} FOR UPDATE`,
      );
      const current = Array.from(locked)[0]?.linked_wallet_pubkey ?? null;
      if (current && current !== walletPubkey) {
        const approved = !!previousSignature && verifyEd25519(
          buildWalletChangeMessage(user.id, nonce, current, walletPubkey),
          previousSignature,
          current,
        );
        if (!approved) throw new OldWalletProofError();
      }
      const activeLinked = await tx.select({ avatarId: tradingWallets.avatarId }).from(tradingWallets)
        .where(and(eq(tradingWallets.userId, user.id), eq(tradingWallets.source, 'linked'), isNull(tradingWallets.revokedAt))).limit(1);
      if (activeLinked[0]) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trading-bind:${activeLinked[0].avatarId}`}, 0))`);
      }
      await tx
        .update(users)
        .set({ linkedWalletPubkey: walletPubkey, linkedWalletAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, user.id));
      await syncLinkedTradingWallet({ userId: user.id, newPubkey: walletPubkey, tx });
    });
  } catch (err) {
    if (err instanceof OldWalletProofError) {
      return c.json({ error: 'invalid_old_wallet_signature', code: 'invalid_old_wallet_signature' }, 401);
    }
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
walletLinkRoutes.get('/', requireAuth, noStorePrivate, async (c) => {
  const user = c.get('user') as { id: string };
  const result = await getLinkedWalletClvBalance(user.id);
  return c.json(result);
});

export default walletLinkRoutes;
