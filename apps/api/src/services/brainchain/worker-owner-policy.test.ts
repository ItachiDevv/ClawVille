import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import postgres from 'postgres';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {WorkerOwnerPolicies,workerPolicyHash,policyNarrows,type WorkerOwnerPolicy,type WorkerPolicyOwner} from './worker-owner-policy';
import {WorkerAuthorityIssuer} from './worker-authority-issuer';
import type {SignerObservation} from './signer-policy';
import {DurableInferenceProxy} from './inference-proxy';
import {buildIsolatedTaskPrompt} from '@clawville/agent-runtime/isolated-task';
import {keccak256,toBytes} from 'viem';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import type {WorkerComputeAssignment} from './worker-authority-issuer';
import {drizzle} from 'drizzle-orm/postgres-js';
import {WorkerJobs} from './worker-jobs';

const payload=():WorkerOwnerPolicy=>({environment:'testnet',chainId:274630,actions:['faucet','stake'],taskKinds:['text-writing'],maxStakeAtomic:'500',maxBondAtomic:'100',maxBrainTotalAtomic:'600',priceAtomic:'1000000',maxGasPerOperationWei:'100',maxGasTotalWei:'1000',maxTasks:1,openaiMicros:'100000',openrouterMicros:'0',expiresAt:new Date(Date.now()+600000).toISOString()});
test('canonical policy hash binds every cap and permits only exact narrowing',()=>{
  const base=payload();expect(workerPolicyHash(base)).toBe(workerPolicyHash({...base,actions:[...base.actions].reverse()}));
  for(const key of ['maxStakeAtomic','maxBondAtomic','maxBrainTotalAtomic','priceAtomic','maxGasPerOperationWei','maxGasTotalWei','openaiMicros','openrouterMicros'] as const){
    const increased={...base,[key]:(BigInt(base[key])+1n).toString()};expect(workerPolicyHash(increased)).not.toBe(workerPolicyHash(base));expect(policyNarrows(increased,base)).toBe(false);
  }
  expect(policyNarrows({...base,maxTasks:0,actions:['faucet'],taskKinds:[]},base)).toBe(true);
});

