import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, integer, bigint, text, jsonb, timestamp, boolean, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { avatars } from './avatars';
import { users } from './users';
export const brainchainBuyerPayers = pgTable('brainchain_buyer_payers', {
  id: uuid('id').primaryKey().defaultRandom(), avatarId: uuid('avatar_id').notNull().references(() => avatars.id), chainId: integer('chain_id'), network: varchar('network',{length:64}).notNull().default('eip155:84532'), address: varchar('address',{length:44}).notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
}, t => ({ payer: uniqueIndex('brainchain_buyer_payer_once').on(t.chainId,t.address), networkPayer: uniqueIndex('brainchain_buyer_payer_network_once').on(t.network,t.address), networkCheck:check('brainchain_buyer_payer_network',sql`(${t.network}='eip155:84532' AND ${t.chainId} IS NOT NULL AND ${t.chainId}=84532 AND ${t.address} ~ '^0x[0-9a-f]{40}$') OR (${t.network}='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' AND ${t.chainId} IS NULL AND ${t.address} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')`) }));
export const brainchainBuyerOrders = pgTable('brainchain_buyer_orders', {
  id: uuid('id').primaryKey(), avatarId: uuid('avatar_id').notNull().references(() => avatars.id), userId: uuid('user_id').notNull().references(()=>users.id), actor: varchar('actor',{length:8}).notNull(),
  idempotencyKey: varchar('idempotency_key',{length:64}).notNull(), body: jsonb('body').notNull(), bodyHash: varchar('body_hash',{length:64}).notNull(),
  state: varchar('state',{length:24}).notNull().default('draft'), quote: jsonb('quote'), quoteExpiresAt: timestamp('quote_expires_at',{withTimezone:true}),
  network: varchar('network',{length:64}).notNull().default('eip155:84532'), solanaArtifact: jsonb('solana_artifact'), solanaDiscovery: jsonb('solana_discovery'),
  payer: varchar('payer',{length:44}), terms: jsonb('terms'), paymentNonce: varchar('payment_nonce',{length:66}), validBefore: timestamp('valid_before',{withTimezone:true}),
  reservedAt: timestamp('reserved_at',{withTimezone:true}), requiresHumanApproval: boolean('requires_human_approval').notNull().default(true),
  humanApprovalWallet: varchar('human_approval_wallet',{length:44}), humanApprovalWalletVersion: bigint('human_approval_wallet_version',{mode:'number'}),
  humanNonce: varchar('human_nonce',{length:64}), humanApprovedAt: timestamp('human_approved_at',{withTimezone:true}), humanApprovalExpiresAt: timestamp('human_approval_expires_at',{withTimezone:true}),
  captured: jsonb('captured'), captureHash: varchar('capture_hash',{length:64}), capturedAt: timestamp('captured_at',{withTimezone:true}),
  sendGeneration: integer('send_generation').notNull().default(0), leaseOwner: uuid('lease_owner'), leaseUntil: timestamp('lease_until',{withTimezone:true}),
  firstSendAt: timestamp('first_send_at',{withTimezone:true}), lastSendAt: timestamp('last_send_at',{withTimezone:true}),
  remoteOrder: varchar('remote_order',{length:66}), remoteState: varchar('remote_state',{length:32}), taskId: varchar('task_id',{length:78}), taskBoard: varchar('task_board',{length:42}),
  paymentTransaction: varchar('payment_transaction',{length:88}), paymentBlockHash: varchar('payment_block_hash',{length:66}), paymentBlock: varchar('payment_block',{length:24}),
  refundTransaction: varchar('refund_transaction',{length:88}), failureCode: varchar('failure_code',{length:64}),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(), updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
}, t => ({ idem: uniqueIndex('brainchain_buyer_order_idem').on(t.avatarId,t.idempotencyKey), nonce: uniqueIndex('brainchain_buyer_nonce').on(t.payer,t.paymentNonce),
  networkCheck:check('brainchain_buyer_order_network',sql`(${t.network}='eip155:84532' AND ${t.solanaArtifact} IS NULL AND (${t.payer} IS NULL OR ${t.payer} ~ '^0x[0-9a-f]{40}$')) OR (${t.network}='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' AND (${t.payer} IS NULL OR ${t.payer} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') AND (${t.terms} IS NULL OR (${t.solanaArtifact} IS NOT NULL AND jsonb_typeof(${t.solanaArtifact})='object')))`),
  discoveryShape:check('brainchain_buyer_discovery_shape',sql`${t.solanaDiscovery} IS NULL OR (${t.network}='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' AND ${t.solanaArtifact} IS NOT NULL AND ${t.captured} IS NOT NULL AND ${t.firstSendAt} IS NOT NULL AND jsonb_typeof(${t.solanaDiscovery})='object' AND octet_length(${t.solanaDiscovery}::text)<=4096)`),
  approvalWalletTuple:check('brainchain_buyer_approval_wallet_tuple',sql`(${t.humanApprovalWallet} IS NULL AND ${t.humanApprovalWalletVersion} IS NULL) OR (${t.humanApprovalWallet} IS NOT NULL AND ${t.humanApprovalWalletVersion} IS NOT NULL AND ${t.humanApprovalWalletVersion} >= 0 AND ${t.humanApprovalWalletVersion} <= 9007199254740991)`),
  remote: uniqueIndex('brainchain_buyer_remote_order').on(t.remoteOrder), lane: check('brainchain_buyer_actor',sql`${t.actor} IN ('human','agent')`) }));
export const brainchainBuyerEvents = pgTable('brainchain_buyer_events', {
  id: uuid('id').primaryKey().defaultRandom(), orderId: uuid('order_id').notNull().references(() => brainchainBuyerOrders.id), kind: varchar('kind',{length:32}).notNull(),
  evidence: jsonb('evidence').notNull(), transaction: varchar('transaction',{length:88}), logIndex: integer('log_index'),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
}, t => ({ receipt: uniqueIndex('brainchain_buyer_receipt_once').on(t.kind,t.transaction,t.logIndex) }));
