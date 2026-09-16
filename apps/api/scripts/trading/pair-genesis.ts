const productionApproved = process.argv.includes('--production');
if (process.env.CLAWVILLE_ENV === 'production' && !productionApproved) {
  throw new Error('Refusing production founder pairing without --production.');
}

const walletPubkey = process.argv.slice(2).find((value) => value !== '--production')?.trim();
if (!walletPubkey) throw new Error('Usage: bun scripts/trading/pair-genesis.ts <walletPubkey> [--production]');

const avatarId = process.env.CLAWVILLE_GENESIS_AVATAR_ID?.trim();
if (!avatarId) throw new Error('CLAWVILLE_GENESIS_AVATAR_ID is required.');

const apiUrl = (process.env.CLAWVILLE_API_URL ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
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
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${String(payload.code ?? payload.error ?? 'unknown')}`);
  }
  return payload;
}

const nonceResponse = await request('/api/admin/trading/nonce');
const nonce = nonceResponse.nonce;
if (typeof nonce !== 'string' || nonce.length < 32) throw new Error('Operator nonce response is invalid.');

const paired = await request('/api/admin/trading/pair', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Money-Confirmation-Nonce': nonce,
  },
  body: JSON.stringify({
    avatarId,
    clawpumpAgentId: 'genesis',
    walletPubkey,
    objective: 'momentum-board',
    operatedByClawville: false,
  }),
});

console.log(String(paired.walletPubkey));
