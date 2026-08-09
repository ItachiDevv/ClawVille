import { and, eq } from 'drizzle-orm';
import {
  agentBots,
  avatars,
  db,
  users,
} from '@clawville/database';

export interface ResolvedAutonomousCoveAgent {
  userId: string | null;
  avatarId: string | null;
  agentId: string;
  ledgerCapable: boolean;
}

export type ConnectedAutonomousCoveAgentResolver = (
  sessionId: string,
) => Promise<ResolvedAutonomousCoveAgent | null>;

/**
 * Resolve the live settlement binding for one autonomous Cove action.
 *
 * House agents deliberately have no spend-capable bearer session. Their
 * server-owned `openclaw_bots.is_house` row is therefore the authority for
 * this one internal settlement path. Every other agent falls through to the
 * existing connected-session resolver unchanged.
 */
export async function resolveAutonomousCoveAgentBinding(
  input: {
    sessionId: string;
    expectedAgentId: string;
  },
  resolveConnectedAgent: ConnectedAutonomousCoveAgentResolver,
): Promise<ResolvedAutonomousCoveAgent | null> {
  const rows = await db
    .select({
      userId: agentBots.userId,
      ownerId: users.id,
      ownerIsGuest: users.isGuest,
      avatarId: avatars.id,
    })
    .from(agentBots)
    .leftJoin(users, eq(users.id, agentBots.userId))
    .leftJoin(
      avatars,
      eq(avatars.userId, agentBots.userId),
    )
    .where(and(
      eq(agentBots.agentId, input.expectedAgentId),
      eq(agentBots.isHouse, true),
    ))
    .limit(1);

  const house = rows[0];
  if (!house) {
    return resolveConnectedAgent(input.sessionId);
  }

  const userId = house.userId ?? null;
  const ownerExists = Boolean(house.ownerId);
  return {
    userId,
    avatarId: house.avatarId ?? null,
    agentId: input.expectedAgentId,
    // Guests never become real-ledger subjects through a house flag. Missing
    // owners likewise fail closed. House ledger avatars are intentionally
    // inactive (their `ocb-*` body is the sole world presence), so exact
    // ownership—not roster activity—is the binding invariant for this path.
    ledgerCapable: Boolean(userId && ownerExists && house.ownerIsGuest === false),
  };
}

/**
 * True when `agentId` is a SERVER-OWNED house bot.
 *
 * The house carve-out above exists because the cove's house is a WAGER
 * COUNTERPARTY: it must be able to settle without a bearer session, and every
 * money transaction on that path re-validates the exact binding. That reasoning
 * does NOT transfer to a faucet. A tutorial quest has no counterparty — it
 * credits from nothing — so letting the house fleet claim the ladder would mint
 * the whole corpus into server-owned balances and leak it into the player
 * economy as cove bankroll.
 *
 * Faucet paths call this and REFUSE on true. Keep it a separate, explicit
 * question rather than a flag on the resolved binding, so a future caller has
 * to answer "is this a counterparty settlement or a faucet?" deliberately.
 */
export async function isHouseAgentId(agentId: string): Promise<boolean> {
  const rows = await db
    .select({ agentId: agentBots.agentId })
    .from(agentBots)
    .where(and(eq(agentBots.agentId, agentId), eq(agentBots.isHouse, true)))
    .limit(1);
  return rows.length > 0;
}
