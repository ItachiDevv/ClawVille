import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Disposable PostgreSQL only. Fixture cloning represents previously settled work; no cognition or keys are used. */
import {beforeAll,afterAll,describe,test,expect,mock} from 'bun:test';
import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {DeliveryRecovery,freezeHireSnapshot,type DeliveryChainEvidence,type DeliveryStage} from './delivery-recovery';
import {TaskDeliveryCoordinator} from './task-delivery';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {signerRequestHash,type SignerObservation} from './signer-policy';
import {serializeTransaction,recoverTransactionAddress,recoverMessageAddress,encodeFunctionData,keccak256,type Hex} from 'viem';
import {ResultSignatureCoordinator} from './result-signing';
import {freezeResultSignatureIntent,resultSignatureClaimHash} from './result-signing-policy';
import {resultUploadMessage} from './result-signing-message';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';

const authorityReader=fixtureConfiguredAuthorityReader();

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('expiry-only delivery recovery',()=>{
  let q:ReturnType<typeof postgres>;const prior=process.env.DATABASE_URL;
  beforeAll(async()=>{
    const root=resolve(import.meta.dir,'../../../../..');const settings=await getBrainchainFixtureSettings();
    q=postgres({...settings.options,max:4,onnotice:()=>{}});
    const migration=await readFile(resolve(root,'packages/database/migrations/0107_brainchain_delivery_recovery.sql'),'utf8');await q.unsafe(migration);await q.unsafe(migration);
    process.env.DATABASE_URL=settings.url;
  });
  afterAll(async()=>{mock.restore();await q.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;});
  async function refusal(work:()=>PromiseLike<unknown>){try{await work();return 'success';}catch(error){return String(error);}}
  async function context(legacy=false,providedAddress?:string,providedTask?:string){
    const [source]=await q`SELECT r.task_id,r.attempt_id,r.call_id,r.result_text,r.result_hash,r.result_sha256,a.authority_id FROM brainchain_task_results r JOIN brainchain_task_attempts a ON a.id=r.attempt_id LIMIT 1`;
    if(!source)throw Error('Settled fixture source required');
    const avatar=randomUUID(),binding=randomUUID(),task=randomUUID(),authority=randomUUID(),attempt=randomUUID(),call=randomUUID(),lease=randomUUID(),address=providedAddress??`0x${randomBytes(20).toString('hex')}`,blockHash=`0x${'a'.repeat(64)}`;
    await q`INSERT INTO avatars(id) VALUES(${avatar})`;
    await q`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${binding},${avatar},'testnet',274630,${address},${'b'.repeat(64)},'running')`;
    await q`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${binding},${avatar},'testnet',274630,${address},${'brainchain-testnet:'+randomUUID()},0)`;
    await q`INSERT INTO brainchain_worker_tasks SELECT (jsonb_populate_record(NULL::brainchain_worker_tasks,to_jsonb(t)||jsonb_build_object('id',${task}::text,'binding_id',${binding}::text,'avatar_id',${avatar}::text,'task_id',${providedTask??BigInt('0x'+randomBytes(12).toString('hex')).toString()}::text,'lease_generation',1,'canonical',true,'status',2,'hire_block',2288,'hire_block_hash',${blockHash}::text,'observed_block',5000,'observed_block_hash',${blockHash}::text,'deadline_unix',EXTRACT(EPOCH FROM clock_timestamp())::bigint+600))).* FROM brainchain_worker_tasks t WHERE id=${source.task_id}`;
    await q`INSERT INTO brainchain_execution_authorities SELECT (jsonb_populate_record(NULL::brainchain_execution_authorities,to_jsonb(a)||jsonb_build_object('id',${authority}::text,'task_id',${task}::text,'binding_id',${binding}::text,'avatar_id',${avatar}::text,'generation',1,'created_at',clock_timestamp()-interval '120 seconds','expires_at',clock_timestamp()-interval '30 seconds','consumed_at',clock_timestamp()-interval '110 seconds','revoked_at',NULL,'authority_policy_version',${CONFIGURED_AUTHORITY_VERSION}::text,'authority_policy_digest',${CONFIGURED_AUTHORITY_DIGEST}::text))).* FROM brainchain_execution_authorities a WHERE id=${source.authority_id}`;
    await q`INSERT INTO brainchain_task_attempts SELECT (jsonb_populate_record(NULL::brainchain_task_attempts,to_jsonb(a)||jsonb_build_object('id',${attempt}::text,'task_id',${task}::text,'binding_id',${binding}::text,'avatar_id',${avatar}::text,'generation',1,'authority_id',${authority}::text,'lease_owner',${lease}::text,'state','executing','created_at',clock_timestamp()-interval '120 seconds','lease_until',clock_timestamp()-interval '30 seconds','output_hash',NULL))).* FROM brainchain_task_attempts a WHERE id=${source.attempt_id}`;
    await q`INSERT INTO brainchain_compute_calls SELECT (jsonb_populate_record(NULL::brainchain_compute_calls,to_jsonb(c)||jsonb_build_object('id',${call}::text,'reservation_id',${randomUUID()}::text,'avatar_id',${avatar}::text,'task_id',${task}::text,'attempt_id',${attempt}::text,'generation',1,'lease_owner',${lease}::text,'capability_hash',${randomBytes(32).toString('hex')}::text))).* FROM brainchain_compute_calls c WHERE id=${source.call_id}`;
    const [stored]=await q`SELECT t.*,${address}::text AS address FROM brainchain_worker_tasks t WHERE id=${task}`,hire=freezeHireSnapshot(stored!);
    const [result]=await q`INSERT INTO brainchain_task_results(task_id,binding_id,avatar_id,environment,chain_id,attempt_id,call_id,generation,lease_owner,prompt_hash,result_text,result_sha256,result_hash,hire_snapshot,hire_snapshot_hash)
      SELECT ${task},${binding},${avatar},'testnet',274630,${attempt},${call},1,${lease},a.prompt_hash,${source.result_text},${source.result_sha256},${source.result_hash},${legacy?null:q.json(hire.snapshot)},${legacy?null:hire.hash} FROM brainchain_task_attempts a WHERE a.id=${attempt} RETURNING *`;
    const evidence:DeliveryChainEvidence={observedAt:new Date(),blockNumber:5000n,blockHash,blockTimestamp:BigInt(Math.floor(Date.now()/1000)),hireBlockHash:blockHash,model:hire.snapshot.model,briefHash:hire.snapshot.briefHash,status:2,payee:`0x${'0'.repeat(40)}`,resultHash:source.result_hash};
    const reader=async()=>({...evidence,observedAt:new Date(Date.now()-1000),blockTimestamp:BigInt(Math.floor(Date.now()/1000))-1n});
    return{avatar,binding,task,authority,attempt,result:result!,address,hire,evidence,reader,recovery:new DeliveryRecovery(q,reader,authorityReader)};
  }
  async function grant(c:Awaited<ReturnType<typeof context>>,stage:DeliveryStage='upload',lifetime=60000){
    const [row]=await q`INSERT INTO brainchain_delivery_authorities(result_id,binding_id,avatar_id,environment,chain_id,stage,task_generation,hire_snapshot_hash,result_hash,result_sha256,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${c.result.id},${c.binding},${c.avatar},'testnet',274630,${stage},1,${c.hire.hash},${c.result.result_hash},${c.result.result_sha256},'fixture-root',clock_timestamp()+${lifetime}*interval '1 millisecond',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;return String(row!.id);
  }
  test('two claimants get one lease; restart preserves output and never revives compute',async()=>{
    const c=await context(),authority=await grant(c),before=await q`SELECT lease_until FROM brainchain_task_attempts WHERE id=${c.attempt}`;
    const races=await Promise.allSettled([c.recovery.claim(c.avatar,c.result.id,authority),c.recovery.claim(c.avatar,c.result.id,authority)]);
    const successes=races.filter(value=>value.status==='fulfilled');expect(successes.length).toBe(1);const proof=successes[0]!.value;
    const restarted=new DeliveryRecovery(q,c.reader,authorityReader),text=await q.begin(tx=>restarted.withLease(tx,c.avatar,c.result.id,proof,'upload',async value=>value.result.result_text));
    expect(text).toBe(c.result.result_text);expect((await q`SELECT lease_until FROM brainchain_task_attempts WHERE id=${c.attempt}`)[0]!.lease_until).toEqual(before[0]!.lease_until);
    expect(await refusal(()=>q.begin(tx=>restarted.withLease(tx,c.avatar,c.result.id,{...proof,leaseOwner:randomUUID()},'upload',async()=>{})))).toContain('owner or stage');
    await q`UPDATE brainchain_worker_tasks SET lease_generation=lease_generation+1 WHERE id=${c.task}`;
    expect(await refusal(()=>q.begin(tx=>restarted.withLease(tx,c.avatar,c.result.id,proof,'upload',async()=>{})))).toContain('generation');
  });
  test('canonical shared Drizzle pool claims and reconciles exact frozen delivery evidence',async()=>{
    const c=await context(),authority=await grant(c,'reconcile');
    const shared=(await import('@clawville/database')).getPostgresClient();
    expect(typeof(await shared`SELECT clock_timestamp() AS now`)[0]!.now).toBe('string');
    const reader=async()=>({...await c.reader(),status:3,payee:c.address,resultHash:c.result.result_hash});
    const recovery=new DeliveryRecovery(shared,reader,authorityReader),proof=await recovery.claim(c.avatar,c.result.id,authority);
    expect((await recovery.reconcileSubmitted(c.avatar,c.result.id,proof)).state).toBe('submitted-observed');
    expect((await recovery.reconcileSubmitted(c.avatar,c.result.id,proof)).finalized).toBe(false);
    const [record]=await shared`SELECT evidence FROM brainchain_delivery_reconciliations WHERE lease_id=${proof.leaseId}`;
    expect(record!.evidence.resultHash).toBe(c.result.result_hash);expect(record!.evidence.finalized).toBe(false);
  });
  test('configured authority drift preserves reconciliation but refuses upload authority',async()=>{
    let calls=0;
    const drift:typeof authorityReader=async()=>{calls++;throw Error('Configured authority getter drift');};
    const c=await context(),grantId=await grant(c,'reconcile');
    const reader=async()=>({...await c.reader(),status:3,payee:c.address,resultHash:c.result.result_hash});
    const recovery=new DeliveryRecovery(q,reader,drift),proof=await recovery.claim(c.avatar,c.result.id,grantId);
    expect((await recovery.reconcileSubmitted(c.avatar,c.result.id,proof)).state).toBe('submitted-observed');expect(calls).toBe(0);
    const upload=await context(),uploadGrant=await grant(upload,'upload');
    expect(await refusal(()=>new DeliveryRecovery(q,upload.reader,drift).claim(upload.avatar,upload.result.id,uploadGrant))).toContain('Configured authority getter drift');
    expect(calls).toBe(1);expect((await q`SELECT consumed_at FROM brainchain_delivery_authorities WHERE id=${uploadGrant}`)[0]!.consumed_at).toBeNull();
  });
  test('expiry delivery authority permits one signature capture; restart never repeats uncertain key use',async()=>{
    const policy=await import('./signer-policy');
    mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{},assertSignerArtifactAdmission:policy.assertObservedSignerCode}));
    for(const captured of [true,false]){
      const [source]=await q`SELECT result_hash FROM brainchain_task_results LIMIT 1`,task=BigInt('0x'+randomBytes(12).toString('hex')).toString();
      const signature=`0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798${'1'.padStart(64,'0')}1b` as Hex;
      const address=(await recoverMessageAddress({message:resultUploadMessage(BRAINCHAIN_CONTRACTS.testnet.contracts.board,task,source!.result_hash),signature})).toLowerCase();
      const c=await context(false,address,task),deliveryGrant=await grant(c,'signature'),proof=await c.recovery.claim(c.avatar,c.result.id,deliveryGrant);
      const [stream]=await q`SELECT signer_ref FROM brainchain_signer_streams WHERE binding_id=${c.binding}`;
      const intent=freezeResultSignatureIntent({domain:'brainchain-result-v2',chainId:274630,resultId:c.result.id,board:BRAINCHAIN_CONTRACTS.testnet.contracts.board,task,hash:c.result.result_hash,worker:address});
      const [authority]=await q`INSERT INTO brainchain_signer_authorities(binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
        VALUES(${c.binding},${c.avatar},'testnet',274630,${address},1,'result-signature',${resultSignatureClaimHash(stream!.signer_ref,intent)},0,'fixture-root',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
      let calls=0,stored=false;const reference='e'.repeat(64);
      const journal={async claimKeyUse(){return true;},async claimDriverUse(){return true;},async putIfAbsent(){stored=true;return reference;},async findByOperation(){return stored?{reference,bytes:signature}:null;},async get(){return signature;}};
      const driver={async signResult(_id:string,_ref:string,_intent:unknown,current:()=>Promise<void>){calls++;await current();if(captured)stored=true;throw Error('fixture process stopped');}};
      const state={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:address,signerAddress:address,observedAt:new Date(),blockNumber:5000n,blockHash:c.evidence.blockHash,blockTimestamp:c.evidence.blockTimestamp,codeHashes:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts},gasBalance:1000n,brainBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n} as SignerObservation;
      const service=new ResultSignatureCoordinator(q,driver,journal,{recovery:c.recovery,proof},authorityReader),args={avatarId:c.avatar,resultId:c.result.id,authorityId:String(authority!.id)};
      const accepted=await service.capture(args,state);expect(accepted.state).toBe('uncertain');expect(calls).toBe(1);
      await q`UPDATE brainchain_delivery_authorities SET revoked_at=clock_timestamp() WHERE id=${deliveryGrant}`;
      const forbidden=async():Promise<never>=>{throw Error('No new key access on restart');};
      const restarted=new ResultSignatureCoordinator(q,{signResult:forbidden},journal,undefined,authorityReader);
      expect((await restarted.capture(args,state)).state).toBe(captured?'captured':'uncertain');
      expect((await restarted.recover(c.avatar,accepted.operationId)).state).toBe(captured?'captured':'uncertain');expect(calls).toBe(1);
    }
  });
  test('replacement hire, missing snapshot, revoked execution and stopped signer refuse',async()=>{
    for(const kind of ['replacement','legacy','revoked','stopped'] as const){const c=await context(kind==='legacy'),authority=await grant(c);
      if(kind==='replacement')await q`UPDATE brainchain_worker_tasks SET hire_tx_hash=${`0x${'c'.repeat(64)}`} WHERE id=${c.task}`;
      if(kind==='revoked')await q`UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE id=${c.authority}`;
      if(kind==='stopped')await q`UPDATE brainchain_signer_streams SET stopped=true WHERE binding_id=${c.binding}`;
      expect(await refusal(()=>c.recovery.claim(c.avatar,c.result.id,authority))).not.toBe('success');
      expect((await q`SELECT consumed_at FROM brainchain_delivery_authorities WHERE id=${authority}`)[0]!.consumed_at).toBeNull();
    }
  });
  test('expiry behind a result lock cannot consume root authority',async()=>{
    const c=await context(),authority=await grant(c,'upload',1500);let acquired!:()=>void,release!:()=>void;
    const locked=new Promise<void>(done=>{acquired=done;}),wait=new Promise<void>(done=>{release=done;});
    const holder=q.begin(async tx=>{await tx`SELECT id FROM brainchain_task_results WHERE id=${c.result.id} FOR UPDATE`;acquired();await wait;});
    await locked;const pending=refusal(()=>c.recovery.claim(c.avatar,c.result.id,authority));await Bun.sleep(1700);release();await holder;
    expect(await pending).toContain('expired');expect((await q`SELECT consumed_at FROM brainchain_delivery_authorities WHERE id=${authority}`)[0]!.consumed_at).toBeNull();
  });
  test('unknown upload has no retry and matching Submitted records reconciliation only',async()=>{
    const unknown=await context(),unknownGrant=await grant(unknown);
    await q`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${unknown.result.id}`;
    await q`UPDATE brainchain_task_results SET state='upload_uncertain' WHERE id=${unknown.result.id}`;
    expect(await refusal(()=>unknown.recovery.claim(unknown.avatar,unknown.result.id,unknownGrant))).toContain('evidence-only');
    const c=await context();c.evidence.status=3;c.evidence.payee=c.address;
    await q`UPDATE brainchain_worker_tasks SET status=3,result_hash=${c.result.result_hash},deadline_unix=EXTRACT(EPOCH FROM clock_timestamp())::bigint-1 WHERE id=${c.task}`;
    const proof=await c.recovery.claim(c.avatar,c.result.id,await grant(c,'reconcile'));
    expect((await c.recovery.reconcileSubmitted(c.avatar,c.result.id,proof)).state).toBe('submitted-observed');
    expect((await c.recovery.reconcileSubmitted(c.avatar,c.result.id,proof)).finalized).toBe(false);
    expect((await q`SELECT * FROM brainchain_delivery_reconciliations WHERE result_id=${c.result.id}`).length).toBe(1);
    expect((await q`SELECT * FROM brainchain_result_submissions WHERE result_id=${c.result.id}`).length).toBe(0);
  });
  test('fresh delivery lease prepares the same output and reserves one submit nonce after compute expiry',async()=>{
    const c=await context(),uri=`https://brain.testnet.usebrainchain.com/records/${c.result.result_hash}.txt`;
    await q`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${c.result.id}`;
    await q`UPDATE brainchain_task_results SET state='uploaded',result_uri=${uri} WHERE id=${c.result.id}`;
    const authority=await grant(c,'prepare-submit'),proof=await c.recovery.claim(c.avatar,c.result.id,authority),delivery=new TaskDeliveryCoordinator(q,undefined,c.recovery,authorityReader);
    const observation={observedAt:new Date(),blockNumber:5000n,blockHash:c.evidence.blockHash,blockTimestamp:c.evidence.blockTimestamp};
    expect((await delivery.prepareSubmission(c.avatar,c.result.id,observation,proof)).signingAvailable).toBe(false);
    const request={kind:'submit' as const,resultId:c.result.id,task:c.hire.snapshot.task,hash:c.result.result_hash,uri},intent=randomUUID(),gas=randomUUID();
    for(const [id,purpose,amount] of [[intent,'submit','0'],[gas,'gas','200']] as const)await q`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${id},${c.binding},${c.avatar},'testnet',274630,${c.address},1,${purpose},${signerRequestHash(request)},${amount},'fixture-root',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const state={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:c.address,signerAddress:c.address,...observation,codeHashes:{},gasBalance:1000n,brainBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n} as SignerObservation;
    const operations=await import('./signer-operations');
    const operation=await operations.prepareSignerOperation({avatarId:c.avatar,bindingId:c.binding,authorityId:intent,gasAuthorityId:gas,idempotencyKey:randomUUID(),request,fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},deliveryProof:proof},state);
    expect((await operations.reserveSignerNonce(operation.id,state,{canonical:0n,pending:0n})).nonce).toBe('0');
    await q`UPDATE brainchain_delivery_authorities SET revoked_at=clock_timestamp() WHERE id=${authority}`;
    expect(await refusal(()=>operations.reserveSignerNonce(operation.id,state,{canonical:0n,pending:0n}))).toContain('delivery lease');
    expect((await q`SELECT nonce FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]!.nonce).toBe('0');
    expect((await q`SELECT result_hash,result_text FROM brainchain_task_results WHERE id=${c.result.id}`)[0]!.result_text).toBe(c.result.result_text);
  });
  test('captured broadcast recovery retains exact nonce and bytes; matching Submitted skips transport',async()=>{
    const policy=await import('./signer-policy');
    const [source]=await q`SELECT result_hash FROM brainchain_task_results LIMIT 1`,taskNumber=BigInt('0x'+randomBytes(12).toString('hex')),resultHash=source!.result_hash as Hex,uri=`https://brain.testnet.usebrainchain.com/records/${resultHash}.txt`;
    const transaction={chainId:274630,type:'eip1559' as const,to:BRAINCHAIN_CONTRACTS.testnet.contracts.board,data:encodeFunctionData({abi:policy.signerAbi,functionName:'submit',args:[taskNumber,resultHash,uri]}),value:0n,nonce:0,gas:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n};
    // Public synthetic signature components only. No private key or signing API is used.
    const bytes=serializeTransaction(transaction,{r:'0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',s:`0x${'1'.padStart(64,'0')}`,yParity:0});
    const address=(await recoverTransactionAddress({serializedTransaction:bytes})).toLowerCase(),c=await context(false,address,taskNumber.toString());
    await q`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${c.result.id}`;
    await q`UPDATE brainchain_task_results SET state='uploaded',result_uri=${uri} WHERE id=${c.result.id}`;
    const initial=await grant(c,'prepare-submit',1500),proof=await c.recovery.claim(c.avatar,c.result.id,initial),delivery=new TaskDeliveryCoordinator(q,undefined,c.recovery,authorityReader);
    const observation={observedAt:new Date(),blockNumber:5000n,blockHash:c.evidence.blockHash,blockTimestamp:c.evidence.blockTimestamp};
    await delivery.prepareSubmission(c.avatar,c.result.id,observation,proof);
    const request={kind:'submit' as const,resultId:c.result.id,task:taskNumber.toString(),hash:resultHash,uri},intent=randomUUID(),gas=randomUUID();
    for(const [id,purpose,amount] of [[intent,'submit','0'],[gas,'gas','200']] as const)await q`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${id},${c.binding},${c.avatar},'testnet',274630,${c.address},1,${purpose},${signerRequestHash(request)},${amount},'fixture-root',clock_timestamp()+interval '1500 milliseconds',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const state={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:c.address,signerAddress:c.address,...observation,codeHashes:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts},gasBalance:1000n,brainBalance:0n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:0n,bond:0n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n} as SignerObservation;
    const operations=await import('./signer-operations'),operation=await operations.prepareSignerOperation({avatarId:c.avatar,bindingId:c.binding,authorityId:intent,gasAuthorityId:gas,idempotencyKey:randomUUID(),request,fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},deliveryProof:proof},state);
    await operations.reserveSignerNonce(operation.id,state,{canonical:0n,pending:0n});
    await q`UPDATE brainchain_signer_operations SET state='accepting',accepted_at=clock_timestamp() WHERE id=${operation.id}`;
    const reference='d'.repeat(64),transactionHash=keccak256(bytes);
    await q`UPDATE brainchain_signer_operations SET state='signed',signed_payload_ref=${reference},transaction_hash=${transactionHash} WHERE id=${operation.id}`;
    await Bun.sleep(1700);
    const [grantRow]=await q`INSERT INTO brainchain_delivery_authorities(result_id,binding_id,avatar_id,environment,chain_id,stage,task_generation,hire_snapshot_hash,result_hash,result_sha256,operation_id,transaction_hash,nonce,gas_ceiling,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${c.result.id},${c.binding},${c.avatar},'testnet',274630,'broadcast',1,${c.hire.hash},${resultHash},${c.result.result_sha256},${operation.id},${transactionHash},0,200,'fixture-root',clock_timestamp()+interval '1500 milliseconds',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
    const broadcastProof=await c.recovery.claim(c.avatar,c.result.id,String(grantRow!.id));
    mock.module('./signer-policy',()=>({...policy,assertSignerArtifactAdmission:policy.assertObservedSignerCode}));
    const service=await import('./signer-service');let sends=0;
    const store={async get(ref:string){expect(ref).toBe(reference);return bytes;},async findByOperation(){return{reference,bytes};},async putIfAbsent(){throw Error('no capture');},async claimKeyUse(){throw Error('no key');}};
    const transport={async assertTestnet(){},async broadcastSameBytes(value:Hex){sends++;expect(value).toBe(bytes);return transactionHash;}};
    const recovery={recovery:c.recovery,avatarId:c.avatar,resultId:c.result.id,proof:broadcastProof};
    expect((await service.broadcastCapturedOperation(operation.id,state,store,transport,recovery,authorityReader)).state).toBe('broadcast');expect(sends).toBe(1);
    c.evidence.status=3;c.evidence.payee=c.address;
    expect((await service.broadcastCapturedOperation(operation.id,state,store,transport,recovery,authorityReader)).state).toBe('submitted-observed');expect(sends).toBe(1);
    expect((await q`SELECT nonce,signed_payload_ref FROM brainchain_signer_operations WHERE id=${operation.id}`)[0]).toEqual({nonce:'0',signed_payload_ref:reference});
    let acquired!:()=>void,release!:()=>void;const locked=new Promise<void>(done=>{acquired=done;}),wait=new Promise<void>(done=>{release=done;});
    const holder=q.begin(async tx=>{await tx`SELECT id FROM brainchain_signer_operations WHERE id=${operation.id} FOR UPDATE`;acquired();await wait;});
    await locked;const delayed=refusal(()=>c.recovery.checkBroadcast(c.avatar,c.result.id,broadcastProof,operation.id));await Bun.sleep(1700);release();await holder;
    expect(await delayed).toContain('Configured authority consumer deadline');expect(sends).toBe(1);
  });
});

