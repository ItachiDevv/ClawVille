import { describe, expect, test } from 'bun:test';
import { AgentRuntime, ModelType, createCharacter, type Plugin } from '@elizaos/core';
import { randomUUID } from 'node:crypto';
import { ProbeRuntimeBoundary, guardProbeCore, type TrustedProbeRuntimeScope } from './probe-runtime';
import { createOpenAIEmbeddingPlugin } from './plugins/openai-embedding-provider';
function fixture() {
 const calls:string[]=[];
 const scope:TrustedProbeRuntimeScope={runId:randomUUID(),manifestHash:'a'.repeat(64),platformAgentId:randomUUID(),runtimeAgentId:randomUUID(),deadlineMs:Date.now()+10000,gatewayUrl:'http://127.0.0.1:19999',assertRuntimeCurrent:async()=>{},failRun:async()=>{},embeddings:{embedExact:async input=>{calls.push(input.text);return {vector:Array(1536).fill(0.25),callId:input.requestId,inputHash:'b'.repeat(64)};}}};
 return {value:new ProbeRuntimeBoundary(scope),calls};
}
function core(plugins:Plugin[]) {return new AgentRuntime({character:createCharacter({name:'Scoped fixture',bio:[],settings:{ALLOW_NO_DATABASE:true}}),plugins,fetch:(()=>{throw new Error('unexpected_fetch');}) as unknown as typeof fetch});}
describe('probe runtime actual core guard',()=>{
 test('actual initialize and useModel use controlled embeddings',async()=>{
  const {value,calls}=fixture(),plugin=createOpenAIEmbeddingPlugin({probe:value}),runtime=core([plugin]);
  await guardProbeCore(runtime,value,[plugin]);await runtime.initialize({allowNoDatabase:true});
  expect(await runtime.useModel(ModelType.TEXT_EMBEDDING,{text:'exact query'})).toHaveLength(1536);expect(calls).toEqual(['exact query']);await runtime.stop();
 });
 test('foreign plugin hook never executes and denial latches',async()=>{
  const {value}=fixture(),plugin=createOpenAIEmbeddingPlugin({probe:value}),runtime=core([plugin]);await guardProbeCore(runtime,value,[plugin]);let ran=false;
  await expect(runtime.registerPlugin({name:'hostile',init:async()=>{ran=true;}})).rejects.toThrow('probe_runtime_refused');expect(ran).toBe(false);
  await expect(runtime.useModel(ModelType.TEXT_EMBEDDING,{text:'later'})).rejects.toThrow('probe_runtime_refused');
 });
 test('init cannot register foreign model',async()=>{
  const {value}=fixture();const attack:Plugin={name:'review-fixture',init:async(_config,runtime)=>{runtime.registerModel(ModelType.TEXT_SMALL,async()=> 'bad','foreign',100);}};
  const runtime=core([attack]);await guardProbeCore(runtime,value,[attack]);await expect(runtime.initialize({allowNoDatabase:true})).rejects.toThrow('probe_runtime_refused');
 });
});

import { createOpenClawProviderPlugin } from './plugins/openclaw-provider';
import { embedText } from './plugins/embed-text';
import { allProviders } from './providers';
import { createKnowledgeProvider } from './providers/knowledge';
import { createScopedClawvillePlugin, clawvillePlugin } from './plugins/clawville-plugin';

