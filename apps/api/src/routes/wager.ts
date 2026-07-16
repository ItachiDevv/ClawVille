/**
 * Wager lobby + escrow routes — concern 4 of the gambling-contracts slice.
 *
 * Mount: `app.route('/api/wager', wagerRoutes)` from index.ts.
 *
 * Surfaces:
 *
 *   POST /lobbies                          (user/agent)  — create a lobby
 *   GET  /lobbies                          (public)      — list + filter
 *   GET  /lobbies/:idOrInvite              (public)      — single lobby + players
 *   POST /lobbies/:id/join                 (user/agent)  — deposit + join
 *   POST /lobbies/:id/lock                 (admin)       — match-start hook
 *   POST /lobbies/:id/settle               (admin)       — match-end hook
 *   POST /lobbies/:id/cancel               (auth)        — creator (open) / admin (open|locked)
 *   POST /lobbies/:id/refund               (auth)        — per-player after cancel
 *
 * The `solo-bots` mode lobby bypasses on-chain entirely: the route inserts
 * a `lobbies` row with mode='solo-bots' and the FE immediately mounts the
 * 3D scene. No deposit, no escrow, no rake.
 *
 * Public listing + invite-code lookups are read-only and rate-limited but
 * NOT auth-gated, per CLAUDE.md "Priority #3" public discovery.
 *
 * Feature gates (per CLAUDE.md "Feature Gates"):
 *
 *   FEATURE_GATE: wager-spl-lobbies
 *   Status: schema-ready (wager_mint column), routes refuse SPL today
 *   Metric to graduate: at least one merchant requests an SPL-only lobby
 *   Current reading: 0 SPL requests
 *   Review deadline: 2026-07-01
 *   On deadline: either ship `wagerMint != null` write path with the SPL
 *                client wiring OR delete the column and the gate
 *   Reference: contracts/programs/clawville-wager — `create_lobby_spl` exists
 *
 *   FEATURE_GATE: wager-mainnet-paid
 *   Status: program is devnet-only; routes never sign mainnet RPC URLs
 *   Metric to graduate: production legal review + custodial signoff
 *   Current reading: pending
 *   Review deadline: 2026-09-01
 *   On deadline: keep refusing mainnet (rip the env override) OR ship a
 *                payments-team-approved mainnet config
 *   Reference: services/wager-program-client.ts `assertWagerBroadcastCluster`
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import {
  db,
  eq,
  and,
  desc,
  sql,
  lobbies,
  lobbyPlayers,
  lobbyEvents,
  avatars,
  wagerChainIntents,
  type Lobby,
  type LobbyPlayer,
  type WagerChainIntent,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  resolveAgentSession,
  AGENT_SESSION_HEADER,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { isGuestUser, requireNonGuestIdentity } from '../middleware/require-non-guest';
import { adminOnly } from '../middleware/admin-only';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { logEventFromContext } from '../services/event-logger';
import {
  WagerClientError,
  assertWagerLobbyIdInEnvNamespace,
  createSolLobby,
  joinSolLobby,
  lockLobby as chainLockLobby,
  settleSolLobby,
  cancelLobby as chainCancelLobby,
  claimSolRefund,
  deriveCreateSolLobbyIntentPda,
  deriveJoinSolLobbyIntentPda,
  finalizeConfirmedWagerIntent,
  reconcileWagerChainIntent,
  withResolvedWagerLobbyFence,
  WagerIntentFenceError,
  resolveVerifiedWagerBroadcastCluster,
  resolveWagerLobbyNamespaceEnv,
  type VerifiedWagerBroadcastCluster,
} from '../services/wager-program-client';
import { withKeyedMutex } from '../services/keyed-mutex';

interface WagerRouteContext extends ActivityAuthContext {
  Variables: ActivityAuthContext['Variables'] & {
    wagerAdminWithoutAvatarUserId?: string;
  };
}

export const wagerRoutes = new Hono<WagerRouteContext>();
wagerRoutes.use('*', sessionMiddleware);

// ─── shared per-IP rate limiters (cheap and bounded) ──────────────────────

const writeLimiter = createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 });
const readLimiter = createRateLimiter({ maxPerWindow: 120, windowMs: 60_000 });

function checkRate(limiter: ReturnType<typeof createRateLimiter>, ip: string) {
  if (!limiter.check(ip)) {
    throw new HTTPException(429, { message: 'rate_limited' });
  }
}

// ─── invite code helper ───────────────────────────────────────────────────

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit similar chars (I/0/1/O/L)
function generateInviteCode(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  }
  return out;
}

// ─── helpers ──────────────────────────────────────────────────────────────

const visibilityValues = ['public', 'private', 'friends'] as const;
const modeValues = ['multiplayer', 'solo-bots'] as const;

const createLobbySchema = z
  .object({
    activityId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, 'activityId must be kebab-case slug'),
    roomId: z.string().min(1).max(128),
    wagerAmountLamports: z.coerce
      .bigint()
      .nonnegative()
      .max(100_000_000_000n, 'wager > 100 SOL not allowed'),
    /** Reserved for future SPL — null/undefined for SOL or free. */
    wagerMint: z.string().min(32).max(64).nullable().optional(),
    maxPlayers: z.coerce.number().int().min(2).max(16),
    visibility: z.enum(visibilityValues),
    mode: z.enum(modeValues).default('multiplayer'),
  })
  .strict();

