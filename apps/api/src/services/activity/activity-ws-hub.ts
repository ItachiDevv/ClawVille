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

import type { ServerFrame, ClientFrame } from '@clawville/shared';
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
import { InputRateTracker, validateChatBounds } from './anti-cheat/shared';
import { logEvent } from '../event-logger';
import type { Room, RoomParticipant } from './types';

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

    // Send snapshot.init. Source varies by room state:
    //   COUNTDOWN → participant roster + empty world
    //   LIVE      → actual sim snapshot
    //   RESULTS   → last snapshot + match_ended preview
    this.sendInit(ws, room);

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

  /** Test hook — wipe all in-memory state */
  __resetForTest(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.rooms.clear();
    this.rateTracker.__resetForTest();
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
      const out = reefRaceSim.applyInput(
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

  private sendInit(ws: HubWs, room: Room): void {
    // Build a WorldState snapshot from the current room members.
    const entities = Array.from(room.participants.values()).map((p) => ({
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
      const reefState = reefRaceSim.getStateSnapshot(room.id);
      if (reefState) {
        tick = reefState.tick;
        entities.length = 0;
        for (const b of reefState.bodies) {
          entities.push({
            avatarId: b.avatarId,
            position: { x: b.x, y: b.y },
            velocity: { x: b.vx, y: b.vy },
            rotation: b.rot,
            state: b.dnf
              ? 'dnf'
              : b.finishedAt !== null
                ? 'finished'
                : 'racing',
          });
        }
        powerUps = reefState.pickups
          .filter((p) => p.active)
          .map((p) => ({
            spawnId: p.spawnId,
            kind: p.kind,
            position: { x: p.x, y: p.y },
          }));
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
      reefRaceSim.forfeit(room.id, avatarId, reason);
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
