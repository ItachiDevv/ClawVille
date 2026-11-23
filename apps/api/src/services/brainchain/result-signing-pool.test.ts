import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Read-only real PostgreSQL regressions. No keys, signature construction, or row writes. Run alone. */
import {beforeAll,afterAll,describe,test,expect,mock} from 'bun:test';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {TaskDeliveryCoordinator} from './task-delivery';
import {ResultSignatureCoordinator} from './result-signing';
import type {ProtectedSignerJournal} from './signer-payload-store';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import type {SignerObservation} from './signer-policy';

const authorityReader=fixtureConfiguredAuthorityReader(`0x${'a'.repeat(64)}`);

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('typed result transaction pool ownership',()=>{
  let settings: Awaited<ReturnType<typeof getBrainchainFixtureSettings>>;
  beforeAll(async()=>{
    settings=await getBrainchainFixtureSettings();
    const policy=await import('./signer-policy');
    // Permit only the read-only stale-authority path. Every key/journal method below throws.
    mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{},assertSignerArtifactAdmission:policy.assertObservedSignerCode}));
  });
  afterAll(()=>{mock.restore();});
  function client(max:number){return postgres({...settings.options,max,onnotice:()=>{}});}
  async function staleRows(sql:ReturnType<typeof client>,count:number){
    const rows=await sql`SELECT r.id,r.avatar_id,w.address FROM brainchain_task_results r
      JOIN brainchain_task_attempts a ON a.id=r.attempt_id JOIN brainchain_worker_bindings w ON w.id=r.binding_id
      LEFT JOIN brainchain_result_signatures s ON s.result_id=r.id
      WHERE a.lease_until<clock_timestamp() AND s.id IS NULL LIMIT ${count}`;
    if(rows.length!==count)throw Error('Existing isolated fixture requires stale result rows');return rows;
  }
  async function bounded<T>(work:Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Pool regression timed out')),1500);})]);}
    finally{clearTimeout(timer);}
  }
  async function refusal(work:PromiseLike<unknown>){try{await work;return 'unexpected success';}catch(error){return String(error);}}
  for(const max of [1,4]){
    test(`result helper refuses stale authority while all ${max} pool connections belong to transactions`,async()=>{
      const sql=client(max);let work:Promise<string[]>|undefined;
      try{
        const rows=await staleRows(sql,max),service=new TaskDeliveryCoordinator(sql,undefined,undefined,authorityReader);let arrivals=0,release!:()=>void,callbacks=0;
        const barrier=new Promise<void>(done=>{release=done;});
        work=Promise.all(rows.map(row=>refusal(sql.begin(async tx=>{
          // All transactions hold their own connection before any owner read begins.
          await tx`SELECT 1`;if(++arrivals===max)release();await barrier;
          return service.withCurrentResult(tx,row.avatar_id,row.id,async()=>{callbacks++;});
        }))));
        const results=await bounded(work);expect(arrivals).toBe(max);expect(callbacks).toBe(0);
        for(const result of results)expect(result).toContain('Current settled execution fence required');
      }finally{await sql.end({timeout:1});await work;}
    });
    test(`signature capture refuses stale authority concurrently with pool max ${max} and never reaches the signer`,async()=>{
      const sql=client(max);let work:Promise<string[]>|undefined,calls=0;
      const forbidden=async():Promise<never>=>{calls++;throw Error('Signer or journal must remain unused');};
      const journal:ProtectedSignerJournal={claimKeyUse:forbidden,claimDriverUse:forbidden,findByOperation:forbidden,putIfAbsent:forbidden,get:forbidden};
      try{
        const rows=await staleRows(sql,max),service=new ResultSignatureCoordinator(sql,{signResult:forbidden},journal,undefined,authorityReader);
        work=Promise.all(rows.map(async row=>{
          const state:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:row.address,signerAddress:row.address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'a'.repeat(64)}`,codeHashes:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts},brainBalance:0n,gasBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n};
          return refusal(service.capture({avatarId:row.avatar_id,resultId:row.id,authorityId:randomUUID()},state));
        }));
        const results=await bounded(work);for(const result of results)expect(result).toContain('Current settled execution fence required');
        expect(calls).toBe(0);
      }finally{await sql.end({timeout:1});await work;}
    });
  }
});
