import { relations } from 'drizzle-orm';

export * from './users';
export * from './avatars';
export * from './locations';
export * from './location-agents';
export * from './agents';
export * from './inventory';
export * from './claws';

import { users, sessions } from './users';
import { avatars } from './avatars';
import { agents, agentLogs } from './agents';
import { locationAgents } from './location-agents';
import { avatarInventory } from './inventory';
import { openclawBots } from './claws';

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  avatar: one(avatars, {
    fields: [users.id],
    references: [avatars.userId],
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

export const petsRelations = relations(avatars, ({ one, many }) => ({
  user: one(users, {
    fields: [avatars.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [avatars.platformAgentId],
    references: [agents.id],
  }),
  inventory: many(avatarInventory),
}));

export const petInventoryRelations = relations(avatarInventory, ({ one }) => ({
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

export const openclawBotsRelations = relations(openclawBots, ({ one }) => ({
  user: one(users, {
    fields: [openclawBots.userId],
    references: [users.id],
  }),
}));
