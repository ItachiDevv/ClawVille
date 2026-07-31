import { randomUUID } from 'crypto';
import {
  WORLD_PRESENCE_WS_CLOSE_CODES,
  WORLD_PRESENCE_WS_MAX_FRAME_BYTES,
  worldPresenceClientFrameSchema,
  type WorldPresenceErrorCode,
  type WorldPresenceServerFrame,
} from '@clawville/shared';
import { derivePublicId, roomRegistry, type RoomRegistry } from './room-registry';
import {
  admitWorldPositionRate,
  applyWorldPosition,
} from './world-position-apply';

// FEATURE_GATE: world_position_ws
// Status: server accepts both transports; flag default OFF; POST /position endpoint permanent.
// Metric to graduate (this gates FU-2, disabling the browser's automatic fallback):
//   7 days on prod with the flag ON — abnormal-close rate (non-1000/1001) < 2% of
//   sockets, /join rate not above its flag-OFF baseline, pong-timeout reaps < 1% of
//   sockets, and POST /position volume from WS-capable browsers ~0.
// Current reading: to fill (the flag has never been enabled anywhere).
// Review deadline: 2026-09-15
// On deadline: if the metric is unmet, the WS path is DELETED and the motion-gated
//   HTTP effector stays the permanent design. Renewal requires a NEW metric reading,
//   not "we still want this."
// Reference: docs/world-presence-ws-uplink-plan-2026-07-30.md (Follow-ups FU-2, FU-4)
export function isWorldPositionWsEnabled(): boolean {
  return process.env.WORLD_POSITION_WS_ENABLED === 'true';
}

export const WORLD_WS_UPGRADE_MAX_PER_MINUTE = 30;
export const WORLD_WS_MAX_SOCKETS_PER_IP = 20;
export const WORLD_WS_MAX_MALFORMED_FRAMES = 5;
/** Fixed-window ingress cap. A boundary-straddling burst is intentionally accepted. */
export const WORLD_WS_MAX_FRAMES_PER_WINDOW = 60;
export const WORLD_WS_FRAME_WINDOW_MS = 1_000;
export const WORLD_WS_HEARTBEAT_MS = 25_000;
export const WORLD_WS_PONG_DEADLINE_MS = 70_000;
export const WORLD_WS_IP_RESERVATION_TTL_MS = 30_000;

export interface WorldWsBinding {
  sessionId: string;
  kind: 'human' | 'guest' | 'agent';
  userId: string | null;
  roomId: string;
  presenceId: string;
  ip: string;
  ipSlotToken: string;
  membershipOk: boolean;
}

export interface WorldWsConnectionData {
  binding: WorldWsBinding;
  connectionId: string;
  malformedFrames: number;
  frameWindowStartMs: number;
  frameWindowCount: number;
  lastPongAt: number;
  openedAt: number;
}

export interface WorldWsTransport {
  send(frame: string): void;
  close(code: number, reason: string): void;
  data: WorldWsConnectionData;
}

export type WorldWs = WorldWsTransport;

export type WorldWsRejectCode =
  | 'world_ws_disabled'
  | 'ws_upgrade_rate_limited'
  | 'invalid_room_id'
  | 'origin_not_allowed'
  | 'no_presence'
  | 'ws_concurrency_cap';

export type WorldWsGateResult =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 401 | 403 | 429 | 503;
      code: WorldWsRejectCode;
    };

/** Pure, ordered pre-upgrade decision table. Membership is intentionally absent. */
export function decideWorldWsUpgrade(input: {
  enabled: boolean;
  ipUpgradeAllowed: boolean;
  roomIdValid: boolean;
  originAllowed: boolean;
  presenceResolved: boolean;
  ipSlotReserved: boolean;
}): WorldWsGateResult {
  if (!input.enabled) {
    return { ok: false, status: 503, code: 'world_ws_disabled' };
  }
  if (!input.ipUpgradeAllowed) {
    return { ok: false, status: 429, code: 'ws_upgrade_rate_limited' };
  }
  if (!input.roomIdValid) {
    return { ok: false, status: 400, code: 'invalid_room_id' };
  }
  if (!input.originAllowed) {
    return { ok: false, status: 403, code: 'origin_not_allowed' };
  }
  if (!input.presenceResolved) {
    return { ok: false, status: 401, code: 'no_presence' };
  }
  if (!input.ipSlotReserved) {
    return { ok: false, status: 429, code: 'ws_concurrency_cap' };
  }
  return { ok: true };
}

