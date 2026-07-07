/**
 * MOCK-HERMES LOCAL RUNTIME — staging-box-local harness (D7 host-it-for-me,
 * magic-link onboarding 2026-07-02).
 *
 * Stands in for a real `hermes run` runtime on the HARDCODED host-it-for-me
 * gateway target (`HERMES_LOCAL_GATEWAY_URL` = http://localhost:8642, see
 * apps/api/src/services/agent-session-config.ts) so the 'hermes-local' cognition
 * seam can be proven end-to-end WITHOUT deploying a real Hermes runtime:
 *
 *   1. run this ON THE SAME BOX as the API (the target is localhost by design —
 *      it is a server-side constant, never caller-suppliable, so the mock cannot
 *      be pointed at from outside);
 *   2. set HERMES_LOCAL_GATEWAY_ENABLED=true on that API and restart it;
 *   3. connect a hermes-identity agent (scripts/agent-connect/hermes-e2e.ts) —
 *      when the sim pulls its body into an ambient NPC conversation, the API
 *      POSTs here and the reply's deterministic marker proves the seam.
 *
 * The reply carries exactly one `[ACTION: emote(name=wave)]` tag (mirroring
 * mock-hatcher-proxy.ts) — today only the hatcher-proxy protocol parses/dispatches
 * ACTION tags, so for hermes-local the tag is inert reply text; it is included so
 * a future hermes ACTION dispatch has a ready-made probe.
 *
 * NO auth and NO signature verification, deliberately: the contract for
 * 'hermes-local' is a bare OpenAI-compat POST to a same-box runtime (nothing
 * secret is sent — see chatHermesLocal in services/agent-substrate-client.ts). To keep
 * the mock unreachable from off-box it binds 127.0.0.1, not 0.0.0.0.
 *
 * Run:  bun run apps/api/scripts/agent-connect/mock-hermes-server.ts [--port 8642]
 */

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function arg(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const PORT = Number.parseInt(arg('--port') ?? process.env.PORT ?? '8642', 10);

/**
 * Deterministic marker the e2e/staging operator greps chat output for — proves
 * the reply came from THIS mock (not a canned sim fallback, not a real runtime).
 */
const MOCK_MARKER = 'HERMES_MOCK_REPLY_V1';

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
let requestCount = 0;

const server = Bun.serve({
  // localhost-only on purpose — the API's hardcoded target is localhost and the
  // mock must not accidentally expose an unauthenticated endpoint off-box.
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const ts = new Date().toISOString();

    // Health probe (curl http://localhost:8642/health).
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, marker: MOCK_MARKER, requests: requestCount });
    }

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      console.log(`[hermes-mock] ${ts} ${req.method} ${url.pathname} → 404 (unhandled)`);
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    requestCount += 1;

    // Parse leniently — log what the API actually sent (model + last user turn)
    // so a contract drift is visible in the mock's stdout, but never 500 on a
    // malformed body (the client under test fails soft either way).
    let model = '(none)';
    let lastUser = '(none)';
    try {
      const body = (await req.json()) as {
        model?: unknown;
        messages?: Array<{ role?: unknown; content?: unknown }>;
      };
      if (typeof body.model === 'string') model = body.model;
      const users = (body.messages ?? []).filter((m) => m?.role === 'user');
      const last = users[users.length - 1];
      if (last && typeof last.content === 'string') lastUser = last.content;
    } catch {
      /* malformed body — reply anyway */
    }
    console.log(
      `[hermes-mock] ${ts} chat #${requestCount} → 200 model=${model} lastUser="${lastUser.slice(0, 80)}"`,
    );

    // Fixed OpenAI-shaped completion: deterministic marker + one ACTION tag.
    return Response.json({
      id: `hermes-mock-${requestCount}`,
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `Hello from the mock local Hermes runtime (${MOCK_MARKER}). [ACTION: emote(name=wave)]`,
          },
          finish_reason: 'stop',
        },
      ],
    });
  },
});

console.log('=== mock-Hermes local runtime (staging-box-local harness) ===');
console.log(`listening : http://127.0.0.1:${server.port}`);
console.log(`chat path : POST /v1/chat/completions (OpenAI-compat)`);
console.log(`marker    : ${MOCK_MARKER}`);
console.log('');
console.log('REMINDER: the API only calls this when HERMES_LOCAL_GATEWAY_ENABLED=true');
console.log('AND this runs on the SAME box (target is the hardcoded localhost:8642).');
console.log('Waiting for cognition calls…');
