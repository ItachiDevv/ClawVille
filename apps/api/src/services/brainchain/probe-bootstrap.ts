import {z} from 'zod';
import type {Sql,TransactionSql} from 'postgres';
import {isAbsolute,resolve} from 'node:path';
import {getPostgresClient} from '@clawville/database';
import {ProtectedRootComputeStore,readRootTrialRecord} from './root-compute-store';
import {ProbeEmbeddingBudget,probeManifestSchema,probeManifestHash,probeHash,type ProbeManifest} from './probe-embedding-budget';
import {ProbeEmbeddingProvider} from './probe-embedding-provider';
import {DurableInferenceProxy,type RootComputeBudgetAuthority,type RootComputeEnvelopeApproval} from './inference-proxy';
import {configureProbeRuntimeDeployment} from './probe-runtime-scope';
const path=z.string().min(1).refine(p=>isAbsolute(p)&&resolve(p)===p);
export const probeBootstrapConfigSchema=z.object({version:z.literal(1),manifest:probeManifestSchema,manifestHash:z.string().regex(/^[a-f0-9]{64}$/),
 pinPath:path,headPath:path,historyDirectory:path,credentialPath:path,gatewayUrl:z.string().url(),rootReservationId:z.string().uuid()}).strict();
export type ProbeBootstrapConfig=z.infer<typeof probeBootstrapConfigSchema>;
export interface ProbeBootstrapDependencies {
 environment:string|undefined;configPath:string|undefined;sourceCommit:string|undefined;uid:number;platform:string;
 readProtected(path:string,uid:number):Promise<string>;
 openStore(config:ProbeBootstrapConfig,uid:number):Promise<{authority():RootComputeBudgetAuthority}>;
 database():Sql;
 sourceEvidence():Promise<{protocolHash:string;curriculumHash:string;protocolInputs:string[];brainchainInputs:string[]}>;
 install(value:{budget:ProbeEmbeddingBudget;gatewayUrl:string}):void;
}
function refused():never{throw new Error('probe_bootstrap_refused');}
async function bounded<T>(fn:()=>Promise<T>,deadline=Date.now()+2000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{if(Date.now()>=deadline)refused();const value=await Promise.race([Promise.resolve().then(fn),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('probe_bootstrap_expired')),Math.min(2000,deadline-Date.now()));})]);if(Date.now()>=deadline)refused();return value;}finally{clearTimeout(timer);}}
/** The same transaction owns these identity locks; no nested pool read or provider fallback. */
export async function assertProbeCanonicalIdentity(tx:TransactionSql,m:Readonly<ProbeManifest>,signal:AbortSignal){
 if(signal.aborted||m.runtimeAgentId!==m.platformAgentId)refused();
 const [row]=await tx`SELECT a.id FROM platform_agents a JOIN users u ON u.id=a.user_id JOIN avatars v ON v.user_id=u.id AND v.platform_agent_id=a.id WHERE a.id=${m.platformAgentId}::uuid AND u.id=${m.userId}::uuid AND v.id=${m.avatarId}::uuid AND u.is_guest=false AND v.is_guest=false FOR SHARE OF a,u,v`;
 if(!row||signal.aborted)refused();
}
function approval(c:ProbeBootstrapConfig):RootComputeEnvelopeApproval{return {jobId:c.manifest.jobId,provider:'openai',rootReservationId:c.rootReservationId,approvalRef:'brainchain-probe:'+c.manifestHash,limitMicros:BigInt(c.manifest.maxCalls)*200n,expiresAt:new Date(c.manifest.expiresAtMs)};}
async function identity(db:Sql,m:ProbeManifest){await db.begin(async tx=>{await tx`SET LOCAL lock_timeout='1000ms'`;await tx`SET LOCAL statement_timeout='2000ms'`;await assertProbeCanonicalIdentity(tx,m,AbortSignal.timeout(2000));const [clock]=await tx`SELECT EXTRACT(EPOCH FROM clock_timestamp())*1000 AS now`;if(Number(clock!.now)>=m.expiresAtMs)refused();});}
async function prepare(d:ProbeBootstrapDependencies){
 if(!d.configPath)return null;if(d.environment!=='staging'||d.platform!=='linux'||!Number.isSafeInteger(d.uid)||d.uid<0)refused();
 const config=probeBootstrapConfigSchema.parse(JSON.parse(await bounded(()=>d.readProtected(path.parse(d.configPath),d.uid))));
 const gateway=new URL(config.gatewayUrl);if(gateway.protocol!=='http:'||gateway.hostname!=='127.0.0.1'||!gateway.port||gateway.username||gateway.password||gateway.search||gateway.hash||!['','/'].includes(gateway.pathname))refused();
 const m=config.manifest;if(probeManifestHash(m)!==config.manifestHash||m.sourceCommit!==d.sourceCommit||m.runtimeAgentId!==m.platformAgentId||Date.now()>=m.expiresAtMs)refused();
 const evidence=await bounded(()=>d.sourceEvidence(),m.expiresAtMs);
 if(evidence.protocolHash!==m.protocolHash||evidence.curriculumHash!==m.curriculumHash||JSON.stringify(evidence.protocolInputs)!==JSON.stringify(m.protocolInputs)||JSON.stringify(evidence.brainchainInputs)!==JSON.stringify(m.brainchainInputs))refused();
 const store=await bounded(()=>d.openStore(config,d.uid),m.expiresAtMs),root=store.authority(),db=d.database();
 await bounded(()=>root.verifyReservation(approval(config)),m.expiresAtMs);await identity(db,m);
 return {config,m,root,db};
}
/** Trusted dependency seam for controlled tests. Production entry uses only the fixed dependencies below. */
export async function bootstrapProbeRuntime(d:ProbeBootstrapDependencies){
 const prepared=await prepare(d);if(!prepared)return;
 const {config,m,root,db}=prepared,unfunded=new ProbeEmbeddingBudget(db,root,assertProbeCanonicalIdentity);
 const found=await unfunded.lookup(m.platformAgentId);if(!found||found.state!=='active'||found.manifestHash!==config.manifestHash)refused();
 await unfunded.assertCurrent(m.runId,AbortSignal.timeout(2000));
 // Dedicated credential only, after identity, source and durable authority checks.
 const key=await bounded(()=>d.readProtected(config.credentialPath,d.uid),m.expiresAtMs);
 const provider=new ProbeEmbeddingProvider(key),budget=new ProbeEmbeddingBudget(db,root,assertProbeCanonicalIdentity,provider);
 await budget.assertCurrent(m.runId,AbortSignal.timeout(2000));await identity(db,m);
 await bounded(()=>root.verifyReservation(approval(config)),m.expiresAtMs);if(Date.now()>=m.expiresAtMs)refused();
 d.install({budget,gatewayUrl:config.gatewayUrl});
}
/** Root-only explicit registration. No credential read, genesis, signing or provider call. */
export async function registerProbeRuntime(d:ProbeBootstrapDependencies){
 const prepared=await prepare(d);if(!prepared)refused();const {config,m,root,db}=prepared;
 const boundedRoot:RootComputeBudgetAuthority={verifyReservation:value=>bounded(()=>root.verifyReservation(value),m.expiresAtMs)};
 const envelope=await new DurableInferenceProxy(db,[],[],boundedRoot).approveEnvelope(approval(config),m.envelopeId);
 if(envelope.id!==m.envelopeId)refused();
 return new ProbeEmbeddingBudget(db,root,assertProbeCanonicalIdentity).register(m);
}
export async function getProbeSourceEvidence(){
 const [{buildProtocolManual},{buildBrainchainOfficeManual},{splitProtocolManualSections}]=await Promise.all([import('../skill-protocol'),import('@clawville/shared'),import('@clawville/agent-runtime')]);
 const protocol=buildProtocolManual('https://api-staging.clawville.world'),curriculum=buildBrainchainOfficeManual();
 return {protocolHash:probeHash(protocol),curriculumHash:probeHash(curriculum),protocolInputs:splitProtocolManualSections(protocol).map(probeHash),brainchainInputs:splitProtocolManualSections(curriculum).map(probeHash)};
}
function dependencies():ProbeBootstrapDependencies{return {environment:process.env.CLAWVILLE_ENV,configPath:process.env.BRAINCHAIN_PROBE_CONFIG_PATH,sourceCommit:process.env.SOURCE_COMMIT,uid:process.getuid?.()??-1,platform:process.platform,
 readProtected:readRootTrialRecord,openStore:async(c,uid)=>ProtectedRootComputeStore.open({pinPath:c.pinPath,headPath:c.headPath,historyDirectory:c.historyDirectory,expectedUid:uid}),database:getPostgresClient,sourceEvidence:getProbeSourceEvidence,install:configureProbeRuntimeDeployment};}
/** API boot entry. A configured value outside staging stays fatal. On staging, a missing, expired or refused
 * config leaves probe deployment disabled instead of crash-looping later restarts: a marked fixture then
 * refuses at runtime start (resolveProbeRuntimeScope needs an installed deployment). The log names no path,
 * value or error text. */
export async function initializeProbeRuntimeDeploymentWith(d:ProbeBootstrapDependencies,warn:(line:string)=>void=console.warn){
 try{await bootstrapProbeRuntime(d);}catch(error){if(!d.configPath||d.environment!=='staging')throw error;warn('[brainchain-probe] staging probe config refused; probe deployment disabled');}
}
export async function initializeProbeRuntimeDeployment(){await initializeProbeRuntimeDeploymentWith(dependencies());}
export async function registerConfiguredProbeRuntime(){return registerProbeRuntime(dependencies());}
