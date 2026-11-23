import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {ProbeEmbeddingBudget,probeHash,probeManifestHash,type ProbeManifest} from './probe-embedding-budget';
import {ProbeEmbeddingProvider} from './probe-embedding-provider';
import {DurableInferenceProxy} from './inference-proxy';
import {reconcileRootComputeDocument} from './root-compute-store';
const signal=()=>new AbortController().signal;
async function refusal(fn:()=>PromiseLike<unknown>){try{await fn();return false;}catch{return true;}}
describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('probe embedding durable shared pool',()=>{
 let q:ReturnType<typeof postgres>;
 beforeAll(async()=>{const s=await getBrainchainFixtureSettings();q=postgres({...s.options,max:4,onnotice:()=>{}});drizzle(q);
  const sql=await Bun.file(new URL('../../../../../packages/database/migrations/0119_brainchain_probe_embeddings.sql',import.meta.url)).text();await q.unsafe(sql);await q.unsafe(sql);
 });afterAll(async()=>{await q.end();});
 async function setup(options:{throwProvider?:boolean;hangRoot?:boolean;providerWait?:()=>Promise<void>}={}){
  const m:ProbeManifest={version:1,runId:randomUUID(),envelopeId:randomUUID(),jobId:randomUUID(),userId:randomUUID(),avatarId:randomUUID(),platformAgentId:randomUUID(),runtimeAgentId:randomUUID(),sourceCommit:'a'.repeat(40),apiOrigin:'https://api-staging.clawville.world',protocolHash:'b'.repeat(64),curriculumHash:'c'.repeat(64),protocolInputs:[probeHash('protocol')],brainchainInputs:[probeHash('brainchain')],maxCalls:35,maxStarts:2,startedAtMs:Date.now(),expiresAtMs:Date.now()+120000,model:'text-embedding-3-small',dimensions:1536,pricingVersion:'openai-embedding-20261109-v1',maximumMicros:'200'};
  const budget=randomUUID(),reservation=randomUUID(),limit='7000';let requests=0,identity=true,rootLive=true,hang=false;
  await q`INSERT INTO brainchain_compute_budgets(id,job_id,provider,cap_micros,allocated_micros) VALUES(${budget},${m.jobId},'openai',10000000,${limit})`;
  await q`INSERT INTO brainchain_compute_envelopes(id,budget_id,root_reservation_id,approval_ref,limit_micros,expires_at) VALUES(${m.envelopeId},${budget},${reservation},${'brainchain-probe:'+probeManifestHash(m)},${limit},${q.typed(new Date(m.expiresAtMs).toISOString(),25)}::timestamptz)`;
  const root={verifyReservation:async()=>{if(hang)await new Promise(()=>{});if(!rootLive)throw Error('revoked');}};
  const provider=new ProbeEmbeddingProvider('fixture', (async()=>{requests++;await options.providerWait?.();if(options.throwProvider)throw Error('unknown');return Response.json({object:'list',model:m.model,data:[{object:'embedding',index:0,embedding:Array(1536).fill(0)}],usage:{prompt_tokens:4,total_tokens:4}});}) as unknown as typeof fetch);
  const service=new ProbeEmbeddingBudget(q,root,async()=>{if(!identity)throw Error('identity');},provider);
  await service.register(m);return {m,budget,reservation,root,provider,service,get requests(){return requests;},revoke(){rootLive=false;},identityOff(){identity=false;},hang(){hang=true;}};
 }
 test('single durable dispatch survives restart, preserves quota and uses shared close/reconciliation',async()=>{
  const f=await setup(),input={requestId:randomUUID(),source:'query' as const,text:'fixture',signal:signal()};await f.service.start(f.m.runId,signal());await f.service.start(f.m.runId,signal());expect(await refusal(()=>f.service.start(f.m.runId,signal()))).toBe(true);
  const races=await Promise.allSettled([f.service.embedExact(f.m.runId,input),f.service.embedExact(f.m.runId,input)]);expect(races.some(x=>x.status==='fulfilled')).toBe(true);expect(f.requests).toBe(1);
  expect((await f.service.embedExact(f.m.runId,input)).vector).toHaveLength(1536);expect(f.requests).toBe(1);
  const [run]=await q`SELECT calls,starts FROM brainchain_probe_runs WHERE id=${f.m.runId}`;expect(run!.calls).toBe(1);expect(run!.starts).toBe(2);
  await f.service.stop(f.m.runId);expect((await f.service.lookup(f.m.platformAgentId))!.state).toBe('stopped');
  const proxy=new DurableInferenceProxy(q,[],[],f.root);const closed=await proxy.closeEnvelope(f.m.envelopeId);expect(closed.releasedMicros).toBe('6999');expect(await proxy.closeEnvelope(f.m.envelopeId)).toEqual(closed);
  await q.begin(tx=>reconcileRootComputeDocument(tx,{kind:'clawville-root-compute-v1',jobId:f.m.jobId,revision:1,previousDocumentHash:null,issuedAtMs:Date.now(),expiresAtMs:Date.now()+60000,providers:{openai:{capMicros:'10000000',spentMicros:'1'},openrouter:{capMicros:'10000000',spentMicros:'0'}},reservations:[{rootReservationId:f.reservation,provider:'openai',approvalRef:'brainchain-probe:'+probeManifestHash(f.m),limitMicros:'7000',expiresAtMs:f.m.expiresAtMs,state:'settled',revoked:false,chargedMicros:'1',reconciliationRef:closed.reconciliationId}]}));
 });
 test('unknown send retains maximum through stop, close refusal and conservative reconciliation',async()=>{
  const f=await setup({throwProvider:true}),requestId=randomUUID();expect(await refusal(()=>f.service.embedExact(f.m.runId,{requestId,source:'query',text:'x',signal:signal()}))).toBe(true);expect(f.requests).toBe(1);
  expect(await refusal(()=>f.service.embedExact(f.m.runId,{requestId,source:'query',text:'x',signal:signal()}))).toBe(true);expect(f.requests).toBe(1);await f.service.stop(f.m.runId);
  const proxy=new DurableInferenceProxy(q,[],[],f.root);expect(await refusal(()=>proxy.closeEnvelope(f.m.envelopeId))).toBe(true);
  const [call]=await q`SELECT id,state FROM brainchain_probe_calls WHERE run_id=${f.m.runId}`;expect(call!.state).toBe('uncertain');await f.service.settleMaximum(f.m.runId,String(call!.id),'fixture_maximum');expect((await proxy.closeEnvelope(f.m.envelopeId)).releasedMicros).toBe('6800');
 });
 test('root/identity refusal and concurrent quota cap prevent provider work',async()=>{
  const f=await setup();const results=await Promise.allSettled(Array.from({length:37},()=>f.service.reserve(f.m.runId,randomUUID(),'query','x',signal())));expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(35);expect(f.requests).toBe(0);
  await f.service.stop(f.m.runId);expect((await q`SELECT reserved_micros FROM brainchain_compute_envelopes WHERE id=${f.m.envelopeId}`)[0]!.reserved_micros).toBe('0');
  const other=await setup();other.revoke();expect(await refusal(()=>other.service.reserve(other.m.runId,randomUUID(),'query','x',signal()))).toBe(true);
  const third=await setup();third.identityOff();expect(await refusal(()=>third.service.start(third.m.runId,signal()))).toBe(true);
 });
 test('hung trusted callback releases shared locks without reservation',async()=>{
  const f=await setup();f.hang();const started=Date.now();expect(await refusal(()=>f.service.reserve(f.m.runId,randomUUID(),'query','x',signal()))).toBe(true);expect(Date.now()-started).toBeLessThan(3000);
  await q.begin(async tx=>{await tx`SELECT id FROM brainchain_compute_budgets WHERE id=${f.budget} FOR UPDATE NOWAIT`;});expect((await q`SELECT calls FROM brainchain_probe_runs WHERE id=${f.m.runId}`)[0]!.calls).toBe(0);
 });
 test('stop during provider response retains charge but refuses vector and replay',async()=>{
  let arrived!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>arrived=r),wait=new Promise<void>(r=>release=r);
  const f=await setup({providerWait:async()=>{arrived();await wait;}}),input={requestId:randomUUID(),source:'query' as const,text:'frozen',signal:signal()};
  const pending=f.service.embedExact(f.m.runId,input);await seen;await f.service.stop(f.m.runId);release();expect(await refusal(()=>pending)).toBe(true);
  const [call]=await q`SELECT state,charged_micros FROM brainchain_probe_calls WHERE run_id=${f.m.runId}`;expect(call!.state).toBe('settled');expect(call!.charged_micros).toBe('1');
  expect(await refusal(()=>f.service.embedExact(f.m.runId,input))).toBe(true);expect(f.requests).toBe(1);
 });
 test('row lock wait is bounded before trusted callbacks',async()=>{
  const f=await setup();let held!:()=>void,release!:()=>void;const acquired=new Promise<void>(r=>held=r),wait=new Promise<void>(r=>release=r);
  const locker=q.begin(async tx=>{await tx`SELECT id FROM brainchain_compute_budgets WHERE id=${f.budget} FOR UPDATE`;held();await wait;});await acquired;
  const start=Date.now();try{expect(await refusal(()=>f.service.reserve(f.m.runId,randomUUID(),'query','x',signal()))).toBe(true);expect(Date.now()-start).toBeLessThan(2000);}finally{release();await locker;}
  expect((await q`SELECT calls FROM brainchain_probe_runs WHERE id=${f.m.runId}`)[0]!.calls).toBe(0);
 });
 test('SQL rejects incomplete settlement evidence and nonnumeric vectors',async()=>{
  const f=await setup(),call=await f.service.reserve(f.m.runId,randomUUID(),'query','x',signal());
  expect(await refusal(()=>q`INSERT INTO brainchain_probe_calls SELECT (jsonb_populate_record(NULL::brainchain_probe_calls,to_jsonb(c)||jsonb_build_object('id',${randomUUID()}::text,'request_id',${randomUUID()}::text,'state','settled','dispatched_at',clock_timestamp(),'charged_micros',0))).* FROM brainchain_probe_calls c WHERE id=${call.id}`)).toBe(true);
  expect(await refusal(()=>q`INSERT INTO brainchain_probe_calls SELECT (jsonb_populate_record(NULL::brainchain_probe_calls,to_jsonb(c)||jsonb_build_object('id',${randomUUID()}::text,'request_id',${randomUUID()}::text,'input_tokens',1))).* FROM brainchain_probe_calls c WHERE id=${call.id}`)).toBe(true);
  expect((await q`SELECT brainchain_probe_vector_valid(${q.typed(JSON.stringify(Array(1536).fill('bad')),25)}::jsonb) AS valid`)[0]!.valid).toBe(false);
  await f.service.stop(f.m.runId);
 });
 test('post-commit abort or host expiry refuses fresh and replay vectors without another charge',async()=>{
  for(const mode of ['fresh','replay'] as const)for(const outcome of ['abort','expiry'] as const){
   const f=await setup(),controller=new AbortController(),input={requestId:randomUUID(),source:'query' as const,text:'final boundary',signal:controller.signal};
   if(mode==='replay')await f.service.embedExact(f.m.runId,input);
   const native=Date.now;let crossed=false;
   const wrapped=new Proxy(q,{get(target,key){if(key==='begin')return async(...args:unknown[])=>{
    const answer=await Reflect.apply(target.begin,target,args);
    if(mode==='fresh'?answer===true:(answer as {dispatch?:boolean})?.dispatch===false){crossed=true;if(outcome==='abort')controller.abort();else {const [retained]=await q`SELECT deadline FROM brainchain_probe_calls WHERE run_id=${f.m.runId}`;const expired=new Date(retained!.deadline).getTime()+1;Date.now=()=>expired;}}
    return answer;
   };return Reflect.get(target,key);}});
   try{expect(await refusal(()=>new ProbeEmbeddingBudget(wrapped,f.root,async()=>{},f.provider).embedExact(f.m.runId,input))).toBe(true);expect(crossed).toBe(true);}finally{Date.now=native;}
   const [call]=await q`SELECT state,charged_micros FROM brainchain_probe_calls WHERE run_id=${f.m.runId}`;expect(call!.state).toBe('settled');expect(call!.charged_micros).toBe('1');expect(f.requests).toBe(1);
  }
 });
 test('concurrent starts return unique committed ordinals and missing provider never reserves',async()=>{
  const f=await setup(),results=await Promise.allSettled([f.service.start(f.m.runId,signal()),f.service.start(f.m.runId,signal()),f.service.start(f.m.runId,signal())]);
  expect(results.filter(x=>x.status==='fulfilled').map(x=>x.value.startOrdinal).sort()).toEqual([1,2]);
  const disabled=new ProbeEmbeddingBudget(q,f.root,async()=>{});expect(await refusal(()=>disabled.embedExact(f.m.runId,{requestId:randomUUID(),source:'query',text:'x',signal:signal()}))).toBe(true);
  expect((await q`SELECT calls FROM brainchain_probe_runs WHERE id=${f.m.runId}`)[0]!.calls).toBe(0);expect(f.requests).toBe(0);
 });
 test('immutable history and close replay reject retained counter drift',async()=>{
  const f=await setup();expect(await refusal(()=>q`DELETE FROM brainchain_probe_markers WHERE platform_agent_id=${f.m.platformAgentId}`)).toBe(true);expect(await refusal(()=>q`UPDATE brainchain_probe_runs SET manifest_hash=${'e'.repeat(64)} WHERE id=${f.m.runId}`)).toBe(true);
  await f.service.reserve(f.m.runId,randomUUID(),'query','x',signal());await q`UPDATE brainchain_compute_envelopes SET reserved_micros=0 WHERE id=${f.m.envelopeId}`;expect(await refusal(()=>new DurableInferenceProxy(q,[],[],f.root).closeEnvelope(f.m.envelopeId))).toBe(true);
  await q`UPDATE brainchain_compute_envelopes SET reserved_micros=200 WHERE id=${f.m.envelopeId}`;await f.service.stop(f.m.runId);
 });
});