const authorityReader=fixtureConfiguredAuthorityReader();

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('Worker owner grants with real PostgreSQL',()=>{
  let sql:ReturnType<typeof postgres>,service:WorkerOwnerPolicies;
  const oldEnvironment=process.env.CLAWVILLE_ENV;
  const oldDatabase=process.env.DATABASE_URL;
  beforeAll(async()=>{
    const settings=await getBrainchainFixtureSettings();sql=postgres({...settings.options,max:8,onnotice:()=>{}});process.env.DATABASE_URL=settings.url;
    const migration=await readFile(new URL('../../../../../packages/database/migrations/0110_brainchain_worker_owner_policy.sql',import.meta.url),'utf8');
    await sql.unsafe(migration);await sql.unsafe(migration);service=new WorkerOwnerPolicies(sql);process.env.CLAWVILLE_ENV='staging';
  });
  afterAll(async()=>{await sql?.end();if(oldEnvironment===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=oldEnvironment;if(oldDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldDatabase;});
  async function fixture(){
    const userId=randomUUID(),avatarId=randomUUID(),workerId=randomUUID(),wallet=nacl.sign.keyPair();
    await sql`INSERT INTO users(id,is_guest,linked_wallet_pubkey) VALUES(${userId},false,${bs58.encode(wallet.publicKey)})`;
    await sql`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;
    await sql`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash) VALUES(${workerId},${avatarId},'testnet',274630,${'0x'+randomBytes(20).toString('hex')},${'a'.repeat(64)})`;
    const owner:WorkerPolicyOwner={userId,avatarId,actor:'human',assertCurrent:async()=>{}};
    return{userId,avatarId,workerId,wallet,owner};
  }
  async function refusal(fn:()=>PromiseLike<unknown>){try{await fn();return 'unexpected success';}catch(error){return String(error);}}
  async function proof(f:Awaited<ReturnType<typeof fixture>>,policyId:string){
    const challenge=await service.challenge(f.owner,f.workerId,policyId);
    return{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),f.wallet.secretKey))};
  }
  test('agents request and narrow but cannot approve; concurrent proof consumes once',async()=>{
    const f=await fixture(),agent={...f.owner,actor:'agent' as const},policy=await service.request(agent,f.workerId,payload());
    expect(await refusal(()=>service.challenge(agent,f.workerId,policy.id))).toContain('Human owner');
    const signed=await proof(f,policy.id);
    expect(await refusal(()=>service.approve(agent,f.workerId,policy.id,signed))).toContain('Human owner');
    const outcomes=await Promise.allSettled(Array.from({length:4},()=>service.approve(f.owner,f.workerId,policy.id,signed)));
    expect(outcomes.filter(value=>value.status==='fulfilled')).toHaveLength(1);
    const smaller={...policy.policy,maxTasks:0};
    expect((await service.narrow(agent,f.workerId,{policyId:policy.id,revision:policy.revision,policy:smaller})).state).toBe('active');
    expect(await refusal(()=>service.approve(f.owner,f.workerId,policy.id,signed))).not.toBe('unexpected success');
  });
  test('wallet rotation revokes proof and retained policy without erasing liabilities',async()=>{
    const f=await fixture(),policy=await service.request(f.owner,f.workerId,payload());
    await service.approve(f.owner,f.workerId,policy.id,await proof(f,policy.id));
    await sql`UPDATE brainchain_worker_policy_budgets SET gas_committed=50 WHERE binding_id=${f.workerId}`;
    await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(nacl.sign.keyPair().publicKey)} WHERE id=${f.userId}`;
    const current=await service.get(f.owner,f.workerId);expect(current.policy?.state).toBe('revoked');expect(String(current.liabilities?.gas_committed)).toBe('50');
    await sql`UPDATE users SET linked_wallet_pubkey=${bs58.encode(f.wallet.publicKey)} WHERE id=${f.userId}`;
    expect((await service.get(f.owner,f.workerId)).policy?.state).toBe('revoked');
    expect(await new WorkerJobs(sql).claim(f.workerId)).toBeNull();
    expect(await refusal(()=>new WorkerAuthorityIssuer(sql,authorityReader).resultSignature(f.workerId,policy.id,randomUUID()))).toContain('Current proved owner policy');
    expect(await refusal(()=>sql`UPDATE brainchain_worker_policy_budgets SET gas_committed=0 WHERE binding_id=${f.workerId}`)).toContain('retained');
    expect(await refusal(()=>sql`DELETE FROM brainchain_worker_policies WHERE id=${policy.id}`)).toContain('retained');
  });
  test('expiry during the final session await refuses proof and rolls back consumption',async()=>{
    const f=await fixture(),policy=await service.request(f.owner,f.workerId,{...payload(),expiresAt:new Date(Date.now()+1500).toISOString()}),signed=await proof(f,policy.id);
    let reads=0;f.owner.assertCurrent=async()=>{if(++reads===2)await Bun.sleep(1700);};
    expect(await refusal(()=>service.approve(f.owner,f.workerId,policy.id,signed))).toContain('expired');
    const [row]=await sql`SELECT consumed_at FROM brainchain_worker_policy_challenges WHERE nonce_hash=${createHash('sha256').update(signed.nonce).digest('hex')}`;
    expect(row!.consumed_at).toBeNull();expect((await service.get({...f.owner,assertCurrent:async()=>{}},f.workerId)).policy?.state).toBe('requested');
  });
  test('wrong wallet and final session revocation cannot activate policy',async()=>{
    const f=await fixture(),policy=await service.request(f.owner,f.workerId,payload()),signed=await proof(f,policy.id);
    expect(await refusal(()=>service.approve(f.owner,f.workerId,policy.id,{...signed,signature:bs58.encode(new Uint8Array(64).fill(1))}))).toContain('Invalid owner proof');
    let reads=0;f.owner.assertCurrent=async()=>{if(++reads===2)throw Error('session revoked');};
    expect(await refusal(()=>service.approve(f.owner,f.workerId,policy.id,signed))).toContain('session revoked');
    expect((await service.get({...f.owner,assertCurrent:async()=>{}},f.workerId)).policy?.state).toBe('requested');
  });
  test('concurrent issuer holds the cumulative cap once and pause revokes derived grants',async()=>{
    const f=await fixture(),policy=await service.request(f.owner,f.workerId,{...payload(),maxGasTotalWei:'100'});
    await service.approve(f.owner,f.workerId,policy.id,await proof(f,policy.id));
    const [binding]=await sql`SELECT address FROM brainchain_worker_bindings WHERE id=${f.workerId}`;
    await sql`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,generation,next_nonce) VALUES(${f.workerId},${f.avatarId},'testnet',274630,${binding!.address},${'brainchain-testnet:fixture-policy-'+randomUUID()},1,0)`;
    const observation:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:binding!.address,signerAddress:binding!.address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'a'.repeat(64)}`,codeHashes:{},brainBalance:1000n,gasBalance:1000n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:1n};
    const issuer=new WorkerAuthorityIssuer(sql,authorityReader),input={workerId:f.workerId,policyId:policy.id,actionKey:'fixture-faucet',request:{kind:'faucet'},fees:{gasLimit:100n,maxFeePerGas:1n,maxPriorityFeePerGas:0n}};
    const results=await Promise.all(Array.from({length:4},()=>issuer.lifecycle(input,observation)));
    expect(new Set(results.map(row=>row.id)).size).toBe(1);
    expect(String((await service.get(f.owner,f.workerId)).liabilities?.gas_committed)).toBe('100');
    expect(await refusal(()=>issuer.lifecycle({...input,actionKey:'second-faucet'},observation))).toContain('gas cap');
    expect(await refusal(()=>issuer.lifecycle(input,{...observation,observationPolicy:'nitro-testnet-latest-v1'}))).toContain('action key conflict');
    expect(await refusal(()=>sql`UPDATE brainchain_signer_authorities SET observation_policy='nitro-testnet-latest-v1' WHERE id=${results[0]!.signer_authority_id}`)).not.toBe('unexpected success');
    expect((await sql`SELECT observation_policy FROM brainchain_signer_authorities WHERE id=${results[0]!.signer_authority_id}`)[0]!.observation_policy).toBe('legacy-depth12-age120-v1');
    await service.control({...f.owner,actor:'agent'},f.workerId,{policyId:policy.id,revision:policy.revision,action:'pause'});
    const grants=await sql`SELECT revoked_at FROM brainchain_signer_authorities WHERE id IN (${results[0]!.signer_authority_id},${results[0]!.gas_authority_id})`;
    expect(grants).toHaveLength(2);expect(grants.every(row=>row.revoked_at!==null)).toBe(true);
    expect(await refusal(()=>issuer.lifecycle(input,observation))).toContain('Current proved owner');
    expect(String((await service.get(f.owner,f.workerId)).liabilities?.gas_committed)).toBe('100');
  });
  test('canonical retained Drizzle pool admits, reserves, dispatches and settles without replay or lost uncertainty',async()=>{
    const {claimExecutionAttempt}=await import('./execution');
    const {getPostgresClient}=await import('@clawville/database');const shared=getPostgresClient();
    expect(typeof (await shared`SELECT clock_timestamp() AS now`)[0]!.now).toBe('string');
    for(const mode of ['mapping','revoked','replay','expiry','unknown','root-timeout','current-timeout','post-timeout','shared-timeout'] as const){
      const f=await fixture(),policy=await service.request(f.owner,f.workerId,payload());
      await service.approve(f.owner,f.workerId,policy.id,await proof(f,policy.id));
      await sql`UPDATE brainchain_worker_bindings SET requested_state='running' WHERE id=${f.workerId}`;
      const taskId=randomUUID(),brief=JSON.stringify({kind:'text-writing',instructions:'Return a brief fixture sentence.'}),prompt=buildIsolatedTaskPrompt(brief),hash=`0x${'a'.repeat(64)}`;
      await sql`INSERT INTO brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id,board_address,task_id,manifest_hash,hire_block,hire_block_hash,hire_tx_hash,hire_log_index,observed_block,observed_block_hash,status,bounty_atomic,deadline_unix,brief_hash,result_hash)
        VALUES(${taskId},${f.workerId},${f.avatarId},'testnet',274630,${BRAINCHAIN_CONTRACTS.testnet.contracts.board},${BigInt('0x'+randomBytes(12).toString('hex')).toString()},${'a'.repeat(64)},1,${hash},${hash},0,5000,${hash},2,1,${Math.floor(Date.now()/1000)+3600},${keccak256(toBytes(brief))},${'0x'+'0'.repeat(64)})`;
      let calls=0,delay=false,rootReads=0,readSignal:AbortSignal|undefined,releaseRead!:()=>void;
      const gate=new Promise<void>(resolve=>{releaseRead=resolve;});
      const root={verifyReservation:async(_approval:unknown,signal?:AbortSignal)=>{
        if(delay){rootReads++;if(mode==='shared-timeout'&&rootReads===2)await Bun.sleep(1200);if((mode==='root-timeout'&&rootReads===2)||(mode==='post-timeout'&&rootReads===4)){readSignal=signal;await gate;}}
      }};
      const price={provider:'openai' as const,model:'owner-fixture',version:'v1',inputMicrosPerMillion:1000000n,outputMicrosPerMillion:1000000n,requestMicros:1n,maxInputTokens:4096,maxOutputTokens:32,inputOverheadTokens:16,inputTokenBound:'utf8-bytes' as const,outputIncludesReasoning:true as const};
      const adapter={provider:'openai' as const,generate:async()=>{calls++;if(mode==='unknown')throw Error('unknown fixture outcome');return{text:'Fixture output.',inputTokens:20,outputTokens:4};}};
      const bootstrap=new DurableInferenceProxy(shared,[price],[adapter],root,undefined,authorityReader),jobId=randomUUID(),rootReservationId=randomUUID();
      const approval={jobId,provider:'openai' as const,rootReservationId,approvalRef:'no-charge-fixture',limitMicros:100000n,expiresAt:new Date(Date.now()+120000)};
      const envelope=await bootstrap.approveEnvelope(approval);expect(await bootstrap.approveEnvelope(approval)).toEqual(envelope);
      let assignment:WorkerComputeAssignment={jobId,provider:'openai',rootReservationId,envelopeId:envelope.id,workerId:f.workerId,avatarId:f.avatarId,policyHash:policy.policyHash,perTaskMicros:'10000',expiresAt:new Date(Date.now()+(mode==='expiry'?1500:90000)).toISOString(),generation:1};
      const trusted={root,current:async(signal?:AbortSignal)=>{if(delay&&mode==='expiry')await Bun.sleep(1700);if(delay&&['current-timeout','shared-timeout'].includes(mode)){readSignal=signal;await gate;}return assignment;}};
      const issuer=new WorkerAuthorityIssuer(shared,authorityReader),issued=await issuer.execution({workerId:f.workerId,policyId:policy.id,taskId,brief},trusted);
      const attempt=await claimExecutionAttempt({avatarId:f.avatarId,taskId,authorityId:issued.execution_authority_id,brief,prompt,observation:await authorityReader({deadlineMs:Date.now()+2000})},authorityReader);
      const proxy=new DurableInferenceProxy(shared,[price],[adapter],root,issuer.computeFence(trusted),authorityReader);
      const input={envelopeId:envelope.id,avatarId:f.avatarId,taskId,attemptId:attempt.id,generation:attempt.generation,leaseOwner:attempt.leaseOwner,model:price.model,pricingVersion:price.version,prompt,maxInputTokens:4096,maxOutputTokens:32,deadlineMs:attempt.leaseUntil.getTime()-1};
      expect(await refusal(()=>bootstrap.reserve(input))).not.toBe('unexpected success');
      const reserved=await proxy.reserve(input),request={binding:reserved.binding,prompt};
      expect(await refusal(()=>bootstrap.dispatch(reserved.capability,request,new AbortController().signal))).not.toBe('unexpected success');
      if(mode==='mapping')assignment={...assignment,generation:2};
      if(mode==='revoked')await service.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'revoke'});
      if(['expiry','root-timeout','current-timeout','post-timeout','shared-timeout'].includes(mode))delay=true;
      if(['root-timeout','current-timeout','post-timeout','shared-timeout'].includes(mode)){
        const started=performance.now();
        if(mode==='post-timeout')expect((await proxy.dispatch(reserved.capability,request,new AbortController().signal)).state).toBe('uncertain');
        else expect(await refusal(()=>proxy.dispatch(reserved.capability,request,new AbortController().signal))).not.toBe('unexpected success');
        expect(performance.now()-started).toBeLessThan(2500);expect(readSignal?.aborted).toBe(true);expect(calls).toBe(0);
        // A second physical client proves the failed transaction released its row lock without callback cooperation.
        expect((await sql.begin(tx=>tx`SELECT id FROM brainchain_worker_policies WHERE id=${policy.id} FOR UPDATE NOWAIT`)).length).toBe(1);
        const retained=await proxy.inspectCall(reserved.binding.callId);expect(retained.state).toBe(mode==='post-timeout'?'uncertain':'reserved');
        const [hold]=await shared`SELECT reserved_micros,uncertain_micros FROM brainchain_compute_envelopes WHERE id=${envelope.id}`;
        expect(String(mode==='post-timeout'?hold!.uncertain_micros:hold!.reserved_micros)).toBe(retained.maximumMicros);
        releaseRead();await Bun.sleep(30);expect(calls).toBe(0);expect((await proxy.inspectCall(retained.callId)).state).toBe(retained.state);
        if(mode==='post-timeout'){expect((await proxy.dispatch(reserved.capability,request,new AbortController().signal)).state).toBe('uncertain');expect(calls).toBe(0);}
      }else if(mode==='replay'){
        expect((await proxy.dispatch(reserved.capability,request,new AbortController().signal)).state).toBe('settled');
        expect((await proxy.dispatch(reserved.capability,request,new AbortController().signal)).state).toBe('settled');expect(calls).toBe(1);
      }else if(mode==='unknown'){
        const receipt=await proxy.dispatch(reserved.capability,request,new AbortController().signal);expect(receipt.state).toBe('uncertain');
        expect((await proxy.dispatch(reserved.capability,request,new AbortController().signal)).state).toBe('uncertain');expect(calls).toBe(1);
        expect(await refusal(()=>proxy.closeEnvelope(envelope.id))).not.toBe('unexpected success');
        expect(String((await shared`SELECT uncertain_micros FROM brainchain_compute_envelopes WHERE id=${envelope.id}`)[0]!.uncertain_micros)).toBe(receipt.maximumMicros);
        await proxy.settleFullCost(receipt.callId,'fixture-conservative');
        expect((await proxy.inspectCall(receipt.callId)).chargedMicros).toBe(receipt.maximumMicros);
        expect((await proxy.closeEnvelope(envelope.id)).releasedMicros).toBe((100000n-BigInt(receipt.maximumMicros)).toString());
      }else{expect(await refusal(()=>proxy.dispatch(reserved.capability,request,new AbortController().signal))).not.toBe('unexpected success');expect(calls).toBe(0);}
    }
  },20000);
  test('actual Drizzle shared-client serializers preserve owner proof and issued authority',async()=>{
    const settings=await getBrainchainFixtureSettings(),shared=postgres({...settings.options,max:1,onnotice:()=>{}});drizzle(shared);
    try{
      const f=await fixture(),policies=new WorkerOwnerPolicies(shared),policy=await policies.request(f.owner,f.workerId,payload());
      const challenge=await policies.challenge(f.owner,f.workerId,policy.id);
      const approved=await policies.approve(f.owner,f.workerId,policy.id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),f.wallet.secretKey))});
      expect(approved.policy.maxGasTotalWei).toBe('1000');expect(approved.state).toBe('active');
      const current=await policies.get(f.owner,f.workerId);
      expect((await policies.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion})).state).toBe('active');
      expect(await refusal(()=>policies.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion}))).toContain('version');
      const [binding]=await sql`SELECT address FROM brainchain_worker_bindings WHERE id=${f.workerId}`;
      await sql`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,generation,next_nonce) VALUES(${f.workerId},${f.avatarId},'testnet',274630,${binding!.address},${'brainchain-testnet:shared-'+randomUUID()},1,0)`;
      const observation:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:binding!.address,signerAddress:binding!.address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'a'.repeat(64)}`,codeHashes:{},brainBalance:1000n,gasBalance:1000n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:1n};
      const issued=await new WorkerAuthorityIssuer(shared,authorityReader).lifecycle({workerId:f.workerId,policyId:policy.id,actionKey:'shared-faucet',request:{kind:'faucet'},fees:{gasLimit:100n,maxFeePerGas:1n,maxPriorityFeePerGas:0n}},observation);
      expect(issued.evidence.request.kind).toBe('faucet');expect(String((await policies.get(f.owner,f.workerId)).liabilities?.gas_committed)).toBe('100');
      await policies.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'pause'});
      const fresh=await policies.get(f.owner,f.workerId);
      expect(await refusal(()=>policies.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:fresh.workerControlVersion}))).toContain('Current owner');
    }finally{await shared.end();}
  });
  test('job takeover retains exact plan and rejects stale host completion',async()=>{
    const f=await fixture(),policy=await service.request(f.owner,f.workerId,payload());
    await service.approve(f.owner,f.workerId,policy.id,await proof(f,policy.id));
    const current=await service.get(f.owner,f.workerId);
    await service.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion});
    const first=new WorkerJobs(sql,randomUUID(),150),second=new WorkerJobs(sql);
    const lease=await first.claim(f.workerId);expect(lease).not.toBeNull();
    const plan={stage:'index',workerId:f.workerId,avatarId:f.avatarId};await first.persist(lease!,plan);
    expect(await second.claim(f.workerId)).toBeNull();await Bun.sleep(180);
    const takeover=await second.claim(f.workerId);expect(takeover!.generation).toBe(lease!.generation+1);expect(takeover!.pendingPlan).toEqual(plan);
    expect(await refusal(()=>first.completeStage(lease!,'indexed'))).toContain('Stale');
    expect(await refusal(()=>first.persist(lease!,{...plan,stage:'compute'}))).toContain('lease');
    expect((await second.claim(f.workerId))!.pendingPlan).toEqual(plan);
    await second.completeStage(takeover!,'indexed');expect((await second.claim(f.workerId))!.pendingPlan).toBeNull();
  });
  test('unchanged job row locks cannot authorize persist or completion after expiry',async()=>{
    for(const action of ['persist','complete'] as const){
      const f=await fixture(),policy=await service.request(f.owner,f.workerId,payload());await service.approve(f.owner,f.workerId,policy.id,await proof(f,policy.id));
      const current=await service.get(f.owner,f.workerId);await service.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion});
      const jobs=new WorkerJobs(sql,randomUUID(),400),lease=(await jobs.claim(f.workerId))!;
      const plan={stage:'index',workerId:f.workerId,avatarId:f.avatarId};if(action==='complete')await jobs.persist(lease,plan);
      let release!:()=>void,locked!:()=>void;const held=new Promise<void>(resolve=>{locked=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      const blocker=sql.begin(async tx=>{await tx`SELECT binding_id FROM brainchain_worker_jobs WHERE binding_id=${f.workerId} FOR UPDATE`;locked();await gate;});
      await held;const pending=refusal(()=>action==='persist'?jobs.persist(lease,plan):jobs.completeStage(lease,'indexed'));
      await Bun.sleep(550);release();await blocker;expect(await pending).toContain('Stale worker lease');
      expect((await sql`SELECT pending_plan FROM brainchain_worker_jobs WHERE binding_id=${f.workerId}`)[0]!.pending_plan).toEqual(action==='complete'?plan:null);
      const replacement=new WorkerJobs(sql),next=(await replacement.claim(f.workerId))!;expect(next.generation).toBe(lease.generation+1);
      expect(await refusal(()=>jobs.completeStage(lease,'indexed'))).toContain('Stale');
      await service.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'pause'});
      expect(await refusal(()=>replacement.persist(next,plan))).toContain('Stale');
      expect(await refusal(()=>replacement.completeStage(next,'indexed'))).toContain('Stale');
    }
  });
  test('issuer cannot mint authority after an unchanged job lock crosses expiry',async()=>{
    const f=await fixture(),policy=await service.request(f.owner,f.workerId,payload());await service.approve(f.owner,f.workerId,policy.id,await proof(f,policy.id));
    const current=await service.get(f.owner,f.workerId);await service.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion});
    const lease=(await new WorkerJobs(sql,randomUUID(),400).claim(f.workerId))!;
    const [binding]=await sql`SELECT address FROM brainchain_worker_bindings WHERE id=${f.workerId}`;
    const observation:SignerObservation={...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:binding!.address,signerAddress:binding!.address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockHash:`0x${'a'.repeat(64)}`,codeHashes:{},brainBalance:1000n,gasBalance:1000n,staked:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:false,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:1n};
    let release!:()=>void,locked!:()=>void;const held=new Promise<void>(resolve=>{locked=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const blocker=sql.begin(async tx=>{await tx`SELECT binding_id FROM brainchain_worker_jobs WHERE binding_id=${f.workerId} FOR UPDATE`;locked();await gate;});
    await held;const pending=refusal(()=>new WorkerAuthorityIssuer(sql,authorityReader).lifecycle({workerId:f.workerId,policyId:policy.id,job:lease,actionKey:'expired-job-lock',request:{kind:'faucet'},fees:{gasLimit:100n,maxFeePerGas:1n,maxPriorityFeePerGas:0n}},observation));
    await Bun.sleep(550);release();await blocker;expect(await pending).toContain('Worker job expired');
    expect(await sql`SELECT id FROM brainchain_worker_policy_issuances WHERE binding_id=${f.workerId}`).toHaveLength(0);
  });

  test('initial assignment reads stop at two seconds or the earlier job lease without callback cooperation',async()=>{
    for(const shortLease of [false,true]){
      const f=await fixture(),policy=await service.request(f.owner,f.workerId,payload());await service.approve(f.owner,f.workerId,policy.id,await proof(f,policy.id));
      const current=await service.get(f.owner,f.workerId);await service.control(f.owner,f.workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion});
      const job=shortLease?(await new WorkerJobs(sql,randomUUID(),250).claim(f.workerId))!:undefined;
      let signal:AbortSignal|undefined,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
      const trusted={current:async(value?:AbortSignal)=>{signal=value;await gate;return{} as WorkerComputeAssignment;},root:{verifyReservation:async()=>{throw Error('Must not reach root');}}};
      const start=performance.now();expect(await refusal(()=>new WorkerAuthorityIssuer(sql,authorityReader).execution({workerId:f.workerId,policyId:policy.id,taskId:randomUUID(),brief:JSON.stringify({kind:'text-writing',instructions:'Fixture'}),job},trusted))).toContain('read deadline');
      expect(performance.now()-start).toBeLessThan(shortLease?700:2500);expect(signal?.aborted).toBe(true);
      release();await Bun.sleep(20);expect(await sql`SELECT id FROM brainchain_worker_policy_issuances WHERE binding_id=${f.workerId}`).toHaveLength(0);
    }
  },6000);

  test('the absolute call deadline wins when host clock leads database time',async()=>{
    const {getPostgresClient}=await import('@clawville/database'),shared=getPostgresClient();
    const [row]=await sql`SELECT i.*,a.task_id,a.avatar_id,a.generation,a.lease_owner,a.id AS attempt_id,e.prompt_hash FROM brainchain_worker_policy_issuances i
      JOIN brainchain_execution_authorities e ON e.id=i.execution_authority_id JOIN brainchain_task_attempts a ON a.authority_id=e.id JOIN brainchain_worker_policies p ON p.id=i.policy_id
      WHERE p.state='active' AND e.expires_at>clock_timestamp()+interval '5 seconds' ORDER BY i.created_at DESC LIMIT 1`;
    expect(row).toBeDefined();
    let release!:()=>void,signal:AbortSignal|undefined;const gate=new Promise<void>(resolve=>{release=resolve;});
    const trusted={root:{verifyReservation:async()=>{}},current:async(value?:AbortSignal)=>{signal=value;await gate;return row!.evidence.assignment;}};
    const fence=new WorkerAuthorityIssuer(shared,authorityReader).computeFence(trusted),native=Date.now;Date.now=()=>native()+2000;
    try{
      const input={taskId:row!.task_id,attemptId:row!.attempt_id,avatarId:row!.avatar_id,generation:row!.generation,leaseOwner:row!.lease_owner,promptHash:row!.prompt_hash,envelopeId:row!.evidence.assignment.envelopeId,maximumMicros:1n,deadlineMs:Date.now()+350};
      const start=performance.now();expect(await refusal(()=>shared.begin(tx=>fence(tx,input)))).toContain('read deadline');
      expect(performance.now()-start).toBeLessThan(750);expect(signal?.aborted).toBe(true);
      expect((await sql.begin(tx=>tx`SELECT id FROM brainchain_worker_policies WHERE id=${row!.policy_id} FOR UPDATE NOWAIT`)).length).toBe(1);
      expect(await refusal(()=>shared.begin(tx=>fence(tx,{...input,deadlineMs:NaN})))).toContain('Invalid compute deadline');
    }finally{Date.now=native;release();await Bun.sleep(20);}
  });

});
