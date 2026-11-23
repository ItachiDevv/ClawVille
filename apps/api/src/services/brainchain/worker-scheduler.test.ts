import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID,randomBytes} from 'node:crypto';
import postgres from 'postgres';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {WorkerOwnerPolicies} from './worker-owner-policy';
import {WorkerJobs} from './worker-jobs';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import type {WorkerSchedulerConfiguration} from './worker-scheduler';

const authorityReader=fixtureConfiguredAuthorityReader();

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('scheduler durable stage composition',()=>{
  let db:ReturnType<typeof postgres>,locks:ReturnType<typeof postgres>,Scheduler:typeof import('./worker-scheduler').BrainchainWorkerScheduler;
  const prior=process.env.DATABASE_URL,priorEnvironment=process.env.CLAWVILLE_ENV;
  beforeAll(async()=>{
    const settings=await getBrainchainFixtureSettings();process.env.DATABASE_URL=settings.url;process.env.CLAWVILLE_ENV='staging';
    const database=await import('@clawville/database');db=database.getPostgresClient();locks=postgres({...settings.options,max:1,onnotice:()=>{}});
    Scheduler=(await import('./worker-scheduler')).BrainchainWorkerScheduler;
  });
  afterAll(async()=>{await locks?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;if(priorEnvironment===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=priorEnvironment;});
  test('receipt persistence survives an expired host and canonical replay precedes every next grant',async()=>{
    const userId=randomUUID(),avatarId=randomUUID(),workerId=randomUUID(),operationId=randomUUID(),authority=randomUUID(),gas=randomUUID(),hostId=randomUUID();
    const address='0x'+randomBytes(20).toString('hex'),hash=`0x${randomBytes(32).toString('hex')}` as const,wallet=nacl.sign.keyPair();
    await db`INSERT INTO users(id,is_guest,linked_wallet_pubkey) VALUES(${userId},false,${bs58.encode(wallet.publicKey)})`;
    await db`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;
    await db`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash) VALUES(${workerId},${avatarId},'testnet',274630,${address},${'a'.repeat(64)})`;
    const policies=new WorkerOwnerPolicies(db),owner={userId,avatarId,actor:'human' as const,assertCurrent:async()=>{}};
    const policy=await policies.request(owner,workerId,{environment:'testnet',chainId:274630,actions:['faucet'],taskKinds:[],maxStakeAtomic:'0',maxBondAtomic:'0',maxBrainTotalAtomic:'0',priceAtomic:'0',maxGasPerOperationWei:'100',maxGasTotalWei:'100',maxTasks:0,openaiMicros:'0',openrouterMicros:'0',expiresAt:new Date(Date.now()+300000).toISOString()});
    const challenge=await policies.challenge(owner,workerId,policy.id);
    await policies.approve(owner,workerId,policy.id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),wallet.secretKey))});
    const status=await policies.get(owner,workerId);await policies.control(owner,workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:status.workerControlVersion});
    await db`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${workerId},${avatarId},'testnet',274630,${address},${'brainchain-testnet:scheduler-'+randomUUID()},1)`;
    for(const [id,purpose]of [[authority,'faucet'],[gas,'gas']])await db`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest) VALUES(${id!},${workerId},${avatarId},'testnet',274630,${address},1,${purpose!},${'a'.repeat(64)},200,'scheduler-fixture',clock_timestamp()+interval '1 minute',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    await db`INSERT INTO brainchain_signer_operations(id,binding_id,avatar_id,environment,chain_id,signer_address,authority_id,gas_authority_id,generation,kind,idempotency_key,request_hash,intent,state,nonce,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,expires_at,signed_payload_ref,transaction_hash,accepted_at,authority_policy_version,authority_policy_digest)
      VALUES(${operationId},${workerId},${avatarId},'testnet',274630,${address},${authority},${gas},1,'faucet',${randomUUID()},${'a'.repeat(64)},'{}'::jsonb,'broadcast',0,100,2,1,clock_timestamp()+interval '1 minute',${'b'.repeat(64)},${hash},clock_timestamp(),${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const jobs=new WorkerJobs(db,hostId,400),lease=(await jobs.claim(workerId))!,plan={version:1,tick:{workerId,avatarId,operationId,stage:'receipt-lifecycle'}};
    await jobs.persist(lease,plan);
    let receiptCalls=0,observationCalls=0,orphan=false;
    const forbidden=async():Promise<never>=>{throw Error('No key, provider or send permitted');};
    const configuration={hostId,runtime:{database:db,lockDatabase:locks,observe:async()=>{observationCalls++;return forbidden();},signer:{driver:{signTransaction:forbidden},results:{signResult:forbidden},transactions:{},signatures:{},fees:{gasLimit:100n,maxFeePerGas:1n,maxPriorityFeePerGas:0n},transport:{nonces:forbidden,sendRawTransaction:forbidden,receipt:async()=>{
      receiptCalls++;if(receiptCalls===1)await Bun.sleep(550);
      return{state:orphan?'orphaned':'included',transactionHash:hash,observedAt:new Date().toISOString(),provisional:true,blockNumber:'100',blockHash:`0x${'c'.repeat(64)}`,successful:true,confirmations:'0',gasUsed:'70',effectiveGasPrice:'1'};
    }}}},compute:{assignment:{current:forbidden,root:{verifyReservation:forbidden}},prices:[],adapters:[],bundle:{},reservation:{}},application:{name:'Fixture',about:'No external effects'}} as unknown as WorkerSchedulerConfiguration;
    let refused=false;try{await new Scheduler(configuration).tick(workerId);}catch{refused=true;}
    expect(refused).toBe(true);expect((await db`SELECT state FROM brainchain_signer_operations WHERE id=${operationId}`)[0]!.state).toBe('confirmed');
    expect((await db`SELECT pending_plan FROM brainchain_worker_jobs WHERE binding_id=${workerId}`)[0]!.pending_plan).toEqual(plan);
    await db`UPDATE brainchain_worker_bindings SET requested_state='draining' WHERE id=${workerId}`;
    const restarted=new Scheduler({...configuration,hostId:randomUUID()});
    expect((await restarted.tick(workerId)).state).toBe('included');expect(receiptCalls).toBe(2);
    expect((await db`SELECT pending_plan FROM brainchain_worker_jobs WHERE binding_id=${workerId}`)[0]!.pending_plan).toBeNull();
    expect((await db`SELECT count(*)::int AS n FROM brainchain_signer_receipt_observations WHERE operation_id=${operationId}`)[0]!.n).toBe(1);
    orphan=true;expect((await restarted.tick(workerId)).state).toBe('receipt-not-canonical-success');expect(observationCalls).toBe(0);
    expect((await db`SELECT stopped FROM brainchain_signer_streams WHERE binding_id=${workerId}`)[0]!.stopped).toBe(true);
  });
  test('automatic lifecycle preparation, drain refusal, rejected selection and multiple hires use concrete services',async()=>{
    const userId=randomUUID(),avatarId=randomUUID(),workerId=randomUUID(),hostId=randomUUID(),address='0x'+randomBytes(20).toString('hex'),hash=`0x${'a'.repeat(64)}`,wallet=nacl.sign.keyPair();
    await db`INSERT INTO users(id,is_guest,linked_wallet_pubkey) VALUES(${userId},false,${bs58.encode(wallet.publicKey)})`;
    await db`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;
    await db`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash) VALUES(${workerId},${avatarId},'testnet',274630,${address},${'a'.repeat(64)})`;
    const policies=new WorkerOwnerPolicies(db),owner={userId,avatarId,actor:'human' as const,assertCurrent:async()=>{}};
    const policy=await policies.request(owner,workerId,{environment:'testnet',chainId:274630,actions:['faucet'],taskKinds:[],maxStakeAtomic:'0',maxBondAtomic:'0',maxBrainTotalAtomic:'0',priceAtomic:'0',maxGasPerOperationWei:'100',maxGasTotalWei:'100',maxTasks:0,openaiMicros:'0',openrouterMicros:'0',expiresAt:new Date(Date.now()+300000).toISOString()});
    const challenge=await policies.challenge(owner,workerId,policy.id);await policies.approve(owner,workerId,policy.id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),wallet.secretKey))});
    const current=await policies.get(owner,workerId);await policies.control(owner,workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion});
    await db`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${workerId},${avatarId},'testnet',274630,${address},${'brainchain-testnet:scheduler-'+randomUUID()},0)`;
    let calls=0,eligible=false;
    const forbidden=async():Promise<never>=>{calls++;throw Error('No key/provider/network effect');};
    const config={hostId,runtime:{database:db,lockDatabase:locks,authorityReader,observe:async()=>({...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:address,signerAddress:address,observedAt:new Date(),blockTimestamp:BigInt(Math.floor(Date.now()/1000)),blockNumber:5000n,blockHash:hash,codeHashes:{},brainBalance:0n,gasBalance:1000n,staked:eligible?500n:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:eligible,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:1n}),signer:{driver:{signTransaction:forbidden},results:{signResult:forbidden},transactions:{},signatures:{},fees:{gasLimit:100n,maxFeePerGas:1n,maxPriorityFeePerGas:0n},transport:{nonces:forbidden,broadcastSameBytes:forbidden,receipt:forbidden}}},compute:{assignment:{current:forbidden,root:{verifyReservation:forbidden}},prices:[],adapters:[],bundle:{},reservation:{}},application:{name:'Fixture',about:'No external effects'}} as unknown as WorkerSchedulerConfiguration;
    const scheduler=new Scheduler(config);expect(await scheduler.tick(workerId)).toEqual({state:'prepared',stage:'prepare-lifecycle'});
    const [operation]=await db`SELECT * FROM brainchain_signer_operations WHERE binding_id=${workerId}`;expect(operation!.kind).toBe('faucet');expect(operation!.state).toBe('prepared');expect(operation!.accepted_at).toBeNull();
    expect((await db`SELECT pending_plan FROM brainchain_worker_jobs WHERE binding_id=${workerId}`)[0]!.pending_plan).toBeNull();
    await db`UPDATE brainchain_worker_bindings SET requested_state='draining' WHERE id=${workerId}`;
    expect((await scheduler.tick(workerId)).state).toBe('draining-unsigned-lifecycle-retained');expect(calls).toBe(0);
    await db`UPDATE brainchain_signer_operations SET state='rejected' WHERE id=${operation!.id}`;
    eligible=true;await db`UPDATE brainchain_worker_bindings SET requested_state='running' WHERE id=${workerId}`;
    for(let n=0;n<2;n++)await db`INSERT INTO brainchain_worker_tasks(binding_id,avatar_id,environment,chain_id,board_address,task_id,manifest_hash,hire_block,hire_block_hash,hire_tx_hash,hire_log_index,observed_block,observed_block_hash,status,bounty_atomic,deadline_unix,brief_hash,result_hash)
      VALUES(${workerId},${avatarId},'testnet',274630,${BRAINCHAIN_CONTRACTS.testnet.contracts.board},${BigInt('0x'+randomBytes(12).toString('hex')).toString()},${'a'.repeat(64)},1,${hash},${hash},${n},5000,${hash},2,1,${Math.floor(Date.now()/1000)+3600},${hash},${hash})`;
    expect((await scheduler.tick(workerId)).state).toBe('multiple-hire-review-required');expect(calls).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM brainchain_worker_policy_issuances WHERE binding_id=${workerId}`)[0]!.n).toBe(1);
    expect(String((await policies.get(owner,workerId)).liabilities?.gas_committed)).toBe('100');
  });

});
