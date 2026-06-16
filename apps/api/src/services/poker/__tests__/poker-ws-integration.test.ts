/**
 * Phase P1.2b — Texas Hold'em END-TO-END WS integration test.
 *
 * Drives a 2-seat `texas-holdem` table all the way through the REAL wiring with
 * NO real sockets:
 *   - a real `activityRoomManager` room (texas-holdem, 2 human participants),
 *   - the real `activityWsHub` with two MOCK WS connections authed through the
 *     same `handleMessage('auth')` handshake production uses,
 *   - the real `pokerTableSim` SINGLETON (the one `handlePokerAction` calls),
 *     with its broadcast / per-seat / hand-complete callbacks wired to the hub
 *     EXACTLY as `apps/api/src/index.ts` wires them at boot,
 *   - inbound `poker.action` frames fed through `handleMessage` (NOT a direct
 *     sim call) so the inbound translation + idempotency-key composition + the
 *     "act as yourself" identity binding are all exercised.
 *
 * Asserts the four contract guarantees:
 *   (a) each seat receives its OWN hole cards over the PRIVATE channel and
 *       NEVER the opponent's (hidden state over the wire),
 *   (b) the PUBLIC `poker.table_state` broadcast carries no hole cards and
 *       board.length === street card count,
 *   (c) a full hand reaches showdown and the right winner is announced,
 *   (d) a duplicate `actionSeq` is idempotent (no double chip movement).
 *
 * The mock-module block mirrors `activity-ws-hub.test.ts` so the hub +
 * room-manager import chain resolves without Lucia / DB / ledger.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  shuffleDeck,
  evaluateBest5,
  compareHandRank,
  type Card,
} from '../../holdem-engine';
import type {
  PublicTableSnapshot,
  HandResult,
} from '../poker-table-types';

// ── Mock the identity + DB + side-effect chain (same as the hub unit test) ──

mock.module('../../../middleware/require-auth-or-agent', () => ({
  resolveActivityIdentity: async (input: { sessionToken: string }) => {
    if (input.sessionToken === 'valid-user-0') {
      return { kind: 'user', userId: 'user-0', avatarId: 'av-0', agentId: null };
    }
    if (input.sessionToken === 'valid-user-1') {
      return { kind: 'user', userId: 'user-1', avatarId: 'av-1', agentId: null };
    }
    return null;
  },
}));

mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: {},
}));
mock.module('../../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));
mock.module('../../activity/activity-replay-log', () => ({
  activityReplayLog: {
    appendInputFrame: () => {},
    flushToDb: () => Promise.resolve(null),
    dropRoom: () => {},
    getReplayId: () => undefined,
    bufferLength: () => 0,
    __resetForTest: () => {},
  },
}));
mock.module('@clawville/database', () => ({
  db: {
    insert: () => ({
      values: () => Promise.resolve(undefined),
      returning: () => Promise.resolve([{ id: 'replay-1' }]),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    query: {},
  },
  activityRooms: {},
  activityRoomParticipants: {},
  activityQueueEntries: {},
  activityParties: {},
  activityPartyMembers: {},
  activityReplays: { id: 'id' },
  activityResults: { id: 'id', avatarId: 'avatar_id', activityId: 'activity_id' },
  avatars: { id: 'id', flags: 'flags' },
  clawTokenTransactions: { id: 'id' },
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
    ghostReplayData: 'ghost_replay_data',
  },
}));
mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: () =>
    Promise.resolve({ balanceAfter: 100, ledgerId: 'ledger-1' }),
}));

const { activityWsHub } = await import('../../activity/activity-ws-hub');
const { activityRoomManager } = await import(
  '../../activity/activity-room-manager'
);
const { pokerTableSim } = await import('../poker-table-sim-singleton');

const SERVER = 'f'.repeat(64); // provable-rng requires EXACTLY 64 hex chars
const CLIENT = 'cafebabe';

const ACTIVITY_CONFIG = { minPlayers: 2, maxPlayers: 9, preferredPlayers: 2 };

// ─── Fake transport (mirrors the hub unit test) ─────────────────────────────

interface FakeWs {
  ws: {
    send: (frame: string) => void;
    close: (code: number, reason: string) => void;
    getBufferedAmount: () => number;
    data: ReturnType<typeof activityWsHub.makeConnectionData>;
  };
  sent: string[];
  closes: Array<{ code: number; reason: string }>;
}

function makeFakeWs(roomId: string): FakeWs {
  const sent: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const ws = {
    send: (frame: string) => sent.push(frame),
    close: (code: number, reason: string) => closes.push({ code, reason }),
    getBufferedAmount: () => 0,
    data: activityWsHub.makeConnectionData(roomId),
  };
  return { ws, sent, closes };
}

function frames(fake: FakeWs): Array<{ type: string; [k: string]: unknown }> {
  return fake.sent.map((s) => JSON.parse(s));
}

/** All `poker.*` server frames a connection received, in order. */
function pokerFrames(fake: FakeWs) {
  return frames(fake).filter((f) => f.type.startsWith('poker.'));
}

