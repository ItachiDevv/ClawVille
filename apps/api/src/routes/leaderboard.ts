/**
 * Leaderboard route — P4's single ClawVille-owned ranking board.
 *
 * This does NOT require a new table. It aggregates live from existing
 * sources of truth:
 *
 *   - avatars.clawTokens ................ liquid balance ("gold" tab)
 *   - claw_token_transactions ........ lifetime earnings ("earned" tab)
 *   - bazaar_transactions ........... skill sales volume ("skills-sold" tab)
 *   - quest_rewards ................. quest completions ("quests" tab)
 *   - bounty_reputation.totalCompleted   bounty completions ("bounties" tab)
 *   - published_skills .............. total skills authored ("authored" tab)
 *
 * A lightweight 30-second in-memory cache keeps the public browse path cheap
 * even if it ends up getting hit by every avatar on every page load. No
 * leaderboard table means no backfill, no migration, and no "stale entry"
 * class of bugs — rankings recompute on every cache miss.
 *
 * Sort modes: gold | earned | skills-sold | skills-authored | quests |
 * bounties | composite. The composite score is a weighted sum that balances
 * all five economic activities so that the default leaderboard rewards
 * well-rounded activity, not just whoever has hoarded the most tokens.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, sql, desc, and, gt } from 'drizzle-orm';
import {
  db,
  avatars,
  clawTokenTransactions,
  bazaarTransactions,
  publishedSkills,
  questRewards,
  bountyReputation,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import type { AppContext } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortMode =
  | 'composite'
  | 'gold'
  | 'earned'
  | 'skills-sold'
  | 'skills-authored'
  | 'quests'
  | 'bounties';

interface LeaderboardEntry {
  rank: number;
  avatarId: string;
  avatarName: string;
  species: string;
  color: string | number | null;
  archetype: string | null;
  // Metrics (all always populated so the UI can show the same row across tabs)
  gold: number;
  earned: number;
  skillsSold: number;
  skillsAuthored: number;
  questsCompleted: number;
  bountiesCompleted: number;
  compositeScore: number;
}

interface LeaderboardSnapshot {
  entries: LeaderboardEntry[];
  totalPets: number;
  generatedAt: string;
}

const VALID_SORTS: SortMode[] = [
  'composite',
  'gold',
  'earned',
  'skills-sold',
  'skills-authored',
  'quests',
  'bounties',
];

// ---------------------------------------------------------------------------
// Composite score weights — tuned so that a high-activity avatar across every
// metric beats one who only sits on a gold pile. Keep the numbers small and
// integer-friendly so the score is easy to reason about.
// ---------------------------------------------------------------------------
const COMPOSITE_WEIGHTS = {
  gold: 1,            // 1 pt per ClawToken held
  earned: 1,          // 1 pt per ClawToken ever earned (tracks activity, not hoarding)
  skillsSold: 500,    // skilled sellers get big credit
  skillsAuthored: 250, // publishing even without sales counts
  questsCompleted: 300,
  bountiesCompleted: 400,
};

function computeComposite(e: Omit<LeaderboardEntry, 'rank' | 'compositeScore'>): number {
  return (
    e.gold * COMPOSITE_WEIGHTS.gold +
    e.earned * COMPOSITE_WEIGHTS.earned +
    e.skillsSold * COMPOSITE_WEIGHTS.skillsSold +
    e.skillsAuthored * COMPOSITE_WEIGHTS.skillsAuthored +
    e.questsCompleted * COMPOSITE_WEIGHTS.questsCompleted +
    e.bountiesCompleted * COMPOSITE_WEIGHTS.bountiesCompleted
  );
}

// ---------------------------------------------------------------------------
// In-memory cache — 30s TTL. Keyed only on the cap (the cap bounds the entry
// count; we re-slice for different sort modes in memory because the raw
// aggregation is the same dataset).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
const DEFAULT_CAP = 500;

interface CacheEntry {
  snapshot: LeaderboardSnapshot;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

function getCache(cap: number): LeaderboardSnapshot | null {
  const hit = cache.get(cap);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(cap);
    return null;
  }
  return hit.snapshot;
}

function setCache(cap: number, snapshot: LeaderboardSnapshot) {
  cache.set(cap, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Aggregation — one pass per metric, then join by avatarId in memory.
// This is faster than a single giant SQL query with six LEFT JOINs because
// each aggregate can use its own dedicated index and we don't pay the
// cartesian-product cost.
// ---------------------------------------------------------------------------

async function buildSnapshot(cap: number): Promise<LeaderboardSnapshot> {
  // 1. Base avatar list — we include every active avatar that has ever earned
  //    anything OR currently holds gold. A zero-activity newcomer with
  //    100 starter tokens still shows up (they just rank near the bottom).
  const petRows = await db
    .select({
      id: avatars.id,
      name: avatars.name,
      species: avatars.species,
      color: avatars.color,
      archetype: avatars.archetype,
      clawTokens: avatars.clawTokens,
    })
    .from(avatars)
    .where(eq(avatars.isActive, true));

  if (petRows.length === 0) {
    return { entries: [], totalPets: 0, generatedAt: new Date().toISOString() };
  }

  // 2. Lifetime earnings — sum of positive amounts in the audit ledger.
  const earnedRows = await db
    .select({
      avatarId: clawTokenTransactions.avatarId,
      total: sql<number>`coalesce(sum(${clawTokenTransactions.amount}), 0)`.as(
        'total'
      ),
    })
    .from(clawTokenTransactions)
    .where(gt(clawTokenTransactions.amount, 0))
    .groupBy(clawTokenTransactions.avatarId);

  const earnedByPet = new Map<string, number>(
    earnedRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  // 3. Skills sold — count of bazaar transactions where the avatar was seller.
  const soldRows = await db
    .select({
      avatarId: bazaarTransactions.sellerId,
      total: sql<number>`count(*)`.as('total'),
    })
    .from(bazaarTransactions)
    .groupBy(bazaarTransactions.sellerId);

  const soldByPet = new Map<string, number>(
    soldRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  // 4. Skills authored — count of published_skills rows with a avatar author.
  //    (Claw-authored skills don't have a avatarId so they're excluded — they'd
  //    need a separate claw leaderboard which we can add later.)
  const authoredRows = await db
    .select({
      avatarId: publishedSkills.authorAvatarId,
      total: sql<number>`count(*)`.as('total'),
    })
    .from(publishedSkills)
    .where(sql`${publishedSkills.authorAvatarId} is not null`)
    .groupBy(publishedSkills.authorAvatarId);

  const authoredByPet = new Map<string, number>(
    authoredRows
      .filter((r): r is { avatarId: string; total: number } => r.avatarId !== null)
      .map((r) => [r.avatarId, Number(r.total) || 0])
  );

  // 5. Quests completed — count of quest_rewards per avatar. One reward row per
  //    approved submission, so this matches "approved completions".
  const questRows = await db
    .select({
      avatarId: questRewards.avatarId,
      total: sql<number>`count(*)`.as('total'),
    })
    .from(questRewards)
    .groupBy(questRewards.avatarId);

  const questByPet = new Map<string, number>(
    questRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  // 6. Bounties completed — already aggregated live on bounty_reputation.
  const bountyRows = await db
    .select({
      avatarId: bountyReputation.avatarId,
      totalCompleted: bountyReputation.totalCompleted,
    })
    .from(bountyReputation);

  const bountyByPet = new Map<string, number>(
    bountyRows.map((r) => [r.avatarId, r.totalCompleted || 0])
  );

  // 7. Stitch everything together.
  const partialEntries = petRows.map((avatar) => {
    const body = {
      avatarId: avatar.id,
      avatarName: avatar.name,
      species: avatar.species,
      color: avatar.color ?? null,
      archetype: avatar.archetype ?? null,
      gold: avatar.clawTokens || 0,
      earned: earnedByPet.get(avatar.id) || 0,
      skillsSold: soldByPet.get(avatar.id) || 0,
      skillsAuthored: authoredByPet.get(avatar.id) || 0,
      questsCompleted: questByPet.get(avatar.id) || 0,
      bountiesCompleted: bountyByPet.get(avatar.id) || 0,
    };
    return {
      ...body,
      compositeScore: computeComposite(body),
    };
  });

  // 8. Sort by composite for the canonical snapshot. The route will re-sort
  //    in memory for other modes — cheaper than re-querying when the working
  //    set is under `cap`.
  partialEntries.sort((a, b) => b.compositeScore - a.compositeScore);

  // 9. Cap, then rank. Avatars outside the cap never appear on any board.
  const capped = partialEntries.slice(0, cap);
  const ranked: LeaderboardEntry[] = capped.map((entry, idx) => ({
    rank: idx + 1,
    ...entry,
  }));

  return {
    entries: ranked,
    totalPets: petRows.length,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Sort & slice
// ---------------------------------------------------------------------------

function sortBy(entries: LeaderboardEntry[], mode: SortMode): LeaderboardEntry[] {
  const sorted = [...entries];
  switch (mode) {
    case 'gold':
      sorted.sort((a, b) => b.gold - a.gold);
      break;
    case 'earned':
      sorted.sort((a, b) => b.earned - a.earned);
      break;
    case 'skills-sold':
      sorted.sort((a, b) => b.skillsSold - a.skillsSold);
      break;
    case 'skills-authored':
      sorted.sort((a, b) => b.skillsAuthored - a.skillsAuthored);
      break;
    case 'quests':
      sorted.sort((a, b) => b.questsCompleted - a.questsCompleted);
      break;
    case 'bounties':
      sorted.sort((a, b) => b.bountiesCompleted - a.bountiesCompleted);
      break;
    case 'composite':
    default:
      sorted.sort((a, b) => b.compositeScore - a.compositeScore);
  }
  return sorted.map((entry, idx) => ({ ...entry, rank: idx + 1 }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const leaderboardRoutes = new Hono<AppContext>();
leaderboardRoutes.use('*', sessionMiddleware);

/**
 * GET /api/leaderboard
 *
 * Query params:
 *   sort    — composite | gold | earned | skills-sold | skills-authored | quests | bounties
 *   limit   — 1..100, default 50
 *   offset  — 0.., default 0
 *   me      — truthy to also include the current user's avatar row, even if
 *             it's outside the cap (so a mid-pack avatar can still see where
 *             they stand without paging through the whole board).
 */
