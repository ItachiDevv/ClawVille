import { relations } from 'drizzle-orm';

export * from './users';
export * from './avatars';
export * from './locations';
export * from './location-agents';
export * from './agents';
export * from './inventory';
export * from './claws';
export * from './memories';
export * from './research';
export * from './marketplace';
export * from './bazaar';
export * from './token-launch';
export * from './treasury';
export * from './auctions';
export * from './quests';
export * from './agent-configs';
export * from './bounties';
export * from './building-skills';
export * from './wallets';
export * from './agent-session-tickets';
// Email-driven auth (password reset + soft email verification). One row per
// issued token; raw token never stored — only sha256(token).
export * from './auth-tokens';
export * from './events';
export * from './event-write-failures';
export * from './pending-account-links';
// Q2 Activity Portals — schemas ship ahead of backend routes. Migration
// (db:push) is a founder-review step; files compile today so downstream
// packages can type-check against them.
export * from './activities';
export * from './activity-rooms';
export * from './activity-room-participants';
export * from './activity-results';
export * from './activity-queue-entries';
export * from './activity-parties';
export * from './activity-replays';
export * from './activity-seasons';
// Reef Race Phase 4 — per-avatar personal-best lap + ghost replay.
export * from './reef-race-personal-bests';
// Q3 plan §2.6 — idempotency for client-side tutorial quest token credits.
export * from './tutorial-quest-claims';
// Q3 plan §4 — cosmetic engine (cosmetic_skus + cosmetic_variants + avatar_skins).
export * from './cosmetics';
// Q3 plan §gamification dashboard — phase status (mutable via dashboard MCP).
export * from './dashboard-phases';
// 2026-05-18 — peer marketplace replacing gated bazaar/auction. Needs +
// one_shot/repeatable offers. Subscriptions deferred.
export * from './exchange';
// Wager lobbies + escrow — mirrors deployed `clawville_wager` Anchor program.
// On-chain is authoritative for money; these tables back FE discovery / FE
// polling / event timelines / leaderboard hooks. See `wager.ts` header.
export * from './wager';
// Phase 6.1 slice 3 — cove slot sessions + spin audit trail. ClawTokens
// fun-money tier today; SOL/USDC route paths return 501 until 6.2 custody.
export * from './cove';
// Phase 6.7.0 — unified cross-game history table for Cove casino. Parallel
// write to per-game tables (slot_spins etc.); one row per atomic gameplay
// unit. Verifier replay surface for slots / blackjack / Hold'em / baccarat.
export * from './cove-events';
// Phase 6.4.1 — cove blackjack shoes + hands. Two-table commit-reveal
// pattern mirroring cove (slot_sessions/slot_spins). One shoe = one
// commit-reveal seed pair (75% penetration reshuffle = new shoe row);
// one hand = one cove_game_events row. ClawTokens tier today; currency
// seam reserved for the SOL/USDC tier.
export * from './blackjack';
// Phase 6.5.1 — cove No-Limit Texas Hold'em tables + hands. Two-table
// commit-reveal pattern mirroring blackjack. Each hand shuffles a FRESH
// 52-card deck from the HMAC stream (nonce=handIndex), so there is no shared
// shoe / cursor drift. One hand = one cove_game_events row (gameType='holdem').
// ClawTokens tier today; currency seam reserved for the SOL/USDC tier.
export * from './holdem';

