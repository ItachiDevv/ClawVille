import {CONFIGURED_AUTHORITY_GETTERS} from './configured-authority';
﻿import {test,expect,mock,afterAll} from 'bun:test';
import {encodeFunctionResult,parseAbi,toFunctionSelector,keccak256,toHex,type Abi} from 'viem';
import {BRAINCHAIN_CONTRACTS} from './contracts';
const code='0x6000',hash=`0x${'a'.repeat(64)}`,address=`0x${'1'.repeat(40)}`;
const evidence=await import('./signer-code-evidence');
mock.module('./signer-code-evidence',()=>({TESTNET_SIGNER_CODE_EVIDENCE:{...evidence.TESTNET_SIGNER_CODE_EVIDENCE,contracts:Object.fromEntries(Object.keys(evidence.TESTNET_SIGNER_CODE_EVIDENCE.contracts).map(key=>[key,keccak256(code)]))}}));
const {createOwnedSignerObserver}=await import('./signer-observation');
afterAll(()=>mock.restore());
const entries:[string,unknown][]=[
  ['function changeSubject(address,bytes) view returns (bytes32)',hash],
  ['function get(address) view returns ((uint128 staked,uint128 unstaking,uint64 unlocksAt,uint128 price,bool registered))',{staked:500n,unstaking:0n,unlocksAt:0n,price:1n,registered:true}],
  ['function minStake() view returns (uint128)',500n],['function held(address) view returns (uint32)',0],
  ['function bond() view returns (uint128)',100n],['function workerAllowed(address) view returns (bool)',true],
  ['function balanceOf(address) view returns (uint256)',1000n],['function allowance(address,address) view returns (uint256)',100n],
  ['function lastClaim(address) view returns (uint256)',0n],['function FAUCET_INTERVAL() view returns (uint256)',86400n],
  ['function openProposal(bytes32) view returns (uint256)',0n],['function vetoed(address,bytes4) view returns (bool)',false],
  ['function changeCount() view returns (uint256)',33n],
];
function fixture(mode:'ok'|'reorg'|'stale'|'code'|'binding'|'chain'|'queue'|'idle'|'ttl',latest=false,broken?:{address:string;code:string},changedGetter?:string){
  let requests=0,anchors=0,clock=Date.now();const start=clock;
  const sql=async()=>mode==='binding'?[]:[{address,signer_address:address}];
  const fetcher:typeof fetch=Object.assign(async(_url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    requests++;expect(String(_url)).toBe(BRAINCHAIN_CONTRACTS.testnet.rpc);
    const request=JSON.parse(String(init?.body));let result:unknown;
    if(request.method==='eth_chainId')result=toHex(mode==='chain'?274663:274630);
    else if(request.method==='eth_blockNumber')result='0x1394';
    else if(request.method==='eth_getBlockByNumber'){
      anchors++;if(anchors===2&&mode==='stale')clock=start+121000;
      if(anchors===2&&mode==='ttl')clock=start+30001;
      result={number:latest?'0x1394':'0x1388',hash:anchors===2&&mode==='reorg'?`0x${'b'.repeat(64)}`:hash,timestamp:mode==='idle'||mode==='ttl'?'0x1':toHex(Math.floor(start/1000))};
    }else if(request.method==='eth_getCode')result=broken&&request.params[0].toLowerCase()===broken.address?broken.code:mode==='code'?'0x6001':code;
    else if(request.method==='eth_getBalance')result='0x1000';
    else if(request.method==='eth_call'){
      expect(request.params[1]).toBe(latest?'0x1394':'0x1388');
      const authority=CONFIGURED_AUTHORITY_GETTERS.find(([target,name])=>target===request.params[0].to&&toFunctionSelector(`${name}()` )===request.params[0].data);
      if(authority){const [,name,type,value]=authority;return Response.json({jsonrpc:'2.0',id:request.id,result:encodeFunctionResult({abi:parseAbi([`function ${name}() view returns (${type})`]) as import('viem').Abi,functionName:name!,result:type==='address'?(name===changedGetter?'0x'+'f'.repeat(40):value):type==='uint32'?Number(value):BigInt(value!)})});}
      const entry=entries.find(([signature])=>toFunctionSelector(signature)===request.params[0].data.slice(0,10));
      if(!entry)throw Error('Unexpected ABI');const abi:Abi=parseAbi([entry[0]]),name=entry[0].slice(9).split('(')[0]!;
      result=encodeFunctionResult({abi,functionName:name,result:mode==='queue'&&name==='workerAllowed'?false:entry[1]});
    }else throw Error('Unexpected RPC');
    return Response.json({jsonrpc:'2.0',id:request.id,result});
  },{preconnect:()=>{}});
  return{sql,fetcher,requests:()=>requests,clock:()=>clock};
}
test('same-block observation resolves bound address and exact pinned fields',async()=>{
  const f=fixture('ok');const observation=await createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})})('11111111-1111-4111-8111-111111111111');
  expect(observation.blockNumber).toBe(5000n);expect(observation.staked).toBe(500n);expect(observation.faucetInterval).toBe(86400n);expect(observation.gasBalance).toBe(4096n);expect(observation.applicationPending).toBe(false);
});
for(const mode of ['reorg','code','binding','chain','queue'] as const)test(`${mode} refuses signer observation`,async()=>{
  const f=fixture(mode);await expect(createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})})('11111111-1111-4111-8111-111111111111')).rejects.toThrow();
  if(mode==='binding')expect(f.requests()).toBe(0);
});
test('final anchor delay cannot admit an expired block',async()=>{
  const f=fixture('stale'),native=Date.now;Date.now=f.clock;
  try{await expect(createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})})('11111111-1111-4111-8111-111111111111')).rejects.toThrow();}
  finally{Date.now=native;}
});