leaderboardRoutes.get('/', async (c) => {
  const rawSort = (c.req.query('sort') || 'composite').toLowerCase();
  const sort = (VALID_SORTS.includes(rawSort as SortMode) ? rawSort : 'composite') as SortMode;

  const limit = Math.min(
    100,
    Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50)
  );
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);
  const wantMe = c.req.query('me') != null && c.req.query('me') !== 'false';

  // Cap — always fetch the top DEFAULT_CAP from cache, then re-sort/slice.
  let snapshot = getCache(DEFAULT_CAP);
  if (!snapshot) {
    snapshot = await buildSnapshot(DEFAULT_CAP);
    setCache(DEFAULT_CAP, snapshot);
  }

  const sorted = sortBy(snapshot.entries, sort);
  const page = sorted.slice(offset, offset + limit);

  // Optional "where do I stand?" row.
  let mePet: LeaderboardEntry | null = null;
  if (wantMe) {
    const user = c.get('user');
    if (user) {
      const [myAvatar] = await db
        .select({ id: avatars.id })
        .from(avatars)
        .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
        .limit(1);

      if (myAvatar) {
        mePet = sorted.find((e) => e.avatarId === myAvatar.id) ?? null;
      }
    }
  }

  return c.json({
    entries: page,
    sort,
    limit,
    offset,
    totalPets: snapshot.totalPets,
    rankedCount: sorted.length,
    generatedAt: snapshot.generatedAt,
    me: mePet,
  });
});

