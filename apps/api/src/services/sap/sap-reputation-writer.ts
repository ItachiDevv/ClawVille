/**
 * Durable SAP reputation writer for verified composed-bounty completions.
 *
 * The bounty PAID CAS only enqueues. This worker performs the house-signed
 * non-money writes later, after the hunter identity is provably registered.
 * Both SAP PDAs are unique per (hunter AgentAccount, house wallet), so every
 * send is probe-first and every broadcast-unknown result is probe-recovered.
 */

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  and,
  asc,
  bounties,
  bountyAttempts,
  db,
  eq,
  sapAgentIdentities,
  sapReputationJobs,
  sql,
  wallets,
  type SapAgentIdentity,
  type SapReputationJob,
} from '@clawville/database';
import { countDistinct, lt, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { alertError, type AlertErrorParams } from '../alert-error';
import { withKeyedMutex } from '../keyed-mutex';
import { resolveHouseAvatarId } from './house-sap-provisioning';
import { buildSapIdentityRegistrationUrl } from './sap-identity-registrar';
import {
  createAttestation,
  fetchAgentProfile,
  getSapConnectionForIdentityRegistrar,
  getSapProgramForIdentityBridge,
  giveFeedback,
  sapConfigSnapshot,
  updateFeedback,
  type SapWriteResult,
} from './sap-client';
import { findAttestationPda, findFeedbackPda } from './sap-pdas';

const REGISTERED_IDENTITY_STATUSES = [
  'registered',
  'attaching_identity',
  'identity_attached',
] as const;
const MAX_ATTEMPTS = 10;
const IDENTITY_WAIT_LIMIT_MS = 14 * 24 * 60 * 60_000;
const CLAIM_STALE_MS = 10 * 60_000;
const POLL_MS_DEFAULT = 300_000;
const POLL_MS_FLOOR = 60_000;
const WORKER_BATCH = 50;
const ATTESTATION_TYPE = 'clawville-verified';
const FEEDBACK_TAG = 'bounty';

type ReputationJobPatch = Partial<
  Pick<
    SapReputationJob,
    | 'status'
    | 'attestationTxSig'
    | 'feedbackTxSig'
    | 'attempts'
    | 'lastError'
    | 'updatedAt'
  >
>;

export interface FeedbackProbe {
  exists: boolean;
  agent?: string;
  reviewer?: string;
  score?: number;
  tag?: string;
  commentHashHex?: string | null;
  isRevoked?: boolean;
}

interface HouseSapIdentity {
  wallet: string;
  agentPda: string;
  cluster: string;
}

export interface SapReputationWriterDeps {
  /** Test seam; production reads the cached validated SAP config snapshot. */
  config?: { enabled: boolean; reputationWritesEnabled: boolean; cluster: string };
  now(): Date;
  loadHunterIdentity(avatarId: string): Promise<SapAgentIdentity | null>;
  resolveHouseAvatarId(): Promise<string | null>;
  loadHouseIdentity(avatarId: string): Promise<HouseSapIdentity | null>;
  countPaidComposedBounties(hunterAvatarId: string): Promise<number>;
  probeAttestation(subjectAgentPda: string, attesterWallet: string): Promise<boolean>;
  probeFeedback(targetAgentPda: string, reviewerWallet: string): Promise<FeedbackProbe>;
  createAttestation: typeof createAttestation;
  giveFeedback: typeof giveFeedback;
  updateFeedback: typeof updateFeedback;
  persistPatch(id: string, patch: ReputationJobPatch): Promise<SapReputationJob>;
  alert(params: AlertErrorParams): Promise<void>;
}

/** Score after N verified completions: first completion is 625, capped at 1000. */
export function bountyReputationScore(completedBounties: number): number {
  const count = Number.isFinite(completedBounties)
    ? Math.max(0, Math.floor(completedBounties))
    : 0;
  return Math.min(1000, 600 + 25 * count);
}

function commentHashHex(bountyId: string): string {
  return createHash('sha256').update(bountyId).digest('hex');
}

function normalizedHashHex(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.toLowerCase();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
    return Buffer.from(value as Uint8Array).toString('hex');
  }
  return null;
}

