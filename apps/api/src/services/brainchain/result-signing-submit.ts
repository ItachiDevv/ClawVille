import {db,sql} from '@clawville/database';
import {BrainChainSignerError,assertFreshTestnetObservation,type SignerObservation,type SignerRequest} from './signer-policy';
import type {DeliveryLeaseProof} from './delivery-recovery';
import {assertSignerObservationPolicy} from './signer-policy';
type Transaction=Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Exact new-operation lineage at the paused worker key boundary. Original grants stay independently required. */
export async function assertExactSubmitKeyAuthority(tx:Transaction,operationId:string){
  const [grant]=await tx.execute<{consent_id:string;result_id:string;delivery_authority_id:string}>(sql`SELECT c.id AS consent_id,r.id AS result_id,d.id AS delivery_authority_id
    FROM brainchain_signer_operations o JOIN brainchain_result_submissions rlink ON rlink.operation_id=o.id JOIN brainchain_task_results r ON r.id=rlink.result_id
    JOIN brainchain_delivery_submit_leases x ON x.operation_id=o.id JOIN brainchain_delivery_leases l ON l.id=x.lease_id
    JOIN brainchain_delivery_authorities d ON d.id=l.authority_id JOIN brainchain_exact_result_consents c ON c.id=d.exact_consent_id
    JOIN brainchain_exact_result_issuances i ON i.consent_id=c.id AND i.delivery_authority_id=d.id
    WHERE o.id=${operationId}::uuid AND o.kind='submit' AND i.stage='prepare-submit' AND i.signer_authority_id=o.authority_id AND i.gas_authority_id=o.gas_authority_id
    AND o.generation=(c.payload->>'signerGeneration')::integer AND o.gas_limit*o.max_fee_per_gas<=(c.payload->>'maxGasWei')::numeric
    AND d.revoked_at IS NULL AND d.consumed_at IS NOT NULL AND d.expires_at>clock_timestamp() AND l.expires_at>clock_timestamp()
    AND c.payload->>'observationPolicy'=o.observation_policy AND d.observation_policy=o.observation_policy
    AND brainchain_exact_recovery_consent(c.id,r.id,o.avatar_id,o.binding_id,'prepare-submit')=c.id`);
  if(!grant)throw new BrainChainSignerError('Paused submit requires exact owner consent and issuance');
  return grant;
}
/** Every preparation, nonce reservation, and first key-use acceptance invokes this same locked database fence. */
export async function assertSubmitResult(tx:Transaction,request:SignerRequest,avatarId:string,bindingId:string,observation:SignerObservation,operationId?:string,deliveryProof?:DeliveryLeaseProof,authorityIds?:{authorityId:string;gasAuthorityId:string}){
  if(request.kind!=='submit')return;
  if(operationId){
    const linked=await tx.execute(sql`SELECT 1 FROM brainchain_result_submissions WHERE result_id=${request.resultId}::uuid AND operation_id=${operationId}::uuid AND binding_id=${bindingId}::uuid AND avatar_id=${avatarId}::uuid`);
    if(linked.length!==1)throw new BrainChainSignerError('Submit operation lacks immutable result link');
  }
  assertFreshTestnetObservation(observation);
  // Authority IDs, not optional proof presence, determine the consent requirement.
  let ids=authorityIds,proof=deliveryProof;
  if(operationId){
    const [operation]=await tx.execute<{authority_id:string;gas_authority_id:string}>(sql`SELECT authority_id,gas_authority_id FROM brainchain_signer_operations WHERE id=${operationId}::uuid`);
    if(!operation)throw new BrainChainSignerError('Submit operation unavailable');
    ids={authorityId:operation.authority_id,gasAuthorityId:operation.gas_authority_id};
  }
  if(ids){
    const exact=await tx.execute<{consent_id:string;stage:string;signer_authority_id:string|null;gas_authority_id:string|null;delivery_authority_id:string}>(sql`SELECT consent_id,stage,signer_authority_id,gas_authority_id,delivery_authority_id FROM brainchain_exact_result_issuances
      WHERE signer_authority_id IN (${ids.authorityId}::uuid,${ids.gasAuthorityId}::uuid) OR gas_authority_id IN (${ids.authorityId}::uuid,${ids.gasAuthorityId}::uuid)`);
    if(exact.length){
      const issued=exact[0]!;
      if(exact.length!==1||issued.stage!=='prepare-submit'||issued.signer_authority_id!==ids.authorityId||issued.gas_authority_id!==ids.gasAuthorityId)throw new BrainChainSignerError('Exact submit authority pair differs from issuance');
      if(operationId){
        const [linked]=await tx.execute<{lease_id:string;lease_owner:string}>(sql`SELECT x.lease_id,l.lease_owner FROM brainchain_delivery_submit_leases x JOIN brainchain_delivery_leases l ON l.id=x.lease_id WHERE x.operation_id=${operationId}::uuid AND x.result_id=${request.resultId}::uuid AND l.authority_id=${issued.delivery_authority_id}::uuid`);
        if(!linked||(proof&&(proof.leaseId!==linked.lease_id||proof.leaseOwner!==linked.lease_owner)))throw new BrainChainSignerError('Exact submit requires its immutable delivery lease');
        proof={leaseId:linked.lease_id,leaseOwner:linked.lease_owner};
        await assertExactSubmitKeyAuthority(tx,operationId);
      }
      if(!proof)throw new BrainChainSignerError('Exact submit requires its issued delivery lease');
      const [lease]=await tx.execute<{observation_policy:string}>(sql`SELECT d.observation_policy FROM brainchain_delivery_leases l JOIN brainchain_delivery_authorities d ON d.id=l.authority_id
        WHERE l.id=${proof.leaseId}::uuid AND l.lease_owner=${proof.leaseOwner}::uuid AND d.id=${issued.delivery_authority_id}::uuid AND d.exact_consent_id=${issued.consent_id}::uuid
        AND d.result_id=${request.resultId}::uuid AND d.avatar_id=${avatarId}::uuid AND d.binding_id=${bindingId}::uuid`);
      if(!lease)throw new BrainChainSignerError('Exact submit delivery issuance mismatch');
      assertSignerObservationPolicy(lease.observation_policy,observation);
      const [allowed]=await tx.execute<{allowed:boolean}>(sql`SELECT brainchain_assert_recovery_submit(${request.resultId}::uuid,${avatarId}::uuid,${bindingId}::uuid,${proof.leaseId}::uuid,${proof.leaseOwner}::uuid,${request.task},${request.hash},${request.uri},${observation.blockHash}) AS allowed`);
      if(allowed?.allowed!==true)throw new BrainChainSignerError('Current exact submit consent required');
      assertFreshTestnetObservation(observation);return;
    }
  }
  const rows=await tx.execute<{allowed:boolean}>(sql`SELECT brainchain_assert_submit_result(${request.resultId}::uuid,${avatarId}::uuid,${bindingId}::uuid,
    ${request.task},${request.hash},${request.uri},${observation.blockHash}) AS allowed`);
  if(rows[0]?.allowed!==true){
    proof=deliveryProof;
    if(!proof&&operationId){
      const [link]=await tx.execute<{lease_id:string;lease_owner:string}>(sql`SELECT x.lease_id,l.lease_owner FROM brainchain_delivery_submit_leases x JOIN brainchain_delivery_leases l ON l.id=x.lease_id WHERE x.operation_id=${operationId}::uuid AND x.result_id=${request.resultId}::uuid`);
      if(link)proof={leaseId:link.lease_id,leaseOwner:link.lease_owner};
    }
    if(!proof)throw new BrainChainSignerError('Current frozen submit result authority required');
    const [delivery]=await tx.execute<{observation_policy:string;exact_consent_id:string|null}>(sql`SELECT d.observation_policy,d.exact_consent_id FROM brainchain_delivery_leases l JOIN brainchain_delivery_authorities d ON d.id=l.authority_id WHERE l.id=${proof.leaseId}::uuid`);
    if(!delivery)throw new BrainChainSignerError('Recovery delivery authority unavailable');
    assertSignerObservationPolicy(delivery.observation_policy,observation);
    if(operationId&&delivery.exact_consent_id)await assertExactSubmitKeyAuthority(tx,operationId);
    const [recovered]=await tx.execute<{allowed:boolean}>(sql`SELECT brainchain_assert_recovery_submit(${request.resultId}::uuid,${avatarId}::uuid,${bindingId}::uuid,${proof.leaseId}::uuid,${proof.leaseOwner}::uuid,${request.task},${request.hash},${request.uri},${observation.blockHash}) AS allowed`);
    if(recovered?.allowed!==true)throw new BrainChainSignerError('Current frozen submit delivery lease required');
  }
  assertFreshTestnetObservation(observation);
}
