import {assertConfiguredAuthorityEvidence} from './configured-authority';
import {assertPersistedConfiguredAuthority,observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {databaseDate} from './database-values';
import {createHash,randomUUID} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';
import {pad,type Address} from 'viem';
import {z} from 'zod';
import {createBrainChainReader} from './chain-client';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {LEGACY_WORKER_POLICY,observationPolicyOf,workerObservationFresh,type WorkerObservationPolicy} from './worker-observation-policy';

const hash=z.string().regex(/^0x[a-f0-9]{64}$/),address=z.string().regex(/^0x[a-f0-9]{40}$/),decimal=z.string().regex(/^(0|[1-9][0-9]*)$/);
const snapshotSchema=z.object({environment:z.literal('testnet'),chainId:z.literal(274630),board:z.literal(BRAINCHAIN_CONTRACTS.testnet.contracts.board),task:decimal,
  model:hash,expectedPayee:address,briefHash:hash,hireBlock:decimal,hireBlockHash:hash,hireTxHash:hash,hireLogIndex:z.number().int().nonnegative()}).strict();
export type FrozenHire=z.infer<typeof snapshotSchema>;
export type DeliveryStage='signature'|'upload'|'prepare-submit'|'broadcast'|'reconcile';
export type DeliveryLeaseProof={leaseId:string;leaseOwner:string};
export class DeliveryRecoveryError extends Error{readonly code='delivery_recovery_refused';}
export function freezeHireSnapshot(task:Record<string,unknown>){
  const worker=String(task.address);
  const snapshot=snapshotSchema.parse({environment:task.environment,chainId:task.chain_id,board:task.board_address,task:String(task.task_id),model:pad(worker as Address,{size:32}).toLowerCase(),expectedPayee:worker,
    briefHash:task.brief_hash,hireBlock:String(task.hire_block),hireBlockHash:task.hire_block_hash,hireTxHash:task.hire_tx_hash,hireLogIndex:task.hire_log_index});
  return{snapshot,hash:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
}
export type DeliveryChainEvidence={observedAt:Date;blockNumber:bigint;blockHash:string;blockTimestamp:bigint;hireBlockHash:string;model:string;briefHash:string;status:number;payee:string;resultHash:string;observationPolicy?:WorkerObservationPolicy;authorityPolicyVersion?:string;authorityPolicyDigest?:string};
export type DeliveryEvidenceReader=(snapshot:FrozenHire)=>Promise<DeliveryChainEvidence>;
async function readPinnedEvidence(snapshot:FrozenHire):Promise<DeliveryChainEvidence>{
  const reader=createBrainChainReader('testnet'),at=await reader.stableBlock();await reader.assertCode(snapshot.board,at);
  const [task,hire]=await Promise.all([reader.task(snapshot.board as Address,BigInt(snapshot.task),at),reader.block(BigInt(snapshot.hireBlock))]);
  const again=await reader.block(BigInt(at.number));
  if(again.hash!==at.hash)throw new DeliveryRecoveryError('Recovery observation reorged');
  return{observedAt:new Date(),blockNumber:BigInt(at.number),blockHash:at.hash,blockTimestamp:BigInt(at.timestamp),hireBlockHash:hire.hash,model:task.model.toLowerCase(),briefHash:task.briefHash.toLowerCase(),status:task.status,payee:task.payee.toLowerCase(),resultHash:task.resultHash.toLowerCase()};
}
type Row=Record<string,any>;
/** Separate internal delivery authority. Human wallet consent can issue exact-result grants; inspection attempts never grant delivery. */
export class DeliveryRecovery{
  constructor(private readonly database:Sql,private readonly readEvidence:DeliveryEvidenceReader=readPinnedEvidence,private readonly authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){}
  private async locked(tx:TransactionSql,avatarId:string,resultId:string,authorityId:string){
    const [initial]=await tx`SELECT * FROM brainchain_task_results WHERE id=${resultId} AND avatar_id=${avatarId}`;
    if(!initial)throw new DeliveryRecoveryError('Frozen result owner mismatch');
    const [stream]=await tx`SELECT * FROM brainchain_signer_streams WHERE binding_id=${initial.binding_id} FOR UPDATE`;
    if(!stream||stream.stopped)throw new DeliveryRecoveryError('Signer is stopped or unavailable');
    const [task]=await tx`SELECT t.*,w.address,w.requested_state FROM brainchain_worker_tasks t JOIN brainchain_worker_bindings w ON w.id=t.binding_id WHERE t.id=${initial.task_id} FOR UPDATE OF t,w`;
    const [grant]=await tx`SELECT * FROM brainchain_delivery_authorities WHERE id=${authorityId} AND avatar_id=${avatarId} AND result_id=${resultId} FOR UPDATE`;
    if(!task||!grant)throw new DeliveryRecoveryError('Explicit delivery authority required');
    return{task,grant,stream};
  }
  private async verify(tx:TransactionSql,resultId:string,task:Row,grant:Row,lease?:Row,acceptedUploadToken?:string){
    const [result]=await tx`SELECT * FROM brainchain_task_results WHERE id=${resultId} FOR UPDATE`;
    const [lineage]=await tx`SELECT a.state,a.generation,a.lease_until,e.expires_at AS execution_expires_at,e.revoked_at,e.consumed_at,c.state AS compute_state,c.output,c.charged_micros
      FROM brainchain_task_attempts a JOIN brainchain_execution_authorities e ON e.id=a.authority_id JOIN brainchain_compute_calls c ON c.attempt_id=a.id
      WHERE a.id=${result!.attempt_id} AND c.id=${result!.call_id} FOR UPDATE OF a,e,c`;
    if(!result?.hire_snapshot||!result.hire_snapshot_hash)throw new DeliveryRecoveryError('Original hire snapshot unavailable');
    const frozen=snapshotSchema.parse(result.hire_snapshot),snapshotHash=createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
    if(snapshotHash!==result.hire_snapshot_hash||JSON.stringify(frozen)!==JSON.stringify(freezeHireSnapshot(task).snapshot))throw new DeliveryRecoveryError('Original hire changed');
    const exactInput=grant.exact_consent_id?{avatarId:String(result.avatar_id),workerId:String(result.binding_id),resultId,consentId:String(grant.exact_consent_id),stage:grant.stage as DeliveryStage,acceptedUploadToken}:undefined;
    const exact=exactInput?await(await import('./exact-result-recovery-consent')).verifyExactRecoveryConsent(tx,exactInput):undefined;
    if(exact){
      const [issued]=await tx`SELECT 1 FROM brainchain_exact_result_issuances WHERE consent_id=${grant.exact_consent_id} AND delivery_authority_id=${grant.id} AND stage=${grant.stage}`;
      if(!issued||exact.payload.observationPolicy!==(grant.observation_policy??LEGACY_WORKER_POLICY))throw new DeliveryRecoveryError('Exact delivery issuance or observation policy changed');
    }
    if(!lineage||(lineage.revoked_at&&!exact)||!lineage.consumed_at||lineage.compute_state!=='settled'||lineage.charged_micros===null||lineage.output!==result.result_text
      ||lineage.generation!==result.generation||lineage.state==='suspended')throw new DeliveryRecoveryError('Original compute authority revoked or lineage changed');
    if(!task.canonical||(!['running','draining'].includes(task.requested_state)&&!exact)||grant.revoked_at||grant.task_generation!==task.lease_generation
      ||grant.binding_id!==result.binding_id||grant.hire_snapshot_hash!==snapshotHash||grant.result_hash!==result.result_hash||grant.result_sha256!==result.result_sha256)
      throw new DeliveryRecoveryError('Delivery generation or authority changed');
    if(['uploading','upload_uncertain'].includes(result.state)&&grant.stage!=='reconcile'&&!(result.state==='uploading'&&grant.stage==='upload'&&acceptedUploadToken===result.upload_token))throw new DeliveryRecoveryError('Unknown upload remains evidence-only');
    const evidence=await this.readEvidence(frozen);
    if(observationPolicyOf(evidence)!==(grant.observation_policy??LEGACY_WORKER_POLICY))throw new DeliveryRecoveryError('Delivery observation policy mismatch');
    const [clock]=await tx`SELECT clock_timestamp() AS now`;const now=databaseDate(clock!.now).getTime();
    if(!exact&&databaseDate(lineage.lease_until).getTime()>now&&databaseDate(lineage.execution_expires_at).getTime()>now)throw new DeliveryRecoveryError('Original execution has not expired');
    if(databaseDate(grant.expires_at).getTime()<=now||(lease&&databaseDate(lease.expires_at).getTime()<=now))throw new DeliveryRecoveryError('Delivery authority expired after locks');
    if(!workerObservationFresh(evidence,new Date(now))||evidence.hireBlockHash!==frozen.hireBlockHash
      ||evidence.model!==frozen.model||evidence.briefHash!==frozen.briefHash||evidence.blockNumber<BigInt(task.observed_block)
      ||(evidence.blockNumber===BigInt(task.observed_block)&&evidence.blockHash!==task.observed_block_hash))throw new DeliveryRecoveryError('Fresh canonical original hire evidence required');
    const submitted=evidence.status===3&&evidence.payee===frozen.expectedPayee&&evidence.resultHash===result.result_hash;
    if(!submitted&&BigInt(task.deadline_unix)<=BigInt(Math.floor(now/1000)))throw new DeliveryRecoveryError('Task deadline expired');
    if(!submitted&&(evidence.status!==2||evidence.payee!==`0x${'0'.repeat(40)}`))throw new DeliveryRecoveryError('Hired worker or submitted result changed');
    if(grant.stage==='broadcast'){
      const [operation]=await tx`SELECT o.*,a.revoked_at AS intent_revoked,g.revoked_at AS gas_revoked FROM brainchain_signer_operations o
        JOIN brainchain_result_submissions s ON s.operation_id=o.id JOIN brainchain_signer_authorities a ON a.id=o.authority_id JOIN brainchain_signer_authorities g ON g.id=o.gas_authority_id
        JOIN brainchain_signer_streams stream ON stream.binding_id=o.binding_id
        WHERE s.result_id=${resultId} AND o.id=${grant.operation_id} AND o.generation=stream.generation FOR UPDATE OF o,a,g`;
      if(!operation||((operation.intent_revoked||operation.gas_revoked)&&!exact)||!operation.signed_payload_ref||!operation.accepted_at
        ||operation.transaction_hash!==grant.transaction_hash||String(operation.nonce)!==String(grant.nonce)
        ||BigInt(operation.gas_limit)*BigInt(operation.max_fee_per_gas)!==BigInt(grant.gas_ceiling))throw new DeliveryRecoveryError('Exact captured submit liability required');
    }
    if(exactInput)await(await import('./exact-result-recovery-consent')).verifyExactRecoveryConsent(tx,exactInput);
    if(grant.stage!=='reconcile'){
      assertPersistedConfiguredAuthority(grant);
      const current=await observeConfiguredAuthority(this.authorityReader,{deadlineMs:Math.min(Date.now()+2000,databaseDate(grant.expires_at).getTime(),lease?databaseDate(lease.expires_at).getTime():Infinity),observationPolicy:grant.observation_policy});
      assertConfiguredAuthorityEvidence(current);
      if(current.blockNumber!==evidence.blockNumber||current.blockHash!==evidence.blockHash)throw new DeliveryRecoveryError('Configured recovery anchor mismatch');
    }
    const [finalClock]=await tx`SELECT clock_timestamp() AS now`;const finalNow=new Date(finalClock!.now).getTime();
    if(databaseDate(grant.expires_at).getTime()<=finalNow||(lease&&databaseDate(lease.expires_at).getTime()<=finalNow)||(!submitted&&BigInt(task.deadline_unix)<=BigInt(Math.floor(finalNow/1000))))throw new DeliveryRecoveryError('Delivery authority expired after locks');
    if(!workerObservationFresh(evidence,new Date(finalNow)))throw new DeliveryRecoveryError('Recovery evidence expired after locks');
    return{result,task,grant,evidence,submitted};
  }
  async reconcileSubmitted(avatarId:string,resultId:string,proof:DeliveryLeaseProof){
    return this.database.begin(async tx=>{
      const [lease]=await tx`SELECT stage FROM brainchain_delivery_leases WHERE id=${proof.leaseId}`;
      if(!lease||!['reconcile','broadcast'].includes(lease.stage))throw new DeliveryRecoveryError('Explicit reconciliation authority required');
      return this.withLease(tx,avatarId,resultId,proof,lease.stage,async context=>{
        if(!context.submitted)throw new DeliveryRecoveryError('Matching Submitted evidence required');
        const evidence={blockNumber:context.evidence.blockNumber.toString(),blockHash:context.evidence.blockHash,blockTimestamp:context.evidence.blockTimestamp.toString(),resultHash:context.result.result_hash,payee:context.evidence.payee,finalized:false};
        await tx`INSERT INTO brainchain_delivery_reconciliations(lease_id,result_id,evidence) VALUES(${proof.leaseId},${resultId},${tx.typed(JSON.stringify(evidence),25)}::jsonb) ON CONFLICT(lease_id) DO NOTHING`;
        return{resultId,state:'submitted-observed' as const,finalized:false as const};
      });
    });
  }
  async checkBroadcast(avatarId:string,resultId:string,proof:DeliveryLeaseProof,operationId:string){
    return this.database.begin(tx=>this.withLease(tx,avatarId,resultId,proof,'broadcast',async context=>{
      if(context.grant.operation_id!==operationId)throw new DeliveryRecoveryError('Broadcast recovery operation mismatch');
      return{alreadySubmitted:context.submitted};
    }));
  }
  async claim(avatarId:string,resultId:string,authorityId:string){
    [avatarId,resultId,authorityId].forEach(value=>z.string().uuid().parse(value));
    return this.database.begin(async tx=>{
      const {task,grant}=await this.locked(tx,avatarId,resultId,authorityId);
      if(grant.consumed_at)throw new DeliveryRecoveryError('Delivery grant already consumed');
      const verified=await this.verify(tx,resultId,task,grant);
      const [active]=await tx`SELECT id FROM brainchain_delivery_leases WHERE result_id=${resultId} AND expires_at>clock_timestamp()`;
      if(active)throw new DeliveryRecoveryError('Delivery lease already active');
      const [taken]=await tx`UPDATE brainchain_delivery_authorities SET consumed_at=clock_timestamp() WHERE id=${authorityId} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`;
      if(!taken)throw new DeliveryRecoveryError('Delivery grant expired before claim');
      const owner=randomUUID();
      const [lease]=await tx`INSERT INTO brainchain_delivery_leases(authority_id,result_id,binding_id,avatar_id,environment,chain_id,stage,task_generation,generation,lease_owner,expires_at)
        SELECT ${authorityId},${resultId},${grant.binding_id},${avatarId},'testnet',274630,${grant.stage},${grant.task_generation},COALESCE(MAX(generation),0)+1,${owner},
        LEAST(clock_timestamp()+interval '60 seconds',${tx.typed(databaseDate(grant.expires_at).toISOString(),25)}::timestamptz,CASE WHEN ${verified.submitted} THEN ${tx.typed(databaseDate(grant.expires_at).toISOString(),25)}::timestamptz ELSE to_timestamp(${task.deadline_unix}::double precision) END) FROM brainchain_delivery_leases WHERE result_id=${resultId} RETURNING *`;
      await this.verify(tx,resultId,task,grant,lease);
      return{leaseId:String(lease!.id),leaseOwner:owner};
    });
  }
  async withLease<T>(tx:TransactionSql,avatarId:string,resultId:string,proof:DeliveryLeaseProof,stage:DeliveryStage,action:(context:Awaited<ReturnType<DeliveryRecovery['verify']>>)=>Promise<T>,acceptedUploadToken?:string){
    const leaseProof=z.object({leaseId:z.string().uuid(),leaseOwner:z.string().uuid()}).strict().parse(proof);
    const [reference]=await tx`SELECT * FROM brainchain_delivery_leases WHERE id=${leaseProof.leaseId} AND lease_owner=${leaseProof.leaseOwner} AND avatar_id=${avatarId} AND result_id=${resultId}`;
    if(!reference||reference.stage!==stage)throw new DeliveryRecoveryError('Delivery lease owner or stage mismatch');
    const {task,grant}=await this.locked(tx,avatarId,resultId,String(reference.authority_id));
    const [lease]=await tx`SELECT * FROM brainchain_delivery_leases WHERE id=${leaseProof.leaseId} FOR UPDATE`;
    if(!lease||!grant.consumed_at)throw new DeliveryRecoveryError('Delivery lease unavailable');
    const context=await this.verify(tx,resultId,task,grant,lease,acceptedUploadToken),value=await action(context);
    await this.verify(tx,resultId,task,grant,lease,acceptedUploadToken);return value;
  }
}
