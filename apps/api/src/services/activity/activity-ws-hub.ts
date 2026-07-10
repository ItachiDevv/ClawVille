/**
 * Q2 Activity Portals — WebSocket hub service (chunk #3).
 *
 * Per backend §3 + §4. Single hub instance owns:
 *   - Per-room WS connection registry
 *   - Auth handshake (first frame must be `auth`)
 *   - Broadcast fan-out with backpressure + slow-read disconnect
 *   - Disconnect grace (10s reconnect window) with forfeit-on-timeout
 *   - Ingress Zod validation of every `ClientFrame`
 *
 * The hub DOES NOT own sim state. It delegates `input` frames to the
 * Bumper Shells sim (chunk #3) and — when Reef Race lands in chunk #5 —
 * will dispatch based on room activityId.
 *
 * Bun-native WS via Hono's `createBunWebSocket` — see `activities.ts`
 * route for the upgrade handler + `apps/api/src/index.ts` for the
 * `websocket` fetch-handler wiring.
 */

import type { ServerFrame, ClientFrame, WorldState } from '@clawville/shared';
import {
  clientFrameSchema,
  ACTIVITY_WS_CLOSE_CODES,
} from '@clawville/shared';
import {
  resolveActivityIdentity,
  type ActivityIdentity,
} from '../../middleware/require-auth-or-agent';
import { activityRoomManager } from './activity-room-manager';
import {
  bumperShellsSim,
  BUMPER_TICK_HZ,
} from './sim/bumper-shells-sim';
import { reefRaceSim } from './sim/reef-race-sim';
import { reefRaceSplineSim } from './sim/reef-race-spline-sim';
import { REEF_RACE_USE_SPLINE } from './sim/reef-race-config';

/**
 * Reef Race v2 sim selector. Single source of truth — every reef-race
 * dispatch site reads through this to keep the env-flag check from
 * drifting. The spline sim's public method shape mirrors `reefRaceSim` so
 * the call sites need no further branching beyond `getReefSim()`.
 *
 * Wave 2 follow-ups (spline sim is missing these methods):
 *   - getStaticZones — ellipse-only ribbons/apex/hazards; v2 has none today
 *   - getRacingProfiles — avatar-stat HUD broadcast not yet ported
 * Both calls below guard with `'method' in sim` so the dispatcher degrades
 * gracefully when the spline path is active.
 */
function getReefSim(): typeof reefRaceSim | typeof reefRaceSplineSim {
  return REEF_RACE_USE_SPLINE
    ? (reefRaceSplineSim as unknown as typeof reefRaceSim)
    : reefRaceSim;
}
import { InputRateTracker, validateChatBounds } from './anti-cheat/shared';
import { logEvent } from '../event-logger';
import type { Room, RoomParticipant } from './types';
// Texas Hold'em (P1.2b) — the live poker table sim singleton. Inbound
// `poker.action` frames route to `applyAction`; the sim's own broadcast /
// per-seat / hand-complete callbacks are registered in `index.ts` at boot.
import { pokerTableSim } from '../poker/poker-table-sim-singleton';
import type { PokerTableSim } from '../poker/poker-table-sim';
import type { Action as PokerSimAction } from '../poker/poker-table-types';

/**
 * Poker MTT (P3.5) — the dispatch seam for tournament tables. The hub does NOT
 * hard-import the MTT sim + TournamentManager singletons (that would force the
 * `poker/tournament-manager` → `claw-token-ledger` → DB import chain into every
 * hub test, and pin the dispatch to the singletons so a test can't inject its
 * own instances). Instead the MTT bridge registers `{ sim, resolveRoomToTable }`
 * here at boot via `setMttDispatch`. Both production (`pokerMttSim` +
 * `tournamentManager`) and the integration test (a fake-clock sim + a fake-db TM)
 * register through the SAME path, so the hub's `texas-holdem-mtt` dispatch always
 * hits the SAME sim+TM that seated the room. Null until the bridge wires it.
 */
export interface MttDispatch {
  /** The MTT sim to apply tournament-table actions to. */
  sim: PokerTableSim;
  /** Translate a WS roomId → the sim tableId (`mtt:<tournamentId>`). */
  resolveRoomToTable: (roomId: string) => string | undefined;
}
// Phase 4 — self avatar's PB ghost frames (sent once per snapshot.init,
// per-recipient — the WS hub is the only server-side surface that
// resolves the connecting identity, so the gating lives here).
import { loadPersonalBestGhostFrames } from './reef-race-personal-best-service';
// SPEC 1 — per-avatar modelKey metadata for GLB dispatch on the client.
import { loadParticipantMeta } from './avatar-profile-loader';

// ─── Constants — backend §3.6 ──────────────────────────────────────────────

