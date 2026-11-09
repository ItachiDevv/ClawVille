import { randomBytes } from 'node:crypto';
import { and, brainchainBindingChallenges as challenges, brainchainWorkerBindings as bindings, db, eq, sql } from '@clawville/database';
import { BRAINCHAIN_NETWORKS } from '@clawville/shared';
import { bindingDomain, buildWorkerBindingMessage, proofHash, verifyWorkerBindingSignature, workerBindingInput, workerBindingProofInput, workerControlInput } from './binding-proof';

export class BrainChainBindingError extends Error {
  constructor(readonly code: 'rate_limited' | 'invalid_proof' | 'binding_conflict' | 'worker_not_found') { super(code); }
}

export function publicWorker(row: typeof bindings.$inferSelect) {
  return { id: row.id, environment: row.environment, chainId: row.chainId, address: row.address,
    requestedState: row.requestedState, observedEligibility: row.observedEligibility,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function listBrainChainWorkers(avatarId: string) {
  return (await db.select().from(bindings).where(eq(bindings.avatarId, avatarId))).map(publicWorker);
}

export async function issueWorkerBindingChallenge(avatarId: string, input: unknown) {
  const { environment, address } = workerBindingInput.parse(input);
  const domain = bindingDomain();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-proof:${avatarId}`}, 0))`);
    const rows = await tx.execute<{ count: number; now: Date }>(sql`
      SELECT count(*)::integer AS count, clock_timestamp() AS now FROM brainchain_binding_challenges
      WHERE avatar_id = ${avatarId}::uuid AND created_at > clock_timestamp() - interval '1 minute'`);
    const count = rows[0]?.count ?? 0;
    if (count >= 5) throw new BrainChainBindingError('rate_limited');
    const issuedAt = new Date(rows[0]!.now);
    const expiresAt = new Date(issuedAt.getTime() + 120_000);
    const nonce = randomBytes(32).toString('hex');
    const message = buildWorkerBindingMessage({ avatarId, environment, address, domain, nonce, issuedAt, expiresAt });
    await tx.insert(challenges).values({ nonceHash: proofHash(nonce), avatarId, environment,
      chainId: BRAINCHAIN_NETWORKS[environment].chainId, address, domain, message, messageHash: proofHash(message),
      createdAt: issuedAt, expiresAt });
    return { nonce, messageToSign: message, expiresAt: expiresAt.toISOString() };
  });
}

export async function bindBrainChainWorker(avatarId: string, input: unknown) {
  const { nonce, signature } = workerBindingProofInput.parse(input);
  const nonceHash = proofHash(nonce);
  // Persist attempt admission before expensive signature work. Replicas share this five-attempt limit.
  const admitted = await db.execute<typeof challenges.$inferSelect & { nonce_hash: string }>(sql`
    UPDATE brainchain_binding_challenges SET verification_attempts = verification_attempts + 1
    WHERE nonce_hash = ${nonceHash} AND avatar_id = ${avatarId}::uuid
      AND consumed_at IS NULL AND expires_at > clock_timestamp() AND verification_attempts < 5
    RETURNING nonce_hash`);
  if (admitted.length !== 1) throw new BrainChainBindingError('invalid_proof');
  const [challenge] = await db.select().from(challenges).where(and(eq(challenges.nonceHash, nonceHash), eq(challenges.avatarId, avatarId)));
  const network = challenge?.environment === 'testnet' || challenge?.environment === 'mainnet' ? challenge.environment : null;
  const canonical = challenge && network ? buildWorkerBindingMessage({ avatarId, environment: network,
    address: challenge.address, domain: challenge.domain, nonce, issuedAt: challenge.createdAt, expiresAt: challenge.expiresAt }) : null;
  if (!challenge || challenge.domain !== bindingDomain() || challenge.messageHash !== proofHash(challenge.message)
    || challenge.message !== canonical || !network || challenge.chainId !== BRAINCHAIN_NETWORKS[network].chainId
    || !(await verifyWorkerBindingSignature(challenge.address, challenge.message, signature))) {
    throw new BrainChainBindingError('invalid_proof');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-binding:${avatarId}`}, 0))`);
    const consumed = await tx.execute(sql`
      UPDATE brainchain_binding_challenges SET consumed_at = clock_timestamp()
      WHERE nonce_hash = ${nonceHash} AND avatar_id = ${avatarId}::uuid AND consumed_at IS NULL AND expires_at > clock_timestamp()
        AND environment = ${challenge.environment} AND chain_id = ${challenge.chainId}
        AND address = ${challenge.address} AND domain = ${challenge.domain} AND message_hash = ${challenge.messageHash}
        AND message = ${challenge.message}
      RETURNING nonce_hash`);
    if (consumed.length !== 1) throw new BrainChainBindingError('invalid_proof');
    const [existing] = await tx.select().from(bindings).where(and(eq(bindings.avatarId, avatarId), eq(bindings.environment, challenge.environment)));
    if (existing) {
      if (existing.address !== challenge.address) throw new BrainChainBindingError('binding_conflict');
      const [updated] = await tx.update(bindings).set({ proofHash: challenge.messageHash, verifiedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(bindings.id, existing.id)).returning();
      return publicWorker(updated!);
    }
    const [inserted] = await tx.insert(bindings).values({ avatarId, environment: challenge.environment,
      chainId: challenge.chainId, address: challenge.address, proofHash: challenge.messageHash,
    }).onConflictDoNothing().returning();
    if (!inserted) throw new BrainChainBindingError('binding_conflict');
    return publicWorker(inserted);
  });
}

export async function requestBrainChainWorkerControl(avatarId: string, workerId: string, input: unknown) {
  const { requestedState } = workerControlInput.parse(input);
  const [worker] = await db.update(bindings).set({ requestedState, updatedAt: sql`now()` })
    .where(and(eq(bindings.id, workerId), eq(bindings.avatarId, avatarId))).returning();
  if (!worker) throw new BrainChainBindingError('worker_not_found');
  return publicWorker(worker);
}