function isRegisteredIdentity(
  row: SapAgentIdentity | null,
  cluster: string,
): boolean {
  return Boolean(
    row &&
      row.cluster === cluster &&
      (REGISTERED_IDENTITY_STATUSES as readonly string[]).includes(row.status) &&
      isRealSignature(row.registerTxSig),
  );
}

function isRealSignature(value: string | null): value is string {
  if (!value) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAlreadyExists(result: SapWriteResult): boolean {
  if (result.ok) return false;
  const message = result.message.toLowerCase();
  return (
    message.includes('already in use') ||
    message.includes('already initialized') ||
    message.includes('accountalreadyinitialized') ||
    message.includes('custom program error: 0x0')
  );
}

function liveSignature(result: SapWriteResult): string | null {
  return result.ok && !result.dryRun ? result.signature : null;
}

function observedSignature(result: SapWriteResult): string | null {
  return liveSignature(result) ?? (!result.ok ? result.signature ?? null : null);
}

async function skipJob(
  row: SapReputationJob,
  reason: string,
  deps: SapReputationWriterDeps,
): Promise<SapReputationJob> {
  return deps.persistPatch(row.id, {
    status: 'skipped',
    lastError: reason,
    updatedAt: deps.now(),
  });
}

async function recordTransientFailure(
  row: SapReputationJob,
  reason: string,
  deps: SapReputationWriterDeps,
): Promise<SapReputationJob> {
  const attempts = row.attempts + 1;
  const terminal = attempts >= MAX_ATTEMPTS;
  const updated = await deps.persistPatch(row.id, {
    status: terminal ? 'failed' : 'writing',
    attempts,
    lastError: reason.slice(0, 4_000),
    updatedAt: deps.now(),
  });
  if (terminal) {
    try {
      await deps.alert({
        severity: 'critical',
        source: 'sap-reputation-writer',
        message: `SAP reputation job ${row.id} exhausted ${MAX_ATTEMPTS} attempts: ${reason}`,
        context: { jobId: row.id, bountyId: row.bountyId, hunterAvatarId: row.hunterAvatarId },
      });
    } catch (err) {
      console.warn('[sap-reputation-writer] terminal alert failed (non-fatal):', messageOf(err));
    }
  }
  return updated;
}

function feedbackMatches(
  probe: FeedbackProbe,
  targetAgentPda: string,
  reviewerWallet: string,
  score: number,
  bountyId: string,
): boolean {
  return (
    probe.exists &&
    probe.agent === targetAgentPda &&
    probe.reviewer === reviewerWallet &&
    probe.isRevoked === false &&
    probe.score === score &&
    probe.tag === FEEDBACK_TAG &&
    probe.commentHashHex?.toLowerCase() === commentHashHex(bountyId)
  );
}

/** Process one claimed row. Exported as the mock-only state-machine seam. */
export async function processSapReputationJob(
  row: SapReputationJob,
  deps: SapReputationWriterDeps,
): Promise<SapReputationJob> {
  if (row.status === 'written' || row.status === 'skipped' || row.status === 'failed') return row;

  const cfg = deps.config ?? sapConfigSnapshot();
  if (!cfg.enabled || !cfg.reputationWritesEnabled) return row;
  const ageMs = deps.now().getTime() - row.createdAt.getTime();
  let hunterIdentity: SapAgentIdentity | null;
  try {
    hunterIdentity = await deps.loadHunterIdentity(row.hunterAvatarId);
  } catch (err) {
    return recordTransientFailure(row, `Hunter identity lookup failed: ${messageOf(err)}`, deps);
  }
  if (!isRegisteredIdentity(hunterIdentity, cfg.cluster)) {
    const absentForCluster = !hunterIdentity || hunterIdentity.cluster !== cfg.cluster;
    const terminalIdentityFailure = hunterIdentity?.status === 'failed';
    const reason = terminalIdentityFailure
      ? 'Hunter SAP identity registration failed.'
      : absentForCluster
        ? 'Hunter SAP identity is absent on this cluster.'
        : 'Waiting for a registered hunter SAP identity.';
    if ((absentForCluster || terminalIdentityFailure) && ageMs >= IDENTITY_WAIT_LIMIT_MS) {
      return skipJob(row, `${reason} Waited 14 days.`, deps);
    }
    return deps.persistPatch(row.id, {
      status: 'waiting_identity',
      lastError: reason,
      updatedAt: deps.now(),
    });
  }
  // The non-registered/null branch above always returns.
  if (!hunterIdentity) {
    return recordTransientFailure(row, 'Hunter SAP identity disappeared after validation.', deps);
  }

  let houseAvatarId: string | null;
  try {
    houseAvatarId = await deps.resolveHouseAvatarId();
  } catch (err) {
    return recordTransientFailure(row, `House avatar lookup failed: ${messageOf(err)}`, deps);
  }
  if (!houseAvatarId) {
    return recordTransientFailure(row, 'Coralia house avatar is not provisioned.', deps);
  }
  if (houseAvatarId === row.hunterAvatarId) {
    return skipJob(row, 'Refused SAP self-attestation: hunter avatar is the house avatar.', deps);
  }

  let houseIdentity: HouseSapIdentity | null;
  try {
    houseIdentity = await deps.loadHouseIdentity(houseAvatarId);
  } catch (err) {
    return recordTransientFailure(row, `House SAP identity lookup failed: ${messageOf(err)}`, deps);
  }
  if (!houseIdentity || houseIdentity.cluster !== cfg.cluster) {
    return recordTransientFailure(row, 'Coralia house SAP identity is not registered on this cluster.', deps);
  }
  if (houseIdentity.wallet === hunterIdentity.wallet) {
    return skipJob(row, 'Refused SAP self-attestation: hunter and house share the owner wallet.', deps);
  }

  let working = row;
  const metadata = buildSapIdentityRegistrationUrl(hunterIdentity.agentPda);

  let attestationExists: boolean;
  try {
    attestationExists = await deps.probeAttestation(hunterIdentity.agentPda, houseIdentity.wallet);
  } catch (err) {
    return recordTransientFailure(working, `Attestation probe failed: ${messageOf(err)}`, deps);
  }
  if (!attestationExists) {
    let created: SapWriteResult;
    try {
      created = await deps.createAttestation({
        attesterAvatarId: houseAvatarId,
        subjectAgentPda: hunterIdentity.agentPda,
        attestationType: ATTESTATION_TYPE,
        metadata,
        expiresAt: 0n,
      });
    } catch (err) {
      return recordTransientFailure(working, `create_attestation threw: ${messageOf(err)}`, deps);
    }
    if (created.ok && created.dryRun) {
      return deps.persistPatch(working.id, {
        status: 'writing',
        lastError: 'SAP_DRY_RUN simulated attestation; no PDA was written.',
        updatedAt: deps.now(),
      });
    }
    if (!created.ok) {
      if (created.broadcast || isAlreadyExists(created)) {
        try {
          attestationExists = await deps.probeAttestation(
            hunterIdentity.agentPda,
            houseIdentity.wallet,
          );
        } catch (err) {
          return recordTransientFailure(
            working,
            `Attestation recovery probe failed: ${messageOf(err)}`,
            deps,
          );
        }
      }
      if (!attestationExists) {
        return recordTransientFailure(
          working,
          `create_attestation failed (${created.code}): ${created.message}`,
          deps,
        );
      }
      if (created.signature) {
        working = await deps.persistPatch(working.id, {
          status: 'writing',
          attestationTxSig: created.signature,
          lastError: null,
          updatedAt: deps.now(),
        });
      }
    } else {
      working = await deps.persistPatch(working.id, {
        status: 'writing',
        attestationTxSig: liveSignature(created),
        lastError: null,
        updatedAt: deps.now(),
      });
    }
  }

  let feedback: FeedbackProbe;
  try {
    feedback = await deps.probeFeedback(hunterIdentity.agentPda, houseIdentity.wallet);
  } catch (err) {
    return recordTransientFailure(working, `Feedback probe failed: ${messageOf(err)}`, deps);
  }
  let completed: number;
  try {
    completed = await deps.countPaidComposedBounties(row.hunterAvatarId);
  } catch (err) {
    return recordTransientFailure(working, `Paid-bounty count failed: ${messageOf(err)}`, deps);
  }
  const score = bountyReputationScore(completed);
  if (
    feedback.exists &&
    (feedback.agent !== hunterIdentity.agentPda ||
      feedback.reviewer !== houseIdentity.wallet ||
      feedback.isRevoked !== false)
  ) {
    return recordTransientFailure(
      working,
      'Standing feedback PDA failed pair/non-revoked validation; refusing to overwrite it.',
      deps,
    );
  }
  // A prior give/update may have landed even though confirmation was unknown.
  // Exact decoded state is the recovery proof; adopt it before any resend.
  if (feedbackMatches(
    feedback,
    hunterIdentity.agentPda,
    houseIdentity.wallet,
    score,
    row.bountyId,
  )) {
    return deps.persistPatch(working.id, {
      status: 'written',
      lastError: null,
      updatedAt: deps.now(),
    });
  }
  const feedbackInput = {
    reviewerAvatarId: houseAvatarId,
    targetAgentPda: hunterIdentity.agentPda,
    score,
    tag: FEEDBACK_TAG,
    comment: row.bountyId,
  };
  let wrote: SapWriteResult;
  try {
    wrote = feedback.exists
      ? await deps.updateFeedback(feedbackInput)
      : await deps.giveFeedback(feedbackInput);
  } catch (err) {
    return recordTransientFailure(working, `Feedback executor threw: ${messageOf(err)}`, deps);
  }

  if (wrote.ok && wrote.dryRun) {
    return deps.persistPatch(working.id, {
      status: 'writing',
      lastError: 'SAP_DRY_RUN simulated feedback; no chain state was written.',
      updatedAt: deps.now(),
    });
  }
  if (!wrote.ok) {
    if (wrote.broadcast || isAlreadyExists(wrote)) {
      try {
        feedback = await deps.probeFeedback(hunterIdentity.agentPda, houseIdentity.wallet);
      } catch (err) {
        return recordTransientFailure(
          working,
          `Feedback recovery probe failed: ${messageOf(err)}`,
          deps,
        );
      }
    }
    // For update_feedback, PDA existence predates this send; only decoded field
    // equality proves the ambiguous broadcast landed.
    if (!feedbackMatches(
      feedback,
      hunterIdentity.agentPda,
      houseIdentity.wallet,
      score,
      row.bountyId,
    )) {
      return recordTransientFailure(
        working,
        `${feedback.exists ? 'update_feedback' : 'give_feedback'} failed (${wrote.code}): ${wrote.message}`,
        deps,
      );
    }
  }

  return deps.persistPatch(working.id, {
    status: 'written',
    feedbackTxSig: observedSignature(wrote),
    lastError: null,
    updatedAt: deps.now(),
  });
}

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadIdentity(client: DbLike, avatarId: string): Promise<SapAgentIdentity | null> {
  const row = await client.query.sapAgentIdentities.findFirst({
    where: eq(sapAgentIdentities.avatarId, avatarId),
  });
  return row ?? null;
}

async function loadHouseIdentity(
  client: DbLike,
  avatarId: string,
): Promise<HouseSapIdentity | null> {
  const cfg = sapConfigSnapshot();
  const persisted = await loadIdentity(client, avatarId);
  if (persisted && persisted.cluster === cfg.cluster && isRealSignature(persisted.registerTxSig) &&
      (REGISTERED_IDENTITY_STATUSES as readonly string[]).includes(persisted.status)) {
    return { wallet: persisted.wallet, agentPda: persisted.agentPda, cluster: persisted.cluster };
  }
  // Coralia predates the automatic identity registry. Fall back to her custodial
  // public wallet plus a current-cluster AgentAccount probe instead of requiring
  // a retroactively fabricated sap_agent_identities row.
  const wallet = await client.query.wallets.findFirst({
    where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
    columns: { publicKey: true },
  });
  if (!wallet) return null;
  const profile = await fetchAgentProfile(wallet.publicKey);
  if (!profile.ok || !profile.data || profile.data.wallet !== wallet.publicKey) return null;
  return { wallet: wallet.publicKey, agentPda: profile.data.agentPda, cluster: cfg.cluster };
}

async function countPaid(client: DbLike, hunterAvatarId: string): Promise<number> {
  const [result] = await client
    .select({ total: countDistinct(bounties.id) })
    .from(bounties)
    .innerJoin(
      bountyAttempts,
      and(eq(bountyAttempts.bountyId, bounties.id), eq(bountyAttempts.status, 'approved')),
    )
    .where(
      and(
        eq(bountyAttempts.hunterId, hunterAvatarId),
        eq(bounties.compositionState, 'paid'),
      ),
    );
  return Number(result?.total ?? 0);
}

async function persistWith(
  client: DbLike,
  id: string,
  patch: ReputationJobPatch,
): Promise<SapReputationJob> {
  const [updated] = await client
    .update(sapReputationJobs)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
    .where(eq(sapReputationJobs.id, id))
    .returning();
  if (!updated) throw new Error(`SAP reputation job ${id} disappeared during processing.`);
  return updated;
}

async function probeAttestation(subjectAgentPda: string, attesterWallet: string): Promise<boolean> {
  const cfg = sapConfigSnapshot();
  const [pda] = findAttestationPda(
    new PublicKey(cfg.programId),
    new PublicKey(subjectAgentPda),
    new PublicKey(attesterWallet),
  );
  const account = await getSapConnectionForIdentityRegistrar().getAccountInfo(pda, 'confirmed');
  if (!account) return false;
  if (!account.owner.equals(new PublicKey(cfg.programId))) {
    throw new Error('Attestation PDA exists but is not owned by the configured SAP program.');
  }
  return true;
}

async function probeFeedback(targetAgentPda: string, reviewerWallet: string): Promise<FeedbackProbe> {
  const cfg = sapConfigSnapshot();
  const [pda] = findFeedbackPda(
    new PublicKey(cfg.programId),
    new PublicKey(targetAgentPda),
    new PublicKey(reviewerWallet),
  );
  const program = getSapProgramForIdentityBridge();
  // Anchor maps the SDK IDL's FeedbackAccount fields to camelCase.
  const account = await (program.account as any).feedbackAccount.fetchNullable(pda);
  if (!account) return { exists: false };
  return {
    exists: true,
    agent: (account.agent as PublicKey).toBase58(),
    reviewer: (account.reviewer as PublicKey).toBase58(),
    score: Number(account.score),
    tag: String(account.tag),
    commentHashHex: normalizedHashHex(account.commentHash),
    isRevoked: Boolean(account.isRevoked),
  };
}

function depsFor(client: DbLike): SapReputationWriterDeps {
  return {
    now: () => new Date(),
    loadHunterIdentity: (avatarId) => loadIdentity(client, avatarId),
    resolveHouseAvatarId,
    loadHouseIdentity: (avatarId) => loadHouseIdentity(client, avatarId),
    countPaidComposedBounties: (avatarId) => countPaid(client, avatarId),
    probeAttestation,
    probeFeedback,
    createAttestation,
    giveFeedback,
    updateFeedback,
    persistPatch: (id, patch) => persistWith(client, id, patch),
    alert: alertError,
  };
}

async function enqueue(bountyId: string, hunterAvatarId: string): Promise<void> {
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled || !cfg.reputationWritesEnabled) return;
  await db
    .insert(sapReputationJobs)
    .values({ bountyId, hunterAvatarId, status: 'waiting_identity' })
    .onConflictDoNothing({ target: sapReputationJobs.bountyId });
}

