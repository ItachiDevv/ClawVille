import {resolve} from 'node:path';
import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {getBrainchainFixtureSettings} from './test-fixtures/database';
import {bootstrapProbeRuntime,initializeProbeRuntimeDeploymentWith,registerProbeRuntime,getProbeSourceEvidence,type ProbeBootstrapDependencies,type ProbeBootstrapConfig} from './probe-bootstrap';
import {probeHash,probeManifestHash,type ProbeManifest} from './probe-embedding-budget';
async function refused(fn:()=>Promise<unknown>){try{await fn();return false;}catch{return true;}}
test('disabled bootstrap reads nothing; configured nonstaging refuses before reads',async()=>{
 let reads=0;const d={environment:'production',configPath:undefined,readProtected:async()=>{reads++;throw Error('unexpected');}} as unknown as ProbeBootstrapDependencies;
 await bootstrapProbeRuntime(d);expect(reads).toBe(0);expect(await refused(()=>bootstrapProbeRuntime({...d,configPath:'/fixture/config'}))).toBe(true);expect(reads).toBe(0);
});
test('boot entry: staging config refusal disables probe without crash; nonstaging config stays fatal',async()=>{
 let installed=0;const lines:string[]=[];
 const d={environment:'staging',configPath:'/fixture/config',sourceCommit:'a'.repeat(40),uid:0,platform:'linux',readProtected:async()=>{throw Error('ENOENT /fixture/config secret-like-text');},install:()=>{installed++;}} as unknown as ProbeBootstrapDependencies;
 await initializeProbeRuntimeDeploymentWith(d,l=>lines.push(l));
 expect(installed).toBe(0);expect(lines).toEqual(['[brainchain-probe] staging probe config refused; probe deployment disabled']);
 expect(await refused(()=>initializeProbeRuntimeDeploymentWith({...d,environment:'production'},l=>lines.push(l)))).toBe(true);
 expect(await refused(()=>initializeProbeRuntimeDeploymentWith({...d,environment:undefined},l=>lines.push(l)))).toBe(true);
 expect(await refused(()=>initializeProbeRuntimeDeploymentWith({...d,platform:'win32'},l=>lines.push(l)))).toBe(false);
 await initializeProbeRuntimeDeploymentWith({...d,configPath:undefined},l=>lines.push(l));expect(lines.length).toBe(2);
});
describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE!=='1')('trusted probe bootstrap shared pool',()=>{
 let q:ReturnType<typeof postgres>;beforeAll(async()=>{const s=await getBrainchainFixtureSettings();q=postgres({...s.options,max:4,onnotice:()=>{}});drizzle(q);await q`CREATE TABLE IF NOT EXISTS platform_agents(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,name varchar(100) NOT NULL)`;await q`ALTER TABLE avatars ADD COLUMN IF NOT EXISTS platform_agent_id uuid`;});afterAll(async()=>{await q.end();});
 async function context(){
  const agent=randomUUID(),m:ProbeManifest={version:1,runId:randomUUID(),envelopeId:randomUUID(),jobId:randomUUID(),userId:randomUUID(),avatarId:randomUUID(),platformAgentId:agent,runtimeAgentId:agent,sourceCommit:'a'.repeat(40),apiOrigin:'https://api-staging.clawville.world',protocolHash:'b'.repeat(64),curriculumHash:'c'.repeat(64),protocolInputs:[probeHash('protocol')],brainchainInputs:[probeHash('brainchain')],maxCalls:35,maxStarts:2,startedAtMs:Date.now(),expiresAtMs:Date.now()+120000,model:'text-embedding-3-small',dimensions:1536,pricingVersion:'openai-embedding-20261109-v1',maximumMicros:'200'};
  await q`INSERT INTO users(id,is_guest) VALUES(${m.userId},false)`;await q`INSERT INTO platform_agents(id,user_id,name) VALUES(${agent},${m.userId},'probe-fixture')`;await q`INSERT INTO avatars(id,user_id,is_guest,platform_agent_id) VALUES(${m.avatarId},${m.userId},false,${agent})`;
  const c:ProbeBootstrapConfig={version:1,manifest:m,manifestHash:probeManifestHash(m),pinPath:resolve('.brainchain-work/bootstrap-fixture/pins'),headPath:resolve('.brainchain-work/bootstrap-fixture/head'),historyDirectory:resolve('.brainchain-work/bootstrap-fixture/history'),credentialPath:resolve('.brainchain-work/bootstrap-fixture/key'),gatewayUrl:'http://127.0.0.1:39999',rootReservationId:randomUUID()};
  // Paths are absolute in the host fixture. Controlled readers avoid any actual credential access.
  let keys=0,installed=0,revoked=false;let onKey:()=>Promise<void>=async()=>{};
  const root={verifyReservation:async(a:{approvalRef:string})=>{if(revoked||a.approvalRef!=='brainchain-probe:'+c.manifestHash)throw Error('root refused');}};
  const d:ProbeBootstrapDependencies={environment:'staging',configPath:resolve('.brainchain-work/bootstrap-fixture/config'),sourceCommit:m.sourceCommit,uid:10001,platform:'linux',database:()=>q,
   readProtected:async p=>{if(p===resolve('.brainchain-work/bootstrap-fixture/config'))return JSON.stringify(c);if(p===c.credentialPath){keys++;await onKey();return 'synthetic-key';}throw Error('unexpected path');},
   openStore:async()=>({authority:()=>root}),sourceEvidence:async()=>({protocolHash:m.protocolHash,curriculumHash:m.curriculumHash,protocolInputs:m.protocolInputs,brainchainInputs:m.brainchainInputs}),install:()=>{installed++;}};
  return {m,c,d,get keys(){return keys;},get installed(){return installed;},revoke(){revoked=true;},onKey(fn:()=>Promise<void>){onKey=fn;}};
 }
 test('registration fixes expected ID without credential; boot only hydrates exact prepared run',async()=>{
  const f=await context();expect(await registerProbeRuntime(f.d)).toEqual({runId:f.m.runId,manifestHash:f.c.manifestHash});expect(await registerProbeRuntime(f.d)).toEqual({runId:f.m.runId,manifestHash:f.c.manifestHash});expect(f.keys).toBe(0);
  await bootstrapProbeRuntime(f.d);expect(f.keys).toBe(1);expect(f.installed).toBe(1);
  expect((await q`SELECT id FROM brainchain_compute_envelopes WHERE root_reservation_id=${f.c.rootReservationId}`)[0]!.id).toBe(f.m.envelopeId);expect((await q`SELECT calls,starts FROM brainchain_probe_runs WHERE id=${f.m.runId}`)[0]).toMatchObject({calls:0,starts:0});
 });
 test('missing run, source mismatch and root refusal occur before credential read',async()=>{
  const f=await context();expect(await refused(()=>bootstrapProbeRuntime(f.d))).toBe(true);expect(f.keys).toBe(0);
  expect(await refused(()=>registerProbeRuntime({...f.d,sourceCommit:'d'.repeat(40)}))).toBe(true);expect(f.keys).toBe(0);
  f.revoke();expect(await refused(()=>registerProbeRuntime(f.d))).toBe(true);expect(f.installed).toBe(0);
 });
 test('avatar platform-agent detachment refuses before credential access',async()=>{
  const f=await context();await registerProbeRuntime(f.d);await q`UPDATE avatars SET platform_agent_id=NULL WHERE id=${f.m.avatarId}`;
  expect(await refused(()=>bootstrapProbeRuntime(f.d))).toBe(true);expect(f.keys).toBe(0);expect(f.installed).toBe(0);
 });
 test('identity deletion or root revocation during credential await prevents installation',async()=>{
  for(const mode of ['identity','root']){const f=await context();await registerProbeRuntime(f.d);f.onKey(async()=>{if(mode==='root')f.revoke();else await q`DELETE FROM platform_agents WHERE id=${f.m.platformAgentId}`;});
   expect(await refused(()=>bootstrapProbeRuntime(f.d))).toBe(true);expect(f.keys).toBe(1);expect(f.installed).toBe(0);
  }
 });
});

test('bootstrap source evidence matches actual protocol and installer curriculum bytes',async()=>{
 const [{buildBrainchainOfficeManual},{buildProtocolManual}]=await Promise.all([import('@clawville/shared'),import('../skill-protocol')]);
 const {splitProtocolManualSections}=await import('@clawville/agent-runtime'),e=await getProbeSourceEvidence();
 const curriculum=buildBrainchainOfficeManual(),protocol=buildProtocolManual('https://api-staging.clawville.world');
 expect(e.curriculumHash).toBe(probeHash(curriculum));expect(e.protocolHash).toBe(probeHash(protocol));
 expect(e.brainchainInputs).toEqual(splitProtocolManualSections(curriculum).map(probeHash));expect(e.protocolInputs).toEqual(splitProtocolManualSections(protocol).map(probeHash));
 expect(e.brainchainInputs.length).toBeGreaterThan(0);expect(e.protocolInputs.length).toBeGreaterThan(0);
});
