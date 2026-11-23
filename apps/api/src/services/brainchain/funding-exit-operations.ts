import {randomBytes,randomUUID} from 'node:crypto';
import type {Sql,TransactionSql} from 'postgres';
import {z} from 'zod';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {canonical} from './purchase-policy';
import type {BuyerOwner,BuyerCaptureCodec} from './purchases';
import {FundingExitClient,type FundingSourceEvidence,type FundingDeskReport} from './funding-exit-client';
import {buildFundingArtifact,fundingArtifactSchema,fundingDraftSchema,fundingDigest,fundingAccountMessage,fundingIntent,verifyFundingCapture,FundingExitError,type FundingArtifact,type FundingDraft} from './funding-exit-policy';
type Cipher={enc:string;iv:string;tag:string};
type Row={id:string;avatar_id:string;user_id:string;worker_id:string;draft:FundingDraft;artifact:FundingArtifact;artifact_hash:string;state:string;
 approval_nonce:string|null;approval_wallet:string|null;approval_wallet_version:string|null;approval_expires_at:Date|string|null;approved_at:Date|string|null;exposed_at:Date|string|null;
 captured:Cipher|null;capture_hash:string|null;source_transaction:string|null;lease_owner:string|null;lease_until:Date|string|null;first_send_at:Date|string|null;
 source_evidence:FundingSourceEvidence|null;desk_report:FundingDeskReport|null;created_at:Date|string;updated_at:Date|string};