/** Fire-and-forget admission; the already-committed bounty result never depends on it. */
export function enqueueBountyReputation(bountyId: string, hunterAvatarId: string): void {
  void enqueue(bountyId, hunterAvatarId).catch((err) => {
    console.warn('[sap-reputation-writer] enqueue failed (non-fatal):', messageOf(err));
  });
}

function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return CLAIM_STALE_MS;
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 6));
}

function rowDue(row: SapReputationJob, now: number): boolean {
  if (row.status === 'waiting_identity') return true;
  return now - row.updatedAt.getTime() >= retryDelayMs(row.attempts);
}

/** One bounded durable sweep; per-hunter locks prevent stale give/update races. */
export async function runSapReputationWriterPass(): Promise<void> {
  const cfg = sapConfigSnapshot();
  // Dry-run cannot prove durable pair state and must never consume/terminalize
  // jobs. Leave them waiting for a live-write posture.
  if (!cfg.enabled || !cfg.reputationWritesEnabled || cfg.dryRun) return;
  const olderJob = alias(sapReputationJobs, 'older_sap_reputation_job');
  const candidates = await db
    .select()
    .from(sapReputationJobs)
    .where(
      and(
        sql`${sapReputationJobs.status} IN ('waiting_identity', 'writing')`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(olderJob)
            .where(
              and(
                eq(olderJob.hunterAvatarId, sapReputationJobs.hunterAvatarId),
                sql`${olderJob.status} IN ('waiting_identity', 'writing')`,
                or(
                  lt(olderJob.createdAt, sapReputationJobs.createdAt),
                  and(
                    eq(olderJob.createdAt, sapReputationJobs.createdAt),
                    lt(olderJob.id, sapReputationJobs.id),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(sapReputationJobs.updatedAt))
    .limit(WORKER_BATCH);

  for (const candidate of candidates) {
    if (!rowDue(candidate, Date.now())) continue;
    try {
      await withKeyedMutex(`sap-reputation:${candidate.hunterAvatarId}`, async () => {
        await db.transaction(async (tx) => {
          // Hold the cross-process advisory lock through probe/write/reprobe.
          // The oldest-row durable lease additionally prevents a later bounty
          // from overtaking this one during backoff or after a process crash.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sap-reputation:${candidate.hunterAvatarId}`}, 0))`,
          );
          const current = await tx.query.sapReputationJobs.findFirst({
            where: eq(sapReputationJobs.id, candidate.id),
          });
          if (!current || !rowDue(current, Date.now())) return;
          if (current.status !== 'waiting_identity' && current.status !== 'writing') return;
          const oldestForHunter = await tx.query.sapReputationJobs.findFirst({
            where: and(
              eq(sapReputationJobs.hunterAvatarId, current.hunterAvatarId),
              sql`${sapReputationJobs.status} IN ('waiting_identity', 'writing')`,
            ),
            orderBy: [asc(sapReputationJobs.createdAt), asc(sapReputationJobs.id)],
          });
          if (!oldestForHunter || oldestForHunter.id !== current.id) return;
          const claimed = await persistWith(tx, current.id, {
            status: 'writing',
            updatedAt: new Date(),
          });
          await processSapReputationJob(claimed, depsFor(tx));
        });
      });
    } catch (err) {
      console.error(`[sap-reputation-writer] job ${candidate.id} failed (non-fatal):`, messageOf(err));
    }
  }
}

function resolvePollMs(): number {
  const parsed = Number(process.env.SAP_REPUTATION_WRITER_POLL_MS);
  return Number.isFinite(parsed) && parsed >= POLL_MS_FLOOR ? parsed : POLL_MS_DEFAULT;
}

let workerInterval: ReturnType<typeof setInterval> | null = null;

export function startSapReputationWriter(): void {
  if (workerInterval) return;
  const cfg = sapConfigSnapshot();
  if (!cfg.enabled || !cfg.reputationWritesEnabled) return;
  const periodMs = resolvePollMs();
  void runSapReputationWriterPass().catch((err) => {
    console.error('[sap-reputation-writer] initial pass failed (non-fatal):', messageOf(err));
  });
  workerInterval = setInterval(() => {
    void runSapReputationWriterPass().catch((err) => {
      console.error('[sap-reputation-writer] worker pass failed (non-fatal):', messageOf(err));
    });
  }, periodMs);
  console.log(`[sap-reputation-writer] worker started (poll ${periodMs}ms)`);
}

export function stopSapReputationWriter(): void {
  if (!workerInterval) return;
  clearInterval(workerInterval);
  workerInterval = null;
}
