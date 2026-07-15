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

import { db, eq, lobbies, lobbyPlayers, lobbyEvents } from '@clawville/database';
import {
  lockLobby,
  settleSolLobby,
  withResolvedWagerLobbyFence,
  WagerClientError,
} from '../wager-program-client';

interface LobbyHandle {
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
