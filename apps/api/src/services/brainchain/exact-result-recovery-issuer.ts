import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST,assertConfiguredAuthorityEvidence} from './configured-authority';
import {observeConfiguredAuthority,createConfiguredAuthorityReader,assertPersistedConfiguredAuthority,type ConfiguredAuthorityReader} from './configured-authority-reader';
import type {Sql} from 'postgres';
import {verifyExactRecoveryConsent,ExactRecoveryError,type ExactRecoveryStage} from './exact-result-recovery-consent';
import type {DeliveryStage} from './delivery-recovery';
import {databaseDate as date} from './database-values';
import {freezeResultSignatureIntent,resultSignatureClaimHash} from './result-signing-policy';
import {signerRequestHash} from './signer-policy';

/** Trusted scheduler composition only. No compute envelope, policy restart, or generic signer grant. */
export class ExactResultRecoveryIssuer{
  constructor(private readonly database:Sql,private readonly authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){}
  async pending(workerId:string,consentId:string,resultId:string){
    const [row]=await this.database`SELECT c.avatar_id,c.result_id,c.binding_id,c.id,c.payload FROM brainchain_exact_result_consents c
      JOIN brainchain_worker_bindings w ON w.id=c.binding_id JOIN avatars a ON a.id=c.avatar_id JOIN users u ON u.id=a.user_id
      WHERE c.id=${consentId} AND c.binding_id=${workerId} AND c.result_id=${resultId} AND c.state='approved' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
      AND c.user_id=u.id AND c.wallet=u.linked_wallet_pubkey AND c.wallet_version=u.linked_wallet_authority_version AND a.is_guest=false AND u.is_guest=false`;
    if(!row)throw new ExactRecoveryError('Explicit owner-bound recovery consent required');
    return{avatarId:String(row.avatar_id),workerId:String(row.binding_id),resultId:String(row.result_id),consentId:String(row.id),stages:row.payload.stages as ExactRecoveryStage[],observationPolicy:row.payload.observationPolicy};
  }
  async issue(input:{avatarId:string;workerId:string;resultId:string;consentId:string;stage:ExactRecoveryStage;fees?:{gasLimit:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint}}){
    if(input.stage==='capture-submit')throw new ExactRecoveryError('Separate exact capture issuer required');
    return this.database.begin(async tx=>{
      const verified=await verifyExactRecoveryConsent(tx,input),{consent,payload,current}=verified;
      const [prior]=await tx`SELECT * FROM brainchain_exact_result_issuances WHERE consent_id=${input.consentId} AND stage=${input.stage}`;
      if(prior){if(input.stage!=='reconcile'){const [grant]=await tx`SELECT * FROM brainchain_delivery_authorities WHERE id=${prior.delivery_authority_id}`;if(!grant)throw new ExactRecoveryError('Delivery policy missing');assertPersistedConfiguredAuthority(grant);}return prior;}
      if(input.stage!=='reconcile')assertConfiguredAuthorityEvidence(await observeConfiguredAuthority(this.authorityReader,{deadlineMs:Math.min(Date.now()+2000,date(consent.expires_at).getTime()),observationPolicy:payload.observationPolicy}));
      const [clock]=await tx`SELECT clock_timestamp() AS now`;
      const expires=new Date(Math.min(date(clock!.now).getTime()+60000,date(consent.expires_at).getTime()));
      let signerId:string|null=null,gasId:string|null=null;
      if(input.stage==='signature'||input.stage==='prepare-submit'){
        let requestHash:string,gas=0n,purpose:string;
        if(input.stage==='signature'){
          const [accepted]=await tx`SELECT id FROM brainchain_result_signatures WHERE result_id=${input.resultId}`;
          if(accepted)throw new ExactRecoveryError('Existing signature acceptance is recovery-only');
          purpose='result-signature';
          const intent=freezeResultSignatureIntent({domain:'brainchain-result-v2',chainId:274630,resultId:input.resultId,board:current.row.board_address,task:String(current.row.external_task),hash:current.row.result_hash,worker:current.row.address});
          requestHash=resultSignatureClaimHash(current.stream.signer_ref,intent);
        }else{
          if(current.payload.captured)throw new ExactRecoveryError('Existing submit operation must retain its nonce and bytes');
          const fees=input.fees;
          if(!fees||fees.gasLimit<=0n||fees.maxFeePerGas<=0n||fees.maxPriorityFeePerGas<0n||fees.maxPriorityFeePerGas>fees.maxFeePerGas)throw new ExactRecoveryError('Exact submit fee bounds required');
          gas=fees.gasLimit*fees.maxFeePerGas;if(gas>BigInt(payload.maxGasWei))throw new ExactRecoveryError('Exact consent gas exceeded');
          if(!current.row.result_uri||!['uploaded','prepared'].includes(current.row.state))throw new ExactRecoveryError('Exact uploaded result required');
          purpose='submit';requestHash=signerRequestHash({kind:'submit',resultId:input.resultId,task:String(current.row.external_task),hash:current.row.result_hash,uri:current.row.result_uri});
        }
        const [signer]=await tx`INSERT INTO brainchain_signer_authorities(binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,observation_policy,authority_policy_version,authority_policy_digest)
          VALUES(${input.workerId},${input.avatarId},'testnet',274630,${current.row.address},${current.stream.generation},${purpose},${requestHash},0,${'exact-result:'+input.consentId},${tx.typed(expires.toISOString(),25)}::timestamptz,${payload.observationPolicy},${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
        signerId=String(signer!.id);
        if(gas>0n){const [grant]=await tx`INSERT INTO brainchain_signer_authorities(binding_id,avatar_id,environment,chain_id,signer_address,generation,purpose,request_hash,max_atomic,approved_by,expires_at,observation_policy,authority_policy_version,authority_policy_digest)
          VALUES(${input.workerId},${input.avatarId},'testnet',274630,${current.row.address},${current.stream.generation},'gas',${requestHash},${gas.toString()},${'exact-result:'+input.consentId},${tx.typed(expires.toISOString(),25)}::timestamptz,${payload.observationPolicy},${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;gasId=String(grant!.id);}
      }
      const captured=current.payload.captured;
      if(input.stage==='broadcast'&&(!captured?.transactionHash||captured.nonce===null))throw new ExactRecoveryError('Exact captured broadcast required');
      const [delivery]=await tx`INSERT INTO brainchain_delivery_authorities(result_id,binding_id,avatar_id,environment,chain_id,stage,task_generation,hire_snapshot_hash,result_hash,result_sha256,
        operation_id,transaction_hash,nonce,gas_ceiling,approved_by,expires_at,exact_consent_id,observation_policy,authority_policy_version,authority_policy_digest)
        VALUES(${input.resultId},${input.workerId},${input.avatarId},'testnet',274630,${input.stage},${current.payload.taskGeneration},${current.payload.hireSnapshotHash},${current.payload.resultHash},${current.payload.resultSha256},
        ${input.stage==='broadcast'?String(captured!.operationId):null},${input.stage==='broadcast'?String(captured!.transactionHash):null},${input.stage==='broadcast'?String(captured!.nonce):null},${input.stage==='broadcast'?String(captured!.gasWei):null},
        ${'exact-result:'+input.consentId},${tx.typed(expires.toISOString(),25)}::timestamptz,${input.consentId},${payload.observationPolicy},${input.stage==='reconcile'?null:CONFIGURED_AUTHORITY_VERSION},${input.stage==='reconcile'?null:CONFIGURED_AUTHORITY_DIGEST}) RETURNING id`;
      const [issued]=await tx`INSERT INTO brainchain_exact_result_issuances(consent_id,stage,delivery_authority_id,signer_authority_id,gas_authority_id)
        VALUES(${input.consentId},${input.stage},${delivery!.id},${signerId},${gasId}) RETURNING *`;
      await verifyExactRecoveryConsent(tx,input);return issued!;
    });
  }
}