// ─── Wire the SINGLETON's callbacks to the real hub — EXACTLY as index.ts ───
//
// This is the production boot wiring lifted verbatim (handNumber pinned to 1
// like the demo path). The hub's `handlePokerAction` calls the SAME singleton.

function wirePokerSingletonToHub(): void {
  pokerTableSim.setBroadcastFn((tableId, snapshot) => {
    activityWsHub.broadcastEvent(tableId, { type: 'poker.table_state', snapshot });
  });
  pokerTableSim.setSendToSeatFn((tableId, avatarId, view) => {
    activityWsHub.sendToAvatar(tableId, avatarId, {
      type: 'poker.hole_cards',
      handNumber: 1,
      seatIndex: view.seatIndex,
      holeCards: view.holeCards,
    });
    activityWsHub.sendToAvatar(tableId, avatarId, {
      type: 'poker.your_turn',
      handNumber: 1,
      view,
    });
  });
  pokerTableSim.setHandCompleteFn((tableId, result) => {
    activityWsHub.broadcastEvent(tableId, {
      type: 'poker.showdown',
      handNumber: result.handNumber,
      board: result.board,
      seats: result.perSeat,
    });
    activityWsHub.broadcastEvent(tableId, { type: 'poker.hand_ended', result });
  });
}

// ─── Replicate the deal so the test knows every card up front ────────────────

function replicateDeal(handNumber: number, seatCount: number) {
  const deck = shuffleDeck({ serverSeed: SERVER, clientSeed: CLIENT, nonce: handNumber });
  const hole: [Card, Card][] = Array.from({ length: seatCount }, () => [
    deck[0]!,
    deck[0]!,
  ]);
  let top = 0;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < seatCount; i++) {
      hole[i]![round] = deck[top++]!;
    }
  }
  const board5 = [deck[top++]!, deck[top++]!, deck[top++]!, deck[top++]!, deck[top++]!];
  return { hole, board5 };
}

function expectedWinnerSeats(
  hole: [Card, Card][],
  board5: Card[],
  contenders: number[],
): number[] {
  let best: ReturnType<typeof evaluateBest5> | null = null;
  let winners: number[] = [];
  for (const seat of contenders) {
    const r = evaluateBest5([...hole[seat]!, ...board5]);
    if (!best || compareHandRank(r, best) > 0) {
      best = r;
      winners = [seat];
    } else if (compareHandRank(r, best) === 0) {
      winners.push(seat);
    }
  }
  return winners.sort((a, b) => a - b);
}

// ─── Auth two mock connections into a fresh texas-holdem room ────────────────

async function setupAuthedRoom() {
  const room = await activityRoomManager.createRoom(
    'texas-holdem',
    [
      { avatarId: 'av-0', userId: 'user-0', agentId: null, subjectType: 'human' as const, partyId: null },
      { avatarId: 'av-1', userId: 'user-1', agentId: null, subjectType: 'human' as const, partyId: null },
    ],
    ACTIVITY_CONFIG,
  );
  const ws0 = makeFakeWs(room.id);
  const ws1 = makeFakeWs(room.id);
  await activityWsHub.handleMessage(
    ws0.ws,
    JSON.stringify({ type: 'auth', sessionToken: 'valid-user-0', shortCode: room.shortCode }),
  );
  await activityWsHub.handleMessage(
    ws1.ws,
    JSON.stringify({ type: 'auth', sessionToken: 'valid-user-1', shortCode: room.shortCode }),
  );
  // Clear the snapshot.init noise from auth so per-test assertions start clean.
  ws0.sent.length = 0;
  ws1.sent.length = 0;
  return { room, ws0, ws1 };
}

