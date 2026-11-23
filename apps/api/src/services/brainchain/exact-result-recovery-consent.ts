import {configuredAuthorityPair,assertConfiguredAuthorityPolicy} from './configured-authority';
import {createHash,randomBytes} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {z} from 'zod';
import {databaseDate as date} from './database-values';
import {bindingDomain} from './binding-proof';
import {freezeHireSnapshot,type DeliveryStage} from './delivery-recovery';
import {resultDigests} from './task-delivery-protocol';
import {LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY} from './worker-observation-policy';

const uuid=z.string().uuid(),hex=z.string().regex(/^[a-f0-9]{64}$/),digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const atomic=z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value=>value.length<=78&&/^\d+$/.test(value)&&BigInt(value)<2n**256n);
const stage=z.enum(['signature','upload','prepare-submit','capture-submit','broadcast','reconcile']);
export type ExactRecoveryStage=DeliveryStage|'capture-submit';
export const exactRecoveryRequestSchema=z.object({resultId:uuid,stages:z.array(stage).min(1).max(6).refine(values=>new Set(values).size===values.length),
  maxGasWei:atomic,expiresAt:z.string().datetime(),observationPolicy:z.enum([LEGACY_WORKER_POLICY,WORKER_PROVISIONAL_POLICY])}).strict();
export type ExactRecoveryOwner={avatarId:string;userId:string;actor:'human'|'agent';humanSessionId?:string;assertCurrent:()=>Promise<void>};
export class ExactRecoveryError extends Error{readonly code='exact_result_recovery_refused';}
type Row=Record<string,any>;
function canonical(value:unknown):unknown{return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;}
export const exactRecoveryPayloadHash=(value:unknown)=>digest(JSON.stringify(canonical(value)));

/** Call only inside the canonical owner-control transaction, before its policy revocation. */
export async function recordOwnerRecoveryControl(tx:TransactionSql,owner:Pick<ExactRecoveryOwner,'avatarId'|'userId'|'actor'>,workerId:string,policyId:string,revision:number,action:'pause'|'revoke'|'narrow'){
  const [row]=await tx`INSERT INTO brainchain_recovery_owner_controls(policy_id,binding_id,avatar_id,user_id,policy_revision,actor,action)
    SELECT p.id,p.binding_id,p.avatar_id,p.user_id,p.revision,${owner.actor},${action} FROM brainchain_worker_policies p JOIN avatars a ON a.id=p.avatar_id
    WHERE p.id=${policyId} AND p.binding_id=${workerId} AND p.avatar_id=${owner.avatarId} AND p.user_id=${owner.userId} AND a.user_id=${owner.userId} AND p.revision=${revision} AND p.state<>'revoked'
    ON CONFLICT(transaction_id,policy_id) DO NOTHING RETURNING id`;
  if(!row)throw new ExactRecoveryError('Owner revocation provenance unavailable');
}

async function ownerRevocation(tx:TransactionSql,kind:string,authorityId:string,revokedAt:unknown,avatarId:string,workerId:string){
  if(!revokedAt)return null;
  const [row]=await tx`SELECT p.control_id,c.policy_id,c.policy_revision,c.user_id,c.actor FROM brainchain_recovery_owner_revocations p
    JOIN brainchain_recovery_owner_controls c ON c.id=p.control_id WHERE p.authority_kind=${kind} AND p.authority_id=${authorityId}
    AND c.avatar_id=${avatarId} AND c.binding_id=${workerId} AND p.revoked_at=CASE ${kind}
      WHEN 'execution' THEN (SELECT revoked_at FROM brainchain_execution_authorities WHERE id=${authorityId})
      WHEN 'signer' THEN (SELECT revoked_at FROM brainchain_signer_authorities WHERE id=${authorityId}) ELSE NULL END`;
  if(!row)throw new ExactRecoveryError('Unknown or security authority revocation cannot use owner consent');
  return{controlId:String(row.control_id),policyId:String(row.policy_id),revision:Number(row.policy_revision),userId:String(row.user_id),actor:String(row.actor)};
}

