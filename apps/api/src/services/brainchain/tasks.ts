import { randomUUID } from 'node:crypto';
import { and, brainchainWorkerBindings as bindings, brainchainWorkerTasks as tasks, brainchainTaskAttempts as attempts, brainchainIndexCursors as cursors, db, eq, sql } from '@clawville/database';
import { pad, type Address } from 'viem';
import { z } from 'zod';
import { BRAINCHAIN_CONTRACTS, type BrainChainEnvironment } from './contracts';
import { BrainChainBindingError } from './bindings';
import { manifestHash, rpcHash } from './chain-client';

export class BrainChainTaskError extends Error { readonly code = 'task_state_conflict'; }
const observationSchema = z.object({
  boardAddress: z.string().regex(/^0x[0-9a-f]{40}$/), taskId: z.string().regex(/^\d{1,78}$/).refine(value=>BigInt(value)<2n**256n), model: rpcHash,
  hireBlock: z.bigint().nonnegative(), hireBlockHash: rpcHash, hireTxHash: rpcHash, hireLogIndex: z.number().int().nonnegative().max(2147483647),
  observedBlock: z.bigint().nonnegative(), observedBlockHash: rpcHash,
  status: z.number().int().min(1).max(9), bountyAtomic: z.string().regex(/^\d{1,39}$/).refine(value=>BigInt(value)<2n**128n), deadlineUnix: z.bigint().nonnegative(),
  briefHash: rpcHash, resultHash: rpcHash,
}).strict();
export type WorkerTaskObservation = z.infer<typeof observationSchema>;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function ownedWorker(avatarId: string, workerId: string) {
  const [worker] = await db.select().from(bindings).where(and(eq(bindings.id,workerId),eq(bindings.avatarId,avatarId)));
  if (!worker) throw new BrainChainBindingError('worker_not_found');
  if (!(worker.environment in BRAINCHAIN_CONTRACTS)) throw new BrainChainTaskError('Unsupported network');
  return worker;
}
export function workerModel(address: string) { return pad(address as Address,{size:32}).toLowerCase(); }

async function lockWorker(tx: Transaction, workerId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-index:${workerId}`},0))`);
}
async function recordObservation(tx: Transaction, worker: typeof bindings.$inferSelect, input: WorkerTaskObservation) {
  const observed = observationSchema.parse(input);
  const environment = worker.environment as BrainChainEnvironment;
  if (!BRAINCHAIN_CONTRACTS[environment].boards.some((board)=>board.address===observed.boardAddress)
    || workerModel(worker.address)!==observed.model.toLowerCase() || observed.observedBlock<observed.hireBlock) {
    throw new BrainChainTaskError('Observation does not match worker');
  }
  const { model: _model,...values } = observed;
  const [row] = await tx.insert(tasks).values({ ...values, bindingId:worker.id,avatarId:worker.avatarId,
    environment,chainId:worker.chainId,manifestHash:manifestHash(environment),canonical:true,
  }).onConflictDoUpdate({target:[tasks.chainId,tasks.boardAddress,tasks.taskId],set:{
    ...values,canonical:true,updatedAt:sql`clock_timestamp()`,
    leaseGeneration:sql`CASE WHEN ${tasks.hireBlockHash}<>${observed.hireBlockHash} OR ${tasks.hireTxHash}<>${observed.hireTxHash} OR ${tasks.hireLogIndex}<>${observed.hireLogIndex} THEN ${tasks.leaseGeneration}+1 ELSE ${tasks.leaseGeneration} END`,
  },setWhere:sql`${tasks.bindingId}=${worker.id} AND ${tasks.avatarId}=${worker.avatarId} AND ${tasks.observedBlock}<=${observed.observedBlock}`}).returning();
  if (!row) throw new BrainChainTaskError('Task ownership or observation changed');
  await tx.update(attempts).set({state:'suspended',updatedAt:sql`clock_timestamp()`})
    .where(and(eq(attempts.taskId,row.id),sql`${attempts.state} IN ('inspecting','executing')`,sql`${attempts.generation}<>${row.leaseGeneration}`));
  return row;
}

export async function persistIndexBatch(input:{avatarId:string;workerId:string;boardAddress:string;expectedEpoch:number;expectedNext:bigint;nextBlock:bigint;checkpointBlock:bigint;checkpointHash:string;observations:WorkerTaskObservation[];fromBlock:bigint}) {
  const worker=await ownedWorker(input.avatarId,input.workerId);
  return db.transaction(async(tx)=>{
    await lockWorker(tx,worker.id);
    const [cursor]=await tx.select().from(cursors).where(and(eq(cursors.bindingId,worker.id),eq(cursors.boardAddress,input.boardAddress)));
    if ((cursor?.epoch??0)!==input.expectedEpoch || (cursor?.nextBlock ?? input.fromBlock)!==input.expectedNext) throw new BrainChainTaskError('Indexer cursor changed; retry read');
    for(const observed of input.observations) await recordObservation(tx,worker,observed);
    await tx.insert(cursors).values({bindingId:worker.id,avatarId:worker.avatarId,environment:worker.environment,chainId:worker.chainId,
      boardAddress:input.boardAddress,epoch:input.expectedEpoch+1,nextBlock:input.nextBlock,checkpointBlock:input.checkpointBlock,checkpointHash:input.checkpointHash,
    }).onConflictDoUpdate({target:[cursors.bindingId,cursors.boardAddress],set:{epoch:input.expectedEpoch+1,nextBlock:input.nextBlock,checkpointBlock:input.checkpointBlock,checkpointHash:input.checkpointHash,updatedAt:sql`clock_timestamp()`}});
  });
}

