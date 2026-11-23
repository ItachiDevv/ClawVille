import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {beforeAll,afterAll,test,describe,expect,mock} from 'bun:test';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256,toBytes,pad,encodeEventTopics,encodeAbiParameters,parseAbiParameters,parseAbi,encodeFunctionResult,toHex,type Hex} from 'viem';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {computeHash,type ComputePricePolicy} from './inference-policy';
import {DurableInferenceProxy} from './inference-proxy';
import {buildIsolatedTaskPrompt} from '@clawville/agent-runtime/isolated-task';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import {freezeResultSignatureIntent,resultSignatureClaimHash} from './result-signing-policy';
import {resultUploadMessage} from './result-signing-message';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {WorkerOwnerPolicies} from './worker-owner-policy';
import type {WorkerSchedulerConfiguration} from './worker-scheduler';
import {taskReadAbi,workerHireAbi} from './chain-client';
import type {WorkerRuntime,WorkerTick} from './worker-coordinator';

const authorityReader=fixtureConfiguredAuthorityReader();

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('automatic worker stages on isolated PostgreSQL',()=>{
  let database:ReturnType<typeof postgres>,lockDatabase:ReturnType<typeof postgres>,Scheduler:typeof import('./worker-scheduler').BrainchainWorkerScheduler;
  const prior=process.env.DATABASE_URL,priorEnvironment=process.env.CLAWVILLE_ENV;
  let rpcState:{worker:Hex;taskNumber:bigint;brief:string;hash:Hex;deadline:bigint;timestamp:bigint};
  const code='0x6000';
  const posted=parseAbi(['event Posted(uint256 indexed id,address indexed poster,uint128 bounty,uint64 deadline,bytes32 briefHash,string briefURI)']);
  const fetcher=(async(_url:unknown,init?:RequestInit)=>{
    const q=JSON.parse(String(init?.body));let result:unknown;const {worker,taskNumber,brief,hash,deadline}=rpcState;
    if(q.method==='eth_chainId')result='0x430c6';
    else if(q.method==='eth_blockNumber')result=toHex(5012);
    else if(q.method==='eth_getBlockByNumber')result={number:q.params[0],hash,timestamp:toHex(rpcState.timestamp)};
    else if(q.method==='eth_getCode')result=code;
    else if(q.method==='eth_getLogs'){
      const filter=q.params[0],hire=filter.topics[0]===encodeEventTopics({abi:workerHireAbi,eventName:'WorkerHired'})[0];
      result=filter.address!==BRAINCHAIN_CONTRACTS.testnet.contracts.board||BigInt(filter.fromBlock)>2288n||BigInt(filter.toBlock)<2288n?[]:[{address:filter.address,blockNumber:toHex(2288),blockHash:hash,transactionHash:hash,logIndex:'0x0',removed:false,topics:hire?encodeEventTopics({abi:workerHireAbi,eventName:'WorkerHired',args:{id:taskNumber,model:pad(worker,{size:32}),decisionId:1n}}):encodeEventTopics({abi:posted,eventName:'Posted',args:{id:taskNumber,poster:worker}}),data:hire?'0x':encodeAbiParameters(parseAbiParameters('uint128,uint64,bytes32,string'),[1n,deadline,keccak256(toBytes(brief)),`data:application/json;base64,${Buffer.from(brief).toString('base64')}`])}];
    }else if(q.method==='eth_call')result=encodeFunctionResult({abi:taskReadAbi,functionName:'get',result:{poster:worker,bounty:1n,deadline,status:2,accepted:false,disputed:false,disputedByModel:false,model:pad(worker,{size:32}),briefHash:keccak256(toBytes(brief)),resultHash:hash,submittedAt:0n,gradedAt:0n,disputedAt:0n,postedAt:0n,payee:'0x0000000000000000000000000000000000000000',feeRecipient:worker,feeBps:0,hireThresholdBps:0,gradeThresholdBps:0,ruleThresholdBps:0,gradeWindow:0n,disputeWindow:0n,ruleWindow:0n}});
    else throw Error('Unexpected fixture RPC');
    return Response.json({jsonrpc:'2.0',id:q.id,result});
  }) as typeof fetch;
  beforeAll(async()=>{
    const settings=await getBrainchainFixtureSettings();process.env.DATABASE_URL=settings.url;process.env.CLAWVILLE_ENV='staging';
    database=(await import('@clawville/database')).getPostgresClient();lockDatabase=postgres({...settings.options,max:1,onnotice:()=>{}});
    const policy=await import('./signer-policy');
    mock.module('./signer-policy',()=>({...policy,assertSignerActivation:()=>{},assertSignerArtifactAdmission:policy.assertObservedSignerCode}));
    // Only the OS/container boundary is controlled. Admission, budget reserve/dispatch, settlement and delivery remain real.
    mock.module('./isolated-process-coordinator',()=>({async runBrainchainIsolatedProcess(input:Parameters<typeof import('./isolated-process-coordinator').runBrainchainIsolatedProcess>[0]){
      const receipt=await input.proxy.dispatch(input.capability,{binding:input.binding,prompt:buildIsolatedTaskPrompt(input.brief)},new AbortController().signal);
      if(receipt.state!=='settled')throw Error('Controlled child receipt unavailable');return{receipt};
    }}));
    const reader=await import('./chain-client'),originalReader=reader.createBrainChainReader,originalRpc=reader.createBrainChainReadRpc;
    mock.module('./chain-client',()=>({...reader,createBrainChainReader:(environment:Parameters<typeof reader.createBrainChainReader>[0])=>originalReader(environment,{fetch:fetcher,validateUrl:async url=>({ok:true,url})}),createBrainChainReadRpc:(environment:Parameters<typeof reader.createBrainChainReadRpc>[0])=>originalRpc(environment,{fetch:fetcher,validateUrl:async url=>({ok:true,url})})}));
    mock.module('./signer-code-evidence',()=>({TESTNET_SIGNER_CODE_EVIDENCE:{...TESTNET_SIGNER_CODE_EVIDENCE,contracts:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts,[BRAINCHAIN_CONTRACTS.testnet.contracts.board]:keccak256(code)}}}));
    Scheduler=(await import('./worker-scheduler')).BrainchainWorkerScheduler;
  });
  afterAll(async()=>{mock.restore();await lockDatabase?.end();if(prior===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=prior;if(priorEnvironment===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=priorEnvironment;});
  test('automatic lifecycle and hired task flow retains captures and never repeats compute or upload',async()=>{
    expect(typeof(await database`SELECT clock_timestamp() AS now`)[0]!.now).toBe('string');
    const userId=randomUUID(),avatarId=randomUUID(),workerId=randomUUID(),taskId=randomUUID();
    // Public test scalar only. No keyring or production secret enters this process.
    const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),address=account.address.toLowerCase(),brief=JSON.stringify({kind:'text-writing',instructions:'Summarize this controlled task.'}),prompt=buildIsolatedTaskPrompt(brief),hash=`0x${'a'.repeat(64)}` as Hex;
    const wallet=nacl.sign.keyPair();
    await database`INSERT INTO users(id,is_guest,linked_wallet_pubkey) VALUES(${userId},false,${bs58.encode(wallet.publicKey)})`;
    await database`INSERT INTO avatars(id,user_id,is_guest) VALUES(${avatarId},${userId},false)`;
    // A fresh owner requires a fresh address. Derive it from a test scalar tied to the fixture UUID.
    const localAccount=privateKeyToAccount(`0x${avatarId.replaceAll('-','').padStart(64,'0')}`),worker=localAccount.address.toLowerCase();
    await database`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state) VALUES(${workerId},${avatarId},'testnet',274630,${worker},${'b'.repeat(64)},'running')`;
    await database`INSERT INTO brainchain_signer_streams(binding_id,avatar_id,environment,chain_id,signer_address,signer_ref,next_nonce) VALUES(${workerId},${avatarId},'testnet',274630,${worker},${'brainchain-testnet:'+workerId},0)`;
    const taskNumber=BigInt('0x'+taskId.replaceAll('-','')).toString();
    rpcState={worker:worker as Hex,taskNumber:BigInt(taskNumber),brief,hash,deadline:BigInt(Math.floor(Date.now()/1000)+3600),timestamp:BigInt(Math.floor(Date.now()/1000))};
    const policies=new WorkerOwnerPolicies(database),owner={userId,avatarId,actor:'human' as const,assertCurrent:async()=>{}};
    const policy=await policies.request(owner,workerId,{environment:'testnet',chainId:274630,actions:['faucet','submit'],taskKinds:['text-writing'],maxStakeAtomic:'500',maxBondAtomic:'100',maxBrainTotalAtomic:'600',priceAtomic:'0',maxGasPerOperationWei:'200',maxGasTotalWei:'400',maxTasks:1,openaiMicros:'10000',openrouterMicros:'0',expiresAt:new Date(Date.now()+300000).toISOString()});
    const challenge=await policies.challenge(owner,workerId,policy.id);await policies.approve(owner,workerId,policy.id,{nonce:challenge.nonce,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.messageToSign),wallet.secretKey))});
    const current=await policies.get(owner,workerId);await policies.control(owner,workerId,{policyId:policy.id,revision:policy.revision,action:'start',workerControlVersion:current.workerControlVersion});
    const price:ComputePricePolicy={provider:'openai',model:'fixture-model',version:'worker-fixture',inputMicrosPerMillion:1n,outputMicrosPerMillion:1n,requestMicros:1n,maxInputTokens:4096,maxOutputTokens:256,inputOverheadTokens:16,inputTokenBound:'utf8-bytes',outputIncludesReasoning:true};
    let providerCalls=0,uploads=0,keyCalls=0,sends=0,eligible=false;
    const root={async verifyReservation(){}},adapter={provider:'openai' as const,async generate(){providerCalls++;return{text:'Exact controlled result',inputTokens:10,outputTokens:10};}};
    const proxy=new DurableInferenceProxy(database,[price],[adapter],root,undefined,authorityReader),jobId=randomUUID(),rootReservationId=randomUUID();
    const envelope=await proxy.approveEnvelope({jobId,provider:'openai',rootReservationId,approvalRef:'fixture',limitMicros:10000n,expiresAt:new Date(Date.now()+90000)});
    const signatures=new Map<string,Hex>(),transactions=new Map<string,Hex>(),claims=new Set<string>();
    const journal=(map:Map<string,Hex>)=>({async claimKeyUse(id:string){if(claims.has(id))return false;claims.add(id);return true;},async claimDriverUse(){return true;},async putIfAbsent(id:string,bytes:Hex){map.set(id,bytes);return computeHash(id);},async findByOperation(id:string){const bytes=map.get(id);return bytes?{reference:computeHash(id),bytes}:null;},async get(ref:string){for(const [id,bytes]of map)if(computeHash(id)===ref)return bytes;throw Error('Missing fixture capture');}});
    const signatureJournal=journal(signatures),transactionJournal=journal(transactions);
    const runtime:WorkerRuntime={database,lockDatabase,authorityReader,async observe(){return{...await authorityReader({deadlineMs:Date.now()+2000}),environment:'testnet',chainId:274630,bindingAddress:worker,signerAddress:worker,observedAt:new Date(Date.now()-1000),blockTimestamp:BigInt(Math.floor(Date.now()/1000))-1n,blockNumber:5000n,blockHash:hash,codeHashes:{...TESTNET_SIGNER_CODE_EVIDENCE.contracts,[BRAINCHAIN_CONTRACTS.testnet.contracts.board]:keccak256(code)},gasBalance:1000n,brainBalance:eligible?1000n:0n,staked:eligible?500n:0n,unstaking:0n,unlocksAt:0n,held:0n,minStake:500n,bond:100n,stakingAllowance:0n,bondAllowance:0n,allowed:eligible,applicationPending:false,applicationVetoed:false,lastClaim:0n,faucetInterval:0n};},
      compute:{proxy,bundle:{bundlePath:'controlled-child',bundleSha256:'a'.repeat(64)},reservation:{envelopeId:envelope.id,model:price.model,pricingVersion:price.version,maxInputTokens:4096,maxOutputTokens:32}},
      upload:{async upload(input){uploads++;return{hash:input.hash,uri:`https://brain.testnet.usebrainchain.com/records/${input.hash}.txt`};}},
      signer:{fees:{gasLimit:100n,maxFeePerGas:2n,maxPriorityFeePerGas:1n},signatures:signatureJournal,transactions:transactionJournal,
        results:{async signResult(id,_reference,intent,current){await current();keyCalls++;const bytes=await localAccount.signMessage({message:resultUploadMessage(intent.board,intent.task,intent.hash)});await signatureJournal.putIfAbsent(id,bytes);throw Error('Fixture restart after signature capture');}},
        driver:{async addressForReference(){return worker;},async signTransaction(id,_reference,transaction,current){await current?.assertCurrent();keyCalls++;const bytes=await localAccount.signTransaction(transaction);await transactionJournal.putIfAbsent(id,bytes);throw Error('Fixture restart after transaction capture');}},
        transport:{async assertTestnet(){},async nonces(){return{canonical:eligible?1n:0n,pending:eligible?1n:0n};},async broadcastSameBytes(bytes){sends++;return keccak256(bytes);},async receipt(transactionHash){if(transactionHash===keccak256([...transactions.values()][0]!)){eligible=true;return{transactionHash,state:'included',observedAt:new Date().toISOString(),provisional:true,blockNumber:'5000',blockHash:hash,successful:true,gasUsed:'100',effectiveGasPrice:'1'};}return{transactionHash,state:'pending',observedAt:new Date().toISOString(),provisional:true};}}}};
    const configuration:WorkerSchedulerConfiguration={hostId:randomUUID(),runtime,compute:{prices:[price],adapters:[adapter],bundle:runtime.compute!.bundle,reservation:runtime.compute!.reservation,assignment:{root,current:async()=>({jobId,rootReservationId,provider:'openai',envelopeId:envelope.id,workerId,avatarId,policyHash:policy.policyHash,perTaskMicros:'100',expiresAt:new Date(Date.now()+80000).toISOString(),generation:1})}},application:{name:'Fixture',about:'No external effects'}};
    // The trusted assignment is immutable across all reads, including restart.
    const assignment=await configuration.compute.assignment.current();configuration.compute.assignment.current=async()=>assignment;
    const tick=()=>new Scheduler(configuration).tick(workerId);
    expect((await tick()).state).toBe('prepared');
    expect((await tick()).state).toBe('retained-evidence-required');
    expect((await tick()).state).toBe('signed');
    expect((await tick()).state).toBe('broadcast');
    expect((await tick()).state).toBe('included');
    expect((await tick()).state).toBe('indexed');
    expect((await tick()).state).toBe('admitted');
    expect((await tick()).state).toBe('computed');
    expect((await tick()).state).toBe('frozen');
    expect((await tick()).state).toBe('retained-evidence-required');
    expect((await tick()).state).toBe('captured');
    expect((await tick()).state).toBe('uploaded');
    expect((await tick()).state).toBe('prepared');
    expect((await tick()).state).toBe('retained-evidence-required');
    expect((await tick()).state).toBe('signed');
    expect((await tick()).state).toBe('broadcast');
    expect((await tick()).state).toBe('pending');
    expect((await tick()).state).toBe('pending');
    expect(providerCalls).toBe(1);expect(uploads).toBe(1);expect(keyCalls).toBe(3);expect(sends).toBe(2);
    expect((await database`SELECT count(*)::int AS n FROM brainchain_task_results WHERE binding_id=${workerId}`)[0]!.n).toBe(1);
    const liabilities=(await policies.get(owner,workerId)).liabilities;expect(String(liabilities?.gas_committed)).toBe('400');
  },20000);
});
