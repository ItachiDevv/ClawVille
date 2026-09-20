import { TRADING_OBJECTIVES } from '@clawville/shared';
import { z } from 'zod';

const productionApproved = process.argv.includes('--production');
const apiUrl = (process.env.CLAWVILLE_API_URL ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const hostname = new URL(apiUrl).hostname.toLowerCase();
if ((process.env.CLAWVILLE_ENV === 'production' || hostname === 'api.clawville.world') && !productionApproved) {
  throw new Error('Refusing production founder pairing without --production.');
}

const args = process.argv.slice(2).filter((value) => value !== '--production');
let clawpumpAgentId = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
let objective = 'momentum-board';
let unpair = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--unpair') unpair = true;
  else if (arg === '--agent' && args[index + 1]) clawpumpAgentId = args[++index]!;
  else if (arg === '--objective' && args[index + 1]) objective = args[++index]!;
  else throw new Error('Usage: bun scripts/trading/pair-genesis.ts [--agent <uuid>] [--objective <TradingObjective>] [--unpair] [--production]');
}
if (!z.string().uuid().safeParse(clawpumpAgentId).success) throw new Error('Agent must be a UUID.');
if (!z.enum(TRADING_OBJECTIVES).safeParse(objective).success) throw new Error('Trading objective is invalid.');

const origin = (process.env.CLAWVILLE_OPERATOR_ORIGIN ?? 'https://staging.clawville.world').replace(/\/+$/, '');
const cookie = process.env.CLAWVILLE_OPERATOR_COOKIE?.trim();
if (!cookie) throw new Error('CLAWVILLE_OPERATOR_COOKIE is required.');

async function request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Cookie: cookie,
      Origin: origin,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const code = typeof payload === 'object' && payload !== null && 'code' in payload
      && typeof payload.code === 'string' && /^[a-z_]{1,64}$/.test(payload.code) ? payload.code : null;
    throw new Error(`${path} failed (${response.status})${code ? `: ${code}` : ''}.`);
  }
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new Error(`${path} returned invalid JSON.`);
  }
}

async function operatorNonce(): Promise<string> {
  const nonceResponse = await request('/api/admin/trading/nonce');
  const nonce = nonceResponse.nonce;
  if (typeof nonce !== 'string' || nonce.length < 32) throw new Error('Operator nonce response is invalid.');
  return nonce;
}

const agentList = await request('/api/admin/trading/clawpump/agents');
const agents = z.array(z.object({
  clawpumpAgentId: z.string().uuid(),
  name: z.string().nullable(),
  status: z.string().nullable(),
  walletPubkey: z.string().nullable(),
  pairedAvatarId: z.string().uuid().nullable(),
})).safeParse(agentList.agents);
if (!agents.success) throw new Error('Agent list response is invalid.');
for (const agent of agents.data) {
  console.log(agent.clawpumpAgentId, agent.name, agent.status, agent.walletPubkey, agent.pairedAvatarId);
}
const agent = agents.data.find((entry) => entry.clawpumpAgentId === clawpumpAgentId);
if (!agent) throw new Error('Agent is not owned by the configured ClawPump account.');

if (unpair) {
  if (!agent.pairedAvatarId) throw new Error('Agent has no paired avatar.');
  const unpaired = await request('/api/admin/trading/clawpump/unpair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Money-Confirmation-Nonce': await operatorNonce() },
    body: JSON.stringify({ avatarId: agent.pairedAvatarId, clawpumpAgentId }),
  });
  console.log('alreadyUnpaired', unpaired.alreadyUnpaired);
  process.exit(0);
}

const provisioned = await request('/api/admin/trading/clawpump/provision', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Money-Confirmation-Nonce': await operatorNonce() },
  body: JSON.stringify({ clawpumpAgentId }),
});
console.log(provisioned.avatarId, provisioned.avatarName, provisioned.created);

const paired = await request('/api/admin/trading/clawpump/pair', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Money-Confirmation-Nonce': await operatorNonce(),
  },
  body: JSON.stringify({
    avatarId: provisioned.avatarId,
    clawpumpAgentId,
    objective,
  }),
});

console.log('replayed', paired.replayed, 'boundSlot', paired.boundSlot);
console.log(String(paired.walletPubkey));
