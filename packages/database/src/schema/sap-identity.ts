/**
 * Durable SAP identity-registration + Metaplex attachment state.
 *
 * One row belongs to one avatar and follows the avatar's own custodial Solana
 * wallet from a queued, self-funded registration through the terminal
 * `identity_attached` state. `agent_pda` is deterministic from that wallet, so
 * it is persisted before the first chain write and remains the public lookup key.
 *
 * This table records identity writes only. It does not authorize, settle, or
 * withdraw escrow funds; the SAP escrow ledgers remain separate and unchanged.
 */

import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';

export const SAP_AGENT_IDENTITY_CLUSTERS = ['devnet', 'mainnet'] as const;
export type SapAgentIdentityCluster = (typeof SAP_AGENT_IDENTITY_CLUSTERS)[number];

export const SAP_AGENT_IDENTITY_STATUSES = [
  'pending_funding',
  'registering',
  'registered',
  'attaching_identity',
  'identity_attached',
  'failed',
] as const;
export type SapAgentIdentityStatus = (typeof SAP_AGENT_IDENTITY_STATUSES)[number];

export interface SapAgentIdentityCapability {
  id: string;
  description?: string | null;
  protocolId?: string | null;
  version?: string | null;
}

export const sapAgentIdentities = pgTable(
  'sap_agent_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** Custodial owner wallet public key (base58); never a secret. */
    wallet: text('wallet').notNull(),
    /** Deterministic SAP AgentAccount PDA (base58), known before registration. */
    agentPda: text('agent_pda').notNull(),
    cluster: text('cluster').$type<SapAgentIdentityCluster>().notNull(),
    status: text('status')
      .$type<SapAgentIdentityStatus>()
      .notNull()
      .default('pending_funding'),
    registerTxSig: text('register_tx_sig'),
    /** Both strings are non-empty because deployed register_agent rejects an empty description. */
    name: text('name').notNull(),
    description: text('description').notNull(),
    capabilities: jsonb('capabilities')
      .$type<SapAgentIdentityCapability[]>()
      .notNull()
      .default([]),
    metaplexAsset: text('metaplex_asset'),
    identityRegistration: text('identity_registration'),
    metaplexTxSig: text('metaplex_tx_sig'),
    triggerSource: text('trigger_source').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    avatarUnique: uniqueIndex('sap_agent_identities_avatar_id_unique').on(t.avatarId),
    agentPdaUnique: uniqueIndex('sap_agent_identities_agent_pda_unique').on(t.agentPda),
    statusUpdatedIdx: index('sap_agent_identities_status_updated_idx').on(t.status, t.updatedAt),
    clusterValid: check(
      'sap_agent_identities_cluster_valid',
      sql`${t.cluster} IN ('devnet', 'mainnet')`,
    ),
    statusValid: check(
      'sap_agent_identities_status_valid',
      sql`${t.status} IN ('pending_funding', 'registering', 'registered', 'attaching_identity', 'identity_attached', 'failed')`,
    ),
    nameNonempty: check('sap_agent_identities_name_nonempty', sql`length(btrim(${t.name})) > 0`),
    descriptionNonempty: check(
      'sap_agent_identities_description_nonempty',
      sql`length(btrim(${t.description})) > 0`,
    ),
    attemptsNonnegative: check('sap_agent_identities_attempts_nonnegative', sql`${t.attempts} >= 0`),
  }),
);

export type SapAgentIdentity = typeof sapAgentIdentities.$inferSelect;
export type NewSapAgentIdentity = typeof sapAgentIdentities.$inferInsert;
