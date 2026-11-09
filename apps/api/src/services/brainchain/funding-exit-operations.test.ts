import {beforeAll,afterAll,test,expect} from 'bun:test';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {FundingExitOperations} from './funding-exit-operations';
import {FundingExitClient,type FundingSourceEvidence} from './funding-exit-client';
import {FUNDING_EXIT_TESTNET as P,type FundingArtifact} from './funding-exit-policy';
import type {BuyerOwner} from './purchases';
const enabled=process.env.BRAINCHAIN_DB_FIXTURE==='1';let sql:ReturnType<typeof postgres>;
class Client extends FundingExitClient{calls=0;fail=true;reorg=false;sent:string[]=[];authorityCalls=0;authorityHook?: (signal?:AbortSignal)=>Promise<void>;
 override async prepare(kind:'parent_eth'|'parent_exit',_source:string,amount:bigint){return {nonce:1,gas:100000n,maxFeePerGas:1000000n,maxPriorityFeePerGas:0n,amount,terms:kind==='parent_exit'?{desk:P.desk,token:P.childToken,payoutChainId:P.parentChainId,payoutToken:P.parentToken,feeBps:50,minFeeUnits:'10000',minUnits:'1000000',maxUnits:'100000000',dailyUnits:'200000000'}:undefined};}
 override async verifyAuthority(_a:FundingArtifact,signal?:AbortSignal){this.authorityCalls++;await this.authorityHook?.(signal);}
 override async send(a:FundingArtifact,bytes:string,fence:()=>Promise<void>){await fence();this.calls++;this.sent.push(bytes);if(this.fail)throw Error('controlled lost reply');const {keccak256}=await import('viem');return keccak256(bytes as `0x${string}`);}
 override async source(_a:FundingArtifact,transaction:string):Promise<FundingSourceEvidence>{if(this.reorg)throw Error('controlled reorg');return {transaction,blockNumber:'10',blockHash:`0x${'a'.repeat(64)}`,observedAt:new Date().toISOString(),finalized:true,destination:'unresolved'};}
}
beforeAll(async()=>{if(!enabled)return;const settings=await getBrainchainFixtureSettings();sql=postgres({...settings.options,max:8,prepare:false,onnotice:()=>{}});drizzle(sql);
 const migration=await readFile(new URL('../../../../../packages/database/migrations/0116_brainchain_funding_exit.sql',import.meta.url),'utf8');await sql.unsafe(migration);await sql.unsafe(migration);
});afterAll(async()=>{if(sql)await sql.end();});
async function setup(kind:'parent_eth'|'parent_exit'='parent_eth'){
 const userId=randomUUID(),avatarId=randomUUID(),workerId=randomUUID(),key=nacl.sign.keyPair(),account=privateKeyToAccount(generatePrivateKey());
 await sql`INSERT INTO users(id,is_guest,linked_wallet_pubkey) VALUES(${userId},false,${bs58.encode(key.publicKey)})`;await sql`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;
 await sql`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash) VALUES(${workerId},${avatarId},'testnet',274630,${account.address.toLowerCase()},${'a'.repeat(64)})`;
 const owner:BuyerOwner={userId,avatarId,actor:'human',assertCurrent:async()=>{}},client=new Client(),codec={seal:async(value:string)=>({enc:Buffer.from(value).toString('base64'),iv:'controlled',tag:'controlled'}),open:async(value:{enc:string})=>Buffer.from(value.enc,'base64').toString()};
 const service=new FundingExitOperations(sql,{client,codec,executeTestnet:true});const input={environment:'testnet',workerId,idempotencyKey:randomUUID(),kind,amountAtomic:kind==='parent_eth'?'1000000000000000':'1000000',maxGasCostWei:'1000000000000000',maxFeeAtomic:'10000',minimumDestinationAtomic:kind==='parent_eth'?'1000000000000000':'990000'};
 const row=await service.create(owner,input);return {owner,client,service,input,row,key,account};
}
async function refuses(action:()=>Promise<unknown>){let refused=false;try{await action();}catch{refused=true;}expect(refused).toBe(true);}
async function approved(f:Awaited<ReturnType<typeof setup>>){const c=await f.service.challenge(f.owner,f.row.id);await f.service.approve(f.owner,f.row.id,{signature:bs58.encode(nacl.sign.detached(Buffer.from(c.messageToSign),f.key.secretKey))});}
async function capture(f:Awaited<ReturnType<typeof setup>>){await approved(f);const {artifact:a,messageToSign}=await f.service.intent(f.owner,f.row.id);const signedTransaction=await f.account.signTransaction({type:'eip1559',chainId:a.chainId,nonce:a.nonce,to:a.to as `0x${string}`,data:a.data as `0x${string}`,value:BigInt(a.value),gas:BigInt(a.gas),maxFeePerGas:BigInt(a.maxFeePerGas),maxPriorityFeePerGas:BigInt(a.maxPriorityFeePerGas)});
 await f.service.capture(f.owner,f.row.id,{signedTransaction,intentSignature:await f.account.signMessage({message:messageToSign})});return signedTransaction;}
test.skipIf(!enabled)('actual Drizzle pool preserves owner, idempotency, nonce and complete capture tuples',async()=>{const f=await setup();expect((await f.service.create(f.owner,f.input)).id).toBe(f.row.id);
 let refused=false;try{await f.service.get({...f.owner,userId:randomUUID()},f.row.id);}catch{refused=true;}expect(refused).toBe(true);try{await f.service.intent(f.owner,f.row.id);throw Error('expected refusal');}catch(e){expect((e as Error).message).toBe('approval_required');}await refuses(()=>f.service.challenge({...f.owner,actor:'agent'},f.row.id));
 await refuses(()=>f.service.create(f.owner,{...f.input,idempotencyKey:randomUUID()}));
 await refuses(async()=>{await sql`UPDATE brainchain_funding_operations SET captured='{}'::jsonb WHERE id=${f.row.id}`;});
 await refuses(async()=>{await sql`UPDATE brainchain_funding_operations SET artifact=artifact || '{"nonce":3}'::jsonb WHERE id=${f.row.id}`;});
 await refuses(async()=>{await sql`DELETE FROM brainchain_funding_operations WHERE id=${f.row.id}`;});
 const results=await Promise.allSettled([f.service.create(f.owner,{...f.input,idempotencyKey:randomUUID()}),f.service.create(f.owner,{...f.input,idempotencyKey:randomUUID()})]);expect(results.filter(r=>r.status==='fulfilled').length).toBe(0);
});
test.skipIf(!enabled)('account rotation away and back refuses old approval for both actor paths',async()=>{const f=await setup();await approved(f);const wallet=bs58.encode(f.key.publicKey);await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(nacl.sign.keyPair().publicKey)} WHERE id=${f.owner.userId}`;await sql`UPDATE users SET linked_wallet_pubkey=${wallet} WHERE id=${f.owner.userId}`;
 await refuses(()=>f.service.intent(f.owner,f.row.id));await refuses(()=>f.service.intent({...f.owner,actor:'agent'},f.row.id));expect((await f.service.get(f.owner,f.row.id)).liabilityState).toBe('reserved');});
