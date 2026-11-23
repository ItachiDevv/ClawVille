import {z} from 'zod';
import {BrainchainWorkerCoordinator,workerTickSchema,type WorkerRuntime,type WorkerTick} from './worker-coordinator';
import {WorkerAuthorityIssuer,type TrustedWorkerAssignment} from './worker-authority-issuer';
import {WorkerJobs,type WorkerJob} from './worker-jobs';
import {WorkerPolicyError,workerOwnerPolicySchema} from './worker-owner-policy';
import {DurableInferenceProxy,type ReservedProviderAdapter} from './inference-proxy';
import type {ComputePricePolicy} from './inference-policy';
import {createWorkerBriefReader} from './worker-brief-reader';
import {observeSignerReceipt} from './signer-service';
import {ExactCaptureRecovery} from './exact-capture-recovery';
import {ExactResultRecoveryIssuer} from './exact-result-recovery-issuer';
import type {DeliveryStage} from './delivery-recovery';
import type {SignerRequest} from './signer-policy';

export type WorkerSchedulerConfiguration={
  runtime:Omit<WorkerRuntime,'compute'>;
  compute:{assignment:TrustedWorkerAssignment;prices:readonly ComputePricePolicy[];adapters:readonly ReservedProviderAdapter[];
    bundle:NonNullable<WorkerRuntime['compute']>['bundle'];reservation:NonNullable<WorkerRuntime['compute']>['reservation']};
  application:{name:string;about:string};
  hostId?:string;
  captureRecovery?:ExactCaptureRecovery;
};
const persisted=z.object({version:z.literal(1),tick:workerTickSchema}).strict();