const uuid=z.string().uuid(),time=(v:Date|string)=>new Date(v).getTime();
export const FUNDING_EXIT_EXECUTION_ENABLED=false;
// FEATURE_GATE: brainchain_testnet_funding_exit
// Status: source implementation; transmission disabled pending independent review and test-token evidence.
// Metric to graduate: reviewed source and destination attribution, exact-byte recovery, and authorized test-token trial.
// Current reading: zero owned funding/exit trials (2026-11-09).
// Review deadline: 2026-11-16
// On deadline: remove inactive transmission unless root supplies reviewed evidence.
// Reference: docs/brainchain-funding-exit-recovery-design.md
export class FundingExitOperations{
 private client:FundingExitClient;private codec:BuyerCaptureCodec;private execute:boolean;
 private readonly deadlines=new WeakMap<TransactionSql,{until:number;controller:AbortController}>();
 /** One monotonic deadline per transaction. Every external await consumes the same budget. */
 private check(tx:TransactionSql){const d=this.deadlines.get(tx);if(!d||d.controller.signal.aborted||performance.now()>=d.until){d?.controller.abort();throw new FundingExitError('operation_uncertain');}return d;}
 private async transaction<T>(work:(tx:TransactionSql)=>Promise<T>):Promise<T>{return this.database.begin(async tx=>{const controller=new AbortController(),until=performance.now()+1500;this.deadlines.set(tx,{until,controller});try{const result=await work(tx);this.check(tx);return result;}finally{controller.abort();this.deadlines.delete(tx);}}) as Promise<T>;}
 private async external<T>(tx:TransactionSql,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{const d=this.check(tx);let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{d.controller.abort();reject(new FundingExitError('operation_uncertain'));},Math.max(1,d.until-performance.now()));});
  try{const result=await Promise.race([Promise.resolve().then(()=>{this.check(tx);return work(d.controller.signal);}),timeout]);this.check(tx);return result;}finally{clearTimeout(timer);}
 }
 private async current(tx:TransactionSql,o:BuyerOwner){await this.external(tx,signal=>(o.assertCurrent as (signal?:AbortSignal)=>Promise<void>)(signal));}
 constructor(private readonly database:Sql,options:{client?:FundingExitClient;codec?:BuyerCaptureCodec;executeTestnet?:boolean}={}){
  this.client=options.client??new FundingExitClient();this.execute=options.executeTestnet??FUNDING_EXIT_EXECUTION_ENABLED;
  this.codec=options.codec??{seal:async text=>{const {encryptToken}=await import('../keypair-vault');return encryptToken(text);},open:async c=>{const {decryptToken}=await import('../keypair-vault');return decryptToken(c.enc,c.iv,c.tag);}};
 }
 private async context(tx:TransactionSql,o:BuyerOwner){uuid.parse(o.avatarId);uuid.parse(o.userId);if(typeof o.assertCurrent!=='function')throw new FundingExitError('owner_required');
  await tx`SET LOCAL lock_timeout='2000ms'`;await tx`SET LOCAL statement_timeout='5000ms'`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-funding-owner:${o.avatarId}`},0))`;
  const [subject]=await tx<{wallet:string|null;version:string}[]>`SELECT u.linked_wallet_pubkey AS wallet,u.linked_wallet_authority_version::text AS version FROM avatars a JOIN users u ON u.id=a.user_id WHERE a.id=${o.avatarId} AND u.id=${o.userId} AND a.is_guest=false AND u.is_guest=false FOR UPDATE OF a,u`;
  if(!subject)throw new FundingExitError('owner_required');await this.current(tx,o);return subject;
 }
 private async clock(tx:TransactionSql){const [r]=await tx<{now:Date|string}[]>`SELECT clock_timestamp() AS now`;if(!r)throw new FundingExitError('operation_conflict');this.check(tx);return time(r.now);}
 private async lock(tx:TransactionSql,o:BuyerOwner,id:string){await this.context(tx,o);uuid.parse(id);const [r]=await tx<Row[]>`SELECT * FROM brainchain_funding_operations WHERE id=${id} AND avatar_id=${o.avatarId} AND user_id=${o.userId} FOR UPDATE`;
  if(!r)throw new FundingExitError('operation_not_found');r.artifact=fundingArtifactSchema.parse(r.artifact);if(fundingDigest(r.artifact)!==r.artifact_hash)throw new FundingExitError('operation_conflict');
  const [worker]=await tx`SELECT id FROM brainchain_worker_bindings WHERE id=${r.worker_id} AND avatar_id=${o.avatarId} AND environment='testnet' AND address=${r.artifact.source}`;
  if(!worker)throw new FundingExitError('owner_required');await this.current(tx,o);return r;
 }
 private async approved(tx:TransactionSql,o:BuyerOwner,r:Row){const subject=await this.context(tx,o);await this.current(tx,o);const now=await this.clock(tx);
  if(!subject.wallet||subject.wallet!==r.approval_wallet||subject.version!==String(r.approval_wallet_version)||!r.approved_at||!r.approval_expires_at||time(r.approval_expires_at)<=now)throw new FundingExitError('approval_required');return now;
 }
 private view(r:Row){return {id:r.id,workerId:r.worker_id,kind:r.artifact.kind,state:r.state,source:r.artifact.source,destination:r.artifact.destination,sourceChain:r.artifact.chainId,destinationChain:r.artifact.destinationChainId,
  amountAtomic:r.artifact.amountAtomic,feeAtomic:r.artifact.feeAtomic,minimumDestinationAtomic:r.artifact.minimumDestinationAtomic,maxGasCostWei:(BigInt(r.artifact.gas)*BigInt(r.artifact.maxFeePerGas)).toString(),
  artifactHash:r.artifact_hash,artifactExpiresAt:r.artifact.expiresAt,sourceToken:r.artifact.token,destinationToken:r.artifact.destinationToken,sourceTransaction:r.source_transaction,sourceEvidence:r.source_evidence,deskReport:r.desk_report,
  statusUrl:r.artifact.kind==='parent_exit'&&r.source_transaction?`https://brain.testnet.usebrainchain.com/exits/${r.source_transaction}`:null,
  destinationState:'unresolved' as const,liabilityState:'reserved' as const,executionEnabled:this.execute,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()};}
 async list(o:BuyerOwner){return this.transaction(async tx=>{await this.context(tx,o);const rows=await tx<Row[]>`SELECT * FROM brainchain_funding_operations WHERE avatar_id=${o.avatarId} AND user_id=${o.userId} ORDER BY created_at DESC LIMIT 30`;return {operations:rows.map(r=>this.view(r)),executionEnabled:this.execute};});}
 async get(o:BuyerOwner,id:string){return this.transaction(async tx=>{const row=await this.lock(tx,o,id);return this.view(row);});}
 async create(o:BuyerOwner,raw:unknown){const draft=fundingDraftSchema.parse(raw);const known=await this.transaction(async tx=>{await this.context(tx,o);
  const [old]=await tx<Row[]>`SELECT * FROM brainchain_funding_operations WHERE avatar_id=${o.avatarId} AND idempotency_key=${draft.idempotencyKey}`;
  if(old){if(fundingDigest(old.draft)!==fundingDigest(draft))throw new FundingExitError('operation_conflict');return {old};}
  const [worker]=await tx<{address:string}[]>`SELECT address FROM brainchain_worker_bindings WHERE id=${draft.workerId} AND avatar_id=${o.avatarId} AND environment='testnet'`;
  if(!worker)throw new FundingExitError('owner_required');return {source:worker.address};});if(known.old)return this.view(known.old);
  const p=await this.client.prepare(draft.kind,known.source!,BigInt(draft.amountAtomic)),id=randomUUID();
  return this.transaction(async tx=>{await this.context(tx,o);const [worker]=await tx`SELECT id FROM brainchain_worker_bindings WHERE id=${draft.workerId} AND avatar_id=${o.avatarId} AND environment='testnet' AND address=${known.source!}`;if(!worker)throw new FundingExitError('owner_required');
   const [old]=await tx<Row[]>`SELECT * FROM brainchain_funding_operations WHERE avatar_id=${o.avatarId} AND idempotency_key=${draft.idempotencyKey}`;if(old){if(fundingDigest(old.draft)!==fundingDigest(draft))throw new FundingExitError('operation_conflict');return this.view(old);}
   const now=await this.clock(tx),a=buildFundingArtifact({id,draft,source:known.source!,...p,now});
   // Native gas and source asset liabilities persist across days, observations, restarts, and uncertainty.
   const [sum]=await tx<{gas:string;amount:string}[]>`SELECT COALESCE(SUM((artifact->>'gas')::numeric*(artifact->>'maxFeePerGas')::numeric),0)::text AS gas,COALESCE(SUM(CASE WHEN artifact->>'kind'=${draft.kind} THEN (artifact->>'amountAtomic')::numeric ELSE 0 END),0)::text AS amount FROM brainchain_funding_operations WHERE avatar_id=${o.avatarId}`;
   if(BigInt(sum!.gas)+BigInt(a.gas)*BigInt(a.maxFeePerGas)>10n**18n||BigInt(sum!.amount)+BigInt(a.amountAtomic)>(draft.kind==='parent_eth'?10n**18n:200000000n))throw new FundingExitError('invalid_request');
   await this.current(tx,o);const [r]=await tx<Row[]>`INSERT INTO brainchain_funding_operations(id,avatar_id,user_id,worker_id,actor,idempotency_key,draft,artifact,artifact_hash,source_chain,source_address,source_nonce) VALUES(${id},${o.avatarId},${o.userId},${draft.workerId},${o.actor},${draft.idempotencyKey},${tx.typed(canonical(draft),25)}::jsonb,${tx.typed(canonical(a),25)}::jsonb,${fundingDigest(a)},${a.chainId},${a.source},${a.nonce}) RETURNING *`;return this.view(r!);});
 }
 async challenge(o:BuyerOwner,id:string){if(o.actor!=='human')throw new FundingExitError('approval_required');return this.transaction(async tx=>{const r=await this.lock(tx,o,id),subject=await this.context(tx,o);if(!subject.wallet||r.state==='sending')throw new FundingExitError('approval_required');
  const now=await this.clock(tx),expires=new Date(Math.min(now+120000,r.captured?now+120000:Date.parse(r.artifact.expiresAt)));if(expires.getTime()<=now)throw new FundingExitError('operation_conflict');const nonce=randomBytes(32).toString('hex');
  await tx`UPDATE brainchain_funding_operations SET approval_nonce=${nonce},approval_wallet=${subject.wallet},approval_wallet_version=${subject.version},approval_expires_at=${tx.typed(expires.toISOString(),25)}::timestamptz,approved_at=NULL WHERE id=${id}`;
  return {messageToSign:fundingAccountMessage(r.artifact,nonce,subject.wallet,subject.version,expires.toISOString()),walletPubkey:subject.wallet,expiresAt:expires.toISOString()};});}
 async approve(o:BuyerOwner,id:string,raw:unknown){if(o.actor!=='human')throw new FundingExitError('approval_required');const {signature}=z.object({signature:z.string().min(64).max(100)}).strict().parse(raw);
  return this.transaction(async tx=>{const r=await this.lock(tx,o,id),s=await this.context(tx,o),now=await this.clock(tx);if(!r.approval_nonce||!s.wallet||s.wallet!==r.approval_wallet||s.version!==String(r.approval_wallet_version)||!r.approval_expires_at||time(r.approval_expires_at)<=now)throw new FundingExitError('approval_required');
   try{if(!nacl.sign.detached.verify(Buffer.from(fundingAccountMessage(r.artifact,r.approval_nonce,s.wallet,s.version,new Date(r.approval_expires_at).toISOString())),bs58.decode(signature),bs58.decode(s.wallet)))throw Error('proof');}catch{throw new FundingExitError('approval_required');}
   await this.current(tx,o);if(time(r.approval_expires_at)<=await this.clock(tx))throw new FundingExitError('approval_required');await tx`UPDATE brainchain_funding_operations SET approved_at=clock_timestamp() WHERE id=${id}`;return {ok:true};});}
 async intent(o:BuyerOwner,id:string){return this.transaction(async tx=>{const r=await this.lock(tx,o,id);const now=await this.approved(tx,o,r);if(r.captured||now>=Date.parse(r.artifact.expiresAt))throw new FundingExitError('operation_conflict');await tx`UPDATE brainchain_funding_operations SET exposed_at=COALESCE(exposed_at,clock_timestamp()) WHERE id=${id}`;return {artifact:r.artifact,messageToSign:fundingIntent(r.artifact)};});}
 async capture(o:BuyerOwner,id:string,raw:unknown){const known=await this.transaction(tx=>this.lock(tx,o,id));const verified=await verifyFundingCapture(known.artifact,raw),hash=fundingDigest(verified.signedTransaction);
  const cipher=await this.codec.seal(canonical({purpose:'brainchain-funding-v1',avatarId:o.avatarId,userId:o.userId,operationId:id,artifactHash:known.artifact_hash,...verified}));
  return this.transaction(async tx=>{const r=await this.lock(tx,o,id),now=await this.approved(tx,o,r);if(r.artifact_hash!==known.artifact_hash||!r.exposed_at)throw new FundingExitError('operation_conflict');if(r.captured){if(r.capture_hash!==hash)throw new FundingExitError('operation_conflict');return this.view(r);}if(r.state!=='reserved'||now>=Date.parse(r.artifact.expiresAt))throw new FundingExitError('operation_conflict');
   const [updated]=await tx<Row[]>`UPDATE brainchain_funding_operations SET captured=${tx.typed(canonical(cipher),25)}::jsonb,capture_hash=${hash},source_transaction=${verified.transactionHash},state='captured',updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;return this.view(updated!);});}
 private async decode(o:BuyerOwner,r:Row){if(!r.captured)throw new FundingExitError('operation_conflict');const p=z.object({purpose:z.literal('brainchain-funding-v1'),avatarId:z.literal(o.avatarId),userId:z.literal(o.userId),operationId:z.literal(r.id),artifactHash:z.literal(r.artifact_hash),signedTransaction:z.string(),transactionHash:z.literal(r.source_transaction!)}).strict().parse(JSON.parse(await this.codec.open(r.captured)));
  if(fundingDigest(p.signedTransaction)!==r.capture_hash)throw new FundingExitError('operation_conflict');return p.signedTransaction;}
 async submit(o:BuyerOwner,id:string,recover=false){if(!this.execute)throw new FundingExitError('execution_disabled');const known=await this.transaction(tx=>this.lock(tx,o,id)),signed=await this.decode(o,known),lease=randomUUID();
  await this.client.verifyAuthority(known.artifact);
  await this.transaction(async tx=>{const r=await this.lock(tx,o,id),now=await this.approved(tx,o,r);if(r.capture_hash!==known.capture_hash||r.lease_until&&time(r.lease_until)>now||(!recover&&(r.state!=='captured'||r.first_send_at||now>=Date.parse(r.artifact.expiresAt)))||(recover&&!['uncertain','sending'].includes(r.state)))throw new FundingExitError('operation_conflict');
   await tx`UPDATE brainchain_funding_operations SET state='sending',lease_owner=${lease},lease_until=clock_timestamp()+interval '20 seconds',first_send_at=COALESCE(first_send_at,clock_timestamp()) WHERE id=${id}`;});
  try{const fence=async()=>{await this.transaction(async tx=>{const r=await this.lock(tx,o,id);await this.external(tx,signal=>this.client.verifyAuthority(r.artifact,signal));const now=await this.approved(tx,o,r);if(r.state!=='sending'||r.lease_owner!==lease||!r.lease_until||time(r.lease_until)<=now||r.capture_hash!==known.capture_hash||(!recover&&now>=Date.parse(r.artifact.expiresAt)))throw new FundingExitError('operation_conflict');});};
   const hash=await this.client.send(known.artifact,signed,fence);if(hash!==known.source_transaction)throw new FundingExitError('operation_uncertain');
  }finally{await this.transaction(async tx=>{await this.lock(tx,o,id);await tx`UPDATE brainchain_funding_operations SET state='uncertain',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${id} AND lease_owner=${lease}`;});}
  return this.get(o,id);
 }
 async reconcile(o:BuyerOwner,id:string){const known=await this.transaction(tx=>this.lock(tx,o,id));if(!known.source_transaction||!known.first_send_at)throw new FundingExitError('operation_conflict');
  let evidence:FundingSourceEvidence;try{evidence=await this.client.source(known.artifact,known.source_transaction);}catch{
   await this.transaction(async tx=>{const r=await this.lock(tx,o,id);if(r.source_evidence)await tx`UPDATE brainchain_funding_operations SET state='reorg_suspended',source_evidence=NULL,updated_at=clock_timestamp() WHERE id=${id}`;});throw new FundingExitError('receipt_unavailable');}
  let report:FundingDeskReport|null=null;if(known.artifact.kind==='parent_exit'){try{report=await this.client.report(known.source_transaction);}catch{/* Source evidence remains separate from unavailable desk reports. */}}
  return this.transaction(async tx=>{const r=await this.lock(tx,o,id);await this.current(tx,o);const now=await this.clock(tx);if(r.capture_hash!==known.capture_hash||now-Date.parse(evidence.observedAt)>5000||Date.parse(evidence.observedAt)>now||r.lease_until&&time(r.lease_until)>now)throw new FundingExitError('operation_conflict');
   const [updated]=await tx<Row[]>`UPDATE brainchain_funding_operations SET state='source_observed',source_evidence=${tx.typed(canonical(evidence),25)}::jsonb,desk_report=${report?tx.typed(canonical(report),25):null}::jsonb,updated_at=clock_timestamp() WHERE id=${id} RETURNING *`;return this.view(updated!);});}
}
let operations:FundingExitOperations|undefined;
export async function getFundingExitOperations(){if(!operations){const {getPostgresClient}=await import('@clawville/database');operations=new FundingExitOperations(getPostgresClient());}return operations;}
