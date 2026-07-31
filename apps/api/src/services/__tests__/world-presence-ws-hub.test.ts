import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  WORLD_PRESENCE_WS_CLOSE_CODES,
  type WorldPresenceServerFrame,
} from '@clawville/shared';

mock.module('../npc-simulation', () => ({
  npcSimulation: {
    refreshHumanControlledOpenClawForUser: () => {},
  },
}));

const {
  WorldPresenceWsHub,
  WORLD_WS_IP_RESERVATION_TTL_MS,
  WORLD_WS_MAX_SOCKETS_PER_IP,
  WORLD_WS_PONG_DEADLINE_MS,
} = await import('../world-presence-ws-hub');
const {
  __resetWorldPositionThrottleForTest,
  admitWorldPositionRate,
} = await import('../world-position-apply');
const {
  derivePublicId,
  RoomRegistry,
  roomRegistry,
  STALE_PLAYER_MS,
} = await import('../room-registry');
import type {
  WorldWs,
  WorldWsBinding,
} from '../world-presence-ws-hub';

const T0 = 1_700_000_000_000;

interface FakeWs {
  ws: WorldWs;
  sent: WorldPresenceServerFrame[];
  closes: Array<{ code: number; reason: string }>;
}

function join(
  registry: InstanceType<typeof RoomRegistry>,
  sessionId: string,
  roomId = 'ABCD',
) {
  return registry.joinPlayer(
    sessionId,
    {
      userId: null,
      name: sessionId,
      species: 'milady_chibi',
      color: 0xcccccc,
      kind: 'guest',
    },
    { requestedRoomId: roomId, isAuthenticated: true },
  );
}

