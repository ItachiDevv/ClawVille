import {test,expect} from 'bun:test';
import {encodeFunctionResult,parseAbi,toFunctionSelector} from 'viem';
import {CONFIGURED_AUTHORITY_GETTERS,CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST,configuredAuthorityPair,assertConfiguredAuthorityPolicy,readConfiguredAuthority,type ConfiguredAuthorityRpc} from './configured-authority';
const at={number:'0x13ec',hash:'0x'+'a'.repeat(64),timestamp:'0x1'};
function fixture(change=-1,mode='ok'){
  let reads=0,anchors=0;
  const rpc:ConfiguredAuthorityRpc=async(method,params)=>{
    if(method==='eth_chainId')return mode==='chain'?'0x1':'0x430c6';
    if(method==='eth_getBlockByNumber'){anchors++;expect(reads).toBe(14);return{...at,hash:mode==='reorg'?'0x'+'b'.repeat(64):at.hash};}
    expect(method).toBe('eth_call');expect(params[1]).toBe(at.number);
    const request=params[0] as {to:string;data:string};
    const index=CONFIGURED_AUTHORITY_GETTERS.findIndex(([target,name])=>target===request.to&&toFunctionSelector(`${name}()` )===request.data);
    expect(index).toBeGreaterThanOrEqual(0);reads++;
    const [,name,type,expected]=CONFIGURED_AUTHORITY_GETTERS[index]!;
    const value=type==='address'?(index===change?'0x'+'f'.repeat(40):expected):type==='uint32'?(index===change?1:0):BigInt(index===change?1:0);
    if(mode==='missing'&&index===0)return'0x';
    return encodeFunctionResult({abi:parseAbi([`function ${name}() view returns (${type})`]) as import('viem').Abi,functionName:name!,result:value});
  };return{rpc,reads:()=>reads,anchors:()=>anchors};
}
test('configured testnet authority accepts exactly fourteen values without a TDX assertion',async()=>{
  const f=fixture(),result=await readConfiguredAuthority(f.rpc,at,new Date(),'nitro-testnet-latest-v1');
  expect(result.authorityPolicyVersion).toBe(CONFIGURED_AUTHORITY_VERSION);expect(result.authorityPolicyDigest).toBe(CONFIGURED_AUTHORITY_DIGEST);
  expect(f.reads()).toBe(14);expect(f.anchors()).toBe(1);expect(CONFIGURED_AUTHORITY_DIGEST).toMatch(/^[a-f0-9]{64}$/);
});
for(let index=0;index<14;index++)test(`getter ${index} drift refuses configured authority`,async()=>{const f=fixture(index);await expect(readConfiguredAuthority(f.rpc,at,new Date(),'nitro-testnet-latest-v1')).rejects.toThrow('drift');expect(f.anchors()).toBe(0);});
for(const mode of ['chain','missing','reorg'])test(`${mode} refuses configured authority`,async()=>{await expect(readConfiguredAuthority(fixture(-1,mode).rpc,at,new Date(),'nitro-testnet-latest-v1')).rejects.toThrow();});
test('missing and unknown persisted policy cannot inherit current evidence',()=>{
  for(const value of [undefined,{}, {authorityPolicyVersion:CONFIGURED_AUTHORITY_VERSION},{...configuredAuthorityPair(),authorityPolicyDigest:'a'.repeat(64)},{...configuredAuthorityPair(),authorityPolicyVersion:'unknown'}])expect(()=>assertConfiguredAuthorityPolicy(value)).toThrow();
  expect(()=>assertConfiguredAuthorityPolicy(configuredAuthorityPair())).not.toThrow();
});
test('caller deadline aborts late reads and never reaches final anchor',async()=>{
  let aborted=false,anchor=false;
  const rpc:ConfiguredAuthorityRpc=async(method,_params,signal)=>{if(method==='eth_chainId')return'0x430c6';if(method==='eth_getBlockByNumber')anchor=true;signal?.addEventListener('abort',()=>{aborted=true;});await Bun.sleep(40);return'0x';};
  await expect(readConfiguredAuthority(rpc,at,new Date(),'nitro-testnet-latest-v1',{deadlineMs:Date.now()+10})).rejects.toThrow();
  await Bun.sleep(50);expect(aborted).toBe(true);expect(anchor).toBe(false);
});
test('stale acquisition and changed final anchor refuse without resetting start',async()=>{
  await expect(readConfiguredAuthority(fixture().rpc,at,new Date(Date.now()-30001),'nitro-testnet-latest-v1')).rejects.toThrow();
  const f=fixture(),start=new Date(),native=Date.now;let clock=native();Date.now=()=>clock;
  try{const rpc:ConfiguredAuthorityRpc=async(method,params,signal)=>{const result=await f.rpc(method,params,signal);if(method==='eth_getBlockByNumber')clock+=30001;return result;};await expect(readConfiguredAuthority(rpc,at,start,'nitro-testnet-latest-v1')).rejects.toThrow();}finally{Date.now=native;}
});

for(const corrupt of ['trailing','address-padding','uint32-padding'])test(`noncanonical ABI ${corrupt} refuses`,async()=>{
  const f=fixture();const rpc:ConfiguredAuthorityRpc=async(method,params,signal)=>{
    const result=await f.rpc(method,params,signal);if(method!=='eth_call')return result;
    const selector=(params[0] as {data:string}).data;
    if(corrupt==='trailing')return String(result)+'00';
    if(corrupt==='address-padding'&&selector===toFunctionSelector('owner()'))return '0x01'+String(result).slice(4);
    if(corrupt==='uint32-padding'&&selector===toFunctionSelector('tcbEvaluationNumber()'))return '0x01'+String(result).slice(4);
    return result;
  };await expect(readConfiguredAuthority(rpc,at,new Date(),'nitro-testnet-latest-v1')).rejects.toThrow();
});
test('caller Date mutation cannot refresh acquisition evidence',async()=>{
  const f=fixture(),start=new Date(),original=start.getTime(),native=Date.now;let clock=original;Date.now=()=>clock;
  try{const rpc:ConfiguredAuthorityRpc=async(method,params,signal)=>{const result=await f.rpc(method,params,signal);if(method==='eth_getBlockByNumber'){clock+=30001;start.setTime(clock);}return result;};await expect(readConfiguredAuthority(rpc,at,start,'nitro-testnet-latest-v1')).rejects.toThrow();}finally{Date.now=native;}
});

for(const mode of ['deadline','abort'])test(`final callback ${mode} refuses before return`,async()=>{
  const f=fixture(),start=Date.now(),native=Date.now,controller=new AbortController();let clock=start;Date.now=()=>clock;
  try{const rpc:ConfiguredAuthorityRpc=async(method,params,signal)=>{const value=await f.rpc(method,params,signal);if(method==='eth_getBlockByNumber'){if(mode==='deadline')clock=start+101;else controller.abort();}return value;};await expect(readConfiguredAuthority(rpc,at,new Date(start),'nitro-testnet-latest-v1',{deadlineMs:start+100,signal:controller.signal})).rejects.toThrow();}finally{Date.now=native;}
});
