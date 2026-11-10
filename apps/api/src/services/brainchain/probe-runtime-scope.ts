import { HTTPException } from 'hono/http-exception';
import { BRAINCHAIN_PROBE_CHAT_TEXT, brainchainProbeDirective } from '@clawville/agent-runtime';
import { getPostgresClient } from '@clawville/database';
import type { TrustedProbeRuntimeScope } from '@clawville/agent-runtime';
import type { ProbeEmbeddingBudget } from './probe-embedding-budget';

interface TrustedProbeDeployment {
  readonly budget: ProbeEmbeddingBudget;
  readonly gatewayUrl: string;
}
let deployment: TrustedProbeDeployment | undefined;
/** Trusted API bootstrap only. No route or request calls this function. */
export function configureProbeRuntimeDeployment(value: TrustedProbeDeployment): void {
  if (deployment || process.env.CLAWVILLE_ENV !== 'staging') throw new Error('probe_runtime_refused');
  const url = new URL(value.gatewayUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('probe_runtime_refused');
  deployment = Object.freeze({ ...value });
}
type ProbeIdentity = { userId?: string | null; avatarId?: string | null; platformAgentId?: string | null };
/** True only on staging, the one environment where probe fixture markers can exist. */
export function probeMarkerChecksEnabled(): boolean {
  return process.env.CLAWVILLE_ENV === 'staging';
}
async function findProbeMarker(identity: ProbeIdentity) {
  // Probe fixtures exist only on staging: preparation requires CLAWVILLE_ENV=staging,
  // probe manifests pin the staging API origin, and resolveProbeRuntimeScope refuses
  // every other environment. Other environments skip this read, which otherwise runs
  // on every authenticated request and every autonomous decision. A marked identity
  // outside staging therefore acts as an ordinary user; it never gains access.
  if (!probeMarkerChecksEnabled()) return undefined;
  const platformAgentId = identity.platformAgentId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(identity.platformAgentId) ? identity.platformAgentId : null;
  if (!identity.userId && !identity.avatarId && !platformAgentId) return undefined;
  const [marker] = await getPostgresClient()`SELECT * FROM brainchain_probe_markers WHERE (${identity.userId ?? null}::uuid IS NOT NULL AND user_id=${identity.userId ?? null}::uuid) OR (${identity.avatarId ?? null}::uuid IS NOT NULL AND avatar_id=${identity.avatarId ?? null}::uuid) OR (${platformAgentId}::uuid IS NOT NULL AND platform_agent_id=${platformAgentId}::uuid) LIMIT 1`;
  return marker;
}
export async function assertProbeOperationAllowed(identity: ProbeIdentity): Promise<void> {
  if (await findProbeMarker(identity)) throw new HTTPException(403,{message:'probe_operation_refused'});
}
/** This runtime-start lookup is independent of configuration and environment and includes every run state. */
export async function resolveProbeRuntimeScope(platformAgentId: string, userId: string, start = false): Promise<TrustedProbeRuntimeScope | undefined> {
  const db = getPostgresClient();
  const [marker] = await db`SELECT * FROM brainchain_probe_markers WHERE platform_agent_id=${platformAgentId}::uuid`;
  if (!marker) return undefined;
  if (!deployment || process.env.CLAWVILLE_ENV !== 'staging') throw new Error('probe_runtime_refused');
  const found = await deployment.budget.lookup(platformAgentId);
  if (!found || found.state !== 'active' || found.manifest.userId !== userId || found.manifest.platformAgentId !== platformAgentId || found.expiresAt.getTime() <= Date.now()) throw new Error('probe_runtime_refused');
  const m = found.manifest;
  const [current] = await db`SELECT a.id FROM platform_agents a JOIN users u ON u.id=a.user_id JOIN avatars v ON v.user_id=u.id AND v.platform_agent_id=a.id WHERE a.id=${platformAgentId}::uuid AND u.id=${userId}::uuid AND v.id=${m.avatarId}::uuid AND u.is_guest=false AND v.is_guest=false`;
  if (!current) throw new Error('probe_runtime_refused');
  const budget = deployment.budget;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(2000, m.expiresAtMs-Date.now())));
  const runtimeStart = start ? (await budget.start(m.runId, signal)).startOrdinal : undefined;
  if (!start) await budget.assertCurrent(m.runId, signal);
  return Object.freeze({ runId:m.runId, manifestHash:found.manifestHash, platformAgentId:m.platformAgentId, runtimeAgentId:m.runtimeAgentId, deadlineMs:m.expiresAtMs, runtimeStart, gatewayUrl:deployment.gatewayUrl,
    assertRuntimeCurrent:(signal:AbortSignal)=>budget.assertCurrent(m.runId,signal),
    failRun:()=>budget.stop(m.runId),
    embeddings:{embedExact:(input:Parameters<TrustedProbeRuntimeScope['embeddings']['embedExact']>[0])=>budget.embedExact(m.runId,input)},
  });
}