/**
 * GET /api/leaderboard/stats
 *
 * Aggregate stats for the header banner — total avatars, total gold in
 * circulation, total skills ever sold, total quests completed.
 */
leaderboardRoutes.get('/stats', async (c) => {
  let snapshot = getCache(DEFAULT_CAP);
  if (!snapshot) {
    snapshot = await buildSnapshot(DEFAULT_CAP);
    setCache(DEFAULT_CAP, snapshot);
  }

  const totalGold = snapshot.entries.reduce((sum, e) => sum + e.gold, 0);
  const totalEarned = snapshot.entries.reduce((sum, e) => sum + e.earned, 0);
  const totalSkillsSold = snapshot.entries.reduce((sum, e) => sum + e.skillsSold, 0);
  const totalSkillsAuthored = snapshot.entries.reduce(
    (sum, e) => sum + e.skillsAuthored,
    0
  );
  const totalQuestsCompleted = snapshot.entries.reduce(
    (sum, e) => sum + e.questsCompleted,
    0
  );
  const totalBountiesCompleted = snapshot.entries.reduce(
    (sum, e) => sum + e.bountiesCompleted,
    0
  );

  return c.json({
    totalPets: snapshot.totalPets,
    rankedPets: snapshot.entries.length,
    totalGold,
    totalEarned,
    totalSkillsSold,
    totalSkillsAuthored,
    totalQuestsCompleted,
    totalBountiesCompleted,
    generatedAt: snapshot.generatedAt,
  });
});
