import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Real local PostgreSQL. No cognition, signature, or network call. */
import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {keccak256,toBytes} from 'viem';
import postgres from 'postgres';
import {BRAINCHAIN_CONTRACTS} from './contracts';

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('BrainChain execution authority',()=>{
  let fixture:ReturnType<typeof postgres>,service:typeof import('./execution'),tasks:typeof import('./tasks');
  const prior=process.env.DATABASE_URL,brief='Fixture research brief',prompt='Trusted fixture instructions\nFixture research brief',hash=`0x${'b'.repeat(64)}`;
  const authorityReader=fixtureConfiguredAuthorityReader(hash);
  const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
  async function refusal(fn:()=>PromiseLike<unknown>){try{await fn();return 'success';}catch(error){return String(error);}}
  beforeAll(async()=>{
    const root=resolve(import.meta.dir,'../../../../..');const settings=await getBrainchainFixtureSettings();
    fixture=postgres({...settings.options,max:8,onnotice:()=>{}});
    const migration=await readFile(resolve(root,'packages/database/migrations/0105_brainchain_execution_admission.sql'),'utf8');
    await fixture.unsafe(migration);await fixture.unsafe(migration);
    process.env.DATABASE_URL=settings.url;
    service=await import('./execution');tasks=await import('./tasks');
  });
  afterAll(async()=>{await fixture?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;});
  async function prepared(lifetime=60000,historical=false){
    const avatarId=randomUUID(),bindingId=randomUUID(),taskId=randomUUID(),authorityId=randomUUID(),address=`0x${randomBytes(20).toString('hex')}`;
    const board=BRAINCHAIN_CONTRACTS.testnet.boards[0]!;
    await fixture`INSERT INTO avatars(id) VALUES(${avatarId})`;
    await fixture`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'a'.repeat(64)},'running')`;
    await fixture`INSERT INTO brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id,board_address,task_id,manifest_hash,hire_block,hire_block_hash,hire_tx_hash,hire_log_index,observed_block,observed_block_hash,status,bounty_atomic,deadline_unix,brief_hash,result_hash)
      VALUES(${taskId},${bindingId},${avatarId},'testnet',274630,${board.address},${BigInt('0x'+randomBytes(12).toString('hex')).toString()},${'a'.repeat(64)},${board.fromBlock},${hash},${hash},0,5000,${hash},2,1000000,${Math.floor(Date.now()/1000)+600},${keccak256(toBytes(brief))},${hash})`;
    await fixture`INSERT INTO brainchain_execution_authorities(id,task_id,binding_id,avatar_id,environment,chain_id,generation,brief_hash,input_hash,prompt_hash,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${authorityId},${taskId},${bindingId},${avatarId},'testnet',274630,1,${keccak256(toBytes(brief))},${digest(brief)},${digest(prompt)},'root-fixture',clock_timestamp()+${lifetime}*interval '1 millisecond',${historical?null:CONFIGURED_AUTHORITY_VERSION},${historical?null:CONFIGURED_AUTHORITY_DIGEST})`;
    return{bindingId,board,input:{avatarId,taskId,authorityId,brief,prompt,observation:await authorityReader({deadlineMs:Date.now()+2000})}};
  }
  test('historical NULL policy remains unconsumed despite fresh matching chain evidence',async()=>{
    const {input}=await prepared(60000,true);
    expect(await refusal(()=>service.claimExecutionAttempt(input,authorityReader))).toContain('Current configured authority policy required');
    const [row]=await fixture`SELECT consumed_at,authority_policy_version,authority_policy_digest FROM brainchain_execution_authorities WHERE id=${input.authorityId}`;
    expect(row!.consumed_at).toBeNull();expect(row!.authority_policy_version).toBeNull();expect(row!.authority_policy_digest).toBeNull();
    expect((await fixture`SELECT id FROM brainchain_task_attempts WHERE task_id=${input.taskId}`).length).toBe(0);
  });
  test('a hung configured reader releases task and authority locks within the consumer deadline',async()=>{
    const {input}=await prepared();let signal:AbortSignal|undefined,entered=false;
    const start=Date.now();
    const failure=await refusal(()=>service.claimExecutionAttempt(input,async limits=>{
      entered=true;signal=limits.signal;return await new Promise<never>(()=>{});
    }));
    expect(failure).toContain('Configured authority consumer canceled');
    expect(entered).toBe(true);expect(signal?.aborted).toBe(true);expect(Date.now()-start).toBeLessThan(3000);
    // A separate fixture connection must acquire both locks after the Drizzle transaction refuses.
    await fixture.begin(async tx=>{
      expect((await tx`SELECT id FROM brainchain_worker_tasks WHERE id=${input.taskId} FOR UPDATE NOWAIT`).length).toBe(1);
      const [row]=await tx`SELECT consumed_at FROM brainchain_execution_authorities WHERE id=${input.authorityId} FOR UPDATE NOWAIT`;
      expect(row!.consumed_at).toBeNull();
    });
    expect((await fixture`SELECT id FROM brainchain_task_attempts WHERE task_id=${input.taskId}`).length).toBe(0);
  });
  test('concurrent admission consumes one authority and freezes exact prompt and lease',async()=>{
    const {input}=await prepared();
    expect(await refusal(()=>service.claimExecutionAttempt({...input,prompt:prompt+'changed'},authorityReader))).toContain('authority');
    const results=await Promise.allSettled(Array.from({length:6},()=>service.claimExecutionAttempt(input,authorityReader)));
    const winners=results.filter(value=>value.status==='fulfilled');expect(winners).toHaveLength(1);
    const attempt=winners[0]!.value;
    expect(attempt.purpose).toBe('execution');expect(attempt.state).toBe('executing');expect(attempt.promptHash).toBe(digest(prompt));
    expect(await refusal(()=>fixture`UPDATE brainchain_task_attempts SET lease_until=lease_until+interval '1 minute' WHERE id=${attempt.id}`)).toContain('immutable');
    expect(await refusal(()=>fixture`UPDATE brainchain_execution_authorities SET expires_at=expires_at+interval '1 minute' WHERE id=${input.authorityId}`)).toContain('immutable');
    expect(await refusal(()=>tasks.claimRecoveryAttempt(input.avatarId,input.taskId))).toContain('leased');
  });
  test('reorg suspends execution and the consumed authority cannot create a retry',async()=>{
    const {input,bindingId,board}=await prepared();const attempt=await service.claimExecutionAttempt(input,authorityReader);
    await tasks.suspendOrphanedBoard(input.avatarId,bindingId,board.address,BigInt(board.fromBlock));
    expect((await fixture`SELECT state FROM brainchain_task_attempts WHERE id=${attempt.id}`)[0]!.state).toBe('suspended');
    expect(await refusal(()=>service.claimExecutionAttempt(input,authorityReader))).toContain('Fresh running testnet');
    expect((await fixture`SELECT consumed_at FROM brainchain_execution_authorities WHERE id=${input.authorityId}`)[0]!.consumed_at).not.toBeNull();
  });
  test('stale evidence and pause refuse without consuming authority',async()=>{
    const {input,bindingId}=await prepared();
    expect(await refusal(()=>service.claimExecutionAttempt({...input,observation:{...input.observation,blockTimestamp:input.observation.blockTimestamp-121n}},authorityReader))).toContain('Fresh configured authority');
    await fixture`UPDATE brainchain_worker_bindings SET requested_state='paused' WHERE id=${bindingId}`;
    expect(await refusal(()=>service.claimExecutionAttempt(input,authorityReader))).toContain('Fresh running testnet');
    expect((await fixture`SELECT consumed_at FROM brainchain_execution_authorities WHERE id=${input.authorityId}`)[0]!.consumed_at).toBeNull();
  });
  test('expiry during lock wait refuses and preserves the unconsumed authority',async()=>{
    const {input,bindingId}=await prepared(1000);let acquired!:()=>void,release!:()=>void;
    const locked=new Promise<void>(done=>{acquired=done;}),finish=new Promise<void>(done=>{release=done;});
    const holder=fixture.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'brainchain-index:'+bindingId},0))`;acquired();await finish;});
    await locked;const pending=refusal(()=>service.claimExecutionAttempt(input,authorityReader));await Bun.sleep(1200);release();await holder;
    expect(await pending).toContain('authority');
    expect((await fixture`SELECT consumed_at FROM brainchain_execution_authorities WHERE id=${input.authorityId}`)[0]!.consumed_at).toBeNull();
  });
});
