import {z} from 'zod';
import {validateOutboundUrlResolved} from '../hatcher-config';
import {FUNDING_EXIT_TESTNET as P,FundingExitError,fundingHash,type FundingArtifact} from './funding-exit-policy';
import {createBrainChainPublicClient} from './public-client';
const quantity=z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const block=z.object({number:quantity,hash:fundingHash,timestamp:quantity});
const hex=z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export type FundingSourceEvidence={transaction:string;blockNumber:string;blockHash:string;observedAt:string;finalized:boolean;destination:'unresolved'};
export type FundingDeskReport={state:'waiting'|'paying'|'paid'|'returning'|'returned'|'held';payoutTransaction:string|null;returnTransaction:string|null;observedAt:string;attribution:'unverified'};
/** Closed testnet endpoints, bounded DNS/headers/body, and no credential forwarding. */
export class FundingExitClient{
 private id=0;
 constructor(private readonly deps:{fetch?:typeof fetch;validateUrl?:typeof validateOutboundUrlResolved}={}){}
 private async request(url:string,body?:unknown,beforeSend?:()=>Promise<void>,parentSignal?:AbortSignal){const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let abortParent:()=>void=()=>{};const stopped=new Promise<never>((_,reject)=>{abortParent=()=>{controller.abort();reject(new FundingExitError('receipt_unavailable'));};if(parentSignal?.aborted)abortParent();else parentSignal?.addEventListener('abort',abortParent,{once:true});});
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new FundingExitError('receipt_unavailable'));},5000);});
  const work=async()=>{const checked=await(this.deps.validateUrl??validateOutboundUrlResolved)(url);if(!checked.ok||controller.signal.aborted)throw Error('refused');
   if(beforeSend){await beforeSend();if(controller.signal.aborted)throw Error('expired');}
   const response=await(this.deps.fetch??fetch)(url,{method:body?'POST':'GET',redirect:'manual',credentials:'omit',signal:controller.signal,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if(response.status!==200||response.redirected||(response.url&&response.url!==url)||!response.body||!response.headers.get('content-type')?.startsWith('application/json'))throw Error('response');
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>262144)throw Error('size');chunks.push(p.value);}}
   finally{controller.signal.removeEventListener('abort',cancel);if(size>262144)void reader.cancel().catch(()=>{});reader.releaseLock();}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))) as unknown;
  };
  try{return await Promise.race([work(),timeout,stopped]);}catch{throw new FundingExitError('receipt_unavailable');}finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abortParent);controller.abort();}
 }
 private async rpc(chainId:number,method:'eth_chainId'|'eth_getTransactionCount'|'eth_gasPrice'|'eth_getCode'|'eth_estimateGas'|'eth_getBalance'|'eth_call'|'eth_getTransactionReceipt'|'eth_getTransactionByHash'|'eth_getBlockByNumber'|'eth_sendRawTransaction',params:unknown[]=[],fence?:()=>Promise<void>,signal?:AbortSignal){
  const url=chainId===P.parentChainId?P.parentRpc:chainId===P.childChainId?P.childRpc:null;if(!url)throw new FundingExitError('unsupported_route');
  const id=++this.id;const result=z.object({jsonrpc:z.literal('2.0'),id:z.literal(id),result:z.unknown(),error:z.unknown().optional()}).parse(await this.request(url,{jsonrpc:'2.0',id,method,params},fence,signal));
  if(result.error!==undefined||!('result'in result))throw new FundingExitError('receipt_unavailable');return result.result;
 }
 private async chain(chainId:number,signal?:AbortSignal){if(BigInt(quantity.parse(await this.rpc(chainId,'eth_chainId',[],undefined,signal)))!==BigInt(chainId))throw new FundingExitError('receipt_unavailable');}
 async terms(signal?:AbortSignal){signal?.throwIfAborted();const original=this.deps.fetch??fetch;const fetcher=(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{signal?.throwIfAborted();return original(input,{...init,...(signal?{signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])}:{})});}) as typeof fetch;const observed=await createBrainChainPublicClient({...this.deps,fetch:fetcher}).observeExit('testnetExit');signal?.throwIfAborted();if(observed.state!=='observed')throw new FundingExitError('terms_unavailable');return observed.terms;}
 async prepare(kind:'parent_eth'|'parent_exit',source:string,amount:bigint){const chainId=kind==='parent_eth'?P.parentChainId:P.childChainId;await this.chain(chainId);
  const [nonce,price,code]=await Promise.all([this.rpc(chainId,'eth_getTransactionCount',[source,'pending']),this.rpc(chainId,'eth_gasPrice'),this.rpc(chainId,'eth_getCode',[source,'latest'])]);
  if(hex.parse(code)!=='0x')throw new FundingExitError('unsupported_route');const n=BigInt(quantity.parse(nonce));if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new FundingExitError('invalid_request');
  const gasPrice=BigInt(quantity.parse(price));if(gasPrice<=0n)throw new FundingExitError('receipt_unavailable');
  // Fixed conservative gas bounds; exact user maximum remains binding. No arbitrary RPC transaction object.
  return {nonce:Number(n),gas:kind==='parent_eth'?200000n:100000n,maxFeePerGas:gasPrice*2n,maxPriorityFeePerGas:0n,terms:kind==='parent_exit'?await this.terms():undefined,amount};
 }
 async verifyAuthority(a:FundingArtifact,signal?:AbortSignal){signal?.throwIfAborted();await this.chain(a.chainId,signal);if(hex.parse(await this.rpc(a.chainId,'eth_getCode',[a.source,'latest'],undefined,signal))!=='0x')throw new FundingExitError('unsupported_route');
  const nonce=BigInt(quantity.parse(await this.rpc(a.chainId,'eth_getTransactionCount',[a.source,'latest'],undefined,signal)));if(nonce>BigInt(a.nonce))throw new FundingExitError('operation_conflict');
  if(a.kind==='parent_exit'){const {fundingDigest,validateExitTerms}=await import('./funding-exit-policy');if(fundingDigest(validateExitTerms(await this.terms(signal)))!==a.termsHash)throw new FundingExitError('terms_unavailable');}
 }
 async send(a:FundingArtifact,signed:string,fence:()=>Promise<void>){await this.chain(a.chainId);return fundingHash.parse(await this.rpc(a.chainId,'eth_sendRawTransaction',[signed],fence));}
 async source(a:FundingArtifact,hash:string):Promise<FundingSourceEvidence>{fundingHash.parse(hash);await this.chain(a.chainId);
  const receipt=z.object({transactionHash:fundingHash,status:quantity,blockNumber:quantity,blockHash:fundingHash}).parse(await this.rpc(a.chainId,'eth_getTransactionReceipt',[hash]));
  const tx=z.object({hash:fundingHash,from:z.string(),to:z.string(),input:hex,value:quantity,nonce:quantity,chainId:quantity,blockHash:fundingHash}).parse(await this.rpc(a.chainId,'eth_getTransactionByHash',[hash]));
  if(receipt.transactionHash!==hash||BigInt(receipt.status)!==1n||tx.hash!==hash||tx.from.toLowerCase()!==a.source||tx.to.toLowerCase()!==a.to||tx.input!==a.data||BigInt(tx.value)!==BigInt(a.value)||BigInt(tx.nonce)!==BigInt(a.nonce)||BigInt(tx.chainId)!==BigInt(a.chainId)||tx.blockHash!==receipt.blockHash)throw new FundingExitError('receipt_unavailable');
  const final=block.parse(await this.rpc(a.chainId,'eth_getBlockByNumber',['finalized',false]));
  const canonical=block.parse(await this.rpc(a.chainId,'eth_getBlockByNumber',[receipt.blockNumber,false]));
  const finalAgain=block.parse(await this.rpc(a.chainId,'eth_getBlockByNumber',[final.number,false]));
  const age=Date.now()/1000-Number(BigInt(finalAgain.timestamp));if(canonical.hash!==receipt.blockHash||finalAgain.hash!==final.hash||age<0||age>120)throw new FundingExitError('receipt_unavailable');
  return {transaction:hash,blockNumber:BigInt(receipt.blockNumber).toString(),blockHash:receipt.blockHash,observedAt:new Date().toISOString(),finalized:BigInt(receipt.blockNumber)<=BigInt(final.number),destination:'unresolved'};
 }
 async report(hash:string):Promise<FundingDeskReport>{fundingHash.parse(hash);const result=z.object({exits:z.array(z.object({state:z.enum(['waiting','paying','paid','returning','returned','held']),payoutTx:fundingHash.optional(),returnTx:fundingHash.optional()})).min(1).max(4)}).parse(await this.request(`${P.origin}/exits/${hash}`));
  if(result.exits.length!==1)throw new FundingExitError('receipt_unavailable');const r=result.exits[0]!;return {state:r.state,payoutTransaction:r.payoutTx??null,returnTransaction:r.returnTx??null,observedAt:new Date().toISOString(),attribution:'unverified'};
 }
}