function makeFake(
  hub: InstanceType<typeof WorldPresenceWsHub>,
  binding: WorldWsBinding,
): FakeWs {
  const sent: WorldPresenceServerFrame[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const ws: WorldWs = {
    send(frame) {
      sent.push(JSON.parse(frame) as WorldPresenceServerFrame);
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    data: hub.makeConnectionData(binding),
  };
  return { ws, sent, closes };
}

function bind(
  hub: InstanceType<typeof WorldPresenceWsHub>,
  sessionId: string,
  roomId = 'ABCD',
  membershipOk = true,
  ip = '203.0.113.8',
): FakeWs {
  const token = hub.reserveIpSlot(ip);
  expect(token).not.toBeNull();
  return makeFake(hub, {
    sessionId,
    kind: 'guest',
    userId: null,
    roomId,
    presenceId: derivePublicId(sessionId),
    ip,
    ipSlotToken: token!,
    membershipOk,
  });
}

function position(x: number, activity = 'walking'): string {
  return JSON.stringify({
    type: 'presence.position',
    x,
    y: x + 1,
    dirZ: 0.5,
    activity,
  });
}

beforeEach(() => {
  roomRegistry.__resetForTests();
  __resetWorldPositionThrottleForTest();
});

describe('WorldPresenceWsHub registration and fencing', () => {
  it('sends presence.ready first with the /join public identity', () => {
    let now = T0;
    join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({ registry: roomRegistry, now: () => now });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);
    expect(fake.sent[0]).toEqual({
      type: 'presence.ready',
      roomId: 'ABCD',
      presenceId: derivePublicId('s1'),
      serverTimeMs: now,
    });
  });

  it('reports membership failure after upgrade and releases the IP slot', () => {
    const hub = new WorldPresenceWsHub({
      registry: roomRegistry,
      now: () => T0,
    });
    const fake = bind(hub, 'missing', 'ABCD', false);
    hub.registerConnection(fake.ws);
    expect(fake.sent).toEqual([
      { type: 'presence.error', code: 'membership_lost' },
    ]);
    expect(fake.closes).toEqual([
      {
        code: WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST,
        reason: 'membership_lost',
      },
    ]);
    expect(hub.getConnectionCount()).toBe(0);
    expect(hub.countForIp('203.0.113.8')).toBe(0);
  });

  it('revalidates membership on open to close the upgrade TOCTOU window', () => {
    join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({
      registry: roomRegistry,
      now: () => T0,
    });
    const fake = bind(hub, 's1');
    roomRegistry.leavePlayer('s1');
    join(roomRegistry, 's1', 'WXYZ');
    hub.registerConnection(fake.ws);
    expect(fake.sent[0]).toMatchObject({
      type: 'presence.error',
      code: 'membership_lost',
    });
    expect(hub.hasSession('s1')).toBe(false);
  });

  it('newest socket wins, old is fenced first, and stale close/frame are harmless', () => {
    let now = T0;
    const { player } = join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({ registry: roomRegistry, now: () => now });
    const first = bind(hub, 's1');
    hub.registerConnection(first.ws);
    const second = bind(hub, 's1');
    hub.registerConnection(second.ws);

    expect(first.sent.at(-1)).toEqual({
      type: 'presence.error',
      code: 'socket_replaced',
    });
    expect(first.closes.at(-1)?.code).toBe(
      WORLD_PRESENCE_WS_CLOSE_CODES.SOCKET_REPLACED,
    );
    expect(second.sent[0]?.type).toBe('presence.ready');
    expect(hub.getConnectionCount()).toBe(1);
    expect(hub.currentConnectionId('s1')).toBe(second.ws.data.connectionId);

    const priorX = player.x;
    hub.unregisterConnection(first.ws);
    expect(hub.hasSession('s1')).toBe(true);
    now += 200;
    hub.handleMessage(first.ws, position(999));
    expect(player.x).toBe(priorX);
    expect(first.sent.filter((frame) => frame.type === 'presence.error')).toHaveLength(
      1,
    );
    expect(first.ws.data.malformedFrames).toBe(0);
  });

  it('fences a socket when membership moves to a different room', () => {
    const { player } = join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({
      registry: roomRegistry,
      now: () => T0,
    });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);
    const oldX = player.x;
    roomRegistry.leavePlayer('s1');
    const { player: moved } = join(roomRegistry, 's1', 'WXYZ');
    hub.handleMessage(fake.ws, position(99));
    expect(moved.x).not.toBe(99);
    expect(player.x).toBe(oldX);
    expect(fake.sent.at(-1)).toEqual({
      type: 'presence.error',
      code: 'membership_lost',
    });
    expect(fake.closes.at(-1)?.code).toBe(
      WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST,
    );
  });
});

