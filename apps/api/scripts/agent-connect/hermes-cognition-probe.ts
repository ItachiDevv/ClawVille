/**
 * Hermes host-it-for-me COGNITION-WIRE probe (D7, magic-link onboarding).
 *
 * DETERMINISTIC proof of the piece the unit tests do NOT cover: that the REAL
 * `AgentSubstrateClient.chatHermesLocal` actually POSTs an OpenAI-compat body to the
 * hardcoded local runtime (localhost:8642), parses the reply, and fails soft
 * when the runtime is down. (The unit tests prove the identityType→'hermes-local'
 * DERIVATION; this proves the WIRE.)
 *
 * Bypasses the sim's non-deterministic ambient-conversation trigger by calling
 * the client directly. Spawns the real mock-hermes-server, so this is a
 * self-contained local run — no staging, no env gate needed (we construct the
 * client with protocol 'hermes-local' directly; the env gate only decides
 * whether the DERIVATION picks that protocol, which the unit tests already pin).
 *
 * Run:  bun run apps/api/scripts/agent-connect/hermes-cognition-probe.ts
 */

// Dummy env so importing the api service graph (service-issuer / hatcher-config
// / fingerprint) does not throw at module load. None is used by chatHermesLocal
// (it sends no auth and hits a compile-time constant URL) — these just satisfy
// crash-loud module-load guards, exactly like scripts/hatcher/selftest-e2e.ts.
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
process.env.FINGERPRINT_SECRET ??= 'a'.repeat(64);
process.env.VANITY_ENCRYPTION_KEY ??= 'b'.repeat(64);
process.env.CLAWVILLE_SERVICE_ISSUER_SK ??= 'c'.repeat(64);
process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY ??= 'd'.repeat(64);
process.env.CLOUDFLARE_WORKER_URL ??= 'https://example.invalid';
process.env.CLOUDFLARE_WORKER_BEARER ??= 'x';
process.env.PARTNER_PUBKEYS ??= '{}';

const { AgentSubstrateClient } = await import('../../src/services/agent-substrate-client');

const MOCK = 'apps/api/scripts/agent-connect/mock-hermes-server.ts';
const MARKER = 'HERMES_MOCK_REPLY_V1';
let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${msg}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${msg}${extra ? `  ${extra}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  // Construct a 'hermes-local' client directly. gatewayUrl is IGNORED on this
  // path (chatHermesLocal hits the hardcoded HERMES_LOCAL_GATEWAY_URL), but the
  // constructor requires it.
  return new AgentSubstrateClient({
    agentId: 'probe-hermes-001',
    sessionId: 'probe-sess',
    gatewayUrl: 'http://localhost:0',
    authToken: '',
    protocol: 'hermes-local',
    species: 'milady_official_1',
    color: 0x888888,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function healthUp(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:8642/health');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

async function main() {
  console.log('\n=== Hermes host-it-for-me cognition-wire probe ===\n');

  // 1. mock DOWN → chat() fails soft to '' (never throws / stalls the sim).
  const soft = await makeClient().chat([{ role: 'user', content: 'ping while down' }]);
  ok(soft === '', 'FAIL-SOFT: chat() returns "" when the local runtime is DOWN', `got=${JSON.stringify(soft).slice(0, 40)}`);

  // 2. Spawn the real mock runtime on 8642, wait for health.
  const proc = Bun.spawn(['bun', 'run', MOCK], { stdout: 'pipe', stderr: 'pipe', cwd: process.cwd() });
  const up = await healthUp();
  ok(up, 'mock-hermes-server is UP on 127.0.0.1:8642 (/health ok)');

  if (up) {
    // 3. Real chatHermesLocal → POST → parse → marker round-trips.
    const reply = await makeClient().chat([{ role: 'user', content: 'hello hermes' }]);
    ok(reply.includes(MARKER), 'WIRE: chatHermesLocal POSTed to :8642 and returned the mock reply', `reply="${reply.slice(0, 90)}"`);
    ok(reply.length > 0 && reply.length <= 4000, 'reply is bounded (<=4000 chars)', `len=${reply.length}`);

    // 4. The mock actually recorded the hit (proves the POST reached it, not a fallback).
    try {
      const h = await (await fetch('http://127.0.0.1:8642/health')).json() as { requests?: number };
      ok((h.requests ?? 0) >= 1, 'mock recorded >=1 chat request (POST genuinely reached the runtime)', `requests=${h.requests}`);
    } catch (e) { ok(false, 'mock health re-read failed', String(e)); }
  }

  proc.kill();
  await proc.exited.catch(() => {});

  console.log(`\n======================================================`);
  console.log(`SUMMARY: ${pass} PASS / ${fail} FAIL`);
  console.log(`======================================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(2); });
