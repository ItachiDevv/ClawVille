import {assertPersistedConfiguredAuthority,observeConfiguredAuthority,createConfiguredAuthorityReader,type ConfiguredAuthorityReader} from './configured-authority-reader';
import {assertConfiguredAuthorityEvidence} from './configured-authority';
import {and,brainchainSignerAuthorities as authorities,brainchainSignerOperations as operations,brainchainSignerStreams as streams,db,eq,sql} from '@clawville/database';
import {keccak256,parseTransaction,recoverTransactionAddress,type Hex} from 'viem';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {FixedTestnetTransport} from './signer-rpc';
import {reserveSignerNonce} from './signer-operations';
import {assertSubmitResult,assertExactSubmitKeyAuthority} from './result-signing-submit';
import type {DeliveryRecovery,DeliveryLeaseProof} from './delivery-recovery';
import {assertFreshTestnetObservation,assertPreparedIntentMatches,assertSignerArtifactAdmission,BrainChainSignerError,prepareSignerIntent,signerRequestHash,signerRequestSchema,type SignerObservation} from './signer-policy';
import {assertSignerObservationPolicy} from './signer-policy';

export type FrozenSignerTransaction={chainId:274630;type:'eip1559';to:Hex;data:Hex;value:0n;nonce:number;gas:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint};
/** Supplied only inside the isolated signer process. Neither HTTP nor cognition can provide this driver. */
export interface DedicatedSignerDriver {
  addressForReference(reference:string):Promise<string>;
  signTransaction(operationId:string,reference:string,transaction:FrozenSignerTransaction,authority?:{result?:Extract<import('./signer-policy').SignerRequest,{kind:'submit'}>;assertCurrent:()=>Promise<void>}):Promise<Hex>;
}
/** Implementation must use protected signer storage. Application DB and logs store only this opaque content reference. */
export interface ProtectedSignedPayloadStore {
  putIfAbsent(operationId:string,bytes:Hex):Promise<string>;
  get(reference:string):Promise<Hex>;
  findByOperation(operationId:string):Promise<{reference:string;bytes:Hex}|null>;
  claimKeyUse(operationId:string,intentHash:string):Promise<boolean>;
}
async function bounded<T>(work:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BrainChainSignerError('Signer operation deadline')),5000);})]);}
  finally{clearTimeout(timer);}
}
export async function verifyFrozenTransaction(bytes:Hex,expected:FrozenSignerTransaction,address:string){
  if(!/^0x02[0-9a-fA-F]{2,16382}$/.test(bytes)||bytes.length%2!==0)throw new BrainChainSignerError('Invalid signed payload');
  const decoded=parseTransaction(bytes);
  if(decoded.type!=='eip1559'||decoded.chainId!==274630||decoded.to?.toLowerCase()!==expected.to.toLowerCase()
    ||(decoded.data??'0x')!==expected.data||(decoded.value??0n)!==0n||decoded.nonce!==expected.nonce||decoded.gas!==expected.gas
    ||decoded.maxFeePerGas!==expected.maxFeePerGas||decoded.maxPriorityFeePerGas!==expected.maxPriorityFeePerGas
    ||(decoded.accessList?.length??0)!==0||(await recoverTransactionAddress({serializedTransaction:bytes as `0x02${string}`})).toLowerCase()!==address.toLowerCase())
    throw new BrainChainSignerError('Signed transaction differs from frozen intent');
  return keccak256(bytes);
}

