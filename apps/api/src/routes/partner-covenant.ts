/**
 * Covenant partner — READ-ONLY verification read surface (2026-07-03).
 *
 * Covenant runs `covenantd`, a verification daemon that verifies bounty work and
 * (later) co-signs on-chain SAP escrow settles with an audit root as the
 * `service_hash` (see `docs/sap-covenant-payai-architecture.md`). To do that it
 * needs to READ the submitted evidence + verdict + escrow linkage for a bounty,
 * plus the on-chain identity of the hunter agent. The PUBLIC bounty reads
 * (`routes/bounties.ts`) only expose evidence to the hunter/creator — a verifier
 * can't see `bounty_attempts.pr_link` / `submission_note`, the verdict columns,
 * or the SAP settlement ledger. This router is that partner-gated read surface.
 *
 * GET-ONLY, NO MUTATIONS ANYWHERE — no DB write, no ledger call, no on-chain call.
 *
 *   GET /bounties                       — list bounties for verification polling
 *   GET /bounties/:id/verification      — full verification bundle for one bounty
 *   GET /agents/:avatarId               — agent-services identity bundle
 *
 * AUTH: every route is fronted by `requireCovenantPartner` (see
 * `middleware/require-covenant-partner.ts`): ed25519 partner signature
 * (`verifyPartnerGetSignature('covenant', …)`, same wire scheme as Hatcher GETs)
 * PLUS an env IP allowlist, fail-closed to 503 when unprovisioned. This file
 * consumes that gate; it never re-implements verification.
 *
 * PUBKEYS ONLY — the identity bundle exposes ONLY public values: the custodial
 * Solana wallet PUBLIC key (the `avatars.walletAddress` mirror), the derived SAP
 * agent PDA (a pure address derivation), and the public ERC-8004 registration
 * URL. It NEVER surfaces a secret/DEK/encrypted key, a session/bearer, an email,
 * or any `users` row field beyond the public identity fingerprint.
 *
 * Rule E5 note: this is a MACHINE-PARTNER read surface, NOT a user-facing
 * economy feature (no game, shop, quest, chat, or CT spend/earn), so the
 * human/agent parity mandate does not apply — there is no write path to bind.
 *
 * PROTECTED HATCHER SURFACE: this file only READS/imports from
 * `partner-signature.ts` + `skill-protocol.ts` (`resolveApiBase`) — it modifies
 * NONE of the protected Hatcher files and does NOT extend the staging-only
 * `ALLOW_TEST_PARTNER_PUBKEY` (hatcher-only) to covenant.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, inArray, gt, isNotNull, like, type SQL } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import {
  db,
  avatars,
  bounties,
  bountyAttempts,
  bountyReputation,
  covenantActionRecords,
  covenantSealBatches,
  sapEscrowSettlements,
  sapEscrowApprovals,
  users,
} from '@clawville/database';
import { loadSapConfig } from '../services/sap/sap-config';
import { findAgentPda } from '../services/sap/sap-pdas';
// resolveApiBase() is a pure exported helper — READ-ONLY import from the
// protected skill-protocol surface (not modified). Same helper partner-hatcher
// uses for its protocol pointer, so the emitted base matches everywhere.
import { resolveApiBase } from '../services/skill-protocol';
import { requireCovenantPartner } from '../middleware/require-covenant-partner';

export const partnerCovenantRoutes = new Hono();

// Every covenant read is partner-signed + IP-allowlisted (fail-closed 503 when
// unprovisioned). GET-only, so no body-size cap is needed.
partnerCovenantRoutes.use('*', requireCovenantPartner);

// ---------------------------------------------------------------------------
// SAP agent PDA + ERC-8004 URL — pure, side-effect-free identity derivations
// ---------------------------------------------------------------------------

/**
 * Memoized SAP program id (env is immutable per process). `loadSapConfig()`
 * falls back to `SAP_DEFAULT_PROGRAM_ID` when SAP env is unset and is enabled-
 * independent, so the agent PDA derives whether or not the on-chain SAP layer is
 * live — it is a deterministic address, NOT a live-account read. Any config
 * throw (e.g. a mainnet-guard misconfig) degrades to null (read surface: omit,
 * never 500).
 */
