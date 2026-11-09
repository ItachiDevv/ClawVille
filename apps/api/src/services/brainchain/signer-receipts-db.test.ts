import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID,randomBytes} from 'node:crypto';
import postgres from 'postgres';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import type {SignerReceiptObservation} from './signer-rpc';

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('durable provisional signer receipts',()=>{
  let sql:ReturnType<typeof postgres>,observe:typeof import('./signer-service').observeSignerReceipt;
  const prior=process.env.DATABASE_URL;
  beforeAll(async()=>{const settings=await getBrainchainFixtureSettings();sql=postgres({...settings.options,max:4,onnotice:()=>{}});process.env.DATABASE_URL=settings.url;observe=(await import('./signer-service')).observeSignerReceipt;});
  afterAll(async()=>{await sql?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;});
  async function fixture(){
    const avatarId=randomUUID(),bindingId=randomUUID(),id=randomUUID(),authority=randomUUID(),gas=randomUUID(),address='0x'+randomBytes(20).toString('hex'),hash=`0x${randomBytes(32).toString('hex')}` as const;
    await sql`INSERT INTO avatars(id) VALUES(${avatarId})`;
    await sql`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'a'.repeat(64)},'running')`;
    await sql`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${bindingId},${avatarId},'testnet',274630,${address},${'brainchain-testnet:receipt-'+randomUUID()},1)`;
    for(const [key,purpose]of [[authority,'faucet'],[gas,'gas']])await sql`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest) VALUES(${key!},${bindingId},${avatarId},'testnet',274630,${address},1,${purpose!},${'a'.repeat(64)},200,'receipt-fixture',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    await sql`INSERT INTO brainchain_signer_operations(id,binding_id,avatar_id,environment,chain_id,signer_address,authority_id,gas_authority_id,generation,kind,idempotency_key,request_hash,intent,state,nonce,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,expires_at,signed_payload_ref,transaction_hash,accepted_at,authority_policy_version,authority_policy_digest)
      VALUES(${id},${bindingId},${avatarId},'testnet',274630,${address},${authority},${gas},1,'faucet',${randomUUID()},${'a'.repeat(64)},'{}'::jsonb,'signed',0,100,2,1,clock_timestamp()+interval '1 minute',${'b'.repeat(64)},${hash},clock_timestamp(),${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const receipt=():SignerReceiptObservation=>({state:'included',transactionHash:hash,observedAt:new Date().toISOString(),provisional:true,blockNumber:'100',blockHash:`0x${'c'.repeat(64)}`,successful:true,confirmations:'12',gasUsed:'70',effectiveGasPrice:'1'});
    return{id,bindingId,hash,receipt};
  }
  test('receipt persistence and nonce progression commit together; replay retains one checkpoint',async()=>{
    const f=await fixture();let failed=false;
    try{await observe(f.id,{receipt:async()=>{throw Error('interrupted before observation');}});}catch{failed=true;}
    expect(failed).toBe(true);expect((await sql`SELECT state FROM brainchain_signer_operations WHERE id=${f.id}`)[0]!.state).toBe('signed');
    const result=await observe(f.id,{receipt:async()=>f.receipt()});expect(result.progressionAllowed).toBe(true);expect(result.finalized).toBe(false);
    expect((await sql`SELECT state FROM brainchain_signer_operations WHERE id=${f.id}`)[0]!.state).toBe('confirmed');
    await observe(f.id,{receipt:async()=>f.receipt()});expect((await sql`SELECT count(*)::int AS n FROM brainchain_signer_receipt_observations WHERE operation_id=${f.id}`)[0]!.n).toBe(1);
  });
  test('orphaned or changed canonical inclusion stops the stream without releasing nonce or bytes',async()=>{
    for(const changed of ['orphan','block','status','gas'] as const){
      const f=await fixture();await observe(f.id,{receipt:async()=>f.receipt()});
      const receipt:SignerReceiptObservation=changed==='block'?{...f.receipt(),blockHash:`0x${'d'.repeat(64)}`}:changed==='status'?{...f.receipt(),successful:false}:changed==='gas'?{...f.receipt(),gasUsed:'71'}:{state:'orphaned',transactionHash:f.hash,observedAt:new Date().toISOString(),provisional:true,blockNumber:'100',blockHash:`0x${'c'.repeat(64)}`};
      expect((await observe(f.id,{receipt:async()=>receipt})).progressionAllowed).toBe(false);
      const [operation]=await sql`SELECT state,nonce,signed_payload_ref FROM brainchain_signer_operations WHERE id=${f.id}`;
      const [stream]=await sql`SELECT stopped,generation,next_nonce FROM brainchain_signer_streams WHERE binding_id=${f.bindingId}`;
      expect(operation!.state).toBe('uncertain');expect(String(operation!.nonce)).toBe('0');expect(operation!.signed_payload_ref).toBe('b'.repeat(64));
      expect(stream!.stopped).toBe(true);expect(stream!.generation).toBe(2);expect(String(stream!.next_nonce)).toBe('1');
    }
  });
});
