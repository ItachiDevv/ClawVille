/**
 * Phase 5 — session-ticket minting + redemption service.
 *
 * Minted by `/api/agent/connect` and `/api/agent/join`, consumed by
 * `GET /api/auth/enter?t=...`. The ticket itself is a 128-bit random
 * value base58-encoded with a `sess-` prefix for readability. See spec
 * §7.
 *
 * Redemption atomicity: the exchange handler calls `consumeTicket`,
 * which issues a single `UPDATE ... SET consumed_at = now() WHERE
 * consumed_at IS NULL AND expires_at > now() RETURNING *`. No row is
 * ever read-then-written; either the atomic UPDATE returns a row (and
 * that row is the authoritative "this request owns the ticket" signal)
 * or it returns nothing (and the caller redirects with an error).
 */

import { randomBytes } from 'crypto';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { db, agentSessionTickets, sql } from '@clawville/database';
import { sessionDigest } from './session-digest';

/**
 * Default TTL matches the spec (10 min). Overridable via env for load
 * testing or for UX experiments around longer/shorter windows. Guard
 * rails: minimum 60s (below that, human click-through latency eats the
 * whole budget), max 3600s (beyond that, a leaked ticket lives too
 * long).
 */
const DEFAULT_TTL_SECONDS = 600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

function resolveTtlSeconds(): number {
  const raw = process.env.AGENT_SESSION_TICKET_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_TTL_SECONDS;
  if (n < MIN_TTL_SECONDS) return MIN_TTL_SECONDS;
  if (n > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return n;
}

/**
 * `WEB_ORIGIN` is the public origin of the Next.js frontend. Falls back
 * to `CORS_ORIGIN`'s first comma-separated value (which is already used
 * everywhere in the API as the allowed frontend origin), then to
 * production. Kept defensive so a forgotten env var in local dev still
 * produces a URL that points *somewhere* rather than `undefined`.
 */
function resolveWebOrigin(): string {
  if (process.env.WEB_ORIGIN) return process.env.WEB_ORIGIN.replace(/\/+$/, '');
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')[0]?.trim();
  if (corsOrigin) return corsOrigin.replace(/\/+$/, '');
  return 'https://clawville.world';
}

/**
 * Base58 alphabet (Bitcoin-flavor — no 0/O/I/l). Short, URL-safe, and
 * visually unambiguous when humans read it out of a chat window.
 */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58encode(buf: Buffer): string {
  // Standard base58 big-endian encode. Leading zero bytes map to '1'.
  let num = 0n;
  for (const byte of buf) {
    num = (num << 8n) + BigInt(byte);
  }
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num /= 58n;
    out = BASE58[rem] + out;
  }
  // Preserve leading-zero bytes as '1' prefix chars (base58 convention).
  for (const byte of buf) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/**
 * Generate a fresh 128-bit random ticket. `sess-` prefix is cosmetic
 * (helps humans visually separate it from `ct-` connect tokens).
 */
function generateTicket(): string {
  // 16 bytes = 128 bits. base58 of 16 random bytes is ~22 chars.
  return `sess-${base58encode(randomBytes(16))}`;
}

export interface MintedTicket {
  ticket: string;
  url: string;
  expiresAt: string; // ISO-8601
  instruction: string;
}

/**
 * Insert a fresh ticket row and return the caller-facing bundle.
 *
 * `avatarName` is optional — when the caller has it, we use it in the
 * instruction copy so the human sees e.g. "Open this URL to enter
 * ClawVille as Reef-King" instead of the generic fallback.
 */
export async function mintSessionTicket(params: {
  userId: string;
  avatarId?: string | null;
  identityType: string;
  identityKey: string;
  issuedToAgentSession?: string | null;
  avatarName?: string | null;
}): Promise<MintedTicket> {
  const { userId, avatarId, identityType, identityKey, issuedToAgentSession, avatarName } = params;

  const ttlSeconds = resolveTtlSeconds();
  const now = Date.now();
  const expiresAt = new Date(now + ttlSeconds * 1000);

  const ticket = generateTicket();

  await db.insert(agentSessionTickets).values({
    ticket,
    userId,
    avatarId: avatarId ?? null,
    // Write-only provenance digest, NOT the raw real-CT bearer (Codex auth-lens
    // fix #4): consumeTicket never re-reads this as a live bearer, so digesting
    // cannot break redemption. Never persist a recoverable session bearer.
    issuedToAgentSession: issuedToAgentSession ? sessionDigest(issuedToAgentSession) : null,
    expiresAt,
    identityType,
    identityKey,
  });

  const webOrigin = resolveWebOrigin();
  const url = `${webOrigin}/enter?t=${encodeURIComponent(ticket)}`;

  const ttlMinutes = Math.round(ttlSeconds / 60);
  const subject = avatarName ? `as ${avatarName}` : 'and meet your agent';
  const instruction = `Open this URL to enter ClawVille ${subject}. Link expires in ${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}.`;

  return {
    ticket,
    url,
    expiresAt: expiresAt.toISOString(),
    instruction,
  };
}

export interface ConsumedTicket {
  userId: string;
  avatarId: string | null;
  ticket: string;
  identityType: string;
}

/**
 * Atomically consume a ticket. Returns the ticket row's
 * authenticating fields if the UPDATE succeeded, or null if the ticket
 * was invalid / expired / already consumed.
 *
 * Uses a raw SQL UPDATE so the WHERE + RETURNING run in a single
 * round-trip. Drizzle's fluent builder supports `.returning()` on
 * updates but the conditional `consumed_at IS NULL` in the WHERE is
 * expressed most clearly as a single SQL template here.
 */
export async function consumeTicket(ticket: string): Promise<ConsumedTicket | null> {
  // Atomic: WHERE clauses + RETURNING run in a single statement. If
  // two redemption requests arrive simultaneously for the same ticket,
  // Postgres row-level locking ensures exactly one UPDATE returns a
  // row; the other returns an empty array and we redirect with an
  // expired-link error. No pre-read, no race window.
  const updated = await db
    .update(agentSessionTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(agentSessionTickets.ticket, ticket),
        isNull(agentSessionTickets.consumedAt),
        gt(agentSessionTickets.expiresAt, sql`now()`),
      ),
    )
    .returning({
      userId: agentSessionTickets.userId,
      avatarId: agentSessionTickets.avatarId,
      ticket: agentSessionTickets.ticket,
      identityType: agentSessionTickets.identityType,
    });

  const row = updated[0];
  if (!row) return null;
  return {
    userId: row.userId,
    avatarId: row.avatarId,
    ticket: row.ticket,
    identityType: row.identityType,
  };
}
