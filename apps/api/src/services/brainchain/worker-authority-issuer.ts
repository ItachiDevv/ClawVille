import {assertConfiguredAuthorityEvidence,assertConfiguredAuthorityPolicy,CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import {observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {createHash} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';
import {z} from 'zod';
import {keccak256,toBytes} from 'viem';
import {buildIsolatedTaskPrompt} from '@clawville/agent-runtime/isolated-task';
import {workerOwnerPolicySchema,workerPolicyHash,policyNarrows,WorkerPolicyError} from './worker-owner-policy';
import {signerRequestSchema,signerRequestHash,prepareSignerIntent,assertFreshTestnetObservation,type SignerObservation} from './signer-policy';
import {freezeResultSignatureIntent,resultSignatureClaimHash} from './result-signing-policy';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import type {RootComputeBudgetAuthority,RootComputeEnvelopeApproval,WorkerComputeFence} from './inference-proxy';
import {databaseDate as date} from './database-values';
import {observationPolicyOf,LEGACY_WORKER_POLICY,type WorkerObservationPolicy} from './worker-observation-policy';

const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const assignmentSchema=z.object({rootReservationId:z.string().uuid(),jobId:z.string().uuid(),provider:z.enum(['openai','openrouter']),workerId:z.string().uuid(),avatarId:z.string().uuid(),policyHash:z.string().regex(/^[a-f0-9]{64}$/),envelopeId:z.string().uuid(),perTaskMicros:z.string().regex(/^[1-9][0-9]{0,7}$/).refine(value=>BigInt(value)<=10000000n),expiresAt:z.string().datetime(),generation:z.number().int().positive()}).strict();
export type WorkerComputeAssignment=z.infer<typeof assignmentSchema>;
export type TrustedWorkerAssignment={current:(signal?:AbortSignal)=>Promise<WorkerComputeAssignment>;root:Omit<RootComputeBudgetAuthority,'verifyReservation'>&{verifyReservation(approval:RootComputeEnvelopeApproval,signal?:AbortSignal):Promise<void>}};
export type WorkerJobLease={workerId:string;policyId:string;generation:number;leaseOwner:string};
export const workerBriefSchema=z.object({kind:z.enum(['text-research','text-extraction','text-code','text-writing']),instructions:z.string().min(1).max(15000)}).strict();

/** Timeout runs inside the transaction await. A late callback cannot resume the issuer. */
async function trustedRead<T>(deadline:number,read:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),remaining=Math.min(2000,deadline-Date.now());
  if(remaining<=0)throw new WorkerPolicyError('Trusted authority read deadline');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new WorkerPolicyError('Trusted authority read deadline'));},remaining);});
    const result=await Promise.race([Promise.resolve().then(()=>read(controller.signal)),timeout]);
    if(controller.signal.aborted||Date.now()>=deadline)throw new WorkerPolicyError('Trusted authority read deadline');
    return result;
  }finally{clearTimeout(timer);controller.abort();}
}
const readDeadline=(dbNow:Date,...expiries:number[])=>{
  if(!Number.isFinite(dbNow.getTime())||expiries.some(value=>!Number.isFinite(value)&&value!==Infinity))throw new WorkerPolicyError('Invalid authority expiry');
  return Date.now()+Math.max(0,Math.min(2000,...expiries.map(expiry=>expiry-dbNow.getTime())));
};

