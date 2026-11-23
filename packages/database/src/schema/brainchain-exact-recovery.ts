import {pgTable,uuid,varchar,integer,text,timestamp,jsonb,bigint,primaryKey,uniqueIndex,unique} from 'drizzle-orm/pg-core';
import {brainchainWorkerPolicies} from './brainchain-worker-policy';
import {brainchainTaskResults,brainchainDeliveryAuthorities} from './brainchain-delivery';
import {brainchainSignerAuthorities} from './brainchain';
import {users} from './users';

export const brainchainRecoveryOwnerControls=pgTable('brainchain_recovery_owner_controls',{
  id:uuid('id').primaryKey().defaultRandom(),policyId:uuid('policy_id').notNull().references(()=>brainchainWorkerPolicies.id),
  bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),userId:uuid('user_id').notNull().references(()=>users.id),
  policyRevision:integer('policy_revision').notNull(),actor:varchar('actor',{length:8}).notNull(),action:varchar('action',{length:8}).notNull(),
  transactionId:bigint('transaction_id',{mode:'bigint'}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
export const brainchainRecoveryOwnerRevocations=pgTable('brainchain_recovery_owner_revocations',{
  authorityId:uuid('authority_id').notNull(),authorityKind:varchar('authority_kind',{length:12}).notNull(),controlId:uuid('control_id').notNull().references(()=>brainchainRecoveryOwnerControls.id),
  revokedAt:timestamp('revoked_at',{withTimezone:true}).notNull(),
},t=>({key:primaryKey({columns:[t.authorityKind,t.authorityId]})}));
export const brainchainExactResultConsents=pgTable('brainchain_exact_result_consents',{
  id:uuid('id').primaryKey().defaultRandom(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),userId:uuid('user_id').notNull().references(()=>users.id),
  resultId:uuid('result_id').notNull().references(()=>brainchainTaskResults.id),payload:jsonb('payload').notNull(),payloadHash:varchar('payload_hash',{length:64}).notNull(),
  state:varchar('state',{length:12}).notNull().default('requested'),approvalNonce:varchar('approval_nonce',{length:64}),wallet:varchar('wallet',{length:44}),walletVersion:bigint('wallet_version',{mode:'number'}),
  approvedAt:timestamp('approved_at',{withTimezone:true}),revokedAt:timestamp('revoked_at',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>({captureOwner:unique('brainchain_exact_consent_capture_owner').on(t.id,t.resultId,t.bindingId,t.avatarId)}));
export const brainchainExactResultChallenges=pgTable('brainchain_exact_result_challenges',{
  nonceHash:varchar('nonce_hash',{length:64}).primaryKey(),consentId:uuid('consent_id').notNull().references(()=>brainchainExactResultConsents.id),sessionId:varchar('session_id',{length:255}).notNull(),
  wallet:varchar('wallet',{length:44}).notNull(),walletVersion:bigint('wallet_version',{mode:'number'}).notNull(),message:text('message').notNull(),attempts:integer('attempts').notNull().default(0),consumedAt:timestamp('consumed_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
});
export const brainchainExactResultIssuances=pgTable('brainchain_exact_result_issuances',{
  consentId:uuid('consent_id').notNull().references(()=>brainchainExactResultConsents.id),stage:varchar('stage',{length:24}).notNull(),deliveryAuthorityId:uuid('delivery_authority_id').notNull().references(()=>brainchainDeliveryAuthorities.id),
  signerAuthorityId:uuid('signer_authority_id').references(()=>brainchainSignerAuthorities.id),gasAuthorityId:uuid('gas_authority_id').references(()=>brainchainSignerAuthorities.id),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({key:primaryKey({columns:[t.consentId,t.stage]})}));
