import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, varchar, unique} from 'drizzle-orm/pg-core';
import { avatars } from './avatars';

/** Address ownership is permanent in this pilot. There is no cross-avatar transfer or delete API. */
export const brainchainWorkerBindings = pgTable('brainchain_worker_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'restrict' }),
  environment: varchar('environment', { length: 8 }).notNull(),
  chainId: integer('chain_id').notNull(),
  address: varchar('address', { length: 42 }).notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  requestedState: varchar('requested_state', { length: 12 }).notNull().default('paused'),
  // Null means no chain eligibility observation exists. A local request cannot populate this field.
  observedEligibility: varchar('observed_eligibility', { length: 24 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  addressOwner: uniqueIndex('brainchain_binding_address_owner').on(t.environment, t.address),
  avatarEnvironment: uniqueIndex('brainchain_binding_avatar_environment').on(t.avatarId, t.environment),
  ownerTuple: unique('brainchain_binding_owner_tuple').on(t.id, t.avatarId, t.environment, t.chainId),
  signerOwnerTuple: unique('brainchain_binding_signer_owner').on(t.id,t.avatarId,t.environment,t.chainId,t.address),
  network: check('brainchain_binding_network', sql`(${t.environment} = 'testnet' AND ${t.chainId} = 274630) OR (${t.environment} = 'mainnet' AND ${t.chainId} = 274663)`),
  addressFormat: check('brainchain_binding_address_format', sql`${t.address} ~ '^0x[0-9a-f]{40}$' AND ${t.address} <> '0x0000000000000000000000000000000000000000'`),
  proofFormat: check('brainchain_binding_proof_format', sql`${t.proofHash} ~ '^[0-9a-f]{64}$'`),
  localState: check('brainchain_binding_local_state', sql`${t.requestedState} IN ('paused','draining','running')`),
  observedState: check('brainchain_binding_observed_state', sql`${t.observedEligibility} IS NULL OR ${t.observedEligibility} IN ('eligible','ineligible','unknown')`),
}));