/** Orphaning never releases task identity or ownership. All old lease generations become unusable. */
export async function suspendOrphanedBoard(avatarId:string,workerId:string,boardAddress:string,rewind:bigint) {
  const worker=await ownedWorker(avatarId,workerId);
  const board=BRAINCHAIN_CONTRACTS[worker.environment as BrainChainEnvironment].boards.find((entry)=>entry.address===boardAddress);
  if (!board || rewind!==BigInt(board.fromBlock)) throw new BrainChainTaskError('Invalid rewind');
  await db.transaction(async(tx)=>{
    await lockWorker(tx,workerId);
    await tx.update(tasks).set({canonical:false,leaseGeneration:sql`${tasks.leaseGeneration}+1`,updatedAt:sql`clock_timestamp()`})
      .where(and(eq(tasks.bindingId,workerId),eq(tasks.boardAddress,boardAddress)));
    await tx.execute(sql`UPDATE brainchain_task_attempts SET state='suspended',updated_at=clock_timestamp()
      WHERE task_id IN (SELECT id FROM brainchain_worker_tasks WHERE binding_id=${workerId}::uuid AND board_address=${boardAddress}) AND state IN ('inspecting','executing')`);
    await tx.insert(cursors).values({bindingId:workerId,avatarId:worker.avatarId,environment:worker.environment,chainId:worker.chainId,
      boardAddress,epoch:1,nextBlock:rewind,checkpointBlock:null,checkpointHash:null})
      .onConflictDoUpdate({target:[cursors.bindingId,cursors.boardAddress],set:{epoch:sql`${cursors.epoch}+1`,nextBlock:rewind,checkpointBlock:null,checkpointHash:null,updatedAt:sql`clock_timestamp()`}});
  });
}

export async function listWorkerTasks(avatarId:string,workerId:string) {
  await ownedWorker(avatarId,workerId);
  const rows=await db.select().from(tasks).where(and(eq(tasks.bindingId,workerId),eq(tasks.avatarId,avatarId))).orderBy(sql`${tasks.hireBlock} DESC`).limit(100);
  return rows.map((row)=>({id:row.id,boardAddress:row.boardAddress,taskId:row.taskId,status:row.status,bountyAtomic:row.bountyAtomic,
    deadlineUnix:row.deadlineUnix.toString(),canonical:row.canonical,observedBlock:row.observedBlock.toString(),observedBlockHash:row.observedBlockHash,
    hireBlock:row.hireBlock.toString(),hireBlockHash:row.hireBlockHash,hireTransaction:row.hireTxHash,hireLogIndex:row.hireLogIndex,
    briefHash:row.briefHash,resultHash:row.resultHash,updatedAt:row.updatedAt.toISOString(),provisional:true as const}));
}

/** Internal recovery bookkeeping only. This lease cannot run cognition, submit results, or authorize a signer. */
export async function claimRecoveryAttempt(avatarId:string,taskId:string) {
  return db.transaction(async(tx)=>{
    const selected=await tx.select().from(tasks).where(and(eq(tasks.id,taskId),eq(tasks.avatarId,avatarId))).for('update');
    const task=selected[0]; if(!task || !task.canonical) throw new BrainChainTaskError('Task is unavailable for recovery');
    const live=await tx.select({id:attempts.id}).from(attempts).where(and(eq(attempts.taskId,taskId),sql`${attempts.state} IN ('inspecting','executing') AND ${attempts.leaseUntil}>clock_timestamp()`));
    if(live.length) throw new BrainChainTaskError('Task recovery is already leased');
    await tx.update(attempts).set({state:'expired',updatedAt:sql`clock_timestamp()`}).where(and(eq(attempts.taskId,taskId),sql`${attempts.state} IN ('inspecting','executing')`));
    const [last]=await tx.select({number:sql<number>`COALESCE(MAX(${attempts.attemptNumber}),0)::integer`}).from(attempts).where(eq(attempts.taskId,taskId));
    const generation=task.leaseGeneration+1;
    await tx.update(tasks).set({leaseGeneration:generation}).where(eq(tasks.id,taskId));
    const [attempt]=await tx.insert(attempts).values({taskId,bindingId:task.bindingId,avatarId,environment:task.environment,chainId:task.chainId,
      attemptNumber:(last?.number??0)+1,generation,leaseOwner:randomUUID(),purpose:'recovery',state:'inspecting',
      createdAt:sql`clock_timestamp()`,leaseUntil:sql`clock_timestamp()+interval '60 seconds'`,
    }).returning();
    return attempt!;
  });
}
export async function finishRecoveryAttempt(input:{avatarId:string;attemptId:string;leaseOwner:string;generation:number;outputHash:string}) {
  if(!/^[a-f0-9]{64}$/.test(input.outputHash)) throw new BrainChainTaskError('Invalid output digest');
  await db.transaction(async(tx)=>{
    const [attempt]=await tx.select().from(attempts).where(and(eq(attempts.id,input.attemptId),eq(attempts.avatarId,input.avatarId)));
    if(!attempt) throw new BrainChainTaskError('Recovery lease is stale');
    const [task]=await tx.select().from(tasks).where(eq(tasks.id,attempt.taskId)).for('update');
    if(!task?.canonical || task.leaseGeneration!==input.generation) throw new BrainChainTaskError('Recovery lease is stale');
    const rows=await tx.execute(sql`UPDATE brainchain_task_attempts SET state='reconciled',output_hash=${input.outputHash},updated_at=clock_timestamp()
      WHERE id=${input.attemptId}::uuid AND avatar_id=${input.avatarId}::uuid AND lease_owner=${input.leaseOwner}::uuid
      AND generation=${input.generation} AND state='inspecting' AND lease_until>clock_timestamp() RETURNING id`);
    if(rows.length!==1) throw new BrainChainTaskError('Recovery lease is stale');
  });
}
