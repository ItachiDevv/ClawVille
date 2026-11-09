import { and, brainchainIndexCursors as cursors, brainchainWorkerTasks as tasks, db, eq, sql } from '@clawville/database';
import { decodeEventLog, type Address, type Hex } from 'viem';
import { createBrainChainReader, workerHireAbi, BrainChainReadError, type ChainBlock,createBrainChainReadRpc,rpcQuantity } from './chain-client';
import {LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY,workerObservationFresh,type WorkerObservationPolicy} from './worker-observation-policy';
import { BRAINCHAIN_CONTRACTS, type BrainChainEnvironment } from './contracts';
import { ownedWorker, persistIndexBatch, suspendOrphanedBoard, workerModel, type WorkerTaskObservation } from './tasks';

type Reader = Omit<ReturnType<typeof createBrainChainReader>, 'paidLogs'>;
class OrphanedHireError extends BrainChainReadError {}
const snapshots = new Map<string,{expires:number;value:Promise<Awaited<ReturnType<Reader['snapshot']>>>}>();
export async function readOwnedWorkerSnapshot(avatarId:string,workerId:string) {
  const worker=await ownedWorker(avatarId,workerId);
  const key=`${worker.environment}:${worker.address}`;
  let cached=snapshots.get(key);
  if(!cached || cached.expires<=Date.now()) {
    if(snapshots.size>=256) snapshots.delete(snapshots.keys().next().value!);
    const value=createBrainChainReader(worker.environment as BrainChainEnvironment).snapshot(worker.address as Address);
    cached={expires:Date.now()+30_000,value};snapshots.set(key,cached);
    // Failures are also cached briefly to prevent a public-RPC outage from amplifying calls.
  }
  return {workerId,...await cached.value};
}

async function taskObservation(reader:Reader,board:Address,taskId:bigint,model:string,at:ChainBlock,hire:{block:bigint;hash:string;tx:string;index:number}):Promise<WorkerTaskObservation> {
  const [value,eventBlock]=await Promise.all([reader.task(board,taskId,at),reader.block(hire.block)]);
  if(value.model.toLowerCase()!==model || eventBlock.hash.toLowerCase()!==hire.hash.toLowerCase()) throw new OrphanedHireError('Task hire no longer matches canonical worker');
  return {boardAddress:board.toLowerCase(),taskId:taskId.toString(),model,
    hireBlock:hire.block,hireBlockHash:hire.hash.toLowerCase(),hireTxHash:hire.tx.toLowerCase(),hireLogIndex:hire.index,
    observedBlock:BigInt(at.number),observedBlockHash:at.hash.toLowerCase(),status:value.status,bountyAtomic:value.bounty.toString(),
    deadlineUnix:value.deadline,briefHash:value.briefHash.toLowerCase(),resultHash:value.resultHash.toLowerCase()};
}

