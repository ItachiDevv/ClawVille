/**
 * Match-server ↔ wager-lobby bridge (concern 5 of the gambling-contracts slice).
 *
 * The activity-room-manager owns the per-match FSM (PENDING → COUNTDOWN →
 * LIVE → RESULTS → GC, with aborted forks). The wager program owns the
 * escrow FSM (open → locked → settled / cancelled). These two FSMs must
 * advance together:
 *
 *   - room → LIVE        ⇒  lobby → locked (on-chain `lock_lobby` ix)
 *   - room → RESULTS     ⇒  lobby → settled (on-chain `settle_lobby_sol`)
 *
 * For idempotency the bridge is a no-op when there's no associated lobby
 * for the room, when the lobby is solo-bots (FE just paints state, no
 * chain footprint), or when the lobby is already in the target state.
 *
 * Wiring: index.ts calls `wireWagerLobbyBridge()` once during boot to set
 * the global hook. The activity-room-manager invokes it via
 * `liveTransitionFn` and the sim's `setEndedFn`.
 *
 * NOTE: we deliberately avoid an HTTP self-call into `/api/wager/lobbies/
 * :id/lock`. That would require minting a fake admin session for the
 * internal service, and Lucia sessions don't admit that pattern. Instead
 * we call the service layer directly — the route is preserved for
 * external operators and the admin dashboard.
 */

import {
  activityRooms,
  and,
  db,
  eq,
  inArray,
  isNotNull,
  lobbies,
  lobbyPlayers,
  lobbyEvents,
  sql,
  wagerChainIntents,
} from '@clawville/database';
import {
  cancelLobby,
  isWagerLobbyAccountAbsent,
  lockLobby,
  readWagerLobbyChainState,
  settleSolLobby,
  withResolvedWagerLobbyFence,
  WagerClientError,
  type CancelLobbyInput,
  type CancelLobbyResult,
  type WagerLobbyChainState,
} from '../wager-program-client';
import { alertError } from '../alert-error';

export interface LobbyHandle {
  rowId: string;
  lobbyId: bigint;
  state: 'open' | 'locked' | 'settled' | 'cancelled';
  mode: 'multiplayer' | 'solo-bots';
  onChainCreateStatus: string;
}

async function findLobbyForRoom(roomId: string): Promise<LobbyHandle | null> {
  const row = await db.query.lobbies.findFirst({
    where: eq(lobbies.roomId, roomId),
    columns: {
      id: true,
      lobbyId: true,
      state: true,
      mode: true,
      onChainCreateStatus: true,
    },
  });
  if (!row) return null;
  return {
    rowId: row.id,
    lobbyId: row.lobbyId,
    state: row.state as LobbyHandle['state'],
    mode: row.mode as LobbyHandle['mode'],
    onChainCreateStatus: row.onChainCreateStatus,
  };
}

interface WagerAbortFenceContext {
  getCurrent(): Promise<LobbyHandle | null>;
  markCancelled(input: {
    txSig: string | null;
    reconciledFromChain: boolean;
  }): Promise<void>;
  /**
   * True only when NO wager chain intent for this lobby (create, join, or any
   * other operation) ever carried a transaction signature. Read inside the
   * fence, after it expired stale prepared rows and refused on unresolved ones.
   */
  noIntentEverSigned(): Promise<boolean>;
  /**
   * DB-only terminal for a lobby whose create never reached the chain:
   * state 'cancelled', on_chain_create_status 'failed', one lobby_events row.
   */
  markCancelledNeverCreated(): Promise<void>;
}

export interface WagerAbortRecoveryDeps {
  findLobbyForRoom(roomId: string): Promise<LobbyHandle | null>;
  withResolvedFence<T>(
    lobbyRowId: string,
    run: (context: WagerAbortFenceContext) => Promise<T>,
  ): Promise<T>;
  readChainState(lobbyId: bigint): Promise<WagerLobbyChainState>;
  /** True only when the lobby PDA is absent on the configured wager cluster. */
  lobbyAccountAbsent(lobbyId: bigint): Promise<boolean>;
  cancelLobby(input: CancelLobbyInput): Promise<CancelLobbyResult>;
}