export interface WorldPresenceWsHubDeps {
  registry: Pick<RoomRegistry, 'getRoomForSession' | 'touchPresence' | 'subscribeTick'>;
  now: () => number;
}

interface IpReservation {
  ip: string;
  expiresAt: number;
}

export class WorldPresenceWsHub {
  private readonly registry: WorldPresenceWsHubDeps['registry'];
  private readonly now: () => number;
  private readonly connections = new Map<string, WorldWs>();
  private readonly reservations = new Map<string, IpReservation>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WorldPresenceWsHubDeps) {
    this.registry = deps.registry;
    this.now = deps.now;
    this.registry.subscribeTick((result) => {
      for (const sessionId of result.staleSessionsRemoved) {
        this.dropSession(sessionId, {
          control: 'membership_lost',
          closeCode: WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST,
          reason: 'stale_membership',
        });
      }
    });
  }

  reserveIpSlot(ip: string): string | null {
    this.sweepExpiredReservations(this.now());
    if (this.countForIp(ip) >= WORLD_WS_MAX_SOCKETS_PER_IP) return null;
    const token = randomUUID();
    this.reservations.set(token, {
      ip,
      expiresAt: this.now() + WORLD_WS_IP_RESERVATION_TTL_MS,
    });
    return token;
  }

  releaseIpSlot(token: string): void {
    this.reservations.delete(token);
  }

  makeConnectionData(binding: WorldWsBinding): WorldWsConnectionData {
    const now = this.now();
    return {
      binding,
      connectionId: randomUUID(),
      malformedFrames: 0,
      frameWindowStartMs: now,
      frameWindowCount: 0,
      lastPongAt: now,
      openedAt: now,
    };
  }

  registerConnection(ws: WorldWs): void {
    const { binding } = ws.data;
    const reservation = this.reservations.get(binding.ipSlotToken);

    if (
      !binding.membershipOk ||
      this.registry.getRoomForSession(binding.sessionId)?.id !== binding.roomId
    ) {
      this.releaseIpSlot(binding.ipSlotToken);
      this.sendError(ws, 'membership_lost');
      this.safeClose(ws, WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST, 'membership_lost');
      return;
    }

    // A reservation must still be live and belong to the binding that claims it.
    if (!reservation || reservation.ip !== binding.ip || reservation.expiresAt <= this.now()) {
      this.releaseIpSlot(binding.ipSlotToken);
      this.safeClose(ws, 1013, 'reservation_expired');
      return;
    }

    const existing = this.connections.get(binding.sessionId);
    if (existing && existing !== ws) {
      // Fence synchronously before writing to the old transport.
      this.connections.delete(binding.sessionId);
      this.sendError(existing, 'socket_replaced');
      this.safeClose(
        existing,
        WORLD_PRESENCE_WS_CLOSE_CODES.SOCKET_REPLACED,
        'socket_replaced',
      );
    }

    this.reservations.delete(binding.ipSlotToken);
    this.connections.set(binding.sessionId, ws);
    this.safeSend(ws, {
      type: 'presence.ready',
      roomId: binding.roomId,
      presenceId: binding.presenceId,
      serverTimeMs: this.now(),
    });
  }

  handleMessage(ws: WorldWs, raw: unknown): void {
    const now = this.now();
    const data = ws.data;

    if (now - data.frameWindowStartMs >= WORLD_WS_FRAME_WINDOW_MS) {
      data.frameWindowStartMs = now;
      data.frameWindowCount = 0;
    }
    data.frameWindowCount += 1;
    if (data.frameWindowCount > WORLD_WS_MAX_FRAMES_PER_WINDOW) {
      this.sendError(ws, 'flood');
      this.safeClose(ws, WORLD_PRESENCE_WS_CLOSE_CODES.FLOOD, 'flood');
      this.unregisterConnection(ws);
      return;
    }

    if (typeof raw !== 'string') {
      this.malformedStrike(ws);
      return;
    }
    if (Buffer.byteLength(raw, 'utf8') > WORLD_PRESENCE_WS_MAX_FRAME_BYTES) {
      this.malformedStrike(ws);
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.malformedStrike(ws);
      return;
    }
    const parsed = worldPresenceClientFrameSchema.safeParse(decoded);
    if (!parsed.success) {
      this.malformedStrike(ws);
      return;
    }

    const { binding } = data;
    if (this.currentConnectionId(binding.sessionId) !== data.connectionId) {
      this.safeClose(ws, 1000, 'stale_generation');
      this.unregisterConnection(ws);
      return;
    }
    if (this.registry.getRoomForSession(binding.sessionId)?.id !== binding.roomId) {
      this.closeMembershipLost(ws);
      return;
    }

    if (parsed.data.type === 'presence.pong') {
      if (!this.registry.touchPresence(binding.sessionId)) {
        this.closeMembershipLost(ws);
        return;
      }
      data.lastPongAt = now;
      return;
    }

    if (!admitWorldPositionRate(binding.sessionId, now)) return;
    const { x, y, dirZ, activity } = parsed.data;
    if (
      applyWorldPosition(
        {
          sessionId: binding.sessionId,
          kind: binding.kind,
          userId: binding.userId,
        },
        { x, y, dirZ, activity },
      ) === 'not_in_room'
    ) {
      this.closeMembershipLost(ws);
    }
  }

  unregisterConnection(ws: WorldWs): void {
    const sessionId = ws.data.binding.sessionId;
    if (this.connections.get(sessionId) === ws) {
      this.connections.delete(sessionId);
    }
    this.releaseIpSlot(ws.data.binding.ipSlotToken);
  }

  dropSession(
    sessionId: string,
    opts: {
      control: WorldPresenceErrorCode | null;
      closeCode: number;
      reason: string;
    },
  ): void {
    const ws = this.connections.get(sessionId);
    if (!ws) return;
    this.connections.delete(sessionId);
    if (opts.control) this.sendError(ws, opts.control);
    this.safeClose(ws, opts.closeCode, opts.reason);
    this.releaseIpSlot(ws.data.binding.ipSlotToken);
  }

  countForIp(ip: string): number {
    this.sweepExpiredReservations(this.now());
    let count = 0;
    for (const ws of this.connections.values()) {
      if (ws.data.binding.ip === ip) count += 1;
    }
    for (const reservation of this.reservations.values()) {
      if (reservation.ip === ip) count += 1;
    }
    return count;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  hasSession(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  currentConnectionId(sessionId: string): string | null {
    return this.connections.get(sessionId)?.data.connectionId ?? null;
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeatTick(this.now());
    }, WORLD_WS_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const sessionId of Array.from(this.connections.keys())) {
      this.dropSession(sessionId, {
        control: 'server_shutdown',
        closeCode: WORLD_PRESENCE_WS_CLOSE_CODES.SERVER_SHUTDOWN,
        reason: 'server_shutdown',
      });
    }
    this.reservations.clear();
  }

  runHeartbeatTick(now: number): void {
    this.sweepExpiredReservations(now);
    for (const ws of Array.from(this.connections.values())) {
      if (now - ws.data.lastPongAt > WORLD_WS_PONG_DEADLINE_MS) {
        this.safeClose(ws, WORLD_PRESENCE_WS_CLOSE_CODES.PONG_TIMEOUT, 'pong_timeout');
        this.unregisterConnection(ws);
        continue;
      }
      this.safeSend(ws, { type: 'presence.ping', serverTimeMs: now });
    }
  }

  __heartbeatTickForTest(now: number): void {
    this.runHeartbeatTick(now);
  }

  __resetForTest(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.connections.clear();
    this.reservations.clear();
  }

  private sweepExpiredReservations(now: number): void {
    for (const [token, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) this.reservations.delete(token);
    }
  }

  private malformedStrike(ws: WorldWs): void {
    ws.data.malformedFrames += 1;
    this.sendError(ws, 'bad_frame');
    if (ws.data.malformedFrames >= WORLD_WS_MAX_MALFORMED_FRAMES) {
      this.safeClose(ws, WORLD_PRESENCE_WS_CLOSE_CODES.BAD_FRAME, 'bad_frame');
      this.unregisterConnection(ws);
    }
  }

  private closeMembershipLost(ws: WorldWs): void {
    this.sendError(ws, 'membership_lost');
    this.safeClose(
      ws,
      WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST,
      'membership_lost',
    );
    this.unregisterConnection(ws);
  }

  private sendError(ws: WorldWs, code: WorldPresenceErrorCode): void {
    this.safeSend(ws, { type: 'presence.error', code });
  }

  private safeSend(ws: WorldWs, frame: WorldPresenceServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      this.unregisterConnection(ws);
    }
  }

  private safeClose(ws: WorldWs, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // onClose may never arrive after a transport-level failure; callers
      // synchronously de-index on every internal close path.
    }
  }
}

export const worldPresenceWsHub = new WorldPresenceWsHub({
  registry: roomRegistry,
  now: Date.now,
});
