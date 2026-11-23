import type {TransactionSql} from 'postgres';
import {signerRequestSchema} from './signer-policy';
import {freezeExactCaptureIntent} from './exact-capture-policy';
import {ExactRecoveryError,type exactRecoverySnapshot} from './exact-result-recovery-consent';

/** Caller owns the stream/result locks from exactRecoverySnapshot. No owner proof is created here. */
export async function exactCaptureSnapshot(tx:TransactionSql,current:Awaited<ReturnType<typeof exactRecoverySnapshot>>,acceptedAuthorityId?:string){
 const {row,stream}=current;
 const [operation]=await tx`SELECT o.* FROM brainchain_result_submissions s JOIN brainchain_signer_operations o ON o.id=s.operation_id
 WHERE s.result_id=${row.id} AND o.binding_id=${row.binding_id} AND o.avatar_id=${row.avatar_id} FOR UPDATE OF o`;
 if(!operation||operation.kind!=='submit'||operation.environment!=='testnet'||operation.chain_id!==274630||operation.generation!==stream.generation
   ||operation.signer_address!==stream.signer_address||operation.signed_payload_ref||operation.transaction_hash)
   throw new ExactRecoveryError('Retained unsigned submit required');
 if(acceptedAuthorityId){
   const [accepted]=await tx`SELECT 1 FROM brainchain_exact_capture_acceptances WHERE operation_id=${operation.id} AND authority_id=${acceptedAuthorityId}`;
   if(!accepted||!operation.accepted_at||operation.state!=='accepting')throw new ExactRecoveryError('Exact capture acceptance unavailable');
 }else if(operation.accepted_at||!['prepared','reserved'].includes(operation.state))throw new ExactRecoveryError('Prior key acceptance is evidence-only');
 const revokedConsents=await tx`SELECT c.id FROM brainchain_exact_result_issuances i JOIN brainchain_exact_result_consents c ON c.id=i.consent_id WHERE (i.signer_authority_id=${operation.authority_id} OR i.gas_authority_id=${operation.gas_authority_id}) AND (c.revoked_at IS NOT NULL OR c.state='revoked')`;
 if(revokedConsents.length)throw new ExactRecoveryError('Original exact consent revocation lacks capture provenance');
 const stored=operation.intent,request=signerRequestSchema.parse(stored?.request);
 if(request.kind!=='submit'||request.resultId!==row.id||request.task!==String(row.external_task)||request.hash!==row.result_hash||request.uri!==row.result_uri
   ||stored.transaction?.from!==stream.signer_address||stored.transaction?.value!=='0'||stored.transaction?.chainId!==274630)
   throw new ExactRecoveryError('Retained submit differs from frozen result');
 const nonce=String(operation.nonce??stream.next_nonce);
 if(operation.nonce!==null&&BigInt(stream.next_nonce)!==BigInt(nonce)+1n)throw new ExactRecoveryError('Retained nonce stream changed');
 const intent=freezeExactCaptureIntent({version:1,operationId:operation.id,resultId:row.id,workerId:row.binding_id,avatarId:row.avatar_id,chainId:274630,
   signer:stream.signer_address,generation:stream.generation,operationHash:operation.request_hash,authorityId:operation.authority_id,gasAuthorityId:operation.gas_authority_id,
   to:stored.transaction.to,data:stored.transaction.data,value:'0',nonce,gas:String(operation.gas_limit),maxFeePerGas:String(operation.max_fee_per_gas),maxPriorityFeePerGas:String(operation.max_priority_fee_per_gas),
   task:request.task,resultHash:request.hash,resultUri:request.uri});
 return{intent,operation};
}