export const brainchainBindingChallenges = pgTable('brainchain_binding_challenges', {
  nonceHash: varchar('nonce_hash', { length: 64 }).primaryKey(),
  avatarId: uuid('avatar_id').notNull().references(() => avatars.id, { onDelete: 'restrict' }),
  environment: varchar('environment', { length: 8 }).notNull(),
  chainId: integer('chain_id').notNull(),
  address: varchar('address', { length: 42 }).notNull(),
  domain: varchar('domain', { length: 80 }).notNull(),
  message: text('message').notNull(),
  messageHash: varchar('message_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  verificationAttempts: integer('verification_attempts').notNull().default(0),
}, (t) => ({
  avatarCreated: index('brainchain_challenge_avatar_created').on(t.avatarId, t.createdAt),
  network: check('brainchain_challenge_network', sql`(${t.environment} = 'testnet' AND ${t.chainId} = 274630) OR (${t.environment} = 'mainnet' AND ${t.chainId} = 274663)`),
  addressFormat: check('brainchain_challenge_address_format', sql`${t.address} ~ '^0x[0-9a-f]{40}$' AND ${t.address} <> '0x0000000000000000000000000000000000000000'`),
  hashes: check('brainchain_challenge_hashes', sql`${t.nonceHash} ~ '^[0-9a-f]{64}$' AND ${t.messageHash} ~ '^[0-9a-f]{64}$'`),
  lifespan: check('brainchain_challenge_lifespan', sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '2 minutes'`),
  attempts: check('brainchain_challenge_attempts', sql`${t.verificationAttempts} BETWEEN 0 AND 5`),
}));

export const brainchainWorkerTasks = pgTable('brainchain_worker_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  bindingId: uuid('binding_id').notNull(), avatarId: uuid('avatar_id').notNull(),
  environment: varchar('environment', { length: 8 }).notNull(), chainId: integer('chain_id').notNull(),
  boardAddress: varchar('board_address', { length: 42 }).notNull(), taskId: numeric('task_id', { precision: 78, scale: 0 }).notNull(),
  manifestHash: varchar('manifest_hash', { length: 64 }).notNull(),
  hireBlock: bigint('hire_block', { mode: 'bigint' }).notNull(), hireBlockHash: varchar('hire_block_hash', { length: 66 }).notNull(),
  hireTxHash: varchar('hire_tx_hash', { length: 66 }).notNull(), hireLogIndex: integer('hire_log_index').notNull(),
  observedBlock: bigint('observed_block', { mode: 'bigint' }).notNull(), observedBlockHash: varchar('observed_block_hash', { length: 66 }).notNull(),
  status: integer('status').notNull(), bountyAtomic: numeric('bounty_atomic', { precision: 39, scale: 0 }).notNull(),
  deadlineUnix: bigint('deadline_unix', { mode: 'bigint' }).notNull(), briefHash: varchar('brief_hash', { length: 66 }).notNull(),
  resultHash: varchar('result_hash', { length: 66 }).notNull(), canonical: boolean('canonical').notNull().default(true),
  leaseGeneration: integer('lease_generation').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  identity: uniqueIndex('brainchain_task_identity').on(t.chainId,t.boardAddress,t.taskId),
  ownerTuple: unique('brainchain_task_owner_tuple').on(t.id,t.bindingId,t.avatarId,t.environment,t.chainId),
  owner: foreignKey({ columns: [t.bindingId,t.avatarId,t.environment,t.chainId], foreignColumns: [brainchainWorkerBindings.id,brainchainWorkerBindings.avatarId,brainchainWorkerBindings.environment,brainchainWorkerBindings.chainId], name: 'brainchain_task_binding_owner' }).onDelete('restrict'),
  format: check('brainchain_task_format', sql`${t.boardAddress} ~ '^0x[0-9a-f]{40}$' AND ${t.manifestHash} ~ '^[0-9a-f]{64}$' AND ${t.hireBlockHash} ~ '^0x[0-9a-f]{64}$' AND ${t.hireTxHash} ~ '^0x[0-9a-f]{64}$' AND ${t.observedBlockHash} ~ '^0x[0-9a-f]{64}$' AND ${t.briefHash} ~ '^0x[0-9a-f]{64}$' AND ${t.resultHash} ~ '^0x[0-9a-f]{64}$'`),
  values: check('brainchain_task_values', sql`${t.taskId} BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND ${t.bountyAtomic} BETWEEN 0 AND 340282366920938463463374607431768211455 AND ${t.hireBlock} >= 0 AND ${t.observedBlock} >= ${t.hireBlock} AND ${t.hireLogIndex} >= 0 AND ${t.deadlineUnix} >= 0 AND ${t.status} BETWEEN 1 AND 9 AND ${t.leaseGeneration} >= 0`),
}));

/** Root-issued, single-attempt testnet execution approval. No public route creates these rows. */
export const brainchainExecutionAuthorities=pgTable('brainchain_execution_authorities',{
  authorityPolicyVersion:varchar('authority_policy_version',{length:64}),authorityPolicyDigest:varchar('authority_policy_digest',{length:64}),
  id:uuid('id').primaryKey().defaultRandom(),taskId:uuid('task_id').notNull(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),
  environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),generation:integer('generation').notNull(),
  briefHash:varchar('brief_hash',{length:66}).notNull(),inputHash:varchar('input_hash',{length:64}).notNull(),promptHash:varchar('prompt_hash',{length:64}).notNull(),
  approvedBy:varchar('approved_by',{length:128}).notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  revokedAt:timestamp('revoked_at',{withTimezone:true}),consumedAt:timestamp('consumed_at',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
  observationPolicy:varchar('observation_policy',{length:40}).notNull().default('legacy-depth12-age120-v1'),
},t=>({
  configuredPair:check('brainchain_execution_authorities_configured_pair',sql`(${t.authorityPolicyVersion} IS NULL AND ${t.authorityPolicyDigest} IS NULL) OR (${t.authorityPolicyVersion} IS NOT NULL AND ${t.authorityPolicyDigest} IS NOT NULL AND ${t.authorityPolicyVersion}='brainchain-testnet-configured-authority-v1' AND ${t.authorityPolicyDigest}='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6')`),
  observation:check('brainchain_execution_authorities_observation_policy',sql`${t.observationPolicy} IN ('legacy-depth12-age120-v1','nitro-testnet-latest-v1')`),
  owner:foreignKey({columns:[t.taskId,t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainWorkerTasks.id,brainchainWorkerTasks.bindingId,brainchainWorkerTasks.avatarId,brainchainWorkerTasks.environment,brainchainWorkerTasks.chainId],name:'brainchain_execution_task_owner'}).onDelete('restrict'),
  tuple:unique('brainchain_execution_owner_tuple').on(t.id,t.taskId,t.bindingId,t.avatarId,t.environment,t.chainId,t.generation,t.inputHash,t.promptHash),
  policyOwner:unique('brainchain_execution_policy_owner').on(t.id,t.bindingId,t.avatarId),
  values:check('brainchain_execution_values',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.generation}>0 AND ${t.briefHash} ~ '^0x[a-f0-9]{64}$' AND ${t.inputHash} ~ '^[a-f0-9]{64}$' AND ${t.promptHash} ~ '^[a-f0-9]{64}$' AND length(${t.approvedBy})>0 AND ${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '10 minutes' AND (${t.consumedAt} IS NULL OR (${t.consumedAt}>=${t.createdAt} AND ${t.consumedAt}<${t.expiresAt}))`),
}));

export const brainchainTaskAttempts = pgTable('brainchain_task_attempts', {
  id: uuid('id').primaryKey().defaultRandom(), taskId: uuid('task_id').notNull(), bindingId: uuid('binding_id').notNull(),
  avatarId: uuid('avatar_id').notNull(), environment: varchar('environment',{length:8}).notNull(), chainId: integer('chain_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(), generation: integer('generation').notNull(),
  purpose: varchar('purpose',{length:12}).notNull().default('recovery'),
  state: varchar('state',{length:16}).notNull().default('inspecting'), leaseOwner: uuid('lease_owner').notNull(),
  leaseUntil: timestamp('lease_until',{withTimezone:true}).notNull(), outputHash: varchar('output_hash',{length:64}),
  authorityId:uuid('authority_id'),inputHash:varchar('input_hash',{length:64}),promptHash:varchar('prompt_hash',{length:64}),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(), updatedAt: timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},(t)=>({
  number: uniqueIndex('brainchain_attempt_number').on(t.taskId,t.attemptNumber),
  generation: uniqueIndex('brainchain_attempt_generation').on(t.taskId,t.generation),
  owner: foreignKey({ columns:[t.taskId,t.bindingId,t.avatarId,t.environment,t.chainId], foreignColumns:[brainchainWorkerTasks.id,brainchainWorkerTasks.bindingId,brainchainWorkerTasks.avatarId,brainchainWorkerTasks.environment,brainchainWorkerTasks.chainId],name:'brainchain_attempt_task_owner' }).onDelete('restrict'),
  authorityOnce:uniqueIndex('brainchain_attempt_authority_once').on(t.authorityId),
  deliveryOwner:unique('brainchain_attempt_delivery_owner').on(t.id,t.taskId,t.bindingId,t.avatarId,t.environment,t.chainId,t.generation,t.leaseOwner,t.promptHash),
  authority:foreignKey({columns:[t.authorityId,t.taskId,t.bindingId,t.avatarId,t.environment,t.chainId,t.generation,t.inputHash,t.promptHash],foreignColumns:[brainchainExecutionAuthorities.id,brainchainExecutionAuthorities.taskId,brainchainExecutionAuthorities.bindingId,brainchainExecutionAuthorities.avatarId,brainchainExecutionAuthorities.environment,brainchainExecutionAuthorities.chainId,brainchainExecutionAuthorities.generation,brainchainExecutionAuthorities.inputHash,brainchainExecutionAuthorities.promptHash],name:'brainchain_attempt_execution_owner'}).onDelete('restrict'),
  values: check('brainchain_attempt_values',sql`${t.attemptNumber}>0 AND ${t.generation}>0 AND ((${t.purpose}='recovery' AND ${t.state} IN ('inspecting','reconciled','expired','suspended') AND ${t.authorityId} IS NULL AND ${t.inputHash} IS NULL AND ${t.promptHash} IS NULL) OR (${t.purpose}='execution' AND ${t.state} IN ('executing','executed','expired','suspended') AND ${t.authorityId} IS NOT NULL AND ${t.inputHash} IS NOT NULL AND ${t.promptHash} IS NOT NULL)) AND ${t.leaseUntil}>${t.createdAt} AND (${t.outputHash} IS NULL OR ${t.outputHash} ~ '^[0-9a-f]{64}$')`),
}));

export const brainchainIndexCursors = pgTable('brainchain_index_cursors', {
  id: uuid('id').primaryKey().defaultRandom(), bindingId: uuid('binding_id').notNull(), avatarId: uuid('avatar_id').notNull(),
  environment: varchar('environment',{length:8}).notNull(),chainId: integer('chain_id').notNull(),boardAddress:varchar('board_address',{length:42}).notNull(),
  epoch: integer('epoch').notNull().default(0),
  nextBlock: bigint('next_block',{mode:'bigint'}).notNull(), checkpointBlock:bigint('checkpoint_block',{mode:'bigint'}), checkpointHash:varchar('checkpoint_hash',{length:66}),
  updatedAt:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
},t=>({
  unique:uniqueIndex('brainchain_cursor_binding_board').on(t.bindingId,t.boardAddress),
  owner:foreignKey({columns:[t.bindingId,t.avatarId,t.environment,t.chainId],foreignColumns:[brainchainWorkerBindings.id,brainchainWorkerBindings.avatarId,brainchainWorkerBindings.environment,brainchainWorkerBindings.chainId],name:'brainchain_cursor_binding_owner'}).onDelete('restrict'),
  values:check('brainchain_cursor_values',sql`${t.epoch}>=0 AND ${t.nextBlock}>=0 AND ${t.boardAddress} ~ '^0x[0-9a-f]{40}$' AND ((${t.checkpointBlock} IS NULL AND ${t.checkpointHash} IS NULL) OR (${t.checkpointBlock} IS NOT NULL AND ${t.checkpointHash} IS NOT NULL AND ${t.checkpointBlock}>=0 AND ${t.checkpointHash} ~ '^0x[0-9a-f]{64}$'))`),
}));

/** Internal testnet custody records. No API route can provision a signer or issue authority. */
export const brainchainSignerStreams=pgTable('brainchain_signer_streams',{
  bindingId:uuid('binding_id').primaryKey(),avatarId:uuid('avatar_id').notNull(),environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),
  signerAddress:varchar('signer_address',{length:42}).notNull(),signerRef:varchar('signer_ref',{length:128}).notNull(),
  generation:integer('generation').notNull().default(1),nextNonce:numeric('next_nonce',{precision:20,scale:0}).notNull(),stopped:boolean('stopped').notNull().default(false),
  createdAt:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
},t=>({
  owner:foreignKey({columns:[t.bindingId,t.avatarId,t.environment,t.chainId,t.signerAddress],foreignColumns:[brainchainWorkerBindings.id,brainchainWorkerBindings.avatarId,brainchainWorkerBindings.environment,brainchainWorkerBindings.chainId,brainchainWorkerBindings.address],name:'brainchain_stream_binding_owner'}).onDelete('restrict'),
  ownerTuple:unique('brainchain_stream_owner_tuple').on(t.bindingId,t.avatarId,t.environment,t.chainId,t.signerAddress),
  keyReference:uniqueIndex('brainchain_stream_key_reference').on(t.signerRef),
  values:check('brainchain_stream_values',sql`${t.environment}='testnet' AND ${t.chainId}=274630 AND ${t.generation}>0 AND ${t.nextNonce} BETWEEN 0 AND 18446744073709551615 AND ${t.signerRef} ~ '^brainchain-testnet:[a-zA-Z0-9_-]{1,96}$'`),
}));

export const brainchainSignerAuthorities=pgTable('brainchain_signer_authorities',{
  authorityPolicyVersion:varchar('authority_policy_version',{length:64}),authorityPolicyDigest:varchar('authority_policy_digest',{length:64}),
  id:uuid('id').primaryKey().defaultRandom(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),signerAddress:varchar('signer_address',{length:42}).notNull(),
  generation:integer('generation').notNull(),purpose:varchar('purpose',{length:24}).notNull(),requestHash:varchar('request_hash',{length:64}).notNull(),
  maxAtomic:numeric('max_atomic',{precision:78,scale:0}).notNull(),approvedBy:varchar('approved_by',{length:128}).notNull(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),revokedAt:timestamp('revoked_at',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
  observationPolicy:varchar('observation_policy',{length:40}).notNull().default('legacy-depth12-age120-v1'),
},t=>({
  configuredPair:check('brainchain_signer_authorities_configured_pair',sql`(${t.authorityPolicyVersion} IS NULL AND ${t.authorityPolicyDigest} IS NULL) OR (${t.authorityPolicyVersion} IS NOT NULL AND ${t.authorityPolicyDigest} IS NOT NULL AND ${t.authorityPolicyVersion}='brainchain-testnet-configured-authority-v1' AND ${t.authorityPolicyDigest}='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6')`),
  observation:check('brainchain_signer_authorities_observation_policy',sql`${t.observationPolicy} IN ('legacy-depth12-age120-v1','nitro-testnet-latest-v1')`),
  owner:foreignKey({columns:[t.bindingId,t.avatarId,t.environment,t.chainId,t.signerAddress],foreignColumns:[brainchainSignerStreams.bindingId,brainchainSignerStreams.avatarId,brainchainSignerStreams.environment,brainchainSignerStreams.chainId,brainchainSignerStreams.signerAddress],name:'brainchain_authority_stream_owner'}).onDelete('restrict'),
  ownerTuple:unique('brainchain_authority_owner_tuple').on(t.id,t.bindingId,t.avatarId,t.environment,t.chainId,t.signerAddress),
  policyOwner:unique('brainchain_signer_policy_owner').on(t.id,t.bindingId,t.avatarId),
  observationOwner:unique('brainchain_signer_observation_owner').on(t.id,t.observationPolicy),
  values:check('brainchain_authority_values',sql`${t.generation}>0 AND ${t.purpose} IN ('result-signature','gas','faucet','approve-stake','approve-bond','stake','apply','leave','withdraw','submit') AND ${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.maxAtomic} BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND ${t.expiresAt}>${t.createdAt} AND ${t.expiresAt}<=${t.createdAt}+interval '1 day'`),
}));

export const brainchainSignerOperations=pgTable('brainchain_signer_operations',{
  authorityPolicyVersion:varchar('authority_policy_version',{length:64}),authorityPolicyDigest:varchar('authority_policy_digest',{length:64}),
  id:uuid('id').primaryKey().defaultRandom(),bindingId:uuid('binding_id').notNull(),avatarId:uuid('avatar_id').notNull(),environment:varchar('environment',{length:8}).notNull(),chainId:integer('chain_id').notNull(),signerAddress:varchar('signer_address',{length:42}).notNull(),
  authorityId:uuid('authority_id').notNull(),gasAuthorityId:uuid('gas_authority_id').notNull(),generation:integer('generation').notNull(),
  kind:varchar('kind',{length:24}).notNull(),idempotencyKey:varchar('idempotency_key',{length:96}).notNull(),requestHash:varchar('request_hash',{length:64}).notNull(),intent:jsonb('intent').notNull(),
  state:varchar('state',{length:16}).notNull().default('prepared'),nonce:numeric('nonce',{precision:20,scale:0}),
  gasLimit:numeric('gas_limit',{precision:78,scale:0}).notNull(),maxFeePerGas:numeric('max_fee_per_gas',{precision:78,scale:0}).notNull(),maxPriorityFeePerGas:numeric('max_priority_fee_per_gas',{precision:78,scale:0}).notNull(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),signedPayloadRef:varchar('signed_payload_ref',{length:64}),transactionHash:varchar('transaction_hash',{length:66}),acceptedAt:timestamp('accepted_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
  observationPolicy:varchar('observation_policy',{length:40}).notNull().default('legacy-depth12-age120-v1'),
},t=>({
  configuredPair:check('brainchain_signer_operations_configured_pair',sql`(${t.authorityPolicyVersion} IS NULL AND ${t.authorityPolicyDigest} IS NULL) OR (${t.authorityPolicyVersion} IS NOT NULL AND ${t.authorityPolicyDigest} IS NOT NULL AND ${t.authorityPolicyVersion}='brainchain-testnet-configured-authority-v1' AND ${t.authorityPolicyDigest}='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6')`),
  observation:check('brainchain_signer_operations_observation_policy',sql`${t.observationPolicy} IN ('legacy-depth12-age120-v1','nitro-testnet-latest-v1')`),
  authority:foreignKey({columns:[t.authorityId,t.bindingId,t.avatarId,t.environment,t.chainId,t.signerAddress],foreignColumns:[brainchainSignerAuthorities.id,brainchainSignerAuthorities.bindingId,brainchainSignerAuthorities.avatarId,brainchainSignerAuthorities.environment,brainchainSignerAuthorities.chainId,brainchainSignerAuthorities.signerAddress],name:'brainchain_operation_intent_owner'}).onDelete('restrict'),
  gasAuthority:foreignKey({columns:[t.gasAuthorityId,t.bindingId,t.avatarId,t.environment,t.chainId,t.signerAddress],foreignColumns:[brainchainSignerAuthorities.id,brainchainSignerAuthorities.bindingId,brainchainSignerAuthorities.avatarId,brainchainSignerAuthorities.environment,brainchainSignerAuthorities.chainId,brainchainSignerAuthorities.signerAddress],name:'brainchain_operation_gas_owner'}).onDelete('restrict'),
  idempotency:uniqueIndex('brainchain_operation_idempotency').on(t.bindingId,t.kind,t.idempotencyKey),
  resultOwner:unique('brainchain_operation_result_owner').on(t.id,t.bindingId,t.avatarId,t.environment,t.chainId),
  receiptOwner:unique('brainchain_operation_receipt_owner').on(t.id,t.generation,t.transactionHash),
  observationIntent:foreignKey({name:'brainchain_operation_observation_intent',columns:[t.authorityId,t.observationPolicy],foreignColumns:[brainchainSignerAuthorities.id,brainchainSignerAuthorities.observationPolicy]}),
  observationGas:foreignKey({name:'brainchain_operation_observation_gas',columns:[t.gasAuthorityId,t.observationPolicy],foreignColumns:[brainchainSignerAuthorities.id,brainchainSignerAuthorities.observationPolicy]}),
  oneIntent:uniqueIndex('brainchain_operation_intent_once').on(t.authorityId),oneGas:uniqueIndex('brainchain_operation_gas_once').on(t.gasAuthorityId),
  nonce:uniqueIndex('brainchain_operation_nonce').on(t.chainId,t.signerAddress,t.nonce),
  hash:uniqueIndex('brainchain_operation_transaction_hash').on(t.chainId,t.transactionHash),
  values:check('brainchain_operation_values',sql`${t.generation}>0 AND ${t.authorityId}<>${t.gasAuthorityId} AND ${t.kind} IN ('faucet','approve-stake','approve-bond','stake','apply','leave','withdraw','submit') AND ${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.idempotencyKey} ~ '^[a-zA-Z0-9_-]{1,96}$' AND ${t.state} IN ('prepared','reserved','accepting','signed','broadcast','confirmed','uncertain','rejected') AND ${t.gasLimit}>0 AND ${t.maxFeePerGas}>0 AND ${t.maxPriorityFeePerGas}>=0 AND ${t.maxPriorityFeePerGas}<=${t.maxFeePerGas} AND (${t.nonce} IS NULL OR ${t.nonce} BETWEEN 0 AND 18446744073709551615) AND ${t.expiresAt}>${t.createdAt}`),
  capture:check('brainchain_operation_capture',sql`((${t.state}='prepared' AND ${t.nonce} IS NULL) OR ${t.state}='rejected' OR (${t.state} IN ('reserved','accepting','signed','broadcast','confirmed','uncertain') AND ${t.nonce} IS NOT NULL)) AND ((${t.signedPayloadRef} IS NULL AND ${t.transactionHash} IS NULL AND ((${t.acceptedAt} IS NULL AND ${t.state} IN ('prepared','reserved','rejected','uncertain')) OR (${t.acceptedAt} IS NOT NULL AND ${t.state} IN ('accepting','uncertain') AND ${t.acceptedAt}>=${t.createdAt}))) OR (${t.signedPayloadRef} IS NOT NULL AND ${t.transactionHash} IS NOT NULL AND ${t.acceptedAt} IS NOT NULL AND ${t.state} IN ('signed','broadcast','confirmed','uncertain') AND ${t.acceptedAt}>=${t.createdAt} AND ${t.signedPayloadRef} ~ '^[a-f0-9]{64}$' AND ${t.transactionHash} ~ '^0x[a-f0-9]{64}$'))`),
}));
