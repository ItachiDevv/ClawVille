import { createHash } from 'node:crypto';
import { verifyMessage } from 'viem';
import { z } from 'zod';
import { BRAINCHAIN_NETWORKS } from '@clawville/shared';

export const workerBindingInput = z.object({
  environment: z.enum(['testnet', 'mainnet']),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase())
    .refine((value) => value !== `0x${'0'.repeat(40)}`, 'Zero address cannot bind'),
}).strict();
export const workerBindingProofInput = z.object({
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
export const workerControlInput = z.object({ requestedState: z.enum(['paused', 'draining']) }).strict();
export const proofHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function bindingDomain(environment = process.env.CLAWVILLE_ENV): string {
  if (environment === 'production') return 'api.clawville.world';
  if (environment === 'staging') return 'api-staging.clawville.world';
  throw new Error('brainchain_deployment_environment_required');
}

export function buildWorkerBindingMessage(input: {
  avatarId: string; environment: 'testnet' | 'mainnet'; address: string;
  domain: string; nonce: string; issuedAt: Date; expiresAt: Date;
}): string {
  return [
    'ClawVille BrainChain worker address association v1',
    `domain: ${input.domain}`, 'purpose: bind-worker-address',
    `avatar: ${input.avatarId}`, `environment: ${input.environment}`,
    `chain: ${BRAINCHAIN_NETWORKS[input.environment].chainId}`,
    `address: ${input.address}`, `nonce: ${input.nonce}`,
    `issued: ${input.issuedAt.toISOString()}`, `expires: ${input.expiresAt.toISOString()}`,
    'This signature associates this address only. It grants no spending, staking, borrowing, or signing authority.',
    'This pilot permanently reserves the address to this avatar on this network.',
  ].join('\n');
}

export async function verifyWorkerBindingSignature(address: string, message: string, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch { return false; }
}