/** Commit acceptance before key use. Ambiguous key use never triggers another automatic signature. */
export async function captureSignerOperation(input:{operationId:string;observation:SignerObservation;nonces:{canonical:bigint;pending:bigint};driver:DedicatedSignerDriver;store:ProtectedSignedPayloadStore;authorityReader?:ConfiguredAuthorityReader}){
  assertFreshTestnetObservation(input.observation);
  assertSignerArtifactAdmission(input.observation); // Fail closed until independent source/deployment equivalence is approved.
  const [captured]=await db.select().from(operations).where(eq(operations.id,input.operationId));
  if(captured?.acceptedAt){
    if(captured.environment!=='testnet'||captured.chainId!==274630||captured.signerAddress!==input.observation.signerAddress.toLowerCase())throw new BrainChainSignerError('Accepted signer owner mismatch');
    return recoverCapturedOperation(input.operationId,input.store);
  }
  const reserved=await reserveSignerNonce(input.operationId,input.observation,input.nonces);
  const accepted=await db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-signer:${reserved.bindingId}`},0))`);
    const [stream]=await tx.select().from(streams).where(eq(streams.bindingId,reserved.bindingId)).for('update');
    if(!stream||stream.stopped)throw new BrainChainSignerError('Signer is stopped');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-nonce:274630:${stream.signerAddress}`},0))`);
    const [operation]=await tx.select().from(operations).where(and(eq(operations.id,input.operationId),eq(operations.generation,stream.generation),
      eq(operations.state,'reserved'),sql`${operations.expiresAt}>clock_timestamp()`)).for('update');
    if(!operation||operation.nonce===null)throw new BrainChainSignerError('Signing fence expired');
    assertPersistedConfiguredAuthority(operation);assertSignerObservationPolicy(operation.observationPolicy,input.observation);
    const granted=await tx.select().from(authorities).where(and(sql`${authorities.id} IN (${operation.authorityId}::uuid,${operation.gasAuthorityId}::uuid)`,
      eq(authorities.bindingId,stream.bindingId),eq(authorities.generation,stream.generation),sql`${authorities.revokedAt} IS NULL AND ${authorities.expiresAt}>clock_timestamp()`)).for('update');
    const intentAuthority=granted.find(value=>value.id===operation.authorityId),gasAuthority=granted.find(value=>value.id===operation.gasAuthorityId);
    if(!intentAuthority||!gasAuthority||intentAuthority.purpose!==operation.kind||gasAuthority.purpose!=='gas')throw new BrainChainSignerError('Signing authority expired');
    assertFreshTestnetObservation(input.observation);assertSignerArtifactAdmission(input.observation);
    const stored=z.object({request:signerRequestSchema,transaction:z.unknown()}).strict().parse(operation.intent);
    await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,input.observation,operation.id);
    const hash=signerRequestHash(stored.request);
    if(hash!==intentAuthority.requestHash||hash!==gasAuthority.requestHash)throw new BrainChainSignerError('Authority intent mismatch');
    const rebuilt=prepareSignerIntent(stored.request,input.observation,{requestHash:hash,amount:BigInt(intentAuthority.maxAtomic),price:'price' in stored.request?BigInt(stored.request.price):0n,gasCeilingWei:BigInt(gasAuthority.maxAtomic)});
    assertPreparedIntentMatches(rebuilt,stored.transaction);
    const nonce=BigInt(operation.nonce);
    if(nonce>BigInt(Number.MAX_SAFE_INTEGER))throw new BrainChainSignerError('Nonce exceeds signer integer range');
    const transaction:FrozenSignerTransaction={chainId:274630,type:'eip1559',to:rebuilt.to,data:rebuilt.data,value:0n,nonce:Number(nonce),
      gas:BigInt(operation.gasLimit),maxFeePerGas:BigInt(operation.maxFeePerGas),maxPriorityFeePerGas:BigInt(operation.maxPriorityFeePerGas)};
    if(transaction.gas*transaction.maxFeePerGas>BigInt(gasAuthority.maxAtomic))throw new BrainChainSignerError('Gas ceiling exceeded');
    if((await bounded(input.driver.addressForReference(stream.signerRef))).toLowerCase()!==stream.signerAddress)throw new BrainChainSignerError('Key reference address mismatch');
    assertFreshTestnetObservation(input.observation);
    const [acceptance]=await tx.execute<{accepted_at:Date|string}>(sql`SELECT clock_timestamp() AS accepted_at WHERE ${operation.expiresAt.toISOString()}::timestamptz>clock_timestamp()
      AND ${intentAuthority.expiresAt.toISOString()}::timestamptz>clock_timestamp() AND ${gasAuthority.expiresAt.toISOString()}::timestamptz>clock_timestamp()`);
    if(!acceptance)throw new BrainChainSignerError('Signing authority expired before key use');
    await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,input.observation,operation.id);
    // Commit this irreversible admission before the driver sees the operation. Never roll it back after key use.
    await tx.update(operations).set({state:'accepting',acceptedAt:new Date(acceptance.accepted_at),updatedAt:sql`clock_timestamp()`}).where(eq(operations.id,operation.id));
    await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,input.observation,operation.id);
    return{operationId:operation.id,reference:stream.signerRef,address:stream.signerAddress,transaction,request:stored.request};
  });
  try{
    const keyUseHash=createHash('sha256').update(JSON.stringify({reference:accepted.reference,transaction:accepted.transaction},(_key,value)=>typeof value==='bigint'?value.toString():value)).digest('hex');
    if(!await bounded(input.store.claimKeyUse(accepted.operationId,keyUseHash)))return await recoverCapturedOperation(accepted.operationId,input.store);
    const authority={...(accepted.request.kind==='submit'?{result:accepted.request}:{}),assertCurrent:()=>assertCurrentSignerOperation(accepted.operationId,input.observation,undefined,input.authorityReader)};
    await authority.assertCurrent();
    const bytes=await bounded(input.driver.signTransaction(accepted.operationId,accepted.reference,accepted.transaction,authority));
    await verifyFrozenTransaction(bytes,accepted.transaction,accepted.address);
    const reference=await bounded(input.store.putIfAbsent(accepted.operationId,bytes));
    if(!/^[a-f0-9]{64}$/.test(reference)||(await bounded(input.store.get(reference)))!==bytes)throw new BrainChainSignerError('Signed payload persistence failed');
    return await recoverCapturedOperation(accepted.operationId,input.store);
  }catch{
    await db.update(operations).set({state:'uncertain',updatedAt:sql`clock_timestamp()`}).where(and(eq(operations.id,accepted.operationId),eq(operations.state,'accepting')));
    return{operationId:accepted.operationId,transactionHash:null,state:'uncertain' as const};
  }
}

