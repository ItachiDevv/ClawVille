import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ProbeEmbeddingProvider, PROBE_EMBEDDING_ENDPOINT, PROBE_EMBEDDING_RESERVED_MICROS, probeEmbeddingCharge } from './probe-embedding-provider';
const request = () => ({callId:randomUUID(),input:'fixture input',deadlineMs:Date.now()+1000});
const ticket = () => ({assertCurrent:async(_signal:AbortSignal)=>{}});
const response = () => ({object:'list',model:'text-embedding-3-small',data:[{object:'embedding',index:0,embedding:Array(1536).fill(0.25)}],usage:{prompt_tokens:4,total_tokens:4}});
const transport = (fn:(url:unknown,init?:RequestInit)=>Promise<Response>|Response) => fn as typeof fetch;
const signal = () => new AbortController().signal;
async function failure(work:Promise<unknown>){try{await work;return '';}catch(e){return String(e);}}
test('fixed request, exact vector and full-model reservation arithmetic',async()=>{
  expect(probeEmbeddingCharge(8192)).toBe(164n);expect(PROBE_EMBEDDING_RESERVED_MICROS).toBe(200n);expect(probeEmbeddingCharge(1)).toBe(1n);
  expect(()=>probeEmbeddingCharge(8193)).toThrow();expect(()=>probeEmbeddingCharge(0)).toThrow();
  let calls=0,fenced=false;
  const adapter=new ProbeEmbeddingProvider('fixture-only',transport((url,init)=>{calls++;expect(fenced).toBe(true);expect(url).toBe(PROBE_EMBEDDING_ENDPOINT);expect(init!.redirect).toBe('manual');
    expect(JSON.parse(String(init!.body))).toEqual({model:'text-embedding-3-small',input:'fixture input',dimensions:1536,encoding_format:'float'});return Response.json(response());}));
  const gate={assertCurrent:async()=>{fenced=true;}},result=await adapter.embed(request(),gate,signal());
  expect(result.vector.length).toBe(1536);expect(result.inputTokens).toBe(4);expect(result.chargedMicros).toBe(1n);
  expect(await failure(adapter.embed(request(),gate,signal()))).toContain('execution_refused');expect(calls).toBe(1);
});
test('invalid input and expired deadline never fetch',async()=>{
  let calls=0;const adapter=new ProbeEmbeddingProvider('fixture',transport(()=>{calls++;return Response.json(response());}));
  for(const raw of [{...request(),input:''},{...request(),input:'x'.repeat(32769)},{...request(),input:'\u00e9'.repeat(16385)},{...request(),deadlineMs:Date.now()-1}])expect(await failure(adapter.embed(raw,ticket(),signal()))).not.toBe('');
  expect(calls).toBe(0);
});
for(const mode of ['deadline','abort','stalled'] as const)test(`final fence ${mode} prevents fetch`,async()=>{
  let calls=0;const abort=new AbortController(),raw={...request(),deadlineMs:Date.now()+30};
  const adapter=new ProbeEmbeddingProvider('fixture',transport(()=>{calls++;return Response.json(response());}));
  const gate={assertCurrent:async()=>{if(mode==='abort')abort.abort();else if(mode==='deadline')await Bun.sleep(45);else await new Promise(()=>{});}};
  expect(await failure(adapter.embed(raw,gate,abort.signal))).toContain('expired');expect(calls).toBe(0);
});
for(const mode of ['vector','nan','usage','zero','tokens','model','extra','redirect','length','oversize'] as const)test(`transmitted ${mode} stays uncertain`,async()=>{
  const adapter=new ProbeEmbeddingProvider('fixture',transport(()=>{
    const value=response();
    if(mode==='vector')value.data[0]!.embedding.pop();if(mode==='nan')value.data[0]!.embedding[0]=Infinity;
    if(mode==='usage')value.usage.total_tokens=5;if(mode==='zero')value.usage={prompt_tokens:0,total_tokens:0};
    if(mode==='tokens')value.usage={prompt_tokens:8193,total_tokens:8193};if(mode==='model')value.model='other';
    if(mode==='extra')return Response.json({...value,unexpected:true});
    if(mode==='redirect')return new Response('',{status:302,headers:{location:'https://example.invalid'}});
    if(mode==='length')return new Response('{}',{headers:{'content-type':'application/json','content-length':'999999'}});
    if(mode==='oversize')return new Response(' '.repeat(131073),{headers:{'content-type':'application/json'}});
    return Response.json(value);
  }));expect(await failure(adapter.embed(request(),ticket(),signal()))).toContain('uncertain');
});
for(const mode of ['fetch','body','synchronous-abort'] as const)test(`bounded ${mode} has no retry`,async()=>{
  let calls=0,canceled=false;const abort=new AbortController();
  const adapter=new ProbeEmbeddingProvider('fixture',transport(async()=>{calls++;
    if(mode==='fetch')return await new Promise<Response>(()=>{});
    if(mode==='synchronous-abort'){abort.abort();return Response.json(response());}
    return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){canceled=true;}}),{headers:{'content-type':'application/json'}});
  }));
  const started=Date.now();expect(await failure(adapter.embed({...request(),deadlineMs:Date.now()+30},ticket(),abort.signal))).toContain('uncertain');
  expect(Date.now()-started).toBeLessThan(500);expect(calls).toBe(1);if(mode==='body'){await Bun.sleep(1);expect(canceled).toBe(true);}
});
test('final response after absolute deadline refuses even if transport ignores timer',async()=>{
  const original=Date.now;let now=original();Date.now=()=>now;
  try{const raw=request(),adapter=new ProbeEmbeddingProvider('fixture',transport(()=>{now=raw.deadlineMs+1;return Response.json(response());}));
    expect(await failure(adapter.embed(raw,ticket(),signal()))).toContain('uncertain');
  }finally{Date.now=original;}
});