let memoSapProgramId: PublicKey | null | undefined;
function sapProgramId(): PublicKey | null {
  if (memoSapProgramId === undefined) {
    try {
      memoSapProgramId = loadSapConfig().programId;
    } catch {
      memoSapProgramId = null;
    }
  }
  return memoSapProgramId;
}

/** Derive the SAP agent PDA `["sap_agent", walletPubkey]` (base58) or null. */
function deriveSapAgentPda(walletPubkey: string | null): string | null {
  if (!walletPubkey) return null;
  const programId = sapProgramId();
  if (!programId) return null;
  try {
    const [agentPda] = findAgentPda(programId, new PublicKey(walletPubkey));
    return agentPda.toBase58();
  } catch {
    // Malformed stored pubkey — omit rather than throw on a read surface.
    return null;
  }
}

/**
 * Absolute URL of the public ERC-8004 registration file for an agent, keyed on
 * its `users.identity_fingerprint` (the real endpoint in this branch —
 * `routes/agent-registration.ts`, mounted at `/.well-known/agents`). There is NO
 * `/agents/<pda>/eip-8004.json` route in this branch; this is the actual,
 * verified ERC-8004 registration-file endpoint. Null when the agent has no
 * identity fingerprint (never bootstrapped an ed25519 identity → the endpoint
 * would 404). PUBLIC value only.
 */
function eip8004RegistrationUrl(identityFingerprint: string | null): string | null {
  if (!identityFingerprint) return null;
  return `${resolveApiBase()}/.well-known/agents/${identityFingerprint}/agent-registration.json`;
}

interface AgentIdentityBundle {
  avatarId: string;
  /** Custodial Solana wallet PUBLIC key (`avatars.walletAddress` mirror). */
  walletPubkey: string | null;
  /** Derived on-chain SAP agent PDA (base58), or null if unresolvable. */
  sapAgentPda: string | null;
  /** Public ERC-8004 registration-file URL, or null if no identity fingerprint. */
  eip8004RegistrationUrl: string | null;
}

