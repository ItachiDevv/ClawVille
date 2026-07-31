/**
 * Localhost-only world-presence WebSocket smoke harness.
 *
 * Required server lane:
 *   WORLD_POSITION_WS_ENABLED=true bun apps/api/src/index.ts
 *
 * Optional harness inputs:
 *   WORLD_WS_SMOKE_BASE_URL=http://127.0.0.1:4000
 *   WORLD_WS_SMOKE_FLAG_OFF_URL=http://127.0.0.1:4001
 *   WORLD_WS_SMOKE_AGENT_SESSION=<local test bearer>
 *   WORLD_WS_SMOKE_LONG=true             # enables the 4m idle + ~95s reap lanes
 *   WORLD_WS_SMOKE_API_PID=<local PID>    # enables the final SIGTERM lane
 *
 * Bun fetch has no cookie jar. This file therefore captures cv_world_guest from
 * /join and replays it on every fetch and WebSocket handshake.
 */
import { createHmac } from 'crypto';
import { z } from 'zod';
import {
  WORLD_PRESENCE_WS_CLOSE_CODES,
  type WorldPresenceServerFrame,
} from '@clawville/shared';
import type { AppContext } from '../src/types';

const joinResponseSchema = z.object({
  roomId: z.string(),
  id: z.string(),
  transports: z.object({ positionWs: z.boolean() }),
});
const errorResponseSchema = z.object({ code: z.string() });
const roomsResponseSchema = z.object({
  rooms: z.array(
    z.object({
      id: z.string(),
      sessions: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(['human', 'guest', 'agent']),
          userId: z.string().nullable(),
          x: z.number(),
          y: z.number(),
        }),
      ),
    }),
  ),
});
const positionResponseSchema = z.object({
  ok: z.literal(true),
  throttled: z.boolean().optional(),
});

const userAgent = 'clawville-world-ws-local-smoke/1';
const baseUrl = process.env.WORLD_WS_SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';
const base = new URL(baseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) {
  throw new Error(`Refusing non-local smoke target: ${base.origin}`);
}
const wsBase = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}`;
const selfHosted = process.env.WORLD_WS_SMOKE_SELF_HOST === 'true';
let stopSelfHostedServer: (() => Promise<void>) | null = null;

const results: Array<{ scenario: string; status: 'PASS' | 'SKIP'; detail: string }> =
  [];

function pass(scenario: string, detail: string): void {
  results.push({ scenario, status: 'PASS', detail });
  console.log(`PASS ${scenario} — ${detail}`);
}

function skip(scenario: string, detail: string): void {
  results.push({ scenario, status: 'SKIP', detail });
  console.log(`SKIP ${scenario} — ${detail}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

function extractWorldCookie(response: Response): {
  cookie: string;
  serialized: string;
} {
  const serialized = response.headers.get('set-cookie') ?? '';
  const match = /(?:^|,\s*)cv_world_guest=([^;,]+)/u.exec(serialized);
  assert(match, 'POST /join did not set cv_world_guest');
  return { cookie: `cv_world_guest=${match[1]}`, serialized };
}

interface JoinResult {
  roomId: string;
  id: string;
  positionWs: boolean;
  cookie: string;
  serializedCookie: string;
}

