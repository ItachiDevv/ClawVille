import {assertConfiguredAuthorityEvidence} from './configured-authority';
import { createHash } from 'node:crypto';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { BRAINCHAIN_CONTRACTS } from './contracts';
import { TESTNET_SIGNER_CODE_EVIDENCE } from './signer-code-evidence';
import {workerObservationFresh,observationPolicyOf,type WorkerObservationPolicy} from './worker-observation-policy';

/** Pure intent preparation only. This module has no key, wallet client, RPC send, or activation path. */
const uint128=z.string().regex(/^(0|[1-9]\d{0,38})$/).refine(value=>BigInt(value)<2n**128n);
const positive128=uint128.refine(value=>BigInt(value)>0n);
export const signerRequestSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('faucet')}).strict(),
  z.object({kind:z.literal('approve-stake'),amount:positive128}).strict(),
  z.object({kind:z.literal('approve-bond'),amount:positive128}).strict(),
  z.object({kind:z.literal('stake'),amount:positive128,price:uint128}).strict(),
  z.object({kind:z.literal('apply'),name:z.string().trim().min(1).max(60),about:z.string().trim().min(1).max(500)}).strict(),
  z.object({kind:z.literal('leave'),amount:positive128}).strict(),
  z.object({kind:z.literal('withdraw')}).strict(),
  z.object({kind:z.literal('submit'),resultId:z.string().uuid(),task:z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value=>BigInt(value)<2n**256n),hash:z.string().regex(/^0x[a-f0-9]{64}$/),uri:z.string().max(256)}).strict(),
]);
export type SignerRequest=z.infer<typeof signerRequestSchema>;
export const signerAbi=parseAbi([
  'function faucet()', 'function approve(address spender,uint256 amount) returns (bool)',
  'function stake(uint128 amount,uint128 price)', 'function requestUnstake(uint128 amount)', 'function withdraw()',
  'function propose(address target,bytes data,string uri) returns (uint256)', 'function setWorkerAllowed(address worker,bool allowed)',
  'function submit(uint256 id,bytes32 resultHash,string resultURI)',
]);
export class BrainChainSignerError extends Error { readonly code='signer_admission_refused'; }
export function assertSignerObservationPolicy(expected:string,state:Pick<SignerObservation,'observationPolicy'>){
  if(expected!==observationPolicyOf(state))throw new BrainChainSignerError('Persisted observation policy mismatch');
}
export type SignerObservation={
  environment:'testnet'|'mainnet';chainId:number;bindingAddress:string;signerAddress:string;
  observedAt:Date;blockTimestamp:bigint;blockHash:Hex;codeHashes:Record<string,Hex>;
  observationPolicy?:WorkerObservationPolicy;
  authorityPolicyVersion?:string;authorityPolicyDigest?:string;blockNumber?:bigint;
  brainBalance:bigint;gasBalance:bigint;staked:bigint;unstaking:bigint;unlocksAt:bigint;held:bigint;
  minStake:bigint;bond:bigint;stakingAllowance:bigint;bondAllowance:bigint;
  allowed:boolean;applicationPending:boolean;applicationVetoed:boolean;lastClaim:bigint;faucetInterval:bigint;
};
export type SignerIntent={chainId:274630;from:Address;to:Address;data:Hex;value:'0';kind:SignerRequest['kind'];requestHash:string};
export function signerRequestHash(input:SignerRequest){return createHash('sha256').update(JSON.stringify(signerRequestSchema.parse(input))).digest('hex');}
export function assertFreshTestnetObservation(state:SignerObservation,now=new Date()){
  if(state.environment!=='testnet'||state.chainId!==274630||state.signerAddress.toLowerCase()!==state.bindingAddress.toLowerCase()
    ||!/^0x[0-9a-fA-F]{40}$/.test(state.signerAddress)||/^0x0{40}$/i.test(state.signerAddress))throw new BrainChainSignerError('Dedicated testnet binding required');
  if(!workerObservationFresh(state,now))throw new BrainChainSignerError('Fresh chain evidence required');
}

/** No source-equivalent deployment artifacts are approved yet. A measured hash alone is insufficient. */
export const TESTNET_SIGNER_ARTIFACT_REVIEW={verified:false,sourceCommit:TESTNET_SIGNER_CODE_EVIDENCE.sourceCommit} as const;
export function assertSignerActivation():void {
  if(!TESTNET_SIGNER_ARTIFACT_REVIEW.verified)throw new BrainChainSignerError('Deployed artifact equivalence is not approved');
}
export function assertObservedSignerCode(state:SignerObservation){
  for(const [address,hash] of Object.entries(TESTNET_SIGNER_CODE_EVIDENCE.contracts)){
    if(state.codeHashes[address]?.toLowerCase()!==hash)throw new BrainChainSignerError('Pinned runtime code mismatch');
  }
}
export function assertSignerArtifactAdmission(state:SignerObservation):void {
  assertSignerActivation();
  assertObservedSignerCode(state);
  assertConfiguredAuthorityEvidence(state);
}

