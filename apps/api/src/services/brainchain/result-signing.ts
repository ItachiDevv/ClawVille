import {assertPersistedConfiguredAuthority,observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {assertConfiguredAuthorityEvidence} from './configured-authority';
import {databaseDate} from './database-values';
import type {Sql,TransactionSql} from 'postgres';
import {z} from 'zod';
import {TaskDeliveryCoordinator} from './task-delivery';
import {assertSignerActivation,assertFreshTestnetObservation,assertSignerArtifactAdmission,BrainChainSignerError,type SignerObservation} from './signer-policy';
import {freezeResultSignatureIntent,resultSignatureClaimHash,verifyResultSignature,type DedicatedResultSignerDriver} from './result-signing-policy';
import type {ProtectedSignerJournal} from './signer-payload-store';
import type {DeliveryRecovery,DeliveryLeaseProof} from './delivery-recovery';
import {assertSignerObservationPolicy} from './signer-policy';

async function bounded<T>(work:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BrainChainSignerError('Result signature outcome uncertain')),5000);})]);}
  finally{clearTimeout(timer);}
}

/** Signer-process coordinator. Raw signatures stay in its protected journal and private upload handoff. */
export class ResultSignatureCoordinator{
  private readonly delivery:TaskDeliveryCoordinator;
  constructor(private readonly database:Sql,private readonly driver:DedicatedResultSignerDriver,private readonly journal:ProtectedSignerJournal,private readonly deliveryLease?:{recovery:DeliveryRecovery;proof:DeliveryLeaseProof},private readonly authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){this.delivery=new TaskDeliveryCoordinator(database,undefined,deliveryLease?.recovery,authorityReader);}
  private async authority(tx:TransactionSql,avatarId:string,resultId:string,authorityId:string,observation:Pick<SignerObservation,'observationPolicy'>={}){
    const result=await this.delivery.readInTransaction(tx,avatarId,resultId);
    await tx`SELECT binding_id FROM brainchain_signer_streams WHERE binding_id=${result.binding_id} FOR UPDATE`;
    const exact=await tx`SELECT * FROM brainchain_exact_result_issuances WHERE signer_authority_id=${authorityId} OR gas_authority_id=${authorityId}`;
    if(exact.length){
      const issued=exact[0]!,proof=this.deliveryLease?.proof;
      if(exact.length!==1||issued.stage!=='signature'||issued.signer_authority_id!==authorityId||!proof)throw new BrainChainSignerError('Exact result signature requires its issued delivery lease');
      const [lease]=await tx`SELECT 1 FROM brainchain_delivery_leases l JOIN brainchain_delivery_authorities d ON d.id=l.authority_id
        WHERE l.id=${proof.leaseId} AND l.lease_owner=${proof.leaseOwner} AND l.stage='signature' AND d.id=${issued.delivery_authority_id}
        AND d.exact_consent_id=${issued.consent_id} AND d.result_id=${resultId} AND d.avatar_id=${avatarId} AND d.binding_id=${result.binding_id}`;
      if(!lease)throw new BrainChainSignerError('Exact result signature delivery issuance mismatch');
    }
    const current=await this.delivery.withCurrentResult(tx,avatarId,resultId,async(row,task)=>{
      const [grant]=await tx`SELECT a.*,s.signer_ref FROM brainchain_signer_authorities a JOIN brainchain_signer_streams s ON s.binding_id=a.binding_id
        WHERE a.id=${authorityId} AND a.binding_id=${row.binding_id} AND a.avatar_id=${avatarId} AND a.environment='testnet' AND a.chain_id=274630
        AND a.purpose='result-signature' AND a.max_atomic=0 AND a.signer_address=${String(task.address)} AND a.generation=s.generation
        AND s.stopped=false AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() FOR UPDATE OF a,s`;
      if(!grant)throw new BrainChainSignerError('Current root result-signature authority required');
      assertPersistedConfiguredAuthority(grant);
      if(this.deliveryLease){
        const [delivery]=await tx`SELECT d.exact_consent_id FROM brainchain_delivery_leases l JOIN brainchain_delivery_authorities d ON d.id=l.authority_id WHERE l.id=${this.deliveryLease.proof.leaseId}`;
        if(delivery?.exact_consent_id){
          const [issued]=await tx`SELECT 1 FROM brainchain_exact_result_issuances WHERE consent_id=${delivery.exact_consent_id} AND stage='signature' AND signer_authority_id=${authorityId}`;
          if(!issued)throw new BrainChainSignerError('Signature authority lacks exact consent linkage');
        }
      }
      assertSignerObservationPolicy(grant.observation_policy,observation);
      const intent=freezeResultSignatureIntent({domain:'brainchain-result-v2',chainId:274630,resultId:row.id,board:String(task.board_address),task:String(task.task_id),hash:row.result_hash,worker:String(task.address)});
      const hash=resultSignatureClaimHash(String(grant.signer_ref),intent);
      if(hash!==grant.request_hash)throw new BrainChainSignerError('Result authority intent mismatch');
      const [alive]=await tx`SELECT 1 WHERE ${tx.typed(databaseDate(grant.expires_at).toISOString(),25)}::timestamptz>clock_timestamp()`;
      if(!alive)throw new BrainChainSignerError('Result authority expired after locks');
      return{row,grant,intent,hash};
    },this.deliveryLease?{proof:this.deliveryLease.proof,stage:'signature'}:undefined);
    assertConfiguredAuthorityEvidence(await observeConfiguredAuthority(this.authorityReader,{deadlineMs:Math.min(Date.now()+2000,databaseDate(current.grant.expires_at).getTime()),observationPolicy:observation.observationPolicy}));
    await this.delivery.withCurrentResult(tx,avatarId,resultId,async()=>undefined,this.deliveryLease?{proof:this.deliveryLease.proof,stage:'signature'}:undefined);
    // Recovery verifies chain evidence after the callback. Its wait can outlive this separate grant.
    const [alive]=await tx`SELECT 1 WHERE ${tx.typed(databaseDate(current.grant.expires_at).toISOString(),25)}::timestamptz>clock_timestamp()`;
    if(!alive)throw new BrainChainSignerError('Result authority expired after recovery verification');
    return current;
  }
  async assertCurrent(operationId:string,observation:SignerObservation){
    assertFreshTestnetObservation(observation);assertSignerArtifactAdmission(observation);
    z.string().uuid().parse(operationId);
    await this.database.begin(async tx=>{
      const [operation]=await tx`SELECT * FROM brainchain_result_signatures WHERE id=${operationId}`;
      if(!operation||operation.state==='captured')throw new BrainChainSignerError('No current result key-use acceptance');
      const live=await this.authority(tx,String(operation.avatar_id),String(operation.result_id),String(operation.authority_id),observation);
      if(operation.intent_hash!==live.hash||operation.generation!==live.grant.generation)throw new BrainChainSignerError('Result acceptance changed');
      if(live.intent.worker!==observation.signerAddress.toLowerCase())throw new BrainChainSignerError('Result observation owner mismatch');
      assertFreshTestnetObservation(observation);
    });
  }
  /** Existing accepted operations recover only. They never call the driver again. */
  async capture(input:{avatarId:string;resultId:string;authorityId:string},observation:SignerObservation){
    const args=z.object({avatarId:z.string().uuid(),resultId:z.string().uuid(),authorityId:z.string().uuid()}).strict().parse(input);
    assertSignerActivation();
    assertFreshTestnetObservation(observation);assertSignerArtifactAdmission(observation);
    const acceptance=await this.database.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-result-signature:${args.resultId}`},0))`;
      const [prior]=await tx`SELECT * FROM brainchain_result_signatures WHERE result_id=${args.resultId}`;
      if(prior){if(prior.avatar_id!==args.avatarId||prior.authority_id!==args.authorityId)throw new BrainChainSignerError('Result signature owner mismatch');return{operationId:String(prior.id),fresh:false};}
      const current=await this.authority(tx,args.avatarId,args.resultId,args.authorityId,observation);
      if(current.intent.worker!==observation.signerAddress.toLowerCase())throw new BrainChainSignerError('Result observation owner mismatch');
      const [operation]=await tx`INSERT INTO brainchain_result_signatures(result_id,authority_id,binding_id,avatar_id,environment,chain_id,signer_address,generation,intent,intent_hash)
        VALUES(${args.resultId},${args.authorityId},${current.row.binding_id},${args.avatarId},'testnet',274630,${current.intent.worker},${current.grant.generation},${tx.typed(JSON.stringify(current.intent),25)}::jsonb,${current.hash}) RETURNING id`;
      await this.authority(tx,args.avatarId,args.resultId,args.authorityId,observation);
      return{operationId:String(operation!.id),fresh:true,reference:String(current.grant.signer_ref),intent:current.intent,hash:current.hash};
    });
    if(!acceptance.fresh||!acceptance.intent||!acceptance.reference||!acceptance.hash)return this.recover(args.avatarId,acceptance.operationId);
    try{
      await this.assertCurrent(acceptance.operationId,observation);
      if(!await bounded(this.journal.claimKeyUse(acceptance.operationId,acceptance.hash)))return this.recover(args.avatarId,acceptance.operationId);
      await bounded(this.driver.signResult(acceptance.operationId,acceptance.reference,acceptance.intent,()=>this.assertCurrent(acceptance.operationId,observation)));
      return this.recover(args.avatarId,acceptance.operationId);
    }catch{
      await this.database`UPDATE brainchain_result_signatures SET state='uncertain',updated_at=clock_timestamp() WHERE id=${acceptance.operationId} AND state='accepted'`;
      return{operationId:acceptance.operationId,state:'uncertain' as const};
    }
  }
  /** No current lease is needed to recover already captured evidence. No key-use fallback exists. */
  async recover(avatarId:string,operationId:string){
    z.string().uuid().parse(avatarId);z.string().uuid().parse(operationId);
    const [row]=await this.database`SELECT * FROM brainchain_result_signatures WHERE id=${operationId} AND avatar_id=${avatarId}`;
    if(!row)throw new BrainChainSignerError('Result signature owner mismatch');
    const capture=await this.journal.findByOperation(operationId);
    if(!capture){await this.database`UPDATE brainchain_result_signatures SET state='uncertain',updated_at=clock_timestamp() WHERE id=${operationId} AND state='accepted'`;return{operationId,state:'uncertain' as const};}
    await verifyResultSignature(capture.bytes,freezeResultSignatureIntent(row.intent));
    if(await this.journal.get(capture.reference)!==capture.bytes)throw new BrainChainSignerError('Result signature recovery mismatch');
    await this.database`UPDATE brainchain_result_signatures SET state='captured',signature_ref=${capture.reference},updated_at=clock_timestamp() WHERE id=${operationId}`;
    return{operationId,state:'captured' as const};
  }
  /** Private process handoff only. The delivery coordinator independently rechecks current execution authority. */
  async signatureForUpload(avatarId:string,operationId:string){
    const recovered=await this.recover(avatarId,operationId);if(recovered.state!=='captured')throw new BrainChainSignerError('Result signature remains uncertain');
    const captured=await this.journal.findByOperation(operationId);if(!captured)throw new BrainChainSignerError('Result signature unavailable');return captured.bytes;
  }
}