export type WagerAbortRecoveryResult =
  | 'no_lobby'
  | 'not_multiplayer'
  | 'already_terminal'
  | 'cancelled'
  | 'reconciled_cancelled'
  | 'cancelled_never_created';

const WAGER_ABORT_ACTIVITY_IDS = new Set(['bumper-shells', 'reef-race']);
const WAGER_ABORT_RECOVERY_INTERVAL_MS = 60_000;
let wagerAbortRecoveryHandle: ReturnType<typeof setInterval> | null = null;

export const productionWagerAbortRecoveryDeps: WagerAbortRecoveryDeps = {
  findLobbyForRoom,
  withResolvedFence: (lobbyRowId, run) =>
    withResolvedWagerLobbyFence(lobbyRowId, async (tx) =>
      run({
        getCurrent: async () => {
          const current = await tx.query.lobbies.findFirst({
            where: eq(lobbies.id, lobbyRowId),
            columns: {
              id: true,
              lobbyId: true,
              state: true,
              mode: true,
              onChainCreateStatus: true,
            },
          });
          if (!current) return null;
          return {
            rowId: current.id,
            lobbyId: current.lobbyId,
            state: current.state as LobbyHandle['state'],
            mode: current.mode as LobbyHandle['mode'],
            onChainCreateStatus: current.onChainCreateStatus,
          };
        },
        markCancelled: async ({ txSig, reconciledFromChain }) => {
          await tx
            .update(lobbies)
            .set({
              state: 'cancelled',
              cancelledAt: new Date(),
              ...(txSig ? { onChainCancelSig: txSig } : {}),
            })
            .where(eq(lobbies.id, lobbyRowId));
          if (reconciledFromChain) {
            await tx.insert(lobbyEvents).values({
              lobbyId: lobbyRowId,
              kind: 'cancelled',
              txSig: null,
              rawEventJson: {
                triggeredBy: 'aborted_crash_recovery',
                reconciledFromChain: true,
              },
            });
          }
        },
        noIntentEverSigned: async () => {
          // wager_chain_intents.lobby_id is the lobbies ROW id (same key the
          // fence expires and checks by).
          const signed = await tx
            .select({ id: wagerChainIntents.id })
            .from(wagerChainIntents)
            .where(
              and(
                eq(wagerChainIntents.lobbyId, lobbyRowId),
                isNotNull(wagerChainIntents.txSignature),
              ),
            )
            .limit(1);
          return signed.length === 0;
        },
        markCancelledNeverCreated: async () => {
          await tx
            .update(lobbies)
            .set({
              state: 'cancelled',
              cancelledAt: new Date(),
              onChainCreateStatus: 'failed',
            })
            .where(eq(lobbies.id, lobbyRowId));
          await tx.insert(lobbyEvents).values({
            lobbyId: lobbyRowId,
            kind: 'cancelled',
            txSig: null,
            rawEventJson: {
              triggeredBy: 'aborted_crash_recovery',
              reason: 'never_created_on_chain',
            },
          });
        },
      }),
    ),
  readChainState: readWagerLobbyChainState,
  lobbyAccountAbsent: isWagerLobbyAccountAbsent,
  cancelLobby,
};

/**
 * Settlement-authority cancel for an activity room that cannot produce results.
 * The create/join reconciliation fence runs first. The chain is then read before
 * any retry: a prior ambiguous cancel is reconciled forward, never re-sent.
 */