async function join(
  extraHeaders: Record<string, string> = {},
  requireGuestCookie = true,
): Promise<JoinResult> {
  const response = await fetch(`${base.origin}/api/world/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      'X-Forwarded-For': '203.0.113.10',
      ...extraHeaders,
    },
    body: '{}',
  });
  assert(response.ok, `POST /join failed: ${response.status}`);
  const parsed = joinResponseSchema.parse(await response.json());
  const serializedCookie = response.headers.get('set-cookie') ?? '';
  const binding = requireGuestCookie
    ? extractWorldCookie(response)
    : {
        cookie: '',
        serialized: serializedCookie,
      };
  return {
    roomId: parsed.roomId,
    id: parsed.id,
    positionWs: parsed.transports.positionWs,
    cookie: binding.cookie,
    serializedCookie: binding.serialized,
  };
}

type BunWebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

class WsProbe {
  readonly frames: WorldPresenceServerFrame[] = [];
  readonly closeInfo: Promise<{ code: number; reason: string }>;
  opened = false;
  private resolveClose!: (value: { code: number; reason: string }) => void;

  constructor(
    readonly socket: WebSocket,
    private readonly autoPong: boolean,
  ) {
    this.closeInfo = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    socket.addEventListener('open', () => {
      this.opened = true;
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const parsed = JSON.parse(event.data) as WorldPresenceServerFrame;
      this.frames.push(parsed);
      if (this.autoPong && parsed.type === 'presence.ping') {
        socket.send(
          JSON.stringify({
            type: 'presence.pong',
            serverTimeMs: parsed.serverTimeMs,
          }),
        );
      }
    });
    socket.addEventListener('close', (event) => {
      this.resolveClose({ code: event.code, reason: event.reason });
    });
  }

  async waitOpen(timeoutMs = 5_000): Promise<void> {
    await waitUntil(() => this.opened, timeoutMs, 'WebSocket open');
  }

  async waitFrame(
    predicate: (frame: WorldPresenceServerFrame) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<WorldPresenceServerFrame> {
    await waitUntil(
      () => this.frames.some(predicate),
      timeoutMs,
      `frame ${label}`,
    );
    return this.frames.find(predicate)!;
  }

  errorFrames(): WorldPresenceServerFrame[] {
    return this.frames.filter((frame) => frame.type === 'presence.error');
  }
}

function openSocket(input: {
  roomId: string;
  cookie?: string;
  origin?: string | null;
  ip?: string;
  autoPong?: boolean;
  agentSession?: string;
}): WsProbe {
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    'X-Forwarded-For': input.ip ?? '203.0.113.10',
  };
  if (input.cookie) headers.Cookie = input.cookie;
  if (input.origin !== null) {
    headers.Origin = input.origin ?? 'http://localhost:3000';
  }
  if (input.agentSession) {
    headers['X-Clawville-Agent-Session'] = input.agentSession;
  }
  const Constructor = WebSocket as unknown as BunWebSocketConstructor;
  return new WsProbe(
    new Constructor(
      `${wsBase}/api/world/${encodeURIComponent(input.roomId)}/ws`,
      { headers },
    ),
    input.autoPong ?? true,
  );
}

async function postPosition(
  cookie: string,
  x: number,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(`${base.origin}/api/world/position`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'User-Agent': userAgent,
      'X-Forwarded-For': '203.0.113.10',
      ...extraHeaders,
    },
    body: JSON.stringify({ x, y: x + 1, dirZ: 0.75, activity: 'smoke' }),
  });
  assert(response.ok, `POST /position failed: ${response.status}`);
  return positionResponseSchema.parse(await response.json());
}

function dashCookie(): string | null {
  const secret = process.env.FINGERPRINT_SECRET;
  if (!secret) return null;
  const value = createHmac('sha256', secret).update('dash-access').digest('hex');
  return `cv_dash=${value}`;
}

async function readAdminPosition(
  roomId: string,
  presenceId: string,
  cookie: string,
): Promise<{ x: number; y: number; kind: string; userId: string | null } | null> {
  const adminCookie = dashCookie();
  if (!adminCookie) return null;
  const response = await fetch(`${base.origin}/api/world/rooms`, {
    headers: {
      Cookie: `${cookie}; ${adminCookie}`,
      'User-Agent': userAgent,
      'X-Forwarded-For': '203.0.113.10',
    },
  });
  assert(response.ok, `GET /rooms failed: ${response.status}`);
  const parsed = roomsResponseSchema.parse(await response.json());
  const room = parsed.rooms.find((candidate) => candidate.id === roomId);
  return room?.sessions.find((session) => session.id === presenceId) ?? null;
}

async function flagOffLane(): Promise<void> {
  const flagOffUrl = selfHosted
    ? base.origin
    : process.env.WORLD_WS_SMOKE_FLAG_OFF_URL;
  if (!flagOffUrl) {
    skip('S1', 'WORLD_WS_SMOKE_FLAG_OFF_URL not supplied');
    return;
  }
  const url = new URL(flagOffUrl);
  assert(
    ['127.0.0.1', 'localhost', '::1'].includes(url.hostname),
    'Flag-off target must be localhost',
  );
  const response = await fetch(`${url.origin}/api/world/ABCD/ws`);
  assert(response.status === 503, `flag-off route returned ${response.status}`);
  const error = errorResponseSchema.parse(await response.json());
  assert(error.code === 'world_ws_disabled', `unexpected flag-off code ${error.code}`);
  const joinResponse = await fetch(`${url.origin}/api/world/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `${userAgent}-flag-off`,
      'X-Forwarded-For': '192.0.2.44',
    },
    body: '{}',
  });
  assert(joinResponse.ok, `flag-off /join returned ${joinResponse.status}`);
  const joined = joinResponseSchema.parse(await joinResponse.json());
  assert(joined.transports.positionWs === false, 'flag-off /join advertised WS');
  pass('S1', 'flag-off upgrade returned 503 and /join advertised false');
}

