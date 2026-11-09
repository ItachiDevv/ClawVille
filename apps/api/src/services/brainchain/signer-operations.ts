import {assertConfiguredAuthorityEvidence} from './configured-authority';
import {assertPersistedConfiguredAuthority} from './configured-authority-reader';
import {createHash} from 'node:crypto';
import {and,brainchainSignerAuthorities as authorities,brainchainSignerOperations as operations,brainchainSignerStreams as streams,brainchainWorkerBindings as bindings,db,eq,sql} from '@clawville/database';
import {z} from 'zod';
import {BrainChainSignerError,assertFreshTestnetObservation,assertPreparedIntentMatches,prepareSignerIntent,signerRequestSchema,type SignerObservation} from './signer-policy';
import {assertSubmitResult} from './result-signing-submit';
import type {DeliveryLeaseProof} from './delivery-recovery';
import {assertSignerObservationPolicy} from './signer-policy';

type Transaction=Parameters<Parameters<typeof db.transaction>[0]>[0];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const feesSchema=z.object({gasLimit:z.bigint().positive(),maxFeePerGas:z.bigint().positive(),maxPriorityFeePerGas:z.bigint().nonnegative()}).strict()
  .refine(value=>value.maxPriorityFeePerGas<=value.maxFeePerGas&&value.gasLimit*value.maxFeePerGas<2n**256n);
async function lockBinding(tx:Transaction,bindingId:string){await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-signer:${bindingId}`},0))`);}
async function loadStream(tx:Transaction,bindingId:string){
  const [stream]=await tx.select().from(streams).where(eq(streams.bindingId,bindingId)).for('update');
  if(!stream||stream.stopped||stream.environment!=='testnet'||stream.chainId!==274630)throw new BrainChainSignerError('Dedicated signer is unavailable');
  return stream;
}
async function loadAuthority(tx:Transaction,id:string,stream:typeof streams.$inferSelect,purpose:string,requestHash:string){
  const [authority]=await tx.select().from(authorities).where(and(eq(authorities.id,id),eq(authorities.bindingId,stream.bindingId),
    eq(authorities.avatarId,stream.avatarId),eq(authorities.generation,stream.generation),eq(authorities.purpose,purpose),eq(authorities.requestHash,requestHash),
    sql`${authorities.revokedAt} IS NULL AND ${authorities.expiresAt}>clock_timestamp()`)).for('update');
  if(!authority)throw new BrainChainSignerError('Explicit unexpired authority required');
  assertPersistedConfiguredAuthority(authority);return authority;
}

/** Internal coordinator only. Existing binding is insufficient; separate owner-issued intent and gas rows must exist. */
export async function prepareSignerOperation(input:{avatarId:string;bindingId:string;authorityId:string;gasAuthorityId:string;idempotencyKey:string;request:unknown;fees:z.infer<typeof feesSchema>;deliveryProof?:DeliveryLeaseProof},observation:SignerObservation){
  z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/).parse(input.idempotencyKey);
  const request=signerRequestSchema.parse(input.request),fees=feesSchema.parse(input.fees);
  const deliveryProof=input.deliveryProof?z.object({leaseId:z.string().uuid(),leaseOwner:z.string().uuid()}).strict().parse(input.deliveryProof):undefined;
  const requestHash=digest(request);
  assertFreshTestnetObservation(observation);assertConfiguredAuthorityEvidence(observation);
  return db.transaction(async tx=>{
    await lockBinding(tx,input.bindingId);
    const [binding]=await tx.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.avatarId,input.avatarId)));
    if(!binding||binding.environment!=='testnet'||binding.chainId!==274630||binding.address!==observation.bindingAddress.toLowerCase())throw new BrainChainSignerError('Worker owner mismatch');
    const stream=await loadStream(tx,binding.id);
    await assertSubmitResult(tx,request,input.avatarId,input.bindingId,observation,undefined,deliveryProof,{authorityId:input.authorityId,gasAuthorityId:input.gasAuthorityId});
    const serializedFees={gasLimit:fees.gasLimit.toString(),maxFeePerGas:fees.maxFeePerGas.toString(),maxPriorityFeePerGas:fees.maxPriorityFeePerGas.toString()};
    const operationHash=digest({request,fees:serializedFees,authorityId:input.authorityId,gasAuthorityId:input.gasAuthorityId,...(deliveryProof?{deliveryProof}:{})});
    const [existing]=await tx.select().from(operations).where(and(eq(operations.bindingId,binding.id),eq(operations.kind,request.kind),eq(operations.idempotencyKey,input.idempotencyKey)));
    if(existing){assertPersistedConfiguredAuthority(existing);assertSignerObservationPolicy(existing.observationPolicy,observation);if(existing.requestHash!==operationHash)throw new BrainChainSignerError('Idempotency intent mismatch');return existing;}
    const authority=await loadAuthority(tx,input.authorityId,stream,request.kind,requestHash);
    const gasAuthority=await loadAuthority(tx,input.gasAuthorityId,stream,'gas',requestHash);
    assertSignerObservationPolicy(authority.observationPolicy,observation);assertSignerObservationPolicy(gasAuthority.observationPolicy,observation);
    const gasCeilingWei=BigInt(gasAuthority.maxAtomic);
    if(fees.gasLimit*fees.maxFeePerGas>gasCeilingWei)throw new BrainChainSignerError('Gas authorization exceeded');
    const intent=prepareSignerIntent(request,observation,{requestHash,amount:BigInt(authority.maxAtomic),price:'price' in request?BigInt(request.price):0n,gasCeilingWei});
    const expiresAt=authority.expiresAt<gasAuthority.expiresAt?authority.expiresAt:gasAuthority.expiresAt;
    const [operation]=await tx.insert(operations).values({bindingId:binding.id,avatarId:binding.avatarId,environment:'testnet',chainId:274630,signerAddress:binding.address,
      authorityId:authority.id,gasAuthorityId:gasAuthority.id,generation:stream.generation,kind:request.kind,idempotencyKey:input.idempotencyKey,requestHash:operationHash,
      authorityPolicyVersion:authority.authorityPolicyVersion,authorityPolicyDigest:authority.authorityPolicyDigest,intent:{request,transaction:intent},observationPolicy:authority.observationPolicy,...serializedFees,expiresAt,createdAt:sql`clock_timestamp()`,state:'prepared'}).returning();
    if(request.kind==='submit')await tx.execute(sql`INSERT INTO brainchain_result_submissions(result_id,operation_id,binding_id,avatar_id,environment,chain_id)
      VALUES(${request.resultId}::uuid,${operation!.id}::uuid,${binding.id}::uuid,${binding.avatarId}::uuid,'testnet',274630)`);
    if(request.kind==='submit'&&deliveryProof)await tx.execute(sql`INSERT INTO brainchain_delivery_submit_leases(operation_id,lease_id,result_id) VALUES(${operation!.id}::uuid,${deliveryProof.leaseId}::uuid,${request.resultId}::uuid)`);
    await assertSubmitResult(tx,request,input.avatarId,input.bindingId,observation,operation!.id,deliveryProof);
    return operation!;
  });
}

