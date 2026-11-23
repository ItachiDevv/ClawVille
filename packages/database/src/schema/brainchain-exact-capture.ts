import {sql} from 'drizzle-orm';
import {pgTable,uuid,varchar,integer,numeric,jsonb,timestamp,foreignKey,check,uniqueIndex,unique} from 'drizzle-orm/pg-core';
import {brainchainSignerOperations} from './brainchain';
import {brainchainTaskResults,brainchainResultSubmissions} from './brainchain-delivery';
import {brainchainExactResultConsents} from './brainchain-exact-recovery';

export const brainchainExactCaptureAuthorities=pgTable('brainchain_exact_capture_authorities',{
  authorityPolicyVersion:varchar('authority_policy_version',{length:64}),authorityPolicyDigest:varchar('authority_policy_digest',{length:64}),
 id:uuid('id').primaryKey().defaultRandom(),consentId:uuid('consent_id').notNull().unique().references(()=>brainchainExactResultConsents.id),
 operationId:uuid('operation_id').notNull(),resultId:uuid('result_id').notNull(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),
 environment:varchar('environment',{length:8}).notNull().default('testnet'),chainId:integer('chain_id').notNull().default(274630),
 generation:integer('generation').notNull(),nonce:numeric('nonce',{precision:78,scale:0}).notNull(),intent:jsonb('intent').notNull(),intentHash:varchar('intent_hash',{length:64}).notNull(),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>({
  configuredPair:check('brainchain_exact_capture_authorities_configured_pair',sql`(${t.authorityPolicyVersion} IS NULL AND ${t.authorityPolicyDigest} IS NULL) OR (${t.authorityPolicyVersion} IS NOT NULL AND ${t.authorityPolicyDigest} IS NOT NULL AND ${t.authorityPolicyVersion}='brainchain-testnet-configured-authority-v1' AND ${t.authorityPolicyDigest}='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6')`),
 consentOwner:foreignKey({name:'brainchain_capture_consent_owner',columns:[t.consentId,t.resultId,t.bindingId,t.avatarId],foreignColumns:[brainchainExactResultConsents.id,brainchainExactResultConsents.resultId,brainchainExactResultConsents.bindingId,brainchainExactResultConsents.avatarId]}),
 operation:unique('brainchain_capture_authority_operation').on(t.id,t.operationId),
 operationOwner:foreignKey({name:'brainchain_capture_operation_owner',columns:[t.operationId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainSignerOperations.id,brainchainSignerOperations.bindingId,brainchainSignerOperations.avatarId,brainchainSignerOperations.environment,brainchainSignerOperations.chainId]}),
 resultOwner:foreignKey({name:'brainchain_capture_result_owner',columns:[t.resultId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainTaskResults.id,brainchainTaskResults.bindingId,brainchainTaskResults.avatarId,brainchainTaskResults.environment,brainchainTaskResults.chainId]}),
 submission:foreignKey({name:'brainchain_capture_submission',columns:[t.operationId,t.resultId],foreignColumns:[brainchainResultSubmissions.operationId,brainchainResultSubmissions.resultId]}),
 values:check('brainchain_capture_values',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.generation}>0 AND ${t.nonce}>=0 AND ${t.nonce}<=9007199254740991 AND ${t.intentHash} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.intent})='object' AND ${t.expiresAt}>${t.createdAt}`),
}));

export const brainchainExactCaptureAcceptances=pgTable('brainchain_exact_capture_acceptances',{
 operationId:uuid('operation_id').primaryKey().references(()=>brainchainSignerOperations.id),
 authorityId:uuid('authority_id').notNull().unique(),
 acceptedAt:timestamp('accepted_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({authorityOperation:foreignKey({columns:[t.authorityId,t.operationId],foreignColumns:[brainchainExactCaptureAuthorities.id,brainchainExactCaptureAuthorities.operationId]})}));