import { users, sessions } from './users';
import { npcMemories, activityLog } from './memories';
import { avatars } from './avatars';
import { agents, agentLogs } from './agents';
import { locationAgents } from './location-agents';
import { avatarInventory } from './inventory';
import { publishedSkills, skillUpvotes } from './marketplace';
import { bazaarListings, bazaarTransactions, bazaarReviews } from './bazaar';
import { openclawBots } from './claws';
import { vanityKeypairs, tokenLaunches } from './token-launch';
import { clawTokenTransactions } from './treasury';
import { auctions, auctionBids, auctionAgentConfigs } from './auctions';
import { quests, questSubmissions, questRewards } from './quests';
import { agentConfigs } from './agent-configs';
import { bounties, bountyRewards, bountyAttempts, bountyReputation } from './bounties';

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  avatars: many(avatars),
  agents: many(agents),
  locationAgents: many(locationAgents),
  agentConfigs: many(agentConfigs),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const avatarsRelations = relations(avatars, ({ one, many }) => ({
  user: one(users, {
    fields: [avatars.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [avatars.platformAgentId],
    references: [agents.id],
  }),
  inventory: many(avatarInventory),
  publishedSkills: many(publishedSkills),
  agentConfigs: many(agentConfigs),
}));

export const avatarInventoryRelations = relations(avatarInventory, ({ one }) => ({
  avatar: one(avatars, {
    fields: [avatarInventory.avatarId],
    references: [avatars.id],
  }),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  user: one(users, {
    fields: [agents.userId],
    references: [users.id],
  }),
  logs: many(agentLogs),
}));

export const agentLogsRelations = relations(agentLogs, ({ one }) => ({
  agent: one(agents, {
    fields: [agentLogs.agentId],
    references: [agents.id],
  }),
}));

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  avatar: one(avatars, {
    fields: [activityLog.avatarId],
    references: [avatars.id],
  }),
}));

