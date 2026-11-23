import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Isolated real PostgreSQL fixture only. This suite never signs or broadcasts a transaction. */
import {beforeAll,afterAll,describe,expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {serializeTransaction,recoverTransactionAddress,type Hex} from 'viem';
import {createHash} from 'node:crypto';
import type {ProtectedSignedPayloadStore} from './signer-service';
import {signerRequestHash,type SignerObservation} from './signer-policy';

const authorityReader=fixtureConfiguredAuthorityReader(`0x${'b'.repeat(64)}`);

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('BrainChain real signer intent and nonce records',()=>{
  let fixture:ReturnType<typeof postgres>,service:typeof import('./signer-operations');
  const prior=process.env.DATABASE_URL;
  const request={kind:'faucet'} as const;
  const fees={gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n};
  async function refuse(operation:()=>PromiseLike<unknown>){try{await operation();return 'success';}catch(error){return String(error);}}
  beforeAll(async()=>{
    const root=resolve(import.meta.dir,'../../../../..');
    const settings=await getBrainchainFixtureSettings();
    fixture=postgres({...settings.options,max:12,onnotice:()=>{}});
    // Never replay an older CHECK definition over the newer delivery fixture.
    const [schema]=await fixture`SELECT to_regclass('public.brainchain_signer_operations') AS relation`;
    if(!schema?.relation){const migration=await readFile(resolve(root,'packages/database/migrations/0103_brainchain_signer_records.sql'),'utf8');await fixture.unsafe(migration);await fixture.unsafe(migration);}
    process.env.DATABASE_URL=settings.url;
    service=await import('./signer-operations');
  });
  afterAll(async()=>{await fixture?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;});
  async function owner(providedAddress?:string){
    const avatarId=randomUUID(),bindingId=randomUUID(),address=providedAddress??`0x${randomBytes(20).toString('hex')}`;
    await fixture`INSERT INTO avatars(id) VALUES(${avatarId})`;
    await fixture`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'a'.repeat(64)})`;
    await fixture`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'brainchain-testnet:'+randomUUID()},0)`;
    const state:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:address,signerAddress:address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'b'.repeat(64)}`,codeHashes:{},
      brainBalance:1000n,gasBalance:10000n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,
      allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:86400n};
    return{avatarId,bindingId,address,state};
  }
  async function authorize(context:Awaited<ReturnType<typeof owner>>){
    const authorityId=randomUUID(),gasAuthorityId=randomUUID(),hash=signerRequestHash(request);
    for(const [id,purpose,amount] of [[authorityId,'faucet','0'],[gasAuthorityId,'gas','200']] as const){
      await fixture`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
        VALUES(${id},${context.bindingId},${context.avatarId},'testnet',274630,${context.address},1,${purpose},${hash},${amount},'isolated-test-fixture',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    }
    return{avatarId:context.avatarId,bindingId:context.bindingId,authorityId,gasAuthorityId,idempotencyKey:randomUUID(),request,fees};
  }
  test('same intent replays one record; altered fees and foreign owner cannot reuse authority',async()=>{
    const context=await owner(),input=await authorize(context);
    const first=await service.prepareSignerOperation(input,context.state);
    const again=await service.prepareSignerOperation(input,context.state);
    expect(again.id).toBe(first.id);
    expect(await refuse(()=>service.prepareSignerOperation({...input,fees:{...fees,gasLimit:101n}},context.state))).toContain('Idempotency intent mismatch');
    expect(await refuse(()=>service.prepareSignerOperation({...input,avatarId:randomUUID()},context.state))).toContain('Worker owner mismatch');
    expect(await refuse(()=>fixture`UPDATE brainchain_signer_operations SET intent='{}'::jsonb WHERE id=${first.id}`)).toContain('immutable');
  });
  test('concurrent intents reserve one nonce and retain identical retry ownership',async()=>{
    const context=await owner();
    const first=await service.prepareSignerOperation(await authorize(context),context.state);
    const second=await service.prepareSignerOperation(await authorize(context),context.state);
    const outcomes=await Promise.allSettled([first,second].map(operation=>service.reserveSignerNonce(operation.id,context.state,{canonical:0n,pending:0n})));
    const winners=outcomes.filter(value=>value.status==='fulfilled');expect(winners).toHaveLength(1);
    const operation=winners[0]!.value;expect(operation.nonce).toBe('0');
    const retried=await service.reserveSignerNonce(operation.id,context.state,{canonical:0n,pending:0n});expect(retried.nonce).toBe('0');expect(retried.id).toBe(operation.id);
    expect(String((await fixture`SELECT next_nonce FROM brainchain_signer_streams WHERE binding_id=${context.bindingId}`)[0]!.next_nonce)).toBe('1');
  });
  test('external nonce use stops future admission durably',async()=>{
    const context=await owner(),operation=await service.prepareSignerOperation(await authorize(context),context.state);
    expect(await refuse(()=>service.reserveSignerNonce(operation.id,context.state,{canonical:1n,pending:1n}))).toContain('External nonce change');
    const [stream]=await fixture`SELECT stopped,generation FROM brainchain_signer_streams WHERE binding_id=${context.bindingId}`;
    expect(stream!.stopped).toBe(true);expect(stream!.generation).toBe(2);
    expect((await fixture`SELECT nonce FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]!.nonce).toBeNull();
  });
  test('stop changes the generation and invalidates prior unaccepted authority',async()=>{
    const context=await owner(),operation=await service.prepareSignerOperation(await authorize(context),context.state);
    await service.stopSignerStream(context.bindingId);
    expect(await refuse(()=>service.reserveSignerNonce(operation.id,context.state,{canonical:0n,pending:0n}))).toContain('unavailable');
    expect(await refuse(()=>fixture`UPDATE brainchain_signer_streams SET generation=1 WHERE binding_id=${context.bindingId}`)).toContain('immutable');
  });
  test('actual SQL checks enforce stream bounds, authority purpose, and capture consistency',async()=>{
    const context=await owner(),operation=await service.prepareSignerOperation(await authorize(context),context.state);
    const constraints=await fixture`SELECT conname FROM pg_constraint WHERE conname IN ('brainchain_stream_values','brainchain_authority_values','brainchain_operation_values','brainchain_operation_capture') AND contype='c'`;
    expect(constraints).toHaveLength(4);
    expect(await refuse(()=>fixture`UPDATE brainchain_signer_streams SET next_nonce=18446744073709551616 WHERE binding_id=${context.bindingId}`)).toContain('brainchain_stream_values');
    expect(await refuse(()=>fixture`INSERT INTO brainchain_signer_authorities(binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${context.bindingId},${context.avatarId},'testnet',274630,${context.address},1,'arbitrary-transfer',${'a'.repeat(64)},-1,'fixture',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`)).toContain('brainchain_authority_values');
    await service.reserveSignerNonce(operation.id,context.state,{canonical:0n,pending:0n});
    expect(await refuse(()=>fixture`UPDATE brainchain_signer_operations SET state='accepting' WHERE id=${operation.id}`)).toContain('brainchain_operation_capture');
    expect(await refuse(()=>fixture`UPDATE brainchain_signer_operations SET signed_payload_ref=${'b'.repeat(64)} WHERE id=${operation.id}`)).toContain('brainchain_operation_capture');
  });
  test('expiry after a binding-lock wait refuses nonce reservation',async()=>{
    const context=await owner(),input=await authorize(context);
    // Set fixture expiry before operation creation; immutable authority prevents later widening.
    await fixture`DELETE FROM brainchain_signer_authorities WHERE id IN (${input.authorityId},${input.gasAuthorityId})`;
    const hash=signerRequestHash(request);
    for(const [id,purpose,amount] of [[input.authorityId,'faucet','0'],[input.gasAuthorityId,'gas','200']] as const)
      await fixture`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
        VALUES(${id},${context.bindingId},${context.avatarId},'testnet',274630,${context.address},1,${purpose},${hash},${amount},'isolated-test-fixture',clock_timestamp()+interval '1.5 seconds',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const operation=await service.prepareSignerOperation(input,context.state);
    let release!:()=>void,acquired!:()=>void;
    const locked=new Promise<void>(resolve=>{acquired=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
    const holder=fixture.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'brainchain-signer:'+context.bindingId},0))`;acquired();await finish;});
    await locked;
    const result=refuse(()=>service.reserveSignerNonce(operation.id,context.state,{canonical:0n,pending:0n}));
    await Bun.sleep(1800);release();await holder;
    expect(await result).toContain('expired');
    expect((await fixture`SELECT nonce FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]!.nonce).toBeNull();
  });
  test('accepted capture survives process interruption and stream retirement without a second key use',async()=>{
    // Synthetic signature components recover a fixture address; no private key or signing API is used.
    const {prepareSignerIntent}=await import('./signer-policy');
    const seed=await owner();
    const intent=prepareSignerIntent(request,seed.state,{requestHash:signerRequestHash(request),amount:0n,price:0n,gasCeilingWei:200n});
    const bytes=serializeTransaction({type:'eip1559',chainId:274630,to:intent.to,data:intent.data,value:0n,nonce:0,gas:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},
      // The standard secp256k1 generator has this valid x coordinate and even y.
      // Random nonzero s varies fixture ownership without choosing an invalid curve point.
      {r:'0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        s:`0x${(BigInt('0x'+randomBytes(31).toString('hex'))+1n).toString(16).padStart(64,'0')}`,yParity:0});
    const address=(await recoverTransactionAddress({serializedTransaction:bytes})).toLowerCase();
    const context=await owner(address),operation=await service.prepareSignerOperation(await authorize(context),context.state);
    await service.reserveSignerNonce(operation.id,context.state,{canonical:0n,pending:0n});
    await fixture`UPDATE brainchain_signer_operations SET state='accepting',accepted_at=clock_timestamp() WHERE id=${operation.id}`;
    const reference=createHash('sha256').update(bytes).digest('hex');
    let durable: {reference:string;bytes:Hex}|null=null,keyCalls=0;
    const store:ProtectedSignedPayloadStore={
      async claimKeyUse(){keyCalls++;throw Error('Recovery must never claim a key');},
      async putIfAbsent(){throw Error('Recovery must not create a payload');},
      async get(){if(!durable)throw Error('No payload');return durable.bytes;},
      async findByOperation(){return durable;},
    };
    const {recoverCapturedOperation,observeSignerReceipt}=await import('./signer-service');
    // Crash before a payload appears retains an accepted, uncertain nonce.
    expect((await recoverCapturedOperation(operation.id,store)).state).toBe('uncertain');
    expect((await fixture`SELECT accepted_at FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]!.accepted_at).not.toBeNull();
    await service.stopSignerStream(context.bindingId);
    // A late protected-store write can be recovered after the original admission expires or stops.
    durable={reference,bytes};
    const recovered=await recoverCapturedOperation(operation.id,store);
    expect(recovered.state).toBe('signed');
    expect(recovered.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await recoverCapturedOperation(operation.id,store)).transactionHash).toBe(recovered.transactionHash);
    expect(keyCalls).toBe(0);
    expect(String((await fixture`SELECT next_nonce FROM brainchain_signer_streams WHERE binding_id=${context.bindingId}`)[0]!.next_nonce)).toBe('1');
    const included=await observeSignerReceipt(operation.id,{async receipt(transactionHash){return{transactionHash,state:'included',provisional:true,observedAt:new Date().toISOString(),blockNumber:'1',blockHash:context.state.blockHash,successful:true,gasUsed:'100',effectiveGasPrice:'1'};}});
    expect(included.finalized).toBe(false);
    expect((await fixture`SELECT state FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]!.state).toBe('signed');
    await observeSignerReceipt(operation.id,{async receipt(transactionHash){return{transactionHash,state:'orphaned',provisional:true,observedAt:new Date().toISOString()};}});
    const [orphaned]=await fixture`SELECT state,nonce,signed_payload_ref FROM brainchain_signer_operations WHERE id=${operation.id}`;
    expect(orphaned!.state).toBe('uncertain');expect(String(orphaned!.nonce)).toBe('0');expect(orphaned!.signed_payload_ref).toBe(reference);
  });
});