const lobbyIdParam = z.string().uuid();
const listQuerySchema = z
  .object({
    activityId: z.string().optional(),
    roomId: z.string().optional(),
    state: z.enum(['open', 'locked', 'settled', 'cancelled']).optional(),
    mine: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const settleSchema = z
  .object({ winnerAvatarId: z.string().uuid() })
  .strict();

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function serializeLobby(row: Lobby) {
  return {
    ...row,
    lobbyId: row.lobbyId.toString(),
    wagerAmountLamports: row.wagerAmountLamports.toString(),
    createdAt: row.createdAt.toISOString(),
    lockedAt: row.lockedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

export function handleWagerClientError(err: unknown): never {
  if (err instanceof WagerIntentFenceError) {
    throw new HTTPException(503, { message: 'wager_intent_reconciliation_required' });
  }
  if (err instanceof WagerClientError) {
    if (err.code === 'state_noop') throw new HTTPException(409, { message: err.message });
    if (err.code === 'rpc_unreachable') throw new HTTPException(503, { message: err.message });
    if (err.code === 'authority_missing')
      throw new HTTPException(500, { message: err.message });
    if (err.code === 'avatar_wallet_missing')
      throw new HTTPException(400, { message: err.message });
    if (err.code === 'pubkey_mismatch')
      throw new HTTPException(500, { message: err.message });
    if (err.code === 'network_refused')
      throw new HTTPException(503, { message: err.message });
    if (err.code === 'namespace_violation')
      throw new HTTPException(500, {
        message: `wager_namespace_configuration_fault: ${err.message}`,
      });
    if (err.code === 'on_chain_error')
      throw new HTTPException(400, { message: err.message });
    if (err.code === 'insufficient_funds')
      throw new HTTPException(400, { message: err.message });
  }
  throw err;
}

function serializeLobbyPlayer(row: LobbyPlayer) {
  return {
    ...row,
    depositAmountLamports: row.depositAmountLamports.toString(),
    depositedAt: row.depositedAt.toISOString(),
    refundedAt: row.refundedAt?.toISOString() ?? null,
  };
}

interface WagerReadIdentity {
  kind: 'user' | 'agent';
  userId: string;
  avatarId: string | null;
}

/** Resolve ownership for public reads without making the public route auth-only. */
async function resolveOptionalWagerReadIdentity(c: any): Promise<WagerReadIdentity | null> {
  const user = c.get('user') as { id: string } | null;
  if (user) return { kind: 'user', userId: user.id, avatarId: null };

  const sessionId = c.req.header(AGENT_SESSION_HEADER);
  if (!sessionId) return null;
  const resolved = await resolveAgentSession(sessionId);
  if (!resolved) throw new HTTPException(401, { message: 'invalid_or_expired_agent_session' });
  if (!resolved.userId || !resolved.avatarId) {
    throw new HTTPException(403, { message: 'agent_session_not_bound_to_avatar' });
  }
  if (resolved.ledgerCapable !== true) {
    throw new HTTPException(403, { message: 'agent_session_not_ledger_authorized' });
  }
  return {
    kind: 'agent',
    userId: resolved.userId,
    avatarId: resolved.avatarId,
  };
}

async function reconcileExistingIntent(operationKey: string) {
  const intent = await db.query.wagerChainIntents.findFirst({
    where: eq(wagerChainIntents.operationKey, operationKey),
  });
  if (!intent) return null;
  if (intent.status === 'prepared') {
    return { status: 'reconcile' as const, evidence: 'pending' as const };
  }
  return reconcileWagerChainIntent(intent.id);
}

function wagerAdminIds(): string[] {
  return (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Preserve the legacy human-admin cancel path even without an active avatar. */
const requireWagerCancelCaller = createMiddleware<WagerRouteContext>(async (c, next) => {
  const user = c.get('user');
  if (user && wagerAdminIds().includes(user.id)) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
      columns: { id: true },
    });
    if (!avatar) {
      if (await isGuestUser(user.id)) {
        throw new HTTPException(403, { message: 'guest_not_allowed' });
      }
      c.set('wagerAdminWithoutAvatarUserId', user.id);
      return next();
    }
  }

  return requireAuthOrAgentSession(c, async () => {
    await requireLedgerCapableIdentity(c, async () => {
      await requireNonGuestIdentity(c, async () => {
        await next();
      });
    });
  });
});

function createOperationKey(avatarId: string, activityId: string, roomId: string): string {
  const digest = createHash('sha256')
    .update(`${avatarId}\0${activityId}\0${roomId}`)
    .digest('hex');
  return `create:${digest}`;
}

type WagerRouteDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextWagerLobbyId(tx: WagerRouteDbTx): Promise<bigint> {
  const rows = await tx.execute<{ lobby_id: string }>(
    sql`SELECT nextval('wager_lobby_id_seq')::text AS lobby_id`,
  );
  const value = rows[0]?.lobby_id;
  if (!value) throw new HTTPException(500, { message: 'wager_lobby_id_allocation_failed' });
  return BigInt(value);
}

export interface PrepareCreateDraftInput {
  operationKey: string;
  activityId: string;
  roomId: string;
  userId: string;
  avatarId: string;
  wagerAmountLamports: bigint;
  maxPlayers: number;
  visibility: (typeof visibilityValues)[number];
  inviteCode: string | null;
  resolveVerifiedCluster: () => Promise<VerifiedWagerBroadcastCluster>;
}

export function canRemintWagerCreateDraft(
  intent: Pick<WagerChainIntent, 'status' | 'txSignature'> | null,
): boolean {
  return (
    !intent ||
    (intent.txSignature === null &&
      (intent.status === 'prepared' || intent.status === 'failed'))
  );
}

/** Allocate or repair a create draft before any on-chain bytes can exist. */
export async function prepareCreateDraft(
  input: PrepareCreateDraftInput,
  overrides?: {
    withMutex?: typeof withKeyedMutex;
    transaction?: typeof db.transaction;
    findDraft?: () => Promise<Lobby | undefined>;
  },
): Promise<{ draft: Lobby; verifiedCluster?: VerifiedWagerBroadcastCluster }> {
  const runWithMutex = overrides?.withMutex ?? withKeyedMutex;
  const runTransaction = overrides?.transaction ?? db.transaction.bind(db);
  const findDraft =
    overrides?.findDraft ??
    (() =>
      db.query.lobbies.findFirst({
        where: and(
          eq(lobbies.activityId, input.activityId),
          eq(lobbies.roomId, input.roomId),
          eq(lobbies.mode, 'multiplayer'),
        ),
      }));
  return runWithMutex(input.operationKey, async () => {
    const preliminaryDraft = await findDraft();
    if (preliminaryDraft) {
      const sameRequest =
        preliminaryDraft.wagerAmountLamports === input.wagerAmountLamports &&
        preliminaryDraft.maxPlayers === input.maxPlayers &&
        preliminaryDraft.visibility === input.visibility;
      if (
        preliminaryDraft.creatorAvatarId !== input.avatarId ||
        !sameRequest ||
        preliminaryDraft.onChainCreateStatus === 'confirmed' ||
        preliminaryDraft.state === 'cancelled' ||
        preliminaryDraft.state === 'settled'
      ) {
        return { draft: preliminaryDraft };
      }
    }

    // Never hold a DB connection/transaction open across the external RPC.
    resolveWagerLobbyNamespaceEnv();
    const verifiedCluster = await input.resolveVerifiedCluster();

    return runTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wager-create:${input.operationKey}`}, 0))`,
      );

      let draft = await tx.query.lobbies.findFirst({
        where: and(
          eq(lobbies.activityId, input.activityId),
          eq(lobbies.roomId, input.roomId),
          eq(lobbies.mode, 'multiplayer'),
        ),
      });

      if (draft) {
        const sameRequest =
          draft.wagerAmountLamports === input.wagerAmountLamports &&
          draft.maxPlayers === input.maxPlayers &&
          draft.visibility === input.visibility;
        if (
          draft.creatorAvatarId !== input.avatarId ||
          !sameRequest ||
          draft.onChainCreateStatus === 'confirmed' ||
          draft.state === 'cancelled' ||
          draft.state === 'settled'
        ) {
          return { draft };
        }
      }

      if (!draft) {
        const lobbyId = await nextWagerLobbyId(tx);
        assertWagerLobbyIdInEnvNamespace(lobbyId, { verifiedCluster });
        [draft] = await tx
          .insert(lobbies)
          .values({
            lobbyId,
            activityId: input.activityId,
            roomId: input.roomId,
            creatorUserId: input.userId,
            creatorAvatarId: input.avatarId,
            wagerAmountLamports: input.wagerAmountLamports,
            wagerMint: null,
            maxPlayers: input.maxPlayers,
            joinedCount: 1,
            state: 'open',
            visibility: input.visibility,
            inviteCode: input.inviteCode,
            mode: 'multiplayer',
            onChainCreateStatus: 'prepared',
          })
          .onConflictDoNothing()
          .returning();
        if (!draft) {
          draft = await tx.query.lobbies.findFirst({
            where: and(
              eq(lobbies.activityId, input.activityId),
              eq(lobbies.roomId, input.roomId),
              eq(lobbies.mode, 'multiplayer'),
            ),
          });
        }
      }
      if (!draft) throw new HTTPException(500, { message: 'lobby_insert_failed' });
      if (draft.creatorAvatarId !== input.avatarId) return { draft };
      const sameRequest =
        draft.wagerAmountLamports === input.wagerAmountLamports &&
        draft.maxPlayers === input.maxPlayers &&
        draft.visibility === input.visibility;
      if (!sameRequest) return { draft };
      if (
        draft.onChainCreateStatus === 'confirmed' ||
        draft.state === 'cancelled' ||
        draft.state === 'settled'
      ) {
        return { draft };
      }

      try {
        assertWagerLobbyIdInEnvNamespace(draft.lobbyId, { verifiedCluster });
        return { draft, verifiedCluster };
      } catch (err) {
        if (
          !(err instanceof WagerClientError) ||
          err.code !== 'namespace_violation' ||
          err.namespaceReason !== 'id_out_of_range'
        ) {
          throw err;
        }

        // Serialize against durable signature capture using its exact lobby fence.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wager-lobby:${draft.id}`}, 0))`,
        );
        const lockedDraft = await tx.query.lobbies.findFirst({
          where: eq(lobbies.id, draft.id),
        });
        if (!lockedDraft) throw new HTTPException(500, { message: 'lobby_lookup_failed' });
        try {
          assertWagerLobbyIdInEnvNamespace(lockedDraft.lobbyId, { verifiedCluster });
          return { draft: lockedDraft, verifiedCluster };
        } catch (lockedErr) {
          if (
            !(lockedErr instanceof WagerClientError) ||
            lockedErr.namespaceReason !== 'id_out_of_range'
          ) {
            throw lockedErr;
          }
        }

        const intent = await tx.query.wagerChainIntents.findFirst({
          where: eq(wagerChainIntents.operationKey, input.operationKey),
        });
        const oldTargetPda = deriveCreateSolLobbyIntentPda(lockedDraft.lobbyId).toBase58();
        const identityMatches = intent
          ? intent.operation === 'create' &&
            intent.lobbyId === lockedDraft.id &&
            intent.actorAvatarId === input.avatarId &&
            intent.targetPda === oldTargetPda
          : lockedDraft.onChainCreateStatus === 'prepared';
        const unsignedRetryable =
          lockedDraft.state === 'open' &&
          (lockedDraft.onChainCreateStatus === 'prepared' ||
            lockedDraft.onChainCreateStatus === 'failed') &&
          identityMatches &&
          canRemintWagerCreateDraft(intent ?? null);
        if (!unsignedRetryable) throw err;

        const lobbyId = await nextWagerLobbyId(tx);
        assertWagerLobbyIdInEnvNamespace(lobbyId, { verifiedCluster });
        const targetPda = deriveCreateSolLobbyIntentPda(lobbyId).toBase58();

        if (intent) {
          const [updatedIntent] = await tx
            .update(wagerChainIntents)
            .set({
              status: 'failed',
              targetPda,
              txSignature: null,
              blockhash: null,
              lastValidBlockHeight: null,
              lastError: 'namespace_reminted',
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(wagerChainIntents.id, intent.id),
                eq(wagerChainIntents.operation, 'create'),
                eq(wagerChainIntents.lobbyId, lockedDraft.id),
                eq(wagerChainIntents.actorAvatarId, input.avatarId),
                eq(wagerChainIntents.targetPda, oldTargetPda),
                sql`${wagerChainIntents.status} IN ('prepared','failed')`,
                sql`${wagerChainIntents.txSignature} IS NULL`,
              ),
            )
            .returning();
          if (!updatedIntent) throw err;
        }

        const [updatedDraft] = await tx
          .update(lobbies)
          .set({
            lobbyId,
            onChainCreateStatus: intent ? 'failed' : 'prepared',
          })
          .where(
            and(
              eq(lobbies.id, lockedDraft.id),
              eq(lobbies.lobbyId, lockedDraft.lobbyId),
              eq(lobbies.state, 'open'),
              sql`${lobbies.onChainCreateStatus} IN ('prepared','failed')`,
            ),
          )
          .returning();
        if (!updatedDraft) throw err;
        return { draft: updatedDraft, verifiedCluster };
      }
    });
  });
}