/** Start hand #1 on the singleton with deterministic seeds + a 2-seat field. */
function startDemoHand(roomId: string): void {
  pokerTableSim.startHand({
    tableId: roomId,
    handNumber: 1,
    seatAssignments: [
      { seatIndex: 0, avatarId: 'av-0', name: 'av-0', subjectType: 'human', chipStack: 1000 },
      { seatIndex: 1, avatarId: 'av-1', name: 'av-1', subjectType: 'human', chipStack: 1000 },
    ],
    blinds: { sb: 10, bb: 20, ante: 0 },
    buttonSeatIndex: 0,
    serverSeed: SERVER,
    clientSeed: CLIENT,
    turnClockMs: 30_000,
    agentTurnGraceMs: 0,
  });
}

/** Feed a poker.action frame through the REAL inbound path for one seat. */
async function sendAction(
  fake: FakeWs,
  actionSeq: number,
  action: Record<string, unknown>,
): Promise<void> {
  await activityWsHub.handleMessage(
    fake.ws,
    JSON.stringify({ type: 'poker.action', handNumber: 1, actionSeq, action }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('texas-holdem WS integration — end-to-end through handleMessage', () => {
  beforeEach(() => {
    activityWsHub.__resetForTest();
    activityRoomManager.__resetForTest();
    // Each test creates a fresh room (unique uuid → unique sim table id), so the
    // singleton's tables never collide across tests. Re-wire the singleton's
    // callbacks to the (reset) hub each time.
    wirePokerSingletonToHub();
  });

  it('(a) private hole cards reach only their owner; opponent never sees them', async () => {
    const { room, ws0, ws1 } = await setupAuthedRoom();
    startDemoHand(room.id);

    const deal = replicateDeal(1, 2);

    // Each seat should have received its OWN hole cards over the private
    // channel (sim sends private view to the seat on the clock; in heads-up
    // both seats act, so both get one before the hand ends — but seat 0 acts
    // first preflop, so assert seat 0 immediately).
    const ws0Hole = pokerFrames(ws0).filter((f) => f.type === 'poker.hole_cards');
    expect(ws0Hole.length).toBeGreaterThanOrEqual(1);
    expect((ws0Hole[0] as unknown as { holeCards: Card[] }).holeCards).toEqual(deal.hole[0]!);

    // Seat 0's connection must NEVER have received seat 1's hole cards, in ANY
    // frame (private or public). Serialize every frame ws0 saw and assert
    // seat 1's exact cards never appear.
    const seat1CardsJson = JSON.stringify(deal.hole[1]!);
    for (const raw of ws0.sent) {
      // The opponent's two-card tuple must not appear verbatim in any frame.
      expect(raw.includes(seat1CardsJson)).toBe(false);
    }
    // And vice-versa: seat 1's connection must never carry seat 0's cards.
    const seat0CardsJson = JSON.stringify(deal.hole[0]!);
    for (const raw of ws1.sent) {
      expect(raw.includes(seat0CardsJson)).toBe(false);
    }
  });

  it('(b) public table_state carries no hole cards and board length == street count', async () => {
    const { room, ws0, ws1 } = await setupAuthedRoom();
    startDemoHand(room.id);

    // The first public broadcast is preflop → board length 0.
    const firstPublic = pokerFrames(ws0).find((f) => f.type === 'poker.table_state');
    expect(firstPublic).toBeDefined();
    const snap0 = (firstPublic as unknown as { snapshot: PublicTableSnapshot }).snapshot;
    expect(snap0.street).toBe('preflop');
    expect(snap0.board.length).toBe(0);
    // No seat in the public snapshot carries a `holeCards` key (structural).
    for (const seat of snap0.seats) {
      expect('holeCards' in seat).toBe(false);
    }
    // The serialized public frame must contain no `holeCards` token at all.
    const firstPublicRaw = ws0.sent.find((s) => s.includes('"poker.table_state"'))!;
    expect(firstPublicRaw.includes('holeCards')).toBe(false);

    // Drive to the flop: preflop SB(0) calls, BB(1) checks → flop dealt.
    await sendAction(ws0, 1, { kind: 'call' });
    await sendAction(ws1, 1, { kind: 'check' });

    // Find a flop-street public snapshot on either connection.
    const flopSnap = [...pokerFrames(ws0), ...pokerFrames(ws1)]
      .filter((f) => f.type === 'poker.table_state')
      .map((f) => (f as unknown as { snapshot: PublicTableSnapshot }).snapshot)
      .find((s) => s.street === 'flop');
    expect(flopSnap).toBeDefined();
    expect(flopSnap!.board.length).toBe(3);
    // serverSeed must NOT leak in any public frame mid-hand.
    expect(ws1.sent.some((s) => s.includes(SERVER))).toBe(false);
  });

  it('(c) a full hand reaches showdown and announces the correct winner', async () => {
    const { room, ws0, ws1 } = await setupAuthedRoom();
    startDemoHand(room.id);

    // Check the whole way down: preflop call+check, then check/check each street.
    await sendAction(ws0, 1, { kind: 'call' }); // SB completes
    await sendAction(ws1, 1, { kind: 'check' }); // BB checks option → flop
    await sendAction(ws1, 2, { kind: 'check' }); // flop: BB first to act
    await sendAction(ws0, 2, { kind: 'check' }); // → turn
    await sendAction(ws1, 3, { kind: 'check' });
    await sendAction(ws0, 3, { kind: 'check' }); // → river
    await sendAction(ws1, 4, { kind: 'check' });
    await sendAction(ws0, 4, { kind: 'check' }); // → showdown

    // A hand-ended frame must have been broadcast to both seats.
    const ended0 = pokerFrames(ws0).find((f) => f.type === 'poker.hand_ended');
    const ended1 = pokerFrames(ws1).find((f) => f.type === 'poker.hand_ended');
    expect(ended0).toBeDefined();
    expect(ended1).toBeDefined();
    const result = (ended0 as unknown as { result: HandResult }).result;
    expect(result.endedAt).toBe('showdown');
    expect(result.board.length).toBe(5);
    // Server seed revealed ONLY now, in hand_ended.
    expect(result.serverSeedRevealed).toBe(SERVER);

    // Chip conservation: nets sum to 0.
    expect(result.perSeat.reduce((acc, s) => acc + s.net, 0)).toBe(0);

    // Correct winner vs the replicated deal.
    const deal = replicateDeal(1, 2);
    const expected = expectedWinnerSeats(deal.hole, deal.board5, [0, 1]);
    const simWinners = result.perSeat
      .filter((s) => s.isWinner)
      .map((s) => s.seatIndex)
      .sort((a, b) => a - b);
    expect(simWinners).toEqual(expected);

    // The showdown frame reached the wire and carries only public results.
    const showdown = pokerFrames(ws0).find((f) => f.type === 'poker.showdown');
    expect(showdown).toBeDefined();
    expect((showdown as unknown as { board: Card[] }).board.length).toBe(5);
  });

  it('(d) a duplicate actionSeq is idempotent — no double chip movement', async () => {
    const { room, ws0, ws1 } = await setupAuthedRoom();
    startDemoHand(room.id);

    // Preflop: SB(0) calls with actionSeq 1.
    await sendAction(ws0, 1, { kind: 'call' });
    const afterFirst = pokerTableSim.getPublicSnapshot(room.id)!;
    const potAfterFirst = afterFirst.pot;
    const seat0StackAfterFirst = afterFirst.seats.find((s) => s.seatIndex === 0)!.chipStack;
    // It is now BB(1)'s turn.
    expect(afterFirst.toActSeatIndex).toBe(1);

    // Re-send the SAME action frame (same handNumber + actionSeq + actor).
    // Idempotent: no chip movement, turn pointer unchanged, no error frame.
    ws0.sent.length = 0;
    await sendAction(ws0, 1, { kind: 'call' });
    const afterDup = pokerTableSim.getPublicSnapshot(room.id)!;
    expect(afterDup.pot).toBe(potAfterFirst);
    expect(afterDup.seats.find((s) => s.seatIndex === 0)!.chipStack).toBe(seat0StackAfterFirst);
    expect(afterDup.toActSeatIndex).toBe(1);
    // The duplicate replayed the prior OK result → no error frame to the actor.
    const errAfterDup = frames(ws0).find((f) => f.type === 'error');
    expect(errAfterDup).toBeUndefined();
  });

  it('rejects an out-of-turn / illegal action with a PRIVATE error (not broadcast)', async () => {
    const { room, ws0, ws1 } = await setupAuthedRoom();
    startDemoHand(room.id);

    // It is seat 0's turn preflop (heads-up button/SB acts first). Seat 1
    // tries to act out of turn → private error to ws1, nothing to ws0.
    ws0.sent.length = 0;
    ws1.sent.length = 0;
    await sendAction(ws1, 1, { kind: 'check' });

    const err = frames(ws1).find((f) => f.type === 'error');
    expect(err).toBeDefined();
    expect((err as unknown as { code: string }).code).toBe('not_your_turn');
    // The opponent (seat 0) must NOT have learned that seat 1 mis-acted.
    expect(pokerFrames(ws0).length).toBe(0);
    expect(frames(ws0).find((f) => f.type === 'error')).toBeUndefined();
  });
});
