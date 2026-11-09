import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import {beforeAll,afterAll,describe,test,expect,mock} from 'bun:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {ExactResultRecoveryConsents,recordOwnerRecoveryControl,verifyExactRecoveryConsent,type ExactRecoveryOwner} from './exact-result-recovery-consent';
import {freezeHireSnapshot,DeliveryRecovery} from './delivery-recovery';
import {ExactResultRecoveryIssuer} from './exact-result-recovery-issuer';

const authorityReader=fixtureConfiguredAuthorityReader();

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('Exact result consent with canonical PostgreSQL composition',()=>{
  let q:ReturnType<typeof postgres>,shared:ReturnType<typeof postgres>,service:ExactResultRecoveryConsents;
  const previous=process.env.DATABASE_URL,previousEnvironment=process.env.CLAWVILLE_ENV;
  beforeAll(async()=>{
    const settings=await getBrainchainFixtureSettings();process.env.DATABASE_URL=settings.url;process.env.CLAWVILLE_ENV='staging';
    q=postgres({...settings.options,max:4,onnotice:()=>{}});
    await q`CREATE TABLE IF NOT EXISTS sessions(id varchar(255) PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at timestamp NOT NULL,created_via text)`;
    const migration=await readFile(new URL('../../../../../packages/database/migrations/0112_brainchain_exact_result_recovery.sql',import.meta.url),'utf8');
    await q.unsafe(migration);await q.unsafe(migration);
    shared=(await import('@clawville/database')).getPostgresClient();service=new ExactResultRecoveryConsents(shared);
  });
  afterAll(async()=>{await q?.end();if(previousEnvironment===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=previousEnvironment;if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;});
  async function fixture(live=false){
    const [source]=await q`SELECT r.*,a.authority_id FROM brainchain_task_results r JOIN brainchain_task_attempts a ON a.id=r.attempt_id LIMIT 1`;
    if(!source)throw Error('Settled fixture source required');
    const userId=randomUUID(),avatarId=randomUUID(),workerId=randomUUID(),task=randomUUID(),authority=randomUUID(),attempt=randomUUID(),call=randomUUID(),lease=randomUUID(),wallet=nacl.sign.keyPair(),session=randomBytes(24).toString('hex');
    const address='0x'+randomBytes(20).toString('hex'),hash=('0x'+'a'.repeat(64)) as `0x${string}`;
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
    return{userId,avatarId,workerId,task,authority,attempt,call,wallet,session,address,hash,hire,resultId:String(result!.id),owner};
  }
  async function draft(f:Awaited<ReturnType<typeof fixture>>,stages=['upload'] as ('signature'|'upload'|'prepare-submit'|'broadcast'|'reconcile')[]){
    return service.request(f.owner,f.workerId,{resultId:f.resultId,stages,maxGasWei:'1000',expiresAt:new Date(Date.now()+120000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'});
  }
  async function approve(f:Awaited<ReturnType<typeof fixture>>,id:string){const challenge=await service.challenge(f.owner,f.workerId,id);return service.approve(f.owner,f.workerId,id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),f.wallet.secretKey))});}
  async function refused(action:()=>PromiseLike<unknown>){try{await action();return false;}catch{return true;}}
  test('canonical shared pool approves exact output without reviving compute or worker',async()=>{
    const f=await fixture(),before=(await q`SELECT revoked_at,expires_at FROM brainchain_execution_authorities WHERE id=${f.authority}`)[0];
    const consent=await draft(f);await approve(f,consent.id);
    const grant=await shared.begin(tx=>verifyExactRecoveryConsent(tx,{avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'upload'}));
    expect(grant.payload.resultHash).toBeDefined();expect(grant.payload.callId).toBe(f.call);
    expect((await q`SELECT requested_state FROM brainchain_worker_bindings WHERE id=${f.workerId}`)[0]!.requested_state).toBe('paused');
    expect((await q`SELECT revoked_at,expires_at FROM brainchain_execution_authorities WHERE id=${f.authority}`)[0]).toEqual(before);
    const issuer=new ExactResultRecoveryIssuer(shared,authorityReader),issued=await issuer.issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'upload'});
    expect(issued.signer_authority_id).toBeNull();expect(issued.gas_authority_id).toBeNull();
    const evidence=async()=>({observedAt:new Date(Date.now()-1000),blockNumber:5000n,blockHash:f.hash,blockTimestamp:1n,hireBlockHash:f.hash,model:f.hire.snapshot.model,briefHash:f.hire.snapshot.briefHash,status:2,payee:'0x'+'0'.repeat(40),resultHash:grant.payload.resultHash,observationPolicy:'nitro-testnet-latest-v1' as const});
    const recovery=new DeliveryRecovery(shared,evidence,authorityReader),proof=await recovery.claim(f.avatarId,f.resultId,String(issued.delivery_authority_id));
    expect(proof.leaseId).toBeDefined();
    expect(await refused(()=>new DeliveryRecovery(shared,async()=>({...await evidence(),observationPolicy:undefined}),authorityReader).claim(f.avatarId,f.resultId,String(issued.delivery_authority_id)))).toBe(true);
  });
  test('agents request and revoke but cannot challenge or approve; foreign avatar cannot replay',async()=>{
    const f=await fixture(),agent={...f.owner,actor:'agent' as const},consent=await draft(f);
    expect(await refused(()=>service.challenge(agent,f.workerId,consent.id))).toBe(true);
    expect(await refused(()=>service.approve(agent,f.workerId,consent.id,{nonce:'a'.repeat(64),signature:'x'.repeat(88)}))).toBe(true);
    expect(await refused(()=>service.challenge({...f.owner,avatarId:randomUUID()},f.workerId,consent.id))).toBe(true);
    await service.revoke(agent,f.workerId,consent.id);expect((await service.list(f.owner,f.workerId)).consents[0]!.state).toBe('revoked');
  });
  test('rotation A-B-A and wallet-version refresh invalidate old proof',async()=>{
    for(const rotate of [false,true]){const f=await fixture(),consent=await draft(f),challenge=await service.challenge(f.owner,f.workerId,consent.id);
      if(rotate){await q`UPDATE users SET linked_wallet_pubkey=${bs58.encode(nacl.sign.keyPair().publicKey)} WHERE id=${f.userId}`;await q`UPDATE users SET linked_wallet_pubkey=${bs58.encode(f.wallet.publicKey)} WHERE id=${f.userId}`;}
      else await q`UPDATE users SET linked_wallet_at=clock_timestamp() WHERE id=${f.userId}`;
      expect(await refused(()=>service.approve(f.owner,f.workerId,consent.id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),f.wallet.secretKey))}))).toBe(true);
    }
  });
  test('owner revocation survives JSONB key ordering without restoring original authority',async()=>{
    const f=await fixture(),policy=randomUUID();
    await q`INSERT INTO brainchain_worker_policies(id,binding_id,avatar_id,user_id,revision,payload,payload_hash,expires_at) VALUES(${policy},${f.workerId},${f.avatarId},${f.userId},1,'{}',${'a'.repeat(64)},clock_timestamp()+interval '1 hour')`;
    await q`INSERT INTO brainchain_worker_policy_issuances(policy_id,binding_id,avatar_id,action_key,kind,request_hash,assignment_hash,evidence,execution_authority_id,compute_reserved) VALUES(${policy},${f.workerId},${f.avatarId},'execution:fixture','execution',${'a'.repeat(64)},${'b'.repeat(64)},'{}',${f.authority},1)`;
    await shared.begin(async tx=>{
      await recordOwnerRecoveryControl(tx,f.owner,f.workerId,policy,1,'pause');
      await tx`UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE id=${f.authority}`;
    });
    const before=(await q`SELECT revoked_at FROM brainchain_execution_authorities WHERE id=${f.authority}`)[0];
    const consent=await draft(f),approved=await approve(f,consent.id);
    expect(approved.state).toBe('approved');
    const grant=await shared.begin(tx=>verifyExactRecoveryConsent(tx,{avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'upload'}));
    expect(grant.payload.provenance.controlId).toBeDefined();
    expect((await q`SELECT revoked_at FROM brainchain_execution_authorities WHERE id=${f.authority}`)[0]).toEqual(before);
    expect((await q`SELECT requested_state FROM brainchain_worker_bindings WHERE id=${f.workerId}`)[0]!.requested_state).toBe('paused');
  });
  test('narrowing revokes old approval and requires a fresh owner signature',async()=>{
    const f=await fixture(),old=await draft(f,['upload','reconcile']);await approve(f,old.id);
    const agent={...f.owner,actor:'agent' as const};
    expect(await refused(()=>service.narrow(agent,f.workerId,old.id,{stages:['broadcast'],maxGasWei:'1',expiresAt:old.expiresAt}))).toBe(true);
    const next=await service.narrow(agent,f.workerId,old.id,{stages:['reconcile'],maxGasWei:'0',expiresAt:old.expiresAt});
    expect(next.state).toBe('requested');
    expect(await refused(()=>shared.begin(tx=>verifyExactRecoveryConsent(tx,{avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:old.id,stage:'upload'})))).toBe(true);
    expect(await refused(()=>shared.begin(tx=>verifyExactRecoveryConsent(tx,{avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:next.id,stage:'reconcile'})))).toBe(true);
  });
  test('paused exact submit reaches driver callback; consent revocation blocks the same boundary',async()=>{
    const policy=await import('./signer-policy');mock.module('./signer-policy',()=>({...policy,assertSignerArtifactAdmission:()=>{}}));
    try{
      const {TaskDeliveryCoordinator}=await import('./task-delivery'),{prepareSignerOperation}=await import('./signer-operations'),{captureSignerOperation}=await import('./signer-service');
      for(const boundary of ['paused-pass','revoke','narrow','expiry'] as const){
        const revoke=boundary!=='paused-pass';
        const f=await fixture(revoke),[row]=await q`SELECT result_hash FROM brainchain_task_results WHERE id=${f.resultId}`,uri=`https://brain.testnet.usebrainchain.com/records/${row!.result_hash}.txt`;
        await q`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${f.resultId}`;
        await q`UPDATE brainchain_task_results SET state='uploaded',result_uri=${uri} WHERE id=${f.resultId}`;
        const consent=boundary==='expiry'?await service.request(f.owner,f.workerId,{resultId:f.resultId,stages:['prepare-submit'],maxGasWei:'1000',expiresAt:new Date(Date.now()+2000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'}):await draft(f,['prepare-submit']);await approve(f,consent.id);
        const issued=await new ExactResultRecoveryIssuer(shared,authorityReader).issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'prepare-submit',fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n}});
        const evidence={observedAt:new Date(Date.now()-1000),blockNumber:5000n,blockHash:f.hash,blockTimestamp:BigInt(Math.floor(Date.now()/1000)),hireBlockHash:f.hash,model:f.hire.snapshot.model,briefHash:f.hire.snapshot.briefHash,status:2,payee:'0x'+'0'.repeat(40),resultHash:row!.result_hash,observationPolicy:'nitro-testnet-latest-v1' as const};
        const recovery=new DeliveryRecovery(shared,async()=>({...evidence,observedAt:new Date(Date.now()-1000)}),authorityReader),proof=await recovery.claim(f.avatarId,f.resultId,String(issued.delivery_authority_id));
        const observation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet' as const,chainId:274630 as const,bindingAddress:f.address,signerAddress:f.address,...evidence,codeHashes:{},gasBalance:1000n,brainBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n};
        await new TaskDeliveryCoordinator(shared,undefined,recovery,authorityReader).prepareSubmission(f.avatarId,f.resultId,{observedAt:observation.observedAt,blockTimestamp:observation.blockTimestamp,blockNumber:observation.blockNumber,blockHash:observation.blockHash,observationPolicy:observation.observationPolicy},proof);
        const request={kind:'submit' as const,resultId:f.resultId,task:f.hire.snapshot.task,hash:row!.result_hash,uri};
        const operation=await prepareSignerOperation({avatarId:f.avatarId,bindingId:f.workerId,authorityId:String(issued.signer_authority_id),gasAuthorityId:String(issued.gas_authority_id),idempotencyKey:randomUUID(),request,fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},deliveryProof:proof},observation);
        let calls=0,callbackPassed=false;
        const result=await captureSignerOperation({operationId:operation.id,observation,authorityReader,nonces:{canonical:0n,pending:0n},driver:{async addressForReference(){return f.address;},async signTransaction(_id,_ref,_tx,authority){await authority!.assertCurrent();callbackPassed=true;calls++;return '0x0201';}},store:{async claimKeyUse(){if(boundary==='revoke')await service.revoke(f.owner,f.workerId,consent.id);if(boundary==='narrow')await service.narrow({...f.owner,actor:'agent'},f.workerId,consent.id,{stages:['prepare-submit'],maxGasWei:'200',expiresAt:consent.expiresAt});if(boundary==='expiry')await Bun.sleep(2100);return true;},async findByOperation(){return null;},async get(){throw Error('No signed fixture');},async putIfAbsent(){throw Error('Invalid fixture bytes');}}});
        expect(result.state).toBe('uncertain');expect(calls).toBe(revoke?0:1);expect(callbackPassed).toBe(!revoke);
        expect((await q`SELECT requested_state FROM brainchain_worker_bindings WHERE id=${f.workerId}`)[0]!.requested_state).toBe(revoke?'running':'paused');
        if(!revoke){const captured=await draft(f,['reconcile']);expect((await approve(f,captured.id)).state).toBe('approved');expect(await refused(()=>service.request(f.owner,f.workerId,{resultId:f.resultId,stages:['broadcast'],maxGasWei:'1',expiresAt:new Date(Date.now()+60000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'}))).toBe(true);}
      }
    }finally{mock.restore();}
  },15000);
  test('approval replay and changed task generation fail closed',async()=>{
    const f=await fixture(),consent=await draft(f),proof=await service.challenge(f.owner,f.workerId,consent.id),signature=bs58.encode(nacl.sign.detached(Buffer.from(proof.messageToSign),f.wallet.secretKey));
    await service.approve(f.owner,f.workerId,consent.id,{nonce:proof.nonce,signature});
    expect(await refused(()=>service.approve(f.owner,f.workerId,consent.id,{nonce:proof.nonce,signature}))).toBe(true);
    await q`UPDATE brainchain_worker_tasks SET lease_generation=lease_generation+1 WHERE id=${f.task}`;
    expect(await refused(()=>shared.begin(tx=>verifyExactRecoveryConsent(tx,{avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'upload'})))).toBe(true);
  });
  test('a final evidence wait cannot outlive the exact consent',async()=>{
    const f=await fixture(),consent=await service.request(f.owner,f.workerId,{resultId:f.resultId,stages:['upload'],maxGasWei:'0',expiresAt:new Date(Date.now()+1000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'});await approve(f,consent.id);
    const issued=await new ExactResultRecoveryIssuer(shared,authorityReader).issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'upload'});
    const recovery=new DeliveryRecovery(shared,async()=>{const observedAt=new Date(Date.now()-1000);await Bun.sleep(1100);return{observedAt,blockNumber:5000n,blockHash:f.hash,blockTimestamp:1n,hireBlockHash:f.hash,model:f.hire.snapshot.model,briefHash:f.hire.snapshot.briefHash,status:2,payee:'0x'+'0'.repeat(40),resultHash:(consent.payload as {resultHash:string}).resultHash,observationPolicy:'nitro-testnet-latest-v1'};},authorityReader);
    expect(await refused(()=>recovery.claim(f.avatarId,f.resultId,String(issued.delivery_authority_id)))).toBe(true);
    expect(await q`SELECT id FROM brainchain_delivery_leases WHERE authority_id=${issued.delivery_authority_id}`).toHaveLength(0);
  });
  test('approval checks the final database clock after a signer lock wait',async()=>{
    const f=await fixture(),consent=await service.request(f.owner,f.workerId,{resultId:f.resultId,stages:['reconcile'],maxGasWei:'0',expiresAt:new Date(Date.now()+1000).toISOString(),observationPolicy:'nitro-testnet-latest-v1'}),proof=await service.challenge(f.owner,f.workerId,consent.id);
    let release!:()=>void,locked!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;});
    const blocker=q.begin(async tx=>{await tx`SELECT binding_id FROM brainchain_signer_streams WHERE binding_id=${f.workerId} FOR UPDATE`;locked();await hold;});await ready;
    const pending=refused(()=>service.approve(f.owner,f.workerId,consent.id,{nonce:proof.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(proof.messageToSign),f.wallet.secretKey))}));
    try{await Bun.sleep(1100);}finally{release();await blocker;}
    expect(await pending).toBe(true);expect((await q`SELECT state FROM brainchain_exact_result_consents WHERE id=${consent.id}`)[0]!.state).toBe('requested');
  });
  test('unknown upload permits only evidence reconciliation',async()=>{
    const f=await fixture();await q`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${f.resultId}`;await q`UPDATE brainchain_task_results SET state='upload_uncertain' WHERE id=${f.resultId}`;
    expect(await refused(()=>draft(f,['upload']))).toBe(true);
    const consent=await draft(f,['reconcile']);await approve(f,consent.id);
    const issued=await new ExactResultRecoveryIssuer(shared,authorityReader).issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'reconcile'});
    const recovery=new DeliveryRecovery(shared,async()=>({observedAt:new Date(Date.now()-1000),blockNumber:5000n,blockHash:f.hash,blockTimestamp:1n,hireBlockHash:f.hash,model:f.hire.snapshot.model,briefHash:f.hire.snapshot.briefHash,status:2,payee:'0x'+'0'.repeat(40),resultHash:(consent.payload as {resultHash:string}).resultHash,observationPolicy:'nitro-testnet-latest-v1'}),authorityReader);
    expect((await recovery.claim(f.avatarId,f.resultId,String(issued.delivery_authority_id))).leaseId).toBeDefined();
    expect((await q`SELECT state,result_uri FROM brainchain_task_results WHERE id=${f.resultId}`)[0]).toMatchObject({state:'upload_uncertain',result_uri:null});
  });
  test('C1 exact submit IDs require their lease even with live normal execution',async()=>{
    const {TaskDeliveryCoordinator}=await import('./task-delivery'),{prepareSignerOperation}=await import('./signer-operations');
    const f=await fixture(true),[row]=await q`SELECT result_hash FROM brainchain_task_results WHERE id=${f.resultId}`,uri=`https://brain.testnet.usebrainchain.com/records/${row!.result_hash}.txt`;
    await q`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${f.resultId}`;await q`UPDATE brainchain_task_results SET state='uploaded',result_uri=${uri} WHERE id=${f.resultId}`;
    const consent=await draft(f,['prepare-submit']);await approve(f,consent.id);
    const issued=await new ExactResultRecoveryIssuer(shared,authorityReader).issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'prepare-submit',fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n}});
    const evidence={observedAt:new Date(Date.now()-1000),blockNumber:5000n,blockHash:f.hash,blockTimestamp:BigInt(Math.floor(Date.now()/1000)),hireBlockHash:f.hash,model:f.hire.snapshot.model,briefHash:f.hire.snapshot.briefHash,status:2,payee:'0x'+'0'.repeat(40),resultHash:row!.result_hash,observationPolicy:'nitro-testnet-latest-v1' as const};
    const recovery=new DeliveryRecovery(shared,async()=>({...evidence,observedAt:new Date(Date.now()-1000)}),authorityReader),proof=await recovery.claim(f.avatarId,f.resultId,String(issued.delivery_authority_id));
    await new TaskDeliveryCoordinator(shared,undefined,recovery,authorityReader).prepareSubmission(f.avatarId,f.resultId,{observedAt:evidence.observedAt,blockTimestamp:evidence.blockTimestamp,blockNumber:5000n,blockHash:f.hash,observationPolicy:evidence.observationPolicy},proof);
    const state={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet' as const,chainId:274630 as const,bindingAddress:f.address,signerAddress:f.address,...evidence,codeHashes:{},gasBalance:1000n,brainBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n};
    const input={avatarId:f.avatarId,bindingId:f.workerId,authorityId:String(issued.signer_authority_id),gasAuthorityId:String(issued.gas_authority_id),idempotencyKey:randomUUID(),request:{kind:'submit' as const,resultId:f.resultId,task:f.hire.snapshot.task,hash:row!.result_hash,uri},fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n}};
    expect(await refused(()=>prepareSignerOperation(input,state))).toBe(true);
    expect(await refused(()=>prepareSignerOperation({...input,deliveryProof:{leaseId:proof.leaseId,leaseOwner:randomUUID()}},state))).toBe(true);
    expect(await q`SELECT id FROM brainchain_signer_operations WHERE binding_id=${f.workerId}`).toHaveLength(0);
    const operation=await prepareSignerOperation({...input,deliveryProof:proof},state);expect(operation.state).toBe('prepared');
    await service.revoke(f.owner,f.workerId,consent.id);
    expect(await refused(()=>import('./signer-operations').then(api=>api.reserveSignerNonce(operation.id,state,{canonical:0n,pending:0n})))).toBe(true);
    expect((await q`SELECT nonce FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]!.nonce).toBeNull();
  });
  test('C1 result signature authority cannot omit its lease or survive consent revocation',async()=>{
    const policy=await import('./signer-policy');mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{},assertSignerArtifactAdmission:()=>{}}));
    try{
      const {ResultSignatureCoordinator}=await import('./result-signing');
      for(const revoke of [false,true]){
        const f=await fixture(true),consent=await draft(f,['signature']);await approve(f,consent.id);
        const issued=await new ExactResultRecoveryIssuer(shared,authorityReader).issue({avatarId:f.avatarId,workerId:f.workerId,resultId:f.resultId,consentId:consent.id,stage:'signature'});
        const evidence={observedAt:new Date(Date.now()-1000),blockNumber:5000n,blockHash:f.hash,blockTimestamp:BigInt(Math.floor(Date.now()/1000)),hireBlockHash:f.hash,model:f.hire.snapshot.model,briefHash:f.hire.snapshot.briefHash,status:2,payee:'0x'+'0'.repeat(40),resultHash:(consent.payload as {resultHash:string}).resultHash,observationPolicy:'nitro-testnet-latest-v1' as const};
        const recovery=new DeliveryRecovery(shared,async()=>({...evidence,observedAt:new Date(Date.now()-1000)}),authorityReader),proof=await recovery.claim(f.avatarId,f.resultId,String(issued.delivery_authority_id));
        const state={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet' as const,chainId:274630 as const,bindingAddress:f.address,signerAddress:f.address,...evidence,codeHashes:{},gasBalance:1000n,brainBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n};
        let calls=0;
        const driver={async signResult(_id:string,_ref:string,_intent:unknown,assertCurrent:()=>Promise<void>){await assertCurrent();calls++;return '0x01' as const;}};
        const journal={async claimKeyUse(){if(revoke)await service.revoke(f.owner,f.workerId,consent.id);return true;},async claimDriverUse(){return true;},async addressForReference(){return f.address;},async findByOperation(){return null;},async get(){throw Error('No fixture bytes');},async putIfAbsent(){throw Error('No fixture bytes');}};
        const input={avatarId:f.avatarId,resultId:f.resultId,authorityId:String(issued.signer_authority_id)};
        expect(await refused(()=>new ResultSignatureCoordinator(shared,driver,journal,undefined,authorityReader).capture(input,state))).toBe(true);
        expect(await q`SELECT id FROM brainchain_result_signatures WHERE result_id=${f.resultId}`).toHaveLength(0);
        expect((await new ResultSignatureCoordinator(shared,driver,journal,{recovery,proof},authorityReader).capture(input,state)).state).toBe('uncertain');
        expect(calls).toBe(revoke?0:1);
      }
    }finally{mock.restore();}
  });
  test('unknown security revocation is not an owner recovery grant',async()=>{
    const f=await fixture();await q`UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE id=${f.authority}`;
    expect(await refused(()=>draft(f))).toBe(true);
  });
});
