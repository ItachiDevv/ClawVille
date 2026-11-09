import {expect,test} from 'bun:test';
import {FundingExitClient} from './funding-exit-client';
import {buildFundingArtifact,FUNDING_EXIT_TESTNET as P} from './funding-exit-policy';
import {randomUUID} from 'node:crypto';
const source=`0x${'1'.repeat(40)}`,hash=`0x${'a'.repeat(64)}`,blockHash=`0x${'b'.repeat(64)}`;
function artifact(){return buildFundingArtifact({id:randomUUID(),draft:{environment:'testnet',workerId:randomUUID(),idempotencyKey:randomUUID(),kind:'parent_eth',amountAtomic:'1000000000000000',maxGasCostWei:'1000000000000000',maxFeeAtomic:'0',minimumDestinationAtomic:'1000000000000000'},source,nonce:1,gas:100000n,maxFeePerGas:1000000n,maxPriorityFeePerGas:0n,now:Date.now()});}
test('fixed RPC rejects substituted transaction and canonical block, with no destination claim',async()=>{const a=artifact();let wrong=false,reorg=false;const urls:string[]=[];
 const client=new FundingExitClient({validateUrl:async url=>({ok:true as const,url}),fetch:(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{urls.push(String(input));const req=JSON.parse(String(init?.body));let result:unknown;
  if(req.method==='eth_chainId')result='0xb626';
  else if(req.method==='eth_getTransactionReceipt')result={transactionHash:hash,status:'0x1',blockNumber:'0xa',blockHash};
  else if(req.method==='eth_getTransactionByHash')result={hash,from:source,to:wrong?P.desk:P.inbox,input:a.data,value:'0x38d7ea4c68000',nonce:'0x1',chainId:'0xb626',blockHash};
  else if(req.method==='eth_getBlockByNumber')result={number:req.params[0]==='finalized'?'0x14':req.params[0],hash:reorg?`0x${'c'.repeat(64)}`:blockHash,timestamp:`0x${Math.floor(Date.now()/1000).toString(16)}`};
  else throw Error('unexpected method');return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}),{headers:{'Content-Type':'application/json'}});}) as unknown as typeof fetch});
 const result=await client.source(a,hash);expect(result.finalized).toBe(true);expect(result.destination).toBe('unresolved');expect(new Set(urls)).toEqual(new Set([P.parentRpc]));
 wrong=true;await expect(client.source(a,hash)).rejects.toThrow();wrong=false;reorg=true;await expect(client.source(a,hash)).rejects.toThrow();
});
test('desk labels retain unverified attribution and cannot supply arbitrary links',async()=>{const client=new FundingExitClient({validateUrl:async url=>({ok:true as const,url}),fetch:(async(input:Parameters<typeof fetch>[0])=>{expect(String(input)).toBe(`${P.origin}/exits/${hash}`);return new Response(JSON.stringify({exits:[{state:'held',reason:'private vendor prose',url:'https://evil.invalid',payoutTx:hash}]}),{headers:{'Content-Type':'application/json'}});}) as unknown as typeof fetch});
 expect(await client.report(hash)).toMatchObject({state:'held',attribution:'unverified',payoutTransaction:hash});expect('reason'in await client.report(hash)).toBe(false);
});
test('authority abort rejects an uncooperative transport and never starts another RPC after its late reply',async()=>{
 let release!:(response:Response)=>void,entered!:()=>void,calls=0;const inside=new Promise<void>(resolve=>{entered=resolve;});let seen:AbortSignal|null|undefined;
 const client=new FundingExitClient({validateUrl:async url=>({ok:true as const,url}),fetch:(async(_input:Parameters<typeof fetch>[0],init?:RequestInit)=>{calls++;seen=init?.signal;entered();return new Promise<Response>(resolve=>{release=resolve;});}) as unknown as typeof fetch}),controller=new AbortController();
 const pending=client.verifyAuthority(artifact(),controller.signal);await inside;controller.abort();await expect(pending).rejects.toThrow();expect(seen?.aborted).toBe(true);release(Response.json({jsonrpc:'2.0',id:1,result:'0xb626'}));await new Promise(resolve=>setTimeout(resolve,20));expect(calls).toBe(1);
});
