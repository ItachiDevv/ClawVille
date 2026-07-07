/**
 * Tokenomics Phase A / Slice A1 (2026-07-07) — wallet-link challenge nonce store.
 *
 * Mirrors the Phase 5.1 `auth-challenge.ts` shape (in-memory `Map` + periodic
 * janitor + single-use delete-on-read), but PURPOSE-FIT for self-custody wallet
 * linking:
 *
 *   - `POST /api/wallet/link/challenge` (authed) issues a nonce BOUND to the
 *     requesting `userId` + the exact human-readable `messageToSign`.
 *   - the user signs the UTF-8 bytes of `messageToSign` (SIWS-lite: readable in
 *     the wallet UI + names the target account — never a blind 32-byte blob).
 *   - `POST /api/wallet/link` (authed) presents { walletPubkey, nonce,
 *     signature }; we `consume(nonce, userId)` (anti-replay + binds the proof to
 *     the SAME account that requested it), reconstruct the message server-side
 *     from (userId, nonce), then verify the ed25519 signature against the
 *     CLAIMED walletPubkey.
 *
 * Binding the nonce to `userId` (vs the generic agent-reconnect store) means a
 * nonce issued to account A can never be consumed by account B — one fewer moving
 * part in a money-adjacent flow. Storage is a single-node in-memory Map (like
 * auth-challenge.ts); swap for Redis when the API scales past one node.
 *
 * TTL 120s — a wallet signature is an interactive user action (open wallet,
 * approve), so a little longer than the 60s agent-reconnect window, still short
 * enough to bound a leaked nonce. Size-capped at 10k (spam guard).
 */

import { randomBytes } from 'crypto';
import bs58 from 'bs58';

const NONCE_TTL_MS = 120 * 1000; // 120 seconds — interactive wallet-sign window
const MAX_NONCES = 10_000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

interface WalletLinkNonce {
  userId: string;
  expiresAt: number;
}

/** nonce (base58) → { userId, expiresAt }. */
const nonces = new Map<string, WalletLinkNonce>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of nonces) {
    if (now > entry.expiresAt) nonces.delete(nonce);
  }
  if (nonces.size > MAX_NONCES) {
    const sorted = [...nonces.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const toDrop = sorted.slice(0, nonces.size - MAX_NONCES);
    for (const [nonce] of toDrop) nonces.delete(nonce);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export interface WalletLinkChallengeIssued {
  nonce: string;
  expiresAt: string;
  /** The EXACT string the wallet must sign (UTF-8) — see buildWalletLinkMessage. */
  messageToSign: string;
}

/**
 * The EXACT string the wallet signs (UTF-8 bytes). Human-readable (SIWS-lite) so
 * wallet UIs display the intent instead of an opaque 32-byte blob, and
 * ACCOUNT-BOUND so a signature phished out of a victim on another site can only
 * ever link the wallet to the account NAMED IN THE TEXT the victim saw — it can
 * never be redirected to an attacker's account. (Raw blind-nonce signing was the
 * orchestrator-review finding this replaces: attacker requests a challenge for
 * HIS account, tricks the victim into blind-signing the bytes, then submits the
 * victim's pubkey+signature to pass hold-tier checks with the victim's balance.)
 */
export function buildWalletLinkMessage(userId: string, nonce: string): string {
  return `ClawVille wallet link\naccount: ${userId}\nnonce: ${nonce}`;
}

/**
 * Issue a fresh 32-byte random nonce bound to `userId`. The client has the
 * wallet sign the UTF-8 bytes of `messageToSign` (NOT the raw decoded nonce).
 */
export function issueWalletLinkChallenge(userId: string): WalletLinkChallengeIssued {
  const raw = randomBytes(32);
  const nonce = bs58.encode(raw);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, expiresAt: expiresAtMs });
  return {
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
    messageToSign: buildWalletLinkMessage(userId, nonce),
  };
}

/**
 * Atomically consume a nonce FOR a specific user. Returns true only when the
 * nonce existed, was issued to THIS `userId`, and had not expired. Delete-on-read
 * makes replay impossible; the userId check makes a cross-account replay
 * impossible even before the signature is verified.
 */
export function consumeWalletLinkChallenge(nonce: string, userId: string): boolean {
  const entry = nonces.get(nonce);
  if (!entry) return false;
  // Always delete on read (single-use), even on a userId/expiry mismatch, so a
  // guessed/leaked nonce can't be probed twice.
  nonces.delete(nonce);
  if (entry.userId !== userId) return false;
  if (Date.now() > entry.expiresAt) return false;
  return true;
}

/** Test-only helper — wipe the map. */
export function _resetWalletLinkNoncesForTest(): void {
  nonces.clear();
}
