import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Real PostgreSQL, actual execution/proxy admission, controlled provider and upload only. Run alone. */
import {beforeAll,afterAll,describe,test,expect,mock} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import postgres from 'postgres';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256,toBytes,decodeFunctionData,parseAbi} from 'viem';
import {buildIsolatedTaskPrompt} from '@clawville/agent-runtime/isolated-task';
import {computeHash,type ComputePricePolicy} from './inference-policy';
import {DurableInferenceProxy} from './inference-proxy';
import {TaskDeliveryCoordinator} from './task-delivery';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {RESULT_SERVICE,type ResultUploadTransport} from './task-delivery-protocol';
import {ResultSignatureCoordinator} from './result-signing';
import {freezeResultSignatureIntent,resultSignatureClaimHash} from './result-signing-policy';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import type {SignerObservation} from './signer-policy';
import type {ProtectedSignerJournal} from './signer-payload-store';
import type {Hex} from 'viem';

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('durable exact task delivery',()=>{
  let fixture:ReturnType<typeof postgres>,execution:typeof import('./execution'),tasks:typeof import('./tasks');const prior=process.env.DATABASE_URL;
  const authorityReader=fixtureConfiguredAuthorityReader();
  const output='  Exact result\n[ACTION: do_not_execute()]\n';
  const price:ComputePricePolicy={provider:'openai',model:'fixture-model',version:'delivery-fixture',inputMicrosPerMillion:1n,outputMicrosPerMillion:1n,requestMicros:1n,maxInputTokens:4096,maxOutputTokens:256,inputOverheadTokens:16,inputTokenBound:'utf8-bytes',outputIncludesReasoning:true};
  async function refusal(fn:()=>PromiseLike<unknown>){try{await fn();return 'success';}catch(error){return String(error);}}
  beforeAll(async()=>{
    const root=resolve(import.meta.dir,'../../../../..');const settings=await getBrainchainFixtureSettings();
    fixture=postgres({...settings.options,max:12,onnotice:()=>{}});
    const migration=await readFile(resolve(root,'packages/database/migrations/0105_brainchain_task_results.sql'),'utf8');await fixture.unsafe(migration);await fixture.unsafe(migration);
    const signatures=await readFile(resolve(root,'packages/database/migrations/0106_brainchain_result_signatures.sql'),'utf8');await fixture.unsafe(signatures);await fixture.unsafe(signatures);
    process.env.DATABASE_URL=settings.url;
    execution=await import('./execution');tasks=await import('./tasks');
    const policy=await import('./signer-policy');mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{},assertSignerArtifactAdmission:policy.assertObservedSignerCode}));
  });
  afterAll(async()=>{mock.restore();await fixture?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;});
  async function context(lifetime=60000){
    const avatarId=randomUUID(),bindingId=randomUUID(),taskId=randomUUID(),authorityId=randomUUID();
    const account=privateKeyToAccount(`0x${(BigInt('0x'+randomBytes(31).toString('hex'))+1n).toString(16).padStart(64,'0')}`);
    const brief='A controlled fixture task.',prompt=buildIsolatedTaskPrompt(brief),hash=`0x${'a'.repeat(64)}`;
    await fixture`INSERT INTO avatars(id) VALUES(${avatarId})`;
    await fixture`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${bindingId},${avatarId},'testnet',274630,${account.address.toLowerCase()},${'b'.repeat(64)},'running')`;
    await fixture`INSERT INTO brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id,board_address,task_id,manifest_hash,hire_block,hire_block_hash,hire_tx_hash,hire_log_index,observed_block,observed_block_hash,status,bounty_atomic,deadline_unix,brief_hash,result_hash)
      VALUES(${taskId},${bindingId},${avatarId},'testnet',274630,${BRAINCHAIN_CONTRACTS.testnet.contracts.board},${BigInt('0x'+randomBytes(12).toString('hex')).toString()},${'c'.repeat(64)},2288,${hash},${hash},0,5000,${hash},2,1,${Math.floor(Date.now()/1000)+3600},${keccak256(toBytes(brief))},${hash})`;
    await fixture`INSERT INTO brainchain_execution_authorities(id,task_id,binding_id,avatar_id,environment,chain_id,generation,brief_hash,input_hash,prompt_hash,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${authorityId},${taskId},${bindingId},${avatarId},'testnet',274630,1,${keccak256(toBytes(brief))},${computeHash(brief)},${computeHash(prompt)},'fixture-only',clock_timestamp()+${lifetime}*interval '1 millisecond',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const configured=await authorityReader({deadlineMs:Date.now()+2000});
    const {authorityPolicyVersion: _version,authorityPolicyDigest: _digest,...observation}=configured;
    const attempt=await execution.claimExecutionAttempt({avatarId,taskId,authorityId,brief,prompt,observation:configured},authorityReader);
    const proxy=new DurableInferenceProxy(fixture,[price],[{provider:'openai',async generate(){return{text:output,inputTokens:10,outputTokens:10};}}],{async verifyReservation(){}},undefined,authorityReader);
    const envelope=await proxy.approveEnvelope({jobId:randomUUID(),provider:'openai',rootReservationId:randomUUID(),approvalRef:'fixture',limitMicros:100n,expiresAt:new Date(Date.now()+60000)});
    const reserve=await proxy.reserve({envelopeId:envelope.id,avatarId,taskId,attemptId:attempt.id,leaseOwner:attempt.leaseOwner,generation:attempt.generation,model:price.model,pricingVersion:price.version,prompt,maxInputTokens:2048,maxOutputTokens:32,deadlineMs:Math.min(Date.now()+30000,attempt.leaseUntil.getTime()-50)});
    await proxy.dispatch(reserve.capability,{binding:reserve.binding,prompt},new AbortController().signal);
    return{account,bindingId,observation,input:{avatarId,taskId,attemptId:attempt.id,callId:reserve.binding.callId,generation:attempt.generation,leaseOwner:attempt.leaseOwner}};
  }
  test('concurrent freezes reuse one exact settled output and reject direct mutation',async()=>{
    const c=await context(),service=new TaskDeliveryCoordinator(fixture,undefined,undefined,authorityReader);
    const rows=await Promise.all(Array.from({length:6},()=>service.freeze(c.input)));
    expect(new Set(rows.map(row=>row.id)).size).toBe(1);expect(rows[0]!.result_text).toBe(output);expect(rows[0]!.result_hash).toBe(keccak256(toBytes(output)));
    expect(await refusal(()=>fixture`UPDATE brainchain_task_results SET result_text='changed' WHERE id=${rows[0]!.id}`)).toContain('immutable');
    expect(await refusal(()=>service.freeze({...c.input,callId:randomUUID()}))).toContain('different frozen');
    expect(await refusal(()=>service.read(randomUUID(),rows[0]!.id))).toContain('owner mismatch');
    expect(await refusal(()=>service.prepareSubmission(c.input.avatarId,rows[0]!.id,c.observation))).toContain('Verified upload');
    const foreign=await context();
    expect(await refusal(()=>fixture`INSERT INTO brainchain_task_results(task_id,binding_id,avatar_id,environment,chain_id,attempt_id,call_id,generation,lease_owner,prompt_hash,result_text,result_sha256,result_hash)
      SELECT ${foreign.input.taskId},${foreign.bindingId},${foreign.input.avatarId},'testnet',274630,${foreign.input.attemptId},${c.input.callId},${foreign.input.generation},${foreign.input.leaseOwner},a.prompt_hash,${output},${rows[0]!.result_sha256},${rows[0]!.result_hash}
      FROM brainchain_task_attempts a WHERE a.id=${foreign.input.attemptId}`)).not.toBe('success');
  });
  test('one upload claim preserves exact bytes and prepares only pinned submit calldata',async()=>{
    let count=0,entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{entered=done;}),resume=new Promise<void>(done=>{release=done;});
    const transport:ResultUploadTransport={async upload(input){count++;expect(input.text).toBe(output);entered();await resume;return{hash:input.hash,uri:`${RESULT_SERVICE}/records/${input.hash}.txt`};}};
    const c=await context(),service=new TaskDeliveryCoordinator(fixture,transport,undefined,authorityReader),row=await service.freeze(c.input);
    const authorization=await service.uploadAuthorization(c.input.avatarId,row.id),signature=await c.account.signMessage({message:authorization.message});
    const first=service.upload(c.input.avatarId,row.id,signature);await started;
    expect(await refusal(()=>service.upload(c.input.avatarId,row.id,signature))).toContain('already claimed');release();expect((await first).state).toBe('uploaded');expect(count).toBe(1);
    const prepared=await service.prepareSubmission(c.input.avatarId,row.id,c.observation);
    expect(prepared.signingAvailable).toBe(false);expect(prepared.intent.to).toBe(BRAINCHAIN_CONTRACTS.testnet.contracts.board);
    const decoded=decodeFunctionData({abi:parseAbi(['function submit(uint256,bytes32,string)']),data:prepared.intent.data});
    expect(decoded.args[1]).toBe(row.result_hash);expect(decoded.args[2]).toBe(`${RESULT_SERVICE}/records/${row.result_hash}.txt`);
  });
  test('uncertain upload cannot retry; reorg preserves output but removes action authority',async()=>{
    let calls=0;const c=await context(),service=new TaskDeliveryCoordinator(fixture,{async upload(){calls++;throw Error('controlled unknown response');}},undefined,authorityReader),row=await service.freeze(c.input);
    const authorization=await service.uploadAuthorization(c.input.avatarId,row.id),signature=await c.account.signMessage({message:authorization.message});
    expect((await service.upload(c.input.avatarId,row.id,signature)).state).toBe('upload_uncertain');
    expect(await refusal(()=>service.upload(c.input.avatarId,row.id,signature))).toContain('already claimed');expect(calls).toBe(1);
    await tasks.suspendOrphanedBoard(c.input.avatarId,c.bindingId,BRAINCHAIN_CONTRACTS.testnet.contracts.board,2288n);
    expect((await service.freeze(c.input)).result_text).toBe(output);
    expect(await refusal(()=>service.uploadAuthorization(c.input.avatarId,row.id))).toContain('execution fence');
    expect(await refusal(()=>service.prepareSubmission(c.input.avatarId,row.id,c.observation))).toContain('execution fence');
  });
  test('foreign tuple and expiry during a task lock wait refuse result freezing',async()=>{
    const c=await context(1800),service=new TaskDeliveryCoordinator(fixture,undefined,undefined,authorityReader);
    expect(await refusal(()=>service.freeze({...c.input,leaseOwner:randomUUID()}))).toContain('execution fence');
    let acquired!:()=>void,release!:()=>void;const locked=new Promise<void>(done=>{acquired=done;}),resume=new Promise<void>(done=>{release=done;});
    const holder=fixture.begin(async tx=>{await tx`SELECT id FROM brainchain_worker_tasks WHERE id=${c.input.taskId} FOR UPDATE`;acquired();await resume;});
    await locked;const pending=refusal(()=>service.freeze(c.input));await Bun.sleep(1900);release();await holder;
    expect(await pending).toContain('execution fence');expect((await fixture`SELECT id FROM brainchain_task_results WHERE task_id=${c.input.taskId}`).length).toBe(0);
  });
  for(const action of ['upload','prepare'] as const)test(`${action} refuses expiry during a result lock wait`,async()=>{
    let calls=0;
    const c=await context(2000),service=new TaskDeliveryCoordinator(fixture,{async upload(input){calls++;return{hash:input.hash,uri:`${RESULT_SERVICE}/records/${input.hash}.txt`};}},undefined,authorityReader);
    const row=await service.freeze(c.input),authorization=await service.uploadAuthorization(c.input.avatarId,row.id);
    const signature=await c.account.signMessage({message:authorization.message});
    if(action==='prepare'){
      await fixture`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${row.id}`;
      await fixture`UPDATE brainchain_task_results SET state='uploaded',result_uri=${`${RESULT_SERVICE}/records/${row.result_hash}.txt`} WHERE id=${row.id}`;
    }
    let acquired!:()=>void,release!:()=>void;const locked=new Promise<void>(done=>{acquired=done;}),resume=new Promise<void>(done=>{release=done;});
    const holder=fixture.begin(async tx=>{await tx`SELECT id FROM brainchain_task_results WHERE id=${row.id} FOR UPDATE`;acquired();await resume;});
    await locked;
    const pending=refusal(()=>action==='upload'?service.upload(c.input.avatarId,row.id,signature):service.prepareSubmission(c.input.avatarId,row.id,c.observation));
    await Bun.sleep(2200);release();await holder;
    expect(await pending).toContain('execution fence');expect(calls).toBe(0);
    const persisted=await service.read(c.input.avatarId,row.id);
    expect(persisted.state).toBe(action==='upload'?'frozen':'uploaded');expect(persisted.submission).toBeNull();
    if(action==='upload')expect(persisted.upload_token).toBeNull();
  });
  for(const loss of ['revoked','generation'] as const)test(`${loss} authority refuses upload and preparation but preserves reads`,async()=>{
    let calls=0;const c=await context(),service=new TaskDeliveryCoordinator(fixture,{async upload(){calls++;throw Error('must not dispatch');}},undefined,authorityReader);
    const row=await service.freeze(c.input),authorization=await service.uploadAuthorization(c.input.avatarId,row.id);
    const signature=await c.account.signMessage({message:authorization.message});
    if(loss==='revoked')await fixture`UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE task_id=${c.input.taskId}`;
    else await fixture`UPDATE brainchain_worker_tasks SET lease_generation=lease_generation+1 WHERE id=${c.input.taskId}`;
    expect(await refusal(()=>service.upload(c.input.avatarId,row.id,signature))).toContain('execution fence');
    expect(await refusal(()=>service.prepareSubmission(c.input.avatarId,row.id,c.observation))).toContain('execution fence');
    expect(calls).toBe(0);expect((await service.read(c.input.avatarId,row.id)).result_text).toBe(output);
  });
  test('typed signature acceptance captures once and recovers after revocation without key reuse',async()=>{
    const c=await context(),delivery=new TaskDeliveryCoordinator(fixture,undefined,undefined,authorityReader),row=await delivery.freeze(c.input),reference=`brainchain-testnet:${randomUUID()}`;
    await fixture`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce)
      VALUES(${c.bindingId},${c.input.avatarId},'testnet',274630,${c.account.address.toLowerCase()},${reference},0)`;
    const [task]=await fixture`SELECT task_id FROM brainchain_worker_tasks WHERE id=${c.input.taskId}`;
    const intent=freezeResultSignatureIntent({domain:'brainchain-result-v2',chainId:274630,resultId:row.id,board:BRAINCHAIN_CONTRACTS.testnet.contracts.board,task:String(task!.task_id),hash:row.result_hash,worker:c.account.address.toLowerCase()});
    const authorityId=randomUUID();
    await fixture`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${authorityId},${c.bindingId},${c.input.avatarId},'testnet',274630,${intent.worker},1,'result-signature',${resultSignatureClaimHash(reference,intent)},0,'fixture',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const state:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:intent.worker,signerAddress:intent.worker,observedAt:new Date(),blockTimestamp:c.observation.blockTimestamp,blockHash:c.observation.blockHash as Hex,codeHashes:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts},brainBalance:1000n,gasBalance:10000n,staked:500n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:86400n};
    const claims=new Map<string,string>(),captures=new Map<string,{reference:string;bytes:Hex}>();
    const journal:ProtectedSignerJournal={async claimKeyUse(id,hash){if(claims.has(id)){if(claims.get(id)!==hash)throw Error('changed claim');return false;}claims.set(id,hash);return true;},async claimDriverUse(){return true;},async putIfAbsent(id,bytes){const prior=captures.get(id);if(prior&&prior.bytes!==bytes)throw Error('changed bytes');captures.set(id,{reference:computeHash(bytes),bytes});return computeHash(bytes);},async findByOperation(id){return captures.get(id)??null;},async get(ref){const value=[...captures.values()].find(value=>value.reference===ref);if(!value)throw Error('absent');return value.bytes;}};
    let calls=0;
    const signer=new ResultSignatureCoordinator(fixture,{async signResult(id,_reference,_intent,assertCurrent){calls++;await assertCurrent();const authorization=await delivery.uploadAuthorization(c.input.avatarId,row.id);const signature=await c.account.signMessage({message:authorization.message});await journal.putIfAbsent(id,signature);throw Error('simulated crash after protected capture');}},journal,undefined,authorityReader);
    const args={avatarId:c.input.avatarId,resultId:row.id,authorityId};
    const results=await Promise.all([signer.capture(args,state),signer.capture(args,state)]);
    expect(new Set(results.map(value=>value.operationId)).size).toBe(1);expect(calls).toBe(1);
    const recovered=await signer.recover(c.input.avatarId,results[0]!.operationId);expect(recovered.state).toBe('captured');
    await fixture`UPDATE brainchain_signer_authorities SET revoked_at=clock_timestamp() WHERE id=${authorityId}`;
    expect((await signer.capture(args,state)).state).toBe('captured');expect(calls).toBe(1);
    expect((await signer.signatureForUpload(c.input.avatarId,recovered.operationId)).length).toBe(132);
    expect(await refusal(()=>signer.recover(randomUUID(),recovered.operationId))).toContain('owner mismatch');
    expect(await refusal(()=>fixture`UPDATE brainchain_result_signatures SET intent='{}'::jsonb WHERE id=${recovered.operationId}`)).toContain('immutable');
    await fixture`UPDATE brainchain_task_results SET state='uploading',upload_token=${randomUUID()},upload_started_at=clock_timestamp() WHERE id=${row.id}`;
    const uri=`${RESULT_SERVICE}/records/${row.result_hash}.txt`;
    await fixture`UPDATE brainchain_task_results SET state='uploaded',result_uri=${uri} WHERE id=${row.id}`;
    await delivery.prepareSubmission(c.input.avatarId,row.id,c.observation);
    const policy=await import('./signer-policy'),operations=await import('./signer-operations');
    const request={kind:'submit' as const,resultId:row.id,task:intent.task,hash:intent.hash,uri},submitId=randomUUID(),gasId=randomUUID();
    for(const [id,purpose,amount] of [[submitId,'submit','0'],[gasId,'gas','200']] as const)await fixture`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${id},${c.bindingId},${c.input.avatarId},'testnet',274630,${intent.worker},1,${purpose},${policy.signerRequestHash(request)},${amount},'fixture',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const prepared=await operations.prepareSignerOperation({avatarId:c.input.avatarId,bindingId:c.bindingId,authorityId:submitId,gasAuthorityId:gasId,idempotencyKey:randomUUID(),request,fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n}},state);
    expect(prepared.kind).toBe('submit');
    const reserved=await operations.reserveSignerNonce(prepared.id,state,{canonical:0n,pending:0n});expect(reserved.nonce).toBe('0');
    expect(await refusal(()=>fixture`UPDATE brainchain_result_submissions SET result_id=${randomUUID()} WHERE operation_id=${prepared.id}`)).toContain('immutable');
    const signerService=await import('./signer-service');let transactionCalls=0;
    const captured=await signerService.captureSignerOperation({operationId:prepared.id,observation:state,nonces:{canonical:0n,pending:0n},store:journal,authorityReader,
      driver:{async addressForReference(){return intent.worker;},async signTransaction(id,_ref,transaction,authority){transactionCalls++;expect(authority?.result?.resultId).toBe(row.id);await authority!.assertCurrent();const bytes=await c.account.signTransaction(transaction);await journal.putIfAbsent(id,bytes);return bytes;}}});
    expect(captured.state).toBe('signed');expect(transactionCalls).toBe(1);
    await fixture`UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE task_id=${c.input.taskId}`;
    expect(await refusal(()=>signerService.assertCurrentSubmitOperation(prepared.id,state))).toContain('Current frozen submit');
    expect((await signerService.recoverCapturedOperation(prepared.id,journal)).transactionHash).toBe(captured.transactionHash);
    expect(transactionCalls).toBe(1);
    expect((await fixture`SELECT nonce FROM brainchain_signer_operations WHERE id=${prepared.id}`)[0]!.nonce).toBe('0');
  });
});
