import { createBrainChainPublicClient } from './public-client';

export function createBrainChainStatusService(
  client = createBrainChainPublicClient(),
  now: () => number = Date.now,
  ttlMs = 60_000,
) {
  type Snapshot = Awaited<ReturnType<typeof read>>;
  let cached: { until: number; value: Snapshot } | undefined;
  let inFlight: Promise<Snapshot> | undefined;

  async function read() {
    const [payment, mainnetExit, testnetExit] = await Promise.all([
      client.observePayment(), client.observeExit('mainnetExit'), client.observeExit('testnetExit'),
    ]);
    return {
      observedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + ttlMs).toISOString(),
      payment, exits: { mainnet: mainnetExit, testnet: testnetExit },
      // A challenge is an advertisement, not a verified payment or permission to sign.
      executionEnabled: false as const,
    };
  }
  async function getStatus(): Promise<Snapshot> {
    if (cached && cached.until > now()) return cached.value;
    if (inFlight) return inFlight;
    inFlight = read().then((value) => {
      cached = { until: now() + ttlMs, value };
      return value;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return { getStatus };
}

export const brainChainStatus = createBrainChainStatusService();
