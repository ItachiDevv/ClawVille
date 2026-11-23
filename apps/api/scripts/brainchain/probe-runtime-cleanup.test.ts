import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {getBrainchainFixtureSettings} from '../../src/services/brainchain/test-fixtures/database';
import {ProbeEmbeddingBudget,probeHash,probeManifestHash,type ProbeManifest} from '../../src/services/brainchain/probe-embedding-budget';
import {ProbeEmbeddingProvider} from '../../src/services/brainchain/probe-embedding-provider';
import {ProbeRuntimeBoundary} from '@clawville/agent-runtime';
import {stopPreparedProbeAdmission} from '../agent-connect/hosted-skill-runtime-probe';
const signal=()=>new AbortController().signal;
async function refused(fn:()=>PromiseLike<unknown>){try{await fn();return false;}catch{return true;}}
describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('probe cleanup shared pool',()=>{
 let q:ReturnType<typeof postgres>;
 beforeAll(async()=>{const s=await getBrainchainFixtureSettings();q=postgres({...s.options,max:4,onnotice:()=>{}});drizzle(q);});
 afterAll(async()=>{await q.end();});
 async function setup(wait?:()=>Promise<void>){
  const m:ProbeManifest={version:1,runId:randomUUID(),envelopeId:randomUUID(),jobId:randomUUID(),userId:randomUUID(),avatarId:randomUUID(),platformAgentId:randomUUID(),runtimeAgentId:randomUUID(),sourceCommit:'a'.repeat(40),apiOrigin:'https://api-staging.clawville.world',protocolHash:'b'.repeat(64),curriculumHash:'c'.repeat(64),protocolInputs:[probeHash('protocol')],brainchainInputs:[probeHash('brainchain')],maxCalls:35,maxStarts:2,startedAtMs:Date.now(),expiresAtMs:Date.now()+120000,model:'text-embedding-3-small',dimensions:1536,pricingVersion:'openai-embedding-20261109-v1',maximumMicros:'200'};
  const budget=randomUUID();let requests=0;
  await q`INSERT INTO brainchain_compute_budgets(id,job_id,provider,cap_micros,allocated_micros) VALUES(${budget},${m.jobId},'openai',10000000,7000)`;
  await q`INSERT INTO brainchain_compute_envelopes(id,budget_id,root_reservation_id,approval_ref,limit_micros,expires_at) VALUES(${m.envelopeId},${budget},${randomUUID()},${'brainchain-probe:'+probeManifestHash(m)},7000,${q.typed(new Date(m.expiresAtMs).toISOString(),25)}::timestamptz)`;
  const provider=new ProbeEmbeddingProvider('controlled-fixture',(async()=>{requests++;await wait?.();return Response.json({object:'list',model:m.model,data:[{object:'embedding',index:0,embedding:Array(1536).fill(0)}],usage:{prompt_tokens:4,total_tokens:4}});}) as unknown as typeof fetch);
  const service=new ProbeEmbeddingBudget(q,{verifyReservation:async()=>{}},async()=>{},provider);await service.register(m);
  return {m,service,fixture:{userId:m.userId,avatarId:m.avatarId,platformAgentId:m.platformAgentId,probeManifestHash:probeManifestHash(m)},get requests(){return requests;}};
 }
 test('repeat stop preserves reserved liability and refuses later dispatch',async()=>{
  const f=await setup(),id=randomUUID();await f.service.reserve(f.m.runId,id,'query','query',signal());
  await stopPreparedProbeAdmission(q,f.m.runId,f.fixture);await stopPreparedProbeAdmission(q,f.m.runId,f.fixture);
  expect(await refused(()=>f.service.embedExact(f.m.runId,{requestId:id,source:'query',text:'query',signal:signal()}))).toBe(true);expect(f.requests).toBe(0);
  const [row]=await q`SELECT r.state,e.reserved_micros,e.uncertain_micros FROM brainchain_probe_runs r JOIN brainchain_compute_envelopes e ON e.id=r.envelope_id WHERE r.id=${f.m.runId}`;
  expect(row.state).toBe('stopped');expect(String(row.reserved_micros)).toBe('200');expect(String(row.uncertain_micros)).toBe('0');
 });
 test('cleanup during a dispatched response retains maximum liability and exact calls',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),seen=new Promise<void>(r=>{entered=r;});
  const f=await setup(async()=>{entered();await gate;throw new Error('controlled lost reply');}),id=randomUUID();
  const work=f.service.embedExact(f.m.runId,{requestId:id,source:'query',text:'query',signal:signal()});
  await seen;await stopPreparedProbeAdmission(q,f.m.runId,f.fixture);
  const [held]=await q`SELECT r.state,e.reserved_micros,e.uncertain_micros FROM brainchain_probe_runs r JOIN brainchain_compute_envelopes e ON e.id=r.envelope_id WHERE r.id=${f.m.runId}`;
  expect(held.state).toBe('stopped');expect(String(held.uncertain_micros)).toBe('200');release();expect(await refused(()=>work)).toBe(true);
  expect(f.requests).toBe(1);expect(await refused(()=>f.service.embedExact(f.m.runId,{requestId:id,source:'query',text:'query',signal:signal()}))).toBe(true);expect(f.requests).toBe(1);
  const rows=await q`SELECT state FROM brainchain_probe_calls WHERE run_id=${f.m.runId}`;expect(rows).toHaveLength(1);expect(rows[0]!.state).toBe('uncertain');
 });
 test('mismatched prepared owner cannot stop a run',async()=>{
  const f=await setup();expect(await refused(()=>stopPreparedProbeAdmission(q,f.m.runId,{...f.fixture,userId:randomUUID()}))).toBe(true);
  const [run]=await q`SELECT state FROM brainchain_probe_runs WHERE id=${f.m.runId}`;expect(run.state).toBe('active');
 });
 test('runtime timeout durably stops before replacement start and retains in-flight uncertainty',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),seen=new Promise<void>(r=>{entered=r;});
  const f=await setup(async()=>{entered();await gate;throw new Error('controlled late unknown');});await f.service.start(f.m.runId,signal());
  const boundary=new ProbeRuntimeBoundary({runId:f.m.runId,manifestHash:probeManifestHash(f.m),platformAgentId:f.m.platformAgentId,runtimeAgentId:f.m.runtimeAgentId,deadlineMs:Date.now()+250,gatewayUrl:'http://127.0.0.1:18745',assertRuntimeCurrent:s=>f.service.assertCurrent(f.m.runId,s),failRun:()=>f.service.stop(f.m.runId),embeddings:{embedExact:input=>f.service.embedExact(f.m.runId,input)}});
  const work=boundary.embed('query','query');await seen;expect(await refused(()=>work)).toBe(true);
  expect(await refused(()=>f.service.start(f.m.runId,signal()))).toBe(true);
  const [row]=await q`SELECT r.state,e.uncertain_micros FROM brainchain_probe_runs r JOIN brainchain_compute_envelopes e ON e.id=r.envelope_id WHERE r.id=${f.m.runId}`;
  expect(row.state).toBe('stopped');expect(String(row.uncertain_micros)).toBe('200');expect(f.requests).toBe(1);release();
 });
 test('deliberate local shutdown permits the reviewed second start',async()=>{
  const f=await setup();expect((await f.service.start(f.m.runId,signal())).startOrdinal).toBe(1);
  const boundary=new ProbeRuntimeBoundary({runId:f.m.runId,manifestHash:probeManifestHash(f.m),platformAgentId:f.m.platformAgentId,runtimeAgentId:f.m.runtimeAgentId,deadlineMs:f.m.expiresAtMs,gatewayUrl:'http://127.0.0.1:18745',assertRuntimeCurrent:s=>f.service.assertCurrent(f.m.runId,s),failRun:()=>f.service.stop(f.m.runId),embeddings:{embedExact:input=>f.service.embedExact(f.m.runId,input)}});
  boundary.stop();expect(await refused(()=>boundary.embed('late','query'))).toBe(true);expect(f.requests).toBe(0);
  expect((await f.service.start(f.m.runId,signal())).startOrdinal).toBe(2);
 });

});