describe('WorldPresenceWsHub inbound frames', () => {
  it('shares the 10 Hz cap across reconnects and HTTP/WS transports', () => {
    let now = T0;
    const { player } = join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({ registry: roomRegistry, now: () => now });
    const first = bind(hub, 's1');
    hub.registerConnection(first.ws);
    hub.handleMessage(first.ws, position(10));
    expect(player.x).toBe(10);

    hub.unregisterConnection(first.ws);
    const second = bind(hub, 's1');
    hub.registerConnection(second.ws);
    now += 50;
    hub.handleMessage(second.ws, position(20));
    expect(player.x).toBe(10);
    expect(second.ws.data.malformedFrames).toBe(0);
    now += 100;
    hub.handleMessage(second.ws, position(30));
    expect(player.x).toBe(30);

    now += 200;
    expect(admitWorldPositionRate('s1', now)).toBe(true);
    now += 50;
    hub.handleMessage(second.ws, position(40));
    expect(player.x).toBe(30);
  });

  it('rejects binary, oversized, invalid JSON, and invalid schemas as strikes', () => {
    join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({
      registry: roomRegistry,
      now: () => T0,
    });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);
    hub.handleMessage(
      fake.ws,
      new TextEncoder().encode(position(1)).buffer,
    );
    hub.handleMessage(fake.ws, 'x'.repeat(1100));
    hub.handleMessage(fake.ws, 'not json');
    hub.handleMessage(fake.ws, JSON.stringify({ type: 'nope' }));
    expect(fake.ws.data.malformedFrames).toBe(4);
    expect(
      fake.sent.filter(
        (frame) => frame.type === 'presence.error' && frame.code === 'bad_frame',
      ),
    ).toHaveLength(4);
    expect(fake.closes).toHaveLength(0);

    hub.handleMessage(fake.ws, JSON.stringify({ type: 'presence.position' }));
    expect(fake.closes.at(-1)?.code).toBe(
      WORLD_PRESENCE_WS_CLOSE_CODES.BAD_FRAME,
    );
  });

  it('defaults activity to idle', () => {
    const { player } = join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({
      registry: roomRegistry,
      now: () => T0,
    });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);
    hub.handleMessage(
      fake.ws,
      JSON.stringify({
        type: 'presence.position',
        x: 4,
        y: 5,
        dirZ: 6,
      }),
    );
    expect(player.activity).toBe('idle');
  });

  it('uses an honest fixed window and closes a sustained flood', () => {
    let now = T0;
    join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({ registry: roomRegistry, now: () => now });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);

    now = T0 + 999;
    for (let index = 0; index < 60; index += 1) {
      hub.handleMessage(fake.ws, position(index));
    }
    now = T0 + 1001;
    for (let index = 0; index < 60; index += 1) {
      hub.handleMessage(fake.ws, position(index));
    }
    expect(fake.closes).toHaveLength(0);

    now = T0 + 2001;
    for (let index = 0; index < 61; index += 1) {
      hub.handleMessage(fake.ws, position(index));
    }
    expect(fake.sent.at(-1)).toEqual({
      type: 'presence.error',
      code: 'flood',
    });
    expect(fake.closes.at(-1)?.code).toBe(WORLD_PRESENCE_WS_CLOSE_CODES.FLOOD);
  });

  it('pongs refresh liveness without pose mutation or position throttling', () => {
    let now = T0;
    const { room, player } = join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({ registry: roomRegistry, now: () => now });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);
    const poseBefore = {
      x: player.x,
      y: player.y,
      dirZ: player.dirZ,
      activity: player.activity,
      ts: player.ts,
    };
    // Make advancement deterministic without sleeping on the real singleton
    // clock used by roomRegistry.
    player.lastPositionUpdateAt -= 10;
    room.lastActivityAt -= 10;
    const livenessBefore = player.lastPositionUpdateAt;
    now += 5_000;
    for (let index = 0; index < 20; index += 1) {
      hub.handleMessage(
        fake.ws,
        JSON.stringify({ type: 'presence.pong', serverTimeMs: now }),
      );
    }
    expect(player).toMatchObject(poseBefore);
    expect(player.lastPositionUpdateAt).toBeGreaterThan(livenessBefore);
    expect(room.lastActivityAt).toBe(player.lastPositionUpdateAt);
    expect(fake.ws.data.malformedFrames).toBe(0);
    expect(fake.ws.data.frameWindowCount).toBe(20);
    expect(
      fake.sent.filter((frame) => frame.type === 'presence.error'),
    ).toHaveLength(0);

    now += 1;
    hub.handleMessage(fake.ws, position(77));
    expect(player.x).toBe(77);
  });
});

