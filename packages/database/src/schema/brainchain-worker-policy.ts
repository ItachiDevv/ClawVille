import {sql} from 'drizzle-orm';
import {pgTable,uuid,varchar,jsonb,integer,bigint,numeric,timestamp,foreignKey,uniqueIndex,check,text} from 'drizzle-orm/pg-core';
import {brainchainWorkerBindings,brainchainSignerAuthorities,brainchainExecutionAuthorities,brainchainSignerOperations} from './brainchain';
import {brainchainDeliveryAuthorities} from './brainchain-delivery';
import {avatars} from './avatars';
import {users} from './users';

export const brainchainWorkerPolicyBudgets=pgTable('brainchain_worker_policy_budgets',{
  bindingId:uuid('binding_id').primaryKey().references(()=>brainchainWorkerBindings.id),avatarId:uuid('avatar_id').notNull().references(()=>avatars.id),
  environment:varchar('environment',{length:8}).notNull().default('testnet'),chainId:integer('chain_id').notNull().default(274630),
  gasCommitted:numeric('gas_committed',{precision:78,scale:0}).notNull().default('0'),brainCommitted:numeric('brain_committed',{precision:78,scale:0}).notNull().default('0'),
  openaiCommitted:bigint('openai_committed',{mode:'bigint'}).notNull().default(0n),openrouterCommitted:bigint('openrouter_committed',{mode:'bigint'}).notNull().default(0n),tasksCommitted:integer('tasks_committed').notNull().default(0),
},t=>({owner:foreignKey({name:'brainchain_policy_budget_owner',columns:[t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainWorkerBindings.id,brainchainWorkerBindings.avatarId,brainchainWorkerBindings.environment,brainchainWorkerBindings.chainId]}),
  bounds:check('brainchain_policy_budget_bounds',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.gasCommitted}>=0 AND ${t.gasCommitted}<2::numeric^256 AND ${t.brainCommitted}>=0 AND ${t.brainCommitted}<2::numeric^256 AND ${t.openaiCommitted} BETWEEN 0 AND 10000000 AND ${t.openrouterCommitted} BETWEEN 0 AND 10000000 AND ${t.tasksCommitted}>=0`)}));
export const brainchainWorkerPolicies=pgTable('brainchain_worker_policies',{
  id:uuid('id').primaryKey().defaultRandom(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),userId:uuid('user_id').notNull().references(()=>users.id),
  environment:varchar('environment',{length:8}).notNull().default('testnet'),chainId:integer('chain_id').notNull().default(274630),revision:integer('revision').notNull(),
  payload:jsonb('payload').notNull(),payloadHash:varchar('payload_hash',{length:64}).notNull(),state:varchar('state',{length:12}).notNull().default('requested'),
  ownerGrantId:varchar('owner_grant_id',{length:64}),approvedAt:timestamp('approved_at',{withTimezone:true}),revokedAt:timestamp('revoked_at',{withTimezone:true}),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({owner:foreignKey({name:'brainchain_worker_policy_owner',columns:[t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainWorkerBindings.id,brainchainWorkerBindings.avatarId,brainchainWorkerBindings.environment,brainchainWorkerBindings.chainId]}),
  revision:uniqueIndex('brainchain_worker_policy_revision').on(t.bindingId,t.revision),tuple:uniqueIndex('brainchain_worker_policy_tuple').on(t.id,t.bindingId,t.avatarId),userTuple:uniqueIndex('brainchain_worker_policy_user_tuple').on(t.id,t.bindingId,t.avatarId,t.userId),
  active:uniqueIndex('brainchain_worker_policy_one_active').on(t.bindingId).where(sql`${t.state}='active'`),
  bounds:check('brainchain_worker_policy_bounds',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.revision}>0 AND ${t.payloadHash}~'^[a-f0-9]{64}$' AND jsonb_typeof(${t.payload})='object' AND ${t.state} IN ('requested','active','paused','revoked') AND ${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '1 day' AND (${t.state}<>'active' OR (${t.ownerGrantId} IS NOT NULL AND ${t.approvedAt} IS NOT NULL))`),
}));
// The cyclic consumed-proof FK and immutable/revocation triggers are installed explicitly by migration0109.
export const brainchainWorkerPolicyChallenges=pgTable('brainchain_worker_policy_challenges',{
  nonceHash:varchar('nonce_hash',{length:64}).primaryKey(),policyId:uuid('policy_id').notNull(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),userId:uuid('user_id').notNull().references(()=>users.id),
  wallet:varchar('wallet',{length:44}).notNull(),domain:varchar('domain',{length:80}).notNull(),message:text('message').notNull(),messageHash:varchar('message_hash',{length:64}).notNull(),attempts:integer('attempts').notNull().default(0),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),consumedAt:timestamp('consumed_at',{withTimezone:true}),
},t=>({owner:foreignKey({name:'brainchain_worker_policy_challenge_owner',columns:[t.policyId,t.bindingId,t.avatarId,t.userId],foreignColumns:[brainchainWorkerPolicies.id,brainchainWorkerPolicies.bindingId,brainchainWorkerPolicies.avatarId,brainchainWorkerPolicies.userId]}),
  tuple:uniqueIndex('brainchain_worker_policy_challenge_tuple').on(t.nonceHash,t.bindingId,t.avatarId,t.userId),
  bounds:check('brainchain_worker_policy_challenge_bounds',sql`${t.nonceHash}~'^[a-f0-9]{64}$' AND ${t.messageHash}~'^[a-f0-9]{64}$' AND ${t.attempts} BETWEEN 0 AND 5 AND ${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '2 minutes' AND (${t.consumedAt} IS NULL OR (${t.consumedAt}>=${t.createdAt} AND ${t.consumedAt}<${t.expiresAt}))`)}));
