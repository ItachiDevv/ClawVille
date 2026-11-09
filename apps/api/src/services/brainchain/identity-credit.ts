import type { BrainchainIdentityCredit } from '@clawville/shared';
import type { Address } from 'viem';
import { z } from 'zod';
import { createBrainChainParentReader } from './parent-reader';
import { createBrainChainPriorsReader } from './priors-reader';

export const identityCreditQuerySchema = z.object({ agentId: z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => value.length <= 78 && /^\d+$/.test(value) && BigInt(value) < 2n ** 256n) }).strict();
type Worker = { id: string; environment: 'mainnet' | 'testnet'; chainId: number; address: string };
type Dependencies = {
  parent: () => ReturnType<typeof createBrainChainParentReader>;
  priors: () => ReturnType<typeof createBrainChainPriorsReader>;
  now: () => number;
};
function age(value: string | null, now: number): number | null {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds > now + 30_000) throw new Error('Invalid source time');
  return Math.max(0, Math.floor((now - milliseconds) / 1000));
}
const expired = (value: string | null, lifetimeSeconds: number, now: number) => value === null || Date.parse(value) + lifetimeSeconds * 1000 < now;

/** Current association and public credit observations; never a consent or historical hire binding. */
export async function readWorkerIdentityCredit(worker: Worker, input: unknown, overrides: Partial<Dependencies> = {}): Promise<BrainchainIdentityCredit> {
  const { agentId } = identityCreditQuerySchema.parse(input);
  const deps: Dependencies = { parent: createBrainChainParentReader, priors: createBrainChainPriorsReader, now: Date.now, ...overrides };
  const base: BrainchainIdentityCredit = { workerId: worker.id, agentId, environment: worker.environment,
    observedAt: new Date(deps.now()).toISOString(), provisional: true, identity: { state: 'unavailable' },
    reputation: { state: 'not_requested' }, record: { state: 'not_requested' }, routes: { state: 'not_requested' } };
  if (worker.environment === 'testnet') return { ...base, identity: { state: 'unsupported_testnet' } };
  if (worker.chainId !== 274663) return base;
  const parent = deps.parent();
  try {
    const at = await parent.anchor();
    const blockTimestamp = BigInt(at.timestamp);
    if (blockTimestamp > BigInt(Number.MAX_SAFE_INTEGER)) return base;
    const parentTime = new Date(Number(blockTimestamp) * 1000).toISOString(), initialNow = deps.now();
    const blockAge = age(parentTime, initialNow);
    if (blockAge === null || expired(parentTime, 120, initialNow)) return { ...base, identity: { state: 'stale' } };
    const association = await parent.association(BigInt(agentId), worker.address as Address, at);
    if (!association) return { ...base, identity: { state: 'not_associated' } };
    const result: BrainchainIdentityCredit = { ...base, identity: { state: 'verified', chainId: 4663, owner: association.owner,
      registeredWallet: association.registeredWallet, association: association.kind, blockAgeSeconds: blockAge,
      block: { number: BigInt(at.number).toString(), hash: at.hash.toLowerCase(), timestamp: blockTimestamp.toString() } } };
    let noRecordEvidence = false;
    try { result.reputation = { state: 'observed', ...await parent.reputation(BigInt(agentId), at) }; }
    catch { result.reputation = { state: 'unavailable' }; }
    if (BigInt(agentId) > BigInt(Number.MAX_SAFE_INTEGER)) {
      result.record = { state: 'unsupported_id' }; result.routes = { state: 'unsupported_id' };
    } else {
      const priors = deps.priors();
      const [record, routes] = await Promise.allSettled([priors.record(Number(agentId)), priors.routes(Number(agentId))]);
      result.record = { state: 'unavailable' }; result.routes = { state: 'unavailable' };
      if (record.status === 'fulfilled' && record.value.agentId === Number(agentId) && record.value.owner === association.owner) {
        try {
          const value = record.value, ageSeconds = age(value.asOf, deps.now());
          if (ageSeconds !== null) result.record = { state: ageSeconds > 300 ? 'stale' : 'observed', owner: value.owner, asOf: value.asOf, ageSeconds,
            isRoot: value.isRoot, backerId: value.backer ? String(value.backer.agentId) : null,
            line: value.line, available: value.available, drawn: value.drawn, premiumBps: value.premiumBps,
            loansRepaid: value.loansRepaid, qualifiedRepaid: value.qualifiedRepaid, volumeRepaid: value.volumeRepaid, feesPaid: value.feesPaid,
            score: value.score, defaulted: value.defaulted, frozen: value.frozen,
            openLoans: { state: value.openLoans.length ? 'terms_unavailable' : 'none', count: value.openLoans.length } };
        } catch { /* No malformed or future-dated source becomes current evidence. */ }
      }
      if (routes.status === 'fulfilled' && routes.value.agentId === Number(agentId) && routes.value.owner === association.owner) {
        try {
          const value = routes.value;
          const snapshotAgeSeconds = age(value.asOf.snapshot, deps.now()), stocksAgeSeconds = age(value.asOf.stocks, deps.now());
          const stale = snapshotAgeSeconds === null || snapshotAgeSeconds > 300 || stocksAgeSeconds === null || stocksAgeSeconds > 900;
          result.routes = { state: stale ? 'stale' : 'observed', owner: value.owner, asOf: { ...value.asOf, directoryBlock: value.asOf.directoryBlock === null ? null : String(value.asOf.directoryBlock) },
            snapshotAgeSeconds, stocksAgeSeconds, ownerDefaulted: value.ownerDefaulted,
            options: value.routes.map(entry => ({ route: entry.route, open: entry.open, line: entry.line ?? null, bond: entry.bond ?? null, room: entry.room ?? null,
              upTo: entry.upTo ?? null, maxLine: entry.maxLine ?? null, weekLeft: entry.weekLeft ?? null })) };
          noRecordEvidence = value.recordRead && value.record === null;
        } catch { /* Keep unknown fields unavailable rather than substitute zero. */ }
      }
    }
    if ((await parent.block(BigInt(at.number))).hash.toLowerCase() !== at.hash.toLowerCase()) return base;
    const finalNow = deps.now();
    const finalAge = age(parentTime, finalNow);
    if (finalAge === null || expired(parentTime, 120, finalNow)) return { ...base, identity: { state: 'stale' } };
    if (result.identity.state === 'verified') result.identity.blockAgeSeconds = finalAge;
    if ('asOf' in result.record) {
      const recordAge = age(result.record.asOf, finalNow);
      if (recordAge === null) result.record = { state: 'unavailable' };
      else { result.record.ageSeconds = recordAge; result.record.state = expired(result.record.asOf, 300, finalNow) ? 'stale' : 'observed'; }
    }
    if ('asOf' in result.routes) {
      const snapshotAge = age(result.routes.asOf.snapshot, finalNow), stocksAge = age(result.routes.asOf.stocks, finalNow);
      result.routes.snapshotAgeSeconds = snapshotAge; result.routes.stocksAgeSeconds = stocksAge;
      result.routes.state = expired(result.routes.asOf.snapshot, 300, finalNow) || expired(result.routes.asOf.stocks, 900, finalNow) ? 'stale' : 'observed';
      if (noRecordEvidence && result.routes.state === 'observed' && result.record.state === 'unavailable') result.record = { state: 'no_record' };
    }
    result.observedAt = new Date(finalNow).toISOString();
    return result;
  } catch { return base; }
}

export async function readOwnedWorkerIdentityCredit(avatarId: string, workerId: string, input: unknown) {
  const { ownedWorker } = await import('./tasks');
  const worker = await ownedWorker(avatarId, workerId);
  return readWorkerIdentityCredit({ ...worker, environment: worker.environment as Worker['environment'] }, input);
}