const syncs = new Map<string,Promise<unknown>>();
/** One board, at most 2,000 blocks and 25 new hires per request. No automatic scheduler starts here. */
export async function syncOwnedWorker(avatarId:string,workerId:string,readerOverride?:Reader,policy:WorkerObservationPolicy=LEGACY_WORKER_POLICY) {
  const worker=await ownedWorker(avatarId,workerId);
  const syncKey=`${workerId}:${policy}`;
  const running=syncs.get(syncKey);if(running)return running;
  if(syncs.size>=16) throw new BrainChainReadError('Index capacity reached');
  const work=async()=>{
    const environment=worker.environment as BrainChainEnvironment;
    const manifest=BRAINCHAIN_CONTRACTS[environment];
    const reader=readerOverride??createBrainChainReader(environment);
    const acquiredAt=new Date(Date.now());
    if(policy===WORKER_PROVISIONAL_POLICY&&environment!=='testnet')throw new BrainChainReadError('Worker policy requires testnet');
    const at=policy===WORKER_PROVISIONAL_POLICY?await (async()=>{
      await reader.assertChain();
      const rpc=createBrainChainReadRpc('testnet');
      return reader.block(BigInt(rpcQuantity.parse(await rpc('eth_blockNumber'))));
    })():await reader.stableBlock();
    const stored=await db.select().from(cursors).where(eq(cursors.bindingId,worker.id));
    // Rotate least-recently-scanned boards, including retired contracts with unfinished work.
    const board=[...manifest.boards].sort((a,b)=>{
      const aTime=stored.find((v)=>v.boardAddress===a.address)?.updatedAt.getTime()??0;
      const bTime=stored.find((v)=>v.boardAddress===b.address)?.updatedAt.getTime()??0;
      return aTime-bTime;
    })[0]!;
    const cursor=stored.find((value)=>value.boardAddress===board.address);
    const suspend=async()=>{
      await suspendOrphanedBoard(avatarId,workerId,board.address,BigInt(board.fromBlock));
      return {workerId,boardAddress:board.address,state:'reorg_suspended',provisional:true};
    };
    if(cursor?.checkpointBlock!==null && cursor?.checkpointBlock!==undefined && cursor.checkpointBlock>BigInt(at.number)) return suspend();
    await reader.assertCode(board.address,at);
    if(cursor?.checkpointBlock!==null && cursor?.checkpointBlock!==undefined && cursor.checkpointHash) {
      const canonical=await reader.block(cursor.checkpointBlock);
      if(canonical.hash.toLowerCase()!==cursor.checkpointHash.toLowerCase()) {
        return suspend();
      }
    }
    const from=cursor?.nextBlock??BigInt(board.fromBlock);
    const stable=BigInt(at.number);
    if(from>stable && !cursor) throw new BrainChainReadError('Pinned board is newer than observation block');
    let to=from+1999n<stable?from+1999n:stable;
    const model=workerModel(worker.address);
    let logs=from<=to?await reader.hiredLogs(board.address,model as Hex,from,to):[];
    // Shrink dense ranges instead of dropping events or advancing an incomplete cursor.
    while(logs.length>25 && to>from) {to=from+(to-from)/2n;logs=await reader.hiredLogs(board.address,model as Hex,from,to);}
    if(logs.length>25) throw new BrainChainReadError('Single block exceeds bounded hire batch');
    const observations:WorkerTaskObservation[]=[];
    try {
    for(const log of logs) {
      if(log.removed || log.address.toLowerCase()!==board.address || BigInt(log.blockNumber)<from || BigInt(log.blockNumber)>to) throw new BrainChainReadError('Invalid hire log');
      const decoded=decodeEventLog({abi:workerHireAbi,eventName:'WorkerHired',data:log.data as Hex,topics:log.topics as [Hex,...Hex[]],strict:true});
      if(decoded.args.model.toLowerCase()!==model) throw new BrainChainReadError('Foreign worker log');
      observations.push(await taskObservation(reader,board.address,decoded.args.id,model,at,{block:BigInt(log.blockNumber),hash:log.blockHash,tx:log.transactionHash,index:Number(BigInt(log.logIndex))}));
    }
    // Status changes have no new hire event. Refresh oldest persisted records on every scan.
    const refresh=await db.select().from(tasks).where(and(eq(tasks.bindingId,workerId),eq(tasks.boardAddress,board.address),eq(tasks.canonical,true)))
      .orderBy(sql`${tasks.updatedAt} ASC`).limit(25);
    for(const task of refresh) {
      if(observations.some((value)=>value.taskId===task.taskId))continue;
      observations.push(await taskObservation(reader,board.address,BigInt(task.taskId),model,at,{block:task.hireBlock,hash:task.hireBlockHash,tx:task.hireTxHash,index:task.hireLogIndex}));
    }
    } catch(error) {
      if(error instanceof OrphanedHireError) return suspend();
      throw error;
    }
    const checkpoint=await reader.block(to);
    const final=await reader.block(stable);
    if(final.hash!==at.hash||final.timestamp!==at.timestamp) throw new BrainChainReadError('Observation block changed');
    if(policy===WORKER_PROVISIONAL_POLICY&&!workerObservationFresh({observedAt:acquiredAt,blockTimestamp:BigInt(final.timestamp),observationPolicy:policy}))throw new BrainChainReadError('Worker observation expired');
    await persistIndexBatch({avatarId,workerId,boardAddress:board.address,expectedEpoch:cursor?.epoch??0,expectedNext:from,nextBlock:to>=from?to+1n:from,
      checkpointBlock:to,checkpointHash:checkpoint.hash.toLowerCase(),observations,fromBlock:BigInt(board.fromBlock)});
    return {workerId,boardAddress:board.address,state:'observed',fromBlock:from.toString(),throughBlock:to.toString(),newHires:logs.length,refreshedTasks:observations.length,provisional:true};
  };
  const active=work().finally(()=>{syncs.delete(syncKey);});syncs.set(syncKey,active);return active;
}
