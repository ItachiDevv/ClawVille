import { relations } from 'drizzle-orm';

export * from './users';
export * from './avatars';
export * from './locations';
export * from './location-agents';
export * from './agents';

import { users, sessions } from './users';
import { avatars } from './avatars';
import { agents, agentLogs } from './agents';
import { locationAgents } from './location-agents';

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

export const petsRelations = relations(avatars, ({ one }) => ({
  user: one(users, {
    fields: [avatars.userId],
    references: [users.id],
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