export const brainchainWorkerPolicyIssuances=pgTable('brainchain_worker_policy_issuances',{
  id:uuid('id').primaryKey().defaultRandom(),policyId:uuid('policy_id').notNull(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),actionKey:varchar('action_key',{length:128}).notNull(),
  kind:varchar('kind',{length:24}).notNull(),requestHash:varchar('request_hash',{length:64}).notNull(),assignmentHash:varchar('assignment_hash',{length:64}),evidence:jsonb('evidence').notNull(),
  signerAuthorityId:uuid('signer_authority_id').references(()=>brainchainSignerAuthorities.id),gasAuthorityId:uuid('gas_authority_id').references(()=>brainchainSignerAuthorities.id),
  executionAuthorityId:uuid('execution_authority_id').references(()=>brainchainExecutionAuthorities.id),deliveryAuthorityId:uuid('delivery_authority_id').references(()=>brainchainDeliveryAuthorities.id),
  gasReserved:numeric('gas_reserved',{precision:78,scale:0}).notNull().default('0'),brainReserved:numeric('brain_reserved',{precision:78,scale:0}).notNull().default('0'),computeReserved:bigint('compute_reserved',{mode:'bigint'}).notNull().default(0n),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({owner:foreignKey({name:'brainchain_worker_policy_issue_owner',columns:[t.policyId,t.bindingId,t.avatarId],foreignColumns:[brainchainWorkerPolicies.id,brainchainWorkerPolicies.bindingId,brainchainWorkerPolicies.avatarId]}),
  signerOwner:foreignKey({name:'brainchain_policy_signer_owner',columns:[t.signerAuthorityId,t.bindingId,t.avatarId],foreignColumns:[brainchainSignerAuthorities.id,brainchainSignerAuthorities.bindingId,brainchainSignerAuthorities.avatarId]}),
  gasOwner:foreignKey({name:'brainchain_policy_gas_owner',columns:[t.gasAuthorityId,t.bindingId,t.avatarId],foreignColumns:[brainchainSignerAuthorities.id,brainchainSignerAuthorities.bindingId,brainchainSignerAuthorities.avatarId]}),
  executionOwner:foreignKey({name:'brainchain_policy_execution_owner',columns:[t.executionAuthorityId,t.bindingId,t.avatarId],foreignColumns:[brainchainExecutionAuthorities.id,brainchainExecutionAuthorities.bindingId,brainchainExecutionAuthorities.avatarId]}),
  deliveryOwner:foreignKey({name:'brainchain_policy_delivery_owner',columns:[t.deliveryAuthorityId,t.bindingId,t.avatarId],foreignColumns:[brainchainDeliveryAuthorities.id,brainchainDeliveryAuthorities.bindingId,brainchainDeliveryAuthorities.avatarId]}),
  kind:check('brainchain_policy_issue_kind',sql`(${t.kind} IN ('faucet','approve-stake','approve-bond','stake','apply','submit','leave','withdraw') AND ${t.signerAuthorityId} IS NOT NULL AND ${t.gasAuthorityId} IS NOT NULL AND ${t.executionAuthorityId} IS NULL AND ${t.deliveryAuthorityId} IS NULL AND ${t.assignmentHash} IS NULL AND ${t.computeReserved}=0)
    OR (${t.kind}='result-signature' AND ${t.signerAuthorityId} IS NOT NULL AND ${t.gasAuthorityId} IS NULL AND ${t.executionAuthorityId} IS NULL AND ${t.deliveryAuthorityId} IS NULL AND ${t.assignmentHash} IS NULL AND ${t.gasReserved}=0 AND ${t.brainReserved}=0 AND ${t.computeReserved}=0)
    OR (${t.kind}='execution' AND ${t.signerAuthorityId} IS NULL AND ${t.gasAuthorityId} IS NULL AND ${t.executionAuthorityId} IS NOT NULL AND ${t.deliveryAuthorityId} IS NULL AND ${t.assignmentHash} IS NOT NULL AND ${t.gasReserved}=0 AND ${t.brainReserved}=0 AND ${t.computeReserved}>0)
    OR (${t.kind}='delivery' AND ${t.signerAuthorityId} IS NULL AND ${t.gasAuthorityId} IS NULL AND ${t.executionAuthorityId} IS NULL AND ${t.deliveryAuthorityId} IS NOT NULL AND ${t.assignmentHash} IS NULL AND ${t.gasReserved}=0 AND ${t.brainReserved}=0 AND ${t.computeReserved}=0)`),
  key:uniqueIndex('brainchain_worker_policy_issue_key').on(t.bindingId,t.actionKey),bounds:check('brainchain_worker_policy_issue_bounds',sql`${t.requestHash}~'^[a-f0-9]{64}$' AND (${t.assignmentHash} IS NULL OR ${t.assignmentHash}~'^[a-f0-9]{64}$') AND ${t.gasReserved}>=0 AND ${t.gasReserved}<2::numeric^256 AND ${t.brainReserved}>=0 AND ${t.brainReserved}<2::numeric^256 AND ${t.computeReserved} BETWEEN 0 AND 10000000 AND jsonb_typeof(${t.evidence})='object'`)}));

export const brainchainWorkerJobs=pgTable('brainchain_worker_jobs',{
  bindingId:uuid('binding_id').primaryKey(),avatarId:uuid('avatar_id').notNull(),policyId:uuid('policy_id').notNull(),
  generation:integer('generation').notNull(),leaseOwner:uuid('lease_owner').notNull(),claimedAt:timestamp('claimed_at',{withTimezone:true}).notNull(),leaseUntil:timestamp('lease_until',{withTimezone:true}).notNull(),
  pendingPlan:jsonb('pending_plan'),lastState:varchar('last_state',{length:96}),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({owner:foreignKey({name:'brainchain_worker_job_policy',columns:[t.policyId,t.bindingId,t.avatarId],foreignColumns:[brainchainWorkerPolicies.id,brainchainWorkerPolicies.bindingId,brainchainWorkerPolicies.avatarId]}),
  bounds:check('brainchain_worker_job_bounds',sql`${t.generation}>0 AND ${t.leaseUntil}>${t.claimedAt} AND ${t.leaseUntil}<=${t.claimedAt}+interval '60 seconds' AND (${t.pendingPlan} IS NULL OR (jsonb_typeof(${t.pendingPlan})='object' AND octet_length(${t.pendingPlan}::text)<=32768))`)}));

export const brainchainSignerReceiptObservations=pgTable('brainchain_signer_receipt_observations',{
  id:uuid('id').primaryKey().defaultRandom(),operationId:uuid('operation_id').notNull(),generation:integer('generation').notNull(),transactionHash:varchar('transaction_hash',{length:66}).notNull(),
  evidenceHash:varchar('evidence_hash',{length:64}).notNull(),evidence:jsonb('evidence').notNull(),state:varchar('state',{length:12}).notNull(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({owner:foreignKey({name:'brainchain_signer_receipt_owner',columns:[t.operationId,t.generation,t.transactionHash],foreignColumns:[brainchainSignerOperations.id,brainchainSignerOperations.generation,brainchainSignerOperations.transactionHash]}),
  once:uniqueIndex('brainchain_signer_receipt_once').on(t.operationId,t.evidenceHash),bounds:check('brainchain_signer_receipt_bounds',sql`${t.generation}>0 AND ${t.transactionHash}~'^0x[a-f0-9]{64}$' AND ${t.evidenceHash}~'^[a-f0-9]{64}$' AND ${t.state} IN ('pending','orphaned','included') AND jsonb_typeof(${t.evidence})='object' AND octet_length(${t.evidence}::text)<=8192`)}));