async function reserveWagerIntent(input: {
  operationKey: string;
  operation: 'create' | 'join';
  lobbyId: string;
  actorAvatarId: string;
  targetPda: string;
}): Promise<{ intent: WagerChainIntent; mayBroadcast: boolean }> {
  const [inserted] = await db
    .insert(wagerChainIntents)
    .values(input)
    .onConflictDoNothing({ target: wagerChainIntents.operationKey })
    .returning();
  if (inserted) return { intent: inserted, mayBroadcast: true };

  const existing = await db.query.wagerChainIntents.findFirst({
    where: eq(wagerChainIntents.operationKey, input.operationKey),
  });
  if (!existing) throw new HTTPException(500, { message: 'wager_intent_lookup_failed' });
  if (
    existing.operation !== input.operation ||
    existing.lobbyId !== input.lobbyId ||
    existing.actorAvatarId !== input.actorAvatarId ||
    existing.targetPda !== input.targetPda
  ) {
    throw new HTTPException(409, { message: 'wager_intent_identity_conflict' });
  }

  // A failed intent is mechanically unsigned (DB CHECK). Exactly one retry may
  // claim it back to prepared; signed/reconcile intents are never reset.
  if (existing.status === 'failed') {
    const [reclaimed] = await db
      .update(wagerChainIntents)
      .set({ status: 'prepared', lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(wagerChainIntents.id, existing.id),
          eq(wagerChainIntents.status, 'failed'),
          sql`${wagerChainIntents.txSignature} IS NULL`,
        ),
      )
      .returning();
    if (reclaimed) return { intent: reclaimed, mayBroadcast: true };
  }

  return { intent: existing, mayBroadcast: false };
}

