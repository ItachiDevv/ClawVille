import {createHash} from 'node:crypto';
import {recoverMessageAddress,type Hex} from 'viem';
import {z} from 'zod';
import {BRAINCHAIN_CONTRACTS} from './contracts';
import {resultUploadMessage} from './result-signing-message';
import {BrainChainSignerError} from './signer-policy';

export const resultSignatureIntentSchema=z.object({
  domain:z.literal('brainchain-result-v2'),chainId:z.literal(274630),resultId:z.string().uuid(),
  board:z.literal(BRAINCHAIN_CONTRACTS.testnet.contracts.board),task:z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
  hash:z.string().regex(/^0x[a-f0-9]{64}$/),worker:z.string().regex(/^0x[a-f0-9]{40}$/),
}).strict();
export type ResultSignatureIntent=z.infer<typeof resultSignatureIntentSchema>;
export function freezeResultSignatureIntent(value:unknown){
  const intent=resultSignatureIntentSchema.parse(value);resultUploadMessage(intent.board,intent.task,intent.hash);return Object.freeze(intent);
}
export function resultSignatureClaimHash(reference:string,intent:ResultSignatureIntent){
  return createHash('sha256').update(JSON.stringify({domain:'brainchain-result-signature-v2',reference,intent:freezeResultSignatureIntent(intent)})).digest('hex');
}
export async function verifyResultSignature(signature:Hex,intent:ResultSignatureIntent){
  if(!/^0x[a-fA-F0-9]{130}$/.test(signature)||(await recoverMessageAddress({message:resultUploadMessage(intent.board,intent.task,intent.hash),signature})).toLowerCase()!==intent.worker)
    throw new BrainChainSignerError('Result signature differs from frozen worker intent');
}
/** Trusted process callback must reload current database authority. It is never supplied over HTTP. */
export type CurrentResultAuthority=()=>Promise<void>;
export interface DedicatedResultSignerDriver{
  signResult(operationId:string,reference:string,intent:ResultSignatureIntent,assertCurrent:CurrentResultAuthority):Promise<Hex>;
}