export async function assertProbeActionAllowed(identity: ProbeIdentity, reply:string):Promise<void> {
  const marker=await findProbeMarker(identity);
  if (!marker) return;
  const scope=await resolveProbeRuntimeScope(String(marker.platform_agent_id),String(marker.user_id));
  if (!scope || (reply.includes('[ACTION:') && reply.trim() !== '[ACTION: brainchain(op=workers)]')) throw new HTTPException(403,{message:'probe_operation_refused'});
}

/** Only exact source-controlled stage text bypasses paid moderation for a marked fixture. */
export async function allowProbeStageText(identity:ProbeIdentity,kind:'chat'|'directive',text:string|undefined):Promise<boolean>{
 const marker=await findProbeMarker(identity);if(!marker)return false;
 const scope=await resolveProbeRuntimeScope(String(marker.platform_agent_id),String(marker.user_id));
 if(!scope||text!==(kind==='chat'?BRAINCHAIN_PROBE_CHAT_TEXT:brainchainProbeDirective(scope.runId)))throw new HTTPException(403,{message:'probe_operation_refused'});
 return true;
}

/** Called only after the existing authentication path resolves canonical identity. */
export async function assertProbeHttpOperation(identity:ProbeIdentity,request:Request,readBody?:()=>Promise<unknown>):Promise<void>{
 const marker=await findProbeMarker(identity);if(!marker)return;
 const path=new URL(request.url).pathname,method=request.method;
 const readPaths=['/api/avatars/me','/api/world/autonomy/status','/api/brainchain/knowledge','/api/brainchain/status','/api/brainchain/workers'];
 if(method==='GET'&&readPaths.includes(path))return;
 // These routes retain their existing challenge/signature proof. This helper
 // grants no identity and never accepts body identifiers as canonical identity.
 if((method==='GET'&&path==='/api/agent/challenge')||(method==='POST'&&path==='/api/agent/disconnect'))return;
 let body:unknown;
 if(readBody){body=await readBody();if(new TextEncoder().encode(JSON.stringify(body)??'').length>8192)throw new HTTPException(403,{message:'probe_operation_refused'});}
 else {
 const clone=request.clone(),reader=clone.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 if(reader){try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8192)throw new HTTPException(403,{message:'probe_operation_refused'});chunks.push(part.value);}}finally{void reader.cancel().catch(()=>{});}}
 const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
 try{body=bytes?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)):{};}catch{throw new HTTPException(403,{message:'probe_operation_refused'});}
 }
 if(!body||typeof body!=='object'||Array.isArray(body))throw new HTTPException(403,{message:'probe_operation_refused'});
 const values=body as Record<string,unknown>,keys=Object.keys(values);
 const exact=(key:string,value:unknown)=>keys.length===1&&values[key]===value;
 if(method==='POST'&&path==='/api/world/autonomy'&&exact('active',false))return;
 if(method==='PATCH'&&path==='/api/avatars/me'&&exact('learningFocus',`probe-stop-${String(marker.run_id).slice(0,8)}-${String(marker.avatar_id).slice(0,8)}`))return;
 const scope=await resolveProbeRuntimeScope(String(marker.platform_agent_id),String(marker.user_id));
 if(!scope)throw new HTTPException(403,{message:'probe_operation_refused'});
 if(method==='POST'&&path==='/api/brainchain/install'&&keys.length===0)return;
 if(method==='POST'&&path==='/api/world/autonomy'&&exact('active',true))return;
 if(method==='POST'&&path==='/api/avatars/me/chat'&&exact('content',BRAINCHAIN_PROBE_CHAT_TEXT))return;
 if(method==='POST'&&path==='/api/avatars/me/directive'&&exact('directive',brainchainProbeDirective(scope.runId)))return;
 throw new HTTPException(403,{message:'probe_operation_refused'});
}
