import type {ConfiguredAuthorityReader} from './configured-authority-reader';
import type {Sql} from 'postgres';
import {z} from 'zod';
import {db as serviceDatabase,sql} from '@clawville/database';
import {buildIsolatedTaskPrompt} from '@clawville/agent-runtime/isolated-task';
import {claimExecutionAttempt} from './execution';
import {syncOwnedWorker,readOwnedWorkerSnapshot} from './indexer';
import {TaskDeliveryCoordinator} from './task-delivery';
import {DeliveryRecovery,type DeliveryLeaseProof} from './delivery-recovery';
import {ResultSignatureCoordinator} from './result-signing';
import {runBrainchainIsolatedProcess,type IsolatedProcessBundle} from './isolated-process-coordinator';
import type {DurableInferenceProxy,ReserveComputeInput} from './inference-proxy';
import {prepareSignerOperation} from './signer-operations';
import {captureSignerOperation,recoverCapturedOperation,broadcastCapturedOperation,observeSignerReceipt,type DedicatedSignerDriver,type ProtectedSignedPayloadStore} from './signer-service';
import type {ProtectedSignerJournal} from './signer-payload-store';
import type {DedicatedResultSignerDriver} from './result-signing-policy';
import type {FixedTestnetTransport} from './signer-rpc';
import type {ResultUploadTransport} from './task-delivery-protocol';
import {signerRequestSchema,type SignerObservation} from './signer-policy';
import type {WorkerObservationPolicy} from './worker-observation-policy';
import {databaseDate} from './database-values';

const uuid=z.string().uuid();
export const workerTickSchema=z.object({avatarId:uuid,workerId:uuid,taskId:uuid.optional(),
  stage:z.enum(['status','index','prepare-lifecycle','capture-lifecycle','broadcast-lifecycle','receipt-lifecycle','admit','compute','freeze','signature','upload','prepare-submit','capture-submit','broadcast','receipt','reconcile']),
  lifecycleRequest:signerRequestSchema.refine(value=>value.kind!=='submit').optional(),operationId:uuid.optional(),idempotencyKey:uuid.optional(),
  authorityId:uuid.optional(),gasAuthorityId:uuid.optional(),deliveryAuthorityId:uuid.optional(),
  deliveryProof:z.object({leaseId:uuid,leaseOwner:uuid}).strict().optional(),
  brief:z.string().min(1).max(16384).optional(),
}).strict();
export type WorkerTick=z.infer<typeof workerTickSchema>;
type Observation=SignerObservation & {blockNumber:bigint};
/** Trusted host composition. No HTTP caller supplies these adapters, paths, credentials or authority factories. */
export interface WorkerRuntime {
  authorityReader?:ConfiguredAuthorityReader;
  observationPolicy?:WorkerObservationPolicy;
  database:Sql;
  /** Separate pool, same database. It owns only the session lock, so nested services cannot exhaust it. */
  lockDatabase:Sql;
  observe(workerId:string):Promise<Observation>;
  compute?:{proxy:DurableInferenceProxy;bundle:IsolatedProcessBundle;reservation:Pick<ReserveComputeInput,'envelopeId'|'model'|'pricingVersion'|'maxInputTokens'|'maxOutputTokens'>};
  signer?:{driver:DedicatedSignerDriver;results:DedicatedResultSignerDriver;transactions:ProtectedSignedPayloadStore;signatures:ProtectedSignerJournal;transport:FixedTestnetTransport;fees:{gasLimit:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}};
  upload?:ResultUploadTransport;
  recovery?:DeliveryRecovery;
}
export class WorkerCoordinatorError extends Error {readonly code='worker_tick_refused';}
const required=<T>(value:T|undefined,label:string):T=>{if(value===undefined)throw new WorkerCoordinatorError(`${label} required`);return value;};