/** This snapshot never contains output text, credentials, signatures, or protected payload references. */
export async function exactRecoverySnapshot(tx:TransactionSql,avatarId:string,workerId:string,resultId:string){
  const [stream]=await tx`SELECT * FROM brainchain_signer_streams WHERE binding_id=${workerId} AND avatar_id=${avatarId} FOR UPDATE`;
  if(!stream||stream.stopped)throw new ExactRecoveryError('Current unstopped signer required');
  const [row]=await tx`SELECT r.*,t.board_address,t.task_id AS external_task,t.lease_generation,t.canonical,t.brief_hash,t.hire_block,t.hire_block_hash,t.hire_tx_hash,t.hire_log_index,
    w.address,w.requested_state,a.authority_id,a.state AS attempt_state,a.lease_until,e.revoked_at AS execution_revoked_at,e.consumed_at,e.expires_at AS execution_expires_at,
    c.state AS compute_state,c.output,c.charged_micros FROM brainchain_task_results r JOIN brainchain_worker_tasks t ON t.id=r.task_id
    JOIN brainchain_worker_bindings w ON w.id=r.binding_id JOIN brainchain_task_attempts a ON a.id=r.attempt_id
    JOIN brainchain_execution_authorities e ON e.id=a.authority_id JOIN brainchain_compute_calls c ON c.id=r.call_id
    WHERE r.id=${resultId} AND r.avatar_id=${avatarId} AND r.binding_id=${workerId} AND r.environment='testnet' AND r.chain_id=274630
    FOR UPDATE OF r,t,w,a,e,c`;
  if(!row||!row.canonical||row.attempt_state==='suspended'||row.compute_state!=='settled'||row.charged_micros===null||row.output!==row.result_text||!row.consumed_at
    ||!row.hire_snapshot_hash||!row.hire_snapshot)throw new ExactRecoveryError('Original settled frozen lineage required');
  const hire=freezeHireSnapshot({...row,task_id:row.external_task});
  const hashes=resultDigests(row.result_text);
  if(hire.hash!==row.hire_snapshot_hash||Object.keys(row.hire_snapshot).length!==Object.keys(hire.snapshot).length||Object.entries(hire.snapshot).some(([key,value])=>row.hire_snapshot[key]!==value)||hashes.hash!==row.result_hash||hashes.sha256!==row.result_sha256)
    throw new ExactRecoveryError('Original hire or frozen output changed');
  const provenance=await ownerRevocation(tx,'execution',String(row.authority_id),row.execution_revoked_at,avatarId,workerId);
  const [operation]=await tx`SELECT o.*,i.revoked_at AS intent_revoked,g.revoked_at AS gas_revoked FROM brainchain_result_submissions l JOIN brainchain_signer_operations o ON o.id=l.operation_id
    JOIN brainchain_signer_authorities i ON i.id=o.authority_id JOIN brainchain_signer_authorities g ON g.id=o.gas_authority_id WHERE l.result_id=${resultId} FOR UPDATE OF o,i,g`;
  let captured:Record<string,unknown>|null=null;
  if(operation){
    if(operation.generation!==stream.generation)throw new ExactRecoveryError('Captured operation signer generation changed');
    const intentProvenance=await ownerRevocation(tx,'signer',operation.authority_id,operation.intent_revoked,avatarId,workerId);
    const gasProvenance=await ownerRevocation(tx,'signer',operation.gas_authority_id,operation.gas_revoked,avatarId,workerId);
    captured={operationId:operation.id,nonce:operation.nonce===null?null:String(operation.nonce),transactionHash:operation.transaction_hash??null,
      gasWei:(BigInt(operation.gas_limit)*BigInt(operation.max_fee_per_gas)).toString(),intentAuthorityId:operation.authority_id,gasAuthorityId:operation.gas_authority_id,intentProvenance,gasProvenance};
  }
  return{row,stream,payload:{version:1,avatarId,workerId,resultId,taskId:row.task_id,attemptId:row.attempt_id,callId:row.call_id,
    resultGeneration:row.generation,taskGeneration:row.lease_generation,signerGeneration:stream.generation,executionAuthorityId:row.authority_id,
    executionRevokedAt:row.execution_revoked_at?date(row.execution_revoked_at).toISOString():null,provenance,hireSnapshotHash:hire.hash,
    resultHash:row.result_hash,resultSha256:row.result_sha256,captured}};
}

