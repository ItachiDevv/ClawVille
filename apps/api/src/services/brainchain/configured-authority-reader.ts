import {keccak256,type Hex} from 'viem';
import {createBrainChainReadRpc,blockSchema,rpcQuantity} from './chain-client';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import {readConfiguredAuthority,assertConfiguredAuthorityEvidence,assertConfiguredAuthorityPolicy,type ConfiguredAuthorityEvidence} from './configured-authority';
import {WORKER_PROVISIONAL_POLICY,LEGACY_WORKER_POLICY,type WorkerObservationPolicy} from './worker-observation-policy';
export type ConfiguredAuthorityReader=(input:{deadlineMs:number;signal?:AbortSignal;observationPolicy?:WorkerObservationPolicy})=>Promise<ConfiguredAuthorityEvidence>;
/** Fixed read-only testnet endpoint. Caller deadline covers initial reads, runtime checks, and all getters together. */
export function createConfiguredAuthorityReader(overrides:Parameters<typeof createBrainChainReadRpc>[1]={}):ConfiguredAuthorityReader{
 return async input=>{
  const acquiredAt=Date.now(),deadline=Math.min(input.deadlineMs,acquiredAt+2000);
  if(!Number.isSafeInteger(input.deadlineMs)||deadline<=acquiredAt||input.signal?.aborted)throw Error('Configured authority caller deadline');
  const controller=new AbortController(),abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const fetcher=overrides.fetch??fetch;
   const rpc=createBrainChainReadRpc('testnet',{...overrides,timeoutMs:Math.min(overrides.timeoutMs??2000,deadline-acquiredAt),fetch:Object.assign((url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>fetcher(url,{...init,signal:AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:[])])}),{preconnect:()=>{}})});
   const work=async()=>{
    if(BigInt(rpcQuantity.parse(await rpc('eth_chainId')))!==274630n)throw Error('Configured authority chain mismatch');
    const head=BigInt(rpcQuantity.parse(await rpc('eth_blockNumber'))),number=input.observationPolicy===LEGACY_WORKER_POLICY?(head>12n?head-12n:0n):head;
    const at=blockSchema.parse(await rpc('eth_getBlockByNumber',['0x'+number.toString(16),false]));
    if(BigInt(at.number)!==number)throw Error('Configured authority selected block mismatch');
    for(const [address,expected] of Object.entries(TESTNET_SIGNER_CODE_EVIDENCE.contracts)){
     const code=await rpc('eth_getCode',[address,at.number]);if(typeof code!=='string'||!/^0x(?:[a-fA-F0-9]{2})+$/.test(code)||keccak256(code as Hex)!==expected)throw Error('Configured authority runtime mismatch');
    }
    return readConfiguredAuthority(rpc,at,new Date(acquiredAt),input.observationPolicy??WORKER_PROVISIONAL_POLICY,{deadlineMs:deadline,signal:controller.signal});
   };
   const canceled=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('Configured authority read canceled')),{once:true});timer=setTimeout(()=>controller.abort(),deadline-Date.now());});
   const result=await Promise.race([Promise.resolve().then(work),canceled]);
   if(controller.signal.aborted||input.signal?.aborted||Date.now()>=deadline)throw Error('Configured authority caller expired');return result;
  }finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);controller.abort();}
 };
}

export function assertPersistedConfiguredAuthority(row:{authorityPolicyVersion?:unknown;authorityPolicyDigest?:unknown;authority_policy_version?:unknown;authority_policy_digest?:unknown}){
 assertConfiguredAuthorityPolicy({authorityPolicyVersion:String(row.authorityPolicyVersion??row.authority_policy_version??''),authorityPolicyDigest:String(row.authorityPolicyDigest??row.authority_policy_digest??'')});
}

/** The consumer owns the timeout too: a trusted injected reader cannot retain database locks indefinitely. */
export async function observeConfiguredAuthority(reader:ConfiguredAuthorityReader,input:Parameters<ConfiguredAuthorityReader>[0]):Promise<ConfiguredAuthorityEvidence>{
 const deadline=Math.min(input.deadlineMs,Date.now()+2000),controller=new AbortController();
 if(!Number.isSafeInteger(input.deadlineMs)||deadline<=Date.now()||input.signal?.aborted)throw Error('Configured authority consumer deadline');
 const abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const canceled=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('Configured authority consumer canceled')),{once:true});timer=setTimeout(()=>controller.abort(),Math.max(0,deadline-Date.now()));});
  const result=await Promise.race([Promise.resolve().then(()=>reader({...input,deadlineMs:deadline,signal:controller.signal})),canceled]);
  if(controller.signal.aborted||input.signal?.aborted||Date.now()>=deadline)throw Error('Configured authority consumer expired');
  assertConfiguredAuthorityEvidence(result);return result;
 }finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);controller.abort();}
}