for(const mode of ['idle','ttl','reorg'] as const)test(`explicit latest worker observation ${mode}`,async()=>{
  const f=fixture(mode,true),native=Date.now;Date.now=f.clock;
  try{
    const operation=createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})},'nitro-testnet-latest-v1')('11111111-1111-4111-8111-111111111111');
    if(mode==='idle'){
      const result=await operation;expect(result.blockNumber).toBe(5012n);expect(result.observationPolicy).toBe('nitro-testnet-latest-v1');
      expect(result.observedAt.getTime()).toBe(f.clock());expect(result.blockTimestamp).toBe(1n);
    }else await expect(operation).rejects.toThrow();
  }finally{Date.now=native;}
});

for(const returnedCode of ['0x','0x6001'])test('DecisionLog absent or mismatched runtime refuses observation '+returnedCode,async()=>{
  const f=fixture('ok',false,{address:'0x4e4cb48f3802bd519e0eed896df82197b0ecbc09',code:returnedCode});
  await expect(createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})})('11111111-1111-4111-8111-111111111111')).rejects.toThrow();
});
for(const returnedCode of ['0x','0x6001'])test('ModelRegistry absent or mismatched runtime refuses observation '+returnedCode,async()=>{
  const f=fixture('ok',false,{address:'0x3e5e23a5ff6548958ab3ddf42c51a59713ce550c',code:returnedCode});
  await expect(createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})})('11111111-1111-4111-8111-111111111111')).rejects.toThrow();
});
for(const returnedCode of ['0x','0x6001'])test('TestUSDG absent or mismatched runtime refuses observation '+returnedCode,async()=>{
  const f=fixture('ok',false,{address:'0xc4ec72794bf3ce9ba1de4b38085464c2eb0cdcf2',code:returnedCode});
  await expect(createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})})('11111111-1111-4111-8111-111111111111')).rejects.toThrow();
});

for(const getter of ['owner','brain','attestation'])test(`configured ${getter} drift refuses signer observation`,async()=>{
 const f=fixture('ok',false,undefined,getter);
 await expect(createOwnedSignerObserver(f.sql as never,{fetch:f.fetcher,validateUrl:async()=>({ok:true,url:BRAINCHAIN_CONTRACTS.testnet.rpc})})('11111111-1111-4111-8111-111111111111')).rejects.toThrow('drift');
});
