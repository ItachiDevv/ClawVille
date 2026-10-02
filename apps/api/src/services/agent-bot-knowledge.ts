/**
 * Security C4 + C5 (batch 2, ported from the 2026-09-30 security pass) — the
 * owner rule for `openclaw_bots.knowledge`.
 *
 * Visit-building, building chat and legacy location-chat append caller-
 * influenced text to the bot row, and that text later enters the owner's
 * prompts. The same rows are read back by GET /:sessionId/knowledge, /stats and
 * the /connect response. The rule is connect-sec's use-time owner proof in
 * `resolveAgentSession` (`require-auth-or-agent.ts`): the session config's
 * proven `boundUserId` equals the row's CURRENT `user_id`. It does NOT need
 * `ledgerCapable` (`sessionLedgerCapable` in `agent-owner-binding.ts` gates real
 * CT, not this data), so an owner-proven non-ledger session (restored after a
 * deploy, the /enter keeper) keeps its own row's knowledge, the same way it
 * keeps its wallet, owned skills and skill memory through `resolveAgentSession`.
 *   - an unbound row (`user_id IS NULL`) stays open to every live session;
 *   - an owned row is open only to a session whose `boundUserId` equals the
 *     row's `user_id` (a null or different `boundUserId` is an unproven session).
 *
 * A read-then-write check is not enough for the writes: an anonymous session
 * can read an unbound row, the owner can bind it, and the anonymous write then
 * lands on the owner's row. So every such UPDATE carries
 * `botKnowledgeWriteOwnerCondition` and the caller treats zero returned rows as
 * "not written". `botKnowledgeAppend` makes the append itself atomic as well.
 */
import type { SQL } from 'drizzle-orm';
import { agentBots, isNull, sql } from '@clawville/database';

type SessionOwnerProof = { boundUserId?: string | null };

/**
 * 403 body for an owner-private read from a session that has not proved
 * ownership of the bound row (same code and shape as `agent-pay.ts`, kept so
 * existing clients branch on one code; the C7 exports also use it for a
 * non-ledger agent session).
 */
export const AGENT_SESSION_NOT_LEDGER_AUTHORIZED_BODY = Object.freeze({
  error: 'agent_session_not_ledger_authorized',
  code: 'agent_session_not_ledger_authorized',
} as const);

/**
 * May this session read or write the knowledge of a row owned by `rowUserId`?
 * The non-atomic statement of `botKnowledgeWriteOwnerCondition`; read paths use
 * it directly, write paths use it to skip the UPDATE early.
 */
export function botKnowledgeAccessible(
  session: SessionOwnerProof,
  rowUserId: string | null,
): boolean {
  return rowUserId === null || (session.boundUserId ?? null) === rowUserId;
}

/**
 * The SET value for appending `entries` to `openclaw_bots.knowledge` (jsonb
 * string[]) inside the UPDATE. Writing back an array built from an earlier read
 * loses an entry when two allowed writes race; the jsonb `||` append does not.
 * Callers still skip entries already present at read time, so a true race can
 * at worst duplicate an entry, never drop one.
 */
export function botKnowledgeAppend(entries: string[]): SQL {
  return sql`coalesce(${agentBots.knowledge}, '[]'::jsonb) || ${JSON.stringify(entries)}::jsonb`;
}

/**
 * The WHERE condition every bot-knowledge UPDATE carries: the atomic form of
 * `botKnowledgeAccessible(session, user_id)`, evaluated against the live row.
 *   - a session with a proven `boundUserId` (ledger-capable or not) may write an
 *     unbound row or the row its `boundUserId` owns;
 *   - a session without owner proof may write only while the row is unbound.
 */
export function botKnowledgeWriteOwnerCondition(session: SessionOwnerProof): SQL {
  const provenUserId = session.boundUserId ?? null;
  return provenUserId !== null
    ? sql`(${agentBots.userId} IS NULL OR ${agentBots.userId} = ${provenUserId})`
    : isNull(agentBots.userId);
}
