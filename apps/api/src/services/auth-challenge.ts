/**
 * Phase 5.1 — signed-challenge reconnect nonce store.
 *
 * The `/api/agent/challenge` endpoint issues a short-lived random nonce
 * that the caller's agent signs with its identity private key; the
 * subsequent `/api/agent/reconnect` call presents the signature, which
 * we verify against `users.identity_pubkey`.
 *
 * Storage is an in-memory `Map<nonce, expiresAt>` with periodic cleanup,
 * mirroring the existing `pendingConnections` pattern in agent-gateway.ts.
 * This works today because the API is single-node on Hetzner; when we
 * scale to multi-node, swap for Redis. Nonces are single-use — consumed
 * atomically via `consumeNonce()` which deletes on first read.
 *
 * TTL: 60 seconds per plan §5.2 — long enough for network round-trips
 * from an agent in a different data center, short enough to bound the
 * window a leaked nonce can be replayed.
 *
 * Size cap: 10_000 nonces. If we ever have 10k unexpired nonces floating
 * around, something's wrong (spam, or a broken caller polling in a
 * tight loop) — we drop the oldest to prevent unbounded memory growth.
 */

import { randomBytes } from 'crypto';
import bs58 from 'bs58';

const NONCE_TTL_MS = 60 * 1000; // 60 seconds
const MAX_NONCES = 10_000;
const CLEANUP_INTERVAL_MS = 30 * 1000; // sweep every 30s

/** nonce (base58) → expiresAt (epoch ms). */
const nonces = new Map<string, number>();

/**
 * Periodic janitor — sweeps expired entries every 30s. setInterval
 * handle kept in module-scope so tests or graceful shutdown can clear
 * it if needed. `unref()` so Bun doesn't keep the process alive just
 * for this timer during graceful shutdown.
 */
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of nonces) {
    if (now > expiresAt) nonces.delete(nonce);
  }
  // Hard cap — drop oldest entries by expiresAt when the map gets huge
  // (spam guard). Only kicks in if the periodic sweep isn't keeping up,
  // which shouldn't happen under normal load.
  if (nonces.size > MAX_NONCES) {
    const sorted = [...nonces.entries()].sort((a, b) => a[1] - b[1]);
    const toDrop = sorted.slice(0, nonces.size - MAX_NONCES);
    for (const [nonce] of toDrop) nonces.delete(nonce);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export interface ChallengeIssued {
  nonce: string;
  expiresAt: string;
}

/**
 * Issue a fresh 32-byte random nonce, base58-encoded. Caller stores it
 * in the signed-challenge flow map and returns it to the agent, which
 * signs `bs58.decode(nonce)` with its identity private key.
 */
export function issueChallenge(): ChallengeIssued {
  const raw = randomBytes(32);
  const nonce = bs58.encode(raw);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, expiresAtMs);
  return {
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Atomically consume a nonce. Returns true if the nonce existed AND
 * wasn't expired — false otherwise (missing, expired, or already
 * consumed by a concurrent call). The delete-on-read semantics mean
 * replay attacks are impossible: the second caller's `consumeNonce()`
 * returns false even if the signature is valid.
 */
export function consumeNonce(nonce: string): boolean {
  const expiresAt = nonces.get(nonce);
  if (expiresAt == null) return false;
  nonces.delete(nonce);
  if (Date.now() > expiresAt) return false;
  return true;
}

/** Test-only helper — wipe the map. */
export function _resetNoncesForTest(): void {
  nonces.clear();
}
