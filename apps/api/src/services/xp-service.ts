import { eq, sql } from 'drizzle-orm';
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
  return db.transaction(async (tx) => {
    const [avatar] = await tx.execute<{
      id: string;
      xp: number;
      level: number;
      total_xp: number;
    }>(
      sql`SELECT id, xp, level, total_xp
          FROM avatars
          WHERE id = ${avatarId}
          FOR UPDATE`,
    );

    if (!avatar) {
      throw new Error(`Avatar not found: ${avatarId}`);
    }

    let currentXp = Number(avatar.xp ?? 0) + amount;
    let currentLevel = Number(avatar.level ?? 1);
    const startLevel = currentLevel;
    let tokensAwarded = 0;

    // Check for level-ups from the row-locked state.
    while (currentXp >= XP_PER_LEVEL(currentLevel)) {
      currentXp -= XP_PER_LEVEL(currentLevel);
      currentLevel += 1;
      tokensAwarded += TOKENS_PER_LEVEL_UP;
    }

    const levelsGained = currentLevel - startLevel;
    const newTotalXp = Number(avatar.total_xp ?? 0) + amount;

    // XP metadata and any level-up mint commit or roll back together.
    // Migration 0032's rolling-deploy guard rejects the pre-fix XP writer. The
    // transaction-local marker authorizes only this atomic lock+update+mint path
    // and automatically disappears at transaction end (including rollback).
    await tx.execute(
      sql`SELECT set_config('clawville.xp_write_authorized', '1', true)`,
    );
    await tx
      .update(avatars)
      .set({
        xp: currentXp,
        level: currentLevel,
        totalXp: newTotalXp,
        updatedAt: new Date(),
      })
      .where(eq(avatars.id, avatarId));

    if (tokensAwarded > 0) {
      await creditClawTokens(
        {
          avatarId,
          amount: tokensAwarded,
          reason: 'level_up',
          source: 'system',
          metadata: { levelsGained, newLevel: currentLevel, xpSource: _source },
          actorKind: 'system',
        },
        tx,
      );
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
  });
}
