/**
 * SYNTHETIC SECOND PRESENCE — multiplayer remote-render repro tool (2026-06-12).
 *
 * The diagnostic (docs/diagnostic-2026-06-12-hatcher-regressions.md, D3) proved
 * the remote-player render path was broken end-to-end but NO reusable tool
 * existed to drive a second presence into a room. This is that tool: it joins a
 * room as a guest (fingerprint session) and heartbeats a position at 5 Hz so a
 * REAL browser in the SAME room sees a second player to render. The auditor
 * (or anyone) then asserts, via CDP on the browser client, that the remote
 * avatar actually mounts a SkinnedMesh at a sane scale — the D3 FREEZE gate.
 *
 * It does NOT render anything itself; it is the OTHER presence. Pair it with a
 * browser tab on /game and read usePlayerStore + the scene graph there.
 *
 * Usage:
 *   bun run apps/api/scripts/world/synthetic-player.ts \
 *     --api-base http://localhost:4000 \
 *     [--room <CODE>]        # join a specific room (else auto-fill; print the assigned room)
 *     [--x 2573 --y 2560]    # spawn position in game px (default near town center, ~13wu from 2560,2560)
 *     [--fingerprint <hex>]  # X-CV-Fingerprint to use (default: a fixed synthetic one)
 *     [--name <label>]       # ignored by server (guest name derived) — informational
 *     [--seconds <n>]        # how long to heartbeat before leaving (default 600)
 *
 * The server assigns a guest session from the fingerprint middleware, so the
 * SAME --fingerprint always maps to the SAME presence (re-runs don't pile up
 * ghosts beyond the 30s GC). Use DISTINCT fingerprints to simulate N players.
 *
 * Exit: prints the assigned roomId + this presence's publicId (so you can grep
 * the browser snapshot for it), heartbeats until --seconds elapses or SIGINT,
 * then best-effort leaves.
 */

function arg(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const API_BASE = (arg('--api-base') ?? process.env.WORLD_API_BASE ?? 'http://localhost:4000').replace(/\/+$/, '');
const ROOM = arg('--room');
const X = Number.parseFloat(arg('--x') ?? '2573'); // ~13wu east of town center (2560,2560) @ 1wu=1px-ish
const Y = Number.parseFloat(arg('--y') ?? '2560');
const FINGERPRINT = arg('--fingerprint') ?? 'synthetic-player-fp-0001';
const SECONDS = Number.parseInt(arg('--seconds') ?? '600', 10);

const HEADERS = {
  'Content-Type': 'application/json',
  // The fingerprint middleware salts+hashes this to derive a stable guest
  // session; the same value re-maps to the same presence across re-runs.
  'X-CV-Fingerprint': FINGERPRINT,
};

interface JoinResponse {
  roomId: string;
  id: string; // this presence's non-reversible publicId (matches snapshot players[].id)
  playerCount?: number;
  players?: Array<{ id: string; name: string; species: string; x: number; y: number }>;
}

let cookie: string | null = null;

async function join(): Promise<JoinResponse | null> {
  const res = await fetch(`${API_BASE}/api/world/join`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(ROOM ? { roomId: ROOM } : {}),
  });
  // Capture the guest session cookie the fingerprint middleware may set, so
  // subsequent position posts are recognised as the SAME session.
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (!res.ok) {
    console.error(`[synthetic] join failed: ${res.status} ${await res.text()}`);
    return null;
  }
  return (await res.json()) as JoinResponse;
}

async function position(x: number, y: number, dirZ: number, activity: string): Promise<number> {
  const res = await fetch(`${API_BASE}/api/world/position`, {
    method: 'POST',
    headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS,
    body: JSON.stringify({ x, y, dirZ, activity }),
  });
  return res.status;
}