/** Explicit host tick. No boot hook, timer, credentials, policy grant, or provider-budget allocation. */
export class BrainchainWorkerScheduler{
  private readonly jobs:WorkerJobs;
  private readonly issuer:WorkerAuthorityIssuer;
  private readonly coordinator:BrainchainWorkerCoordinator;
  private readonly readBrief:ReturnType<typeof createWorkerBriefReader>;
  constructor(private readonly configuration:WorkerSchedulerConfiguration){
    const {runtime,compute}=configuration;
    this.jobs=new WorkerJobs(runtime.database,configuration.hostId);
    this.issuer=new WorkerAuthorityIssuer(runtime.database,runtime.authorityReader);
    // Every owner-issued task uses this concrete fence. A supplied root-only proxy is not accepted.
    const proxy=new DurableInferenceProxy(runtime.database,compute.prices,compute.adapters,compute.assignment.root,this.issuer.computeFence(compute.assignment),runtime.authorityReader);
    this.coordinator=new BrainchainWorkerCoordinator({...runtime,compute:{proxy,bundle:compute.bundle,reservation:compute.reservation}});
    this.readBrief=createWorkerBriefReader(runtime.database,{},runtime.observationPolicy);
    z.object({name:z.string().trim().min(1).max(60),about:z.string().trim().min(1).max(500)}).strict().parse(configuration.application);
  }
  async tick(workerId:string){
    z.string().uuid().parse(workerId);
    const job=await this.jobs.claim(workerId);if(!job)return{state:'not-started-or-busy'};
    let tick:WorkerTick;
    if(job.pendingPlan){
      tick=persisted.parse(job.pendingPlan).tick;
      if(tick.workerId!==job.workerId||tick.avatarId!==job.avatarId)throw new WorkerPolicyError('Retained plan owner changed');
      const blocked=await this.checkReceipts(job,['receipt','receipt-lifecycle'].includes(tick.stage)?tick.operationId:undefined);if(blocked)return blocked;
    }else{
      // Check all retained included operations before a later authority. No liability is released here.
      const blocked=await this.checkReceipts(job);if(blocked)return blocked;
      const next=await this.plan(job);if(!('stage'in next))return next;
      tick=workerTickSchema.parse(next);
      await this.jobs.persist(job,{version:1,tick});
    }
    const result=await this.coordinator.tick(tick);
    const state=String(result.state);
    if(['uncertain','upload-evidence-required','compute-evidence-required','busy'].includes(state))return{state:'retained-evidence-required',stage:tick.stage};
    // If a host dies here, the immutable plan replays against the concrete service's durable records.
    await this.jobs.completeStage(job,`stage-${tick.stage}`);
    return{state,stage:tick.stage};
  }
  /** Separate owner-consent path. It never restarts a paused policy or issues compute authority. */
  async recover(workerId:string,resultId:string,consentId:string){
    for(const value of [workerId,resultId,consentId])z.string().uuid().parse(value);
    const {database,signer}=this.configuration.runtime;
    await new ExactResultRecoveryIssuer(database,this.configuration.runtime.authorityReader).pending(workerId,consentId,resultId);
    const [result]=await database`SELECT r.*,t.status AS task_status FROM brainchain_task_results r JOIN brainchain_worker_tasks t ON t.id=r.task_id
      WHERE r.id=${resultId} AND r.binding_id=${workerId} AND t.environment='testnet' AND t.chain_id=274630`;
    if(!result)throw new WorkerPolicyError('Exact owned testnet result required');
    const base={workerId,avatarId:String(result.avatar_id),taskId:String(result.task_id)};
    const [signature]=await database`SELECT state FROM brainchain_result_signatures WHERE result_id=${resultId}`;
    const [operation]=await database`SELECT o.id,o.state,o.accepted_at,o.signed_payload_ref FROM brainchain_result_submissions s
      JOIN brainchain_signer_operations o ON o.id=s.operation_id WHERE s.result_id=${resultId}`;
    // Existing admissions without capture recover evidence only. They never authorize another key use.
    if(signature&&signature.state!=='captured')return this.coordinator.tick({...base,stage:'signature'});
    if(operation?.state==='broadcast')return this.coordinator.tick({...base,stage:'receipt',operationId:operation.id});
    if(operation?.accepted_at&&!operation.signed_payload_ref)return this.coordinator.tick({...base,stage:'capture-submit',operationId:operation.id});
    if(operation&&!operation.signed_payload_ref){
      if(!signer||!this.configuration.captureRecovery)return{state:'exact-capture-consent-required'};
      const authority=await this.configuration.captureRecovery.issue({...base,resultId,consentId});
      const [worker]=await database`SELECT address FROM brainchain_worker_bindings WHERE id=${workerId} AND avatar_id=${base.avatarId}`;
      if(!worker)throw new WorkerPolicyError('Exact capture worker unavailable');
      const answer=await this.configuration.captureRecovery.capture({authorityId:String(authority.id),observation:await this.configuration.runtime.observe(workerId),nonces:await signer.transport.nonces(worker.address),driver:signer.driver,store:signer.transactions});
      return{state:answer.state,stage:'capture-submit'};
    }
    let stage:DeliveryStage;
    if(result.task_status===3||['uploading','upload_uncertain'].includes(result.state)||operation?.state==='confirmed')stage='reconcile';
    else if(!signature)stage='signature';
    else if(!['uploaded','prepared'].includes(result.state))stage='upload';
    else if(operation?.signed_payload_ref)stage='broadcast';
    else stage='prepare-submit';
    const issued=await new ExactResultRecoveryIssuer(database,this.configuration.runtime.authorityReader).issue({avatarId:base.avatarId,workerId,resultId,consentId,stage,fees:signer?.fees});
    const tick:WorkerTick={...base,stage,deliveryAuthorityId:String(issued!.delivery_authority_id),
      authorityId:issued!.signer_authority_id??undefined,gasAuthorityId:issued!.gas_authority_id??undefined,
      operationId:operation?.id};
    const answer=await this.coordinator.tick(tick);return{state:answer.state,stage:tick.stage};
  }
  private async checkReceipts(job:WorkerJob,observedOperation?:string){
    const {database,signer}=this.configuration.runtime;
    const operations=await database`SELECT id FROM brainchain_signer_operations WHERE binding_id=${job.workerId} AND state='confirmed' ORDER BY created_at LIMIT 101`;
    if(operations.length>100)return{state:'receipt-history-review-required'};
    if(operations.length&&!signer)throw new WorkerPolicyError('Concrete signer transport required');
    for(const operation of operations){
      if(operation.id===observedOperation)continue;
      const receipt=await observeSignerReceipt(operation.id,signer!.transport);
      if(!receipt.progressionAllowed)return{state:'receipt-not-canonical-success'};
    }
    return null;
  }
  private async plan(job:WorkerJob):Promise<WorkerTick|{state:string}>{
    const {database,signer}=this.configuration.runtime,base={workerId:job.workerId,avatarId:job.avatarId};
    const [binding]=await database`SELECT requested_state FROM brainchain_worker_bindings WHERE id=${job.workerId}`;
    const draining=binding?.requested_state==='draining';
    const [pending]=await database`SELECT id,kind,state,accepted_at,signed_payload_ref FROM brainchain_signer_operations
      WHERE binding_id=${job.workerId} AND state NOT IN ('confirmed','rejected') ORDER BY created_at LIMIT 1`;
    if(pending){
      if(draining&&pending.kind!=='submit'&&!pending.signed_payload_ref)return{state:'draining-unsigned-lifecycle-retained'};
      const submit=pending.kind==='submit';let taskId:string|undefined;
      if(submit){const [row]=await database`SELECT r.task_id FROM brainchain_result_submissions s JOIN brainchain_task_results r ON r.id=s.result_id WHERE s.operation_id=${pending.id}`;taskId=row?.task_id;if(!taskId)throw new WorkerPolicyError('Submit result lineage unavailable');}
      if(pending.state==='uncertain'&&!pending.signed_payload_ref)return{state:'signature-capture-evidence-required'};
      const stage:WorkerTick['stage']=pending.state==='broadcast'||pending.state==='uncertain'?(submit?'receipt':'receipt-lifecycle'):
        pending.signed_payload_ref?(submit?'broadcast':'broadcast-lifecycle'):(submit?'capture-submit':'capture-lifecycle');
      return{...base,taskId,operationId:pending.id,stage};
    }
    const [policyRow]=await database`SELECT payload FROM brainchain_worker_policies WHERE id=${job.policyId}`;
    const policy=workerOwnerPolicySchema.parse(policyRow?.payload);
    const state=await this.configuration.runtime.observe(job.workerId);
    const need=state.minStake>state.staked?state.minStake-state.staked:0n;
    let request:Exclude<SignerRequest,{kind:'submit'}>|undefined;
    if(state.gasBalance===0n)return{state:'testnet-gas-required'};
    if(!draining&&need>0n){
      if(state.brainBalance<need){
        if(state.lastClaim!==0n&&state.blockTimestamp<state.lastClaim+state.faucetInterval)return{state:'faucet-cooldown'};
        request={kind:'faucet'};
      }else request=state.stakingAllowance<need?{kind:'approve-stake',amount:need.toString()}:{kind:'stake',amount:need.toString(),price:policy.priceAtomic};
    }else if(!draining&&!state.allowed){
      if(state.applicationVetoed)return{state:'application-vetoed'};
      if(state.applicationPending)return{state:'application-pending'};
      if(state.brainBalance<state.bond)return{state:'application-bond-required'};
      request=state.bondAllowance<state.bond?{kind:'approve-bond',amount:state.bond.toString()}:{kind:'apply',...this.configuration.application};
    }
    if(request){
      if(!signer)throw new WorkerPolicyError('Concrete signer configuration required');
      const issued=await this.issuer.lifecycle({workerId:job.workerId,policyId:job.policyId,job,actionKey:`lifecycle:${job.generation}:${request.kind}:${state.blockHash}`,request,fees:signer.fees},state);
      return{...base,stage:'prepare-lifecycle',authorityId:issued.signer_authority_id,gasAuthorityId:issued.gas_authority_id,lifecycleRequest:request,idempotencyKey:issued.id};
    }
    const tasks=await database`SELECT t.id,t.status FROM brainchain_worker_tasks t WHERE t.binding_id=${job.workerId} AND t.canonical=true AND t.status IN (2,3) ORDER BY t.hire_block LIMIT 2`;
    if(tasks.length>1)return{state:'multiple-hire-review-required'};
    if(!tasks.length)return{...base,stage:'index'};
    const taskId=String(tasks[0]!.id);
    const [result]=await database`SELECT * FROM brainchain_task_results WHERE task_id=${taskId}`;
    if(result){
      const [submitted]=await database`SELECT o.id FROM brainchain_result_submissions s JOIN brainchain_signer_operations o ON o.id=s.operation_id WHERE s.result_id=${result.id} AND o.state='confirmed'`;
      if(tasks[0]!.status===3||submitted)return{...base,stage:'index'};
      if(['uploading','upload_uncertain'].includes(result.state))return{state:'upload-evidence-required'};
      const [signature]=await database`SELECT id,state FROM brainchain_result_signatures WHERE result_id=${result.id}`;
      if(!signature){
        const issued=await this.issuer.resultSignature(job.workerId,job.policyId,result.id,job,state.observationPolicy);
        return{...base,taskId,stage:'signature',authorityId:issued.signer_authority_id};
      }
      if(signature.state!=='captured')return{state:'signature-capture-evidence-required'};
      if(!['uploaded','prepared'].includes(result.state))return{...base,taskId,stage:'upload'};
      if(!signer)throw new WorkerPolicyError('Concrete signer configuration required');
      const [task]=await database`SELECT task_id FROM brainchain_worker_tasks WHERE id=${taskId}`;
      const submit={kind:'submit' as const,resultId:result.id,task:String(task!.task_id),hash:result.result_hash,uri:result.result_uri};
      const issued=await this.issuer.lifecycle({workerId:job.workerId,policyId:job.policyId,job,actionKey:`submit:${result.id}`,request:submit,fees:signer.fees},state);
      return{...base,taskId,stage:'prepare-submit',authorityId:issued.signer_authority_id,gasAuthorityId:issued.gas_authority_id};
    }
    const [attempt]=await database`SELECT id FROM brainchain_task_attempts WHERE task_id=${taskId} AND purpose='execution' ORDER BY attempt_number DESC LIMIT 1`;
    if(attempt){
      const [call]=await database`SELECT state FROM brainchain_compute_calls WHERE attempt_id=${attempt.id}`;
      if(call)return call.state==='settled'?{...base,taskId,stage:'freeze'}:{state:'compute-evidence-required'};
      return{...base,taskId,stage:'compute',brief:await this.readBrief(job.workerId,taskId)};
    }
    if(draining)return{state:'drained-no-new-execution'};
    const brief=await this.readBrief(job.workerId,taskId);
    const issued=await this.issuer.execution({workerId:job.workerId,policyId:job.policyId,job,taskId,brief,observationPolicy:state.observationPolicy},this.configuration.compute.assignment);
    return{...base,taskId,stage:'admit',brief,authorityId:issued.execution_authority_id};
  }
}