/** The authorization comes from durable owner approval, never from task text or a public request. */
export function prepareSignerIntent(input:unknown,state:SignerObservation,authorization:{requestHash:string;amount:bigint;price:bigint;gasCeilingWei:bigint},now=new Date()):SignerIntent {
  const request=signerRequestSchema.parse(input);
  assertFreshTestnetObservation(state,now);
  const requestHash=signerRequestHash(request);
  if(requestHash!==authorization.requestHash||authorization.gasCeilingWei<=0n||state.gasBalance<authorization.gasCeilingWei)throw new BrainChainSignerError('Intent or gas authority mismatch');
  const c=BRAINCHAIN_CONTRACTS.testnet.contracts;
  const from=state.signerAddress.toLowerCase() as Address;
  let to:Address,data:Hex;
  const amount='amount' in request?BigInt(request.amount):0n;
  switch(request.kind){
    case 'faucet':
      if(state.lastClaim!==0n&&state.blockTimestamp<state.lastClaim+state.faucetInterval)throw new BrainChainSignerError('Faucet cooldown');
      to=c.brain;data=encodeFunctionData({abi:signerAbi,functionName:'faucet'});break;
    case 'approve-stake':case 'approve-bond':{
      if(amount!==authorization.amount||(request.kind==='approve-bond'&&amount!==state.bond))throw new BrainChainSignerError('Allowance amount mismatch');
      to=c.brain;data=encodeFunctionData({abi:signerAbi,functionName:'approve',args:[request.kind==='approve-stake'?c.staking:c.bonds,amount]});break;
    }
    case 'stake':
      if(amount!==authorization.amount||BigInt(request.price)!==authorization.price||amount+state.staked<state.minStake||state.brainBalance<amount||state.stakingAllowance<amount)throw new BrainChainSignerError('Stake authority or balance mismatch');
      to=c.staking;data=encodeFunctionData({abi:signerAbi,functionName:'stake',args:[amount,BigInt(request.price)]});break;
    case 'apply':{
      if(state.allowed||state.applicationPending||state.applicationVetoed||authorization.amount!==state.bond||state.brainBalance<state.bond||state.bondAllowance<state.bond)throw new BrainChainSignerError('Application state or bond mismatch');
      const nested=encodeFunctionData({abi:signerAbi,functionName:'setWorkerAllowed',args:[from,true]});
      const uri=`data:application/json;base64,${Buffer.from(JSON.stringify({name:request.name,about:request.about}),'utf8').toString('base64')}`;
      to=c.bonds;data=encodeFunctionData({abi:signerAbi,functionName:'propose',args:[c.board,nested,uri]});break;
    }
    case 'leave':
      if(amount!==authorization.amount||amount!==state.staked)throw new BrainChainSignerError('Drain amount mismatch');
      to=c.staking;data=encodeFunctionData({abi:signerAbi,functionName:'requestUnstake',args:[amount]});break;
    case 'withdraw':
      if(state.unstaking<=0n||state.held!==0n||state.blockTimestamp<state.unlocksAt)throw new BrainChainSignerError('Stake remains locked');
      to=c.staking;data=encodeFunctionData({abi:signerAbi,functionName:'withdraw'});break;
    case 'submit':
      if(authorization.amount!==0n||request.uri!==`https://brain.testnet.usebrainchain.com/records/${request.hash}.txt`)throw new BrainChainSignerError('Submit result authority mismatch');
      to=c.board;data=encodeFunctionData({abi:signerAbi,functionName:'submit',args:[BigInt(request.task),request.hash as Hex,request.uri]});break;
  }
  return {chainId:274630,from,to,data,value:'0',kind:request.kind,requestHash};
}

export function assertPreparedIntentMatches(expected:SignerIntent,actual:unknown){
  const schema=z.object({chainId:z.literal(274630),from:z.string(),to:z.string(),data:z.string(),value:z.literal('0'),kind:z.string(),requestHash:z.string()}).strict();
  const value=schema.parse(actual);
  if(JSON.stringify(value)!==JSON.stringify(expected))throw new BrainChainSignerError('Prepared transaction changed');
}
