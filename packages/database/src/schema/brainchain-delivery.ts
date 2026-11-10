import {sql} from 'drizzle-orm';
import {pgTable,uuid,varchar,integer,text,timestamp,jsonb,numeric,uniqueIndex,foreignKey,check,unique} from 'drizzle-orm/pg-core';
import {brainchainWorkerTasks,brainchainTaskAttempts,brainchainSignerAuthorities,brainchainSignerOperations} from './brainchain';
import {brainchainComputeCalls} from './brainchain-compute';

/** Private, immutable output. Never copied to public knowledge, telemetry, or agent memories. */
export const brainchainTaskResults=pgTable('brainchain_task_results',{
  id:uuid('id').primaryKey().defaultRandom(),taskId:uuid('task_id').notNull(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),
  environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),attemptId:uuid('attempt_id').notNull(),callId:uuid('call_id').notNull(),
  generation:integer('generation').notNull(),leaseOwner:uuid('lease_owner').notNull(),promptHash:varchar('prompt_hash',{length:64}).notNull(),
  resultText:text('result_text').notNull(),resultSha256:varchar('result_sha256',{length:64}).notNull(),resultHash:varchar('result_hash',{length:66}).notNull(),
  hireSnapshot:jsonb('hire_snapshot'),hireSnapshotHash:varchar('hire_snapshot_hash',{length:64}),
  state:varchar('state',{length:24}).notNull().default('frozen'),uploadToken:uuid('upload_token'),uploadStartedAt:timestamp('upload_started_at',{withTimezone:true}),
  resultUri:text('result_uri'),submission:jsonb('submission'),createdAt:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>({
  signerOwner:unique('brainchain_result_signer_owner').on(t.id,t.bindingId,t.avatarId,t.environment,t.chainId),
  exactOwner:uniqueIndex('brainchain_result_exact_owner').on(t.id,t.bindingId,t.avatarId),
  snapshot:check('brainchain_result_hire_snapshot',sql`(${t.hireSnapshot} IS NULL AND ${t.hireSnapshotHash} IS NULL) OR (${t.hireSnapshot} IS NOT NULL AND ${t.hireSnapshotHash} IS NOT NULL AND jsonb_typeof(${t.hireSnapshot})='object' AND ${t.hireSnapshotHash} ~ '^[a-f0-9]{64}$')`),
  taskOnce:uniqueIndex('brainchain_result_task_once').on(t.taskId),attemptOnce:uniqueIndex('brainchain_result_attempt_once').on(t.attemptId),callOnce:uniqueIndex('brainchain_result_call_once').on(t.callId),
  taskOwner:foreignKey({columns:[t.taskId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainWorkerTasks.id,brainchainWorkerTasks.bindingId,brainchainWorkerTasks.avatarId,brainchainWorkerTasks.environment,brainchainWorkerTasks.chainId],name:'brainchain_result_task_owner'}).onDelete('restrict'),
  attemptOwner:foreignKey({columns:[t.attemptId,t.taskId,t.bindingId,t.avatarId,t.environment,t.chainId,t.generation,t.leaseOwner,t.promptHash],foreignColumns:[brainchainTaskAttempts.id,brainchainTaskAttempts.taskId,brainchainTaskAttempts.bindingId,brainchainTaskAttempts.avatarId,brainchainTaskAttempts.environment,brainchainTaskAttempts.chainId,brainchainTaskAttempts.generation,brainchainTaskAttempts.leaseOwner,brainchainTaskAttempts.promptHash],name:'brainchain_result_attempt_owner'}).onDelete('restrict'),
  callOwner:foreignKey({columns:[t.callId,t.taskId,t.attemptId,t.avatarId,t.generation,t.leaseOwner,t.promptHash],foreignColumns:[brainchainComputeCalls.id,brainchainComputeCalls.taskId,brainchainComputeCalls.attemptId,brainchainComputeCalls.avatarId,brainchainComputeCalls.generation,brainchainComputeCalls.leaseOwner,brainchainComputeCalls.promptHash],name:'brainchain_result_call_owner'}).onDelete('restrict'),
  values:check('brainchain_result_values',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.generation}>0 AND octet_length(${t.resultText}) BETWEEN 1 AND 32768 AND ${t.resultSha256} ~ '^[a-f0-9]{64}$' AND ${t.resultHash} ~ '^0x[a-f0-9]{64}$'`),
  lifecycle:check('brainchain_result_lifecycle',sql`(${t.state}='frozen' AND ${t.uploadToken} IS NULL AND ${t.uploadStartedAt} IS NULL AND ${t.resultUri} IS NULL AND ${t.submission} IS NULL) OR (${t.state} IN ('uploading','upload_uncertain') AND ${t.uploadToken} IS NOT NULL AND ${t.uploadStartedAt} IS NOT NULL AND ${t.resultUri} IS NULL AND ${t.submission} IS NULL) OR (${t.state} IN ('uploaded','prepared') AND ${t.uploadToken} IS NOT NULL AND ${t.uploadStartedAt} IS NOT NULL AND ${t.resultUri} IS NOT NULL AND ${t.resultUri}='https://brain.testnet.usebrainchain.com/records/'||${t.resultHash}||'.txt' AND ((${t.state}='uploaded' AND ${t.submission} IS NULL) OR (${t.state}='prepared' AND ${t.submission} IS NOT NULL)))`),
}));

export const brainchainResultSignatures=pgTable('brainchain_result_signatures',{
  id:uuid('id').primaryKey().defaultRandom(),resultId:uuid('result_id').notNull().unique(),authorityId:uuid('authority_id').notNull().unique(),
  bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),
  signerAddress:varchar('signer_address',{length:42}).notNull(),generation:integer('generation').notNull(),intent:jsonb('intent').notNull(),intentHash:varchar('intent_hash',{length:64}).notNull(),
  state:varchar('state',{length:16}).notNull().default('accepted'),acceptedAt:timestamp('accepted_at',{withTimezone:true}).notNull().defaultNow(),signatureRef:varchar('signature_ref',{length:64}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({
  resultOwner:foreignKey({name:'brainchain_signature_result_owner',columns:[t.resultId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainTaskResults.id,brainchainTaskResults.bindingId,brainchainTaskResults.avatarId,brainchainTaskResults.environment,brainchainTaskResults.chainId]}),
  authorityOwner:foreignKey({name:'brainchain_signature_authority_owner',columns:[t.authorityId,t.bindingId,t.avatarId,t.environment,t.chainId,t.signerAddress],foreignColumns:[brainchainSignerAuthorities.id,brainchainSignerAuthorities.bindingId,brainchainSignerAuthorities.avatarId,brainchainSignerAuthorities.environment,brainchainSignerAuthorities.chainId,brainchainSignerAuthorities.signerAddress]}),
  values:check('brainchain_signature_values',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.generation}>0 AND ${t.intentHash} ~ '^[a-f0-9]{64}$' AND ((${t.state} IN ('accepted','uncertain') AND ${t.signatureRef} IS NULL) OR (${t.state}='captured' AND ${t.signatureRef} IS NOT NULL AND ${t.signatureRef} ~ '^[a-f0-9]{64}$'))`),
}));