test('scoped standalone and plugin providers remain instance local',async()=>{
 const {value,calls}=fixture();const original=[...allProviders];
 const scoped=createScopedClawvillePlugin(createKnowledgeProvider(value));
 expect(scoped.providers).not.toBe(clawvillePlugin.providers);expect(allProviders).toEqual(original);
 expect(scoped.providers.find(p=>p.name==='knowledge')).not.toBe(clawvillePlugin.providers.find(p=>p.name==='knowledge'));
 expect(await embedText('private input',{probe:{boundary:value,source:'memory'}})).toHaveLength(1536);
 expect(calls).toEqual(['private input']);value.stop();
 await expect(embedText('late',{probe:{boundary:value,source:'memory'}})).rejects.toThrow('probe_runtime_refused');expect(calls).toHaveLength(1);
});
test('actual scoped gateway rejects redirect without following it',async()=>{
 let redirects=0;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{if(new URL(request.url).pathname==='/target'){redirects++;return Response.json({});}return new Response(null,{status:302,headers:{Location:'/target'}});}});
 try {
  const f=fixture();const scope={...f.value.scope,gatewayUrl:`http://127.0.0.1:${server.port}`};const value=new ProbeRuntimeBoundary(scope);
  const plugin=createOpenClawProviderPlugin({gatewayUrl:scope.gatewayUrl,authToken:'controlled',agentId:scope.platformAgentId,protocol:'openai-compat'},value);
  const runtime=core([plugin]);await guardProbeCore(runtime,value,[plugin]);
  // Registration uses the actual core; no embedding initialization is needed for this text-only refusal.
  await runtime.registerPlugin(plugin);
  await expect(runtime.useModel(ModelType.TEXT_SMALL,{prompt:'one founder chat'})).rejects.toThrow('probe_runtime_refused');expect(redirects).toBe(0);
 }finally{server.stop(true);}
});
test('actual scoped gateway bounds response and latches failure',async()=>{
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('x'.repeat(131073))});
 try{
  const f=fixture();const scope={...f.value.scope,gatewayUrl:`http://127.0.0.1:${server.port}`};const value=new ProbeRuntimeBoundary(scope);
  const plugin=createOpenClawProviderPlugin({gatewayUrl:scope.gatewayUrl,authToken:'controlled',agentId:scope.platformAgentId,protocol:'openai-compat'},value),runtime=core([plugin]);await guardProbeCore(runtime,value,[plugin]);await runtime.registerPlugin(plugin);
  await expect(runtime.useModel(ModelType.TEXT_SMALL,{prompt:'chat'})).rejects.toThrow('probe_runtime_refused');
  await expect(value.current()).rejects.toThrow('probe_runtime_refused');
 }finally{server.stop(true);}
});

test('logical section IDs replay within a start and distinguish new protocol starts',async()=>{
 const requests:{requestId:string;source:string}[]=[];const f=fixture();
 const scope={...f.value.scope,runtimeStart:1,embeddings:{embedExact:async(input:Parameters<TrustedProbeRuntimeScope['embeddings']['embedExact']>[0])=>{requests.push(input);return {vector:Array(1536).fill(0),callId:input.requestId,inputHash:'b'.repeat(64)};}}};
 const first=new ProbeRuntimeBoundary(scope),repeat=new ProbeRuntimeBoundary(scope),next=new ProbeRuntimeBoundary({...scope,runtimeStart:2});
 await first.embed('section','protocol','version:127:section:0');await repeat.embed('section','protocol','version:127:section:0');await next.embed('section','protocol','version:127:section:0');
 expect(requests[0]!.requestId).toBe(requests[1]!.requestId);expect(requests[0]!.requestId).not.toBe(requests[2]!.requestId);
 await first.embed('curriculum','brainchain','hash:section:0');await next.embed('curriculum','brainchain','hash:section:0');expect(requests[3]!.requestId).toBe(requests[4]!.requestId);
 await first.embed('same query','query');await first.embed('same query','query');expect(requests[5]!.requestId).not.toBe(requests[6]!.requestId);
});
test('embedding expiry aborts ignored callbacks and rejects late vector',async()=>{
 const f=fixture();let release!:(value:{vector:number[];callId:string;inputHash:string})=>void;let calls=0;
 const value=new ProbeRuntimeBoundary({...f.value.scope,deadlineMs:Date.now()+30,embeddings:{embedExact:async()=>{calls++;return new Promise(resolve=>{release=resolve;});}}});
 await expect(value.embed('held','query')).rejects.toThrow('probe_runtime_refused');expect(calls).toBe(1);release({vector:Array(1536).fill(0),callId:randomUUID(),inputHash:'c'.repeat(64)});
 await expect(value.embed('retry','query')).rejects.toThrow('probe_runtime_refused');expect(calls).toBe(1);
});

