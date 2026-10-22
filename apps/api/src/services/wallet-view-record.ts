/**
 * `wallet.viewed` RECORDER (2026-10-22 quests wire) — the proof the
 * `wallet-aware` tutorial quest reads. Context-free so BOTH callers use it:
 * `GET /api/wallet/balances` (routes/wallet-withdraw.ts, passes the request's
 * anti-farm tags) and the hosted-agent `view_wallet` `[ACTION:]` verb
 * (npc-simulation.ts, passes nothing).
 *
 * Logged ONCE per avatar: the in-process Set skips the DB check after the
 * first view, and the existence check (covered by idx_events_avatar_ts) stops
 * a second row across restarts and pods. The Set is bounded; on overflow it
 * clears, which only costs one cheap re-check per avatar.
 *
 * WHO: any authenticated subject except a guest (demo economy; cannot claim
 * real-vCLAW quests) and a server-owned house agent (the quest is a faucet).
 * Both facts never change for a subject, so an ineligible avatar stays in the
 * Set and costs no further queries. A view counts with OR without a custodial
 * wallet: avatars created without one still open the Wallet panel and get the
 * `wallet_missing` 404 (on prod 2026-10-22: 55 of 420 real avatars).
 *
 * IMPORT RULE: no route and no middleware that pulls `npc-simulation.ts`
 * (the executor imports this module; that would be a load-time cycle).
 */

import { db, sql } from '@clawville/database';
import { logEventReturningId } from './event-logger';
import { isHouseAgentId } from './autonomous-cove-agent-binding';
import { isGuestUser } from '../middleware/require-non-guest';

export interface WalletViewActor {
  kind: 'user' | 'agent' | 'guest' | string;
  userId: string;
  avatarId: string;
  agentId?: string | null;
  /**
   * An agent records the proof only when this is `true`, the same rule the
   * hosted `view_wallet` verb and the cosmetic services apply (Codex review
   * 2026-10-22). The balance read itself stays open to the agent.
   */
  ledgerCapable?: boolean;
}

export interface WalletViewMeta {
  fpHash?: string | null;
  ipPrefixHash?: string | null;
}

const WALLET_VIEWED_SEEN_CAP = 10_000;
const walletViewedSeen = new Set<string>();

/** Record the avatar's first wallet view. Never throws. */
export async function recordFirstWalletView(
  actor: WalletViewActor,
  meta?: WalletViewMeta,
): Promise<void> {
  try {
    const avatarId = actor.avatarId;
    if (!avatarId) return;
    // Checked BEFORE the Set: ledger authority can change for a live agent, so
    // a refusal here is never cached.
    if (actor.kind === 'agent' && actor.ledgerCapable !== true) return;
    if (walletViewedSeen.has(avatarId)) return;
    if (walletViewedSeen.size >= WALLET_VIEWED_SEEN_CAP) walletViewedSeen.clear();
    // Claim the slot BEFORE the awaits so two concurrent reads in this process
    // log one row, not two. Released on any failure so a later read retries.
    walletViewedSeen.add(avatarId);
    try {
      if (actor.kind === 'guest') return;
      if (actor.kind === 'agent' && actor.agentId && (await isHouseAgentId(actor.agentId))) return;
      if (await isGuestUser(actor.userId)) return;
      const rows = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM events
        WHERE event_type = 'wallet.viewed' AND avatar_id = ${avatarId}
        LIMIT 1
      `);
      if (rows[0]) return;
      const eventId = await logEventReturningId({
        eventType: 'wallet.viewed',
        userId: actor.userId,
        avatarId,
        payload: { subjectKind: actor.kind },
        fpHash: meta?.fpHash ?? null,
        ipPrefixHash: meta?.ipPrefixHash ?? null,
      });
      // null = the insert fell back to event_write_failures; retry next read.
      if (eventId === null) walletViewedSeen.delete(avatarId);
    } catch (err) {
      walletViewedSeen.delete(avatarId);
      console.warn('[wallet] wallet.viewed record failed', err);
    }
  } catch (err) {
    // Nothing above may escape to a caller (REST read or executor verb).
    console.warn('[wallet] wallet.viewed record failed', err);
  }
}
