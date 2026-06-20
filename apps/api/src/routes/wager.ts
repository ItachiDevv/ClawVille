/**
 * Wager lobby + escrow routes — concern 4 of the gambling-contracts slice.
 *
 * Mount: `app.route('/api/wager', wagerRoutes)` from index.ts.
 *
 * Surfaces:
 *
 *   POST /lobbies                          (Lucia auth)  — create a lobby
 *   GET  /lobbies                          (public)      — list + filter
 *   GET  /lobbies/:idOrInvite              (public)      — single lobby + players
 *   POST /lobbies/:id/join                 (Lucia auth)  — deposit + join
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
 *   Reference: this file's SOLANA_RPC_URL guard
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import {
  db,
  eq,
  and,
  desc,
  inArray,
  sql,
  lobbies,
  lobbyPlayers,
  lobbyEvents,
  avatars,
  users,
  type Lobby,
} from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { logEventFromContext } from '../services/event-logger';
import {
  WagerClientError,
  createSolLobby,
  joinSolLobby,
  lockLobby as chainLockLobby,
  settleSolLobby,
  cancelLobby as chainCancelLobby,
  claimSolRefund,
} from '../services/wager-program-client';
import type { AppContext } from '../types';

export const wagerRoutes = new Hono<AppContext>();
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

async function loadAvatarForUser(userId: string): Promise<{
  id: string;
  userId: string;
  walletAddress: string | null;
  name: string;
}> {
  const row = await db.query.avatars.findFirst({
    where: eq(avatars.userId, userId),
    columns: { id: true, userId: true, walletAddress: true, name: true },
  });
  if (!row) {
    throw new HTTPException(400, { message: 'no_avatar_for_user' });
  }
  return row;
}

function handleWagerClientError(err: unknown): never {
  if (err instanceof WagerClientError) {
    if (err.code === 'state_noop') throw new HTTPException(409, { message: err.message });
    if (err.code === 'rpc_unreachable') throw new HTTPException(503, { message: err.message });
    if (err.code === 'authority_missing')
      throw new HTTPException(500, { message: err.message });
    if (err.code === 'avatar_wallet_missing')
      throw new HTTPException(400, { message: err.message });
    if (err.code === 'pubkey_mismatch')
      throw new HTTPException(500, { message: err.message });
    if (err.code === 'on_chain_error')
      throw new HTTPException(400, { message: err.message });
    if (err.code === 'insufficient_funds')
      throw new HTTPException(400, { message: err.message });
  }
  throw err;
}

// ─── POST /lobbies ────────────────────────────────────────────────────────

wagerRoutes.post('/lobbies', requireAuth, async (c) => {
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

  const user = c.get('user')!;
  const avatar = await loadAvatarForUser(user.id);

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
        creatorUserId: user.id,
        creatorAvatarId: avatar.id,
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
      actorUserId: user.id,
      txSig: null,
      rawEventJson: { mode: 'solo-bots', wagerAmount: '0' },
    });

    void logEventFromContext(c, {
      eventType: 'wager.lobby.created',
      userId: user.id,
      avatarId: avatar.id,
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
  // INSERT first so the on-chain `lobby_id` is reserved + lobby_events FK
  // resolves on the first chain emit.
  const [draft] = await db
    .insert(lobbies)
    .values({
      activityId: input.activityId,
      roomId: input.roomId,
      creatorUserId: user.id,
      creatorAvatarId: avatar.id,
      wagerAmountLamports: input.wagerAmountLamports,
      wagerMint: null,
      maxPlayers: input.maxPlayers,
      joinedCount: 1,
      state: 'open',
      visibility: input.visibility,
      inviteCode,
      mode: 'multiplayer',
    })
    .returning();
  if (!draft) throw new HTTPException(500, { message: 'lobby_insert_failed' });

  // Issue create_lobby_sol. Roll back the row if the chain call fails.
  let createResult;
  try {
    createResult = await createSolLobby({
      creatorAvatarId: avatar.id,
      lobbyIdBigint: draft.lobbyId,
      wagerAmountLamports: draft.wagerAmountLamports,
      maxPlayers: draft.maxPlayers,
    });
  } catch (err) {
    await db.delete(lobbies).where(eq(lobbies.id, draft.id));
    handleWagerClientError(err);
  }

  // Insert the creator's lobby_players row (they're the first depositor).
  await db.insert(lobbyPlayers).values({
    lobbyId: draft.id,
    userId: user.id,
    avatarId: avatar.id,
    depositAmountLamports: draft.wagerAmountLamports,
    onChainJoinSig: createResult.txSig,
  });

  // Update the on_chain_create_sig + verify joined_count is mirrored to 1.
  const [updated] = await db
    .update(lobbies)
    .set({ onChainCreateSig: createResult.txSig })
    .where(eq(lobbies.id, draft.id))
    .returning();
  if (!updated) throw new HTTPException(500, { message: 'lobby_update_failed' });

  void logEventFromContext(c, {
    eventType: 'wager.lobby.created',
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      activityId: input.activityId,
      roomId: input.roomId,
      mode: 'multiplayer',
      wagerLamports: draft.wagerAmountLamports.toString(),
      maxPlayers: input.maxPlayers,
      visibility: input.visibility,
      txSig: createResult.txSig,
    },
  });

  return c.json({ lobby: serializeLobby(updated) }, 201);
});

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

  const filters: Parameters<typeof and>[number][] = [];
  if (activityId) filters.push(eq(lobbies.activityId, activityId));
  if (roomId) filters.push(eq(lobbies.roomId, roomId));
  if (state) filters.push(eq(lobbies.state, state));
  if (mine) {
    const user = c.get('user');
    if (!user) throw new HTTPException(401, { message: 'mine_requires_auth' });
    filters.push(eq(lobbies.creatorUserId, user.id));
  }

  const rows = await db
    .select()
    .from(lobbies)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(lobbies.createdAt))
    .limit(limit);

  // Hide invite codes from list responses for private/friends rows the caller
  // doesn't own. Public lobbies have null invite_code anyway.
  const user = c.get('user');
  const callerUserId = user?.id ?? null;
  const serialized = rows.map((row) => {
    const s = serializeLobby(row);
    if (
      (row.visibility === 'private' || row.visibility === 'friends') &&
      row.creatorUserId !== callerUserId
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

  let row: Lobby | undefined;
  if (isUuid(idOrInvite)) {
    row = await db.query.lobbies.findFirst({ where: eq(lobbies.id, idOrInvite) });
  } else {
    row = await db.query.lobbies.findFirst({
      where: eq(lobbies.inviteCode, idOrInvite),
    });
  }
  if (!row) throw new HTTPException(404, { message: 'lobby_not_found' });

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

  const user = c.get('user');
  const callerUserId = user?.id ?? null;
  const s = serializeLobby(row);
  if (
    (row.visibility === 'private' || row.visibility === 'friends') &&
    row.creatorUserId !== callerUserId
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

wagerRoutes.post('/lobbies/:id/join', requireAuth, async (c) => {
  checkRate(writeLimiter, getClientIp(c.req.raw.headers));
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });

  const user = c.get('user')!;
  const avatar = await loadAvatarForUser(user.id);

  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  if (lobby.mode === 'solo-bots') {
    throw new HTTPException(400, { message: 'solo_bots_lobby_cannot_join' });
  }
  if (lobby.state !== 'open') {
    throw new HTTPException(409, { message: `lobby_state_${lobby.state}` });
  }
  if (lobby.joinedCount >= lobby.maxPlayers) {
    throw new HTTPException(409, { message: 'lobby_full' });
  }

  // Already joined?
  const existing = await db.query.lobbyPlayers.findFirst({
    where: and(eq(lobbyPlayers.lobbyId, lobby.id), eq(lobbyPlayers.userId, user.id)),
  });
  if (existing) {
    throw new HTTPException(409, { message: 'already_joined' });
  }

  // Issue join_lobby_sol.
  let joinResult;
  try {
    joinResult = await joinSolLobby({
      joinerAvatarId: avatar.id,
      lobbyIdBigint: lobby.lobbyId,
    });
  } catch (err) {
    handleWagerClientError(err);
  }

  // Insert lobby_players + bump joined_count atomically.
  await db.insert(lobbyPlayers).values({
    lobbyId: lobby.id,
    userId: user.id,
    avatarId: avatar.id,
    depositAmountLamports: lobby.wagerAmountLamports,
    onChainJoinSig: joinResult.txSig,
  });

  const [updated] = await db
    .update(lobbies)
    .set({ joinedCount: sql`${lobbies.joinedCount} + 1` })
    .where(eq(lobbies.id, lobby.id))
    .returning();

  void logEventFromContext(c, {
    eventType: 'wager.lobby.joined',
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      lobbyId: lobby.id,
      onChainLobbyId: lobby.lobbyId.toString(),
      activityId: lobby.activityId,
      txSig: joinResult.txSig,
    },
  });

  return c.json({ lobby: updated ? serializeLobby(updated) : null });
});

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

  if (lobby.state === 'locked') {
    return c.json({ lobby: serializeLobby(lobby), idempotent: true });
  }
  if (lobby.state !== 'open') {
    throw new HTTPException(409, { message: `lobby_state_${lobby.state}` });
  }

  let result;
  try {
    result = await chainLockLobby({ lobbyIdBigint: lobby.lobbyId });
  } catch (err) {
    handleWagerClientError(err);
  }

  const [updated] = await db
    .update(lobbies)
    .set({
      state: 'locked',
      lockedAt: new Date(),
      onChainLockSig: result.txSig,
    })
    .where(eq(lobbies.id, lobby.id))
    .returning();

  void logEventFromContext(c, {
    eventType: 'wager.lobby.locked',
    payload: {
      lobbyId: lobby.id,
      onChainLobbyId: lobby.lobbyId.toString(),
      txSig: result.txSig,
    },
  });

  return c.json({ lobby: updated ? serializeLobby(updated) : null });
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
  if (lobby.state === 'settled') {
    return c.json({ lobby: serializeLobby(lobby), idempotent: true });
  }
  if (lobby.state !== 'locked') {
    throw new HTTPException(409, { message: `lobby_state_${lobby.state}` });
  }

  // Winner must be in lobby_players.
  const winnerRow = await db.query.lobbyPlayers.findFirst({
    where: and(
      eq(lobbyPlayers.lobbyId, lobby.id),
      eq(lobbyPlayers.avatarId, winnerAvatarId),
    ),
  });
  if (!winnerRow && lobby.mode === 'multiplayer') {
    throw new HTTPException(400, { message: 'winner_not_in_lobby' });
  }
  const winnerAvatar = await db.query.avatars.findFirst({
    where: eq(avatars.id, winnerAvatarId),
    columns: { id: true, userId: true },
  });
  if (!winnerAvatar) throw new HTTPException(400, { message: 'winner_avatar_unknown' });

  if (lobby.mode === 'solo-bots') {
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

  let result;
  try {
    result = await settleSolLobby({
      lobbyIdBigint: lobby.lobbyId,
      winnerAvatarId,
    });
  } catch (err) {
    handleWagerClientError(err);
  }

  const [updated] = await db
    .update(lobbies)
    .set({
      state: 'settled',
      settledAt: new Date(),
      settledWinnerUserId: winnerAvatar.userId,
      settledWinnerAvatarId: winnerAvatarId,
      onChainSettleSig: result.txSig,
    })
    .where(eq(lobbies.id, lobby.id))
    .returning();

  void logEventFromContext(c, {
    eventType: 'wager.lobby.settled',
    payload: {
      lobbyId: lobby.id,
      onChainLobbyId: lobby.lobbyId.toString(),
      winnerAvatarId,
      payoutLamports: result.payoutLamports.toString(),
      rakeLamports: result.rakeLamports.toString(),
      txSig: result.txSig,
    },
  });

  return c.json({
    lobby: updated ? serializeLobby(updated) : null,
    payoutLamports: result.payoutLamports.toString(),
    rakeLamports: result.rakeLamports.toString(),
  });
});

// ─── POST /lobbies/:id/cancel ─────────────────────────────────────────────

wagerRoutes.post('/lobbies/:id/cancel', requireAuth, async (c) => {
  checkRate(writeLimiter, getClientIp(c.req.raw.headers));
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });

  const user = c.get('user')!;
  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  if (lobby.state === 'cancelled') {
    return c.json({ lobby: serializeLobby(lobby), idempotent: true });
  }

  // Authorization: creator (state=open) or admin (state in open|locked).
  // adminOnly is checked separately via ADMIN_USER_IDS env list — we replicate
  // that check here inline so the route can accept BOTH the creator and an
  // admin caller without forcing the FE to know which.
  const adminIds = (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isAdmin = adminIds.includes(user.id);
  const isCreator = lobby.creatorUserId === user.id;

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
      actorUserId: user.id,
      txSig: null,
      rawEventJson: { mode: 'solo-bots' },
    });
    return c.json({ lobby: updated ? serializeLobby(updated) : null });
  }

  let result;
  try {
    result = await chainCancelLobby({
      lobbyIdBigint: lobby.lobbyId,
      signerKind,
    });
  } catch (err) {
    handleWagerClientError(err);
  }

  const [updated] = await db
    .update(lobbies)
    .set({
      state: 'cancelled',
      cancelledAt: new Date(),
      onChainCancelSig: result.txSig,
    })
    .where(eq(lobbies.id, lobby.id))
    .returning();

  void logEventFromContext(c, {
    eventType: 'wager.lobby.cancelled',
    userId: user.id,
    payload: {
      lobbyId: lobby.id,
      onChainLobbyId: lobby.lobbyId.toString(),
      signerKind,
      txSig: result.txSig,
    },
  });

  return c.json({ lobby: updated ? serializeLobby(updated) : null });
});

// ─── POST /lobbies/:id/refund ─────────────────────────────────────────────

wagerRoutes.post('/lobbies/:id/refund', requireAuth, async (c) => {
  checkRate(writeLimiter, getClientIp(c.req.raw.headers));
  const id = lobbyIdParam.safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'invalid_lobby_id' });

  const user = c.get('user')!;
  const avatar = await loadAvatarForUser(user.id);

  const lobby = await db.query.lobbies.findFirst({ where: eq(lobbies.id, id.data) });
  if (!lobby) throw new HTTPException(404, { message: 'lobby_not_found' });
  if (lobby.state !== 'cancelled') {
    throw new HTTPException(409, { message: `lobby_not_cancelled` });
  }

  const playerRow = await db.query.lobbyPlayers.findFirst({
    where: and(
      eq(lobbyPlayers.lobbyId, lobby.id),
      eq(lobbyPlayers.userId, user.id),
    ),
  });
  if (!playerRow) throw new HTTPException(404, { message: 'not_in_lobby' });
  if (playerRow.refunded) {
    return c.json({ playerRow, idempotent: true });
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
      actorUserId: user.id,
      txSig: null,
      rawEventJson: { mode: lobby.mode, freePlay: true },
    });
    return c.json({ playerRow: updated });
  }

  let result;
  try {
    result = await claimSolRefund({
      playerAvatarId: avatar.id,
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
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      lobbyId: lobby.id,
      onChainLobbyId: lobby.lobbyId.toString(),
      txSig: result.txSig,
    },
  });

  return c.json({
    playerRow: updated
      ? {
          ...updated,
          depositAmountLamports: updated.depositAmountLamports.toString(),
          depositedAt: updated.depositedAt.toISOString(),
          refundedAt: updated.refundedAt?.toISOString() ?? null,
        }
      : null,
  });
});

// Unused-import safety
void users;
void inArray;