export async function cancelLobbyForAbortedRoom(
  roomId: string,
  deps: WagerAbortRecoveryDeps = productionWagerAbortRecoveryDeps,
): Promise<WagerAbortRecoveryResult> {
  const handle = await deps.findLobbyForRoom(roomId);
  if (!handle) return 'no_lobby';
  if (handle.mode !== 'multiplayer') return 'not_multiplayer';
  if (handle.state === 'cancelled' || handle.state === 'settled') {
    return 'already_terminal';
  }

  return deps.withResolvedFence(handle.rowId, async (context) => {
    const current = await context.getCurrent();
    if (!current) return 'no_lobby';
    if (current.mode !== 'multiplayer') return 'not_multiplayer';
    if (current.state === 'cancelled' || current.state === 'settled') {
      return 'already_terminal';
    }
    if (current.state !== 'open' && current.state !== 'locked') {
      throw new Error(`lobby_state_${current.state}`);
    }
    if (current.onChainCreateStatus !== 'confirmed') {
      // A create that NEVER reached the chain has nothing to refund and no
      // escrow to cancel. Without this branch such a row can never leave the
      // sweep (prod 2026-09-18: two free lobbies from 07-28/07-29 threw every
      // 60 s since). All three proofs are required; any doubt keeps the old
      // quarantine:
      //   1. the DB says the create is 'prepared' or 'failed' (never confirmed);
      //   2. no intent for this lobby EVER carried a tx signature (checked
      //      inside the fence, which already expired stale prepared rows and
      //      refused on any prepared/sending/reconcile one);
      //   3. the lobby PDA is ABSENT on the wager cluster (no account at all),
      //      so no join could have deposited into it.
      const createNeverSent =
        (current.onChainCreateStatus === 'prepared' || current.onChainCreateStatus === 'failed') &&
        (await context.noIntentEverSigned()) &&
        (await deps.lobbyAccountAbsent(current.lobbyId));
      if (createNeverSent) {
        await context.markCancelledNeverCreated();
        return 'cancelled_never_created';
      }
      throw new Error('wager_create_reconciliation_required');
    }

    const chainState = await deps.readChainState(current.lobbyId);
    if (chainState === 'cancelled') {
      await context.markCancelled({ txSig: null, reconciledFromChain: true });
      return 'reconciled_cancelled';
    }
    if (chainState !== 'open' && chainState !== 'locked') {
      throw new Error(`wager_chain_state_${chainState}`);
    }

    const result = await deps.cancelLobby({
      lobbyIdBigint: current.lobbyId,
      signerKind: 'settlement-authority',
    });
    await context.markCancelled({
      txSig: result.txSig,
      reconciledFromChain: false,
    });
    return 'cancelled';
  });
}

/** Activity-filtered callback registered into the room manager's composed set. */
export async function handleWagerRoomAborted(
  roomId: string,
  activityId: string,
  status: 'aborted' | 'aborted_crash',
  deps: WagerAbortRecoveryDeps = productionWagerAbortRecoveryDeps,
): Promise<void> {
  // Exit-lifecycle review, blocking issue 3: plain 'aborted' rooms can carry
  // a locked wager too — a funded countdown room whose last non-bot withdrew,
  // or a reef no-show abort. Both abort statuses must cancel the escrow;
  // cancelLobbyForAbortedRoom is terminal-guarded, so replays are no-ops.
  if (!WAGER_ABORT_ACTIVITY_IDS.has(activityId)) return;
  await cancelLobbyForAbortedRoom(roomId, deps);
}

/**
 * Log throttle for the 60 s abort sweep. A row that stays quarantined (for
 * example a create that never reached the chain: prod had two free lobbies
 * from 07-28/07-29 that threw wager_create_reconciliation_required every
 * minute, 650 lines in 5 h) must stay VISIBLE without flooding the log: one
 * line per room per cause per hour, carrying how many repeats were held back.
 * The quarantine itself is unchanged; closing such a row in the DB alone is
 * unsafe because the program accepts a direct create for a caller-chosen
 * lobby id, so a DB cancel cannot rule out a later on-chain deposit.
 */
const SWEEP_FAILURE_LOG_INTERVAL_MS = 60 * 60_000;
const sweepFailureLog = new Map<string, { message: string; loggedAt: number; held: number }>();

