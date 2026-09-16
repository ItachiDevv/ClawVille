const productionApproved = process.argv.includes('--production');
const apiUrl = (process.env.CLAWVILLE_API_URL ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const hostname = new URL(apiUrl).hostname.toLowerCase();
if ((process.env.CLAWVILLE_ENV === 'production' || hostname === 'api.clawville.world') && !productionApproved) {
  throw new Error('Refusing production founder pairing without --production.');
}

const args = process.argv.slice(2).filter((value) => value !== '--production');
const challengeOnly = args.includes('--challenge');
const values = args.filter((value) => value !== '--challenge');
const [walletPubkey, challengeNonce, signature] = values;
if (!walletPubkey) throw new Error('Usage: bun scripts/trading/pair-genesis.ts <walletPubkey> --challenge [--production], then <walletPubkey> <challengeNonce> <signature> [--production]');

const avatarId = process.env.CLAWVILLE_GENESIS_AVATAR_ID?.trim();
if (!avatarId) throw new Error('CLAWVILLE_GENESIS_AVATAR_ID is required.');

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

async function operatorNonce(): Promise<string> {
  const nonceResponse = await request('/api/admin/trading/nonce');
  const nonce = nonceResponse.nonce;
  if (typeof nonce !== 'string' || nonce.length < 32) throw new Error('Operator nonce response is invalid.');
  return nonce;
}

if (challengeOnly) {
  const challenge = await request('/api/admin/trading/pair/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Money-Confirmation-Nonce': await operatorNonce() },
    body: JSON.stringify({ avatarId, walletPubkey }),
  });
  console.log(JSON.stringify(challenge, null, 2));
  process.exit(0);
}

if (!challengeNonce || !signature) {
  throw new Error('Pair submission requires the challenge nonce and the detached base58 signature.');
}

const paired = await request('/api/admin/trading/pair', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Money-Confirmation-Nonce': await operatorNonce(),
  },
  body: JSON.stringify({
    avatarId,
    clawpumpAgentId: 'genesis',
    walletPubkey,
    objective: 'momentum-board',
    nonce: challengeNonce,
    signature,
  }),
});

console.log(String(paired.walletPubkey));