export const locationAgentsRelations = relations(locationAgents, ({ one }) => ({
  user: one(users, {
    fields: [locationAgents.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [locationAgents.platformAgentId],
    references: [agents.id],
  }),
}));

export const publishedSkillsRelations = relations(publishedSkills, ({ one, many }) => ({
  authorAvatar: one(avatars, {
    fields: [publishedSkills.authorAvatarId],
    references: [avatars.id],
  }),
  upvotes: many(skillUpvotes),
  listings: many(bazaarListings),
  reviews: many(bazaarReviews),
}));

export const skillUpvotesRelations = relations(skillUpvotes, ({ one }) => ({
  skill: one(publishedSkills, {
    fields: [skillUpvotes.skillId],
    references: [publishedSkills.id],
  }),
  avatar: one(avatars, {
    fields: [skillUpvotes.avatarId],
    references: [avatars.id],
  }),
}));

export const openclawBotsRelations = relations(openclawBots, ({ one }) => ({
  user: one(users, {
    fields: [openclawBots.userId],
    references: [users.id],
  }),
}));

export const vanityKeypairsRelations = relations(vanityKeypairs, ({ one }) => ({
  reservedByUser: one(users, {
    fields: [vanityKeypairs.reservedBy],
    references: [users.id],
  }),
}));

export const tokenLaunchesRelations = relations(tokenLaunches, ({ one }) => ({
  user: one(users, {
    fields: [tokenLaunches.userId],
    references: [users.id],
  }),
  avatar: one(avatars, {
    fields: [tokenLaunches.avatarId],
    references: [avatars.id],
  }),
  vanityKeypair: one(vanityKeypairs, {
    fields: [tokenLaunches.vanityKeypairId],
    references: [vanityKeypairs.id],
  }),
}));

export const bazaarListingsRelations = relations(bazaarListings, ({ one }) => ({
  skill: one(publishedSkills, {
    fields: [bazaarListings.skillId],
    references: [publishedSkills.id],
  }),
  seller: one(avatars, {
    fields: [bazaarListings.sellerId],
    references: [avatars.id],
  }),
}));

export const bazaarTransactionsRelations = relations(bazaarTransactions, ({ one }) => ({
  listing: one(bazaarListings, {
    fields: [bazaarTransactions.listingId],
    references: [bazaarListings.id],
  }),
  buyer: one(avatars, {
    fields: [bazaarTransactions.buyerId],
    references: [avatars.id],
    relationName: 'transactionBuyer',
  }),
  seller: one(avatars, {
    fields: [bazaarTransactions.sellerId],
    references: [avatars.id],
    relationName: 'transactionSeller',
  }),
  skill: one(publishedSkills, {
    fields: [bazaarTransactions.skillId],
    references: [publishedSkills.id],
  }),
}));

export const bazaarReviewsRelations = relations(bazaarReviews, ({ one }) => ({
  transaction: one(bazaarTransactions, {
    fields: [bazaarReviews.transactionId],
    references: [bazaarTransactions.id],
  }),
  reviewer: one(avatars, {
    fields: [bazaarReviews.reviewerId],
    references: [avatars.id],
  }),
  skill: one(publishedSkills, {
    fields: [bazaarReviews.skillId],
    references: [publishedSkills.id],
  }),
}));

export const auctionsRelations = relations(auctions, ({ one, many }) => ({
  seller: one(avatars, {
    fields: [auctions.sellerId],
    references: [avatars.id],
    relationName: 'auctionSeller',
  }),
  currentBidder: one(avatars, {
    fields: [auctions.currentBidderId],
    references: [avatars.id],
    relationName: 'auctionCurrentBidder',
  }),
  skill: one(publishedSkills, {
    fields: [auctions.skillId],
    references: [publishedSkills.id],
  }),
  bids: many(auctionBids),
  agentConfigs: many(auctionAgentConfigs),
}));

export const auctionBidsRelations = relations(auctionBids, ({ one }) => ({
  auction: one(auctions, {
    fields: [auctionBids.auctionId],
    references: [auctions.id],
  }),
  bidder: one(avatars, {
    fields: [auctionBids.bidderId],
    references: [avatars.id],
  }),
}));

export const auctionAgentConfigsRelations = relations(auctionAgentConfigs, ({ one }) => ({
  auction: one(auctions, {
    fields: [auctionAgentConfigs.auctionId],
    references: [auctions.id],
  }),
  avatar: one(avatars, {
    fields: [auctionAgentConfigs.avatarId],
    references: [avatars.id],
  }),
}));

export const questsRelations = relations(quests, ({ one, many }) => ({
  skillReward: one(publishedSkills, {
    fields: [quests.skillRewardId],
    references: [publishedSkills.id],
  }),
  createdByUser: one(users, {
    fields: [quests.createdBy],
    references: [users.id],
  }),
  submissions: many(questSubmissions),
  rewards: many(questRewards),
}));

export const questSubmissionsRelations = relations(questSubmissions, ({ one }) => ({
  quest: one(quests, {
    fields: [questSubmissions.questId],
    references: [quests.id],
  }),
  avatar: one(avatars, {
    fields: [questSubmissions.avatarId],
    references: [avatars.id],
  }),
  reviewedByUser: one(users, {
    fields: [questSubmissions.reviewedBy],
    references: [users.id],
  }),
}));

export const questRewardsRelations = relations(questRewards, ({ one }) => ({
  submission: one(questSubmissions, {
    fields: [questRewards.submissionId],
    references: [questSubmissions.id],
  }),
  avatar: one(avatars, {
    fields: [questRewards.avatarId],
    references: [avatars.id],
  }),
  quest: one(quests, {
    fields: [questRewards.questId],
    references: [quests.id],
  }),
  skill: one(publishedSkills, {
    fields: [questRewards.skillId],
    references: [publishedSkills.id],
  }),
}));

export const agentConfigsRelations = relations(agentConfigs, ({ one }) => ({
  user: one(users, { fields: [agentConfigs.userId], references: [users.id] }),
  avatar: one(avatars, { fields: [agentConfigs.avatarId], references: [avatars.id] }),
}));

export const bountiesRelations = relations(bounties, ({ one, many }) => ({
  creator: one(avatars, { fields: [bounties.creatorId], references: [avatars.id] }),
  rewards: many(bountyRewards),
  attempts: many(bountyAttempts),
}));

export const bountyRewardsRelations = relations(bountyRewards, ({ one }) => ({
  bounty: one(bounties, { fields: [bountyRewards.bountyId], references: [bounties.id] }),
  skill: one(publishedSkills, { fields: [bountyRewards.skillId], references: [publishedSkills.id] }),
  agentConfig: one(agentConfigs, { fields: [bountyRewards.agentConfigId], references: [agentConfigs.id] }),
}));

export const bountyAttemptsRelations = relations(bountyAttempts, ({ one }) => ({
  bounty: one(bounties, { fields: [bountyAttempts.bountyId], references: [bounties.id] }),
  hunter: one(avatars, { fields: [bountyAttempts.hunterId], references: [avatars.id] }),
}));

export const bountyReputationRelations = relations(bountyReputation, ({ one }) => ({
  avatar: one(avatars, { fields: [bountyReputation.avatarId], references: [avatars.id] }),
}));

export const clawTokenTransactionsRelations = relations(clawTokenTransactions, ({ one }) => ({
  avatar: one(avatars, { fields: [clawTokenTransactions.avatarId], references: [avatars.id] }),
}));
