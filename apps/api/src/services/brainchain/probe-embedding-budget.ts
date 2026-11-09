import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql, TransactionSql } from 'postgres';
import { databaseDate } from './database-values';
import type { RootComputeBudgetAuthority } from './inference-proxy';
import { ProbeEmbeddingProvider, probeEmbeddingCharge } from './probe-embedding-provider';
const uuid=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/);
export const probeManifestSchema=z.object({version:z.literal(1),runId:uuid,envelopeId:uuid,jobId:uuid,userId:uuid,avatarId:uuid,platformAgentId:uuid,runtimeAgentId:uuid,
 sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),apiOrigin:z.literal('https://api-staging.clawville.world'),protocolHash:hash,curriculumHash:hash,
 protocolInputs:z.array(hash).min(1).max(500),brainchainInputs:z.array(hash).min(1).max(100),maxCalls:z.number().int().positive().max(1000),maxStarts:z.literal(2),
 startedAtMs:z.number().int().positive().safe(),expiresAtMs:z.number().int().positive().safe(),model:z.literal('text-embedding-3-small'),dimensions:z.literal(1536),pricingVersion:z.literal('openai-embedding-20261109-v1'),maximumMicros:z.literal('200')}).strict();
export type ProbeManifest=z.infer<typeof probeManifestSchema>;
function canonical(v:unknown):string {if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';}
export const probeHash=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
export const probeManifestHash=(v:ProbeManifest)=>probeHash(canonical(probeManifestSchema.parse(v)));
function refuse():never {throw new Error('Probe budget refused');}
export type ProbeIdentityFence=(tx:TransactionSql,manifest:Readonly<ProbeManifest>,signal:AbortSignal)=>Promise<void>;
/** No credential lookup or public authority issuer. Root registers an already allocated envelope. */
export class ProbeEmbeddingBudget {
 constructor(private readonly db:Sql,private readonly root:RootComputeBudgetAuthority,private readonly identity:ProbeIdentityFence,private readonly provider?:ProbeEmbeddingProvider){}
 private async bounded<T>(work:(signal:AbortSignal)=>Promise<T>,deadline:number,signal?:AbortSignal):Promise<T>{
  const end=Math.min(Date.now()+2000,deadline),c=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const cancel=()=>c.abort();signal?.addEventListener('abort',cancel,{once:true});
  let reject!:()=>void;const stop=new Promise<never>((_,r)=>{reject=()=>r(new Error('Probe boundary expired'));});c.signal.addEventListener('abort',reject,{once:true});
  try{if(signal?.aborted||Date.now()>=end)refuse();timer=setTimeout(cancel,end-Date.now());const value=await Promise.race([Promise.resolve().then(()=>work(c.signal)),stop]);if(c.signal.aborted||signal?.aborted||Date.now()>=end)refuse();return value;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);c.signal.removeEventListener('abort',reject);c.abort();}
 }
 private async envelope(tx:TransactionSql,id:string){
  await tx`SET LOCAL lock_timeout='1000ms'`;await tx`SET LOCAL statement_timeout='2000ms'`;
  const [owner]=await tx`SELECT budget_id FROM brainchain_compute_envelopes WHERE id=${id}`;if(!owner)refuse();
  await tx`SELECT id FROM brainchain_compute_budgets WHERE id=${owner.budget_id} FOR UPDATE`;
  const [e]=await tx`SELECT e.*,b.job_id,b.provider FROM brainchain_compute_envelopes e JOIN brainchain_compute_budgets b ON b.id=e.budget_id WHERE e.id=${id} FOR UPDATE OF e`;if(!e)refuse();return e;
 }
 private async fence(tx:TransactionSql,e:Record<string,any>,m:ProbeManifest,deadline:number,signal?:AbortSignal){
  const end=Math.min(deadline,m.expiresAtMs,databaseDate(e.expires_at).getTime(),Date.now()+2000);
  if(e.provider!=='openai'||e.job_id!==m.jobId||e.state!=='open'||e.approval_ref!=='brainchain-probe:'+probeManifestHash(m))refuse();
  await this.bounded(async s=>{await this.root.verifyReservation({jobId:m.jobId,provider:'openai',rootReservationId:String(e.root_reservation_id),approvalRef:String(e.approval_ref),limitMicros:BigInt(e.limit_micros),expiresAt:databaseDate(e.expires_at)});if(s.aborted)refuse();await this.identity(tx,Object.freeze({...m}),s);},end,signal);
  const [time]=await tx`SELECT clock_timestamp() AS now`;if(signal?.aborted||Date.now()>=end||databaseDate(time!.now).getTime()>=Math.min(deadline,m.expiresAtMs,databaseDate(e.expires_at).getTime()))refuse();
 }
 /** Registration marker remains after scope expiry and fixture identity cleanup. */
 async register(raw:ProbeManifest){const m=probeManifestSchema.parse(raw),digest=probeManifestHash(m);
  if(m.maxCalls!==2*m.protocolInputs.length+m.brainchainInputs.length+32||m.startedAtMs>Date.now()||m.expiresAtMs<=m.startedAtMs||m.expiresAtMs-m.startedAtMs>480000)refuse();
  return this.db.begin(async tx=>{const e=await this.envelope(tx,m.envelopeId);await this.fence(tx,e,m,m.expiresAtMs);
   const [prior]=await tx`SELECT * FROM brainchain_probe_runs WHERE id=${m.runId} FOR UPDATE`;if(prior){if(prior.manifest_hash!==digest)refuse();return {runId:m.runId,manifestHash:digest};}
   if(BigInt(e.limit_micros)<BigInt(m.maxCalls)*200n||m.expiresAtMs>databaseDate(e.expires_at).getTime())refuse();
   await tx`INSERT INTO brainchain_probe_markers(platform_agent_id,user_id,avatar_id,runtime_agent_id,run_id) VALUES(${m.platformAgentId},${m.userId},${m.avatarId},${m.runtimeAgentId},${m.runId})`;
   await tx`INSERT INTO brainchain_probe_runs(id,envelope_id,manifest,manifest_hash,platform_agent_id,max_calls,max_starts,expires_at) VALUES(${m.runId},${m.envelopeId},${tx.typed(JSON.stringify(m),25)}::jsonb,${digest},${m.platformAgentId},${m.maxCalls},${m.maxStarts},${tx.typed(new Date(m.expiresAtMs).toISOString(),25)}::timestamptz)`;
   return {runId:m.runId,manifestHash:digest};});
 }
 /** All states are returned. A marker without a run is a refusal, never an ordinary runtime. */
 async lookup(platformAgentId:string){uuid.parse(platformAgentId);const [row]=await this.db`SELECT m.*,r.manifest,r.manifest_hash,r.state,r.expires_at FROM brainchain_probe_markers m LEFT JOIN brainchain_probe_runs r ON r.id=m.run_id WHERE m.platform_agent_id=${platformAgentId}`;if(!row)return null;if(!row.manifest)refuse();const m=probeManifestSchema.parse(row.manifest);if(m.runId!==row.run_id||m.platformAgentId!==row.platform_agent_id||m.avatarId!==row.avatar_id||m.userId!==row.user_id||m.runtimeAgentId!==row.runtime_agent_id||probeManifestHash(m)!==row.manifest_hash)refuse();return {manifest:m,manifestHash:String(row.manifest_hash),state:String(row.state),expiresAt:databaseDate(row.expires_at)};}
 private async locked(tx:TransactionSql,runId:string){await tx`SET LOCAL lock_timeout='1000ms'`;await tx`SET LOCAL statement_timeout='2000ms'`;const [known]=await tx`SELECT envelope_id FROM brainchain_probe_runs WHERE id=${runId}`;if(!known)refuse();const e=await this.envelope(tx,String(known.envelope_id));const [run]=await tx`SELECT * FROM brainchain_probe_runs WHERE id=${runId} FOR UPDATE`;if(!run)refuse();const m=probeManifestSchema.parse(run.manifest);if(probeManifestHash(m)!==run.manifest_hash||m.runId!==run.id||m.envelopeId!==e.id)refuse();const [marker]=await tx`SELECT * FROM brainchain_probe_markers WHERE platform_agent_id=${m.platformAgentId}`;if(!marker||marker.run_id!==m.runId||marker.user_id!==m.userId||marker.avatar_id!==m.avatarId||marker.runtime_agent_id!==m.runtimeAgentId)refuse();return {e,run,m};}
 async start(runId:string,signal:AbortSignal){uuid.parse(runId);return this.db.begin(async tx=>{const {e,run,m}=await this.locked(tx,runId);if(run.state!=='active'||run.starts>=run.max_starts)refuse();await this.fence(tx,e,m,m.expiresAtMs,signal);await tx`UPDATE brainchain_probe_runs SET starts=starts+1 WHERE id=${runId}`;return {startOrdinal:Number(run.starts)+1};});}
 async assertCurrent(runId:string,signal:AbortSignal){uuid.parse(runId);await this.db.begin(async tx=>{const {e,run,m}=await this.locked(tx,runId);if(run.state!=='active')refuse();await this.fence(tx,e,m,m.expiresAtMs,signal);});}
 async reserve(runId:string,requestId:string,source:'protocol'|'brainchain'|'query'|'memory',text:string,signal:AbortSignal){uuid.parse(runId);uuid.parse(requestId);z.enum(['protocol','brainchain','query','memory']).parse(source);const bytes=Buffer.byteLength(text,'utf8'),digest=probeHash(text);if(bytes<1||bytes>32768)refuse();
  return this.db.begin(async tx=>{const {e,run,m}=await this.locked(tx,runId);const [prior]=await tx`SELECT * FROM brainchain_probe_calls WHERE run_id=${runId} AND request_id=${requestId} FOR UPDATE`;if(prior){if(prior.input_hash!==digest||prior.source!==source)refuse();return prior;}
   if(run.state!=='active'||run.calls>=run.max_calls||(source==='protocol'&&!m.protocolInputs.includes(digest))||(source==='brainchain'&&!m.brainchainInputs.includes(digest)))refuse();
   await this.fence(tx,e,m,m.expiresAtMs,signal);if(BigInt(e.reserved_micros)+BigInt(e.uncertain_micros)+BigInt(e.settled_micros)+200n>BigInt(e.limit_micros))refuse();
   const id=randomUUID();const [call]=await tx`INSERT INTO brainchain_probe_calls(id,run_id,envelope_id,request_id,source,input_hash,input_bytes,deadline) VALUES(${id},${runId},${m.envelopeId},${requestId},${source},${digest},${bytes},${tx.typed(new Date(Math.min(m.expiresAtMs,Date.now()+30000)).toISOString(),25)}::timestamptz) RETURNING *`;
   await tx`UPDATE brainchain_probe_runs SET calls=calls+1 WHERE id=${runId}`;await tx`UPDATE brainchain_compute_envelopes SET reserved_micros=reserved_micros+200 WHERE id=${m.envelopeId}`;return call!;});
 }
 async embedExact(runId:string,raw:{requestId:string;source:'protocol'|'brainchain'|'query'|'memory';text:string;signal:AbortSignal}){
  if(!this.provider)throw new Error('Probe provider unavailable');
  const input=Object.freeze({...raw}),startedAt=Date.now();
  const known=await this.reserve(runId,input.requestId,input.source,input.text,input.signal);
  const returnDeadline=Math.min(startedAt+30000,databaseDate(known.deadline).getTime());
  const assertReturn=()=>{if(input.signal.aborted||Date.now()>=returnDeadline)throw new Error('Probe result expired');};
  const admitted=await this.db.begin(async tx=>{const {e,run,m}=await this.locked(tx,runId);const [call]=await tx`SELECT * FROM brainchain_probe_calls WHERE id=${known.id} FOR UPDATE`;if(!call)refuse();if(run.state!=='active')refuse();await this.fence(tx,e,m,databaseDate(call.deadline).getTime(),input.signal);if(call.state!=='reserved')return {call,dispatch:false};
   await tx`UPDATE brainchain_probe_calls SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=${call.id}`;await tx`UPDATE brainchain_compute_envelopes SET reserved_micros=reserved_micros-200,uncertain_micros=uncertain_micros+200 WHERE id=${m.envelopeId}`;return {call,dispatch:true};});
  assertReturn();
  if(!admitted.dispatch){if(admitted.call.state==='settled'&&admitted.call.vector)return {vector:admitted.call.vector as number[],callId:String(known.id),inputHash:String(known.input_hash)};throw new Error('Probe evidence required');}
  let used=false;
  const ticket={assertCurrent:async(signal:AbortSignal)=>{if(used)refuse();used=true;await this.db.begin(async tx=>{const {e,run,m}=await this.locked(tx,runId);const [call]=await tx`SELECT * FROM brainchain_probe_calls WHERE id=${known.id} FOR UPDATE`;if(!call||call.state!=='dispatched'||run.state!=='active')refuse();await this.fence(tx,e,m,databaseDate(call.deadline).getTime(),signal);});}};
  try{const response=await this.provider.embed({callId:String(known.id),input:input.text,deadlineMs:returnDeadline},ticket,input.signal);
   if(!used||response.callId!==known.id||response.vector.length!==1536||!response.vector.every(Number.isFinite)||response.chargedMicros!==probeEmbeddingCharge(response.inputTokens))refuse();
   const accepted=await this.db.begin(async tx=>{const {e,run,m}=await this.locked(tx,runId);const [call]=await tx`SELECT * FROM brainchain_probe_calls WHERE id=${known.id} FOR UPDATE`;if(!call||call.state!=='dispatched'||response.chargedMicros!==probeEmbeddingCharge(response.inputTokens))refuse();
    await tx`UPDATE brainchain_probe_calls SET state='settled',charged_micros=${response.chargedMicros.toString()},input_tokens=${response.inputTokens},vector=${tx.typed(JSON.stringify(response.vector),25)}::jsonb WHERE id=${known.id}`;
    await tx`UPDATE brainchain_compute_envelopes SET uncertain_micros=uncertain_micros-200,settled_micros=settled_micros+${response.chargedMicros.toString()} WHERE id=${m.envelopeId}`;
    if(run.state!=='active'||input.signal.aborted)return false;try{await this.fence(tx,e,m,databaseDate(call.deadline).getTime(),input.signal);return true;}catch{return false;} });
   if(!accepted)throw new Error('Probe result expired');
   assertReturn();
   return {vector:response.vector,callId:String(known.id),inputHash:String(known.input_hash)};
  }catch{await this.db.begin(async tx=>{await this.locked(tx,runId);await tx`SELECT id FROM brainchain_probe_calls WHERE id=${known.id} FOR UPDATE`;await tx`UPDATE brainchain_probe_calls SET state='uncertain' WHERE id=${known.id} AND state='dispatched'`;});throw new Error('Probe outcome uncertain');}
 }
 async stop(runId:string){uuid.parse(runId);await this.db.begin(async tx=>{const {m}=await this.locked(tx,runId);await tx`UPDATE brainchain_probe_runs SET state='stopped' WHERE id=${runId}`;const calls=await tx`SELECT id FROM brainchain_probe_calls WHERE run_id=${runId} AND state='reserved' ORDER BY id FOR UPDATE`;await tx`UPDATE brainchain_probe_calls SET state='canceled',charged_micros=0 WHERE run_id=${runId} AND state='reserved'`;await tx`UPDATE brainchain_compute_envelopes SET reserved_micros=reserved_micros-${(BigInt(calls.length)*200n).toString()} WHERE id=${m.envelopeId}`;});}
 /** Conservative root reconciliation: retain the full maximum, never infer zero from a timeout. */
 async settleMaximum(runId:string,callId:string,reference:string){uuid.parse(runId);uuid.parse(callId);z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).parse(reference);await this.db.begin(async tx=>{const {m}=await this.locked(tx,runId);const [call]=await tx`SELECT * FROM brainchain_probe_calls WHERE id=${callId} AND run_id=${runId} FOR UPDATE`;if(!call)refuse();if(call.state==='settled'&&call.reconciliation_ref===reference)return;if(!['dispatched','uncertain'].includes(call.state))refuse();await tx`UPDATE brainchain_probe_calls SET state='settled',charged_micros=200,reconciliation_ref=${reference} WHERE id=${callId}`;await tx`UPDATE brainchain_compute_envelopes SET uncertain_micros=uncertain_micros-200,settled_micros=settled_micros+200 WHERE id=${m.envelopeId}`;});}
}