/** Reloads revocation, stream generation, execution lease, and frozen result after signer-side asynchronous work. */
export async function assertCurrentSubmitOperation(operationId:string,observation:SignerObservation,authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){
  return assertCurrentSignerOperation(operationId,observation,'submit',authorityReader);
}
export async function assertCurrentSignerOperation(operationId:string,observation:SignerObservation,expectedKind?:'submit',authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){
  assertFreshTestnetObservation(observation);assertSignerArtifactAdmission(observation);
  await db.transaction(async tx=>{
    const [operation]=await tx.select().from(operations).where(eq(operations.id,operationId));
    if(!operation||(expectedKind&&operation.kind!==expectedKind)||!['accepting','uncertain','signed','broadcast'].includes(operation.state))throw new BrainChainSignerError('No current signer acceptance');
    assertPersistedConfiguredAuthority(operation);assertSignerObservationPolicy(operation.observationPolicy,observation);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-signer:${operation.bindingId}`},0))`);
    const [stream]=await tx.select().from(streams).where(eq(streams.bindingId,operation.bindingId)).for('update');
    if(!stream||stream.stopped||stream.generation!==operation.generation)throw new BrainChainSignerError('Submit signer generation changed');
    const [worker]=await tx.execute(sql`SELECT requested_state FROM brainchain_worker_bindings WHERE id=${operation.bindingId} AND avatar_id=${operation.avatarId} AND address=${stream.signerAddress} FOR UPDATE`);
    if(!worker)throw new BrainChainSignerError('Worker signing owner changed');
    if(!['running','draining'].includes(String(worker.requested_state)))await assertExactSubmitKeyAuthority(tx,operation.id);
    if(worker.requested_state==='draining'&&operation.kind!=='submit'&&!operation.signedPayloadRef)throw new BrainChainSignerError('Drain refuses new lifecycle key use');
    const live=await tx.select().from(authorities).where(and(sql`${authorities.id} IN (${operation.authorityId}::uuid,${operation.gasAuthorityId}::uuid)`,sql`${authorities.revokedAt} IS NULL AND ${authorities.expiresAt}>clock_timestamp()`)).for('update');
    if(live.length!==2)throw new BrainChainSignerError('Submit authority revoked or expired');
    const stored=z.object({request:signerRequestSchema}).passthrough().parse(operation.intent);
    await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,observation,operation.id);
    for(const grant of live)assertPersistedConfiguredAuthority(grant);
    assertConfiguredAuthorityEvidence(await observeConfiguredAuthority(authorityReader,{deadlineMs:Math.min(Date.now()+2000,operation.expiresAt.getTime(),...live.map(grant=>grant.expiresAt.getTime())),observationPolicy:observation.observationPolicy}));
    await assertSubmitResult(tx,stored.request,operation.avatarId,operation.bindingId,observation,operation.id);
    const [alive]=await tx.execute(sql`SELECT 1 WHERE ${operation.expiresAt.toISOString()}::timestamptz>clock_timestamp()
      AND ${live[0]!.expiresAt.toISOString()}::timestamptz>clock_timestamp() AND ${live[1]!.expiresAt.toISOString()}::timestamptz>clock_timestamp()`);
    if(!alive)throw new BrainChainSignerError('Submit authority expired after locks');
  });
}

