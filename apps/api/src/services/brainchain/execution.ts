import {assertPersistedConfiguredAuthority,observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {assertConfiguredAuthorityEvidence} from './configured-authority';
import {createHash,randomUUID} from 'node:crypto';
import {keccak256,toBytes} from 'viem';
import {z} from 'zod';
import {and,db,eq,sql,brainchainWorkerTasks as tasks,brainchainWorkerBindings as bindings,brainchainTaskAttempts as attempts,brainchainExecutionAuthorities as authorities} from '@clawville/database';
import {BrainChainTaskError} from './tasks';
import {LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY,observationPolicyOf,workerObservationFresh} from './worker-observation-policy';

const digest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const inputSchema=z.object({avatarId:z.string().uuid(),taskId:z.string().uuid(),authorityId:z.string().uuid(),
  brief:z.string().min(1).max(16384).refine(value=>Buffer.byteLength(value)<=16384),
  prompt:z.string().min(1).max(32768).refine(value=>Buffer.byteLength(value)<=32768),
  observation:z.object({authorityPolicyVersion:z.string().optional(),authorityPolicyDigest:z.string().optional(),observedAt:z.date(),blockTimestamp:z.bigint().nonnegative(),blockNumber:z.bigint().nonnegative(),blockHash:z.string().regex(/^0x[a-f0-9]{64}$/),observationPolicy:z.enum([LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY]).optional()}).strict(),
}).strict();
export type ExecutionAdmission=z.infer<typeof inputSchema>;

/** Internal trusted coordinator only. A root-issued row approves one exact input and prompt, never retries or spend. */
export async function claimExecutionAttempt(raw:ExecutionAdmission,authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){
  const input=inputSchema.parse(raw),inputHash=digest(input.brief),promptHash=digest(input.prompt),briefHash=keccak256(toBytes(input.brief));
  assertConfiguredAuthorityEvidence(input.observation);
  return db.transaction(async tx=>{
    // Shared with index/reorg. Always acquire this before task and authority rows.
    const [reference]=await tx.select({bindingId:tasks.bindingId}).from(tasks).where(and(eq(tasks.id,input.taskId),eq(tasks.avatarId,input.avatarId)));
    if(!reference)throw new BrainChainTaskError('Execution task is unavailable');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-index:${reference.bindingId}`},0))`);
    const [task]=await tx.select().from(tasks).where(and(eq(tasks.id,input.taskId),eq(tasks.avatarId,input.avatarId))).for('update');
    const [worker]=await tx.select().from(bindings).where(eq(bindings.id,reference.bindingId)).for('update');
    const [authority]=await tx.select().from(authorities).where(eq(authorities.id,input.authorityId)).for('update');
    const currentPolicy=await observeConfiguredAuthority(authorityReader,{deadlineMs:Date.now()+2000,observationPolicy:input.observation.observationPolicy});
    assertConfiguredAuthorityEvidence(currentPolicy);
    if(currentPolicy.blockNumber!==input.observation.blockNumber||currentPolicy.blockHash!==input.observation.blockHash)throw new BrainChainTaskError('Configured authority execution anchor changed');
    const [clock]=await tx.execute<{now:string|Date}>(sql`SELECT clock_timestamp() AS now`);
    const now=new Date(clock!.now),nowMs=now.getTime();
    if(!task?.canonical||task.status!==2||task.environment!=='testnet'||task.chainId!==274630||!worker||worker.requestedState!=='running'
      ||task.observedBlock!==input.observation.blockNumber||task.observedBlockHash!==input.observation.blockHash
      ||!workerObservationFresh(input.observation,now))
      throw new BrainChainTaskError('Fresh running testnet hire required');
    if(!authority||authority.taskId!==task.id||authority.avatarId!==input.avatarId||authority.bindingId!==worker.id||authority.revokedAt||authority.consumedAt
      ||authority.generation!==task.leaseGeneration+1||authority.expiresAt<=now||authority.briefHash!==task.briefHash||briefHash!==task.briefHash
      ||authority.inputHash!==inputHash||authority.promptHash!==promptHash||authority.observationPolicy!==observationPolicyOf(input.observation))
      throw new BrainChainTaskError('Execution authority is unavailable');
    assertPersistedConfiguredAuthority(authority);assertConfiguredAuthorityEvidence(input.observation,now);
    const live=await tx.select({id:attempts.id}).from(attempts).where(and(eq(attempts.taskId,task.id),sql`${attempts.state} IN ('inspecting','executing') AND ${attempts.leaseUntil}>clock_timestamp()`));
    if(live.length)throw new BrainChainTaskError('Task already has a live attempt');
    const deadlineMs=Math.min(authority.expiresAt.getTime(),Number(task.deadlineUnix)*1000,nowMs+60000);
    if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=nowMs)throw new BrainChainTaskError('Execution deadline expired');
    const [last]=await tx.select({number:sql<number>`COALESCE(MAX(${attempts.attemptNumber}),0)::integer`}).from(attempts).where(eq(attempts.taskId,task.id));
    const admitted=await tx.update(authorities).set({consumedAt:sql`clock_timestamp()`}).where(and(eq(authorities.id,authority.id),sql`${authorities.consumedAt} IS NULL AND ${authorities.revokedAt} IS NULL AND ${authorities.expiresAt}>clock_timestamp()`)).returning({id:authorities.id});
    if(admitted.length!==1)throw new BrainChainTaskError('Execution authority expired after locks');
    await tx.update(attempts).set({state:'expired',updatedAt:sql`clock_timestamp()`}).where(and(eq(attempts.taskId,task.id),sql`${attempts.state} IN ('inspecting','executing')`));
    await tx.update(tasks).set({leaseGeneration:authority.generation}).where(eq(tasks.id,task.id));
    const [attempt]=await tx.insert(attempts).values({taskId:task.id,bindingId:worker.id,avatarId:input.avatarId,environment:'testnet',chainId:274630,
      attemptNumber:(last?.number??0)+1,generation:authority.generation,purpose:'execution',state:'executing',leaseOwner:randomUUID(),
      authorityId:authority.id,inputHash,promptHash,createdAt:sql`clock_timestamp()`,leaseUntil:new Date(deadlineMs),
    }).returning();
    return attempt!;
  });
}
