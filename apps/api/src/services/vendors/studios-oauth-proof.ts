/**
 * Wallet proof for linking or removing a Studios sign-in (MCP hub phase 3c).
 *
 * An agent can mint its owner's `magic_link` session (a session ticket from
 * the agent gateway, redeemed at /api/auth), so a human Lucia session alone
 * does not prove a human. Like the Studios key routes and spend-rules raises
 * (services/spend-policy-proof.ts, same message style), the human's LINKED
 * self-custody wallet signs a readable message that names the account, the
 * avatar, the vendor, the action, a single-use nonce and its expiry.
 *
 * Storage: an in-memory Map (single API node), TTL 120 s. A nonce is consumed
 * on the first verify, also when the verify fails.
 */

import { randomBytes } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export type StudiosSignInAction = 'link' | 'unlink';

const NONCE_TTL_MS = 120 * 1000;
const MAX_NONCES = 10_000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

interface SignInNonce {
  userId: string;
  message: string;
  expiresAt: number;
}

const nonces = new Map<string, SignInNonce>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of nonces) {
    if (now > entry.expiresAt) nonces.delete(nonce);
  }
  if (nonces.size > MAX_NONCES) {
    const sorted = [...nonces.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [nonce] of sorted.slice(0, nonces.size - MAX_NONCES)) nonces.delete(nonce);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

/** The EXACT UTF-8 text the linked wallet signs. */
export function buildStudiosSignInMessage(input: {
  userId: string;
  avatarId: string;
  vendor: string;
  action: StudiosSignInAction;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    'ClawVille paid tool sign-in',
    `account: ${input.userId}`,
    `avatar: ${input.avatarId}`,
    `tool: ${input.vendor}`,
    input.action === 'link'
      ? `action: link my own ${input.vendor} account by signing in`
      : `action: remove my ${input.vendor} sign-in`,
    `nonce: ${input.nonce}`,
    `expires: ${input.expiresAt}`,
  ].join('\n');
}

export interface StudiosSignInChallenge {
  nonce: string;
  expiresAt: string;
  messageToSign: string;
}

export function issueStudiosSignInChallenge(input: {
  userId: string;
  avatarId: string;
  vendor: string;
  action: StudiosSignInAction;
}): StudiosSignInChallenge {
  const nonce = bs58.encode(randomBytes(32));
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const message = buildStudiosSignInMessage({ ...input, nonce, expiresAt });
  nonces.set(nonce, { userId: input.userId, message, expiresAt: expiresAtMs });
  return { nonce, expiresAt, messageToSign: message };
}

export type StudiosSignInProofResult = 'ok' | 'invalid_challenge' | 'invalid_signature';

/**
 * Consume the nonce (single use, also on failure) and verify that
 * `walletPubkey` signed the message for THIS user, avatar, vendor and action.
 */
export function verifyStudiosSignInProof(input: {
  userId: string;
  avatarId: string;
  vendor: string;
  action: StudiosSignInAction;
  nonce: string;
  signature: string;
  walletPubkey: string;
}): StudiosSignInProofResult {
  const entry = nonces.get(input.nonce);
  if (!entry) return 'invalid_challenge';
  nonces.delete(input.nonce);
  if (entry.userId !== input.userId || Date.now() > entry.expiresAt) return 'invalid_challenge';
  const expected = buildStudiosSignInMessage({
    userId: input.userId,
    avatarId: input.avatarId,
    vendor: input.vendor,
    action: input.action,
    nonce: input.nonce,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  });
  if (expected !== entry.message) return 'invalid_challenge';
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = bs58.decode(input.signature);
    pub = bs58.decode(input.walletPubkey);
  } catch {
    return 'invalid_signature';
  }
  if (sig.length !== 64 || pub.length !== 32) return 'invalid_signature';
  return nacl.sign.detached.verify(new TextEncoder().encode(expected), sig, pub) ? 'ok' : 'invalid_signature';
}

/** Test-only helper: wipe the map. */
export function _resetStudiosSignInNoncesForTest(): void {
  nonces.clear();
}
