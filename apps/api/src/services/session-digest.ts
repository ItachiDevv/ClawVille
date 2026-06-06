/**
 * Non-reversible digest of an agent-session id for logs + event/ledger metadata.
 *
 * SECURITY (Codex auth-lens fix #4, 2026-06-03): the raw agent-session id is the
 * REAL-ClawToken bearer credential — cove-blackjack.ts getSubject reads it from
 * the `X-Clawville-Agent-Session` header and any caller holding a live id can
 * open/deal/action/close against the bound avatar's real CT. Writing that raw id
 * into the `events` table (top-level `session_id` column OR a payload field), the
 * `claw_token_transactions.metadata` JSON, or a `console.log` line means anyone
 * with read access to those surfaces (an internal dashboard, a leaked log, a DB
 * dump) recovers a spendable bearer. We therefore log/store ONLY a one-way
 * sha256 prefix — enough to correlate rows for the same session during an
 * investigation, never enough to reconstruct the bearer.
 *
 * The 16-hex-char (8-byte / 64-bit) prefix keeps collisions astronomically
 * unlikely across the small set of concurrently-live sessions while staying
 * compact in a log line. sha256 is one-way, so the digest cannot be reversed to
 * the session id (which itself carries ~192 bits of CSPRNG entropy from the
 * `randomBytes(24)` mint, so even a brute-force pre-image is infeasible).
 *
 * NOTE: this is a CORRELATION id, not an auth credential — never accept a digest
 * as a substitute for the live session id at any privileged gate. The authority
 * remains `validateLiveAgentSession(sessionId)`.
 */

import { createHash } from 'crypto';

/** sha256(sessionId) → first 16 hex chars (64-bit prefix). One-way, non-reversible. */
export function sessionDigest(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}
