import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST,assertConfiguredAuthorityEvidence} from './configured-authority';
import {assertPersistedConfiguredAuthority,observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {createHash} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';
import {z} from 'zod';
import {verifyExactRecoveryConsent,ExactRecoveryError} from './exact-result-recovery-consent';
import {exactCaptureSnapshot} from './exact-capture-snapshot';
import {exactCaptureHash,exactCaptureTransaction,freezeExactCaptureIntent} from './exact-capture-policy';
import {databaseDate} from './database-values';
import {assertFreshTestnetObservation,assertSignerArtifactAdmission,assertSignerObservationPolicy,type SignerObservation} from './signer-policy';
import {verifyFrozenTransaction,recoverCapturedOperation,type DedicatedSignerDriver,type ProtectedSignedPayloadStore} from './signer-service';
import {workerObservationFresh,observationPolicyOf} from './worker-observation-policy';
import type {DeliveryEvidenceReader} from './delivery-recovery';

async function bounded<T>(work:Promise<T>,ms=2000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ExactRecoveryError('Exact capture boundary timeout')),ms);})]);}finally{clearTimeout(timer);}}
type Scope={avatarId:string;workerId:string;resultId:string;consentId:string};
/** Trusted signer host only. HTTP can request consent, but cannot inject readers, drivers or stores. */
export class ExactCaptureRecovery{
 constructor(private readonly database:Sql,private readonly readEvidence:DeliveryEvidenceReader,private readonly authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){}
 async issue(scope:Scope){
  Object.values(scope).forEach(value=>z.string().uuid().parse(value));
  return this.database.begin(async tx=>{
   const verified=await verifyExactRecoveryConsent(tx,{...scope,stage:'capture-submit'});
   const retained=await exactCaptureSnapshot(tx,verified.current),intent=retained.intent;
   if(!verified.payload.captureIntent||exactCaptureHash(verified.payload.captureIntent)!==exactCaptureHash(intent))throw new ExactRecoveryError('Signed exact capture intent required');
   const [prior]=await tx`SELECT * FROM brainchain_exact_capture_authorities WHERE consent_id=${scope.consentId}`;
   if(prior){assertPersistedConfiguredAuthority(prior);if(prior.intent_hash!==exactCaptureHash(intent))throw new ExactRecoveryError('Capture authority changed');return prior;}
   assertConfiguredAuthorityEvidence(await observeConfiguredAuthority(this.authorityReader,{deadlineMs:Math.min(Date.now()+2000,databaseDate(verified.consent.expires_at).getTime()),observationPolicy:verified.payload.observationPolicy}));
   const [authority]=await tx`INSERT INTO brainchain_exact_capture_authorities(consent_id,operation_id,result_id,binding_id,avatar_id,generation,nonce,intent,intent_hash,expires_at,authority_policy_version,authority_policy_digest)
    SELECT ${scope.consentId},${intent.operationId},${scope.resultId},${scope.workerId},${scope.avatarId},${intent.generation},${intent.nonce},${tx.typed(JSON.stringify(intent),25)}::jsonb,${exactCaptureHash(intent)},expires_at,${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST}
    FROM brainchain_exact_result_consents WHERE id=${scope.consentId} AND expires_at>clock_timestamp() RETURNING *`;
   if(!authority)throw new ExactRecoveryError('Capture consent expired');
   await verifyExactRecoveryConsent(tx,{...scope,stage:'capture-submit'});return authority;
  });
 }
 private async current(tx:TransactionSql,authorityId:string,observation:SignerObservation,accepted=false){
  assertFreshTestnetObservation(observation);assertSignerArtifactAdmission(observation);
  const [authority]=await tx`SELECT * FROM brainchain_exact_capture_authorities WHERE id=${authorityId}`;
  if(!authority)throw new ExactRecoveryError('Persisted exact capture authority required');
  assertPersistedConfiguredAuthority(authority);
  const scope={avatarId:String(authority.avatar_id),workerId:String(authority.binding_id),resultId:String(authority.result_id),consentId:String(authority.consent_id),stage:'capture-submit' as const};
  const verified=await verifyExactRecoveryConsent(tx,scope);
  const retained=await exactCaptureSnapshot(tx,verified.current,accepted?authorityId:undefined);
  const intent=freezeExactCaptureIntent(authority.intent);
  if(authority.intent_hash!==exactCaptureHash(intent)||authority.intent_hash!==exactCaptureHash(retained.intent)
    ||exactCaptureHash(verified.payload.captureIntent)!==authority.intent_hash||String(authority.nonce)!==intent.nonce||authority.generation!==intent.generation
    ||intent.signer!==observation.signerAddress.toLowerCase()||intent.signer!==observation.bindingAddress.toLowerCase())throw new ExactRecoveryError('Capture authority owner or transaction changed');
  assertSignerObservationPolicy(verified.payload.observationPolicy,observation);
  const evidence=await bounded(this.readEvidence(verified.current.row.hire_snapshot));
  const [clock]=await tx`SELECT clock_timestamp() AS now`;
  const [task]=await tx`SELECT deadline_unix FROM brainchain_worker_tasks WHERE id=${verified.current.row.task_id}`;
  if(!task||!workerObservationFresh(evidence,databaseDate(clock!.now))||observationPolicyOf(evidence)!==verified.payload.observationPolicy
    ||evidence.hireBlockHash!==verified.current.row.hire_block_hash||evidence.briefHash!==verified.current.row.brief_hash||evidence.model!==verified.current.row.hire_snapshot.model
    ||evidence.status!==2||evidence.payee!=='0x0000000000000000000000000000000000000000'||BigInt(task.deadline_unix)<=BigInt(Math.floor(databaseDate(clock!.now).getTime()/1000)))
    throw new ExactRecoveryError('Current canonical unsubmitted hire required');
  await verifyExactRecoveryConsent(tx,scope);
  const configured=await observeConfiguredAuthority(this.authorityReader,{deadlineMs:Math.min(Date.now()+2000,databaseDate(authority.expires_at).getTime()),observationPolicy:verified.payload.observationPolicy});
  assertConfiguredAuthorityEvidence(configured);
  if(configured.blockNumber!==evidence.blockNumber||configured.blockHash!==evidence.blockHash)throw new ExactRecoveryError('Configured exact capture anchor mismatch');
  const [alive]=await tx`SELECT clock_timestamp() AS now FROM brainchain_exact_capture_authorities WHERE id=${authorityId} AND expires_at>clock_timestamp() AND ${task.deadline_unix}::bigint>EXTRACT(EPOCH FROM clock_timestamp())`;
  if(!alive||!workerObservationFresh(evidence,databaseDate(alive.now)))throw new ExactRecoveryError('Exact capture expired after awaits');
  assertFreshTestnetObservation(observation);
  return{authority,verified,retained,intent};
 }
 async capture(input:{authorityId:string;observation:SignerObservation;nonces:{canonical:bigint;pending:bigint};driver:DedicatedSignerDriver;store:ProtectedSignedPayloadStore}){
  z.string().uuid().parse(input.authorityId);
  const [reference]=await this.database`SELECT o.id,o.accepted_at,o.state FROM brainchain_exact_capture_authorities a JOIN brainchain_signer_operations o ON o.id=a.operation_id WHERE a.id=${input.authorityId}`;
  if(!reference)throw new ExactRecoveryError('Exact capture authority required');
  if(reference.accepted_at){
   // Inspection cannot change another in-flight acceptance before its driver callback.
   const retained=await bounded(input.store.findByOperation(String(reference.id)));
   if(!retained&&reference.state==='accepting')return{operationId:String(reference.id),transactionHash:null,state:'uncertain' as const};
   return recoverCapturedOperation(String(reference.id),input.store);
  }
  assertFreshTestnetObservation(input.observation);assertSignerArtifactAdmission(input.observation);
  const accepted=await this.database.begin(async tx=>{
   const checked=await this.current(tx,input.authorityId,input.observation),{intent,retained,verified}=checked;
   const nonce=BigInt(intent.nonce);
   if(input.nonces.canonical!==nonce||input.nonces.pending!==nonce)throw new ExactRecoveryError('Exact approved nonce no longer available');
   const outstanding=await tx`SELECT id FROM brainchain_signer_operations WHERE binding_id=${intent.workerId} AND id<>${intent.operationId} AND nonce IS NOT NULL AND state<>'confirmed'`;
   if(outstanding.length)throw new ExactRecoveryError('Another nonce liability requires reconciliation');
   if((await bounded(input.driver.addressForReference(verified.current.stream.signer_ref))).toLowerCase()!==intent.signer)throw new ExactRecoveryError('Capture key address differs');
   await this.current(tx,input.authorityId,input.observation);
   if(retained.operation.nonce===null){
    const advanced=await tx`UPDATE brainchain_signer_streams SET next_nonce=next_nonce+1 WHERE binding_id=${intent.workerId} AND next_nonce=${intent.nonce} AND generation=${intent.generation} AND stopped=false RETURNING binding_id`;
    if(advanced.length!==1)throw new ExactRecoveryError('Approved proposed nonce changed');
   }
   await tx`UPDATE brainchain_signer_operations SET nonce=${intent.nonce},state='reserved',updated_at=clock_timestamp() WHERE id=${intent.operationId} AND state='prepared'`;
   await tx`INSERT INTO brainchain_exact_capture_acceptances(operation_id,authority_id) VALUES(${intent.operationId},${input.authorityId})`;
   const acceptedRows=await tx`UPDATE brainchain_signer_operations SET nonce=${intent.nonce},state='accepting',accepted_at=(SELECT accepted_at FROM brainchain_exact_capture_acceptances WHERE operation_id=${intent.operationId}),updated_at=clock_timestamp()
    WHERE id=${intent.operationId} AND accepted_at IS NULL AND signed_payload_ref IS NULL AND state IN ('prepared','reserved') RETURNING id`;
   if(acceptedRows.length!==1)throw new ExactRecoveryError('Another capture already accepted');
   return{intent,reference:String(verified.current.stream.signer_ref),transaction:exactCaptureTransaction(intent)};
  });
  try{
   const claimHash=createHash('sha256').update(JSON.stringify({reference:accepted.reference,transaction:accepted.transaction},(_key,value)=>typeof value==='bigint'?value.toString():value)).digest('hex');
   if(!await bounded(input.store.claimKeyUse(accepted.intent.operationId,claimHash)))return recoverCapturedOperation(accepted.intent.operationId,input.store);
   const assertCurrent=()=>this.database.begin(async tx=>{await this.current(tx,input.authorityId,input.observation,true);}).then(()=>{});
   await assertCurrent();
   const bytes=await bounded(input.driver.signTransaction(accepted.intent.operationId,accepted.reference,accepted.transaction,{result:{kind:'submit',resultId:accepted.intent.resultId,task:accepted.intent.task,hash:accepted.intent.resultHash,uri:accepted.intent.resultUri},assertCurrent}),5000);
   await verifyFrozenTransaction(bytes,accepted.transaction,accepted.intent.signer);
   const reference=await bounded(input.store.putIfAbsent(accepted.intent.operationId,bytes));
   if(!/^[a-f0-9]{64}$/.test(reference)||await bounded(input.store.get(reference))!==bytes)throw new ExactRecoveryError('Protected capture readback differs');
   return recoverCapturedOperation(accepted.intent.operationId,input.store);
  }catch{
   await this.database`UPDATE brainchain_signer_operations SET state='uncertain',updated_at=clock_timestamp() WHERE id=${accepted.intent.operationId} AND state='accepting'`;
   return{operationId:accepted.intent.operationId,transactionHash:null,state:'uncertain' as const};
  }
 }
}
