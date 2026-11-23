import {createHash} from 'node:crypto';
import {decodeFunctionResult,encodeFunctionResult,encodeFunctionData,parseAbi,type Hex} from 'viem';
import {z} from 'zod';
import {TESTNET_SIGNER_CODE_EVIDENCE} from './signer-code-evidence';
import {workerObservationFresh,type WorkerObservationPolicy} from './worker-observation-policy';

export const CONFIGURED_AUTHORITY_VERSION='brainchain-testnet-configured-authority-v1' as const;
const executor='0xa3a40a2d46d54dc6e88c08a9d98ec47785cb2366',log='0x4e4cb48f3802bd519e0eed896df82197b0ecbc09',board='0x7a7cc5d35a642ccc268c7b263ff800bc7ebd52a4';
/** Reviewed fixed getters. Zero attestations is a change detector, never a TDX guarantee. */
export const CONFIGURED_AUTHORITY_GETTERS=Object.freeze([
  [log,'owner','address','0x2b70bcf8fe79e75f10a7dbf8d9ab6d63216f2273'],
  [log,'pendingOwner','address','0x0000000000000000000000000000000000000000'],
  [log,'brain','address','0x4c4ef8b7797667ac553274dda0c08d777c5231a0'],
  [log,'attestation','address','0xb364f47e16ea1555835f9593f409c39d3509f4c5'],
  [log,'attestations','uint256','0'],[log,'tcbEvaluationNumber','uint32','0'],
  ['0x3e5e23a5ff6548958ab3ddf42c51a59713ce550c','owner','address',executor],
  [board,'owner','address',executor],[board,'guardian','address','0x84d01e0869fbcb07c0141e49c390ffdc064d6882'],
  [board,'feeRouter','address','0x235658ee85939e2969e1bcbae1633769a414bd8a'],
  ['0x6afc3efb49cf9b14c2f7c6c4f6c0bb3ef0125e2b','owner','address',executor],
  [executor,'board','address',board],[executor,'models','address','0x3e5e23a5ff6548958ab3ddf42c51a59713ce550c'],
  [executor,'guardian','address','0x84d01e0869fbcb07c0141e49c390ffdc064d6882'],
].map(row=>Object.freeze(row))) as readonly (readonly string[])[];
export const CONFIGURED_AUTHORITY_DIGEST=createHash('sha256').update(JSON.stringify({version:CONFIGURED_AUTHORITY_VERSION,chainId:274630,release:'3.5.0',sourceCommit:TESTNET_SIGNER_CODE_EVIDENCE.sourceCommit,contracts:TESTNET_SIGNER_CODE_EVIDENCE.contracts,getters:CONFIGURED_AUTHORITY_GETTERS})).digest('hex');
export type ConfiguredAuthorityPolicy={authorityPolicyVersion:string;authorityPolicyDigest:string};
export type ConfiguredAuthorityEvidence=ConfiguredAuthorityPolicy&{observedAt:Date;blockNumber:bigint;blockHash:string;blockTimestamp:bigint;observationPolicy?:WorkerObservationPolicy};
export function assertConfiguredAuthorityPolicy(value:Partial<ConfiguredAuthorityPolicy>|null|undefined):asserts value is ConfiguredAuthorityPolicy{
  if(value?.authorityPolicyVersion!==CONFIGURED_AUTHORITY_VERSION||value.authorityPolicyDigest!==CONFIGURED_AUTHORITY_DIGEST)throw Error('Current configured authority policy required');
}
export function assertConfiguredAuthorityEvidence(value:Partial<ConfiguredAuthorityEvidence>|undefined,now=new Date(Date.now())):asserts value is ConfiguredAuthorityEvidence{
  const evidence=value;assertConfiguredAuthorityPolicy(value);
  if(!evidence||!(evidence.observedAt instanceof Date)||typeof evidence.blockTimestamp!=='bigint'||typeof evidence.blockNumber!=='bigint'||!/^0x[0-9a-f]{64}$/.test(evidence.blockHash??'')||!workerObservationFresh(evidence as ConfiguredAuthorityEvidence,now))throw Error('Fresh configured authority evidence required');
}
export function configuredAuthorityPair(){return{authorityPolicyVersion:CONFIGURED_AUTHORITY_VERSION,authorityPolicyDigest:CONFIGURED_AUTHORITY_DIGEST};}
const hex=z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/);
const block=z.object({number:z.string().regex(/^0x[0-9a-fA-F]+$/),hash:z.string().regex(/^0x[a-fA-F0-9]{64}$/),timestamp:z.string().regex(/^0x[0-9a-fA-F]+$/)});
export type ConfiguredAuthorityRpc=(method:string,params:unknown[],signal?:AbortSignal)=>Promise<unknown>;
/** Caller supplies a fixed trusted transport. No endpoint or getter comes from a task or public request. */
export async function readConfiguredAuthority(rpc:ConfiguredAuthorityRpc,anchor:{number:string;hash:string;timestamp:string},observedAt:Date,observationPolicy?:WorkerObservationPolicy,limits:{deadlineMs?:number;signal?:AbortSignal}={}):Promise<ConfiguredAuthorityEvidence>{
  const at=block.parse(anchor),acquiredAt=observedAt.getTime(),deadline=Math.min(acquiredAt+30000,limits.deadlineMs??Infinity);
  async function bounded(method:string,params:unknown[]){
    const remaining=deadline-Date.now();if(limits.signal?.aborted||!Number.isFinite(remaining)||remaining<=0)throw Error('Configured authority acquisition expired');
    let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
    const abort=()=>controller.abort();limits.signal?.addEventListener('abort',abort,{once:true});
    try{
      const canceled=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('Configured authority acquisition canceled')),{once:true});timer=setTimeout(()=>controller.abort(),remaining);});
      const result=await Promise.race([Promise.resolve().then(()=>rpc(method,params,controller.signal)),canceled]);
      if(controller.signal.aborted||limits.signal?.aborted||Date.now()>=deadline)throw Error('Configured authority acquisition expired');
      return result;
    }finally{clearTimeout(timer);limits.signal?.removeEventListener('abort',abort);controller.abort();}
  }
  if(await bounded('eth_chainId',[])!=='0x430c6')throw Error('Configured authority testnet chain required');
  for(const [target,name,type,expected] of CONFIGURED_AUTHORITY_GETTERS){
    const abi=parseAbi([`function ${name}() view returns (${type})`]);
    const data=hex.parse(await bounded('eth_call',[{to:target,data:encodeFunctionData({abi,functionName:name!})},at.number])) as Hex;
    if(data.length!==66)throw Error('Configured authority ABI word required');
    const value=decodeFunctionResult({abi,functionName:name!,data});
    if(encodeFunctionResult({abi,functionName:name!,result:value}).toLowerCase()!==data.toLowerCase())throw Error('Configured authority noncanonical ABI word');
    const normalized=type==='address'?z.string().regex(/^0x[a-fA-F0-9]{40}$/).parse(value).toLowerCase():type==='uint32'?String(z.number().int().min(0).max(4294967295).parse(value)):z.bigint().nonnegative().max(2n**256n-1n).parse(value).toString();
    if(normalized!==expected)throw Error(`Configured authority drift: ${name}`);
  }
  const final=block.parse(await bounded('eth_getBlockByNumber',[at.number,false]));
  if(final.number!==at.number||final.hash.toLowerCase()!==at.hash.toLowerCase()||final.timestamp!==at.timestamp)throw Error('Configured authority anchor changed');
  const evidence={...configuredAuthorityPair(),observedAt:new Date(acquiredAt),blockNumber:BigInt(at.number),blockHash:at.hash.toLowerCase(),blockTimestamp:BigInt(at.timestamp),observationPolicy};
  if(limits.signal?.aborted||Date.now()>=deadline)throw Error('Configured authority acquisition expired');
  assertConfiguredAuthorityEvidence(evidence);return evidence;
}