/** Trusted host issuer. Public policy approval never creates root provider authority or selects a key. */
export class WorkerAuthorityIssuer{
  constructor(private readonly database:Sql,private readonly authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){}
  private async job(tx:TransactionSql,workerId:string,policyId:string,job?:WorkerJobLease){
    if(!job)return undefined;
    if(job.workerId!==workerId||job.policyId!==policyId)throw new WorkerPolicyError('Worker job scope mismatch');
    const [row]=await tx`SELECT lease_until FROM brainchain_worker_jobs WHERE binding_id=${workerId} AND policy_id=${policyId} AND generation=${job.generation} AND lease_owner=${job.leaseOwner} AND lease_until>clock_timestamp() FOR UPDATE`;
    const [clock]=await tx`SELECT clock_timestamp() AS now`;
    if(!row||date(row.lease_until)<=date(clock!.now))throw new WorkerPolicyError('Worker job expired or replaced');return date(row.lease_until);
  }
  /** Same transaction as the proxy. Never call a base-pool reader while the proxy owns a connection. */
  computeFence(trusted:TrustedWorkerAssignment):WorkerComputeFence{return async(tx,input)=>{
    const [issued]=await tx`SELECT i.*,a.prompt_hash,a.generation,a.authority_policy_version,a.authority_policy_digest,a.expires_at AS authority_expiry,attempt.lease_until AS attempt_expiry FROM brainchain_worker_policy_issuances i
      JOIN brainchain_execution_authorities a ON a.id=i.execution_authority_id JOIN brainchain_task_attempts attempt ON attempt.authority_id=a.id
      WHERE attempt.id=${input.attemptId} AND attempt.task_id=${input.taskId} AND attempt.avatar_id=${input.avatarId}
      AND attempt.generation=${input.generation} AND attempt.lease_owner=${input.leaseOwner} AND i.kind='execution'`;
    if(!issued||issued.prompt_hash!==input.promptHash||issued.generation!==input.generation)throw new WorkerPolicyError('Issued compute scope required');
    assertConfiguredAuthorityPolicy({authorityPolicyVersion:issued.authority_policy_version,authorityPolicyDigest:issued.authority_policy_digest});
    const assignment=assignmentSchema.parse(issued.evidence.assignment);
    const {row,owner}=await this.policy(tx,issued.binding_id,issued.policy_id);
    if(digest(assignment)!==issued.assignment_hash||assignment.workerId!==issued.binding_id||assignment.avatarId!==owner.avatar_id||assignment.policyHash!==row.payload_hash
      ||assignment.envelopeId!==input.envelopeId||input.maximumMicros>BigInt(assignment.perTaskMicros)||input.maximumMicros>BigInt(issued.compute_reserved))throw new WorkerPolicyError('Issued compute assignment mismatch');
    const [envelope]=await tx`SELECT e.*,b.job_id,b.provider FROM brainchain_compute_envelopes e JOIN brainchain_compute_budgets b ON b.id=e.budget_id WHERE e.id=${input.envelopeId}`;
    if(!envelope||envelope.root_reservation_id!==assignment.rootReservationId||envelope.job_id!==assignment.jobId||envelope.provider!==assignment.provider)throw new WorkerPolicyError('Root compute assignment mismatch');
    const jobExpiry=await this.job(tx,issued.binding_id,issued.policy_id,issued.evidence.job);
    const [clock]=await tx`SELECT clock_timestamp() AS now,(SELECT min(deadline) FROM brainchain_compute_calls WHERE attempt_id=${input.attemptId} AND state IN ('reserved','dispatched')) AS call_expiry`;
    if(input.deadlineMs!==undefined&&(!Number.isSafeInteger(input.deadlineMs)||input.deadlineMs<=0))throw new WorkerPolicyError('Invalid compute deadline');
    const dbDeadline=readDeadline(date(clock!.now),date(issued.attempt_expiry).getTime(),date(row.expires_at).getTime(),date(issued.authority_expiry).getTime(),date(issued.attempt_expiry).getTime(),date(envelope.expires_at).getTime(),Date.parse(assignment.expiresAt),jobExpiry?.getTime()??Infinity,clock!.call_expiry?date(clock!.call_expiry).getTime():Infinity);
    const deadline=Math.min(input.deadlineMs??Infinity,dbDeadline,Date.now()+2000);
    await trustedRead(deadline,signal=>trusted.root.verifyReservation({jobId:envelope.job_id,provider:envelope.provider,rootReservationId:envelope.root_reservation_id,approvalRef:envelope.approval_ref,limitMicros:BigInt(envelope.limit_micros),expiresAt:date(envelope.expires_at)},signal));
    if(digest(assignmentSchema.parse(await trustedRead(deadline,signal=>trusted.current(signal))))!==issued.assignment_hash)throw new WorkerPolicyError('Trusted compute assignment changed');
    assertConfiguredAuthorityEvidence(await trustedRead(deadline,signal=>observeConfiguredAuthority(this.authorityReader,{deadlineMs:deadline,signal,observationPolicy:issued.evidence.observationPolicy??LEGACY_WORKER_POLICY})));
    const final=await this.policy(tx,issued.binding_id,issued.policy_id);
    await this.job(tx,issued.binding_id,issued.policy_id,issued.evidence.job);
    if(Date.parse(assignment.expiresAt)<=final.now.getTime()||Date.parse(assignment.expiresAt)>date(envelope.expires_at).getTime())throw new WorkerPolicyError('Trusted compute assignment expired');
  };}
  private async policy(tx:TransactionSql,workerId:string,policyId:string){
    const [owner]=await tx`SELECT w.address,w.avatar_id,w.requested_state,u.id AS user_id,u.linked_wallet_pubkey FROM brainchain_worker_bindings w JOIN avatars a ON a.id=w.avatar_id JOIN users u ON u.id=a.user_id
      WHERE w.id=${workerId} AND w.environment='testnet' AND w.chain_id=274630 AND a.is_guest=false AND u.is_guest=false FOR UPDATE OF w,a,u`;
    const [row]=await tx`SELECT p.*,c.wallet,c.consumed_at,approved.payload AS approved_payload FROM brainchain_worker_policies p
      JOIN brainchain_worker_policy_challenges c ON c.nonce_hash=p.owner_grant_id JOIN brainchain_worker_policies approved ON approved.id=c.policy_id
      WHERE p.id=${policyId} AND p.binding_id=${workerId} FOR UPDATE OF p`;
    const [budget]=await tx`SELECT * FROM brainchain_worker_policy_budgets WHERE binding_id=${workerId} FOR UPDATE`;
    const [clock]=await tx`SELECT clock_timestamp() AS now`;
    if(!owner||!row||!budget||row.state!=='active'||!row.consumed_at||row.wallet!==owner.linked_wallet_pubkey||row.user_id!==owner.user_id||row.avatar_id!==owner.avatar_id||date(row.expires_at)<=date(clock!.now))throw new WorkerPolicyError('Current proved owner policy required');
    const payload=workerOwnerPolicySchema.parse(row.payload),approved=workerOwnerPolicySchema.parse(row.approved_payload);
    if(workerPolicyHash(payload)!==row.payload_hash||!policyNarrows(payload,approved))throw new WorkerPolicyError('Owner grant scope mismatch');
    return{row,payload,budget,owner,now:date(clock!.now)};
  }
  private async prior(tx:TransactionSql,workerId:string,policyId:string,actionKey:string,hash:string,observationPolicy:WorkerObservationPolicy){
    z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).parse(actionKey);
    const [row]=await tx`SELECT * FROM brainchain_worker_policy_issuances WHERE binding_id=${workerId} AND action_key=${actionKey}`;
    if(row&&(row.policy_id!==policyId||row.request_hash!==hash||(row.evidence.observationPolicy??LEGACY_WORKER_POLICY)!==observationPolicy))throw new WorkerPolicyError('Authority action key conflict');
    if(row)assertConfiguredAuthorityPolicy(row.evidence);return row;
  }
  async lifecycle(input:{workerId:string;policyId:string;actionKey:string;request:unknown;fees:{gasLimit:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint};job?:WorkerJobLease},observation:SignerObservation){
    const request=signerRequestSchema.parse(input.request),hash=signerRequestHash(request);
    const gas=input.fees.gasLimit*input.fees.maxFeePerGas;
    if(gas<=0n||input.fees.maxPriorityFeePerGas<0n||input.fees.maxPriorityFeePerGas>input.fees.maxFeePerGas)throw new WorkerPolicyError('Invalid fee bounds');
    assertFreshTestnetObservation(observation);assertConfiguredAuthorityEvidence(observation);
    return this.database.begin(async tx=>{
      const policy=await this.policy(tx,input.workerId,input.policyId),{payload,budget,owner,row,now}=policy;
      const jobExpiry=await this.job(tx,input.workerId,input.policyId,input.job);
      if(input.job&&owner.requested_state!=='running'&&request.kind!=='submit')throw new WorkerPolicyError('Drain refuses new lifecycle authority');
      const prior=await this.prior(tx,input.workerId,input.policyId,input.actionKey,hash,observationPolicyOf(observation));if(prior)return prior;
      if(!payload.actions.includes(request.kind)||gas>BigInt(payload.maxGasPerOperationWei)||gas+BigInt(budget.gas_committed)>BigInt(payload.maxGasTotalWei))throw new WorkerPolicyError('Owner action or gas cap refused');
      const [stream]=await tx`SELECT * FROM brainchain_signer_streams WHERE binding_id=${input.workerId} AND stopped=false`;
      if(!stream||stream.signer_address!==owner.address||observation.bindingAddress!==owner.address)throw new WorkerPolicyError('Policy signer scope mismatch');
      let amount=0n,brain=0n;
      if('amount'in request)amount=BigInt(request.amount);
      if(request.kind==='approve-stake'&&amount>BigInt(payload.maxStakeAtomic))throw new WorkerPolicyError('Stake allowance exceeds owner cap');
      if(request.kind==='approve-bond'&&amount>BigInt(payload.maxBondAtomic))throw new WorkerPolicyError('Bond allowance exceeds owner cap');
      if(request.kind==='stake'){
        if(amount+observation.staked>BigInt(payload.maxStakeAtomic)||request.price!==payload.priceAtomic)throw new WorkerPolicyError('Stake exceeds owner scope');brain=amount;
      }
      if(request.kind==='apply'){amount=observation.bond;brain=amount;if(amount>BigInt(payload.maxBondAtomic))throw new WorkerPolicyError('Bond exceeds owner cap');}
      if(request.kind==='submit'){
        const [result]=await tx`SELECT r.id FROM brainchain_task_results r JOIN brainchain_worker_tasks t ON t.id=r.task_id
          WHERE r.id=${request.resultId} AND r.binding_id=${input.workerId} AND r.avatar_id=${owner.avatar_id}
          AND r.result_hash=${request.hash} AND r.result_uri=${request.uri} AND r.state IN ('uploaded','prepared')
          AND t.task_id=${request.task} AND t.canonical=true AND t.status=2 AND t.board_address=${BRAINCHAIN_CONTRACTS.testnet.contracts.board}`;
        if(!result)throw new WorkerPolicyError('Exact owned frozen submission required');
      }
      if(brain+BigInt(budget.brain_committed)>BigInt(payload.maxBrainTotalAtomic))throw new WorkerPolicyError('Cumulative BRAIN cap refused');
      prepareSignerIntent(request,observation,{requestHash:hash,amount,price:BigInt(payload.priceAtomic),gasCeilingWei:gas});
      const expires=new Date(Math.min(now.getTime()+60000,date(row.expires_at).getTime(),jobExpiry?.getTime()??Infinity));
      const [authority]=await tx`INSERT INTO brainchain_signer_authorities(binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,observation_policy,authority_policy_version,authority_policy_digest)
        VALUES(${input.workerId},${owner.avatar_id},'testnet',274630,${owner.address},${stream.generation},${request.kind},${hash},${amount.toString()},${'owner-policy:'+row.id},${tx.typed(expires.toISOString(),25)}::timestamptz,${observationPolicyOf(observation)},${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
      const [gasAuthority]=await tx`INSERT INTO brainchain_signer_authorities(binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,observation_policy,authority_policy_version,authority_policy_digest)
        VALUES(${input.workerId},${owner.avatar_id},'testnet',274630,${owner.address},${stream.generation},'gas',${hash},${gas.toString()},${'owner-policy:'+row.id},${tx.typed(expires.toISOString(),25)}::timestamptz,${observationPolicyOf(observation)},${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
      await tx`UPDATE brainchain_worker_policy_budgets SET gas_committed=gas_committed+${gas.toString()}::numeric,brain_committed=brain_committed+${brain.toString()}::numeric WHERE binding_id=${input.workerId}`;
      const [issued]=await tx`INSERT INTO brainchain_worker_policy_issuances(policy_id,binding_id,avatar_id,action_key,kind,request_hash,evidence,signer_authority_id,gas_authority_id,gas_reserved,brain_reserved)
        VALUES(${row.id},${input.workerId},${owner.avatar_id},${input.actionKey},${request.kind},${hash},${tx.typed(JSON.stringify({authorityPolicyVersion:CONFIGURED_AUTHORITY_VERSION,authorityPolicyDigest:CONFIGURED_AUTHORITY_DIGEST,request,observationPolicy:observationPolicyOf(observation),policyHash:row.payload_hash,blockHash:observation.blockHash,job:input.job??null}),25)}::jsonb,${authority!.id},${gasAuthority!.id},${gas.toString()},${brain.toString()}) RETURNING *`;
      await this.policy(tx,input.workerId,input.policyId);await this.job(tx,input.workerId,input.policyId,input.job);assertFreshTestnetObservation(observation);return issued!;
    });
  }
  async resultSignature(workerId:string,policyId:string,resultId:string,job?:WorkerJobLease,observationPolicy:WorkerObservationPolicy=LEGACY_WORKER_POLICY){
    return this.database.begin(async tx=>{
      const {row,payload,owner,now}=await this.policy(tx,workerId,policyId);
      const jobExpiry=await this.job(tx,workerId,policyId,job);
      assertConfiguredAuthorityEvidence(await observeConfiguredAuthority(this.authorityReader,{deadlineMs:readDeadline(now,date(row.expires_at).getTime(),jobExpiry?.getTime()??Infinity),observationPolicy}));
      if(!payload.actions.includes('submit'))throw new WorkerPolicyError('Submit permission required');
      const [result]=await tx`SELECT r.*,t.board_address,t.task_id AS external_task FROM brainchain_task_results r JOIN brainchain_worker_tasks t ON t.id=r.task_id WHERE r.id=${resultId} AND r.binding_id=${workerId} AND t.canonical=true`;
      const [stream]=await tx`SELECT * FROM brainchain_signer_streams WHERE binding_id=${workerId} AND stopped=false`;
      if(!result||!stream)throw new WorkerPolicyError('Canonical frozen result required');
      const intent=freezeResultSignatureIntent({domain:'brainchain-result-v2',chainId:274630,resultId,board:result.board_address,task:result.external_task,hash:result.result_hash,worker:owner.address});
      const hash=resultSignatureClaimHash(stream.signer_ref,intent),key='signature:'+resultId;
      const existing=await this.prior(tx,workerId,policyId,key,hash,observationPolicy);if(existing)return existing;
      const [authority]=await tx`INSERT INTO brainchain_signer_authorities(binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,observation_policy,authority_policy_version,authority_policy_digest)
        VALUES(${workerId},${owner.avatar_id},'testnet',274630,${owner.address},${stream.generation},'result-signature',${hash},0,${'owner-policy:'+row.id},${tx.typed(new Date(Math.min(now.getTime()+60000,date(row.expires_at).getTime(),jobExpiry?.getTime()??Infinity)).toISOString(),25)}::timestamptz,${observationPolicy},${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
      const [issued]=await tx`INSERT INTO brainchain_worker_policy_issuances(policy_id,binding_id,avatar_id,action_key,kind,request_hash,evidence,signer_authority_id)
        VALUES(${policyId},${workerId},${owner.avatar_id},${key},'result-signature',${hash},${tx.typed(JSON.stringify({authorityPolicyVersion:CONFIGURED_AUTHORITY_VERSION,authorityPolicyDigest:CONFIGURED_AUTHORITY_DIGEST,resultId,observationPolicy,policyHash:row.payload_hash,job:job??null}),25)}::jsonb,${authority!.id}) RETURNING *`;
      await this.policy(tx,workerId,policyId);await this.job(tx,workerId,policyId,job);return issued!;
    });
  }
  async execution(input:{workerId:string;policyId:string;taskId:string;brief:string;job?:WorkerJobLease;observationPolicy?:WorkerObservationPolicy},trusted:TrustedWorkerAssignment){
    if(Buffer.byteLength(input.brief)>16384)throw new WorkerPolicyError('Brief exceeds policy bound');
    let initialDeadline=Date.now()+2000;
    if(input.job){
      const [lease]=await this.database`SELECT lease_until,clock_timestamp() AS now FROM brainchain_worker_jobs WHERE binding_id=${input.workerId} AND policy_id=${input.policyId} AND generation=${input.job.generation} AND lease_owner=${input.job.leaseOwner}`;
      if(!lease)throw new WorkerPolicyError('Worker job expired or replaced');initialDeadline=readDeadline(date(lease.now),date(lease.lease_until).getTime());
    }
    const brief=workerBriefSchema.parse(JSON.parse(input.brief)),assignment=assignmentSchema.parse(await trustedRead(initialDeadline,signal=>trusted.current(signal))),assignmentHash=digest(assignment),prompt=buildIsolatedTaskPrompt(input.brief);
    return this.database.begin(async tx=>{
      // Execution admission locks task before binding; the issuer keeps the same order.
      const [task]=await tx`SELECT * FROM brainchain_worker_tasks WHERE id=${input.taskId} AND binding_id=${input.workerId} FOR UPDATE`;
      const {row,payload,budget,owner,now}=await this.policy(tx,input.workerId,input.policyId);
      if(input.job&&owner.requested_state!=='running')throw new WorkerPolicyError('Drain refuses new execution authority');
      const jobExpiry=await this.job(tx,input.workerId,input.policyId,input.job);
      if(!task?.canonical||task.status!==2||task.board_address!==BRAINCHAIN_CONTRACTS.testnet.contracts.board||task.brief_hash!==keccak256(toBytes(input.brief))||!payload.taskKinds.includes(brief.kind))throw new WorkerPolicyError('Owner task scope refused');
      if(assignment.workerId!==input.workerId||assignment.avatarId!==owner.avatar_id||assignment.policyHash!==row.payload_hash||Date.parse(assignment.expiresAt)<=now.getTime())throw new WorkerPolicyError('Trusted compute assignment mismatch');
      const [envelope]=await tx`SELECT e.*,b.job_id,b.provider FROM brainchain_compute_envelopes e JOIN brainchain_compute_budgets b ON b.id=e.budget_id WHERE e.id=${assignment.envelopeId}`;
      if(!envelope||envelope.state!=='open'||envelope.root_reservation_id!==assignment.rootReservationId||envelope.job_id!==assignment.jobId||envelope.provider!==assignment.provider||Date.parse(assignment.expiresAt)>date(envelope.expires_at).getTime())throw new WorkerPolicyError('Existing root envelope required');
      const approval:RootComputeEnvelopeApproval={jobId:envelope.job_id,provider:envelope.provider,rootReservationId:envelope.root_reservation_id,approvalRef:envelope.approval_ref,limitMicros:BigInt(envelope.limit_micros),expiresAt:date(envelope.expires_at)};
      const [readClock]=await tx`SELECT clock_timestamp() AS now`;
      const deadline=readDeadline(date(readClock!.now),date(row.expires_at).getTime(),date(envelope.expires_at).getTime(),Date.parse(assignment.expiresAt),Number(task.deadline_unix)*1000,jobExpiry?.getTime()??Infinity);
      await trustedRead(deadline,signal=>trusted.root.verifyReservation(approval,signal));
      if(digest(assignmentSchema.parse(await trustedRead(deadline,signal=>trusted.current(signal))))!==assignmentHash)throw new WorkerPolicyError('Trusted compute assignment changed');
      assertConfiguredAuthorityEvidence(await trustedRead(deadline,signal=>observeConfiguredAuthority(this.authorityReader,{deadlineMs:deadline,signal,observationPolicy:input.observationPolicy})));
      const hash=digest({taskId:input.taskId,briefHash:task.brief_hash,promptHash:digest(prompt),assignmentHash}),key='execute:'+input.taskId;
      const prior=await this.prior(tx,input.workerId,input.policyId,key,hash,input.observationPolicy??LEGACY_WORKER_POLICY);if(prior)return prior;
      const maximum=BigInt(assignment.perTaskMicros),committed=BigInt(assignment.provider==='openai'?budget.openai_committed:budget.openrouter_committed),cap=BigInt(assignment.provider==='openai'?payload.openaiMicros:payload.openrouterMicros);
      if(committed+maximum>cap||budget.tasks_committed>=payload.maxTasks)throw new WorkerPolicyError('Cumulative owner compute cap refused');
      const [clock]=await tx`SELECT clock_timestamp() AS now`;
      const expires=new Date(Math.min(date(clock!.now).getTime()+60000,date(row.expires_at).getTime(),Date.parse(assignment.expiresAt),Number(task.deadline_unix)*1000,jobExpiry?.getTime()??Infinity));
      if(expires.getTime()<=date(clock!.now).getTime())throw new WorkerPolicyError('Execution authority expired');
      const [authority]=await tx`INSERT INTO brainchain_execution_authorities(task_id,binding_id,avatar_id,environment,chain_id,generation,brief_hash,input_hash,prompt_hash,approved_by,expires_at,observation_policy,authority_policy_version,authority_policy_digest)
        VALUES(${task.id},${input.workerId},${owner.avatar_id},'testnet',274630,${task.lease_generation+1},${task.brief_hash},${digest(input.brief)},${digest(prompt)},${'owner-policy:'+row.id},${tx.typed(expires.toISOString(),25)}::timestamptz,${input.observationPolicy??LEGACY_WORKER_POLICY},${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
      if(assignment.provider==='openai')await tx`UPDATE brainchain_worker_policy_budgets SET openai_committed=openai_committed+${maximum.toString()}::bigint,tasks_committed=tasks_committed+1 WHERE binding_id=${input.workerId}`;
      else await tx`UPDATE brainchain_worker_policy_budgets SET openrouter_committed=openrouter_committed+${maximum.toString()}::bigint,tasks_committed=tasks_committed+1 WHERE binding_id=${input.workerId}`;
      const [issued]=await tx`INSERT INTO brainchain_worker_policy_issuances(policy_id,binding_id,avatar_id,action_key,kind,request_hash,assignment_hash,evidence,execution_authority_id,compute_reserved)
        VALUES(${row.id},${input.workerId},${owner.avatar_id},${key},'execution',${hash},${assignmentHash},${tx.typed(JSON.stringify({authorityPolicyVersion:CONFIGURED_AUTHORITY_VERSION,authorityPolicyDigest:CONFIGURED_AUTHORITY_DIGEST,assignment,observationPolicy:input.observationPolicy??LEGACY_WORKER_POLICY,promptHash:digest(prompt),briefHash:task.brief_hash,job:input.job??null}),25)}::jsonb,${authority!.id},${maximum.toString()}) RETURNING *`;
      await this.policy(tx,input.workerId,input.policyId);await this.job(tx,input.workerId,input.policyId,input.job);return issued!;
    });
  }
}