/** Read recovery never calls a key. A missing payload leaves durable uncertainty and blocks nonce reuse. */
export async function recoverCapturedOperation(operationId:string,store:ProtectedSignedPayloadStore){
  const [operation]=await db.select().from(operations).where(eq(operations.id,operationId));
  if(!operation||!operation.acceptedAt||operation.nonce===null||operation.environment!=='testnet'||operation.chainId!==274630)throw new BrainChainSignerError('No durable signing acceptance');
  if(operation.signedPayloadRef&&operation.transactionHash)return{operationId,transactionHash:operation.transactionHash,nonce:operation.nonce,state:operation.state};
  if(!['accepting','uncertain'].includes(operation.state))throw new BrainChainSignerError('Invalid capture recovery state');
  if(BigInt(operation.nonce)>BigInt(Number.MAX_SAFE_INTEGER))throw new BrainChainSignerError('Nonce exceeds signer integer range');
  const recovered=await bounded(store.findByOperation(operationId));
  if(!recovered){
    await db.update(operations).set({state:'uncertain',updatedAt:sql`clock_timestamp()`}).where(and(eq(operations.id,operationId),eq(operations.state,'accepting')));
    return{operationId,transactionHash:null,nonce:operation.nonce,state:'uncertain' as const};
  }
  const stored=z.object({transaction:z.object({to:z.string().regex(/^0x[a-fA-F0-9]{40}$/),data:z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/),chainId:z.literal(274630),value:z.literal('0')}).passthrough()}).passthrough().parse(operation.intent);
  const expected:FrozenSignerTransaction={chainId:274630,type:'eip1559',to:stored.transaction.to as Hex,data:stored.transaction.data as Hex,value:0n,
    nonce:Number(operation.nonce),gas:BigInt(operation.gasLimit),maxFeePerGas:BigInt(operation.maxFeePerGas),maxPriorityFeePerGas:BigInt(operation.maxPriorityFeePerGas)};
  const transactionHash=await verifyFrozenTransaction(recovered.bytes,expected,operation.signerAddress);
  if(!/^[a-f0-9]{64}$/.test(recovered.reference)||(await bounded(store.get(recovered.reference)))!==recovered.bytes)throw new BrainChainSignerError('Protected recovery readback mismatch');
  await db.update(operations).set({state:'signed',signedPayloadRef:recovered.reference,transactionHash,updatedAt:sql`clock_timestamp()`})
    .where(and(eq(operations.id,operationId),sql`${operations.state} IN ('accepting','uncertain')`,sql`${operations.signedPayloadRef} IS NULL`));
  return{operationId,transactionHash,nonce:operation.nonce,state:'signed' as const};
}