/** Returns the number of repeats held back since the last line, or null to stay quiet. */
export function sweepFailureLogDecision(
  roomId: string,
  message: string,
  now: number = Date.now(),
): number | null {
  const prev = sweepFailureLog.get(roomId);
  if (prev && prev.message === message && now - prev.loggedAt < SWEEP_FAILURE_LOG_INTERVAL_MS) {
    prev.held += 1;
    return null;
  }
  const held = prev && prev.message === message ? prev.held : 0;
  sweepFailureLog.set(roomId, { message, loggedAt: now, held: 0 });
  return held;
}

export function __resetSweepFailureLogForTest(): void {
  sweepFailureLog.clear();
}

/** Retry durable aborted_crash escrow rows, including across process restarts. */
export async function sweepAbortedCrashWagerLobbies(
  deps: WagerAbortRecoveryDeps = productionWagerAbortRecoveryDeps,
): Promise<{
  attempted: number;
  recovered: number;
  failed: number;
}> {
  const rows = await db
    .select({ roomId: lobbies.roomId })
    .from(lobbies)
    // activity_rooms.id is uuid; wager lobbies.room_id is text (it can carry
    // non-uuid ids for other modes), so cast the uuid side — `uuid = text` has
    // no operator and made every sweep tick throw 42883 since the P4 deploy.
    .innerJoin(activityRooms, sql`${activityRooms.id}::text = ${lobbies.roomId}`)
    .where(
      and(
        eq(lobbies.mode, 'multiplayer'),
        inArray(lobbies.activityId, Array.from(WAGER_ABORT_ACTIVITY_IDS)),
        inArray(lobbies.state, ['open', 'locked']),
        // Both abort statuses (see handleWagerRoomAborted) — a plain
        // 'aborted' room can also strand a locked lobby.
        inArray(activityRooms.status, ['aborted', 'aborted_crash']),
      ),
    );
  let recovered = 0;
  let failed = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.roomId);
    try {
      const result = await cancelLobbyForAbortedRoom(row.roomId, deps);
      if (result === 'cancelled' || result === 'reconciled_cancelled') recovered++;
      sweepFailureLog.delete(row.roomId);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const held = sweepFailureLogDecision(row.roomId, message);
      if (held !== null) {
        console.error(
          `[wager-bridge] abort recovery retry failed for ${row.roomId}` +
            (held > 0 ? ` (same failure ${held} more times since the last line):` : ':'),
          err,
        );
      }
    }
  }
  // Rows that left the sweep (recovered elsewhere, or closed by an operator)
  // stop holding a throttle entry.
  for (const roomId of sweepFailureLog.keys()) {
    if (!seen.has(roomId)) sweepFailureLog.delete(roomId);
  }
  return { attempted: rows.length, recovered, failed };
}

export function startWagerAbortRecoveryWorker(): void {
  if (wagerAbortRecoveryHandle) return;
  const run = () => {
    void sweepAbortedCrashWagerLobbies().catch((err) => {
      console.error('[wager-bridge] abort recovery sweep failed:', err);
    });
  };
  run();
  wagerAbortRecoveryHandle = setInterval(() => {
    run();
  }, WAGER_ABORT_RECOVERY_INTERVAL_MS);
}

export function stopWagerAbortRecoveryWorker(): void {
  if (!wagerAbortRecoveryHandle) return;
  clearInterval(wagerAbortRecoveryHandle);
  wagerAbortRecoveryHandle = null;
}

/**
 * Called by the room manager's `liveTransitionFn` AFTER it has set
 * `room.startedAt`. Best-effort: failure is logged + the event is recorded
 * but the match still runs. The settle step is the one we MUST get right;
 * an unlocked lobby just means we can still cancel-refund instead of
 * paying out, which is the safer failure mode.
 */
