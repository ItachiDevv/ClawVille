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