// ─── POST /lobbies ────────────────────────────────────────────────────────

wagerRoutes.post(
  '/lobbies',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
  checkRate(writeLimiter, getClientIp(c.req.raw.headers));

  const body = await c.req.json().catch(() => null);
  const parsed = createLobbySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const input = parsed.data;

  // SPL gate
  if (input.wagerMint != null) {
    throw new HTTPException(503, {
      message: 'spl_wager_disabled — see FEATURE_GATE wager-spl-lobbies',
    });
  }

  const identity = c.get('identity');
  const userId = identity.userId;
  const avatarId = identity.avatarId;

  // Visibility: private requires invite code (auto-generated below).
  const inviteCode =
    input.visibility === 'public' ? null : generateInviteCode(12);

  // solo-bots short-circuits the on-chain flow.
  if (input.mode === 'solo-bots') {
    if (input.wagerAmountLamports > 0n) {
      throw new HTTPException(400, {
        message: 'solo-bots cannot have a wager (escrow bypassed)',
      });
    }
    const [row] = await db
      .insert(lobbies)
      .values({
        activityId: input.activityId,
        roomId: input.roomId,
        creatorUserId: userId,
        creatorAvatarId: avatarId,
        wagerAmountLamports: 0n,
        wagerMint: null,
        maxPlayers: input.maxPlayers,
        joinedCount: 1,
        state: 'open',
        visibility: input.visibility,
        inviteCode,
        mode: 'solo-bots',
      })
      .returning();
    if (!row) throw new HTTPException(500, { message: 'lobby_insert_failed' });

    await db.insert(lobbyEvents).values({
      lobbyId: row.id,
      kind: 'created',
      actorUserId: userId,
      txSig: null,
      rawEventJson: { mode: 'solo-bots', wagerAmount: '0' },
    });

    void logEventFromContext(c, {
      eventType: 'wager.lobby.created',
      userId,
      avatarId,
      payload: {
        activityId: input.activityId,
        roomId: input.roomId,
        mode: 'solo-bots',
        wagerLamports: '0',
        maxPlayers: input.maxPlayers,
        visibility: input.visibility,
      },
    });

    return c.json({ lobby: serializeLobby(row) }, 201);
  }

  // Multiplayer (real lobby).
  // A room is the immutable match-instance identity. Replaying the same create
  // after a lost response must return its row instead of depositing again. A
  // terminal room cannot be recycled into a new escrow deposit; callers must
  // mint a fresh room id. The partial-UNIQUE index closes the first-create race.
  const operationKey = createOperationKey(avatarId, input.activityId, input.roomId);
  let verifiedCluster: VerifiedWagerBroadcastCluster | undefined;
  let draft: Lobby;
  try {
    const prepared = await prepareCreateDraft({
      operationKey,
      activityId: input.activityId,
      roomId: input.roomId,
      userId,
      avatarId,
      wagerAmountLamports: input.wagerAmountLamports,
      maxPlayers: input.maxPlayers,
      visibility: input.visibility,
      inviteCode,
      resolveVerifiedCluster: () =>
        resolveVerifiedWagerBroadcastCluster('createSolLobby'),
    });
    draft = prepared.draft;
    verifiedCluster = prepared.verifiedCluster;
  } catch (err) {
    handleWagerClientError(err);
  }

  if (draft.creatorAvatarId !== avatarId) {
    return c.json({ error: 'active_lobby_owned_by_another_avatar' }, 409);
  }

  const sameDraftRequest =
    draft.wagerAmountLamports === input.wagerAmountLamports &&
    draft.maxPlayers === input.maxPlayers &&
    draft.visibility === input.visibility &&
    draft.creatorAvatarId === avatarId;
  if (!sameDraftRequest) {
    return c.json({ error: 'active_lobby_request_conflict' }, 409);
  }

  if (draft.state === 'cancelled' || draft.state === 'settled') {
    // Terminal retries still repair a landed create whose response/DB
    // finalization was lost. Without this, the creator Player witness can
    // never be recovered and `/refund` reports not_in_lobby forever.
    const reconciled = await reconcileExistingIntent(operationKey);
    if (reconciled?.status === 'reconcile') {
      return c.json({ error: 'wager_create_reconciliation_required' }, 503);
    }
    return c.json({ error: 'match_room_terminal', state: draft.state }, 409);
  }

  if (draft.onChainCreateStatus === 'confirmed') {
    const existingIntent = await db.query.wagerChainIntents.findFirst({
      where: eq(wagerChainIntents.operationKey, operationKey),
    });
    if (existingIntent?.status === 'confirmed') {
      await finalizeConfirmedWagerIntent(existingIntent.id);
    }
    const replay = await db.query.lobbies.findFirst({
      where: eq(lobbies.id, draft.id),
    });
    if (!replay) throw new HTTPException(500, { message: 'lobby_update_failed' });
    return c.json({ lobby: serializeLobby(replay), idempotent: true }, 200);
  }

  const targetPda = deriveCreateSolLobbyIntentPda(draft.lobbyId);
  let reserved = await reserveWagerIntent({
    operationKey,
    operation: 'create',
    lobbyId: draft.id,
    actorAvatarId: avatarId,
    targetPda: targetPda.toBase58(),
  });
  if (!reserved.mayBroadcast) {
    const reconciled =
      reserved.intent.status === 'prepared'
        ? { status: 'reconcile' as const, evidence: 'pending' as const }
        : await reconcileWagerChainIntent(reserved.intent.id);
    if (reconciled.status === 'confirmed') {
      const replay = await db.query.lobbies.findFirst({
        where: eq(lobbies.id, draft.id),
      });
      if (!replay) throw new HTTPException(500, { message: 'lobby_update_failed' });
      return c.json({ lobby: serializeLobby(replay), idempotent: true }, 200);
    }
    if (reconciled.status === 'failed') {
      reserved = await reserveWagerIntent({
        operationKey,
        operation: 'create',
        lobbyId: draft.id,
        actorAvatarId: avatarId,
        targetPda: targetPda.toBase58(),
      });
    }
  }

  // Issue create_lobby_sol. A signed/ambiguous intent is retained forever;
  // only the unsigned `failed` state is eligible for a guarded retry.
  let createTxSig: string;
  try {
    if (!reserved.mayBroadcast) {
      if (reserved.intent.status !== 'confirmed' || !reserved.intent.txSignature) {
        return c.json(
          { error: 'wager_create_reconciliation_required', lobbyId: draft.id },
          503,
        );
      }
      createTxSig = reserved.intent.txSignature;
    } else {
      if (!verifiedCluster) {
        throw new HTTPException(500, { message: 'wager_cluster_proof_missing' });
      }
      const createResult = await createSolLobby({
        creatorAvatarId: avatarId,
        lobbyIdBigint: draft.lobbyId,
        wagerAmountLamports: draft.wagerAmountLamports,
        maxPlayers: draft.maxPlayers,
        intentId: reserved.intent.id,
      }, { verifiedCluster });
      createTxSig = createResult.txSig;
    }
  } catch (err) {
    const intent = await db.query.wagerChainIntents.findFirst({
      where: eq(wagerChainIntents.id, reserved.intent.id),
      columns: { status: true },
    });
    if (intent) {
      await db
        .update(lobbies)
        .set({ onChainCreateStatus: intent.status })
        .where(eq(lobbies.id, draft.id));
    }
    handleWagerClientError(err);
  }

  await finalizeConfirmedWagerIntent(reserved.intent.id);
  const updated = await db.query.lobbies.findFirst({
    where: eq(lobbies.id, draft.id),
  });
  if (!updated) throw new HTTPException(500, { message: 'lobby_update_failed' });

  void logEventFromContext(c, {
    eventType: 'wager.lobby.created',
    userId,
    avatarId,
    payload: {
      activityId: input.activityId,
      roomId: input.roomId,
      mode: 'multiplayer',
      wagerLamports: draft.wagerAmountLamports.toString(),
      maxPlayers: input.maxPlayers,
      visibility: input.visibility,
      txSig: createTxSig,
    },
  });

  return c.json({ lobby: serializeLobby(updated) }, 201);
  },
);