/** Assemble the pubkey-only identity bundle for one avatar. */
function buildAgentIdentity(
  avatarId: string,
  walletPubkey: string | null,
  identityFingerprint: string | null,
): AgentIdentityBundle {
  return {
    avatarId,
    walletPubkey: walletPubkey ?? null,
    sapAgentPda: deriveSapAgentPda(walletPubkey),
    eip8004RegistrationUrl: eip8004RegistrationUrl(identityFingerprint),
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** The bounty status enum (mirrors `bounty_status` in the schema). */
const BOUNTY_STATUSES = [
  'open',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;

const listQuerySchema = z.object({
  status: z.enum(BOUNTY_STATUSES).optional(),
  paymentRail: z.enum(['vclaw', 'usdc']).optional(),
  // Query strings arrive as strings — coerce, then bound (default 25, max 100).
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const uuidSchema = z.string().uuid();

// Belt-and-braces fan-out bound (M3). Today a no-op — a bounty's `maxAttempts` is
// itself capped at 100 at create (`createBountySchema`), so at most 100 attempt
// rows can exist — but if that cap is ever raised, this keeps the verification
// bundle (and the per-hunter PDA derivations it drives) bounded to the 100 most
// recently-updated attempts instead of returning an unbounded list.
const MAX_ATTEMPTS_RETURNED = 100;

// ---------------------------------------------------------------------------
// GET /bounties — list for verification polling
// ---------------------------------------------------------------------------
// Verification-relevant fields only, newest-updated first (a verifier polls for
// bounties whose state just changed). `limit`/`offset` paginate.
partnerCovenantRoutes.get('/bounties', async (c) => {
  const parsed = listQuerySchema.safeParse({
    status: c.req.query('status'),
    paymentRail: c.req.query('paymentRail'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', details: parsed.error.flatten() }, 400);
  }
  const { status, paymentRail, limit, offset } = parsed.data;

  const conditions: SQL[] = [];
  if (status) conditions.push(eq(bounties.status, status));
  if (paymentRail) conditions.push(eq(bounties.paymentRail, paymentRail));
  // `and()` with no args is undefined — drizzle treats that as "no WHERE".
  const whereClause = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: bounties.id,
      title: bounties.title,
      status: bounties.status,
      paymentRail: bounties.paymentRail,
      verdictRequired: bounties.verdictRequired,
      escrowPda: bounties.escrowPda,
      escrowJobId: bounties.escrowJobId,
      tokenReward: bounties.tokenReward,
      currentAttempts: bounties.currentAttempts,
      expiresAt: bounties.expiresAt,
      updatedAt: bounties.updatedAt,
    })
    .from(bounties)
    .where(whereClause)
    .orderBy(desc(bounties.updatedAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    bounties: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      paymentRail: r.paymentRail,
      verdictRequired: r.verdictRequired,
      escrowPda: r.escrowPda,
      escrowJobId: r.escrowJobId,
      tokenReward: r.tokenReward,
      currentAttempts: r.currentAttempts,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// GET /bounties/:id/verification — full verification bundle for one bounty
// ---------------------------------------------------------------------------
partnerCovenantRoutes.get('/bounties/:id/verification', async (c) => {
  const idParse = uuidSchema.safeParse(c.req.param('id'));
  // Opaque 404 for malformed ids (never a 400 that distinguishes probes).
  if (!idParse.success) return c.json({ error: 'not_found' }, 404);
  const bountyId = idParse.data;

  const bounty = await db.query.bounties.findFirst({
    where: eq(bounties.id, bountyId),
  });
  if (!bounty) return c.json({ error: 'not_found' }, 404);

  // Creator: avatar public fields + reputation tier (same join the public
  // GET /:id does).
  const creatorAvatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, bounty.creatorId),
    columns: { id: true, name: true, species: true },
  });
  const creatorRep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.avatarId, bounty.creatorId),
    columns: { tier: true },
  });

  // The 100 most-recently-updated attempts + the hunter's public avatar fields
  // (name + wallet mirror + userId) so we can resolve hunter identities without an
  // N+1 per hunter. Capped at MAX_ATTEMPTS_RETURNED (M3) so the bundle + the
  // per-hunter PDA derivations it drives stay bounded even if the create-time
  // maxAttempts cap is ever raised above 100.
  const attemptRows = await db
    .select({
      id: bountyAttempts.id,
      hunterId: bountyAttempts.hunterId,
      hunterName: avatars.name,
      hunterWallet: avatars.walletAddress,
      hunterUserId: avatars.userId,
      status: bountyAttempts.status,
      prLink: bountyAttempts.prLink,
      submissionNote: bountyAttempts.submissionNote,
      reviewNote: bountyAttempts.reviewNote,
      claimedAt: bountyAttempts.claimedAt,
      submittedAt: bountyAttempts.submittedAt,
      reviewedAt: bountyAttempts.reviewedAt,
      updatedAt: bountyAttempts.updatedAt,
    })
    .from(bountyAttempts)
    .innerJoin(avatars, eq(bountyAttempts.hunterId, avatars.id))
    .where(eq(bountyAttempts.bountyId, bountyId))
    .orderBy(desc(bountyAttempts.updatedAt))
    .limit(MAX_ATTEMPTS_RETURNED);

  // SAP settlement ledger + depositor approvals for this bounty's escrow. Only
  // when the bounty carries an escrow binding; the (escrow_pda, job_id) key is
  // the bounty's escrowPda + escrowJobId (jobId === bounty.id by construction).
  let escrowSettlements: Array<Record<string, unknown>> = [];
  let escrowApprovals: Array<Record<string, unknown>> = [];
  if (bounty.escrowPda) {
    const jobId = bounty.escrowJobId ?? bounty.id;
    const settlementRows = await db
      .select()
      .from(sapEscrowSettlements)
      .where(
        and(
          eq(sapEscrowSettlements.escrowPda, bounty.escrowPda),
          eq(sapEscrowSettlements.jobId, jobId),
        ),
      );
    escrowSettlements = settlementRows.map((s) => ({
      id: s.id,
      status: s.status,
      dryRun: s.dryRun,
      settleSignature: s.settleSignature,
      fundingSignature: s.fundingSignature,
      tokenMint: s.tokenMint,
      pricePerCall: s.pricePerCall,
      maxCalls: s.maxCalls,
      fundedAmount: s.fundedAmount,
      callsSettled: s.callsSettled,
      releasedAmount: s.releasedAmount,
      refundedAmount: s.refundedAmount,
      verificationProvider: s.verificationProvider,
      verificationPassed: s.verificationPassed,
      auditRootHex: s.auditRootHex,
      verificationDetail: s.verificationDetail,
      depositorAvatarId: s.depositorAvatarId,
      workerAvatarId: s.workerAvatarId,
      depositorWalletPubkey: s.depositorWalletPubkey,
      workerWalletPubkey: s.workerWalletPubkey,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      settledAt: s.settledAt?.toISOString() ?? null,
    }));

    const approvalRows = await db
      .select()
      .from(sapEscrowApprovals)
      .where(
        and(
          eq(sapEscrowApprovals.escrowPda, bounty.escrowPda),
          eq(sapEscrowApprovals.jobId, jobId),
        ),
      );
    escrowApprovals = approvalRows.map((a) => ({
      id: a.id,
      approverAvatarId: a.approverAvatarId,
      workerAvatarId: a.workerAvatarId,
      approvedCalls: a.approvedCalls,
      approvedAt: a.approvedAt.toISOString(),
    }));
  }

  // Distinct hunters → resolve identity fingerprint (batched) → pubkey-only bundle.
  const distinctHunters = new Map<
    string,
    { name: string | null; wallet: string | null; userId: string | null }
  >();
  for (const a of attemptRows) {
    if (!distinctHunters.has(a.hunterId)) {
      distinctHunters.set(a.hunterId, {
        name: a.hunterName,
        wallet: a.hunterWallet,
        userId: a.hunterUserId,
      });
    }
  }
  const userIds = [
    ...new Set(
      [...distinctHunters.values()]
        .map((h) => h.userId)
        .filter((u): u is string => !!u),
    ),
  ];
  const fingerprintByUser = new Map<string, string | null>();
  if (userIds.length > 0) {
    const fpRows = await db
      .select({ id: users.id, fp: users.identityFingerprint })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const r of fpRows) fingerprintByUser.set(r.id, r.fp ?? null);
  }
  const hunterAgentIdentity = [...distinctHunters.entries()].map(([avatarId, h]) => ({
    name: h.name,
    ...buildAgentIdentity(
      avatarId,
      h.wallet,
      h.userId ? fingerprintByUser.get(h.userId) ?? null : null,
    ),
  }));

  return c.json({
    bounty: {
      id: bounty.id,
      title: bounty.title,
      description: bounty.description,
      requirements: bounty.requirements,
      acceptanceCriteria: bounty.acceptanceCriteria,
      difficulty: bounty.difficulty,
      status: bounty.status,
      tokenReward: bounty.tokenReward,
      paymentRail: bounty.paymentRail,
      verdictRequired: bounty.verdictRequired,
      covenantAuditRootHex: bounty.covenantAuditRootHex,
      covenantVerificationPassed: bounty.covenantVerificationPassed,
      covenantVerdictId: bounty.covenantVerdictId,
      escrowPda: bounty.escrowPda,
      escrowJobId: bounty.escrowJobId,
      maxAttempts: bounty.maxAttempts,
      currentAttempts: bounty.currentAttempts,
      expiresAt: bounty.expiresAt?.toISOString() ?? null,
      completedAt: bounty.completedAt?.toISOString() ?? null,
      createdAt: bounty.createdAt.toISOString(),
      updatedAt: bounty.updatedAt.toISOString(),
    },
    creator: {
      avatarId: bounty.creatorId,
      name: creatorAvatar?.name ?? null,
      species: creatorAvatar?.species ?? null,
      reputationTier: creatorRep?.tier ?? 'newcomer',
    },
    attempts: attemptRows.map((a) => ({
      id: a.id,
      hunter: { avatarId: a.hunterId, name: a.hunterName },
      status: a.status,
      prLink: a.prLink,
      submissionNote: a.submissionNote,
      reviewNote: a.reviewNote,
      claimedAt: a.claimedAt.toISOString(),
      submittedAt: a.submittedAt?.toISOString() ?? null,
      reviewedAt: a.reviewedAt?.toISOString() ?? null,
      updatedAt: a.updatedAt.toISOString(),
    })),
    escrowSettlements,
    escrowApprovals,
    hunterAgentIdentity,
  });
});

// ---------------------------------------------------------------------------
// GET /agents/:avatarId — agent-services identity bundle
// ---------------------------------------------------------------------------
partnerCovenantRoutes.get('/agents/:avatarId', async (c) => {
  const idParse = uuidSchema.safeParse(c.req.param('avatarId'));
  if (!idParse.success) return c.json({ error: 'not_found' }, 404);
  const avatarId = idParse.data;

  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, avatarId),
    columns: {
      id: true,
      name: true,
      species: true,
      userId: true,
      walletAddress: true,
    },
  });
  // Opaque, generic 404 when the avatar is unknown.
  if (!avatar) return c.json({ error: 'not_found' }, 404);

  const rep = await db.query.bountyReputation.findFirst({
    where: eq(bountyReputation.avatarId, avatarId),
  });

  let fingerprint: string | null = null;
  if (avatar.userId) {
    const u = await db.query.users.findFirst({
      where: eq(users.id, avatar.userId),
      columns: { identityFingerprint: true },
    });
    fingerprint = u?.identityFingerprint ?? null;
  }

  return c.json({
    avatar: { id: avatar.id, name: avatar.name, species: avatar.species },
    reputation: rep
      ? {
          tier: rep.tier,
          totalCompleted: rep.totalCompleted,
          totalEarned: rep.totalEarned,
          totalPosted: rep.totalPosted,
          successRate: rep.successRate,
          lastActivityAt: rep.lastActivityAt?.toISOString() ?? null,
        }
      : null,
    agentIdentity: buildAgentIdentity(avatar.id, avatar.walletAddress, fingerprint),
  });
});