async function main(): Promise<void> {
  if (selfHosted) process.env.WORLD_POSITION_WS_ENABLED = 'false';
  await flagOffLane();
  if (selfHosted) process.env.WORLD_POSITION_WS_ENABLED = 'true';

  const noMembership = openSocket({
    roomId: 'ABCD',
    ip: '198.51.100.20',
    origin: null,
    autoPong: false,
  });
  await noMembership.waitOpen();
  await noMembership.waitFrame(
    (frame) =>
      frame.type === 'presence.error' && frame.code === 'membership_lost',
    'membership_lost',
  );
  const noMembershipClose = await noMembership.closeInfo;
  assert(
    noMembershipClose.code === WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST,
    `S2 close was ${noMembershipClose.code}`,
  );
  pass('S2', 'upgrade completed, then membership_lost + 4409');

  const joined = await join();
  assert(joined.positionWs, 'local server did not advertise WS');
  let active = openSocket({
    roomId: joined.roomId,
    cookie: joined.cookie,
    autoPong: true,
  });
  await active.waitOpen();
  const ready = await active.waitFrame(
    (frame) => frame.type === 'presence.ready',
    'presence.ready',
  );
  assert(ready.type === 'presence.ready', 'S3 did not receive ready');
  assert(ready.presenceId === joined.id, 'ready presenceId drifted from /join id');
  assert(ready.roomId === joined.roomId, 'ready roomId drifted from /join room');
  pass('S3', 'ready arrived first with matching roomId and presenceId');

  active.socket.send(
    JSON.stringify({
      type: 'presence.position',
      x: 321,
      y: 654,
      dirZ: 1,
      activity: 'smoke-one',
    }),
  );
  await delay(150);
  const applied = await readAdminPosition(
    joined.roomId,
    joined.id,
    joined.cookie,
  );
  if (applied) {
    assert(applied.x === 321 && applied.y === 654, 'S4 position did not land');
    pass('S4', 'one WS pose was visible through GET /api/world/rooms');
  } else {
    skip('S4', 'FINGERPRINT_SECRET unavailable to derive local cv_dash admin cookie');
  }

  const errorsBeforeBurst = active.errorFrames().length;
  for (let index = 0; index < 20; index += 1) {
    active.socket.send(
      JSON.stringify({
        type: 'presence.position',
        x: 400 + index,
        y: 500 + index,
        dirZ: 0,
        activity: 'burst',
      }),
    );
  }
  await delay(1_100);
  assert(
    active.errorFrames().length === errorsBeforeBurst,
    'S5 received an error for over-rate poses',
  );
  pass('S5', '20-frame burst was silently throttled with zero error frames');

  assert(joined.serializedCookie.includes('HttpOnly'), 'guest cookie lacks HttpOnly');
  assert(joined.serializedCookie.includes('Path=/'), 'guest cookie lacks Path=/');
  assert(!/Max-Age|Expires/iu.test(joined.serializedCookie), 'guest cookie is durable');
  pass('S8', 'guest binding cookie is HttpOnly, Path=/, and session-scoped');

  const badOrigin = openSocket({
    roomId: joined.roomId,
    cookie: joined.cookie,
    origin: 'https://evil.example',
  });
  await delay(750);
  assert(!badOrigin.opened, 'bad Origin unexpectedly opened');
  const noOrigin = openSocket({
    roomId: joined.roomId,
    cookie: joined.cookie,
    origin: null,
  });
  await noOrigin.waitOpen();
  await noOrigin.waitFrame((frame) => frame.type === 'presence.ready', 'ready');
  pass('S9', 'bad Origin was rejected; absent Origin succeeded');

  const activeReplaced = active;
  active = noOrigin;
  const replacement = openSocket({
    roomId: joined.roomId,
    cookie: joined.cookie,
    autoPong: true,
  });
  await replacement.waitOpen();
  await replacement.waitFrame(
    (frame) => frame.type === 'presence.ready',
    'replacement ready',
  );
  await active.waitFrame(
    (frame) =>
      frame.type === 'presence.error' && frame.code === 'socket_replaced',
    'socket_replaced',
  );
  const replacedClose = await active.closeInfo;
  assert(
    replacedClose.code === WORLD_PRESENCE_WS_CLOSE_CODES.SOCKET_REPLACED,
    `replacement close was ${replacedClose.code}`,
  );
  active = replacement;
  activeReplaced.socket.close();
  pass('S10', 'newest socket won; old received socket_replaced + 4410');

  for (let index = 0; index < 5; index += 1) active.socket.send('not-json');
  await waitUntil(
    () =>
      active.errorFrames().filter(
        (frame) => frame.type === 'presence.error' && frame.code === 'bad_frame',
      ).length === 5,
    5_000,
    'five bad_frame controls',
  );
  const malformedClose = await active.closeInfo;
  assert(
    malformedClose.code === WORLD_PRESENCE_WS_CLOSE_CODES.BAD_FRAME,
    `malformed close was ${malformedClose.code}`,
  );

  active = openSocket({
    roomId: joined.roomId,
    cookie: joined.cookie,
    autoPong: true,
  });
  await active.waitOpen();
  await active.waitFrame((frame) => frame.type === 'presence.ready', 'ready');
  active.socket.send('x'.repeat(2048));
  await active.waitFrame(
    (frame) => frame.type === 'presence.error' && frame.code === 'bad_frame',
    'oversize bad_frame',
  );
  assert(active.socket.readyState === WebSocket.OPEN, 'one oversize frame closed socket');
  pass('S11', 'five malformed frames closed 4400; one 2 KiB frame only struck');

  const beforeBinary = await readAdminPosition(
    joined.roomId,
    joined.id,
    joined.cookie,
  );
  active.socket.send(
    new TextEncoder().encode(
      JSON.stringify({
        type: 'presence.position',
        x: 9999,
        y: 9999,
        dirZ: 0,
        activity: 'binary',
      }),
    ),
  );
  await waitUntil(
    () =>
      active.errorFrames().filter(
        (frame) => frame.type === 'presence.error' && frame.code === 'bad_frame',
      ).length >= 2,
    5_000,
    'binary bad_frame',
  );
  const afterBinary = await readAdminPosition(
    joined.roomId,
    joined.id,
    joined.cookie,
  );
  if (beforeBinary && afterBinary) {
    assert(afterBinary.x === beforeBinary.x, 'binary frame mutated the pose');
    pass('S12', 'binary valid-JSON frame struck and did not mutate pose');
  } else {
    skip('S12', 'binary struck, but admin pose inspection was unavailable');
  }

  await delay(150);
  active.socket.send(
    JSON.stringify({
      type: 'presence.position',
      x: 808,
      y: 809,
      dirZ: 0,
      activity: 'shared-budget',
    }),
  );
  const httpInterleave = await postPosition(joined.cookie, 909);
  assert(httpInterleave.throttled === true, 'HTTP/WS budget doubled');
  pass('S15', 'HTTP and WS interleaved under one 10 Hz session budget');

  if (process.env.WORLD_WS_SMOKE_LONG === 'true') {
    await delay(4 * 60_000);
    assert(active.socket.readyState === WebSocket.OPEN, 'ponging socket died during 4m idle');
    pass('S6', 'ponging socket survived four minutes with no position frames');

    const halfOpen = openSocket({
      roomId: joined.roomId,
      cookie: joined.cookie,
      autoPong: false,
    });
    await halfOpen.waitOpen();
    await halfOpen.waitFrame((frame) => frame.type === 'presence.ready', 'ready');
    const keepFresh = setInterval(() => {
      void postPosition(joined.cookie, 700).catch(() => {});
    }, 10_000);
    const halfOpenClose = await Promise.race([
      halfOpen.closeInfo,
      delay(100_000).then(() => ({ code: -1, reason: 'timeout' })),
    ]);
    clearInterval(keepFresh);
    assert(
      halfOpenClose.code === WORLD_PRESENCE_WS_CLOSE_CODES.PONG_TIMEOUT,
      `half-open close was ${halfOpenClose.code}`,
    );
    pass('S7', 'ignored pings were reaped with 4408 inside the bounded deadline');
    active = openSocket({
      roomId: joined.roomId,
      cookie: joined.cookie,
      autoPong: true,
    });
    await active.waitOpen();
    await active.waitFrame((frame) => frame.type === 'presence.ready', 'ready');
  } else {
    skip('S6', 'set WORLD_WS_SMOKE_LONG=true for the four-minute idle lane');
    skip('S7', 'set WORLD_WS_SMOKE_LONG=true for the pong-timeout lane');
  }

  const agentSession = process.env.WORLD_WS_SMOKE_AGENT_SESSION;
  if (agentSession) {
    const agentJoin = await join(
      {
        'X-Clawville-Agent-Session': agentSession,
        'X-Forwarded-For': '203.0.113.11',
      },
      false,
    );
    const agentSocket = openSocket({
      roomId: agentJoin.roomId,
      agentSession,
      ip: '203.0.113.11',
    });
    await agentSocket.waitOpen();
    await agentSocket.waitFrame((frame) => frame.type === 'presence.ready', 'agent ready');
    agentSocket.socket.send(
      JSON.stringify({
        type: 'presence.position',
        x: 515,
        y: 516,
        dirZ: 0,
        activity: 'agent-smoke',
      }),
    );
    pass('S14', 'validated local agent bearer joined and opened the same uplink');
    agentSocket.socket.close();
  } else {
    skip('S14', 'WORLD_WS_SMOKE_AGENT_SESSION not supplied');
  }

  const errorsBeforeLeave = active.errorFrames().length;
  const leaveResponse = await fetch(`${base.origin}/api/world/leave`, {
    method: 'POST',
    headers: {
      Cookie: joined.cookie,
      'User-Agent': userAgent,
      'X-Forwarded-For': '203.0.113.10',
    },
  });
  assert(leaveResponse.ok, `POST /leave failed: ${leaveResponse.status}`);
  const leaveClose = await active.closeInfo;
  assert(leaveClose.code === 1000, `leave close was ${leaveClose.code}`);
  assert(
    active.errorFrames().length === errorsBeforeLeave,
    'leave emitted a new presence.error',
  );
  pass('S13', 'POST /leave closed 1000 with no control error');

  const apiPid = process.env.WORLD_WS_SMOKE_API_PID;
  if (apiPid) {
    const shutdownJoin = await join();
    const shutdownSocket = openSocket({
      roomId: shutdownJoin.roomId,
      cookie: shutdownJoin.cookie,
    });
    await shutdownSocket.waitOpen();
    await shutdownSocket.waitFrame((frame) => frame.type === 'presence.ready', 'ready');
    process.kill(z.number().int().positive().parse(Number(apiPid)), 'SIGTERM');
    await shutdownSocket.waitFrame(
      (frame) =>
        frame.type === 'presence.error' && frame.code === 'server_shutdown',
      'server_shutdown',
      10_000,
    );
    const shutdownClose = await shutdownSocket.closeInfo;
    assert(
      shutdownClose.code === WORLD_PRESENCE_WS_CLOSE_CODES.SERVER_SHUTDOWN,
      `shutdown close was ${shutdownClose.code}`,
    );
    pass('S16', 'SIGTERM emitted server_shutdown + 4413 before exit');
  } else {
    skip('S16', 'WORLD_WS_SMOKE_API_PID not supplied');
  }

  const passed = results.filter((result) => result.status === 'PASS').length;
  const skipped = results.filter((result) => result.status === 'SKIP').length;
  console.log(`SUMMARY pass=${passed} skip=${skipped} fail=0`);
}

