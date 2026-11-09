import {z} from 'zod';
import {encodeFunctionData,type Hex} from 'viem';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {signerAbi,signerRequestSchema} from './signer-policy';
import {exactRecoveryPayloadHash,ExactRecoveryError} from './exact-result-recovery-consent';
import type {FrozenSignerTransaction} from './signer-service';

const uint=z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value=>BigInt(value)<2n**256n);
const address=z.string().regex(/^0x[a-f0-9]{40}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const exactCaptureIntentSchema=z.object({version:z.literal(1),operationId:z.string().uuid(),resultId:z.string().uuid(),workerId:z.string().uuid(),avatarId:z.string().uuid(),
  chainId:z.literal(274630),signer:address,generation:z.number().int().positive(),operationHash:hash,authorityId:z.string().uuid(),gasAuthorityId:z.string().uuid(),
  to:address,data:z.string().regex(/^0x(?:[a-f0-9]{2})+$/).max(16384),value:z.literal('0'),nonce:uint,gas:uint,maxFeePerGas:uint,maxPriorityFeePerGas:uint,
  task:uint,resultHash:z.string().regex(/^0x[a-f0-9]{64}$/),resultUri:z.string().max(256)}).strict();
export type ExactCaptureIntent=z.infer<typeof exactCaptureIntentSchema>;
/** No asynchronous work or caller-owned transaction reference survives this snapshot. */
export function freezeExactCaptureIntent(raw:unknown){
  const intent=exactCaptureIntentSchema.parse(raw);
  const request=signerRequestSchema.parse({kind:'submit',resultId:intent.resultId,task:intent.task,hash:intent.resultHash,uri:intent.resultUri});
  if(request.kind!=='submit'||intent.to!==BRAINCHAIN_CONTRACTS.testnet.contracts.board||intent.resultUri!==`https://brain.testnet.usebrainchain.com/records/${intent.resultHash}.txt`
    ||intent.data!==encodeFunctionData({abi:signerAbi,functionName:'submit',args:[BigInt(intent.task),intent.resultHash as Hex,intent.resultUri]})
    ||BigInt(intent.nonce)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(intent.gas)===0n||BigInt(intent.maxFeePerGas)===0n
    ||BigInt(intent.maxPriorityFeePerGas)>BigInt(intent.maxFeePerGas)||BigInt(intent.gas)*BigInt(intent.maxFeePerGas)>=2n**256n)
    throw new ExactRecoveryError('Exact retained submit transaction required');
  return Object.freeze(intent);
}
export function exactCaptureTransaction(raw:unknown):Readonly<FrozenSignerTransaction>{
  const intent=freezeExactCaptureIntent(raw);
  return Object.freeze({chainId:274630,type:'eip1559',to:intent.to as Hex,data:intent.data as Hex,value:0n,nonce:Number(intent.nonce),
    gas:BigInt(intent.gas),maxFeePerGas:BigInt(intent.maxFeePerGas),maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas)});
}
export const exactCaptureHash=(raw:unknown)=>exactRecoveryPayloadHash(freezeExactCaptureIntent(raw));