/** Drop non-critical frames once the send buffer exceeds this (bytes) */
const BACKPRESSURE_DROP_BYTES = 50_000;

/** Buffer-full duration before we start skipping broadcasts (ms) */
const SLOW_READ_SKIP_MS = 3_000;

/** Buffer-full duration before we close with 4002 (ms) */
const SLOW_READ_CLOSE_MS = 8_000;

/** Reconnect grace after an unexpected disconnect (ms) */
const RECONNECT_GRACE_MS = 10_000;

// ─── Per-connection stashed state ──────────────────────────────────────────

/**
 * Minimal transport abstraction over whatever WS primitive the caller
 * holds. Hono's bun adapter passes a `WSContext` to the lifecycle
 * handlers; tests can plug in a fake. The hub doesn't depend on Bun's
 * `ServerWebSocket` directly, keeping unit tests trivial.
 */
export interface HubWsTransport {
  send(frame: string): void;
  close(code: number, reason: string): void;
  /** Bun-native method; tests stub to 0 */
  getBufferedAmount?(): number;
  /**
   * Per-connection state owned by the hub — see `WsConnectionData`.
   * Ownership contract: the route's factory calls
   * `activityWsHub.makeConnectionData(roomId)` and attaches the result
   * here before `registerConnection` runs.
   */
  data: WsConnectionData;
}

export interface WsConnectionData {
  /** Populated after successful auth handshake */
  identity: ActivityIdentity | null;
  roomId: string;
  /** Allocated for disconnect-grace bookkeeping + forfeit-on-timeout */
  connectionId: string;
  /** authed = handshake succeeded */
  authed: boolean;
  lastPingAt: number;
  lastInputSeq: number;
  flagCount: number;
  bufferFullSince: number | null;
  /** Skipped broadcast count during slow-read skip window */
  skippedBroadcasts: number;
  /** Cached handshake short-code — protects against stolen URL with wrong code */
  shortCode: string | null;
  /** Close code the hub set internally — Bun close events don't always carry it */
  internalCloseCode: number | null;
  /**
   * Lucia session id extracted from the upgrade request's Cookie header.
   * The client sends the literal placeholder `'cookie'` in the auth frame
   * when relying on the browser cookie (see `useActivityWs.ts` — the WS
   * upgrade attaches the cookie automatically, but the auth-frame schema
   * requires a non-empty string). The hub then resolves identity using
   * this value instead of the placeholder. Null when no Lucia cookie was
   * attached (agent-session callers, who pass their own session id).
   */
  preauthLuciaSessionId: string | null;
}

export type HubWs = HubWsTransport;

// ─── Hub ────────────────────────────────────────────────────────────────────

class ActivityWsHub {
  /** SINGLE-POD: per-room → avatarId → WS connection */
  private rooms = new Map<string, Map<string, HubWs>>();

  /** Reconnect grace timers keyed by `${roomId}:${avatarId}` */
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Rate tracker shared across all rooms (stateless per-avatar) */
  private rateTracker = new InputRateTracker();

  /**
   * P3.5 — the tournament-table dispatch seam, registered by the MTT WS bridge at
   * boot. Null until wired (no MTT tables can be played before then). See
   * `MttDispatch` above for why this is a registration, not a hard import.
   */
  private mttDispatch: MttDispatch | null = null;

  // ─── Registration ────────────────────────────────────────────────────

