import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

// Security fix D3 (2026-09-30): the hosted local runtimes (hermes-local / openclaw-local) are
// tool-capable. With no gateway key configured the client must send NOTHING — before this fix it
// sent a bare, unauthenticated POST. The keys are read once at module load, so the check runs in a
// child process whose environment has both keys removed (it runs even when the parent test
// environment carries real keys).
const CHILD = `
process.env.FINGERPRINT_SECRET ??= 'a'.repeat(64);
process.env.VANITY_ENCRYPTION_KEY ??= 'b'.repeat(64);
process.env.CLAWVILLE_SERVICE_ISSUER_SK ??= 'c'.repeat(64);
process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY ??= 'd'.repeat(64);
process.env.CLOUDFLARE_WORKER_URL ??= 'https://example.invalid';
process.env.CLOUDFLARE_WORKER_BEARER ??= 'x';
process.env.PARTNER_PUBKEYS ??= '{}';
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return new Response(JSON.stringify({ choices: [{ message: { content: 'should not be reached' } }] }), { status: 200 });
};
const { AgentSubstrateClient } = await import('./src/services/agent-substrate-client.ts');
const replies = [];
for (const protocol of ['hermes-local', 'openclaw-local']) {
  const client = new AgentSubstrateClient({
    agentId: 'fail-closed-' + protocol, sessionId: 'fail-closed-session', gatewayUrl: 'http://localhost:0',
    authToken: '', protocol, species: 'milady_official_1', color: 0x888888,
  });
  replies.push(await client.chat([{ role: 'user', content: 'hello' }]));
  await client.prewarmLocalGateway(1000);
}
console.log('RESULT fetchCalls=' + calls + ' replies=' + JSON.stringify(replies));
`;

describe('local runtime clients fail closed without a gateway key (D3)', () => {
  it('chat and prewarm send nothing for hermes-local and openclaw-local', () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.HERMES_LOCAL_GATEWAY_KEY;
    delete env.OPENCLAW_LOCAL_GATEWAY_KEY;
    const result = Bun.spawnSync([process.execPath, '-e', CHILD], {
      cwd: join(import.meta.dir, '..', '..', '..'),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.stdout.toString()).toContain('RESULT fetchCalls=0 replies=["",""]');
    expect(result.exitCode).toBe(0);
  });
});