async function leave(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/world/leave`, {
      method: 'POST',
      headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS,
      body: JSON.stringify({}),
    });
  } catch {
    /* best-effort — server GCs stale players after 30s */
  }
}

/**
 * Hold the room SSE stream open for the lifetime of the presence.
 *
 * CRITICAL (diagnostic 2026-06-12 D3 correction): a presence that joins +
 * heartbeats but does NOT hold an open `GET /api/world/:roomId/stream`
 * connection is GC'd by the room registry ~every 30s, so it vanishes from the
 * browser's store before any remote VRM can mount — that produced the FALSE
 * "remote players never render" conclusion. The real browser client holds this
 * stream via EventSource; the synthetic presence must do the same to be a
 * faithful second player. We drain the body so backpressure doesn't stall the
 * server, but otherwise just keep the connection alive until aborted.
 */
function holdStream(roomId: string, signal: AbortSignal): void {
  void (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/world/${encodeURIComponent(roomId)}/stream`, {
        method: 'GET',
        headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS,
        signal,
      });
      if (!res.ok || !res.body) {
        console.error(`[synthetic] stream open failed: ${res.status} (presence may be GC'd — remote render check is INVALID without a held stream)`);
        return;
      }
      console.log('[synthetic] SSE stream held open (presence will NOT be GC\'d while this runs)');
      const reader = res.body.getReader();
      // Drain the SSE bytes so the server's writes don't backpressure-stall;
      // we don't parse them — we only need the connection ALIVE.
      for (;;) {
        const { done } = await reader.read();
        if (done || signal.aborted) break;
      }
    } catch (err) {
      if (!signal.aborted) {
        console.error(`[synthetic] stream error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  })();
}

async function main(): Promise<void> {
  console.log('=== synthetic second presence (D3 remote-render repro) ===');
  console.log(`api-base   : ${API_BASE}`);
  console.log(`fingerprint: ${FINGERPRINT}`);
  console.log(`spawn      : (${X}, ${Y})  room: ${ROOM ?? '(auto-fill)'}`);
  console.log('');

  const joined = await join();
  if (!joined) {
    console.error('FATAL: could not join a room');
    process.exit(1);
  }
  console.log(`JOINED room=${joined.roomId} as publicId=${joined.id}`);
  console.log(`  -> in the browser tab, this presence appears in usePlayerStore.players with id="${joined.id}"`);
  console.log(`  -> assert: that entry has isLocal=false AND mounts a SkinnedMesh under perf:remote-players`);
  if (joined.players) {
    console.log(`  room currently has ${joined.players.length} player(s): ${joined.players.map((p) => `${p.id.slice(0, 8)}(${p.species})`).join(', ')}`);
  }
  console.log('');

  // Hold the SSE stream so the registry does NOT GC this presence — without
  // this the browser sees the player flicker in/out every ~30s and no remote
  // VRM ever mounts (the D3 false-negative). One controller for the whole run.
  const streamAbort = new AbortController();
  holdStream(joined.roomId, streamAbort.signal);

  console.log(`heartbeating at 5 Hz for ${SECONDS}s (Ctrl-C to stop early)…`);

  let stopped = false;
  const stop = () => { stopped = true; streamAbort.abort(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Tiny idle wobble so the activity flips walking↔idle and dirZ updates,
  // exercising the entity-interpolation + facing path on the client.
  const start = Date.now();
  let tick = 0;
  let last409 = 0;
  while (!stopped && (Date.now() - start) / 1000 < SECONDS) {
    const phase = tick % 20;
    const moving = phase < 4; // brief walk burst every ~4s
    const x = X + (moving ? Math.sin(tick * 0.3) * 4 : 0);
    const dirZ = moving ? Math.atan2(Math.cos(tick * 0.3) * 4, 0) : 0;
    const status = await position(x, Y, dirZ, moving ? 'walking' : 'idle');
    if (status === 409) {
      // GC'd (no-position-update timeout) — rejoin once, then continue.
      const now = Date.now();
      if (now - last409 > 5000) {
        last409 = now;
        // A 409 with a held stream is unexpected (the stream should prevent
        // GC) — log it loudly and re-join + re-hold so the presence recovers.
        console.log('[synthetic] 409 despite held stream — rejoining + re-holding stream…');
        const rejoined = await join();
        if (rejoined) {
          console.log(`[synthetic] rejoined room=${rejoined.roomId} publicId=${rejoined.id}`);
          holdStream(rejoined.roomId, streamAbort.signal);
        }
      }
    } else if (status !== 200 && tick % 25 === 0) {
      console.log(`[synthetic] position status=${status}`);
    }
    tick++;
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\nleaving…');
  await leave();
  console.log('done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
