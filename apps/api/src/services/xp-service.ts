import { eq } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { creditClawTokens } from './claw-token-ledger';

/** XP required to level up from a given level */
export const XP_PER_LEVEL = (level: number): number => level * 100;

/** ClawTokens awarded per level-up */
const TOKENS_PER_LEVEL_UP = 50;

export interface XpAwardResult {
  xpAwarded: number;
  newXp: number;
  newLevel: number;
  newTotalXp: number;
  leveledUp: boolean;
  levelsGained: number;
  tokensAwarded: number;
}

/**
 * Award XP to an avatar. Handles level-ups and token rewards automatically.
 * This is safe to call fire-and-forget (non-blocking).
 */
export async function awardXp(
  avatarId: string,
  amount: number,
  _source: string,
): Promise<XpAwardResult> {
  // Fetch current avatar state
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, avatarId),
    columns: { id: true, xp: true, level: true, totalXp: true, clawTokens: true },
  });

  if (!avatar) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  let currentXp = (avatar.xp ?? 0) + amount;
  let currentLevel = avatar.level ?? 1;
  const startLevel = currentLevel;
  let tokensAwarded = 0;

  // Check for level-ups
  while (currentXp >= XP_PER_LEVEL(currentLevel)) {
    currentXp -= XP_PER_LEVEL(currentLevel);
    currentLevel += 1;
    tokensAwarded += TOKENS_PER_LEVEL_UP;
  }

  const levelsGained = currentLevel - startLevel;
  const newTotalXp = (avatar.totalXp ?? 0) + amount;

  // Update XP metadata (NOT the token balance — that goes through the ledger)
  await db
    .update(avatars)
    .set({
      xp: currentXp,
      level: currentLevel,
      totalXp: newTotalXp,
      updatedAt: new Date(),
    })
    .where(eq(avatars.id, avatarId));

  // Credit level-up tokens via ledger (atomic + audited)
  if (tokensAwarded > 0) {
    await creditClawTokens({
      avatarId,
      amount: tokensAwarded,
      reason: 'level_up',
      source: 'system',
      metadata: { levelsGained, newLevel: currentLevel, xpSource: _source },
      actorKind: 'system',
    });
  }

  return {
    xpAwarded: amount,
    newXp: currentXp,
    newLevel: currentLevel,
    newTotalXp,
    leveledUp: levelsGained > 0,
    levelsGained,
    tokensAwarded,
  };
}