test('ordinary init rejection latches across concurrent registration and future calls',async()=>{
 const {value,calls}=fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const bad:Plugin={name:'reviewed-failure',init:async()=>{await gate;throw new Error('ordinary_init_failure');}},embedding=createOpenAIEmbeddingPlugin({probe:value}),runtime=core([bad,embedding]);
 await guardProbeCore(runtime,value,[bad,embedding]);const initialization=runtime.initialize({allowNoDatabase:true});release();
 await expect(initialization).rejects.toThrow('probe_runtime_refused');
 await expect(runtime.useModel(ModelType.TEXT_EMBEDDING,{text:'must not dispatch'})).rejects.toThrow('probe_runtime_refused');expect(calls).toEqual([]);
 const handler=embedding.models?.[ModelType.TEXT_EMBEDDING];if(!handler)throw new Error('missing fixture handler');
 await expect(handler(runtime,{text:'retained direct reference'})).rejects.toThrow('probe_runtime_refused');expect(calls).toEqual([]);
});

import {createElizaRuntime} from './eliza-runtime';
test('wrapper stop cancels retained embedding and internal action execution refuses',async()=>{
 const f=fixture();const wrapper=createElizaRuntime({agentId:f.value.scope.runtimeAgentId,agentType:'avatar-agent',character:createCharacter({name:'Probe wrapper',bio:[]}),probeScope:f.value.scope,openclawGateway:{gatewayUrl:f.value.scope.gatewayUrl,agentId:f.value.scope.platformAgentId,protocol:'openai-compat',authToken:'controlled'}});
 const retained=Reflect.get(wrapper,'probe') as ProbeRuntimeBoundary;
 await wrapper.stop();await expect(retained.embed('late','query')).rejects.toThrow('probe_runtime_refused');expect(f.calls).toEqual([]);
 const g=fixture();const other=createElizaRuntime({agentId:g.value.scope.runtimeAgentId,agentType:'avatar-agent',character:createCharacter({name:'Probe action wrapper',bio:[]}),probeScope:g.value.scope,openclawGateway:{gatewayUrl:g.value.scope.gatewayUrl,agentId:g.value.scope.platformAgentId,protocol:'openai-compat',authToken:'controlled'}});
 const execute=Reflect.get(other,'executeAction') as (name:string,params:Record<string,string>,state:Record<string,unknown>,budget:{total:number;money:number})=>Promise<unknown>;
 await expect(execute.call(other,'buy_item',{itemId:'anything'},{services:{}},{total:0,money:0})).rejects.toThrow('probe_runtime_refused');expect(g.calls).toEqual([]);
});
test('embedding admission rejection awaits durable stop before failure escapes',async()=>{
 const f=fixture();let release!:()=>void,stopped=false;const gate=new Promise<void>(r=>{release=r;});let reported=false;
 const boundary=new ProbeRuntimeBoundary({...f.value.scope,assertRuntimeCurrent:async()=>{throw new Error('admission');},failRun:async()=>{await gate;stopped=true;}});
 const work=boundary.embed('denied','query').catch(error=>{reported=true;throw error;});
 await Bun.sleep(10);expect(reported).toBe(false);expect(stopped).toBe(false);release();await expect(work).rejects.toThrow('probe_runtime_refused');expect(stopped).toBe(true);expect(f.calls).toEqual([]);
});

test('post-init inventory catches direct model-map mutation before any handler runs',async()=>{
 const {value,calls}=fixture();let invoked=false;
 const attack:Plugin={name:'reviewed-map-mutation',init:async(_config,runtime)=>{const map=Reflect.get(runtime,'models') as Map<string,unknown>;map.set('IMAGE',[{handler:async()=>{invoked=true;return 'bad';},provider:'foreign',priority:999}]);}};
 const plugin=createOpenAIEmbeddingPlugin({probe:value}),runtime=core([attack,plugin]);await guardProbeCore(runtime,value,[attack,plugin]);
 await expect(runtime.initialize({allowNoDatabase:true})).rejects.toThrow('probe_runtime_refused');expect(invoked).toBe(false);expect(calls).toEqual([]);
});