/** Internal signer bookkeeping. Reserving a nonce does not sign or broadcast anything. One unresolved nonce blocks the stream. */
export async function reserveSignerNonce(operationId:string,observation:SignerObservation,nonces:{canonical:bigint;pending:bigint}){
  assertFreshTestnetObservation(observation);assertConfiguredAuthorityEvidence(observation);
  if(nonces.canonical<0n||nonces.pending<nonces.canonical)throw new BrainChainSignerError('Invalid nonce observation');
  const [reference]=await db.select().from(operations).where(eq(operations.id,operationId));
  if(!reference)throw new BrainChainSignerError('Unknown operation');
  const result=await db.transaction(async tx=>{
    await lockBinding(tx,reference.bindingId);
    const stream=await loadStream(tx,reference.bindingId);
    // The fixed order is binding, task (future execution only), signer nonce stream, then operation.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-nonce:274630:${stream.signerAddress}`},0))`);
    const [operation]=await tx.select().from(operations).where(eq(operations.id,operationId)).for('update');
    if(!operation||operation.generation!==stream.generation||!['prepared','reserved'].includes(operation.state)
      ||stream.signerAddress!==observation.signerAddress.toLowerCase())throw new BrainChainSignerError('Operation fence is stale');
    const alive=await tx.execute(sql`SELECT id FROM brainchain_signer_operations WHERE id=${operationId}::uuid AND expires_at>clock_timestamp()`);
    if(!alive.length)throw new BrainChainSignerError('Operation authority expired');
    const stored=z.object({request:signerRequestSchema,transaction:z.unknown()}).strict().parse(operation.intent);
    await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,observation,operation.id);
    const requestHash=digest(stored.request);
    const authority=await loadAuthority(tx,operation.authorityId,stream,operation.kind,requestHash);
    const gasAuthority=await loadAuthority(tx,operation.gasAuthorityId,stream,'gas',requestHash);
    assertPersistedConfiguredAuthority(operation);assertSignerObservationPolicy(operation.observationPolicy,observation);assertSignerObservationPolicy(authority.observationPolicy,observation);assertSignerObservationPolicy(gasAuthority.observationPolicy,observation);
    const rebuilt=prepareSignerIntent(stored.request,observation,{requestHash,amount:BigInt(authority.maxAtomic),price:'price' in stored.request?BigInt(stored.request.price):0n,gasCeilingWei:BigInt(gasAuthority.maxAtomic)});
    assertPreparedIntentMatches(rebuilt,stored.transaction);
    const expected=BigInt(stream.nextNonce);
    if(operation.nonce!==null){
      if(nonces.canonical>BigInt(operation.nonce)||nonces.pending>BigInt(operation.nonce)){
        await tx.update(streams).set({stopped:true,generation:stream.generation+1}).where(eq(streams.bindingId,stream.bindingId));return null;
      }
      await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,observation,operation.id);
      return operation;
    }
    const outstanding=await tx.select({id:operations.id}).from(operations).where(and(eq(operations.bindingId,stream.bindingId),sql`${operations.nonce} IS NOT NULL AND ${operations.state}<>'confirmed'`));
    if(outstanding.length)throw new BrainChainSignerError('Prior nonce requires reconciliation');
    if(nonces.canonical!==expected||nonces.pending!==expected){
      await tx.update(streams).set({stopped:true,generation:stream.generation+1}).where(eq(streams.bindingId,stream.bindingId));return null;
    }
    if(expected>BigInt(Number.MAX_SAFE_INTEGER))throw new BrainChainSignerError('Nonce exceeds signer integer range');
    const [reserved]=await tx.update(operations).set({nonce:expected.toString(),state:'reserved',updatedAt:sql`clock_timestamp()`}).where(eq(operations.id,operation.id)).returning();
    await tx.update(streams).set({nextNonce:(expected+1n).toString()}).where(eq(streams.bindingId,stream.bindingId));
    await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,observation,operation.id);
    return reserved!;
  });
  if(!result)throw new BrainChainSignerError('External nonce change stopped signer');
  return result;
}

/** Revokes future admission only. Signed payloads and nonce ownership remain durable reconciliation liabilities. */
export async function stopSignerStream(bindingId:string){
  await db.transaction(async tx=>{await lockBinding(tx,bindingId);await tx.update(streams).set({stopped:true,generation:sql`${streams.generation}+1`}).where(eq(streams.bindingId,bindingId));});
}
