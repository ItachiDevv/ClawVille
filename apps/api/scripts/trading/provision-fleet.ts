import { TRADING_OBJECTIVES, type TradingObjective } from '@clawville/shared';

const productionApproved = process.argv.includes('--production');
if (process.env.CLAWVILLE_ENV === 'production' && !productionApproved) {
  throw new Error('Refusing production fleet provisioning without --production.');
}

const apiUrl = (process.env.CLAWVILLE_API_URL ?? 'https://api-staging.clawville.world').replace(/\/+$/, '');
const origin = (process.env.CLAWVILLE_OPERATOR_ORIGIN ?? 'https://staging.clawville.world').replace(/\/+$/, '');
const cookie = process.env.CLAWVILLE_OPERATOR_COOKIE?.trim();
if (!cookie) throw new Error('CLAWVILLE_OPERATOR_COOKIE is required.');

const names: Record<TradingObjective, string> = {
  'momentum-board': 'MomentumTrader',
  'ansem-clawville-dca': 'ClawDcaTrader',
  'sol-usdc-mean-reversion': 'SolMeanTrader',
  'intel-signal-follower': 'IntelTrader',
  'conservative-rebalancer': 'SafeRebalancer',
};

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

for (const objective of TRADING_OBJECTIVES) {
  const nonceResponse = await request('/api/admin/trading/nonce');
  const nonce = nonceResponse.nonce;
  if (typeof nonce !== 'string' || nonce.length < 32) throw new Error('Operator nonce response is invalid.');

  const provisioned = await request('/api/admin/trading/fleet/provision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Money-Confirmation-Nonce': nonce,
    },
    body: JSON.stringify({
      objective,
      traderName: names[objective],
      leaderboardEligible: true,
      operatedByClawville: true,
    }),
  });
  if (provisioned.armed !== false || provisioned.killed !== true) {
    throw new Error(`Fleet safety state is invalid for ${objective}.`);
  }
  console.log(String(provisioned.walletPubkey));
}