export function exactRecoveryMessage(input:{domain:string;consentId:string;payloadHash:string;wallet:string;walletVersion:string;nonce:string;expiresAt:string}){
  return['ClawVille exact frozen result recovery v1',`domain: ${input.domain}`,`consent: ${input.consentId}`,`exact-payload-sha256: ${input.payloadHash}`,
    `account-wallet: ${input.wallet}`,`wallet-version: ${input.walletVersion}`,`nonce: ${input.nonce}`,`expires: ${input.expiresAt}`,
    'I approve only the displayed frozen result, original hire, generations, remaining stages and maximum testnet gas.',
    'This separate delivery consent does not restart compute, clear revocations, resume the worker, release charges, or replace captured bytes and nonce.'].join('\n');
}

export class ExactResultRecoveryConsents{
  constructor(private readonly database:Sql){}
  private async owner(tx:TransactionSql,owner:ExactRecoveryOwner,workerId:string,human=false){
    [owner.avatarId,owner.userId,workerId].forEach(value=>uuid.parse(value));
    await tx`SELECT binding_id FROM brainchain_signer_streams WHERE binding_id=${workerId} FOR UPDATE`;
    const [row]=await tx`SELECT w.id,w.address,u.linked_wallet_pubkey AS wallet,u.linked_wallet_authority_version::text AS wallet_version FROM brainchain_worker_bindings w
      JOIN avatars a ON a.id=w.avatar_id JOIN users u ON u.id=a.user_id WHERE w.id=${workerId} AND w.avatar_id=${owner.avatarId} AND a.user_id=${owner.userId}
      AND w.environment='testnet' AND w.chain_id=274630 AND a.is_guest=false AND u.is_guest=false FOR UPDATE OF w,a,u`;
    if(!row)throw new ExactRecoveryError('Current avatar owner required');
    if(human){
      if(owner.actor!=='human'||!owner.humanSessionId)throw new ExactRecoveryError('Fresh human wallet approval required');
      const [session]=await tx`SELECT id FROM sessions WHERE id=${owner.humanSessionId} AND user_id=${owner.userId} AND created_via IN ('password','magic_link','avatar_create') AND expires_at>clock_timestamp() FOR UPDATE`;
      if(!session)throw new ExactRecoveryError('Fresh human session required');
    }
    return row;
  }
  private view(row:Row){return{id:String(row.id),workerId:String(row.binding_id),resultId:String(row.result_id),state:String(row.state),payload:row.payload,payloadHash:String(row.payload_hash),expiresAt:date(row.expires_at).toISOString(),executionEnabled:false};}
  async list(owner:ExactRecoveryOwner,workerId:string){
    await owner.assertCurrent();return this.database.begin(async tx=>{await this.owner(tx,owner,workerId);const rows=await tx`SELECT * FROM brainchain_exact_result_consents WHERE binding_id=${workerId} AND avatar_id=${owner.avatarId} ORDER BY created_at DESC LIMIT 2`;
      const results=await tx`SELECT id,result_hash,result_sha256,hire_snapshot_hash,state FROM brainchain_task_results WHERE binding_id=${workerId} AND avatar_id=${owner.avatarId} ORDER BY created_at DESC LIMIT 5`;
      return{consents:rows.map(row=>this.view(row)),results:results.map(row=>({id:String(row.id),resultHash:String(row.result_hash),resultSha256:String(row.result_sha256),hireSnapshotHash:String(row.hire_snapshot_hash),state:String(row.state)}))};});
  }
  async request(owner:ExactRecoveryOwner,workerId:string,raw:unknown){
    const input=exactRecoveryRequestSchema.parse(raw);await owner.assertCurrent();
    return this.database.begin(async tx=>{
      const identity=await this.owner(tx,owner,workerId),current=await exactRecoverySnapshot(tx,owner.avatarId,workerId,input.resultId);
      if(['uploading','upload_uncertain'].includes(current.row.state)&&input.stages.some(value=>value!=='reconcile'))throw new ExactRecoveryError('Unknown upload is evidence-only');
      if(current.payload.captured&&BigInt(String(current.payload.captured.gasWei))>BigInt(input.maxGasWei))throw new ExactRecoveryError('Captured gas exceeds exact consent cap');
      const captureIntent=input.stages.includes('capture-submit')?(await (await import('./exact-capture-snapshot')).exactCaptureSnapshot(tx,current)).intent:undefined;
      const payload={...current.payload,...configuredAuthorityPair(),...(captureIntent?{captureIntent}:{}),userId:owner.userId,walletVersion:String(identity.wallet_version),stages:[...input.stages].sort(),maxGasWei:input.maxGasWei,expiresAt:input.expiresAt,observationPolicy:input.observationPolicy};
      const [row]=await tx`INSERT INTO brainchain_exact_result_consents(binding_id,avatar_id,user_id,result_id,payload,payload_hash,expires_at)
        SELECT ${workerId},${owner.avatarId},${owner.userId},${input.resultId},${tx.typed(JSON.stringify(payload),25)}::jsonb,${exactRecoveryPayloadHash(payload)},${tx.typed(input.expiresAt,25)}::timestamptz
        WHERE ${tx.typed(input.expiresAt,25)}::timestamptz>clock_timestamp() AND ${tx.typed(input.expiresAt,25)}::timestamptz<=clock_timestamp()+interval '10 minutes' RETURNING *`;
      if(!row)throw new ExactRecoveryError('Consent expiry must be within ten minutes');return this.view(row);
    });
  }
  async challenge(owner:ExactRecoveryOwner,workerId:string,consentId:string){
    uuid.parse(consentId);await owner.assertCurrent();
    return this.database.begin(async tx=>{
      const identity=await this.owner(tx,owner,workerId,true);
      const [row]=await tx`SELECT * FROM brainchain_exact_result_consents WHERE id=${consentId} AND binding_id=${workerId} AND avatar_id=${owner.avatarId} AND user_id=${owner.userId} AND state='requested' FOR UPDATE`;
      if(!row||!identity.wallet||String(identity.wallet_version)!==row.payload.walletVersion)throw new ExactRecoveryError('Current account wallet and consent required');
      if(bs58.decode(identity.wallet).length!==32)throw new ExactRecoveryError('Current linked Solana wallet required');
      const [clock]=await tx`SELECT clock_timestamp() AS now`;
      const expiresAt=new Date(Math.min(date(clock!.now).getTime()+120000,date(row.expires_at).getTime()));
      const nonce=randomBytes(32).toString('hex'),message=exactRecoveryMessage({domain:bindingDomain(),consentId,payloadHash:row.payload_hash,wallet:identity.wallet,walletVersion:String(identity.wallet_version),nonce,expiresAt:expiresAt.toISOString()});
      await tx`INSERT INTO brainchain_exact_result_challenges(nonce_hash,consent_id,session_id,wallet,wallet_version,message,expires_at)
        VALUES(${digest(nonce)},${consentId},${owner.humanSessionId!},${identity.wallet},${identity.wallet_version},${message},${tx.typed(expiresAt.toISOString(),25)}::timestamptz)`;
      return{nonce,messageToSign:message,walletPubkey:identity.wallet,expiresAt:expiresAt.toISOString(),consent:this.view(row)};
    });
  }
  async approve(owner:ExactRecoveryOwner,workerId:string,consentId:string,raw:unknown){
    if(owner.actor!=='human')throw new ExactRecoveryError('Human approval required');
    const input=z.object({nonce:hex,signature:z.string().min(80).max(100)}).strict().parse(raw);await owner.assertCurrent();
    const [admitted]=await this.database`UPDATE brainchain_exact_result_challenges SET attempts=attempts+1 WHERE nonce_hash=${digest(input.nonce)} AND consent_id=${consentId} AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5 RETURNING nonce_hash`;
    if(!admitted)throw new ExactRecoveryError('Recovery proof unavailable');
    return this.database.begin(async tx=>{
      const identity=await this.owner(tx,owner,workerId,true);
      const [row]=await tx`SELECT * FROM brainchain_exact_result_consents WHERE id=${consentId} AND binding_id=${workerId} AND avatar_id=${owner.avatarId} AND user_id=${owner.userId} AND state='requested' FOR UPDATE`;
      const [proof]=await tx`SELECT * FROM brainchain_exact_result_challenges WHERE nonce_hash=${digest(input.nonce)} FOR UPDATE`;
      if(!row||!proof||row.payload_hash!==exactRecoveryPayloadHash(row.payload)||proof.session_id!==owner.humanSessionId||proof.wallet!==identity.wallet||String(proof.wallet_version)!==String(identity.wallet_version)||row.payload.walletVersion!==String(identity.wallet_version))throw new ExactRecoveryError('Recovery wallet or session scope changed');
      const current=await exactRecoverySnapshot(tx,owner.avatarId,workerId,row.result_id);
      for(const [key,value] of Object.entries(current.payload))if(JSON.stringify(canonical(row.payload[key]))!==JSON.stringify(canonical(value)))throw new ExactRecoveryError('Exact frozen recovery scope changed');
      if(row.payload.stages.includes('capture-submit')){
        const retained=await (await import('./exact-capture-snapshot')).exactCaptureSnapshot(tx,current);
        if(exactRecoveryPayloadHash(row.payload.captureIntent)!==exactRecoveryPayloadHash(retained.intent))throw new ExactRecoveryError('Exact capture intent changed before approval');
      }
      const message=exactRecoveryMessage({domain:bindingDomain(),consentId,payloadHash:row.payload_hash,wallet:proof.wallet,walletVersion:String(proof.wallet_version),nonce:input.nonce,expiresAt:date(proof.expires_at).toISOString()});
      let valid=false;try{valid=message===proof.message&&nacl.sign.detached.verify(Buffer.from(message),bs58.decode(input.signature),bs58.decode(proof.wallet));}catch{}
      if(!valid)throw new ExactRecoveryError('Invalid exact recovery signature');
      await this.owner(tx,owner,workerId,true);
      const [used]=await tx`UPDATE brainchain_exact_result_challenges SET consumed_at=clock_timestamp() WHERE nonce_hash=${digest(input.nonce)} AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING nonce_hash`;
      if(!used)throw new ExactRecoveryError('Recovery proof expired after locks');
      const [approved]=await tx`UPDATE brainchain_exact_result_consents SET state='approved',approval_nonce=${used.nonce_hash},wallet=${identity.wallet},wallet_version=${identity.wallet_version},approved_at=clock_timestamp()
        WHERE id=${consentId} AND expires_at>clock_timestamp() RETURNING *`;
      if(!approved)throw new ExactRecoveryError('Recovery consent expired after locks');return this.view(approved);
    });
  }
  /** Narrowing revokes the old grant immediately. The reduced request requires a fresh owner signature. */
  async narrow(owner:ExactRecoveryOwner,workerId:string,consentId:string,raw:unknown){
    const input=exactRecoveryRequestSchema.omit({resultId:true,observationPolicy:true}).parse(raw);
    uuid.parse(consentId);await owner.assertCurrent();
    return this.database.begin(async tx=>{
      await this.owner(tx,owner,workerId);
      const [old]=await tx`SELECT * FROM brainchain_exact_result_consents WHERE id=${consentId} AND binding_id=${workerId} AND avatar_id=${owner.avatarId} AND state<>'revoked' AND expires_at>clock_timestamp() FOR UPDATE`;
      if(!old||input.stages.some(value=>!old.payload.stages.includes(value))||BigInt(input.maxGasWei)>BigInt(old.payload.maxGasWei)||Date.parse(input.expiresAt)>date(old.expires_at).getTime())throw new ExactRecoveryError('Recovery limits can only decrease');
      await exactRecoverySnapshot(tx,owner.avatarId,workerId,String(old.result_id));
      const payload={...old.payload,stages:[...input.stages].sort(),maxGasWei:input.maxGasWei,expiresAt:input.expiresAt};
      const [next]=await tx`INSERT INTO brainchain_exact_result_consents(binding_id,avatar_id,user_id,result_id,payload,payload_hash,expires_at)
        SELECT ${workerId},${owner.avatarId},${owner.userId},${old.result_id},${tx.typed(JSON.stringify(payload),25)}::jsonb,${exactRecoveryPayloadHash(payload)},${tx.typed(input.expiresAt,25)}::timestamptz
        WHERE ${tx.typed(input.expiresAt,25)}::timestamptz>clock_timestamp() RETURNING *`;
      if(!next)throw new ExactRecoveryError('Reduced consent expired');
      await tx`UPDATE brainchain_exact_result_consents SET state='revoked',revoked_at=clock_timestamp() WHERE id=${consentId}`;
      return this.view(next);
    });
  }
  async revoke(owner:ExactRecoveryOwner,workerId:string,consentId:string){
    uuid.parse(consentId);await owner.assertCurrent();return this.database.begin(async tx=>{await this.owner(tx,owner,workerId);
      const [row]=await tx`UPDATE brainchain_exact_result_consents SET state='revoked',revoked_at=clock_timestamp() WHERE id=${consentId} AND binding_id=${workerId} AND avatar_id=${owner.avatarId} AND state<>'revoked' RETURNING *`;
      if(!row)throw new ExactRecoveryError('Recovery consent unavailable');return this.view(row);});
  }
}