  /**
   * Handshake + register. Returns false if auth fails (caller closes
   * the WS with 4001) or if the avatar isn't in the room participants.
   */
  async registerConnection(ws: HubWs, firstFrame: ClientFrame): Promise<boolean> {
    if (firstFrame.type !== 'auth') {
      this.safeClose(ws, ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED, 'first frame must be auth');
      return false;
    }
    // The client sends the literal string `'cookie'` (see
    // `useActivityWs.ts:166`) when relying on the browser cookie that the
    // WS upgrade attaches automatically. In that case, swap in the Lucia
    // session id we resolved at upgrade time. Real session tokens (raw
    // Lucia ids minted via `/api/auth/guest` or magic-link, or agent
    // session ids passed by headless callers) pass through unchanged.
    const tokenForResolve =
      firstFrame.sessionToken === 'cookie' && ws.data.preauthLuciaSessionId
        ? ws.data.preauthLuciaSessionId
        : firstFrame.sessionToken;
    const identity = await resolveActivityIdentity({
      sessionToken: tokenForResolve,
    });
    if (!identity) {
      this.safeClose(ws, ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED, 'invalid session');
      return false;
    }

    const roomId = ws.data.roomId;
    const room = activityRoomManager.getRoom(roomId);
    if (!room) {
      this.safeClose(ws, ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED, 'room not found');
      return false;
    }
    if (room.shortCode !== firstFrame.shortCode) {
      this.safeClose(ws, ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED, 'shortCode mismatch');
      return false;
    }
    const participant = room.participants.get(identity.avatarId);
    if (!participant) {
      this.safeClose(ws, ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED, 'not a participant');
      return false;
    }

    // Wire up per-connection state.
    ws.data.identity = identity;
    ws.data.authed = true;
    ws.data.shortCode = firstFrame.shortCode;
    ws.data.lastPingAt = Date.now();

    // Mark participant connected + clear any pending reconnect-grace timer.
    this.clearGraceTimer(roomId, identity.avatarId);
    participant.connected = true;
    participant.disconnectedAt = null;
    participant.wsConnectionId = ws.data.connectionId;

    // Index the connection.
    let roomMap = this.rooms.get(roomId);
    if (!roomMap) {
      roomMap = new Map();
      this.rooms.set(roomId, roomMap);
    }
    // If the same avatar has an existing connection (reconnect collision),
    // close the old one first.
    const existing = roomMap.get(identity.avatarId);
    if (existing && existing !== ws) {
      this.safeClose(existing, ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED, 'superseded by new connection');
    }
    roomMap.set(identity.avatarId, ws);

    // Re-anchor a soon-to-expire COUNTDOWN BEFORE building the snapshot so the
    // `RoomMeta.countdownStartedAt` carried by snapshot.init (which the HUD's
    // local 3-2-1 ticker reads) and the one-shot `event.countdown` below agree
    // on the SAME window. createRoom() arms the COUNTDOWN→LIVE timer at room
    // creation, but the client only connects after navigating the browser —
    // that latency burned the countdown (remaining=0 ⇒ overlay gated out, or
    // the room already auto-advanced to LIVE), so the HUD jumped straight to
    // RACE 0% with no 3-2-1. Sim-agnostic: the sim doesn't own the countdown
    // and only starts at LIVE; this fixes both the ellipse and CLOSED-LOOP
    // spline paths. No-op for a healthy window (see ensureSyncedCountdown).
    if (room.state === 'countdown') {
      activityRoomManager.ensureSyncedCountdown(room.id);
    }

    // Send snapshot.init. Source varies by room state:
    //   COUNTDOWN → participant roster + empty world
    //   LIVE      → actual sim snapshot
    //   RESULTS   → last snapshot + match_ended preview
    // Phase 4 — sendInit now async (1 PB-ghost DB read for Reef Race
    // self avatar). Awaiting here keeps the snapshot.init delivery ordered
    // BEFORE the countdown event below.
    await this.sendInit(ws, room);

    // If the room is in COUNTDOWN, also send the countdown seconds remaining.
    if (room.state === 'countdown') {
      const countdownStartedAt = room.countdownStartedAt ?? Date.now();
      const elapsed = Date.now() - countdownStartedAt;
      const remaining = Math.max(0, Math.ceil((5_000 - elapsed) / 1000));
      this.safeSend(ws, { type: 'event.countdown', secondsRemaining: remaining });
    }

    return true;
  }

  /**
   * Tear down on close or error. Called by the route's WS lifecycle
   * handler. Sets up the 10s reconnect grace.
   */
  unregisterConnection(ws: HubWs): void {
    const data = ws.data;
    const roomMap = this.rooms.get(data.roomId);
    if (!roomMap) return;
    if (!data.identity) return;
    const avatarId = data.identity.avatarId;

    const current = roomMap.get(avatarId);
    if (current !== ws) {
      // Stale close for a superseded connection — ignore.
      return;
    }
    roomMap.delete(avatarId);
    if (roomMap.size === 0) this.rooms.delete(data.roomId);

    const room = activityRoomManager.getRoom(data.roomId);
    if (!room) return;

    const participant = room.participants.get(avatarId);
    if (!participant) return;
    participant.connected = false;
    participant.disconnectedAt = Date.now();
    participant.wsConnectionId = null;

    // If the hub internally closed with INTEGRITY, don't grant grace.
    if (data.internalCloseCode === ACTIVITY_WS_CLOSE_CODES.INTEGRITY) {
      this.notifyForfeit(room, avatarId, 'integrity');
      return;
    }

    // If the WS closed voluntarily (e.g. `leave` frame), forfeit right
    // away — no grace.
    // Voluntary leave is tracked by the route `onMessage` handler which
    // sets an internalCloseCode of 1000 before the close fires.
    if (data.internalCloseCode === 1000) {
      this.notifyForfeit(room, avatarId, 'voluntary');
      return;
    }

    // Otherwise set a 10s grace timer.
    const key = `${data.roomId}:${avatarId}`;
    const timer = setTimeout(() => {
      this.graceTimers.delete(key);
      const stillRoom = activityRoomManager.getRoom(data.roomId);
      if (!stillRoom) return;
      const p = stillRoom.participants.get(avatarId);
      if (!p) return;
      if (p.connected) return; // reconnected in time
      this.notifyForfeit(stillRoom, avatarId, 'timeout');
    }, RECONNECT_GRACE_MS);
    this.graceTimers.set(key, timer);
  }