// ─── GET /lobbies ─────────────────────────────────────────────────────────

wagerRoutes.get('/lobbies', async (c) => {
  checkRate(readLimiter, getClientIp(c.req.raw.headers));

  const parsed = listQuerySchema.safeParse({
    activityId: c.req.query('activityId'),
    roomId: c.req.query('roomId'),
    state: c.req.query('state'),
    mine: c.req.query('mine'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_query: ' + parsed.error.message });
  }
  const { activityId, roomId, state, mine, limit } = parsed.data;
  const readIdentity = await resolveOptionalWagerReadIdentity(c);

  const filters: Parameters<typeof and>[number][] = [
    eq(lobbies.onChainCreateStatus, 'confirmed'),
  ];
  if (activityId) filters.push(eq(lobbies.activityId, activityId));
  if (roomId) filters.push(eq(lobbies.roomId, roomId));
  if (state) filters.push(eq(lobbies.state, state));
  if (mine) {
    if (!readIdentity) throw new HTTPException(401, { message: 'mine_requires_auth' });
    filters.push(
      readIdentity.kind === 'agent' && readIdentity.avatarId
        ? eq(lobbies.creatorAvatarId, readIdentity.avatarId)
        : eq(lobbies.creatorUserId, readIdentity.userId),
    );
  }

  const rows = await db
    .select()
    .from(lobbies)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(lobbies.createdAt))
    .limit(limit);

  // Hide invite codes from list responses for private/friends rows the caller
  // doesn't own. Public lobbies have null invite_code anyway.
  const serialized = rows.map((row) => {
    const s = serializeLobby(row);
    const ownsLobby =
      readIdentity?.kind === 'agent'
        ? row.creatorAvatarId === readIdentity.avatarId
        : row.creatorUserId === readIdentity?.userId;
    if (
      (row.visibility === 'private' || row.visibility === 'friends') &&
      !ownsLobby
    ) {
      s.inviteCode = null;
    }
    return s;
  });

  return c.json({ lobbies: serialized });
});

// ─── GET /lobbies/:idOrInviteCode ─────────────────────────────────────────

wagerRoutes.get('/lobbies/:idOrInviteCode', async (c) => {
  checkRate(readLimiter, getClientIp(c.req.raw.headers));
  const idOrInvite = c.req.param('idOrInviteCode');
  const readIdentity = await resolveOptionalWagerReadIdentity(c);

  let row: Lobby | undefined;
  if (isUuid(idOrInvite)) {
    row = await db.query.lobbies.findFirst({ where: eq(lobbies.id, idOrInvite) });
  } else {
    row = await db.query.lobbies.findFirst({
      where: eq(lobbies.inviteCode, idOrInvite),
    });
  }
  if (!row || row.onChainCreateStatus !== 'confirmed') {
    throw new HTTPException(404, { message: 'lobby_not_found' });
  }

  const players = await db
    .select({
      id: lobbyPlayers.id,
      userId: lobbyPlayers.userId,
      avatarId: lobbyPlayers.avatarId,
      depositAmountLamports: lobbyPlayers.depositAmountLamports,
      depositedAt: lobbyPlayers.depositedAt,
      refunded: lobbyPlayers.refunded,
      refundedAt: lobbyPlayers.refundedAt,
      onChainJoinSig: lobbyPlayers.onChainJoinSig,
      avatarName: avatars.name,
    })
    .from(lobbyPlayers)
    .leftJoin(avatars, eq(lobbyPlayers.avatarId, avatars.id))
    .where(eq(lobbyPlayers.lobbyId, row.id))
    .orderBy(desc(lobbyPlayers.depositedAt));

  const s = serializeLobby(row);
  const ownsLobby =
    readIdentity?.kind === 'agent'
      ? row.creatorAvatarId === readIdentity.avatarId
      : row.creatorUserId === readIdentity?.userId;
  if (
    (row.visibility === 'private' || row.visibility === 'friends') &&
    !ownsLobby
  ) {
    s.inviteCode = null;
  }
  return c.json({
    lobby: s,
    players: players.map((p) => ({
      ...p,
      depositAmountLamports: p.depositAmountLamports.toString(),
      depositedAt: p.depositedAt.toISOString(),
      refundedAt: p.refundedAt?.toISOString() ?? null,
    })),
  });
});

// ─── POST /lobbies/:id/join ───────────────────────────────────────────────

wagerRoutes.post(
  '/lobbies/:id/join',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
  checkRate(writeLimiter, getClientIp(c.req.raw.headers));
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });

  const identity = c.get('identity');
  const userId = identity.userId;
  const avatarId = identity.avatarId;

  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  if (lobby.mode === 'solo-bots') {
    throw new HTTPException(400, { message: 'solo_bots_lobby_cannot_join' });
  }

  // Already joined?
  const existing = await db.query.lobbyPlayers.findFirst({
    where: and(
      eq(lobbyPlayers.lobbyId, lobby.id),
      eq(lobbyPlayers.avatarId, avatarId),
    ),
  });
  if (existing) return c.json({ lobby: serializeLobby(lobby), idempotent: true });

  const joinOperationKey = `join:${lobby.id}:${avatarId}`;
  const existingIntent = await db.query.wagerChainIntents.findFirst({
    where: eq(wagerChainIntents.operationKey, joinOperationKey),
  });
  if (existingIntent) {
    const reconciled =
      existingIntent.status === 'prepared'
        ? { status: 'reconcile' as const, evidence: 'pending' as const }
        : await reconcileWagerChainIntent(existingIntent.id);
    if (reconciled.status === 'confirmed') {
      const replay = await db.query.lobbies.findFirst({
        where: eq(lobbies.id, lobby.id),
      });
      return c.json({ lobby: replay ? serializeLobby(replay) : null, idempotent: true });
    }
    if (reconciled.status === 'reconcile') {
      return c.json({ error: 'wager_join_reconciliation_required' }, 503);
    }
  }

  // State rejection happens only AFTER an existing intent had a chance to
  // repair its Player witness. This is critical for landed joins whose creator
  // cancelled before the join response reached the caller.
  if (lobby.onChainCreateStatus !== 'confirmed') {
    return c.json({ error: 'wager_create_reconciliation_required' }, 503);
  }
  if (lobby.state !== 'open') {
    throw new HTTPException(409, { message: `lobby_state_${lobby.state}` });
  }
  if (lobby.joinedCount >= lobby.maxPlayers) {
    throw new HTTPException(409, { message: 'lobby_full' });
  }

  const targetPda = await deriveJoinSolLobbyIntentPda({
    lobbyIdBigint: lobby.lobbyId,
    joinerAvatarId: avatarId,
  });
  let reserved = await reserveWagerIntent({
    operationKey: joinOperationKey,
    operation: 'join',
    lobbyId: lobby.id,
    actorAvatarId: avatarId,
    targetPda: targetPda.toBase58(),
  });
  if (!reserved.mayBroadcast) {
    const reconciled =
      reserved.intent.status === 'prepared'
        ? { status: 'reconcile' as const, evidence: 'pending' as const }
        : await reconcileWagerChainIntent(reserved.intent.id);
    if (reconciled.status === 'confirmed') {
      const replay = await db.query.lobbies.findFirst({
        where: eq(lobbies.id, lobby.id),
      });
      return c.json({ lobby: replay ? serializeLobby(replay) : null, idempotent: true });
    }
    if (reconciled.status === 'failed') {
      reserved = await reserveWagerIntent({
        operationKey: joinOperationKey,
        operation: 'join',
        lobbyId: lobby.id,
        actorAvatarId: avatarId,
        targetPda: targetPda.toBase58(),
      });
    }
  }

  // Issue join_lobby_sol once. Confirmed intents can repair a DB finalization
  // crash; sending/reconcile/prepared intents are never re-broadcast.
  let joinTxSig: string;
  try {
    if (!reserved.mayBroadcast) {
      if (reserved.intent.status !== 'confirmed' || !reserved.intent.txSignature) {
        return c.json({ error: 'wager_join_reconciliation_required' }, 503);
      }
      joinTxSig = reserved.intent.txSignature;
    } else {
      const joinResult = await joinSolLobby({
        joinerAvatarId: avatarId,
        lobbyIdBigint: lobby.lobbyId,
        intentId: reserved.intent.id,
      });
      joinTxSig = joinResult.txSig;
    }
  } catch (err) {
    handleWagerClientError(err);
  }

  await finalizeConfirmedWagerIntent(reserved.intent.id);
  const updated = await db.query.lobbies.findFirst({
    where: eq(lobbies.id, lobby.id),
  });

  void logEventFromContext(c, {
    eventType: 'wager.lobby.joined',
    userId,
    avatarId,
    payload: {
      lobbyId: lobby.id,
      onChainLobbyId: lobby.lobbyId.toString(),
      activityId: lobby.activityId,
      txSig: joinTxSig,
    },
  });

  return c.json({ lobby: updated ? serializeLobby(updated) : null });
  },
);

