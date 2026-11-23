import { describe, expect, test } from 'bun:test';
import { decodeEventLog, decodeFunctionData, encodeEventTopics, encodeFunctionResult, pad, toHex, type Hex } from 'viem';
import { BRAINCHAIN_CONTRACTS } from './contracts';
import { createBrainChainReader, workerReadAbi, workerHireAbi } from './chain-client';

const validateUrl=async(url:string)=>({ok:true as const,url});
const fakeFetch=(fn:(input:string|URL|Request,init?:RequestInit)=>Promise<Response>)=>fn as typeof fetch;
const address=`0x${'1'.repeat(40)}` as const;
const hash=`0x${'a'.repeat(64)}`;
describe('BrainChain bounded pinned RPC',()=>{
  test('payment reads pin board, worker model and account, and reject oversized or unknown ranges', async () => {
    const { pad, toEventSelector } = await import('viem');
    const board = BRAINCHAIN_CONTRACTS.mainnet.boards[0]!.address;
    let calls = 0;
    const reader = createBrainChainReader('mainnet', { validateUrl, fetch: fakeFetch(async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe('eth_getLogs');
      expect(request.params[0]).toEqual({ address: board, fromBlock: '0x3c5', toBlock: '0x3e8',
        topics: [toEventSelector('BountyPaid(uint256,bytes32,address,uint128,uint128)'), null, pad(address, { size: 32 }), pad(address, { size: 32 })] });
      return Response.json({ jsonrpc: '2.0', id: request.id, result: [] });
    }) });
    expect(await reader.paidLogs(board, pad(address, { size: 32 }), address, 965n, 1000n)).toEqual([]);
    await expect(reader.paidLogs(address, pad(address, { size: 32 }), address, 965n, 1000n)).rejects.toThrow();
    await expect(reader.paidLogs(board, pad(address, { size: 32 }), address, 965n, 2965n)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test('reads a consistent block, decodes stake and retains provisional semantics',async()=>{
    const methods:string[]=[];
    const reader=createBrainChainReader('testnet',{validateUrl,fetch:fakeFetch(async(url,init)=>{
      expect(url).toBe(BRAINCHAIN_CONTRACTS.testnet.rpc);expect(init?.redirect).toBe('manual');
      const body=JSON.parse(String(init?.body));methods.push(body.method);
      let result:unknown;
      switch(body.method){
        case 'eth_chainId':result=toHex(274630);break;
        case 'eth_blockNumber':result=toHex(5012);break;
        case 'eth_getBlockByNumber':result={number:toHex(5000),hash,timestamp:toHex(1700000000)};break;
        case 'eth_getCode':result='0x01';break;
        case 'eth_getBalance':result='0x64';break;
        case 'eth_call':{
          const decoded=decodeFunctionData({abi:workerReadAbi,data:body.params[0].data as Hex});
          const values:Record<string,unknown>={workerAllowed:true,get:{staked:500n,unstaking:20n,unlocksAt:1800000000n,price:10n,registered:true},held:2,minStake:500n,bond:100n,timelock:7200n,balanceOf:999n};
          result=encodeFunctionResult({abi:workerReadAbi,functionName:decoded.functionName,result:values[decoded.functionName]} as Parameters<typeof encodeFunctionResult>[0]);break;
        }
        default:throw new Error('Unexpected RPC');
      }
      return Response.json({jsonrpc:'2.0',id:body.id,result});
    })});
    const snapshot=await reader.snapshot(address);
    expect(snapshot.block.number).toBe('5000');expect(snapshot.provisional).toBe(true);
    expect(snapshot.stake).toEqual({stakedAtomic:'500',unstakingAtomic:'20',unlocksAtUnix:'1800000000',priceAtomic:'10',registered:true,held:'2'});
    expect(snapshot.balances).toEqual({gasWei:'100',brainAtomic:'999',usdgAtomic:'999'});
    expect(snapshot.terms).toEqual({minStakeAtomic:'500',bondAtomic:'100',timelockSeconds:'7200'});
    expect(methods.some(method=>method.includes('send'))).toBe(false);
  });
  test('refuses wrong network before contract reads',async()=>{
    let calls=0;
    const reader=createBrainChainReader('testnet',{validateUrl,fetch:fakeFetch(async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));return Response.json({jsonrpc:'2.0',id:body.id,result:'0x1'});})});
    await expect(reader.snapshot(address)).rejects.toThrow('Chain mismatch');expect(calls).toBe(1);
  });
  test('refuses private DNS, redirects, oversized responses, and invalid envelopes',async()=>{
    let privateCalls=0;
    const privateReader=createBrainChainReader('testnet',{validateUrl:async()=>({ok:false as const,reason:'resolves_to_private_ip' as const}),fetch:fakeFetch(async()=>{privateCalls++;return Response.json({});})});
    await expect(privateReader.assertChain()).rejects.toThrow('Chain read failed');expect(privateCalls).toBe(0);
    for(const response of [new Response(null,{status:302}),Response.json({jsonrpc:'2.0',id:999,result:'0x430c6'}),new Response(' '.repeat(1_048_577),{headers:{'content-type':'application/json'}})]){
      await expect(createBrainChainReader('testnet',{validateUrl,fetch:fakeFetch(async()=>response)}).assertChain()).rejects.toThrow('Chain read failed');
    }
  });
  test('deadline includes DNS resolution and blocks arbitrary board and range',async()=>{
    const slow=createBrainChainReader('testnet',{timeoutMs:5,validateUrl:()=>new Promise(()=>{}),fetch:fakeFetch(async()=>Response.json({}))});
    await expect(slow.assertChain()).rejects.toThrow('Chain read failed');
    const reader=createBrainChainReader('testnet');
    await expect(reader.hiredLogs(address,hash as Hex,0n,1n)).rejects.toThrow('Invalid log range');
    await expect(reader.hiredLogs(BRAINCHAIN_CONTRACTS.testnet.boards[0].address,hash as Hex,0n,50000n)).rejects.toThrow('Invalid log range');
  });
});

test('pinned WorkerHired ABI decodes all three indexed fields and refuses a missing decision topic', () => {
  const model = pad(address, { size: 32 });
  const topics = encodeEventTopics({ abi: workerHireAbi, eventName: 'WorkerHired', args: { id: 7n, model, decisionId: 9n } });
  expect(topics.length).toBe(4);
  const decoded = decodeEventLog({ abi: workerHireAbi, eventName: 'WorkerHired', topics: topics as [Hex, ...Hex[]], data: '0x', strict: true });
  expect(decoded.args).toEqual({ id: 7n, model, decisionId: 9n });
  expect(() => decodeEventLog({ abi: workerHireAbi, eventName: 'WorkerHired', topics: topics.slice(0, 3) as [Hex, ...Hex[]], data: '0x', strict: true })).toThrow();
});
