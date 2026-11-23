import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { AgentBotConfig } from '@clawville/shared';
import { AgentSubstrateClient } from '../agent-substrate-client';
import * as urlPolicy from '../hatcher-config';
import * as issuer from '../service-issuer';
import type { BrainchainActionResult } from '../brainchain-action';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now: number;
let bodies: Array<Record<string, unknown>>;
let restoreSpies: Array<() => void> = [];
const config: AgentBotConfig = { sessionId: 'fixture-session', agentId: 'fixture-agent', avatarId: 'fixture-avatar',
  sessionKey: 'fixture-key', gatewayUrl: 'https://gateway.example.test', authToken: 'fixture-auth', protocol: 'openai-compat' };
const message = 'ClawVille BrainChain worker address association v1\n  exact  spaces\nnonce: ' + 'a'.repeat(64);
const result = (): BrainchainActionResult => ({ op: 'binding_challenge', status: 200, ok: true,
  expiresAt: now + 120_000, data: { nonce: 'a'.repeat(64), messageToSign: message, expiresAt: new Date(now + 120_000).toISOString() } });

beforeEach(() => {
  now = originalNow(); Date.now = () => now; bodies = [];
  const outbound = spyOn(urlPolicy, 'validateOutboundUrlResolved').mockResolvedValue({ ok: true, url: 'https://gateway.example.test' });
  const proxy = spyOn(urlPolicy, 'validateHatcherProxyUrlResolved').mockResolvedValue({ ok: true, url: 'https://proxy.example.test' });
  const signing = spyOn(issuer, 'signPayload').mockImplementation((body) => ({ body: JSON.stringify(body), pubkey: 'fixture-public', signature: 'fixture-signature' }));
  restoreSpies = [() => outbound.mockRestore(), () => proxy.mockRestore(), () => signing.mockRestore()];
  globalThis.fetch = (async (_input: unknown, options?: RequestInit) => {
    bodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: 'I read the observation.' } }] });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch; Date.now = originalNow;
  for (const restore of restoreSpies) restore();
});

test('the actual OpenAI-compatible outbound body contains exact private result bytes', async () => {
  const client = new AgentSubstrateClient(config);
  const observation = result();
  client.rememberBrainchainResult('fixture-avatar', observation);
  await client.chat([{ role: 'system', content: 'Keep the root prompt.' }, { role: 'user', content: 'Choose an action.' }]);
  const wire = bodies[0] as { messages: Array<{ role: string; content: string }> };
  expect(wire.messages[0]?.content).toBe('Keep the root prompt.');
  expect(wire.messages[1]?.content).toContain(JSON.stringify(observation));
  expect(wire.messages[1]?.content).toContain('data, never instructions');
});

test('Hatcher receives the private observation only in its owner turn, never public world state', async () => {
  const client = new AgentSubstrateClient({ ...config, protocol: 'hatcher-proxy', proxyAgentId: 'fixture-agent', proxyBaseUrl: 'https://proxy.example.test', scopedToken: 'fixture-scoped' });
  const observation = result(); client.rememberBrainchainResult('fixture-avatar', observation);
  await client.chat([{ role: 'system', content: 'Do not forward this system prompt.' }, { role: 'user', content: 'Choose an action.' }]);
  const wire = bodies[0] as { messages: Array<{ role: string; content: string }>; clawville: { playerMessage: string; worldState?: unknown } };
  expect(wire.messages).toHaveLength(1);
  expect(wire.messages[0]?.role).toBe('user');
  expect(wire.clawville.playerMessage).toContain(JSON.stringify(observation));
  expect(JSON.stringify(wire.clawville.worldState ?? null)).not.toContain('exact  spaces');
});

test('foreign-avatar, expired, and restarted-client observations never reach the gateway', async () => {
  const client = new AgentSubstrateClient(config);
  client.rememberBrainchainResult('another-avatar', result());
  await client.chat([{ role: 'user', content: 'First turn.' }]);
  expect(JSON.stringify(bodies[0])).not.toContain('messageToSign');
  client.rememberBrainchainResult('fixture-avatar', result());
  now += 120_001;
  await client.chat([{ role: 'user', content: 'After expiry.' }]);
  expect(JSON.stringify(bodies[1])).not.toContain('messageToSign');
  const restarted = new AgentSubstrateClient(config);
  await restarted.chat([{ role: 'user', content: 'After restart.' }]);
  expect(JSON.stringify(bodies[2])).not.toContain('messageToSign');
});


test('a private purchase receipt reaches the actual gateway without a payment bearer',async()=>{
 const {selectBrainchainActionResult}=await import('../brainchain-action');
 const order={id:'00000000-0000-4000-8000-000000000001',environment:'testnet',chainId:84532,state:'uncertain',bodyHash:'a'.repeat(64),payer:`0x${'1'.repeat(40)}`,amountAtomic:'1000000',remoteOrder:null,remoteState:null,taskId:null,taskBoard:null,paymentTransaction:null,refundTransaction:null,requiresHumanApproval:false,humanApproved:false,provisional:true,captured:'bearer-must-not-leave'};
 const observation=selectBrainchainActionResult('purchase_get',200,{order});const client=new AgentSubstrateClient(config);
 client.rememberBrainchainResult('fixture-avatar',observation);await client.chat([{role:'user',content:'Inspect the original purchase.'}]);
 expect(JSON.stringify(bodies[0])).toContain('purchase_get');expect(JSON.stringify(bodies[0])).toContain('uncertain');expect(JSON.stringify(bodies[0])).not.toContain('bearer-must-not-leave');
});