export const brainchainResultSubmissions=pgTable('brainchain_result_submissions',{
  resultId:uuid('result_id').primaryKey(),operationId:uuid('operation_id').notNull().unique(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),
},t=>({
  operationResult:unique('brainchain_submission_operation_result').on(t.operationId,t.resultId),
  resultOwner:foreignKey({name:'brainchain_submission_result_owner',columns:[t.resultId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainTaskResults.id,brainchainTaskResults.bindingId,brainchainTaskResults.avatarId,brainchainTaskResults.environment,brainchainTaskResults.chainId]}),
  operationOwner:foreignKey({name:'brainchain_submission_operation_owner',columns:[t.operationId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainSignerOperations.id,brainchainSignerOperations.bindingId,brainchainSignerOperations.avatarId,brainchainSignerOperations.environment,brainchainSignerOperations.chainId]}),
  testnet:check('brainchain_submission_testnet',sql`${t.environment}='testnet' AND ${t.chainId}=274630`),
}));

export const brainchainDeliveryAuthorities=pgTable('brainchain_delivery_authorities',{
  authorityPolicyVersion:varchar('authority_policy_version',{length:64}),authorityPolicyDigest:varchar('authority_policy_digest',{length:64}),
  exactConsentId:uuid('exact_consent_id'),observationPolicy:varchar('observation_policy',{length:40}).notNull().default('legacy-depth12-age120-v1'),
  id:uuid('id').primaryKey().defaultRandom(),resultId:uuid('result_id').notNull(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),stage:varchar('stage',{length:24}).notNull(),taskGeneration:integer('task_generation').notNull(),
  hireSnapshotHash:varchar('hire_snapshot_hash',{length:64}).notNull(),resultHash:varchar('result_hash',{length:66}).notNull(),resultSha256:varchar('result_sha256',{length:64}).notNull(),
  operationId:uuid('operation_id').references(()=>brainchainSignerOperations.id),transactionHash:varchar('transaction_hash',{length:66}),nonce:numeric('nonce',{precision:20,scale:0}),gasCeiling:numeric('gas_ceiling',{precision:78,scale:0}),
  approvedBy:varchar('approved_by',{length:128}).notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),revokedAt:timestamp('revoked_at',{withTimezone:true}),consumedAt:timestamp('consumed_at',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({
  configuredPair:check('brainchain_delivery_authorities_configured_pair',sql`(${t.authorityPolicyVersion} IS NULL AND ${t.authorityPolicyDigest} IS NULL) OR (${t.authorityPolicyVersion} IS NOT NULL AND ${t.authorityPolicyDigest} IS NOT NULL AND ${t.authorityPolicyVersion}='brainchain-testnet-configured-authority-v1' AND ${t.authorityPolicyDigest}='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6')`),
  owner:foreignKey({name:'brainchain_delivery_authority_owner',columns:[t.resultId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainTaskResults.id,brainchainTaskResults.bindingId,brainchainTaskResults.avatarId,brainchainTaskResults.environment,brainchainTaskResults.chainId]}),
  tuple:unique('brainchain_delivery_authority_tuple').on(t.id,t.resultId,t.bindingId,t.avatarId,t.environment,t.chainId,t.stage,t.taskGeneration),
  policyOwner:unique('brainchain_delivery_policy_owner').on(t.id,t.bindingId,t.avatarId),
  numericBounds:check('brainchain_delivery_numeric_bounds',sql`(${t.nonce} IS NULL OR ${t.nonce} BETWEEN 0 AND 18446744073709551615) AND (${t.gasCeiling} IS NULL OR ${t.gasCeiling} BETWEEN 1 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935)`),
  values:check('brainchain_delivery_authority_values',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.taskGeneration}>0 AND ${t.stage} IN ('signature','upload','prepare-submit','broadcast','reconcile') AND ${t.hireSnapshotHash} ~ '^[a-f0-9]{64}$' AND ${t.resultHash} ~ '^0x[a-f0-9]{64}$' AND ${t.resultSha256} ~ '^[a-f0-9]{64}$' AND length(${t.approvedBy})>0 AND ${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '10 minutes' AND (${t.consumedAt} IS NULL OR (${t.consumedAt}>=${t.createdAt} AND ${t.consumedAt}<${t.expiresAt})) AND ((${t.stage}='broadcast' AND ${t.operationId} IS NOT NULL AND ${t.transactionHash} IS NOT NULL AND ${t.transactionHash} ~ '^0x[a-f0-9]{64}$' AND ${t.nonce} IS NOT NULL AND ${t.nonce} BETWEEN 0 AND 18446744073709551615 AND ${t.gasCeiling} IS NOT NULL AND ${t.gasCeiling} BETWEEN 1 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935) OR (${t.stage}<>'broadcast' AND ${t.operationId} IS NULL AND ${t.transactionHash} IS NULL AND ${t.nonce} IS NULL AND ${t.gasCeiling} IS NULL))`),
}));
export const brainchainDeliveryLeases=pgTable('brainchain_delivery_leases',{
  id:uuid('id').primaryKey().defaultRandom(),authorityId:uuid('authority_id').notNull().unique(),resultId:uuid('result_id').notNull(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),stage:varchar('stage',{length:24}).notNull(),taskGeneration:integer('task_generation').notNull(),
  generation:integer('generation').notNull(),leaseOwner:uuid('lease_owner').notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({
  authority:foreignKey({name:'brainchain_delivery_lease_authority',columns:[t.authorityId,t.resultId,t.bindingId,t.avatarId,t.environment,t.chainId,t.stage,t.taskGeneration],foreignColumns:[brainchainDeliveryAuthorities.id,brainchainDeliveryAuthorities.resultId,brainchainDeliveryAuthorities.bindingId,brainchainDeliveryAuthorities.avatarId,brainchainDeliveryAuthorities.environment,brainchainDeliveryAuthorities.chainId,brainchainDeliveryAuthorities.stage,brainchainDeliveryAuthorities.taskGeneration]}),
  generation:uniqueIndex('brainchain_delivery_lease_generation').on(t.resultId,t.generation),result:unique('brainchain_delivery_lease_result').on(t.id,t.resultId),
  values:check('brainchain_delivery_lease_values',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.generation}>0 AND ${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '60 seconds'`),
}));
export const brainchainDeliveryReconciliations=pgTable('brainchain_delivery_reconciliations',{
  leaseId:uuid('lease_id').primaryKey(),resultId:uuid('result_id').notNull(),evidence:jsonb('evidence').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({owner:foreignKey({columns:[t.leaseId,t.resultId],foreignColumns:[brainchainDeliveryLeases.id,brainchainDeliveryLeases.resultId]})}));
export const brainchainDeliverySubmitLeases=pgTable('brainchain_delivery_submit_leases',{
  operationId:uuid('operation_id').primaryKey().references(()=>brainchainSignerOperations.id),leaseId:uuid('lease_id').notNull(),resultId:uuid('result_id').notNull(),
},t=>({owner:foreignKey({columns:[t.leaseId,t.resultId],foreignColumns:[brainchainDeliveryLeases.id,brainchainDeliveryLeases.resultId]}),operation:foreignKey({columns:[t.operationId,t.resultId],foreignColumns:[brainchainResultSubmissions.operationId,brainchainResultSubmissions.resultId]})}));
