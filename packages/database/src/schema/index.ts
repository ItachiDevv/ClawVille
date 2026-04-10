import { relations } from 'drizzle-orm';

export * from './users';
export * from './pets';
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

import { users, sessions } from './users';
import { npcMemories, activityLog } from './memories';
import { pets } from './pets';
import { agents, agentLogs } from './agents';
import { locationAgents } from './location-agents';
import { petInventory } from './inventory';
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
  pets: many(pets),
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

export const petsRelations = relations(pets, ({ one, many }) => ({
  user: one(users, {
    fields: [pets.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [pets.platformAgentId],
    references: [agents.id],
  }),
  inventory: many(petInventory),
  publishedSkills: many(publishedSkills),
  agentConfigs: many(agentConfigs),
}));

export const petInventoryRelations = relations(petInventory, ({ one }) => ({
  pet: one(pets, {
    fields: [petInventory.petId],
    references: [pets.id],
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
  pet: one(pets, {
    fields: [activityLog.petId],
    references: [pets.id],
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
  authorPet: one(pets, {
    fields: [publishedSkills.authorPetId],
    references: [pets.id],
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
  pet: one(pets, {
    fields: [skillUpvotes.petId],
    references: [pets.id],
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
  pet: one(pets, {
    fields: [tokenLaunches.petId],
    references: [pets.id],
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
  seller: one(pets, {
    fields: [bazaarListings.sellerId],
    references: [pets.id],
  }),
}));

export const bazaarTransactionsRelations = relations(bazaarTransactions, ({ one }) => ({
  listing: one(bazaarListings, {
    fields: [bazaarTransactions.listingId],
    references: [bazaarListings.id],
  }),
  buyer: one(pets, {
    fields: [bazaarTransactions.buyerId],
    references: [pets.id],
    relationName: 'transactionBuyer',
  }),
  seller: one(pets, {
    fields: [bazaarTransactions.sellerId],
    references: [pets.id],
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
  reviewer: one(pets, {
    fields: [bazaarReviews.reviewerId],
    references: [pets.id],
  }),
  skill: one(publishedSkills, {
    fields: [bazaarReviews.skillId],
    references: [publishedSkills.id],
  }),
}));

export const auctionsRelations = relations(auctions, ({ one, many }) => ({
  seller: one(pets, {
    fields: [auctions.sellerId],
    references: [pets.id],
    relationName: 'auctionSeller',
  }),
  currentBidder: one(pets, {
    fields: [auctions.currentBidderId],
    references: [pets.id],
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
  bidder: one(pets, {
    fields: [auctionBids.bidderId],
    references: [pets.id],
  }),
}));

export const auctionAgentConfigsRelations = relations(auctionAgentConfigs, ({ one }) => ({
  auction: one(auctions, {
    fields: [auctionAgentConfigs.auctionId],
    references: [auctions.id],
  }),
  pet: one(pets, {
    fields: [auctionAgentConfigs.petId],
    references: [pets.id],
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
  pet: one(pets, {
    fields: [questSubmissions.petId],
    references: [pets.id],
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
  pet: one(pets, {
    fields: [questRewards.petId],
    references: [pets.id],
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
  pet: one(pets, { fields: [agentConfigs.petId], references: [pets.id] }),
}));

export const bountiesRelations = relations(bounties, ({ one, many }) => ({
  creator: one(pets, { fields: [bounties.creatorId], references: [pets.id] }),
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
  hunter: one(pets, { fields: [bountyAttempts.hunterId], references: [pets.id] }),
}));

export const bountyReputationRelations = relations(bountyReputation, ({ one }) => ({
  pet: one(pets, { fields: [bountyReputation.petId], references: [pets.id] }),
}));

export const clawTokenTransactionsRelations = relations(clawTokenTransactions, ({ one }) => ({
  pet: one(pets, { fields: [clawTokenTransactions.petId], references: [pets.id] }),
}));