// ─── POST /lobbies/:id/lock ───────────────────────────────────────────────
// Admin / match-server only. Idempotent: returns 409 if state != open.

wagerRoutes.post('/lobbies/:id/lock', adminOnly, async (c) => {
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });

  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  if (lobby.mode === 'solo-bots') {
    // No-op for solo-bots; just mark it locked off-chain so the FE sees state.
    if (lobby.state === 'locked') {
      return c.json({ lobby: serializeLobby(lobby), idempotent: true });
    }
    if (lobby.state !== 'open') {
      throw new HTTPException(409, { message: `lobby_state_${lobby.state}` });
    }
    const [updated] = await db
      .update(lobbies)
      .set({ state: 'locked', lockedAt: new Date() })
      .where(eq(lobbies.id, lobby.id))
      .returning();
    await db.insert(lobbyEvents).values({
      lobbyId: lobby.id,
      kind: 'locked',
      txSig: null,
      rawEventJson: { mode: 'solo-bots' },
    });
    return c.json({ lobby: updated ? serializeLobby(updated) : null });
  }

  try {
    const fenced = await withResolvedWagerLobbyFence(lobby.id, async (tx) => {
      const current = await tx.query.lobbies.findFirst({
        where: eq(lobbies.id, lobby.id),
      });
      if (!current) throw new HTTPException(404, { message: 'lobby_not_found' });
      if (current.state === 'locked') {
        return { lobby: current, idempotent: true as const, txSig: null };
      }
      if (current.onChainCreateStatus !== 'confirmed') {
        throw new HTTPException(503, { message: 'wager_create_reconciliation_required' });
      }
      if (current.state !== 'open') {
        throw new HTTPException(409, { message: `lobby_state_${current.state}` });
      }

      const result = await chainLockLobby({ lobbyIdBigint: current.lobbyId });
      const [updated] = await tx
        .update(lobbies)
        .set({ state: 'locked', lockedAt: new Date(), onChainLockSig: result.txSig })
        .where(eq(lobbies.id, current.id))
        .returning();
      return { lobby: updated ?? current, idempotent: false as const, txSig: result.txSig };
    });

    if (fenced.idempotent) {
      return c.json({ lobby: serializeLobby(fenced.lobby), idempotent: true });
    }
    void logEventFromContext(c, {
      eventType: 'wager.lobby.locked',
      payload: {
        lobbyId: lobby.id,
        onChainLobbyId: lobby.lobbyId.toString(),
        txSig: fenced.txSig,
      },
    });
    return c.json({ lobby: serializeLobby(fenced.lobby) });
  } catch (err) {
    handleWagerClientError(err);
  }
});

