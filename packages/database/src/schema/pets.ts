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

export const petSpeciesEnum = pgEnum('pet_species', [
  'cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle',
]);

export const petColorEnum = pgEnum('pet_color', [
  'green', 'red', 'blue', 'yellow',
]);

export const petGenderEnum = pgEnum('pet_gender', ['male', 'female']);

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

/** ElizaOS-compatible character config for pet agents */
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

export const pets = pgTable('pets', {
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
  /** ElizaOS character config - full archetype data for the pet's AI personality */
  characterConfig: jsonb('character_config').$type<PetCharacterConfigJson>(),
  /** Link to platform_agents table for ElizaOS runtime */
  platformAgentId: uuid('platform_agent_id')
    .references(() => platformAgents.id, { onDelete: 'set null' }),
  positionX: integer('position_x').default(400).notNull(),
  positionY: integer('position_y').default(250).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
