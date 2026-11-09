import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import {beforeAll,afterAll,test,describe,expect,mock} from 'bun:test';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256,toBytes,type Hex} from 'viem';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {computeHash,type ComputePricePolicy} from './inference-policy';
import {DurableInferenceProxy} from './inference-proxy';
import {buildIsolatedTaskPrompt} from '@clawville/agent-runtime/isolated-task';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import {freezeResultSignatureIntent,resultSignatureClaimHash} from './result-signing-policy';
import {resultUploadMessage} from './result-signing-message';
import {signerRequestHash} from './signer-policy';
import type {WorkerRuntime,WorkerTick} from './worker-coordinator';

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('explicit worker stages on isolated PostgreSQL',()=>{
  let database:ReturnType<typeof postgres>,lockDatabase:ReturnType<typeof postgres>,Coordinator:typeof import('./worker-coordinator').BrainchainWorkerCoordinator;
  const authorityReader=fixtureConfiguredAuthorityReader();
  const prior=process.env.DATABASE_URL;
  beforeAll(async()=>{
    const settings=await getBrainchainFixtureSettings();process.env.DATABASE_URL=settings.url;
    database=(await import('@clawville/database')).getPostgresClient();lockDatabase=postgres({...settings.options,max:1,onnotice:()=>{}});
    const policy=await import('./signer-policy');
    mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{},assertSignerArtifactAdmission:policy.assertObservedSignerCode}));
    // Only the OS/container boundary is controlled. Admission, budget reserve/dispatch, settlement and delivery remain real.
    mock.module('./isolated-process-coordinator',()=>({async runBrainchainIsolatedProcess(input:Parameters<typeof import('./isolated-process-coordinator').runBrainchainIsolatedProcess>[0]){
      const receipt=await input.proxy.dispatch(input.capability,{binding:input.binding,prompt:buildIsolatedTaskPrompt(input.brief)},new AbortController().signal);
      if(receipt.state!=='settled')throw Error('Controlled child receipt unavailable');return{receipt};
    }}));
    Coordinator=(await import('./worker-coordinator')).BrainchainWorkerCoordinator;
  });
  afterAll(async()=>{mock.restore();await lockDatabase?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;});
  test('admission through captured submit uses real durable services; restart never repeats compute or upload',async()=>{
    expect(typeof(await database`SELECT clock_timestamp() AS now`)[0]!.now).toBe('string');
    const avatarId=randomUUID(),workerId=randomUUID(),taskId=randomUUID(),authorityId=randomUUID();
    // Public test scalar only. No keyring or production secret enters this process.
    const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),address=account.address.toLowerCase(),brief='Summarize this controlled task.',prompt=buildIsolatedTaskPrompt(brief),hash=`0x${'a'.repeat(64)}` as Hex;
    await database`INSERT INTO avatars(id) VALUES(${avatarId})`;
    // A fresh owner requires a fresh address. Derive it from a test scalar tied to the fixture UUID.
    const localAccount=privateKeyToAccount(`0x${avatarId.replaceAll('-','').padStart(64,'0')}`),worker=localAccount.address.toLowerCase();
    await database`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${workerId},${avatarId},'testnet',274630,${worker},${'b'.repeat(64)},'running')`;
    await database`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${workerId},${avatarId},'testnet',274630,${worker},${'brainchain-testnet:'+workerId},0)`;
    const taskNumber=BigInt('0x'+taskId.replaceAll('-','')).toString();
    await database`INSERT INTO brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id,board_address,task_id,manifest_hash,hire_block,hire_block_hash,hire_tx_hash,hire_log_index,observed_block,observed_block_hash,status,bounty_atomic,deadline_unix,brief_hash,result_hash)
      VALUES(${taskId},${workerId},${avatarId},'testnet',274630,${BRAINCHAIN_CONTRACTS.testnet.contracts.board},${taskNumber},${'c'.repeat(64)},2288,${hash},${hash},0,5000,${hash},2,1,${Math.floor(Date.now()/1000)+3600},${keccak256(toBytes(brief))},${hash})`;
    await database`INSERT INTO brainchain_execution_authorities(id,task_id,binding_id,avatar_id,environment,chain_id,generation,brief_hash,input_hash,prompt_hash,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${authorityId},${taskId},${workerId},${avatarId},'testnet',274630,1,${keccak256(toBytes(brief))},${computeHash(brief)},${computeHash(prompt)},'fixture',clock_timestamp()+interval '60 seconds',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    const price:ComputePricePolicy={provider:'openai',model:'fixture-model',version:'worker-fixture',inputMicrosPerMillion:1n,outputMicrosPerMillion:1n,requestMicros:1n,maxInputTokens:4096,maxOutputTokens:256,inputOverheadTokens:16,inputTokenBound:'utf8-bytes',outputIncludesReasoning:true};
    let providerCalls=0,uploads=0,keyCalls=0,sends=0;
    const proxy=new DurableInferenceProxy(database,[price],[{provider:'openai',async generate(){providerCalls++;return{text:'Exact controlled result',inputTokens:10,outputTokens:10};}}],{async verifyReservation(){}},undefined,authorityReader);
    const envelope=await proxy.approveEnvelope({jobId:randomUUID(),provider:'openai',rootReservationId:randomUUID(),approvalRef:'fixture',limitMicros:100n,expiresAt:new Date(Date.now()+90000)});
    const signatures=new Map<string,Hex>(),transactions=new Map<string,Hex>(),claims=new Set<string>();
    const journal=(map:Map<string,Hex>)=>({async claimKeyUse(id:string){if(claims.has(id))return false;claims.add(id);return true;},async claimDriverUse(){return true;},async putIfAbsent(id:string,bytes:Hex){map.set(id,bytes);return computeHash(id);},async findByOperation(id:string){const bytes=map.get(id);return bytes?{reference:computeHash(id),bytes}:null;},async get(ref:string){for(const [id,bytes]of map)if(computeHash(id)===ref)return bytes;throw Error('Missing fixture capture');}});
    const signatureJournal=journal(signatures),transactionJournal=journal(transactions);
    const runtime:WorkerRuntime={database,lockDatabase,authorityReader,async observe(){return{...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:worker,signerAddress:worker,observedAt:new Date(Date.now()-1000),blockTimestamp:BigInt(Math.floor(Date.now()/1000))-1n,blockNumber:5000n,blockHash:hash,codeHashes:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts},gasBalance:1000n,brainBalance:1000n,staked:500n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:true,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n};},
      compute:{proxy,bundle:{bundlePath:'controlled-child',bundleSha256:'a'.repeat(64)},reservation:{envelopeId:envelope.id,model:price.model,pricingVersion:price.version,maxInputTokens:4096,maxOutputTokens:32}},
      upload:{async upload(input){uploads++;return{hash:input.hash,uri:`https://brain.testnet.usebrainchain.com/records/${input.hash}.txt`};}},
      signer:{fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},signatures:signatureJournal,transactions:transactionJournal,
        results:{async signResult(id,_reference,intent,current){await current();keyCalls++;const bytes=await localAccount.signMessage({message:resultUploadMessage(intent.board,intent.task,intent.hash)});await signatureJournal.putIfAbsent(id,bytes);throw Error('Fixture restart after signature capture');}},
        driver:{async addressForReference(){return worker;},async signTransaction(id,_reference,transaction,current){await current?.assertCurrent();keyCalls++;const bytes=await localAccount.signTransaction(transaction);await transactionJournal.putIfAbsent(id,bytes);throw Error('Fixture restart after transaction capture');}},
        transport:{async assertTestnet(){},async nonces(){return{canonical:0n,pending:0n};},async broadcastSameBytes(bytes){sends++;return keccak256(bytes);},async receipt(transactionHash){return{transactionHash,state:'pending',observedAt:new Date().toISOString(),provisional:true};}}}};
    const tick=(stage:WorkerTick['stage'],extra:Partial<WorkerTick>={})=>new Coordinator(runtime).tick({avatarId,workerId,taskId,stage,...extra});
    expect((await tick('admit',{brief,authorityId})).state).toBe('admitted');
    expect((await tick('compute',{brief})).state).toBe('computed');
    expect((await tick('compute',{brief})).state).toBe('existing-compute');expect(providerCalls).toBe(1);
    expect((await tick('freeze')).state).toBe('frozen');
    expect((await tick('admit',{brief,authorityId})).state).toBe('frozen');
    const [result]=await database`SELECT * FROM brainchain_task_results WHERE task_id=${taskId}`;
    const signatureAuthority=randomUUID(),intent=freezeResultSignatureIntent({domain:'brainchain-result-v2',chainId:274630,resultId:result!.id,board:BRAINCHAIN_CONTRACTS.testnet.contracts.board,task:taskNumber,hash:result!.result_hash,worker});
    await database`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${signatureAuthority},${workerId},${avatarId},'testnet',274630,${worker},1,'result-signature',${resultSignatureClaimHash('brainchain-testnet:'+workerId,intent)},0,'fixture',clock_timestamp()+interval '60 seconds',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    expect((await tick('signature',{authorityId:signatureAuthority})).state).toBe('uncertain');
    expect((await tick('signature')).state).toBe('captured');expect(keyCalls).toBe(1);
    expect((await tick('upload')).state).toBe('uploaded');expect((await tick('upload')).state).toBe('uploaded');expect(uploads).toBe(1);
    const submit=randomUUID(),gas=randomUUID(),request={kind:'submit' as const,resultId:result!.id,task:taskNumber,hash:result!.result_hash,uri:`https://brain.testnet.usebrainchain.com/records/${result!.result_hash}.txt`};
    for(const [id,purpose,amount]of [[submit,'submit','0'],[gas,'gas','200']])await database`INSERT INTO brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,authority_policy_version,authority_policy_digest)
      VALUES(${id!},${workerId},${avatarId},'testnet',274630,${worker},1,${purpose!},${signerRequestHash(request)},${amount!},'fixture',clock_timestamp()+interval '60 seconds',${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
    expect((await tick('prepare-submit',{authorityId:submit,gasAuthorityId:gas})).state).toBe('prepared');
    expect((await tick('capture-submit')).state).toBe('uncertain');
    expect((await tick('capture-submit')).state).toBe('signed');expect(keyCalls).toBe(2);
    expect((await tick('broadcast')).state).toBe('broadcast');expect(sends).toBe(1);
    expect((await tick('receipt')).state).toBe('pending');
    expect(providerCalls).toBe(1);expect((await tick('compute',{brief})).state).toBe('frozen');
  },15000);
});