// ─── POST /lobbies/:id/settle ─────────────────────────────────────────────

wagerRoutes.post('/lobbies/:id/settle', adminOnly, async (c) => {
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });
  const body = await c.req.json().catch(() => null);
  const parsed = settleSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const { winnerAvatarId } = parsed.data;

  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  const winnerAvatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, winnerAvatarId),
    columns: { id: true, userId: true },
  });
  if (!winnerAvatar) throw new HTTPException(400, { message: 'winner_avatar_unknown' });

  if (lobby.mode === 'solo-bots') {
    if (lobby.state === 'settled') {
      return c.json({ lobby: serializeLobby(lobby), idempotent: true });
    }
    if (lobby.state !== 'locked') {
      throw new HTTPException(409, { message: `lobby_state_${lobby.state}` });
    }
    const [updated] = await db
      .update(lobbies)
      .set({
        state: 'settled',
        settledAt: new Date(),
        settledWinnerUserId: winnerAvatar.userId,
        settledWinnerAvatarId: winnerAvatarId,
      })
      .where(eq(lobbies.id, lobby.id))
      .returning();
    await db.insert(lobbyEvents).values({
      lobbyId: lobby.id,
      kind: 'settled',
      txSig: null,
      rawEventJson: { mode: 'solo-bots', winnerAvatarId },
    });
    return c.json({ lobby: updated ? serializeLobby(updated) : null });
  }

  try {
    const fenced = await withResolvedWagerLobbyFence(lobby.id, async (tx) => {
      const current = await tx.query.lobbies.findFirst({
        where: eq(lobbies.id, lobby.id),
      });
      if (!current) throw new HTTPException(404, { message: 'lobby_not_found' });
      if (current.state === 'settled') {
        return {
          lobby: current,
          idempotent: true as const,
          payoutLamports: null,
          rakeLamports: null,
          txSig: null,
        };
      }
      if (current.onChainCreateStatus !== 'confirmed') {
        throw new HTTPException(503, { message: 'wager_create_reconciliation_required' });
      }
      if (current.state !== 'locked') {
        throw new HTTPException(409, { message: `lobby_state_${current.state}` });
      }
      const winnerRow = await tx.query.lobbyPlayers.findFirst({
        where: and(
          eq(lobbyPlayers.lobbyId, current.id),
          eq(lobbyPlayers.avatarId, winnerAvatarId),
        ),
      });
      if (!winnerRow) {
        throw new HTTPException(400, { message: 'winner_not_in_lobby' });
      }

      const result = await settleSolLobby({
        lobbyIdBigint: current.lobbyId,
        winnerAvatarId,
      });
      const [updated] = await tx
        .update(lobbies)
        .set({
          state: 'settled',
          settledAt: new Date(),
          settledWinnerUserId: winnerAvatar.userId,
          settledWinnerAvatarId: winnerAvatarId,
          onChainSettleSig: result.txSig,
        })
        .where(eq(lobbies.id, current.id))
        .returning();
      return {
        lobby: updated ?? current,
        idempotent: false as const,
        payoutLamports: result.payoutLamports,
        rakeLamports: result.rakeLamports,
        txSig: result.txSig,
      };
    });

    if (fenced.idempotent) {
      return c.json({ lobby: serializeLobby(fenced.lobby), idempotent: true });
    }
    void logEventFromContext(c, {
      eventType: 'wager.lobby.settled',
      payload: {
        lobbyId: lobby.id,
        onChainLobbyId: lobby.lobbyId.toString(),
        winnerAvatarId,
        payoutLamports: fenced.payoutLamports.toString(),
        rakeLamports: fenced.rakeLamports.toString(),
        txSig: fenced.txSig,
      },
    });
    return c.json({
      lobby: serializeLobby(fenced.lobby),
      payoutLamports: fenced.payoutLamports.toString(),
      rakeLamports: fenced.rakeLamports.toString(),
    });
  } catch (err) {
    handleWagerClientError(err);
  }
});

// ─── POST /lobbies/:id/cancel ─────────────────────────────────────────────