describe('WorldPresenceWsHub heartbeat, cleanup, and caps', () => {
  it('keeps a ponging background presence alive for four simulated minutes', () => {
    let now = T0;
    const registry = new RoomRegistry({ now: () => now, randomChar: () => 'A' });
    join(registry, 's1');
    const hub = new WorldPresenceWsHub({ registry, now: () => now });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);

    for (let elapsed = 25_000; elapsed <= 4 * 60_000; elapsed += 25_000) {
      now = T0 + elapsed;
      hub.__heartbeatTickForTest(now);
      hub.handleMessage(
        fake.ws,
        JSON.stringify({ type: 'presence.pong', serverTimeMs: now }),
      );
      registry.tick();
    }
    expect(registry.getRoomForSession('s1')).not.toBeNull();
    expect(hub.hasSession('s1')).toBe(true);
    expect(
      fake.sent.some((frame) => frame.type === 'presence.ping'),
    ).toBe(true);
  });

  it('reaps a half-open socket by pong deadline even if pose membership remains', () => {
    let now = T0;
    join(roomRegistry, 's1');
    const hub = new WorldPresenceWsHub({ registry: roomRegistry, now: () => now });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);
    now += WORLD_WS_PONG_DEADLINE_MS + 1;
    hub.__heartbeatTickForTest(now);
    expect(fake.closes.at(-1)?.code).toBe(4408);
    expect(
      fake.sent.filter((frame) => frame.type === 'presence.error'),
    ).toHaveLength(0);
    expect(hub.hasSession('s1')).toBe(false);
  });

  it('drops sockets when registry stale GC removes membership', () => {
    let now = T0;
    const registry = new RoomRegistry({ now: () => now, randomChar: () => 'A' });
    join(registry, 's1');
    const hub = new WorldPresenceWsHub({ registry, now: () => now });
    const fake = bind(hub, 's1');
    hub.registerConnection(fake.ws);
    now += STALE_PLAYER_MS + 1;
    registry.tick();
    expect(fake.sent.at(-1)).toEqual({
      type: 'presence.error',
      code: 'membership_lost',
    });
    expect(hub.hasSession('s1')).toBe(false);
  });

  it('reserves IP slots atomically, releases idempotently, and expires leaks', () => {
    let now = T0;
    const registry = new RoomRegistry({ now: () => now });
    const hub = new WorldPresenceWsHub({ registry, now: () => now });
    const tokens: string[] = [];
    for (let index = 0; index < WORLD_WS_MAX_SOCKETS_PER_IP; index += 1) {
      tokens.push(hub.reserveIpSlot('198.51.100.4')!);
    }
    expect(hub.reserveIpSlot('198.51.100.4')).toBeNull();
    hub.releaseIpSlot(tokens[0]!);
    hub.releaseIpSlot(tokens[0]!);
    expect(hub.reserveIpSlot('198.51.100.4')).not.toBeNull();

    now += WORLD_WS_IP_RESERVATION_TTL_MS;
    hub.__heartbeatTickForTest(now);
    expect(hub.countForIp('198.51.100.4')).toBe(0);
  });

  it('supports silent leave, penalty-free reopen, and shutdown drain', () => {
    join(roomRegistry, 's1');
    join(roomRegistry, 's2');
    const hub = new WorldPresenceWsHub({
      registry: roomRegistry,
      now: () => T0,
    });
    const first = bind(hub, 's1');
    const second = bind(hub, 's2');
    hub.registerConnection(first.ws);
    hub.registerConnection(second.ws);
    hub.dropSession('s1', { control: null, closeCode: 1000, reason: 'left' });
    expect(first.sent.filter((frame) => frame.type === 'presence.error')).toHaveLength(
      0,
    );
    expect(first.closes.at(-1)?.code).toBe(1000);

    const reopened = bind(hub, 's1');
    hub.registerConnection(reopened.ws);
    expect(hub.hasSession('s1')).toBe(true);
    hub.shutdown();
    for (const fake of [reopened, second]) {
      expect(fake.sent.at(-1)).toEqual({
        type: 'presence.error',
        code: 'server_shutdown',
      });
      expect(fake.closes.at(-1)?.code).toBe(
        WORLD_PRESENCE_WS_CLOSE_CODES.SERVER_SHUTDOWN,
      );
    }
    expect(hub.getConnectionCount()).toBe(0);
    expect(
      [...reopened.sent, ...second.sent].some(
        (frame) =>
          frame.type === 'presence.error' &&
          (frame.code === 'superseded' ||
            frame.code === 'transport_disabled'),
      ),
    ).toBe(false);
  });
});
