import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import {beforeAll,afterAll,describe,test,expect,mock,setDefaultTimeout} from 'bun:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import {privateKeyToAccount} from 'viem/accounts';
import {computeHash} from './inference-policy';
import {ExactCaptureRecovery} from './exact-capture-recovery';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {ExactResultRecoveryConsents,recordOwnerRecoveryControl,verifyExactRecoveryConsent,type ExactRecoveryOwner} from './exact-result-recovery-consent';
import {freezeHireSnapshot,DeliveryRecovery} from './delivery-recovery';
import {ExactResultRecoveryIssuer} from './exact-result-recovery-issuer';

// Positive preparation uses a five-second grant; explicit expiry cases retain their short recovery deadlines.
setDefaultTimeout(60000);
const authorityReader=fixtureConfiguredAuthorityReader();

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('Exact unsigned capture recovery with canonical PostgreSQL composition',()=>{
  let q:ReturnType<typeof postgres>,shared:ReturnType<typeof postgres>,service:ExactResultRecoveryConsents;
  const previous=process.env.DATABASE_URL,previousEnvironment=process.env.CLAWVILLE_ENV;
  beforeAll(async()=>{
    const settings=await getBrainchainFixtureSettings();process.env.DATABASE_URL=settings.url;process.env.CLAWVILLE_ENV='staging';
    q=postgres({...settings.options,max:4,onnotice:()=>{}});
    await q`CREATE TABLE IF NOT EXISTS sessions(id varchar(255) PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at timestamp NOT NULL,created_via text)`;
    const migration=await readFile(new URL('../../../../../packages/database/migrations/0116_brainchain_exact_capture.sql',import.meta.url),'utf8');
    await q.unsafe(migration);await q.unsafe(migration);
    shared=(await import('@clawville/database')).getPostgresClient();service=new ExactResultRecoveryConsents(shared);
    const policy=await import('./signer-policy');mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{},assertSignerArtifactAdmission:()=>{}}));
  });
  afterAll(async()=>{mock.restore();await q?.end();if(previousEnvironment===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=previousEnvironment;if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;});
  async function fixture(live=false){
    const [source]=await q`SELECT r.*,a.authority_id FROM brainchain_task_results r JOIN brainchain_task_attempts a ON a.id=r.attempt_id LIMIT 1`;
    if(!source)throw Error('Settled fixture source required');
    const userId=randomUUID(),avatarId=randomUUID(),workerId=randomUUID(),task=randomUUID(),authority=randomUUID(),attempt=randomUUID(),call=randomUUID(),lease=randomUUID(),wallet=nacl.sign.keyPair(),session=randomBytes(24).toString('hex');
    const account=privateKeyToAccount(`0x${avatarId.replaceAll('-','').padStart(64,'0')}`),address=account.address.toLowerCase(),hash=('0x'+'a'.repeat(64)) as `0x${string}`;
    await q`INSERT INTO users(id,is_guest,linked_wallet_pubkey) VALUES(${userId},false,${bs58.encode(wallet.publicKey)})`;
    await q`INSERT INTO sessions(id,user_id,expires_at,created_via) VALUES(${session},${userId},clock_timestamp()+interval '1 hour','password')`;
    await q`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;
    await q`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${workerId},${avatarId},'testnet',274630,${address},${'b'.repeat(64)},${live?'running':'paused'})`;
    await q`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${workerId},${avatarId},'testnet',274630,${address},${'brainchain-testnet:'+randomUUID()},0)`;
    await q`INSERT INTO brainchain_worker_tasks SELECT (jsonb_populate_record(NULL::brainchain_worker_tasks,to_jsonb(t)||jsonb_build_object('id',${task}::text,'binding_id',${workerId}::text,'avatar_id',${avatarId}::text,'task_id',${BigInt('0x'+randomBytes(12).toString('hex')).toString()}::text,'lease_generation',1,'canonical',true,'status',2,'hire_block',2288,'hire_block_hash',${hash}::text,'observed_block',5000,'observed_block_hash',${hash}::text,'deadline_unix',EXTRACT(EPOCH FROM clock_timestamp())::bigint+600))).* FROM brainchain_worker_tasks t WHERE id=${source.task_id}`;
    await q`INSERT INTO brainchain_execution_authorities SELECT (jsonb_populate_record(NULL::brainchain_execution_authorities,to_jsonb(e)||jsonb_build_object('id',${authority}::text,'task_id',${task}::text,'binding_id',${workerId}::text,'avatar_id',${avatarId}::text,'generation',1,'created_at',clock_timestamp()-${live?5:120}*interval '1 second','expires_at',clock_timestamp()+${live?40:-30}*interval '1 second','consumed_at',clock_timestamp()-${live?4:110}*interval '1 second','revoked_at',NULL,'authority_policy_version',${CONFIGURED_AUTHORITY_VERSION}::text,'authority_policy_digest',${CONFIGURED_AUTHORITY_DIGEST}::text))).* FROM brainchain_execution_authorities e WHERE id=${source.authority_id}`;
    await q`INSERT INTO brainchain_task_attempts SELECT (jsonb_populate_record(NULL::brainchain_task_attempts,to_jsonb(a)||jsonb_build_object('id',${attempt}::text,'task_id',${task}::text,'binding_id',${workerId}::text,'avatar_id',${avatarId}::text,'generation',1,'authority_id',${authority}::text,'lease_owner',${lease}::text,'state','executing','created_at',clock_timestamp()-${live?5:120}*interval '1 second','lease_until',clock_timestamp()+${live?40:-30}*interval '1 second','output_hash',NULL))).* FROM brainchain_task_attempts a WHERE id=${source.attempt_id}`;
    await q`INSERT INTO brainchain_compute_calls SELECT (jsonb_populate_record(NULL::brainchain_compute_calls,to_jsonb(c)||jsonb_build_object('id',${call}::text,'reservation_id',${randomUUID()}::text,'avatar_id',${avatarId}::text,'task_id',${task}::text,'attempt_id',${attempt}::text,'generation',1,'lease_owner',${lease}::text,'capability_hash',${randomBytes(32).toString('hex')}::text))).* FROM brainchain_compute_calls c WHERE id=${source.call_id}`;
    const [taskRow]=await q`SELECT t.*,${address}::text AS address FROM brainchain_worker_tasks t WHERE id=${task}`,hire=freezeHireSnapshot(taskRow!);
    const [result]=await q`INSERT INTO brainchain_task_results(task_id,binding_id,avatar_id,environment,chain_id,attempt_id,call_id,generation,lease_owner,prompt_hash,result_text,result_sha256,result_hash,hire_snapshot,hire_snapshot_hash)
      SELECT ${task},${workerId},${avatarId},'testnet',274630,${attempt},${call},1,${lease},a.prompt_hash,${source.result_text},${source.result_sha256},${source.result_hash},${q.json(hire.snapshot)},${hire.hash} FROM brainchain_task_attempts a WHERE a.id=${attempt} RETURNING id`;
    const owner:ExactRecoveryOwner={avatarId,userId,actor:'human',humanSessionId:session,assertCurrent:async()=>{}};
    return{account,userId,avatarId,workerId,task,authority,attempt,call,wallet,session,address,hash,hire,resultId:String(result!.id),owner};
  }
  async function draft(f:Pick<Awaited<ReturnType<typeof fixture>>,'owner'|'workerId'|'resultId'>,stages=['upload'] as ('signature'|'upload'|'prepare-submit'|'broadcast'|'reconcile'|'capture-submit')[]){
    return service.request(f.owner,f.workerId,{resultId:f.resultId,stages,maxGasWei:'1000',expiresAt:new Date(Date.now()+120000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'});
  }
  async function approve(f:Pick<Awaited<ReturnType<typeof fixture>>,'owner'|'workerId'|'wallet'>,id:string){const challenge=await service.challenge(f.owner,f.workerId,id);return service.approve(f.owner,f.workerId,id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),f.wallet.secretKey))});}
  async function refused(action:()=>PromiseLike<unknown>){try{await action();return false;}catch{return true;}}

  async function prepared(reserve=false,recoveryMs=120000,ownerRevoked=false){
    const f=await fixture(true),{TaskDeliveryCoordinator}=await import('./task-delivery'),{prepareSignerOperation,reserveSignerNonce}=await import('./signer-operations');
    const [row]=await q`SELECT result_hash FROM brainchain_task_results WHERE id=${f.resultId}`,uri=`https://brain.testnet.usebrainchain.com/records/${row!.result_hash}.txt`;
    await q`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${f.resultId}`;
    await q`UPDATE brainchain_task_results SET state='uploaded',result_uri=${uri} WHERE id=${f.resultId}`;
    const original=await service.request(f.owner,f.workerId,{resultId:f.resultId,stages:['prepare-submit'],maxGasWei:'1000',expiresAt:new Date(Date.now()+5000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'});await approve(f,original.id);
    const issued=await new ExactResultRecoveryIssuer(shared,authorityReader).issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:original.id,stage:'prepare-submit',fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n}});
    const evidence=async()=>({observedAt:new Date(Date.now()-1000),blockNumber:5000n,blockHash:f.hash,blockTimestamp:1n,hireBlockHash:f.hash,model:f.hire.snapshot.model,briefHash:f.hire.snapshot.briefHash,status:2,payee:'0x'+'0'.repeat(40),resultHash:row!.result_hash,observationPolicy:'nitro-testnet-latest-v1' as const});
    const recovery=new DeliveryRecovery(shared,evidence,authorityReader),proof=await recovery.claim(f.avatarId,f.resultId,String(issued.delivery_authority_id));
    const observation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet' as const,chainId:274630 as const,bindingAddress:f.address,signerAddress:f.address,...await evidence(),codeHashes:{},gasBalance:1000n,brainBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n};
    await new TaskDeliveryCoordinator(shared,undefined,recovery,authorityReader).prepareSubmission(f.avatarId,f.resultId,{observedAt:observation.observedAt,blockTimestamp:observation.blockTimestamp,blockNumber:observation.blockNumber,blockHash:observation.blockHash,observationPolicy:observation.observationPolicy},proof);
    const operation=await prepareSignerOperation({avatarId:f.avatarId,bindingId:f.workerId,authorityId:String(issued.signer_authority_id),gasAuthorityId:String(issued.gas_authority_id),idempotencyKey:randomUUID(),request:{kind:'submit',resultId:f.resultId,task:f.hire.snapshot.task,hash:row!.result_hash,uri},fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},deliveryProof:proof},observation);
    if(reserve)await reserveSignerNonce(operation.id,observation,{canonical:0n,pending:0n});
    await Bun.sleep(Math.max(0,Date.parse(original.expiresAt)-Date.now()+50));
    await q`UPDATE brainchain_worker_bindings SET requested_state='paused' WHERE id=${f.workerId}`;
    if(ownerRevoked){
      const policyId=randomUUID();
      await q`INSERT INTO brainchain_worker_policies(id,binding_id,avatar_id,user_id,revision,payload,payload_hash,expires_at) VALUES(${policyId},${f.workerId},${f.avatarId},${f.userId},1,'{}',${'a'.repeat(64)},clock_timestamp()+interval '1 hour')`;
      await q`INSERT INTO brainchain_worker_policy_issuances(policy_id,binding_id,avatar_id,action_key,kind,request_hash,evidence,signer_authority_id,gas_authority_id,gas_reserved) VALUES(${policyId},${f.workerId},${f.avatarId},'submit:fixture','submit',${'a'.repeat(64)},'{}',${operation.authorityId},${operation.gasAuthorityId},200)`;
      await shared.begin(async tx=>{await recordOwnerRecoveryControl(tx,f.owner,f.workerId,policyId,1,'revoke');await tx`UPDATE brainchain_signer_authorities SET revoked_at=clock_timestamp() WHERE id IN (${operation.authorityId},${operation.gasAuthorityId})`;});
    }
    const consent=await service.request(f.owner,f.workerId,{resultId:f.resultId,stages:['capture-submit'],maxGasWei:'1000',expiresAt:new Date(Date.now()+recoveryMs).toISOString(),observationPolicy:'nitro-testnet-latest-v1'});await approve(f,consent.id);
    const capture=new ExactCaptureRecovery(shared,evidence,authorityReader),authority=await capture.issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id});
    return{...f,operation,observation,consent,capture,authority,evidence};
  }
  function signer(f:Awaited<ReturnType<typeof prepared>>){
    let calls=0,claimed=false;const captures=new Map<string,`0x${string}`>();
    return{get calls(){return calls;},driver:{async addressForReference(){return f.address;},async signTransaction(id:string,_reference:string,transaction:import('./signer-service').FrozenSignerTransaction,authority?:{assertCurrent:()=>Promise<void>}){await authority!.assertCurrent();calls++;const bytes=await f.account.signTransaction(transaction);captures.set(id,bytes);return bytes;}},
      store:{async claimKeyUse(){if(claimed)return false;claimed=true;return true;},async putIfAbsent(id:string,bytes:`0x${string}`){captures.set(id,bytes);return computeHash(id);},async get(ref:string){for(const[id,bytes]of captures)if(computeHash(id)===ref)return bytes;throw Error('No fixture capture');},async findByOperation(id:string){const bytes=captures.get(id);return bytes?{reference:computeHash(id),bytes}:null;}}};
  }
  test('expired retained operations preserve exact nonce and original authority across capture and replay',async()=>{
    for(const reserve of [false,true]){
      const f=await prepared(reserve),key=signer(f),before=await q`SELECT id,expires_at,revoked_at FROM brainchain_signer_authorities WHERE id IN (${f.operation.authorityId},${f.operation.gasAuthorityId}) ORDER BY id`;
      const input={authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store};
      expect((await f.capture.capture(input)).state).toBe('signed');expect((await f.capture.capture(input)).state).toBe('signed');expect(key.calls).toBe(1);
      expect(JSON.stringify(await q`SELECT id,expires_at,revoked_at FROM brainchain_signer_authorities WHERE id IN (${f.operation.authorityId},${f.operation.gasAuthorityId}) ORDER BY id`)).toBe(JSON.stringify(before));
      const [operation]=await q`SELECT nonce,gas_limit,max_fee_per_gas,authority_id,gas_authority_id FROM brainchain_signer_operations WHERE id=${f.operation.id}`;
      const [precision]=await q`SELECT o.accepted_at=a.accepted_at AS exact,EXTRACT(MICROSECONDS FROM a.accepted_at)::bigint%1000 AS fraction FROM brainchain_signer_operations o JOIN brainchain_exact_capture_acceptances a ON a.operation_id=o.id WHERE o.id=${f.operation.id}`;expect(precision!.exact).toBe(true);
      expect(operation!.nonce).toBe('0');expect(operation!.gas_limit).toBe('100');expect(operation!.authority_id).toBe(f.operation.authorityId);
    }
  });
  test('different configured block or hash refuses before acceptance and key access',async()=>{
    const f=await prepared(),key=signer(f);
    for(const mismatch of ['block','hash'] as const){
      const reader:typeof authorityReader=async input=>({...await authorityReader(input),...(mismatch==='block'?{blockNumber:5001n}:{blockHash:'0x'+'b'.repeat(64)})});
      const capture=new ExactCaptureRecovery(shared,f.evidence,reader);
      let error='';try{await capture.capture({authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store});}catch(e){error=String(e);}
      expect(error).toContain('Configured exact capture anchor mismatch');expect(key.calls).toBe(0);
      expect((await q`SELECT accepted_at FROM brainchain_signer_operations WHERE id=${f.operation.id}`)[0]!.accepted_at).toBeNull();
    }
  });
  test('changed wallet, signer generation, calldata, fees and security revocation refuse before key use',async()=>{
    for(const mutation of ['wallet','generation','calldata','fees','security','consent'] as const){
      const f=await prepared(),key=signer(f);
      if(mutation==='wallet'){await q`UPDATE users SET linked_wallet_pubkey=${bs58.encode(nacl.sign.keyPair().publicKey)} WHERE id=${f.userId}`;await q`UPDATE users SET linked_wallet_pubkey=${bs58.encode(f.wallet.publicKey)} WHERE id=${f.userId}`;}
      if(mutation==='generation')await q`UPDATE brainchain_signer_streams SET generation=generation+1 WHERE binding_id=${f.workerId}`;
      if(mutation==='calldata'){expect(await refused(()=>q`UPDATE brainchain_signer_operations SET intent=jsonb_set(intent,'{transaction,data}','"0x00"'::jsonb) WHERE id=${f.operation.id}`)).toBe(true);expect(key.calls).toBe(0);continue;}
      if(mutation==='fees'){expect(await refused(()=>q`UPDATE brainchain_signer_operations SET max_fee_per_gas=3 WHERE id=${f.operation.id}`)).toBe(true);expect(key.calls).toBe(0);continue;}
      if(mutation==='security')await q`UPDATE brainchain_signer_authorities SET revoked_at=clock_timestamp() WHERE id=${f.operation.authorityId}`;
      if(mutation==='consent')await service.revoke(f.owner,f.workerId,f.consent.id);
      expect(await refused(()=>f.capture.capture({authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store}))).toBe(true);
      expect(key.calls).toBe(0);expect((await q`SELECT accepted_at FROM brainchain_signer_operations WHERE id=${f.operation.id}`)[0]!.accepted_at).toBeNull();
    }
  },60000);
  test('revocation after protected claim retains uncertainty without a key call or retry',async()=>{
    const f=await prepared(),key=signer(f),original=key.store.claimKeyUse;
    key.store.claimKeyUse=async()=>{const claimed=await original();await service.revoke(f.owner,f.workerId,f.consent.id);return claimed;};
    const input={authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store};
    expect((await f.capture.capture(input)).state).toBe('uncertain');expect((await f.capture.capture(input)).state).toBe('uncertain');expect(key.calls).toBe(0);
    expect((await q`SELECT nonce FROM brainchain_signer_operations WHERE id=${f.operation.id}`)[0]!.nonce).toBe('0');
  });
  test('competing fresh consents admit one key use and retain one nonce',async()=>{
    const f=await prepared(),key=signer(f),input={authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store};
    const second=await draft(f,['capture-submit']);await approve(f,second.id);const other=await f.capture.issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:second.id});
    const outcomes=await Promise.allSettled([f.capture.capture(input),f.capture.capture({...input,authorityId:String(other.id)})]);
    expect(outcomes.some(value=>value.status==='fulfilled'&&value.value.state==='signed')).toBe(true);expect(key.calls).toBe(1);
    expect(await q`SELECT id FROM brainchain_exact_capture_authorities WHERE operation_id=${f.operation.id}`).toHaveLength(2);
    expect(await q`SELECT operation_id FROM brainchain_exact_capture_acceptances WHERE operation_id=${f.operation.id}`).toHaveLength(1);
  });

  test('direct SQL cannot admit late capture without the exact operation consent',async()=>{
    const f=await prepared(true),other=await prepared(true);
    expect(await refused(()=>q`UPDATE brainchain_signer_operations SET state='accepting',accepted_at=clock_timestamp() WHERE id=${f.operation.id}`)).toBe(true);
    expect(await refused(()=>q`INSERT INTO brainchain_exact_capture_acceptances(operation_id,authority_id) VALUES(${f.operation.id},${other.authority.id})`)).toBe(true);
    expect(await refused(()=>q`UPDATE brainchain_exact_capture_authorities SET nonce=nonce+1 WHERE id=${f.authority.id}`)).toBe(true);
    expect((await q`SELECT accepted_at FROM brainchain_signer_operations WHERE id=${f.operation.id}`)[0]!.accepted_at).toBeNull();
  },60000);
  test('consent expiry while waiting on the stream lock makes zero key calls',async()=>{
    const f=await prepared(false,350),key=signer(f),lock=await q.reserve();
    try{
      await lock`BEGIN`;await lock`SELECT binding_id FROM brainchain_signer_streams WHERE binding_id=${f.workerId} FOR UPDATE`;
      const pending=refused(()=>f.capture.capture({authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store}));
      await Bun.sleep(450);await lock`COMMIT`;expect(await pending).toBe(true);expect(key.calls).toBe(0);
      expect((await q`SELECT accepted_at FROM brainchain_signer_operations WHERE id=${f.operation.id}`)[0]!.accepted_at).toBeNull();
    }finally{await lock`ROLLBACK`;lock.release();}
  });

  test('database acceptance preserves nonzero microseconds without another key attempt',async()=>{
    const f=await prepared(true),key=signer(f);
    await q.begin(async tx=>{
      await tx`INSERT INTO brainchain_exact_capture_acceptances(operation_id,authority_id,accepted_at) VALUES(${f.operation.id},${f.authority.id},date_trunc('milliseconds',clock_timestamp()-interval '1 millisecond')+interval '123 microseconds')`;
      await tx`UPDATE brainchain_signer_operations SET state='accepting',accepted_at=(SELECT accepted_at FROM brainchain_exact_capture_acceptances WHERE operation_id=${f.operation.id}) WHERE id=${f.operation.id}`;
    });
    const [precision]=await q`SELECT o.accepted_at=a.accepted_at AS exact,EXTRACT(MICROSECONDS FROM a.accepted_at)::bigint%1000 AS fraction FROM brainchain_signer_operations o JOIN brainchain_exact_capture_acceptances a ON a.operation_id=o.id WHERE o.id=${f.operation.id}`;
    expect(precision!.exact).toBe(true);expect(String(precision!.fraction)).toBe('123');
    expect((await f.capture.capture({authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store})).state).toBe('uncertain');expect(key.calls).toBe(0);
  });

  test('fresh capture consent uses proven owner revocation without changing original revoked grants',async()=>{
    const f=await prepared(true,120000,true),key=signer(f),before=JSON.stringify(await q`SELECT id,revoked_at,expires_at FROM brainchain_signer_authorities WHERE id IN (${f.operation.authorityId},${f.operation.gasAuthorityId}) ORDER BY id`);
    expect((await f.capture.capture({authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store})).state).toBe('signed');
    expect(key.calls).toBe(1);expect(JSON.stringify(await q`SELECT id,revoked_at,expires_at FROM brainchain_signer_authorities WHERE id IN (${f.operation.authorityId},${f.operation.gasAuthorityId}) ORDER BY id`)).toBe(before);
  });

  test('consent expiry during signer address await refuses before durable acceptance',async()=>{
    const f=await prepared(false,350),key=signer(f);key.driver.addressForReference=async()=>{await Bun.sleep(450);return f.address;};
    expect(await refused(()=>f.capture.capture({authorityId:String(f.authority.id),observation:f.observation,nonces:{canonical:0n,pending:0n},driver:key.driver,store:key.store}))).toBe(true);
    expect(key.calls).toBe(0);expect((await q`SELECT accepted_at FROM brainchain_signer_operations WHERE id=${f.operation.id}`)[0]!.accepted_at).toBeNull();
  });

});
