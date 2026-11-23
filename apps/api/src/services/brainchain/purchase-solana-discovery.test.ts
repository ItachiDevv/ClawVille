import {expect,test} from 'bun:test';
import {Keypair,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {SolanaBuyerDiscovery} from './purchase-solana-discovery';
import {SolanaBuyerRpc} from './purchase-solana-rpc';
import {SOLANA_BUYER_LANE as L} from './purchase-solana-policy';
import {buildSolanaBuyerArtifact,decodeSolanaBuyerTransaction} from './purchase-solana-transaction';
function fixture(count=0){
 const payer=Keypair.generate(),a=buildSolanaBuyerArtifact(payer.publicKey.toBase58(),{blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:100,lastValidBlockHeight:200});
 const rows=Array.from({length:count},(_,index)=>{
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:a.blockhash,instructions:[new TransactionInstruction({programId:Keypair.generate().publicKey,keys:[],data:Buffer.from(String(index))})]}).compileToV0Message());tx.sign([payer]);
  return {signature:bs58.encode(tx.signatures[0]!),slot:200-index,err:null,memo:null,blockTime:1,confirmationStatus:'finalized',wire:Buffer.from(tx.serialize()).toString('base64')};
 });
 const state={missing:'',calls:[] as {method:string;params:unknown[]}[]};
 const fetcher=(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  expect(String(input)).toBe(L.rpc);const request=JSON.parse(String(init?.body)) as {method:string;params:unknown[]};state.calls.push(request);let result:unknown;
  if(request.method==='getGenesisHash')result=L.genesisHash;
  else if(request.method==='getSignaturesForAddress'){
   const [address,raw]=request.params,options=raw as {before?:string;commitment:string;limit:number;minContextSlot:number};expect(options.commitment).toBe('finalized');expect(options.limit).toBe(25);expect(options.minContextSlot).toBe(100);
   if(address===a.sourceAta)result=[];
   else{expect(address).toBe(a.payer);const start=options.before?rows.findIndex(row=>row.signature===options.before)+1:0;if(options.before&&start===0)throw new Error('Unknown cursor');result=rows.slice(start,start+25).map(({wire,...row})=>row);}
  }else if(request.method==='getTransaction'){
   const row=rows.find(item=>item.signature===request.params[0]);if(!row)throw new Error('Unknown transaction');result=row.signature===state.missing?null:{slot:row.slot,transaction:[row.wire,'base64']};
  }else throw new Error('Unexpected method');
  return Response.json({jsonrpc:'2.0',id:1,result});
 }) as typeof fetch;
 return {a,payer,rows,state,rpc:new SolanaBuyerRpc(fetcher)};
}
test('bounded scans advance stored cursors without treating an empty history as non-payment',async()=>{
 const f=fixture(30),scan=new SolanaBuyerDiscovery(f.rpc),first=await scan.scan(f.a,null);
 expect(first.observation.state).toBe('incomplete');expect(first.observation.scannedTransactions).toBe(12);expect(first.cursor.payerBefore).toBe(f.rows[11]!.signature);expect(first.payment).toBeUndefined();
 const second=await scan.scan(f.a,first.cursor);expect(second.cursor.payerBefore).toBe(f.rows[23]!.signature);
 const third=await scan.scan(f.a,second.cursor);expect(third.observation.state).toBe('not_found');expect(third.payment).toBeUndefined();expect(third.observation.hasMore).toBe(false);
 expect(f.state.calls.every(call=>call.method!=='sendTransaction')).toBe(true);
});
test('unavailable candidates reset progress so a possible payment is never skipped',async()=>{
 const f=fixture(6);f.state.missing=f.rows[3]!.signature;const result=await new SolanaBuyerDiscovery(f.rpc).scan(f.a,null);
 expect(result.observation.state).toBe('unavailable');expect(result.cursor.payerBefore).toBeNull();expect(result.payment).toBeUndefined();
});
test('foreign message cursors refuse before RPC and matching partial signatures never become receipts',async()=>{
 const f=fixture(1),scan=new SolanaBuyerDiscovery(f.rpc);
 await expect(scan.scan(f.a,{version:1,messageHash:'00'.repeat(32),payerBefore:null,sourceBefore:null,payerDone:false,sourceDone:false})).rejects.toThrow();expect(f.state.calls).toHaveLength(0);
 const partial=decodeSolanaBuyerTransaction(f.a.unsignedTransaction);partial.sign([f.payer]);f.rows[0]!.wire=Buffer.from(partial.serialize()).toString('base64');
 const result=await scan.scan(f.a,null);expect(result.observation.state).toBe('unavailable');expect(result.payment).toBeUndefined();expect(result.cursor.payerBefore).toBeNull();
});
test('RPC cancellation stops a stalled response without waiting for its own five-second timer',async()=>{
 const controller=new AbortController();let signal:AbortSignal|undefined;
 const fetcher=(async(_input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{signal=init?.signal??undefined;return new Promise<Response>(()=>{});}) as typeof fetch;
 const started=Date.now(),pending=new SolanaBuyerRpc(fetcher).read('getGenesisHash',[],controller.signal);controller.abort();
 await expect(pending).rejects.toMatchObject({code:'receipt_unavailable'});expect(signal?.aborted).toBe(true);expect(Date.now()-started).toBeLessThan(1000);
});
