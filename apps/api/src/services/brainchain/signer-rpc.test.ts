import {describe,test,expect} from 'bun:test';
import {createFixedTestnetTransport} from './signer-rpc';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import type {Hex} from 'viem';
const hash=`0x${'a'.repeat(64)}` as Hex,other=`0x${'b'.repeat(64)}`;
function fixture(answer:(method:string,params:unknown[])=>unknown){
  const calls:{method:string;params:unknown[]}[]=[];
  const fetcher=async(url:unknown,init?:RequestInit)=>{
    expect(url).toBe(BRAINCHAIN_CONTRACTS.testnet.rpc);expect(init?.redirect).toBe('manual');expect(init?.credentials).toBe('omit');
    const request=JSON.parse(String(init?.body));calls.push(request);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:answer(request.method,request.params)}),{headers:{'content-type':'application/json'}});
  };
  return{calls,transport:createFixedTestnetTransport({fetch:fetcher as typeof fetch,validateUrl:async(url)=>({ok:true,url})})};
}
const receipt={transactionHash:hash,blockHash:hash,blockNumber:'0x64',status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x2'};
const normal=(method:string)=>method==='eth_chainId'?'0x430c6':method==='eth_getTransactionReceipt'?receipt:method==='eth_blockNumber'?'0x70':{number:'0x64',hash,timestamp:'0x1'};
describe('BrainChain fixed signer RPC',()=>{
  test('activation gate blocks even direct broadcast before any request',async()=>{
    const {transport,calls}=fixture(()=>null);
    await expect(transport.broadcastSameBytes('0x0201')).rejects.toThrow('artifact equivalence');expect(calls).toHaveLength(0);
  });
  test('wrong chain refuses before transaction or receipt work',async()=>{
    const {transport,calls}=fixture(()=> '0x1');
    await expect(transport.receipt(hash)).rejects.toThrow('chain mismatch');expect(calls.map(call=>call.method)).toEqual(['eth_chainId']);
  });
  test('stale heads refuse before code reads; fresh wrong bytecode also refuses',async()=>{
    const stale=fixture(method=>method==='eth_chainId'?'0x430c6':method==='eth_blockNumber'?'0x64':{number:'0x64',hash,timestamp:'0x1'});
    await expect(stale.transport.assertTestnet()).rejects.toThrow('Fresh testnet head');
    expect(stale.calls.some(call=>call.method==='eth_getCode')).toBe(false);
    const wrong=fixture(method=>method==='eth_chainId'?'0x430c6':method==='eth_blockNumber'?'0x64':method==='eth_getCode'?'0x6000':{number:'0x64',hash,timestamp:`0x${Math.floor(Date.now()/1000).toString(16)}`});
    await expect(wrong.transport.assertTestnet()).rejects.toThrow('bytecode mismatch');
  });
  test('receipt inclusion remains provisional with exact fee evidence',async()=>{
    const {transport}=fixture(normal),result=await transport.receipt(hash);
    expect(result.state).toBe('included');expect(result.provisional).toBe(true);expect(result.successful).toBe(true);
    expect(result.confirmations).toBe('13');expect(result.gasUsed).toBe('21000');expect(result.effectiveGasPrice).toBe('2');
  });
  test('missing and reorged receipts never become confirmation',async()=>{
    expect((await fixture(method=>method==='eth_chainId'?'0x430c6':null).transport.receipt(hash)).state).toBe('pending');
    let blocks=0;
    const {transport}=fixture(method=>method==='eth_getBlockByNumber'?{number:'0x64',hash:++blocks===1?hash:other,timestamp:'0x1'}:normal(method));
    expect((await transport.receipt(hash)).state).toBe('orphaned');
  });
  test('foreign receipt hash and wrong block number fail closed',async()=>{
    await expect(fixture(method=>method==='eth_getTransactionReceipt'?{...receipt,transactionHash:other}:normal(method)).transport.receipt(hash)).rejects.toThrow('transaction mismatch');
    await expect(fixture(method=>method==='eth_getBlockByNumber'?{number:'0x63',hash,timestamp:'0x1'}:normal(method)).transport.receipt(hash)).rejects.toThrow('Block mismatch');
  });
  test('nonce observation preserves canonical and pending distinction',async()=>{
    const {transport}=fixture((method,params)=>method==='eth_chainId'?'0x430c6':params[1]==='latest'?'0x2':'0x3');
    expect(await transport.nonces(`0x${'1'.repeat(40)}`)).toEqual({canonical:2n,pending:3n});
  });
  test('timeout and response limits abort without retries',async()=>{
    let calls=0,signal:AbortSignal|undefined;
    const transport=createFixedTestnetTransport({validateUrl:async(url)=>({ok:true,url}),timeoutMs:10,fetch:((_url,init)=>{calls++;signal=init?.signal??undefined;return new Promise(()=>{});}) as typeof fetch});
    await expect(transport.receipt(hash)).rejects.toThrow('unavailable');expect(calls).toBe(1);expect(signal?.aborted).toBe(true);
    const oversized=createFixedTestnetTransport({validateUrl:async(url)=>({ok:true,url}),fetch:(async()=>new Response('a'.repeat(262145),{headers:{'content-type':'application/json'}})) as unknown as typeof fetch});
    await expect(oversized.receipt(hash)).rejects.toThrow('unavailable');
  });
});