test.skipIf(!enabled)('lost reply persists original capture; replay uses identical bytes and source finality never releases funds',async()=>{const f=await setup(),bytes=await capture(f);await refuses(()=>f.service.submit(f.owner,f.row.id));expect((await f.service.get(f.owner,f.row.id)).state).toBe('uncertain');
 f.client.fail=false;await f.service.submit({...f.owner,actor:'agent'},f.row.id,true);expect(f.client.sent).toEqual([bytes,bytes]);const observed=await f.service.reconcile(f.owner,f.row.id);expect(observed.sourceEvidence?.finalized).toBe(true);expect(observed.destinationState).toBe('unresolved');expect(observed.liabilityState).toBe('reserved');
 f.client.reorg=true;await refuses(()=>f.service.reconcile(f.owner,f.row.id));expect((await f.service.get(f.owner,f.row.id)).state).toBe('reorg_suspended');expect((await f.service.get(f.owner,f.row.id)).liabilityState).toBe('reserved');});
test.skipIf(!enabled)('approval expiry during final identity wait retains capture and prevents any send',async()=>{const f=await setup();await capture(f);let reads=0;f.owner.assertCurrent=async()=>{if(++reads===9)await new Promise(resolve=>setTimeout(resolve,160));};await sql`UPDATE brainchain_funding_operations SET approval_expires_at=clock_timestamp()+interval '0.1 seconds' WHERE id=${f.row.id}`;
 await refuses(()=>f.service.submit(f.owner,f.row.id));expect(f.client.calls).toBe(0);expect((await f.service.get(f.owner,f.row.id)).liabilityState).toBe('reserved');});
