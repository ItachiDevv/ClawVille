/**
 * Land hold-wallet ownership proof — DOOR 1 nonce store (2026-08-10).
 *
 * Founder ruling 2026-08-10: proof of control over the declared land hold wallet
 * is REQUIRED before the hold door opens ("optional proof is just not proof").
 * Declaring a wallet you do not control previously let an account claim
 * hold-door land backed by SOMEONE ELSE'S CLV balance.
 *
 * This is the free, instant, primary door: the account signs a server-issued
 * nonce with the declared wallet's key.
 *
 *   - `POST /api/land/hold-wallet/verify/challenge` issues a nonce BOUND to the
 *     requesting `userId` AND to the account's CURRENTLY DECLARED wallet, plus
 *     the exact human-readable `messageToSign`.
 *   - the wallet signs the UTF-8 bytes of `messageToSign` (SIWS-lite: readable
 *     in the wallet UI + names both the account and the wallet — never a blind
 *     32-byte blob).
 *   - `POST /api/land/hold-wallet/verify/signature` presents `{ nonce,
 *     signature }`; we `consume(nonce, userId, declaredWallet)`, reconstruct the
 *     message server-side, then verify the ed25519 signature against the
 *     SERVER-READ declared pubkey (never a client-supplied one).
 *
 * Deliberately a verbatim sibling of `wallet-link-challenge.ts` — same in-memory
 * Map, same 120s TTL, same delete-on-read single use, same size cap + unref'd
 * janitor, same "false on ANY mismatch" consume. Read that file's header for the
 * PHISHED BLIND-SIGNATURE attack the account binding exists to kill: an attacker
 * requests a challenge for HIS account, tricks the victim into blind-signing the
 * bytes, then submits the victim's pubkey + signature to pass hold-tier checks
 * with the victim's balance. Naming the account IN THE TEXT THE VICTIM SEES is
 * what closes it, so the `account:` line is NOT optional decoration.
 *
 * ADDED HERE beyond the wallet-link message: a `wallet:` line, and the wallet is
 * bound in the store as well. Without it a nonce issued while wallet A was
 * declared could be spent after a repoint to wallet B, and the signature would
 * verify against a message that never named B.
 *
 * Storage is a single-node in-memory Map (like `auth-challenge.ts` and
 * `wallet-link-challenge.ts`); swap for Redis when the API scales past one node.
 */

import { randomBytes } from 'crypto';
import bs58 from 'bs58';

const NONCE_TTL_MS = 120 * 1000; // 120 seconds — interactive wallet-sign window
const MAX_NONCES = 10_000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

interface LandHoldWalletNonce {
  userId: string;
  /** The declared wallet this nonce was issued for. */
  walletAddress: string;
  expiresAt: number;
}

/** nonce (base58) → { userId, walletAddress, expiresAt }. */
const nonces = new Map<string, LandHoldWalletNonce>();

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

export interface LandHoldWalletChallengeIssued {
  nonce: string;
  expiresAt: string;
  /** The EXACT string the wallet must sign (UTF-8) — see buildLandHoldWalletMessage. */
  messageToSign: string;
  /** Echoed so the client signs with the wallet the SERVER believes is declared. */
  walletAddress: string;
}

/**
 * The EXACT string the wallet signs (UTF-8 bytes). Human-readable (SIWS-lite),
 * ACCOUNT-BOUND (kills the phished blind-signature redirect) and WALLET-BOUND (a
 * signature can never be replayed against a different declared wallet).
 *
 * Frozen wire format — the protocol manual documents it verbatim for BYO agents,
 * so changing it is a PROTOCOL_VERSION bump, not a refactor:
 *
 *   ClawVille land hold wallet
 *   account: <userId>
 *   wallet: <declared pubkey>
 *   nonce: <nonce>
 */
export function buildLandHoldWalletMessage(
  userId: string,
  walletAddress: string,
  nonce: string,
): string {
  return `ClawVille land hold wallet\naccount: ${userId}\nwallet: ${walletAddress}\nnonce: ${nonce}`;
}

/**
 * Issue a fresh 32-byte random nonce bound to `userId` + `walletAddress`. The
 * caller has the wallet sign the UTF-8 bytes of `messageToSign` (NOT the raw
 * decoded nonce).
 */
export function issueLandHoldWalletChallenge(
  userId: string,
  walletAddress: string,
): LandHoldWalletChallengeIssued {
  const raw = randomBytes(32);
  const nonce = bs58.encode(raw);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, walletAddress, expiresAt: expiresAtMs });
  return {
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
    messageToSign: buildLandHoldWalletMessage(userId, walletAddress, nonce),
    walletAddress,
  };
}

/**
 * Atomically consume a nonce FOR a specific (user, declared wallet) pair.
 * Returns true only when the nonce existed, was issued to THIS `userId` for
 * THIS `walletAddress`, and had not expired.
 *
 * Delete-on-read makes replay impossible; the userId check makes a cross-account
 * replay impossible even before the signature is verified; the wallet check
 * makes a repoint-then-spend impossible. We delete on EVERY read, including a
 * mismatch, so a guessed or leaked nonce cannot be probed twice.
 */
export function consumeLandHoldWalletChallenge(
  nonce: string,
  userId: string,
  walletAddress: string,
): boolean {
  const entry = nonces.get(nonce);
  if (!entry) return false;
  nonces.delete(nonce);
  if (entry.userId !== userId) return false;
  if (entry.walletAddress !== walletAddress) return false;
  if (Date.now() > entry.expiresAt) return false;
  return true;
}

/** Test-only helper — wipe the map. */
export function _resetLandHoldWalletNoncesForTest(): void {
  nonces.clear();
}

/** Test-only helper — force an issued nonce to be already expired. */
export function _expireLandHoldWalletNonceForTest(nonce: string): boolean {
  const entry = nonces.get(nonce);
  if (!entry) return false;
  entry.expiresAt = Date.now() - 1;
  return true;
}