export interface TestnetBroadcastTransport {
  /** Must query fixed testnet RPC and confirm exact chain ID. It must never accept an RPC URL argument. */
  assertTestnet():Promise<void>;
  broadcastSameBytes(bytes:Hex,assertCurrent?:()=>Promise<void>):Promise<Hex>;
}
/** Replay only the original accepted bytes. Timeout retains nonce and gas liabilities; no replacement or cancellation exists. */
export async function broadcastCapturedOperation(operationId:string,observation:SignerObservation,store:ProtectedSignedPayloadStore,transport:TestnetBroadcastTransport,delivery?:{recovery:DeliveryRecovery;avatarId:string;resultId:string;proof:DeliveryLeaseProof},authorityReader:ConfiguredAuthorityReader=createConfiguredAuthorityReader()){
  // Artifact admission stays mandatory for broadcast too; no accepted row can bypass the deployment review.
  assertFreshTestnetObservation(observation);assertSignerArtifactAdmission(observation);
  const [reference]=await db.select().from(operations).where(eq(operations.id,operationId));
  if(!reference||reference.environment!=='testnet'||reference.chainId!==274630||!reference.signedPayloadRef||!reference.transactionHash||reference.nonce===null
    ||!['signed','uncertain','broadcast'].includes(reference.state))throw new BrainChainSignerError('No accepted transaction');
  const bytes=await bounded(store.get(reference.signedPayloadRef));
  assertSignerObservationPolicy(reference.observationPolicy,observation);
  if(keccak256(bytes)!==reference.transactionHash)throw new BrainChainSignerError('Protected payload hash mismatch');
  const submitFence=async()=>{
    if(reference.kind!=='submit'){await assertCurrentSignerOperation(operationId,observation,undefined,authorityReader);return false;}
    if(!delivery){await assertCurrentSubmitOperation(operationId,observation,authorityReader);return false;}
    if(delivery.avatarId!==reference.avatarId)throw new BrainChainSignerError('Broadcast recovery owner mismatch');
    const evidence=await delivery.recovery.checkBroadcast(delivery.avatarId,delivery.resultId,delivery.proof,operationId);
    if(evidence.alreadySubmitted){await delivery.recovery.reconcileSubmitted(delivery.avatarId,delivery.resultId,delivery.proof);return true;}
    return false;
  };
  if(await submitFence())return{operationId,transactionHash:reference.transactionHash,state:'submitted-observed' as const};
  await bounded(transport.assertTestnet());
  if(await submitFence())return{operationId,transactionHash:reference.transactionHash,state:'submitted-observed' as const};
  const changed=await db.update(operations).set({state:'uncertain',updatedAt:sql`clock_timestamp()`})
    .where(and(eq(operations.id,operationId),sql`${operations.state} IN ('signed','uncertain','broadcast')`)).returning({id:operations.id});
  if(changed.length!==1)throw new BrainChainSignerError('Transaction reconciliation state changed');
  try{
    if(await submitFence())return{operationId,transactionHash:reference.transactionHash,state:'submitted-observed' as const};
    const returnedHash=await bounded(transport.broadcastSameBytes(bytes,async()=>{if(await submitFence())throw new BrainChainSignerError('Submission already observed');}));
    if(returnedHash.toLowerCase()!==reference.transactionHash)throw new BrainChainSignerError('Broadcast hash mismatch');
    await db.update(operations).set({state:'broadcast',updatedAt:sql`clock_timestamp()`}).where(and(eq(operations.id,operationId),eq(operations.state,'uncertain')));
    return{operationId,transactionHash:reference.transactionHash,state:'broadcast' as const};
  }catch{
    return{operationId,transactionHash:reference.transactionHash,state:'uncertain' as const};
  }
}