async function startSelfHostedServer(): Promise<void> {
  if (!selfHosted) return;
  const port = z.coerce.number().int().positive().parse(base.port || '80');
  const [
    { Hono },
    { fingerprintMiddleware },
    { worldRoutes },
    { getBunWebSocketHelper },
    { worldPresenceWsHub },
  ] = await Promise.all([
    import('hono'),
    import('../src/middleware/fingerprint'),
    import('../src/routes/world'),
    import('../src/lib/bun-ws-adapter'),
    import('../src/services/world-presence-ws-hub'),
  ]);
  const app = new Hono<AppContext>();
  app.use('*', fingerprintMiddleware);
  app.route('/api/world', worldRoutes);
  const { websocket } = getBunWebSocketHelper();
  const server = Bun.serve({
    hostname: base.hostname,
    port,
    fetch: app.fetch,
    websocket,
  });
  worldPresenceWsHub.startHeartbeat();
  stopSelfHostedServer = async () => {
    worldPresenceWsHub.shutdown();
    await server.stop(false);
  };
  console.log(`SELF_HOSTED ${server.url.origin}`);
}

async function run(): Promise<void> {
  await startSelfHostedServer();
  try {
    await main();
  } finally {
    await stopSelfHostedServer?.();
  }
}

run().catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exitCode = 1;
});