export async function lockLobbyForRoom(roomId: string): Promise<void> {
  let handle: LobbyHandle | null = null;
  try {
    handle = await findLobbyForRoom(roomId);
    if (!handle) return; // no lobby attached (legacy queue-matched room or pre-wager activity)

    if (
      handle.mode === 'solo-bots' &&
      (handle.state === 'locked' || handle.state === 'settled')
    ) return;
    if (handle.state === 'cancelled') {
      if (handle.mode === 'multiplayer') {
        await withResolvedWagerLobbyFence(handle.rowId, async () => undefined);
      }
      console.warn(
        `[wager-bridge] room ${roomId} reached LIVE but lobby ${handle.rowId} is already cancelled — skipping lock`,
      );
      return;
    }

    if (handle.mode === 'solo-bots') {
      await db
        .update(lobbies)
        .set({ state: 'locked', lockedAt: new Date() })
        .where(eq(lobbies.id, handle.rowId));
      await db.insert(lobbyEvents).values({
        lobbyId: handle.rowId,
        kind: 'locked',
        txSig: null,
        rawEventJson: { mode: 'solo-bots', triggeredBy: 'room_manager' },
      });
      return;
    }

    // Multiplayer — issue on-chain lock_lobby.
    await withResolvedWagerLobbyFence(handle.rowId, async (tx) => {
      const current = await tx.query.lobbies.findFirst({
        where: eq(lobbies.id, handle!.rowId),
      });
      if (!current || current.onChainCreateStatus !== 'confirmed') {
        throw new Error('wager_create_reconciliation_required');
      }
      if (current.state === 'locked' || current.state === 'settled') return;
      if (current.state !== 'open') throw new Error(`lobby_state_${current.state}`);
      const result = await lockLobby({ lobbyIdBigint: current.lobbyId });
      await tx
        .update(lobbies)
        .set({ state: 'locked', lockedAt: new Date(), onChainLockSig: result.txSig })
        .where(eq(lobbies.id, current.id));
    });
  } catch (err) {
    if (err instanceof WagerClientError && err.code === 'state_noop') {
      // Already in target state — fine.
      return;
    }
    console.error(
      `[wager-bridge] lockLobbyForRoom(${roomId}) failed:`,
      err,
    );
    if (handle) {
      try {
        await db.insert(lobbyEvents).values({
          lobbyId: handle.rowId,
          kind: 'locked',
          txSig: null,
          rawEventJson: {
            error: String(err),
            triggeredBy: 'room_manager',
            failed: true,
          },
        });
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Called by the sim's `setEndedFn` after the room manager transitions to
 * RESULTS. The sim provides the winner's avatarId via its computeResults.
 *
 * Behavior:
 *   - If no lobby attached, no-op.
 *   - If lobby is `solo-bots`, mark settled off-chain.
 *   - If lobby is multiplayer + locked, issue settle_lobby_sol with the
 *     winner. We require the winner to be in `lobby_players` to avoid
 *     settling to a bot (which has no wallet PDA) or a no-show.
 *   - If the winner isn't in `lobby_players`, fall back to cancelling the
 *     lobby so every depositor can refund.
 */
export async function settleLobbyForRoom(
  roomId: string,
  winnerAvatarId: string | null,
): Promise<void> {
  let handle: LobbyHandle | null = null;
  try {
    handle = await findLobbyForRoom(roomId);
    if (!handle) return;
    if (
      handle.mode === 'solo-bots' &&
      (handle.state === 'settled' || handle.state === 'cancelled')
    ) return;
    if (handle.mode === 'multiplayer' && handle.state === 'cancelled') {
      await withResolvedWagerLobbyFence(handle.rowId, async () => undefined);
      return;
    }
    if (handle.state !== 'locked') {
      console.warn(
        `[wager-bridge] room ${roomId} → RESULTS but lobby is in state '${handle.state}'; expected 'locked' — settling anyway`,
      );
    }

    if (handle.mode === 'solo-bots') {
      // Find creator's avatar if no winner was passed; otherwise we just
      // mark the lobby settled — solo-bots has no payout.
      await db
        .update(lobbies)
        .set({
          state: 'settled',
          settledAt: new Date(),
          settledWinnerAvatarId: winnerAvatarId,
        })
        .where(eq(lobbies.id, handle.rowId));
      await db.insert(lobbyEvents).values({
        lobbyId: handle.rowId,
        kind: 'settled',
        txSig: null,
        rawEventJson: { mode: 'solo-bots', winnerAvatarId },
      });
      return;
    }

    if (!winnerAvatarId) {
      await withResolvedWagerLobbyFence(handle.rowId, async () => undefined);
      console.warn(
        `[wager-bridge] room ${roomId} → RESULTS with no winnerAvatarId; cannot settle on-chain. ` +
          `Operator must call POST /api/wager/lobbies/${handle.rowId}/cancel to unlock refunds.`,
      );
      // Same stuck-locked class as a failed settle — page ops, do not rely
      // on someone reading stdout (fails-visible rule).
      void alertError({
        severity: 'critical',
        source: 'wager-lobby-bridge',
        message: `room ${roomId} reached RESULTS with no settleable winner — escrow stuck locked; operator cancel required`,
        context: { roomId, lobbyRowId: handle.rowId },
      });
      await db.insert(lobbyEvents).values({
        lobbyId: handle.rowId,
        kind: 'settled',
        txSig: null,
        rawEventJson: { failed: true, reason: 'no_winner' },
      });
      return;
    }

    // Make sure the winner is actually one of the depositors. Bot winners
    // are filtered out by virtue of having no `lobby_players` row.
    await withResolvedWagerLobbyFence(handle.rowId, async (tx) => {
      const current = await tx.query.lobbies.findFirst({
        where: eq(lobbies.id, handle!.rowId),
      });
      if (!current || current.onChainCreateStatus !== 'confirmed') {
        throw new Error('wager_create_reconciliation_required');
      }
      if (current.state === 'settled' || current.state === 'cancelled') return;
      if (current.state !== 'locked') throw new Error(`lobby_state_${current.state}`);

      const allPlayers = await tx
        .select({ avatarId: lobbyPlayers.avatarId, userId: lobbyPlayers.userId })
        .from(lobbyPlayers)
        .where(eq(lobbyPlayers.lobbyId, current.id));
      const winner = allPlayers.find((player) => player.avatarId === winnerAvatarId);
      if (!winner) throw new Error('winner_not_depositor');

      const result = await settleSolLobby({
        lobbyIdBigint: current.lobbyId,
        winnerAvatarId,
      });
      await tx
        .update(lobbies)
        .set({
          state: 'settled',
          settledAt: new Date(),
          settledWinnerAvatarId: winnerAvatarId,
          settledWinnerUserId: winner.userId,
          onChainSettleSig: result.txSig,
        })
        .where(eq(lobbies.id, current.id));
    });
  } catch (err) {
    console.error(
      `[wager-bridge] settleLobbyForRoom(${roomId}, ${winnerAvatarId}) failed:`,
      err,
    );
    // Exit-lifecycle review, blocking issue 2: a settle that fails with a
    // non-depositor winner (a bot at placement 1 — e.g. every human left an
    // early-terminated round) leaves the escrow LOCKED with no automatic
    // path out. Page ops loudly (fails-visible rule): the operator cancel
    // (POST /api/wager/lobbies/:id/cancel) unlocks the refunds.
    void alertError({
      severity: 'critical',
      source: 'wager-lobby-bridge',
      message: `settleLobbyForRoom failed for room ${roomId} — escrow may be stuck locked; operator cancel required`,
      context: {
        roomId,
        lobbyRowId: handle?.rowId ?? null,
        winnerAvatarId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    if (handle) {
      try {
        await db.insert(lobbyEvents).values({
          lobbyId: handle.rowId,
          kind: 'settled',
          txSig: null,
          rawEventJson: {
            failed: true,
            error: String(err),
            winnerAvatarId,
          },
        });
      } catch {
        // best-effort
      }
    }
  }
}