async function singleService(client:Client){const settings=await getBrainchainFixtureSettings(),pool=postgres({...settings.options,max:1,prepare:false,onnotice:()=>{}});drizzle(pool);return {pool,service:new FundingExitOperations(pool,{client,executeTestnet:true,codec:{seal:async value=>({enc:Buffer.from(value).toString('base64'),iv:'controlled',tag:'controlled'}),open:async value=>Buffer.from(value.enc,'base64').toString()}})};}
function deferred(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function boundedRefusal(promise:Promise<unknown>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise.then(()=>{throw Error('expected refusal');},()=>{}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline failed')),2300);})]);}finally{clearTimeout(timer);}}
test.skipIf(!enabled)('owner callback deadline rolls back and releases max-one pool and avatar lock before late resolution',async()=>{
 const f=await setup(),{pool,service}=await singleService(f.client),gate=deferred(),entered=deferred();let signal:AbortSignal|undefined,calls=0;
 try{const pending=service.get({...f.owner,assertCurrent:async(s?:AbortSignal)=>{signal=s;calls++;entered.release();await gate.promise;}},f.row.id);await entered.promise;await boundedRefusal(pending);
  await sql.begin(async tx=>{await tx`SELECT id FROM avatars WHERE id=${f.owner.avatarId} FOR UPDATE NOWAIT`;});expect((await pool`SELECT 1 AS n`)[0]!.n).toBe(1);expect(signal?.aborted).toBe(true);expect(calls).toBe(1);
  gate.release();await new Promise(resolve=>setTimeout(resolve,20));expect(calls).toBe(1);expect((await service.get(f.owner,f.row.id)).state).toBe('reserved');
 }finally{gate.release();await pool.end({timeout:1});}
},6000);
test.skipIf(!enabled)('authority callback timeout retains captured bytes, releases locks and never dispatches after late completion',async()=>{
 const f=await setup(),bytes=await capture(f),{pool,service}=await singleService(f.client),gate=deferred(),entered=deferred();let signal:AbortSignal|undefined;
 f.client.authorityHook=async s=>{if(f.client.authorityCalls===2){signal=s;entered.release();await gate.promise;}};
 try{const pending=service.submit(f.owner,f.row.id);await entered.promise;await boundedRefusal(pending);await sql.begin(async tx=>{await tx`SELECT id FROM avatars WHERE id=${f.owner.avatarId} FOR UPDATE NOWAIT`;});expect((await pool`SELECT 1 AS n`)[0]!.n).toBe(1);expect(signal?.aborted).toBe(true);expect(f.client.calls).toBe(0);
  const before=await service.get(f.owner,f.row.id);expect(before.state).toBe('uncertain');expect(before.liabilityState).toBe('reserved');const [captureRow]=await sql`SELECT capture_hash,captured FROM brainchain_funding_operations WHERE id=${f.row.id}`;expect(captureRow!.captured).not.toBeNull();expect(captureRow!.capture_hash).toBe((await import('./funding-exit-policy')).fundingDigest(bytes));
  gate.release();await new Promise(resolve=>setTimeout(resolve,30));expect(f.client.calls).toBe(0);expect((await service.get(f.owner,f.row.id)).state).toBe('uncertain');
 }finally{gate.release();await pool.end({timeout:1});}
},6000);
test.skipIf(!enabled)('multiple owner waits share one host deadline and cannot expose terms after cumulative expiry',async()=>{
 const f=await setup();await approved(f);let calls=0;const started=performance.now();await refuses(()=>f.service.intent({...f.owner,assertCurrent:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,600));}},f.row.id));
 expect(calls).toBeGreaterThanOrEqual(2);expect(performance.now()-started).toBeLessThan(2300);const [row]=await sql`SELECT exposed_at FROM brainchain_funding_operations WHERE id=${f.row.id}`;expect(row!.exposed_at).toBeNull();
},6000);