wagerRoutes.post(
  '/lobbies/:id/cancel',
  requireWagerCancelCaller,
  async (c) => {
  checkRate(writeLimiter, getClientIp(c.req.raw.headers));
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });

  const adminWithoutAvatarUserId = c.get('wagerAdminWithoutAvatarUserId');
  const identity = adminWithoutAvatarUserId ? null : c.get('identity');
  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  if (lobby.state === 'cancelled') {
    if (lobby.mode === 'multiplayer') {
      try {
        await withResolvedWagerLobbyFence(lobby.id, async () => undefined);
      } catch (err) {
        handleWagerClientError(err);
      }
    }
    return c.json({ lobby: serializeLobby(lobby), idempotent: true });
  }

  // Authorization: creator (state=open) or admin (state in open|locked).
  // adminOnly is checked separately via ADMIN_USER_IDS env list — we replicate
  // that check here inline so the route can accept BOTH the creator and an
  // admin caller without forcing the FE to know which.
  const isAdmin =
    adminWithoutAvatarUserId !== undefined ||
    (identity?.kind === 'user' && wagerAdminIds().includes(identity.userId));
  const isCreator = identity ? lobby.creatorAvatarId === identity.avatarId : false;

  let signerKind: 'creator' | 'settlement-authority';
  if (isAdmin) {
    if (lobby.state !== 'open' && lobby.state !== 'locked') {
      throw new HTTPException(409, { message: `lobby_state_${lobby.state}` });
    }
    signerKind = 'settlement-authority';
  } else if (isCreator) {
    if (lobby.state !== 'open') {
      throw new HTTPException(409, {
        message: `creator_cannot_cancel_state_${lobby.state}`,
      });
    }
    signerKind = 'creator';
  } else {
    throw new HTTPException(403, { message: 'not_creator_or_admin' });
  }

  if (lobby.mode === 'solo-bots') {
    const [updated] = await db
      .update(lobbies)
      .set({ state: 'cancelled', cancelledAt: new Date() })
      .where(eq(lobbies.id, lobby.id))
      .returning();
    await db.insert(lobbyEvents).values({
      lobbyId: lobby.id,
      kind: 'cancelled',
      actorUserId: adminWithoutAvatarUserId ?? identity?.userId ?? null,
      txSig: null,
      rawEventJson: { mode: 'solo-bots' },
    });
    return c.json({ lobby: updated ? serializeLobby(updated) : null });
  }

  try {
    const fenced = await withResolvedWagerLobbyFence(lobby.id, async (tx) => {
      const current = await tx.query.lobbies.findFirst({
        where: eq(lobbies.id, lobby.id),
      });
      if (!current) throw new HTTPException(404, { message: 'lobby_not_found' });
      if (current.state === 'cancelled') {
        return { lobby: current, idempotent: true as const, txSig: null };
      }
      if (current.onChainCreateStatus !== 'confirmed') {
        throw new HTTPException(503, { message: 'wager_create_reconciliation_required' });
      }
      if (signerKind === 'settlement-authority') {
        if (current.state !== 'open' && current.state !== 'locked') {
          throw new HTTPException(409, { message: `lobby_state_${current.state}` });
        }
      } else if (current.state !== 'open') {
        throw new HTTPException(409, {
          message: `creator_cannot_cancel_state_${current.state}`,
        });
      }

      const result = await chainCancelLobby({
        lobbyIdBigint: current.lobbyId,
        signerKind,
      });
      const [updated] = await tx
        .update(lobbies)
        .set({
          state: 'cancelled',
          cancelledAt: new Date(),
          onChainCancelSig: result.txSig,
        })
        .where(eq(lobbies.id, current.id))
        .returning();
      return { lobby: updated ?? current, idempotent: false as const, txSig: result.txSig };
    });

    if (fenced.idempotent) {
      return c.json({ lobby: serializeLobby(fenced.lobby), idempotent: true });
    }
    void logEventFromContext(c, {
      eventType: 'wager.lobby.cancelled',
      userId: adminWithoutAvatarUserId ?? identity?.userId,
      avatarId: identity?.avatarId,
      payload: {
        lobbyId: lobby.id,
        onChainLobbyId: lobby.lobbyId.toString(),
        signerKind,
        txSig: fenced.txSig,
      },
    });
    return c.json({ lobby: serializeLobby(fenced.lobby) });
  } catch (err) {
    handleWagerClientError(err);
  }
  },
);

// ─── POST /lobbies/:id/refund ─────────────────────────────────────────────

wagerRoutes.post(
  '/lobbies/:id/refund',
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
  checkRate(writeLimiter, getClientIp(c.req.raw.headers));
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });

  const identity = c.get('identity');

  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  if (lobby.state !== 'cancelled') {
    throw new HTTPException(409, { message: `lobby_not_cancelled` });
  }
  if (lobby.mode === 'multiplayer') {
    try {
      await withResolvedWagerLobbyFence(lobby.id, async () => undefined);
    } catch (err) {
      handleWagerClientError(err);
    }
  }

  const playerRow = await db.query.lobbyPlayers.findFirst({
    where: and(
      eq(lobbyPlayers.lobbyId, lobby.id),
      eq(lobbyPlayers.avatarId, identity.avatarId),
    ),
  });
  if (!playerRow) throw new HTTPException(404, { message: 'not_in_lobby' });
  if (playerRow.refunded) {
    return c.json({ playerRow: serializeLobbyPlayer(playerRow), idempotent: true });
  }

  // Solo-bots lobbies are never on-chain so refund is a no-op.
  if (lobby.mode === 'solo-bots' || playerRow.depositAmountLamports === 0n) {
    const [updated] = await db
      .update(lobbyPlayers)
      .set({ refunded: true, refundedAt: new Date() })
      .where(eq(lobbyPlayers.id, playerRow.id))
      .returning();
    await db.insert(lobbyEvents).values({
      lobbyId: lobby.id,
      kind: 'refunded',
      actorUserId: identity.userId,
      txSig: null,
      rawEventJson: { mode: lobby.mode, freePlay: true },
    });
    return c.json({ playerRow: updated ? serializeLobbyPlayer(updated) : null });
  }

  let result;
  try {
    result = await claimSolRefund({
      playerAvatarId: identity.avatarId,
      lobbyIdBigint: lobby.lobbyId,
    });
  } catch (err) {
    handleWagerClientError(err);
  }

  const [updated] = await db
    .update(lobbyPlayers)
    .set({
      refunded: true,
      refundedAt: new Date(),
      onChainRefundSig: result.txSig,
    })
    .where(eq(lobbyPlayers.id, playerRow.id))
    .returning();

  void logEventFromContext(c, {
    eventType: 'wager.lobby.refunded',
    userId: identity.userId,
    avatarId: identity.avatarId,
    payload: {
      lobbyId: lobby.id,
      onChainLobbyId: lobby.lobbyId.toString(),
      txSig: result.txSig,
    },
  });

  return c.json({
    playerRow: updated ? serializeLobbyPlayer(updated) : null,
  });
  },
);
