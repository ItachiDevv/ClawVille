import { eq } from 'drizzle-orm';
import { db, pets } from '@clawville/database';

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
 * Award XP to a pet. Handles level-ups and token rewards automatically.
 * This is safe to call fire-and-forget (non-blocking).
 */
export async function awardXp(
  petId: string,
  amount: number,
  _source: string,
): Promise<XpAwardResult> {
  // Fetch current pet state
  const pet = await db.query.pets.findFirst({
    where: eq(pets.id, petId),
    columns: { id: true, xp: true, level: true, totalXp: true, clawTokens: true },
  });

  if (!pet) {
    throw new Error(`Pet not found: ${petId}`);
  }

  let currentXp = (pet.xp ?? 0) + amount;
  let currentLevel = pet.level ?? 1;
  const startLevel = currentLevel;
  let tokensAwarded = 0;

  // Check for level-ups
  while (currentXp >= XP_PER_LEVEL(currentLevel)) {
    currentXp -= XP_PER_LEVEL(currentLevel);
    currentLevel += 1;
    tokensAwarded += TOKENS_PER_LEVEL_UP;
  }

  const levelsGained = currentLevel - startLevel;
  const newTotalXp = (pet.totalXp ?? 0) + amount;
  const newTokens = (pet.clawTokens ?? 100) + tokensAwarded;

  // Update DB in one query
  await db
    .update(pets)
    .set({
      xp: currentXp,
      level: currentLevel,
      totalXp: newTotalXp,
      clawTokens: newTokens,
      updatedAt: new Date(),
    })
    .where(eq(pets.id, petId));

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
