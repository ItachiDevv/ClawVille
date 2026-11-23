import {pgTable,uuid,varchar,jsonb,integer,bigint,timestamp,uniqueIndex} from 'drizzle-orm/pg-core';
import {avatars} from './avatars';
import {users} from './users';
import {brainchainWorkerBindings} from './brainchain';
/** Testnet reservations remain liabilities after every source-only observation. */
export const brainchainFundingOperations=pgTable('brainchain_funding_operations',{
 id:uuid('id').primaryKey(),avatarId:uuid('avatar_id').notNull().references(()=>avatars.id),userId:uuid('user_id').notNull().references(()=>users.id),
 workerId:uuid('worker_id').notNull().references(()=>brainchainWorkerBindings.id),actor:varchar('actor',{length:8}).notNull(),idempotencyKey:varchar('idempotency_key',{length:64}).notNull(),
 draft:jsonb('draft').notNull(),artifact:jsonb('artifact').notNull(),artifactHash:varchar('artifact_hash',{length:64}).notNull(),
 sourceChain:integer('source_chain').notNull(),sourceAddress:varchar('source_address',{length:42}).notNull(),sourceNonce:bigint('source_nonce',{mode:'number'}).notNull(),state:varchar('state',{length:24}).notNull().default('reserved'),
 approvalNonce:varchar('approval_nonce',{length:64}),approvalWallet:varchar('approval_wallet',{length:44}),approvalWalletVersion:bigint('approval_wallet_version',{mode:'number'}),approvalExpiresAt:timestamp('approval_expires_at',{withTimezone:true}),approvedAt:timestamp('approved_at',{withTimezone:true}),exposedAt:timestamp('exposed_at',{withTimezone:true}),
 captured:jsonb('captured'),captureHash:varchar('capture_hash',{length:64}),sourceTransaction:varchar('source_transaction',{length:66}),leaseOwner:uuid('lease_owner'),leaseUntil:timestamp('lease_until',{withTimezone:true}),firstSendAt:timestamp('first_send_at',{withTimezone:true}),sourceEvidence:jsonb('source_evidence'),deskReport:jsonb('desk_report'),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({idem:uniqueIndex('brainchain_funding_idempotency').on(t.avatarId,t.idempotencyKey),nonce:uniqueIndex('brainchain_funding_source_nonce').on(t.sourceChain,t.sourceAddress,t.sourceNonce),transaction:uniqueIndex('brainchain_funding_transaction').on(t.sourceChain,t.sourceTransaction)}));
