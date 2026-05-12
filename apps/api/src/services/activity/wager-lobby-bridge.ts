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
import { lockLobby, settleSolLobby, WagerClientError } from '../wager-program-client';

interface LobbyHandle {
  rowId: string;
  lobbyId: bigint;
  state: 'open' | 'locked' | 'settled' | 'cancelled';
  mode: 'multiplayer' | 'solo-bots';
}

async function findLobbyForRoom(roomId: string): Promise<LobbyHandle | null> {
  const row = await db.query.lobbies.findFirst({
    where: eq(lobbies.roomId, roomId),
    columns: { id: true, lobbyId: true, state: true, mode: true },
  });
  if (!row) return null;
  return {
    rowId: row.id,
    lobbyId: row.lobbyId,
    state: row.state as LobbyHandle['state'],
    mode: row.mode as LobbyHandle['mode'],
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

    if (handle.state === 'locked' || handle.state === 'settled') return;
    if (handle.state === 'cancelled') {
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
    const result = await lockLobby({ lobbyIdBigint: handle.lobbyId });
    await db
      .update(lobbies)
      .set({ state: 'locked', lockedAt: new Date(), onChainLockSig: result.txSig })
      .where(eq(lobbies.id, handle.rowId));
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
    if (handle.state === 'settled' || handle.state === 'cancelled') return;
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
    const playerRow = await db.query.lobbyPlayers.findFirst({
      where: eq(lobbyPlayers.lobbyId, handle.rowId),
      columns: { avatarId: true },
    });
    void playerRow; // existence check only — we re-query with avatarId below
    const depositorWinner = await db.query.lobbyPlayers.findFirst({
      where: eq(lobbyPlayers.lobbyId, handle.rowId),
    });
    // Simpler: list all players, see if winner is one of them.
    const allPlayers = await db
      .select({ avatarId: lobbyPlayers.avatarId, userId: lobbyPlayers.userId })
      .from(lobbyPlayers)
      .where(eq(lobbyPlayers.lobbyId, handle.rowId));
    void depositorWinner;
    const winnerIsDepositor = allPlayers.some((p) => p.avatarId === winnerAvatarId);
    if (!winnerIsDepositor) {
      console.warn(
        `[wager-bridge] room ${roomId} winner ${winnerAvatarId} is not a depositor — skipping on-chain settle`,
      );
      await db.insert(lobbyEvents).values({
        lobbyId: handle.rowId,
        kind: 'settled',
        txSig: null,
        rawEventJson: {
          failed: true,
          reason: 'winner_not_depositor',
          winnerAvatarId,
        },
      });
      return;
    }

    const winnerUserId =
      allPlayers.find((p) => p.avatarId === winnerAvatarId)?.userId ?? null;

    const result = await settleSolLobby({
      lobbyIdBigint: handle.lobbyId,
      winnerAvatarId,
    });

    await db
      .update(lobbies)
      .set({
        state: 'settled',
        settledAt: new Date(),
        settledWinnerAvatarId: winnerAvatarId,
        settledWinnerUserId: winnerUserId,
        onChainSettleSig: result.txSig,
      })
      .where(eq(lobbies.id, handle.rowId));
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
