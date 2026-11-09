import {assertConfiguredAuthorityEvidence} from './configured-authority';
import {assertPersistedConfiguredAuthority,observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {databaseDate} from './database-values';
import {randomUUID} from 'node:crypto';
import {recoverMessageAddress,type Hex} from 'viem';
import type {Sql,TransactionSql} from 'postgres';
import {z} from 'zod';
import {assertSignerActivation} from './signer-policy';
import {resultDigests,resultUploadMessage,resultSubmission,validateResultUri,TaskDeliveryError,type ResultUploadTransport} from './task-delivery-protocol';
import {freezeHireSnapshot,type DeliveryRecovery,type DeliveryLeaseProof,type DeliveryStage} from './delivery-recovery';
import {LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY,observationPolicyOf,workerObservationFresh} from './worker-observation-policy';

const uuid=z.string().uuid();
const ownerSchema=z.object({avatarId:uuid,taskId:uuid,attemptId:uuid,callId:uuid,generation:z.number().int().positive(),leaseOwner:uuid}).strict();
const observationSchema=z.object({observedAt:z.date(),blockTimestamp:z.bigint().nonnegative(),blockNumber:z.bigint().nonnegative(),blockHash:z.string().regex(/^0x[a-f0-9]{64}$/),observationPolicy:z.enum([LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY]).optional()}).strict();
type Owner=z.infer<typeof ownerSchema>;
type ResultRow={id:string;task_id:string;binding_id:string;avatar_id:string;attempt_id:string;call_id:string;generation:number;lease_owner:string;prompt_hash:string;
  result_text:string;result_sha256:string;result_hash:Hex;state:string;upload_token:string|null;result_uri:string|null;submission:unknown};

/** Private internal coordinator. It accepts IDs, never caller-supplied output or endpoint URLs. */
export class TaskDeliveryCoordinator {
  constructor(private readonly database:Sql,private readonly transport?:ResultUploadTransport,private readonly recovery?:DeliveryRecovery,private readonly authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){}
  private async fence(tx:TransactionSql,input:Owner){
    await tx`SELECT id FROM brainchain_worker_tasks WHERE id=${input.taskId} AND avatar_id=${input.avatarId} FOR UPDATE`;
    const [row]=await tx`SELECT t.*,w.address,a.prompt_hash,a.input_hash,a.lease_until,auth.expires_at AS authority_expires_at,auth.observation_policy,auth.authority_policy_version,auth.authority_policy_digest,c.output,c.state AS compute_state,c.charged_micros
      FROM brainchain_worker_tasks t JOIN brainchain_worker_bindings w ON w.id=t.binding_id
      JOIN brainchain_task_attempts a ON a.task_id=t.id JOIN brainchain_execution_authorities auth ON auth.id=a.authority_id
      JOIN brainchain_compute_calls c ON c.attempt_id=a.id
      WHERE t.id=${input.taskId} AND t.avatar_id=${input.avatarId} AND t.environment='testnet' AND t.chain_id=274630 AND t.canonical=true AND t.status=2
      AND t.lease_generation=${input.generation} AND t.deadline_unix>EXTRACT(EPOCH FROM clock_timestamp())
      AND a.id=${input.attemptId} AND a.avatar_id=t.avatar_id AND a.binding_id=t.binding_id AND a.generation=t.lease_generation
      AND a.purpose='execution' AND a.state='executing' AND a.lease_owner=${input.leaseOwner} AND a.lease_until>clock_timestamp()
      AND auth.revoked_at IS NULL AND auth.consumed_at IS NOT NULL AND auth.expires_at>clock_timestamp()
      AND w.requested_state IN ('running','draining') AND c.id=${input.callId} AND c.avatar_id=t.avatar_id AND c.task_id=t.id
      AND c.generation=a.generation AND c.lease_owner=a.lease_owner AND c.prompt_hash=a.prompt_hash AND c.state='settled'
      AND c.charged_micros IS NOT NULL AND c.output IS NOT NULL FOR UPDATE OF a,c,w,auth`;
    if(!row)throw new TaskDeliveryError('Current settled execution fence required');
    assertPersistedConfiguredAuthority(row);
    assertConfiguredAuthorityEvidence(await observeConfiguredAuthority(this.authorityReader,{deadlineMs:Math.min(Date.now()+2000,databaseDate(row.lease_until).getTime(),databaseDate(row.authority_expires_at).getTime()),observationPolicy:row.observation_policy}));
    const [live]=await tx`SELECT 1 WHERE ${tx.typed(databaseDate(row.lease_until).toISOString(),25)}::timestamptz>clock_timestamp() AND ${tx.typed(databaseDate(row.authority_expires_at).toISOString(),25)}::timestamptz>clock_timestamp()
      AND ${row.deadline_unix}::bigint>EXTRACT(EPOCH FROM clock_timestamp())`;
    if(!live)throw new TaskDeliveryError('Execution fence expired after locks');
    return row;
  }
  private owner(row:ResultRow):Owner{return{avatarId:row.avatar_id,taskId:row.task_id,attemptId:row.attempt_id,callId:row.call_id,generation:row.generation,leaseOwner:row.lease_owner};}
  private verify(row:ResultRow){const digest=resultDigests(row.result_text);if(digest.hash!==row.result_hash||digest.sha256!==row.result_sha256)throw new TaskDeliveryError('Frozen result digest mismatch');return row;}
  private async actionFence(tx:TransactionSql,row:ResultRow,stage:DeliveryStage,proof?:DeliveryLeaseProof,acceptedUploadToken?:string){
    if(!proof)return this.fence(tx,this.owner(row));
    return this.withCurrentResult(tx,row.avatar_id,row.id,async(_result,task)=>task,{proof,stage,acceptedUploadToken});
  }
  /** Trusted signer coordinator only. Retains all owner locks through the callback and checks expiry afterward. */
  async withCurrentResult<T>(tx:TransactionSql,avatarId:string,resultId:string,action:(row:ResultRow,task:Record<string,unknown>)=>Promise<T>,delivery?:{proof:DeliveryLeaseProof;stage:DeliveryStage;acceptedUploadToken?:string}):Promise<T>{
    if(delivery){
      if(!this.recovery)throw new TaskDeliveryError('Delivery recovery unavailable');
      return this.recovery.withLease(tx,avatarId,resultId,delivery.proof,delivery.stage,async context=>{
        if(context.submitted)throw new TaskDeliveryError('Matching submitted result requires reconciliation');
        return action(this.verify(context.result as ResultRow),context.task);
      },delivery.acceptedUploadToken);
    }
    const row=await this.readInTransaction(tx,avatarId,resultId);
    await this.fence(tx,this.owner(row));
    const [locked]=await tx<ResultRow[]>`SELECT * FROM brainchain_task_results WHERE id=${row.id} FOR UPDATE`;
    if(!locked)throw new TaskDeliveryError('Result unavailable');
    const task=await this.fence(tx,this.owner(locked));this.verify(locked);
    const value=await action(locked,task);
    await this.fence(tx,this.owner(locked));return value;
  }
  async read(avatarId:string,resultId:string){
    return this.readFrom(this.database,avatarId,resultId);
  }
  async readInTransaction(tx:TransactionSql,avatarId:string,resultId:string){
    return this.readFrom(tx,avatarId,resultId);
  }
  private async readFrom(connection:Sql|TransactionSql,avatarId:string,resultId:string){
    uuid.parse(avatarId);uuid.parse(resultId);
    const [row]=await connection<ResultRow[]>`SELECT * FROM brainchain_task_results WHERE id=${resultId} AND avatar_id=${avatarId}`;
    if(!row)throw new TaskDeliveryError('Result owner mismatch');return this.verify(row);
  }
  async freeze(raw:Owner){
    const input=ownerSchema.parse(raw);
    return this.database.begin(async tx=>{
      await tx`SELECT id FROM brainchain_worker_tasks WHERE id=${input.taskId} AND avatar_id=${input.avatarId} FOR UPDATE`;
      const [prior]=await tx<ResultRow[]>`SELECT * FROM brainchain_task_results WHERE task_id=${input.taskId}`;
      if(prior){if(JSON.stringify(this.owner(prior))!==JSON.stringify(input))throw new TaskDeliveryError('Task already has a different frozen result');return this.verify(prior);}
      const task=await this.fence(tx,input),text=String(task.output),digests=resultDigests(text);
      const hire=freezeHireSnapshot(task);
      const [row]=await tx<ResultRow[]>`INSERT INTO brainchain_task_results(task_id,binding_id,avatar_id,environment,chain_id,attempt_id,call_id,generation,lease_owner,prompt_hash,result_text,result_sha256,result_hash,hire_snapshot,hire_snapshot_hash)
        VALUES(${input.taskId},${task.binding_id},${input.avatarId},'testnet',274630,${input.attemptId},${input.callId},${input.generation},${input.leaseOwner},${task.prompt_hash},${text},${digests.sha256},${digests.hash},${tx.typed(JSON.stringify(hire.snapshot),25)}::jsonb,${hire.hash}) RETURNING *`;
      return this.verify(row!);
    });
  }
  /** Returns an exact typed message, never a signature or generic message-sign capability. */
  async uploadAuthorization(avatarId:string,resultId:string,proof?:DeliveryLeaseProof){
    const row=await this.read(avatarId,resultId);
    return this.database.begin(async tx=>{const task=await this.actionFence(tx,row,'upload',proof);
      return{resultId:row.id,workerAddress:String(task.address),message:resultUploadMessage(String(task.board_address),String(task.task_id),row.result_hash),hash:row.result_hash};});
  }
  /** A future separately reviewed typed signer supplies the signature. No retry exists after upload acceptance. */
  async upload(avatarId:string,resultId:string,rawSignature:Hex,proof?:DeliveryLeaseProof){
    assertSignerActivation();
    const signature=z.string().regex(/^0x[a-fA-F0-9]{130}$/).parse(rawSignature) as Hex;
    if(!this.transport)throw new TaskDeliveryError('Result upload adapter unavailable');
    const row=await this.read(avatarId,resultId),authorization=await this.uploadAuthorization(avatarId,resultId,proof);
    if((await recoverMessageAddress({message:authorization.message,signature})).toLowerCase()!==authorization.workerAddress)
      throw new TaskDeliveryError('Upload signer does not own result');
    const claim=await this.database.begin(async tx=>{
      await this.actionFence(tx,row,'upload',proof);
      await tx`SELECT id FROM brainchain_task_results WHERE id=${row.id} FOR UPDATE`;
      const task=await this.actionFence(tx,row,'upload',proof);
      const token=randomUUID();
      const [claimed]=await tx`UPDATE brainchain_task_results SET state='uploading',upload_token=${token},upload_started_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=${row.id} AND state='frozen' RETURNING id`;
      if(!claimed)throw new TaskDeliveryError('Upload already claimed; recover stored evidence');
      await this.actionFence(tx,row,'upload',proof,token);
      return{token,task:String(task.task_id)};
    });
    try{
      // Commit and pool waits can outlive the admitted lease. Refuse dispatch if authority changed.
      // A claimed upload is an uncertain external effect; recovery may only validate this exact claim.
      await this.database.begin(async tx=>{await this.actionFence(tx,row,'upload',proof,claim.token);});
      const response=await this.transport.upload(Object.freeze({task:claim.task,text:row.result_text,signature,hash:row.result_hash}));
      if(response.hash!==row.result_hash)throw new TaskDeliveryError('Upload hash mismatch');
      const uri=validateResultUri(response.uri,row.result_hash);
      await this.database`UPDATE brainchain_task_results SET state='uploaded',result_uri=${uri},updated_at=clock_timestamp()
        WHERE id=${row.id} AND upload_token=${claim.token} AND state IN ('uploading','upload_uncertain')`;
    }catch{
      await this.database`UPDATE brainchain_task_results SET state='upload_uncertain',updated_at=clock_timestamp() WHERE id=${row.id} AND upload_token=${claim.token} AND state='uploading'`;
    }
    return this.read(avatarId,resultId);
  }
  /** Pure submission preparation only. No transaction authority, key, nonce reservation, or send occurs here. */
  async prepareSubmission(avatarId:string,resultId:string,rawObservation:z.infer<typeof observationSchema>,proof?:DeliveryLeaseProof){
    const observation=observationSchema.parse(rawObservation),observedAt=new Date(observation.observedAt),row=await this.read(avatarId,resultId);
    return this.database.begin(async tx=>{
      await this.actionFence(tx,row,'prepare-submit',proof);
      const [current]=await tx<ResultRow[]>`SELECT * FROM brainchain_task_results WHERE id=${row.id} FOR UPDATE`;
      const task=await this.actionFence(tx,row,'prepare-submit',proof);
      const [clock]=await tx`SELECT clock_timestamp() AS now`;const now=new Date(clock!.now);
      if(!workerObservationFresh({...observation,observedAt},now)||(!proof&&task.observation_policy!==observationPolicyOf(observation))||BigInt(task.observed_block)!==observation.blockNumber||task.observed_block_hash!==observation.blockHash)
        throw new TaskDeliveryError('Fresh matching task observation required');
      if(!current||!['uploaded','prepared'].includes(current.state)||!current.result_uri)throw new TaskDeliveryError('Verified upload required');
      this.verify(current);
      const intent=resultSubmission(String(task.board_address),String(task.task_id),current.result_hash,current.result_uri);
      await tx`UPDATE brainchain_task_results SET state='prepared',submission=${tx.typed(JSON.stringify(intent),25)}::jsonb,updated_at=clock_timestamp() WHERE id=${row.id}`;
      await this.actionFence(tx,row,'prepare-submit',proof);
      return{resultId:row.id,intent,signingAvailable:false as const};
    });
  }
}
