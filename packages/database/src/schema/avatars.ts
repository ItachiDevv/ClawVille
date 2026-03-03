import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  integer,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { platformAgents } from './agents';

export const petSpeciesEnum = pgEnum('avatar_species', [
  'cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle',
]);

export const petColorEnum = pgEnum('avatar_color', [
  'green', 'red', 'blue', 'yellow',
]);

export const petGenderEnum = pgEnum('avatar_gender', ['male', 'female']);

export interface PetPersonalityJson {
  habitat: string;
  hobby: string;
  greeting: string;
}

export interface PetStatsJson {
  strength: number;
  defence: number;
  movement: number;
}

/** ElizaOS-compatible character config for avatar agents */
export interface PetCharacterConfigJson {
  bio: string[];
  greeting: string;
  tone: string;
  topics: string[];
  adjectives: string[];
  rules: string[];
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  messageExamples: Array<{ user: string; content: string }[]>;
  lore: string[];
  knowledge: string[];
  system?: string;
}

export const avatars = pgTable('avatars', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull().unique(),
  species: petSpeciesEnum('species').notNull(),
  color: petColorEnum('color').notNull(),
  gender: petGenderEnum('gender').notNull(),
  /** Selected archetype ID (e.g. 'brave-adventurer') */
  archetype: varchar('archetype', { length: 50 }).notNull(),
  personality: jsonb('personality').$type<PetPersonalityJson>().notNull(),
  stats: jsonb('stats').$type<PetStatsJson>().notNull(),
  /** ElizaOS character config - full archetype data for the avatar's AI personality */
  characterConfig: jsonb('character_config').$type<PetCharacterConfigJson>(),
  /** Link to platform_agents table for ElizaOS runtime */
  platformAgentId: uuid('platform_agent_id')
    .references(() => platformAgents.id, { onDelete: 'set null' }),
  clawTokens: integer('neo_tokens').default(100).notNull(),
  positionX: integer('position_x').default(400).notNull(),
  positionY: integer('position_y').default(250).notNull(),
  lastActiveAt: timestamp('last_active_at'),
  loginStreak: integer('login_streak').default(0).notNull(),
  lastLoginDate: varchar('last_login_date', { length: 10 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
