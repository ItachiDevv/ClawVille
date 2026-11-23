import { expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
let marked=false, canonical=true, currentState='active';
const platformAgentId=randomUUID(),userId=randomUUID(),avatarId=randomUUID(),runId=randomUUID();
const sql=async(strings:TemplateStringsArray)=>strings.join('').includes('FROM platform_agents')?(canonical?[{id:platformAgentId}]:[]):marked?[{run_id:runId,user_id:userId,avatar_id:avatarId,platform_agent_id:platformAgentId}]:[];
mock.module('@clawville/database',()=>({getPostgresClient:()=>sql}));
const api=await import('./probe-runtime-scope');
test('persistent marker refuses missing deployment while ordinary identity stays ordinary',async()=>{
 marked=false;expect(await api.resolveProbeRuntimeScope(platformAgentId,userId)).toBeUndefined();
 marked=true;await expect(api.resolveProbeRuntimeScope(platformAgentId,userId)).rejects.toThrow('probe_runtime_refused');
});
test('trusted hydration respects stopped state, canonical identity and start ordinal',async()=>{
 const previous=process.env.CLAWVILLE_ENV;process.env.CLAWVILLE_ENV='staging';
 let starts=0;
 const manifest={runId,platformAgentId,runtimeAgentId:platformAgentId,userId,avatarId,expiresAtMs:Date.now()+60000};
 const budget={lookup:async()=>({manifest,manifestHash:'a'.repeat(64),state:currentState,expiresAt:new Date(manifest.expiresAtMs)}),start:async()=>({startOrdinal:++starts}),assertCurrent:async()=>{},embedExact:async()=>{throw new Error('unused');}};
 try{
  api.configureProbeRuntimeDeployment({gatewayUrl:'http://127.0.0.1:18745',budget:budget as unknown as Parameters<typeof api.configureProbeRuntimeDeployment>[0]['budget']});
  marked=true;const first=await api.resolveProbeRuntimeScope(platformAgentId,userId,true);expect(first?.runtimeStart).toBe(1);expect(starts).toBe(1);
  await api.resolveProbeRuntimeScope(platformAgentId,userId);expect(starts).toBe(1);
  currentState='stopped';await expect(api.resolveProbeRuntimeScope(platformAgentId,userId,true)).rejects.toThrow('probe_runtime_refused');expect(starts).toBe(1);
  currentState='active';canonical=false;await expect(api.resolveProbeRuntimeScope(platformAgentId,userId)).rejects.toThrow('probe_runtime_refused');
 }finally{if(previous===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=previous;}
});

test('platform-only marker denies external operations and accepts only the actual workers read',async()=>{
 const previous=process.env.CLAWVILLE_ENV;process.env.CLAWVILLE_ENV='staging';marked=true;canonical=true;currentState='active';
 try {
  await expect(api.assertProbeOperationAllowed({platformAgentId})).rejects.toThrow('probe_operation_refused');
  await api.assertProbeActionAllowed({platformAgentId},'[ACTION: brainchain(op=workers)]');
  await expect(api.assertProbeActionAllowed({platformAgentId},'[ACTION: chat_nori(message=hello)]')).rejects.toThrow('probe_operation_refused');
  await expect(api.assertProbeActionAllowed({platformAgentId},'[ACTION: brainchain(op=workers)] [ACTION: move(x=1,y=2)]')).rejects.toThrow('probe_operation_refused');
  marked=false;await api.assertProbeOperationAllowed({platformAgentId});await api.assertProbeActionAllowed({platformAgentId},'[ACTION: move(x=1,y=2)]');
  expect(marked).toBe(false);
 } finally{if(previous===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=previous;}
});

import {Hono} from 'hono';
import {BRAINCHAIN_PROBE_CHAT_TEXT,brainchainProbeDirective} from '@clawville/agent-runtime';
mock.module('../../lib/auth',()=>({lucia:{readSessionCookie:(value:string)=>value==='fixture=session'?'session':null,validateSession:async()=>({user:{id:userId},session:{id:'session',fresh:false}}),createSessionCookie:()=>({serialize:()=>''}),createBlankSessionCookie:()=>({serialize:()=>''})}}));
const {sessionMiddleware,requireAuth}=await import('../../middleware/auth');
test('actual Hono parsed-body then canonical auth preserves exact stages and rejects other writes',async()=>{
 const previous=process.env.CLAWVILLE_ENV;process.env.CLAWVILLE_ENV='staging';marked=true;canonical=true;currentState='active';let reached=0;
 const app=new Hono();
 // Matches index jsonBodyGuard ordering: the raw body is consumed before auth.
 app.use('*',async(c,next)=>{if(['POST','PATCH'].includes(c.req.method))await c.req.json();await next();});
 app.use('*',sessionMiddleware);
 app.use('/api/avatars/*',requireAuth);
 app.all('*',c=>{reached++;return c.json({ok:true});});
 const request=(path:string,body:unknown,method='POST')=>app.request(`http://fixture${path}`,{method,headers:{Cookie:'fixture=session','Content-Type':'application/json'},body:JSON.stringify(body)});
 try {
  for(const [path,body] of [['/api/brainchain/install',{}],['/api/avatars/me/chat',{content:BRAINCHAIN_PROBE_CHAT_TEXT}],['/api/avatars/me/directive',{directive:brainchainProbeDirective(runId)}],['/api/world/autonomy',{active:true}]] as const){expect((await request(path,body)).status).toBe(200);}
  for(const [path,body] of [['/api/avatars/me/chat',{content:'arbitrary'}],['/api/avatars/me/directive',{directive:brainchainProbeDirective(runId),extra:true}],['/api/world/autonomy',{active:true,extra:true}],['/api/agent/v2/expert-consult',{question:'paid'}]] as const){expect((await request(path,body)).status).toBe(403);}
  expect(reached).toBe(4);currentState='stopped';
  expect((await request('/api/world/autonomy',{active:false})).status).toBe(200);
  expect((await request('/api/avatars/me',{learningFocus:`probe-stop-${runId.slice(0,8)}-${avatarId.slice(0,8)}`},'PATCH')).status).toBe(200);
  expect((await app.request('http://fixture/api/world/autonomy/status',{headers:{Cookie:'fixture=session'}})).status).toBe(200);
  marked=false;expect((await request('/api/avatars/me/chat',{content:'ordinary unchanged'})).status).toBe(200);
  marked=true;expect((await app.request('http://fixture/api/avatars/me/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'unattributed guest unchanged'})})).status).toBe(401);
  expect((await app.request('http://fixture/public-diagnostic')).status).toBe(200);
 } finally{if(previous===undefined)delete process.env.CLAWVILLE_ENV;else process.env.CLAWVILLE_ENV=previous;}
});