/** Inclusion is provisional. Missing or orphaned receipts retain the nonce and captured bytes. */
export async function observeSignerReceipt(operationId:string,transport:Pick<FixedTestnetTransport,'receipt'>){
  const [operation]=await db.select().from(operations).where(eq(operations.id,operationId));
  if(!operation||operation.environment!=='testnet'||operation.chainId!==274630||!operation.transactionHash||!operation.signedPayloadRef)
    throw new BrainChainSignerError('No captured testnet operation');
  const observation=z.object({state:z.enum(['pending','orphaned','included']),transactionHash:z.string().regex(/^0x[a-f0-9]{64}$/),observedAt:z.string().datetime(),provisional:z.literal(true),
    blockNumber:z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),blockHash:z.string().regex(/^0x[a-f0-9]{64}$/).optional(),successful:z.boolean().optional(),confirmations:z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),gasUsed:z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),effectiveGasPrice:z.string().regex(/^(0|[1-9][0-9]*)$/).optional()}).strict().parse(await transport.receipt(operation.transactionHash as Hex));
  if(observation.transactionHash.toLowerCase()!==operation.transactionHash)throw new BrainChainSignerError('Receipt owner mismatch');
  if(observation.state==='included'&&(!observation.blockNumber||!observation.blockHash||observation.successful===undefined||!observation.gasUsed||!observation.effectiveGasPrice))throw new BrainChainSignerError('Incomplete included receipt');
  const progressionAllowed=await db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-signer:${operation.bindingId}`},0))`);
    const [stream]=await tx.select().from(streams).where(eq(streams.bindingId,operation.bindingId)).for('update');
    const [current]=await tx.select().from(operations).where(eq(operations.id,operationId)).for('update');
    if(!current||current.transactionHash!==observation.transactionHash||current.generation!==operation.generation||!current.signedPayloadRef)throw new BrainChainSignerError('Receipt operation changed');
    const [clock]=await tx.execute<{now:string|Date}>(sql`SELECT clock_timestamp() AS now`);
    const age=new Date(clock!.now).getTime()-Date.parse(observation.observedAt);
    if(age<0||age>30000)throw new BrainChainSignerError('Receipt observation expired after locks');
    const evidence={...observation};const {observedAt:_time,confirmations:_count,...identity}=evidence;
    const evidenceHash=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    await tx.execute(sql`INSERT INTO brainchain_signer_receipt_observations(operation_id,generation,transaction_hash,evidence_hash,evidence,state,observed_at)
      VALUES(${operationId}::uuid,${current.generation},${current.transactionHash},${evidenceHash},${JSON.stringify(evidence)}::jsonb,${observation.state},${observation.observedAt}::timestamptz) ON CONFLICT(operation_id,evidence_hash) DO NOTHING`);
    const [previous]=await tx.execute<{evidence:Record<string,unknown>}>(sql`SELECT evidence FROM brainchain_signer_receipt_observations WHERE operation_id=${operationId}::uuid AND state='included' AND evidence_hash<>${evidenceHash} ORDER BY created_at DESC LIMIT 1`);
    const changedInclusion=observation.state==='included'&&previous&&
      (['blockNumber','blockHash','successful','gasUsed','effectiveGasPrice'] as const).some(key=>previous.evidence[key]!==observation[key]);
    if(changedInclusion){
      if(stream&&!stream.stopped)await tx.update(streams).set({stopped:true,generation:stream.generation+1}).where(eq(streams.bindingId,current.bindingId));
      await tx.update(operations).set({state:'uncertain',updatedAt:sql`clock_timestamp()`}).where(eq(operations.id,operationId));return false;
    }
    if(observation.state==='included'&&stream&&!stream.stopped&&stream.generation===current.generation){
      // "confirmed" means a provisional canonical receipt consumed this nonce, never parent-chain finality.
      await tx.update(operations).set({state:'confirmed',updatedAt:sql`clock_timestamp()`}).where(and(eq(operations.id,operationId),sql`${operations.state} IN ('signed','broadcast','uncertain','confirmed')`));
      return observation.successful===true;
    }else if(observation.state!=='included'){
      if(current.state==='confirmed'&&stream&&!stream.stopped)await tx.update(streams).set({stopped:true,generation:stream.generation+1}).where(eq(streams.bindingId,current.bindingId));
      await tx.update(operations).set({state:'uncertain',updatedAt:sql`clock_timestamp()`}).where(and(eq(operations.id,operationId),sql`${operations.state} IN ('signed','broadcast','confirmed')`));
    }
    return false;
  });
  return{operationId,...observation,progressionAllowed,finalized:false as const};
}