/** Exactly one explicit stage. No timers, authority issuance, background loop or credential discovery. */
export class BrainchainWorkerCoordinator {
  constructor(private readonly runtime:WorkerRuntime){
    if(runtime.database===runtime.lockDatabase)throw new WorkerCoordinatorError('Separate lock pool required');
  }
  async tick(raw:WorkerTick){
    const input=workerTickSchema.parse(raw),db=this.runtime.database;
    const lock=await this.runtime.lockDatabase.reserve();
    let locked=false;
    try{
      const [identity]=await db`SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port`;
      const [lockIdentity]=await lock`SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port`;
      const [serviceIdentity]=await serviceDatabase.execute(sql`SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port`);
      if(JSON.stringify(identity)!==JSON.stringify(lockIdentity)||JSON.stringify(identity)!==JSON.stringify(serviceIdentity))throw new WorkerCoordinatorError('Service database mismatch');
      const [claim]=await lock`SELECT pg_try_advisory_lock(hashtextextended(${`brainchain-worker-tick:${input.workerId}`},0)) AS acquired`;
      locked=claim!.acquired===true;if(!locked)return{state:'busy' as const};
      const [worker]=await db`SELECT id,address,requested_state FROM brainchain_worker_bindings WHERE id=${input.workerId} AND avatar_id=${input.avatarId} AND environment='testnet' AND chain_id=274630`;
      if(!worker)throw new WorkerCoordinatorError('Owned testnet worker required');
      if(input.stage==='index')return{state:'indexed',observation:await syncOwnedWorker(input.avatarId,input.workerId,undefined,this.runtime.observationPolicy)};
      if(input.stage==='status'){
        const snapshot=await readOwnedWorkerSnapshot(input.avatarId,input.workerId);
        const next=snapshot.freshness.state==='stale'?'wait-fresh-chain':BigInt(snapshot.balances.gasWei)===0n?'fund-testnet-gas':
          BigInt(snapshot.stake.stakedAtomic)<BigInt(snapshot.terms.minStakeAtomic)?'approve-and-stake':!snapshot.allowed?'apply-and-await-approval':'await-hire';
        return{state:'status',requestedState:worker.requested_state,next,executionEnabled:false,snapshot};
      }
      if(input.stage.endsWith('-lifecycle')){
        const signer=required(this.runtime.signer,'Signer process configuration');
        if(input.stage==='prepare-lifecycle'){
          const operation=await prepareSignerOperation({avatarId:input.avatarId,bindingId:input.workerId,authorityId:required(input.authorityId,'Lifecycle authority'),gasAuthorityId:required(input.gasAuthorityId,'Gas authority'),idempotencyKey:required(input.idempotencyKey,'Idempotency key'),request:required(input.lifecycleRequest,'Typed lifecycle request'),fees:signer.fees},await this.runtime.observe(input.workerId));
          return{state:'prepared',operationId:operation.id};
        }
        const [operation]=await db`SELECT id,accepted_at FROM brainchain_signer_operations WHERE id=${required(input.operationId,'Lifecycle operation')} AND binding_id=${input.workerId} AND avatar_id=${input.avatarId} AND kind<>'submit'`;
        if(!operation)throw new WorkerCoordinatorError('Owned lifecycle operation required');
        if(input.stage==='receipt-lifecycle')return observeSignerReceipt(operation.id,signer.transport);
        if(input.stage==='broadcast-lifecycle')return broadcastCapturedOperation(operation.id,await this.runtime.observe(input.workerId),signer.transactions,signer.transport,undefined,this.runtime.authorityReader);
        if(operation.accepted_at)return recoverCapturedOperation(operation.id,signer.transactions);
        return captureSignerOperation({operationId:operation.id,observation:await this.runtime.observe(input.workerId),nonces:await signer.transport.nonces(worker.address),driver:signer.driver,store:signer.transactions,authorityReader:this.runtime.authorityReader});
      }
      const taskId=required(input.taskId,'Task');
      const [task]=await db`SELECT * FROM brainchain_worker_tasks WHERE id=${taskId} AND binding_id=${input.workerId} AND avatar_id=${input.avatarId}`;
      if(!task)throw new WorkerCoordinatorError('Owned task required');
      const [result]=await db`SELECT id,state,result_hash,result_uri FROM brainchain_task_results WHERE task_id=${taskId} AND avatar_id=${input.avatarId}`;
      if(result&&['admit','compute','freeze'].includes(input.stage))return{state:'frozen',resultId:String(result.id),next:'signature'};
      if(input.stage==='admit'){
        const [attempt]=await db`SELECT id FROM brainchain_task_attempts WHERE task_id=${taskId} AND purpose='execution' LIMIT 1`;
        if(attempt)return{state:'existing-attempt',next:'inspect-compute-evidence'};
        const brief=required(input.brief,'Exact brief'),observation=await this.runtime.observe(input.workerId);
        const admitted=await claimExecutionAttempt({avatarId:input.avatarId,taskId,authorityId:required(input.authorityId,'Execution authority'),brief,prompt:buildIsolatedTaskPrompt(brief),observation:{authorityPolicyVersion:observation.authorityPolicyVersion,authorityPolicyDigest:observation.authorityPolicyDigest,observedAt:observation.observedAt,blockTimestamp:observation.blockTimestamp,blockNumber:observation.blockNumber,blockHash:observation.blockHash,observationPolicy:observation.observationPolicy}},this.runtime.authorityReader);
        return{state:'admitted',attemptId:admitted.id};
      }
      if(input.stage==='compute'||input.stage==='freeze'){
        const [attempt]=await db`SELECT * FROM brainchain_task_attempts WHERE task_id=${taskId} AND purpose='execution' ORDER BY attempt_number DESC LIMIT 1`;
        if(!attempt)throw new WorkerCoordinatorError('Execution attempt required');
        const [call]=await db`SELECT id,state FROM brainchain_compute_calls WHERE attempt_id=${attempt.id} ORDER BY created_at LIMIT 1`;
        if(input.stage==='freeze'){
          if(!call||call.state!=='settled')return{state:'compute-evidence-required'};
          const frozen=await new TaskDeliveryCoordinator(db,undefined,undefined,this.runtime.authorityReader).freeze({avatarId:input.avatarId,taskId,attemptId:attempt.id,callId:call.id,generation:attempt.generation,leaseOwner:attempt.lease_owner});
          return{state:'frozen',resultId:frozen.id};
        }
        if(call)return{state:'existing-compute',computeState:String(call.state),next:call.state==='settled'?'freeze':'inspect-compute-evidence'};
        const compute=required(this.runtime.compute,'Compute configuration'),brief=required(input.brief,'Exact brief');
        const reserved=await compute.proxy.reserve({...compute.reservation,avatarId:input.avatarId,taskId,attemptId:attempt.id,generation:attempt.generation,leaseOwner:attempt.lease_owner,prompt:buildIsolatedTaskPrompt(brief),deadlineMs:databaseDate(attempt.lease_until).getTime()});
        await runBrainchainIsolatedProcess({bundle:compute.bundle,...reserved,brief,proxy:compute.proxy});
        return{state:'computed',callId:reserved.binding.callId,next:'freeze'};
      }
      if(!result)throw new WorkerCoordinatorError('Frozen result required');
      if(['uploading','upload_uncertain'].includes(result.state)&&input.stage!=='reconcile')return{state:'upload-evidence-required',resultId:result.id};
      const recovery=this.runtime.recovery??new DeliveryRecovery(db,undefined,this.runtime.authorityReader);
      let proof:DeliveryLeaseProof|undefined=input.deliveryProof;
      if(!proof&&input.deliveryAuthorityId){
        const [retained]=await db`SELECT id,lease_owner FROM brainchain_delivery_leases WHERE authority_id=${input.deliveryAuthorityId} AND result_id=${result.id} AND avatar_id=${input.avatarId}`;
        proof=retained?{leaseId:String(retained.id),leaseOwner:String(retained.lease_owner)}:await recovery.claim(input.avatarId,result.id,input.deliveryAuthorityId);
      }
      const delivery=new TaskDeliveryCoordinator(db,this.runtime.upload,recovery,this.runtime.authorityReader);
      const signer=required(this.runtime.signer,'Signer process configuration');
      const signatures=new ResultSignatureCoordinator(db,signer.results,signer.signatures,proof?{recovery,proof}:undefined,this.runtime.authorityReader);
      if(input.stage==='signature'){
        const [existing]=await db`SELECT id FROM brainchain_result_signatures WHERE result_id=${result.id} AND avatar_id=${input.avatarId}`;
        if(existing)return signatures.recover(input.avatarId,existing.id);
        return signatures.capture({avatarId:input.avatarId,resultId:result.id,authorityId:required(input.authorityId,'Result signature authority')},await this.runtime.observe(input.workerId));
      }
      if(input.stage==='upload'){
        if(['uploaded','prepared'].includes(result.state))return{state:'uploaded',resultId:result.id};
        const [signature]=await db`SELECT id FROM brainchain_result_signatures WHERE result_id=${result.id} AND avatar_id=${input.avatarId}`;
        if(!signature)throw new WorkerCoordinatorError('Captured result signature required');
        const uploaded=await delivery.upload(input.avatarId,result.id,await signatures.signatureForUpload(input.avatarId,signature.id),proof);
        return{state:uploaded.state,resultId:result.id};
      }
      if(input.stage==='reconcile')return recovery.reconcileSubmitted(input.avatarId,result.id,required(proof,'Delivery reconciliation lease'));
      const [operation]=await db`SELECT o.* FROM brainchain_result_submissions s JOIN brainchain_signer_operations o ON o.id=s.operation_id WHERE s.result_id=${result.id} AND s.avatar_id=${input.avatarId}`;
      if(input.stage==='prepare-submit'){
        if(operation)return{state:'prepared',operationId:String(operation.id)};
        const observation=await this.runtime.observe(input.workerId);
        await delivery.prepareSubmission(input.avatarId,result.id,{observedAt:observation.observedAt,blockTimestamp:observation.blockTimestamp,blockNumber:observation.blockNumber,blockHash:observation.blockHash,observationPolicy:observation.observationPolicy},proof);
        const prepared=await prepareSignerOperation({avatarId:input.avatarId,bindingId:input.workerId,authorityId:required(input.authorityId,'Submit authority'),gasAuthorityId:required(input.gasAuthorityId,'Gas authority'),idempotencyKey:result.id,request:{kind:'submit',resultId:result.id,task:String(task.task_id),hash:result.result_hash,uri:result.result_uri},fees:signer.fees,deliveryProof:proof},observation);
        return{state:'prepared',operationId:prepared.id};
      }
      if(!operation)throw new WorkerCoordinatorError('Prepared submit required');
      if(input.stage==='receipt')return observeSignerReceipt(operation.id,signer.transport);
      if(input.stage==='capture-submit'){
        if(operation.accepted_at)return recoverCapturedOperation(operation.id,signer.transactions);
        return captureSignerOperation({operationId:operation.id,observation:await this.runtime.observe(input.workerId),nonces:await signer.transport.nonces(worker.address),driver:signer.driver,store:signer.transactions,authorityReader:this.runtime.authorityReader});
      }
      if(input.stage==='broadcast')return broadcastCapturedOperation(operation.id,await this.runtime.observe(input.workerId),signer.transactions,signer.transport,proof?{recovery,avatarId:input.avatarId,resultId:result.id,proof}:undefined,this.runtime.authorityReader);
      throw new WorkerCoordinatorError('Unsupported stage');
    }finally{
      try{if(locked)await lock`SELECT pg_advisory_unlock(hashtextextended(${`brainchain-worker-tick:${input.workerId}`},0))`;}
      finally{lock.release();}
    }
  }
}

