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
export * from './token-launch';

import { users, sessions } from './users';
import { npcMemories, activityLog } from './memories';
import { pets } from './pets';
import { agents, agentLogs } from './agents';
import { locationAgents } from './location-agents';
import { petInventory } from './inventory';
import { publishedSkills, skillUpvotes } from './marketplace';
import { openclawBots } from './claws';
import { vanityKeypairs, tokenLaunches } from './token-launch';

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  pet: one(pets, {
    fields: [users.id],
    references: [pets.userId],
  }),
  agents: many(agents),
  locationAgents: many(locationAgents),
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
