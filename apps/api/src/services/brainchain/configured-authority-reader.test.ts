/** Run alone: fixture replaces runtime hashes, never the policy reader or admission checks. */
import {test,expect,mock,afterAll} from 'bun:test';
import {keccak256,encodeFunctionResult,parseAbi,toFunctionSelector,type Abi} from 'viem';
const original=await import('./signer-code-evidence');
mock.module('./signer-code-evidence',()=>({TESTNET_SIGNER_CODE_EVIDENCE:{...original.TESTNET_SIGNER_CODE_EVIDENCE,contracts:Object.fromEntries(Object.keys(original.TESTNET_SIGNER_CODE_EVIDENCE.contracts).map(address=>[address,keccak256('0x6000')]))}}));
const {CONFIGURED_AUTHORITY_GETTERS}=await import('./configured-authority');
const {createConfiguredAuthorityReader,observeConfiguredAuthority}=await import('./configured-authority-reader');
afterAll(()=>mock.restore());
for(const mode of ['ok','chain','code','getter','anchor','deadline','abort'] as const)test(`fixed configured authority reader ${mode}`,async()=>{
 const native=Date.now,start=native(),controller=new AbortController();let clock=start,anchors=0,getters=0,codeReads=0;Date.now=()=>clock;
 const fetcher=Object.assign(async(url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  expect(String(url)).toBe('https://rpc.testnet.usebrainchain.com');const request=JSON.parse(String(init?.body));let result:unknown;
  if(request.method==='eth_chainId')result=mode==='chain'?'0x1':'0x430c6';
  else if(request.method==='eth_blockNumber')result='0x13ec';
  else if(request.method==='eth_getCode'){codeReads++;result=mode==='code'?'0x6001':'0x6000';}
  else if(request.method==='eth_getBlockByNumber'){
   anchors++;result={number:'0x13ec',hash:'0x'+(mode==='anchor'&&anchors===2?'b':'a').repeat(64),timestamp:'0x1'};
   if(anchors===2&&mode==='deadline')clock=start+101;if(anchors===2&&mode==='abort')controller.abort();
  }else if(request.method==='eth_call'){
   const entry=CONFIGURED_AUTHORITY_GETTERS.find(([target,name])=>target===request.params[0].to&&toFunctionSelector(`${name}()` )===request.params[0].data);if(!entry)throw Error('Unexpected getter');
   getters++;const [,name,type,value]=entry;
   result=encodeFunctionResult({abi:parseAbi([`function ${name}() view returns (${type})`]) as Abi,functionName:name!,result:type==='address'?(mode==='getter'?'0x'+'f'.repeat(40):value):type==='uint32'?Number(value):BigInt(value!)});
  }else throw Error('Unexpected method');return Response.json({jsonrpc:'2.0',id:request.id,result});
 },{preconnect:()=>{}});
 try{
  const operation=createConfiguredAuthorityReader({fetch:fetcher,validateUrl:async url=>({ok:true,url})})({deadlineMs:start+100,signal:controller.signal});
  if(mode==='ok'){const value=await operation;expect(value.blockNumber).toBe(5100n);expect(codeReads).toBe(8);expect(getters).toBe(14);expect(anchors).toBe(2);}
  else await expect(operation).rejects.toThrow();
 }finally{Date.now=native;}
});

test('consumer bounds an injected stalled reader and ignores its late result',async()=>{
 let aborted=false,release!:(value:never)=>void,effect=false;
 const read=observeConfiguredAuthority(async({signal})=>{signal?.addEventListener('abort',()=>{aborted=true;});return new Promise<never>(resolve=>{release=resolve;});},{deadlineMs:Date.now()+15}).then(value=>{effect=true;return value;});
 await expect(read).rejects.toThrow();expect(aborted).toBe(true);release({} as never);await Bun.sleep(10);expect(effect).toBe(false);
});
for(const mode of ['deadline','abort'])test(`consumer refuses injected final ${mode}`,async()=>{
 const native=Date.now,start=native(),controller=new AbortController();let clock=start;Date.now=()=>clock;
 try{await expect(observeConfiguredAuthority(async()=>{if(mode==='deadline')clock+=101;else controller.abort();return{} as never;},{deadlineMs:start+100,signal:controller.signal})).rejects.toThrow();}finally{Date.now=native;}
});
