import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Real isolated PostgreSQL evidence. Run separately with BRAINCHAIN_DB_FIXTURE=1. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { BRAINCHAIN_CONTRACTS } from './contracts';
import type { WorkerTaskObservation } from './tasks';

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('BrainChain real task ownership and recovery',()=>{
  let fixture:ReturnType<typeof postgres>;
  let service:typeof import('./tasks');
  const avatar=randomUUID(),foreign=randomUUID(),worker=randomUUID();
  const address=`0x${randomBytes(20).toString('hex')}`;
  const board=BRAINCHAIN_CONTRACTS.testnet.boards[0]!;
  const hash=`0x${'a'.repeat(64)}`;
  const taskNumber=BigInt(`0x${randomBytes(12).toString('hex')}`).toString();
  const prior=process.env.DATABASE_URL;
  let rowId:string;
  let observation:WorkerTaskObservation;
  async function refuse(operation:()=>PromiseLike<unknown>){try{await operation();return 'success';}catch(error){return String(error);}}
  beforeAll(async()=>{
    const root=resolve(import.meta.dir,'../../../../..');
    const settings=await getBrainchainFixtureSettings();
    fixture=postgres({...settings.options,max:12,onnotice:()=>{}});
    for(const name of ['0101_brainchain_worker_bindings.sql','0102_brainchain_task_observations.sql']) {
      const migration=await readFile(resolve(root,'packages/database/migrations',name),'utf8');
      await fixture.unsafe(migration);await fixture.unsafe(migration);
    }
    await fixture`INSERT INTO avatars(id) VALUES(${avatar}),(${foreign})`;
    await fixture`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash)
      VALUES(${worker},${avatar},'testnet',274630,${address},${'b'.repeat(64)})`;
    process.env.DATABASE_URL=settings.url;
    service=await import('./tasks');
    observation={boardAddress:board.address,taskId:taskNumber,model:service.workerModel(address),hireBlock:BigInt(board.fromBlock),hireBlockHash:hash,
      hireTxHash:hash,hireLogIndex:0,observedBlock:5000n,observedBlockHash:hash,status:2,bountyAtomic:'1000000',deadlineUnix:2000000000n,briefHash:hash,resultHash:hash};
  });
  afterAll(async()=>{await fixture?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;});
  async function ingest(owner:string,id:string,observations:WorkerTaskObservation[]){
    const [cursor]=await fixture`SELECT epoch,next_block FROM brainchain_index_cursors WHERE binding_id=${id} AND board_address=${board.address}`;
    const next=cursor?BigInt(cursor.next_block):BigInt(board.fromBlock);
    await service.persistIndexBatch({avatarId:owner,workerId:id,boardAddress:board.address,expectedEpoch:cursor?.epoch??0,expectedNext:next,nextBlock:next,
      checkpointBlock:5000n,checkpointHash:hash,observations,fromBlock:BigInt(board.fromBlock)});
    return service.listWorkerTasks(owner,id);
  }
  test('duplicate event ingestion preserves one immutable owner and rejects stale state',async()=>{
    const races=await Promise.allSettled(Array.from({length:6},()=>ingest(avatar,worker,[observation])));
    const results=races.filter(result=>result.status==='fulfilled').map(result=>result.value);
    rowId=results[0]![0]!.id;
    expect(new Set(results.map(rows=>rows[0]!.id)).size).toBe(1);
    expect((await fixture`SELECT id FROM brainchain_worker_tasks WHERE chain_id=274630 AND board_address=${board.address} AND task_id=${taskNumber}`).length).toBe(1);
    expect(await refuse(()=>ingest(foreign,worker,[observation]))).toContain('worker_not_found');
    expect(await refuse(()=>ingest(avatar,worker,[{...observation,observedBlock:4999n}]))).toContain('observation changed');
    expect(await refuse(()=>fixture`UPDATE brainchain_worker_tasks SET avatar_id=${foreign} WHERE id=${rowId}`)).toContain('immutable');
    expect(await refuse(()=>fixture`UPDATE brainchain_worker_bindings SET avatar_id=${foreign} WHERE id=${worker}`)).toContain('immutable');
  });
  test('concurrent claims have one owner and previous owners cannot finish',async()=>{
    const claims=await Promise.allSettled(Array.from({length:8},()=>service.claimRecoveryAttempt(avatar,rowId)));
    const winners=claims.filter(result=>result.status==='fulfilled');
    expect(winners).toHaveLength(1);
    const first=winners[0]!.value;
    expect(await refuse(()=>service.finishRecoveryAttempt({avatarId:avatar,attemptId:first.id,leaseOwner:randomUUID(),generation:first.generation,outputHash:'a'.repeat(64)}))).toContain('stale');
    await service.finishRecoveryAttempt({avatarId:avatar,attemptId:first.id,leaseOwner:first.leaseOwner,generation:first.generation,outputHash:'a'.repeat(64)});
    const second=await service.claimRecoveryAttempt(avatar,rowId);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.attemptNumber).toBe(first.attemptNumber+1);
    expect(await refuse(()=>service.finishRecoveryAttempt({avatarId:avatar,attemptId:first.id,leaseOwner:first.leaseOwner,generation:first.generation,outputHash:'a'.repeat(64)}))).toContain('stale');
    await service.finishRecoveryAttempt({avatarId:avatar,attemptId:second.id,leaseOwner:second.leaseOwner,generation:second.generation,outputHash:'b'.repeat(64)});
    expect((await fixture`SELECT state FROM brainchain_task_attempts WHERE id=${second.id}`)[0]!.state).toBe('reconciled');
  });
  test('composite foreign keys forbid foreign attempts and cursors',async()=>{
    expect(await refuse(()=>fixture`INSERT INTO brainchain_task_attempts(task_id,binding_id,avatar_id,environment,chain_id,attempt_number,generation,lease_owner,lease_until)
      VALUES(${rowId},${worker},${foreign},'testnet',274630,100,100,${randomUUID()},clock_timestamp()+interval '1 minute')`)).toContain('brainchain_attempt_task_owner');
    expect(await refuse(()=>fixture`INSERT INTO brainchain_index_cursors(binding_id,avatar_id,environment,chain_id,board_address,next_block)
      VALUES(${worker},${foreign},'testnet',274630,${BRAINCHAIN_CONTRACTS.testnet.boards[1]!.address},0)`)).toContain('brainchain_cursor_binding_owner');
    expect(await refuse(()=>fixture`UPDATE brainchain_index_cursors SET checkpoint_block=NULL,checkpoint_hash=${hash} WHERE binding_id=${worker}`)).toContain('brainchain_cursor_values');
    expect(await refuse(()=>fixture`UPDATE brainchain_worker_tasks SET bounty_atomic=${(2n**128n).toString()} WHERE id=${rowId}`)).toContain('brainchain_task_values');
    expect(await refuse(()=>fixture`UPDATE brainchain_worker_tasks SET task_id=${(2n**256n).toString()} WHERE id=${rowId}`)).not.toBe('success');
  });
  test('reorg suspension fences leases, preserves attribution, and rewinds cursor',async()=>{
    const [before]=await fixture`SELECT epoch FROM brainchain_index_cursors WHERE binding_id=${worker} AND board_address=${board.address}`;
    const priorEpoch=before!.epoch;
    await service.persistIndexBatch({avatarId:avatar,workerId:worker,boardAddress:board.address,expectedEpoch:priorEpoch,expectedNext:BigInt(board.fromBlock),nextBlock:5001n,
      checkpointBlock:5000n,checkpointHash:hash,observations:[observation],fromBlock:BigInt(board.fromBlock)});
    const lease=await service.claimRecoveryAttempt(avatar,rowId);
    await service.suspendOrphanedBoard(avatar,worker,board.address,BigInt(board.fromBlock));
    const [task]=await fixture`SELECT * FROM brainchain_worker_tasks WHERE id=${rowId}`;
    expect(task!.canonical).toBe(false);expect(task!.avatar_id).toBe(avatar);expect(task!.binding_id).toBe(worker);
    expect(await refuse(()=>service.claimRecoveryAttempt(avatar,rowId))).toContain('unavailable');
    expect(await refuse(()=>service.finishRecoveryAttempt({avatarId:avatar,attemptId:lease.id,leaseOwner:lease.leaseOwner,generation:lease.generation,outputHash:'c'.repeat(64)}))).toContain('stale');
    const [cursor]=await fixture`SELECT * FROM brainchain_index_cursors WHERE binding_id=${worker}`;
    expect(String(cursor!.next_block)).toBe(String(board.fromBlock));expect(cursor!.checkpoint_hash).toBeNull();
    expect(cursor!.epoch).toBeGreaterThan(priorEpoch);
    expect(await refuse(()=>service.persistIndexBatch({avatarId:avatar,workerId:worker,boardAddress:board.address,expectedEpoch:priorEpoch,expectedNext:BigInt(board.fromBlock),nextBlock:5001n,
      checkpointBlock:5000n,checkpointHash:hash,observations:[observation],fromBlock:BigInt(board.fromBlock)}))).toContain('cursor changed');
    expect((await fixture`SELECT canonical FROM brainchain_worker_tasks WHERE id=${rowId}`)[0]!.canonical).toBe(false);
    const [restored]=await ingest(avatar,worker,[{...observation,observedBlock:5001n,hireBlockHash:`0x${'d'.repeat(64)}`}]);
    expect(restored!.id).toBe(rowId);expect((await fixture`SELECT avatar_id FROM brainchain_worker_tasks WHERE id=${rowId}`)[0]!.avatar_id).toBe(avatar);expect(restored!.canonical).toBe(true);
  });
  test('suspension before the first cursor persists a nonzero epoch',async()=>{
    const retired=BRAINCHAIN_CONTRACTS.testnet.boards[1]!;
    await service.suspendOrphanedBoard(avatar,worker,retired.address,BigInt(retired.fromBlock));
    expect(await refuse(()=>service.persistIndexBatch({avatarId:avatar,workerId:worker,boardAddress:retired.address,expectedEpoch:0,expectedNext:BigInt(retired.fromBlock),nextBlock:5001n,
      checkpointBlock:5000n,checkpointHash:hash,observations:[],fromBlock:BigInt(retired.fromBlock)}))).toContain('cursor changed');
  });
  test('actual indexer detects a changed checkpoint before ingestion',async()=>{
    for(const entry of BRAINCHAIN_CONTRACTS.testnet.boards){
      await fixture`INSERT INTO brainchain_index_cursors(binding_id,avatar_id,environment,chain_id,board_address,next_block,checkpoint_block,checkpoint_hash)
        VALUES(${worker},${avatar},'testnet',274630,${entry.address},5001,5000,${hash})
        ON CONFLICT(binding_id,board_address) DO UPDATE SET next_block=5001,checkpoint_block=5000,checkpoint_hash=${hash},updated_at=clock_timestamp()`;
    }
    await fixture`UPDATE brainchain_index_cursors SET updated_at=clock_timestamp()-interval '1 day' WHERE binding_id=${worker} AND board_address=${board.address}`;
    const {syncOwnedWorker}=await import('./indexer');
    const changed=`0x${'f'.repeat(64)}`;
    const at={number:'0x1770',hash:changed,timestamp:'0x6553f100'};
    let logReads=0;
    const reader={stableBlock:async()=>at,assertCode:async()=>{},assertChain:async()=>{},block:async(number:bigint)=>({...at,number:`0x${number.toString(16)}`}),
      hiredLogs:async()=>{logReads++;return[];},snapshot:async()=>{throw Error('unused');},task:async()=>{throw Error('unused');}};
    expect(await syncOwnedWorker(avatar,worker,reader)).toMatchObject({state:'reorg_suspended',provisional:true});
    expect(logReads).toBe(0);
    expect((await fixture`SELECT canonical FROM brainchain_worker_tasks WHERE id=${rowId}`)[0]!.canonical).toBe(false);
  });
});