let service:ExactResultRecoveryConsents|undefined;
export async function getExactResultRecoveryConsents(){if(!service){const{getPostgresClient}=await import('@clawville/database');service=new ExactResultRecoveryConsents(getPostgresClient());}return service;}

/** Returns validated exact authority, never a revocation override flag. Caller retains this transaction. */
export async function verifyExactRecoveryConsent(tx:TransactionSql,input:{avatarId:string;workerId:string;resultId:string;consentId:string;stage:ExactRecoveryStage;acceptedUploadToken?:string}){
  const current=await exactRecoverySnapshot(tx,input.avatarId,input.workerId,input.resultId);
  const [consent]=await tx`SELECT c.* FROM brainchain_exact_result_consents c JOIN users u ON u.id=c.user_id JOIN avatars a ON a.id=c.avatar_id
    JOIN brainchain_exact_result_challenges p ON p.nonce_hash=c.approval_nonce AND p.consent_id=c.id JOIN sessions s ON s.id=p.session_id
    WHERE c.id=${input.consentId} AND c.result_id=${input.resultId} AND c.binding_id=${input.workerId} AND c.avatar_id=${input.avatarId}
    AND c.state='approved' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND a.user_id=u.id AND a.is_guest=false AND u.is_guest=false
    AND c.wallet=u.linked_wallet_pubkey AND c.wallet_version=u.linked_wallet_authority_version AND p.wallet=c.wallet AND p.wallet_version=c.wallet_version
    AND p.consumed_at IS NOT NULL AND s.user_id=u.id AND s.created_via IN ('password','magic_link','avatar_create') AND s.expires_at>clock_timestamp()
    FOR UPDATE OF c,u,a,p,s`;
  if(!consent||consent.payload_hash!==exactRecoveryPayloadHash(consent.payload)||!consent.payload.stages?.includes(input.stage))throw new ExactRecoveryError('Current exact-result stage consent required');
  const payload=consent.payload;
  if(input.stage!=='reconcile')assertConfiguredAuthorityPolicy(payload);
  for(const [key,value] of Object.entries(current.payload)){
    if(key==='captured')continue;
    if(JSON.stringify(canonical(payload[key]))!==JSON.stringify(canonical(value)))throw new ExactRecoveryError('Exact recovery lineage or provenance changed');
  }
  if(payload.walletVersion!==String(consent.wallet_version))throw new ExactRecoveryError('Exact recovery wallet version changed');
  if(payload.captured){
    const captured=current.payload.captured;
    if(!captured)throw new ExactRecoveryError('Captured operation disappeared');
    for(const [key,value] of Object.entries(payload.captured))if(value!==null&&JSON.stringify(canonical(captured[key]))!==JSON.stringify(canonical(value)))throw new ExactRecoveryError('Captured operation changed');
  }else if(current.payload.captured){
    const captured=current.payload.captured;
    const [issued]=await tx`SELECT 1 FROM brainchain_exact_result_issuances WHERE consent_id=${input.consentId} AND stage='prepare-submit'
      AND signer_authority_id=${String(captured.intentAuthorityId)} AND gas_authority_id=${String(captured.gasAuthorityId)}`;
    if(!issued)throw new ExactRecoveryError('New submit operation lacks exact consent lineage');
  }
  if(current.payload.captured&&BigInt(String(current.payload.captured.gasWei))>BigInt(payload.maxGasWei))throw new ExactRecoveryError('Exact result gas cap exceeded');
  if(['uploading','upload_uncertain'].includes(current.row.state)&&input.stage!=='reconcile'
    &&!(current.row.state==='uploading'&&input.stage==='upload'&&input.acceptedUploadToken===current.row.upload_token))throw new ExactRecoveryError('Unknown upload remains evidence-only');
  const [alive]=await tx`SELECT 1 FROM brainchain_exact_result_consents c JOIN brainchain_exact_result_challenges p ON p.nonce_hash=c.approval_nonce AND p.consent_id=c.id JOIN sessions s ON s.id=p.session_id
    WHERE c.id=${input.consentId} AND c.state='approved' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`;
  if(!alive)throw new ExactRecoveryError('Exact recovery consent expired after locks');
  return{consent,payload,current};
}