  /**
   * Handle an inbound message. Called by the route's `onMessage`.
   * Returns `true` if the connection was closed as a result.
   */
  async handleMessage(ws: HubWs, raw: string | ArrayBuffer | Uint8Array): Promise<void> {
    let parsed: unknown;
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      parsed = JSON.parse(text);
    } catch {
      this.safeSend(ws, { type: 'error', code: 'bad_frame', message: 'invalid json' });
      return;
    }
    const validation = clientFrameSchema.safeParse(parsed);
    if (!validation.success) {
      this.safeSend(ws, {
        type: 'error',
        code: 'bad_frame',
        message: validation.error.issues[0]?.message ?? 'schema violation',
      });
      return;
    }
    const frame = validation.data;

    if (!ws.data.authed) {
      // Only `auth` is accepted pre-handshake.
      if (frame.type !== 'auth') {
        this.safeClose(ws, ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED, 'auth required');
        return;
      }
      await this.registerConnection(ws, frame);
      return;
    }

    switch (frame.type) {
      case 'auth':
        // Re-auth on an already-authed socket is a silent no-op.
        return;
      case 'input':
        this.handleInput(ws, frame);
        return;
      case 'ping':
        ws.data.lastPingAt = Date.now();
        this.safeSend(ws, {
          type: 'pong',
          sentAt: frame.sentAt,
          serverTime: Date.now(),
        });
        return;
      case 'chat':
        this.handleChat(ws, frame);
        return;
      case 'emote':
        // Emote is broadcast as a chat frame with special shape — simpler
        // to just re-use `chat` transport for chunk #3.
        return;
      case 'leave':
        ws.data.internalCloseCode = 1000;
        this.safeClose(ws, 1000, 'voluntary leave');
        return;
      case 'poker.action':
        this.handlePokerAction(ws, frame);
        return;
      case 'poker.sit_out':
      case 'poker.sit_in':
        // Sit-out / sit-in are accepted at the protocol level but are a no-op
        // in P1.2b (the demo sim re-seats every participant each hand). The
        // server-side seat-state mutation lands with persistence in a later
        // phase. Silently accepted so a forward-looking client doesn't error.
        return;
    }
  }

  /**
   * Route an inbound `poker.action` frame to the correct poker sim — dispatching
   * by `room.activityId` (P3.5):
   *   - `texas-holdem`     → the DEMO `pokerTableSim`, addressed by `roomId`
   *     (tableId === roomId, one live hand per room).
   *   - `texas-holdem-mtt` → the tournament `pokerMttSim`, addressed by the sim
   *     `tableId` (`mtt:<tournamentId>`) translated from the roomId via the
   *     TournamentManager's `resolveRoomToTable`. The two sims + activityIds are
   *     fully isolated — a demo action can never reach the MTT sim and vice-versa.
   *
   * The actor's avatarId comes from the AUTHED identity on the connection — the
   * client never names the seat, so an actor can only ever act AS ITSELF
   * (human-XOR-agent parity, resolved on the auth frame). The idempotency key is
   * `<handNumber>:<actionSeq>:<avatarId>` so a retransmit (same hand, same seq,
   * same actor) is a stable no-op inside the sim. On an illegal / rejected action
   * the actor gets a PRIVATE `error` frame (never broadcast — an opponent must not
   * learn that a seat fat-fingered an illegal raise).
   *
   * NOTE: poker is NOT routed through `handleInput` (that's continuous motion for
   * the racing/bumper sims and is rate-limited as such). Turn-based betting actions
   * are infrequent and gate on the sim's own "is it your turn" check.
   */
  private handlePokerAction(
    ws: HubWs,
    frame: Extract<ClientFrame, { type: 'poker.action' }>,
  ): void {
    const identity = ws.data.identity!;
    const room = activityRoomManager.getRoom(ws.data.roomId);
    if (!room) {
      this.safeSend(ws, {
        type: 'error',
        code: 'no_room',
        message: 'room not found',
      });
      return;
    }

    // Resolve which sim + which table id this action targets, by activityId.
    let sim: PokerTableSim;
    let tableId: string;
    if (room.activityId === 'texas-holdem') {
      sim = pokerTableSim;
      tableId = ws.data.roomId; // demo: tableId === roomId
    } else if (room.activityId === 'texas-holdem-mtt') {
      if (!this.mttDispatch) {
        // The MTT bridge hasn't registered the dispatch seam — no tournament
        // tables can be played. Private rejection (no broadcast).
        this.safeSend(ws, {
          type: 'error',
          code: 'mtt_unavailable',
          message: 'tournament dispatch not wired',
        });
        return;
      }
      const mttTableId = this.mttDispatch.resolveRoomToTable(ws.data.roomId);
      if (!mttTableId) {
        // The tournament ended / the room↔table binding was torn down — the table
        // is gone. Treat as a private rejection (no broadcast).
        this.safeSend(ws, {
          type: 'error',
          code: 'no_table',
          message: 'tournament table not found for room',
        });
        return;
      }
      sim = this.mttDispatch.sim;
      tableId = mttTableId;
    } else {
      this.safeSend(ws, {
        type: 'error',
        code: 'wrong_activity',
        message: 'poker action sent to a non-poker room',
      });
      return;
    }

    // The shared `PokerActionPayload` is structurally identical to the sim's
    // `Action` (discriminated on `kind`); the cast documents that boundary.
    const action = frame.action as PokerSimAction;
    const idempotencyKey = `${frame.handNumber}:${frame.actionSeq}:${identity.avatarId}`;

    const result = sim.applyAction(tableId, identity.avatarId, action, {
      idempotencyKey,
    });

    if (!result.ok) {
      // Private rejection — the sim's broadcast/per-seat callbacks (registered in
      // index.ts / the MTT bridge) already emitted any state change on a SUCCESSFUL
      // action; a rejected action mutates nothing, so we only owe the actor an error.
      this.safeSend(ws, {
        type: 'error',
        code: result.reason ?? 'illegal_action',
        message: result.reason ?? 'illegal action',
      });
    }
  }

  /**
   * Send a frame to a single avatar. Used by the queue's match.found
   * delivery (chunk #2 registered this callback) and by the sim for
   * per-avatar events.
   */
  sendToAvatar(roomId: string, avatarId: string, frame: ServerFrame): void {
    const ws = this.rooms.get(roomId)?.get(avatarId);
    if (!ws) return;
    this.safeSend(ws, frame);
  }

  /** Broadcast a frame to every connected avatar in the room */
  broadcastEvent(roomId: string, frame: ServerFrame): void {
    const roomMap = this.rooms.get(roomId);
    if (!roomMap) return;
    for (const ws of roomMap.values()) {
      this.safeSend(ws, frame);
    }
  }

  /**
   * Broadcast a sim snapshot with backpressure awareness. Dropped for
   * clients over the BACKPRESSURE_DROP_BYTES threshold — non-critical
   * by definition (delta OR keyframe; recovery floor = keyframe at 1Hz).
   */
  broadcastSnapshot(roomId: string, frame: ServerFrame): void {
    const roomMap = this.rooms.get(roomId);
    if (!roomMap) return;
    const isKeyframe = frame.type === 'snapshot.keyframe';
    for (const ws of roomMap.values()) {
      const buffered = ws.getBufferedAmount?.() ?? 0;
      if (buffered > BACKPRESSURE_DROP_BYTES && !isKeyframe) {
        this.trackSlowRead(ws);
        continue;
      }
      if (buffered > BACKPRESSURE_DROP_BYTES && isKeyframe) {
        // Even keyframes get dropped if the socket is hopelessly behind
        // — close-with-4002 path kicks in below.
        this.trackSlowRead(ws);
        continue;
      }
      // Socket is draining — clear any pending slow-read tracking.
      ws.data.bufferFullSince = null;
      ws.data.skippedBroadcasts = 0;
      this.safeSend(ws, frame);
    }
  }

  /** How many connected WS participants a room has right now */
  getActiveConnections(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  /**
   * P3.5 — register the tournament-table dispatch seam. Called once by the MTT WS
   * bridge at boot (production) / per-test (integration). Idempotent overwrite.
   */
  setMttDispatch(dispatch: MttDispatch): void {
    this.mttDispatch = dispatch;
  }

  /** Test hook — wipe all in-memory state */
  __resetForTest(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.rooms.clear();
    this.rateTracker.__resetForTest();
    // Leave `mttDispatch` intact across resets: the integration test wires it once
    // (via the bridge) in beforeEach AFTER __resetForTest, and production wires it
    // once at boot — clearing it here would strand MTT dispatch. A re-wire simply
    // overwrites it.
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private handleInput(ws: HubWs, frame: Extract<ClientFrame, { type: 'input' }>): void {
    const identity = ws.data.identity!;
    // Rate-limit inbound inputs.
    const rate = this.rateTracker.validateInputRate(identity.avatarId);
    if (!rate.ok) {
      this.safeSend(ws, { type: 'error', code: 'input_rate', message: 'rate limit' });
      return;
    }
    // Dispatch to the sim. Chunk #3 = Bumper only. Chunk #5 adds Reef.
    const room = activityRoomManager.getRoom(ws.data.roomId);
    if (!room) return;

    // Reef Race Phase 1 — capture pre-launch thrust during COUNTDOWN so the
    // sim can credit a launch-boost / launch-stall verdict at the LIVE
    // transition (audit C4 fix). Falls THROUGH to the existing applyInput
    // dispatch — sim returns {ok:false} for unknown rooms during countdown,
    // which is exactly the silent-no-op behaviour we want.
    if (
      room.activityId === 'reef-race' &&
      room.state === 'countdown' &&
      typeof frame.thrust === 'number' &&
      frame.thrust >= 1.0
    ) {
      activityRoomManager.recordPreLaunchInput(
        ws.data.roomId,
        identity.avatarId,
        Date.now(),
        frame.thrust,
      );
    }

    if (room.activityId === 'bumper-shells') {
      const out = bumperShellsSim.applyInput(
        ws.data.roomId,
        identity.avatarId,
        frame.seq,
        frame.dt,
        {
          dir: frame.dir,
          thrust: frame.thrust,
          actionBits: frame.actionBits,
        },
      );
      void out; // flag handling routed via the sim's integrityForfeitFn
    } else if (room.activityId === 'reef-race') {
      // Reef Race v2 — dispatch to spline sim when REEF_RACE_USE_SPLINE is
      // true. Both sims expose an identical applyInput surface so the call
      // site is unchanged beyond the `getReefSim()` selector.
      const out = getReefSim().applyInput(
        ws.data.roomId,
        identity.avatarId,
        frame.seq,
        frame.dt,
        {
          dir: frame.dir,
          thrust: frame.thrust,
          actionBits: frame.actionBits,
        },
      );
      void out;
    }
    // else: unknown activity — sim missing for this activityId
  }

  private handleChat(ws: HubWs, frame: Extract<ClientFrame, { type: 'chat' }>): void {
    const verdict = validateChatBounds(frame.text);
    if (!verdict.ok) {
      this.safeSend(ws, { type: 'error', code: 'bad_chat', message: verdict.detail ?? 'invalid' });
      return;
    }
    this.broadcastEvent(ws.data.roomId, {
      type: 'chat',
      avatarId: ws.data.identity!.avatarId,
      text: verdict.value,
    });
  }

  private async sendInit(ws: HubWs, room: Room): Promise<void> {
    // Build a WorldState snapshot from the current room members.
    // Explicitly typed as the protocol WorldState entity array so the reef-race
    // branch can push the v2 mechanics fields (miniTurboCharge/Level/boosting,
    // height) — the inferred type from this initial participant map omits them,
    // which broke the Codex-finding-7 keyframe/init wire fix (TS2353).
    const entities: WorldState['entities'] = Array.from(room.participants.values()).map((p) => ({
      avatarId: p.avatarId,
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      rotation: 0,
      state: p.connected ? 'alive' : 'disconnected',
    }));
    let tick = 0;
    let powerUps: Array<{ spawnId: string; kind: string; position: { x: number; y: number } }> = [];
    if (room.activityId === 'bumper-shells') {
      const bumperState = bumperShellsSim.getStateSnapshot(room.id);
      if (bumperState) {
        tick = bumperState.tick;
        entities.length = 0;
        for (const b of bumperState.bodies) {
          entities.push({
            avatarId: b.avatarId,
            position: { x: b.x, y: b.y },
            velocity: { x: b.vx, y: b.vy },
            rotation: b.rot,
            state: b.alive ? 'alive' : 'eliminated',
          });
        }
        powerUps = bumperState.spawns
          .filter((s) => s.active)
          .map((s) => ({
            spawnId: s.spawnId,
            kind: s.kind,
            position: { x: s.x, y: s.y },
          }));
      }
    } else if (room.activityId === 'reef-race') {
      const reefState = getReefSim().getStateSnapshot(room.id);
      if (reefState) {
        tick = reefState.tick;
        entities.length = 0;
        for (const b of reefState.bodies) {
          // v1 snapshot bodies expose .y/.vy (XY plane). v2 spline-sim
          // snapshot bodies expose .z/.vz (XZ plane) — but the wire
          // protocol always uses {x, y} = (sceneX, sceneZ). Normalize at
          // the boundary so the client side is sim-agnostic.
          const bb = b as {
            y?: number;
            z?: number;
            vy?: number;
            vz?: number;
            height?: number;
            miniTurboCharge?: number;
            miniTurboLevel?: 0 | 1 | 2;
            boosting?: boolean;
          };
          const yScene = bb.y ?? bb.z ?? 0;
          const vyScene = bb.vy ?? bb.vz ?? 0;
          entities.push({
            avatarId: b.avatarId,
            position: { x: b.x, y: yScene },
            velocity: { x: b.vx, y: vyScene },
            rotation: b.rot,
            state: b.dnf
              ? 'dnf'
              : b.finishedAt !== null
                ? 'finished'
                : 'racing',
            // v2 spline-sim: carry boost/meter state on a LIVE reconnect so the
            // HUD meter/trail isn't blank until the next delta (Codex finding 7).
            // Ellipse-sim snapshots omit these fields (undefined → dropped).
            ...(bb.height && bb.height !== 0 ? { height: bb.height } : {}),
            miniTurboCharge: bb.miniTurboCharge,
            miniTurboLevel: bb.miniTurboLevel,
            boosting: bb.boosting,
          });
        }
        powerUps = reefState.pickups
          .filter((p) => p.active)
          .map((p) => {
            const pp = p as { y?: number; z?: number };
            return {
              spawnId: p.spawnId,
              kind: p.kind,
              position: { x: p.x, y: pp.y ?? pp.z ?? 0 },
            };
          });
      }
    }
    // Phase 2 — pull static-zone positions for reef-race rooms so the client
    // can build visual meshes (ribbons, apex markers, hazards) from a single
    // server-authoritative source. `null` for non-reef-race rooms.
    //
    // Spline-sim (v2) has NO ribbons/apex/hazards (oval-only mechanics) — the
    // method itself doesn't exist on the v2 sim. Wave 2 follow-up: spline
    // sim should expose its own static zones (jump ramps, dive arches) on
    // a parallel surface; until then, omit and the client renders no zones.
    const reefStaticZones =
      room.activityId === 'reef-race' && !REEF_RACE_USE_SPLINE
        ? reefRaceSim.getStaticZones(room.id) ?? undefined
        : undefined;
    // v2 mechanics — spline-sim boost-pad + ramp trigger zones so the client can
    // render them (the spline sim has no ribbons/apex/hazards; these replace
    // that Wave-2 gap for the boost pads + ramps). Only under REEF_RACE_USE_SPLINE.
    // Room-independent (Codex finding 8): the pads/ramps are STATIC track
    // features, so this returns real zones even during countdown (before the sim
    // room exists) — no permanent client fallback to reconstructed pads.
    const reefSplineZones =
      room.activityId === 'reef-race' && REEF_RACE_USE_SPLINE
        ? reefRaceSplineSim.getSplineStaticZones()
        : undefined;
    // Phase 3 — pull per-avatar racing profile (class + level) for reef-race
    // rooms so the HUD's archetype tile can show the player WHY they have
    // the multipliers they have (audit S5 fix: room-wide one-shot map,
    // ~50 bytes × ≤8 = ≤400 bytes total).
    //
    // Spline-sim (v2) doesn't expose this method either — the same Wave 2
    // gap. Skipping is safe (HUD falls back to no-class-tile state).
    const reefRacingProfiles =
      room.activityId === 'reef-race' && !REEF_RACE_USE_SPLINE
        ? reefRaceSim.getRacingProfiles(room.id) ?? undefined
        : undefined;

    // Phase 4 — self avatar's PB ghost replay frames. Sent ONCE per
    // snapshot.init for the SELF avatar only (no rivals — too crowded per
    // spec §2). Per-recipient by construction: the WS hub gates on
    // ws.data.identity.avatarId, so other connections never see this avatar's
    // ghost on their snapshot.init. Skipped for guests (identity may be
    // unset early) + non-Reef-Race rooms.
    let selfBestLapGhost: Awaited<ReturnType<typeof loadPersonalBestGhostFrames>> = undefined;
    if (room.activityId === 'reef-race' && ws.data.identity?.avatarId) {
      try {
        selfBestLapGhost = await loadPersonalBestGhostFrames(
          ws.data.identity.avatarId,
        );
      } catch (err) {
        // Logged in the loader; defensive double-catch so a transient
        // DB hiccup never blocks snapshot.init.
        console.warn(
          '[activity-ws-hub] PB ghost load failed; sending snapshot.init without ghost:',
          err,
        );
        selfBestLapGhost = undefined;
      }
    }

    // SPEC 1 — per-avatar modelKey metadata for GLB dispatch on the client.
    // Pattern mirrors reefRacingProfiles (Phase 3). DB query is ≤8 rows,
    // ~1ms. Falls back to all-lobster on error.
    // No !REEF_RACE_USE_SPLINE guard: this is display-only (not sim-coupled)
    // and equally needed in both spline-sim and non-spline-sim modes.
    let reefParticipantMeta: Record<string, { modelKey: string }> | undefined;
    if (room.activityId === 'reef-race') {
      const allAvatarIds = Array.from(room.participants.keys());
      const humanAvatarIds = allAvatarIds.filter(
        (id) => room.participants.get(id)!.subjectType !== 'bot',
      );
      const botAvatarIds = allAvatarIds.filter(
        (id) => room.participants.get(id)!.subjectType === 'bot',
      );
      try {
        reefParticipantMeta = await loadParticipantMeta(humanAvatarIds, botAvatarIds);
      } catch (err) {
        console.error('[activity-ws-hub] loadParticipantMeta failed:', err);
        reefParticipantMeta = undefined; // client falls back to lobster
      }
    }

    this.safeSend(ws, {
      type: 'snapshot.init',
      room: {
        roomId: room.id,
        shortCode: room.shortCode,
        activityId: room.activityId,
        status: room.state === 'countdown' ? 'countdown' : room.state === 'live' ? 'live' : 'results',
        startedAt: room.startedAt ?? undefined,
        // Reef Race Phase 1 — HUD launch-glow ring computes secondsRemaining
        // locally from this so it doesn't depend on a per-second countdown
        // event the room manager doesn't currently emit (audit S9 fix).
        countdownStartedAt: room.countdownStartedAt ?? undefined,
        // Reef Race Phase 2 — server-authoritative static-zone positions
        // for ribbons / apex markers / hazards. Sent ONCE per snapshot.init.
        reefStaticZones,
        // Reef Race v2 mechanics — boost-pad + ramp trigger zones (spline sim).
        // Sent ONCE per snapshot.init; client builds pad/ramp visuals from these.
        reefSplineZones,
        // Reef Race Phase 3 — per-avatar (class, level). Sent ONCE per
        // snapshot.init. Client filters by self avatarId.
        reefRacingProfiles,
        // Reef Race Phase 4 — self avatar's PB ghost replay frames.
        selfBestLapGhost,
        // Reef Race SPEC 1 — per-avatar modelKey for GLB dispatch (lobster/crayfish/seahorse).
        reefParticipantMeta,
      },
      world: {
        tick,
        entities,
        powerUps,
        scores: [],
      },
      seed: 0,
    });
  }

  private trackSlowRead(ws: HubWs): void {
    const now = Date.now();
    if (ws.data.bufferFullSince == null) {
      ws.data.bufferFullSince = now;
      ws.data.skippedBroadcasts = 1;
      return;
    }
    const age = now - ws.data.bufferFullSince;
    ws.data.skippedBroadcasts += 1;
    if (age < SLOW_READ_SKIP_MS) return;
    if (age >= SLOW_READ_SKIP_MS && age < SLOW_READ_CLOSE_MS) {
      const identity = ws.data.identity;
      if (identity && ws.data.skippedBroadcasts === 1) {
        // Only log once per sustained episode.
        void logEvent({
          eventType: 'activity.ws.slow_client',
          avatarId: identity.avatarId,
          payload: { roomId: ws.data.roomId, bufferedMs: age },
        });
      }
      return;
    }
    // age ≥ SLOW_READ_CLOSE_MS — close.
    ws.data.internalCloseCode = ACTIVITY_WS_CLOSE_CODES.SLOW_READ;
    this.safeClose(ws, ACTIVITY_WS_CLOSE_CODES.SLOW_READ, 'slow read');
  }

  private notifyForfeit(room: Room, avatarId: string, reason: 'voluntary' | 'timeout' | 'integrity'): void {
    // Forfeit the body in the sim if one is running.
    if (room.activityId === 'bumper-shells' && room.state === 'live') {
      bumperShellsSim.forfeit(room.id, avatarId, reason);
    } else if (room.activityId === 'reef-race' && room.state === 'live') {
      getReefSim().forfeit(room.id, avatarId, reason);
    }
    this.broadcastEvent(room.id, {
      type: 'event.player_left',
      avatarId,
      reason,
    });
  }

  private clearGraceTimer(roomId: string, avatarId: string): void {
    const key = `${roomId}:${avatarId}`;
    const timer = this.graceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(key);
    }
  }

  private safeSend(ws: HubWs, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      console.warn('[activity-ws-hub] send failed:', err);
    }
  }

  private safeClose(ws: HubWs, code: number, reason: string): void {
    try {
      if (ws.data) ws.data.internalCloseCode = code;
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  /**
   * Factory used by the route's upgradeWebSocket factory. Called for
   * every incoming WS upgrade to bootstrap the per-connection state.
   */
  makeConnectionData(
    roomId: string,
    preauthLuciaSessionId: string | null = null,
  ): WsConnectionData {
    return {
      identity: null,
      roomId,
      connectionId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      authed: false,
      lastPingAt: Date.now(),
      lastInputSeq: 0,
      flagCount: 0,
      bufferFullSince: null,
      skippedBroadcasts: 0,
      shortCode: null,
      internalCloseCode: null,
      preauthLuciaSessionId,
    };
  }
}

export const activityWsHub = new ActivityWsHub();

// ─── Exports for sim wiring ────────────────────────────────────────────────

void BUMPER_TICK_HZ; // keep import pinned for sim tick-rate reference