// ---------------------------------------------------------------------------
// GET /actions — the covenant action-record stream (2026-07-13)
// ---------------------------------------------------------------------------
// The append-only, hash-chained record of every economic agent action (see
// `services/covenant-action-recorder.ts` + `covenant-chain-sealer.ts`).
// SEALED records only — a sealed row carries its chain position + hashes, so
// everything served is verifiable; unsealed rows (younger than the sealer's
// watermark) become visible within ~90s. Cursor by `sincePosition` (exclusive),
// ascending — a poller replays the chain gaplessly from any position.

const actionsQuerySchema = z.object({
  // String→BigInt by hand: z.coerce.bigint() throws an UNCAUGHT TypeError (not
  // a ZodError) on non-numeric input in this zod line, which would 500 the
  // route instead of 400ing.
  sincePosition: z
    .string()
    .regex(/^\d{1,19}$/)
    .default('0')
    .transform((s) => BigInt(s)),
  /** Exact action verb (e.g. 'economy.credit') or a 'prefix.*' wildcard. */
  action: z
    .string()
    .regex(/^[a-z_]+\.(?:[a-z_]+|\*)$/)
    .optional(),
  subjectId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

partnerCovenantRoutes.get('/actions', async (c) => {
  const parsed = actionsQuerySchema.safeParse({
    sincePosition: c.req.query('sincePosition'),
    action: c.req.query('action'),
    subjectId: c.req.query('subjectId'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', details: parsed.error.flatten() }, 400);
  }
  const { sincePosition, action, subjectId, limit } = parsed.data;

  const conditions: SQL[] = [
    isNotNull(covenantActionRecords.chainPosition),
    gt(covenantActionRecords.chainPosition, sincePosition),
  ];
  if (action) {
    if (action.endsWith('.*')) {
      conditions.push(like(covenantActionRecords.action, `${action.slice(0, -1)}%`));
    } else {
      conditions.push(eq(covenantActionRecords.action, action));
    }
  }
  if (subjectId) conditions.push(eq(covenantActionRecords.subjectId, subjectId));

  const rows = await db
    .select({
      chainPosition: covenantActionRecords.chainPosition,
      action: covenantActionRecords.action,
      subjectType: covenantActionRecords.subjectType,
      subjectId: covenantActionRecords.subjectId,
      actorKind: covenantActionRecords.actorKind,
      payload: covenantActionRecords.payload,
      payloadHash: covenantActionRecords.payloadHash,
      prevHash: covenantActionRecords.prevHash,
      recordHash: covenantActionRecords.recordHash,
      createdAt: covenantActionRecords.createdAt,
      sealedAt: covenantActionRecords.sealedAt,
    })
    .from(covenantActionRecords)
    .where(and(...conditions))
    .orderBy(covenantActionRecords.chainPosition)
    .limit(limit);

  return c.json({
    actions: rows.map((r) => ({
      chainPosition: r.chainPosition!.toString(),
      action: r.action,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      actorKind: r.actorKind,
      payload: r.payload,
      payloadHash: r.payloadHash,
      prevHash: r.prevHash,
      recordHash: r.recordHash,
      createdAt: r.createdAt.toISOString(),
      sealedAt: r.sealedAt!.toISOString(),
    })),
    limit,
    // Next-page cursor: the last served position (echo the request's when empty).
    nextSincePosition: (rows.length
      ? rows[rows.length - 1].chainPosition!
      : sincePosition
    ).toString(),
  });
});

// ---------------------------------------------------------------------------
// GET /actions/head — chain head + latest seal batch (cheap poll/verify)
// ---------------------------------------------------------------------------
partnerCovenantRoutes.get('/actions/head', async (c) => {
  const [head] = await db
    .select({
      chainPosition: covenantActionRecords.chainPosition,
      recordHash: covenantActionRecords.recordHash,
      sealedAt: covenantActionRecords.sealedAt,
    })
    .from(covenantActionRecords)
    .where(isNotNull(covenantActionRecords.chainPosition))
    .orderBy(desc(covenantActionRecords.chainPosition))
    .limit(1);

  const [batch] = await db
    .select()
    .from(covenantSealBatches)
    .orderBy(desc(covenantSealBatches.lastPosition))
    .limit(1);

  return c.json({
    head: head
      ? {
          chainPosition: head.chainPosition!.toString(),
          recordHash: head.recordHash,
          sealedAt: head.sealedAt!.toISOString(),
        }
      : null,
    latestBatch: batch
      ? {
          firstPosition: batch.firstPosition.toString(),
          lastPosition: batch.lastPosition.toString(),
          recordCount: batch.recordCount.toString(),
          batchRoot: batch.batchRoot,
          prevBatchRoot: batch.prevBatchRoot,
          createdAt: batch.createdAt.toISOString(),
        }
      : null,
  });
});
