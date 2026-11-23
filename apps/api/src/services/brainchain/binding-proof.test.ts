import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { bindingDomain, buildWorkerBindingMessage, proofHash, verifyWorkerBindingSignature, workerBindingInput, workerBindingProofInput, workerControlInput } from './binding-proof';

// Public deterministic test key, never a wallet used outside these tests.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const input = { avatarId: 'afba8dd6-cfea-4bb0-9d14-0505f242b8a8', environment: 'testnet' as const,
  address: account.address.toLowerCase(), domain: 'api-staging.clawville.world', nonce: 'ab'.repeat(32),
  issuedAt: new Date('2026-11-09T12:00:00Z'), expiresAt: new Date('2026-11-09T12:02:00Z') };

describe('BrainChain worker proof boundaries', () => {
  test('verifies real EIP191 proof only for exact server message and expected wallet', async () => {
    const message = buildWorkerBindingMessage(input);
    const signature = await account.signMessage({ message });
    expect(await verifyWorkerBindingSignature(input.address, message, signature)).toBe(true);
    for (const changed of [
      { avatarId: 'different-avatar' }, { domain: 'other.example' }, { environment: 'mainnet' as const },
      { nonce: 'cd'.repeat(32) }, { expiresAt: new Date('2026-11-09T12:03:00Z') },
      { address: `0x${'22'.repeat(20)}` },
    ]) {
      expect(await verifyWorkerBindingSignature(input.address, buildWorkerBindingMessage({ ...input, ...changed }), signature)).toBe(false);
    }
    expect(await verifyWorkerBindingSignature(`0x${'22'.repeat(20)}`, message, signature)).toBe(false);
    expect(await verifyWorkerBindingSignature(input.address, message.replace('bind-worker-address', 'stake'), signature)).toBe(false);
  });

  test('normalizes addresses and rejects zero, unknown network and extra authority fields', () => {
    expect(workerBindingInput.parse({ environment: 'testnet', address: account.address }).address).toBe(input.address);
    for (const value of [
      { environment: 'testnet', address: `0x${'0'.repeat(40)}` },
      { environment: 'production', address: account.address },
      { environment: 'testnet', address: account.address, avatarId: 'victim' },
      { environment: 'testnet', address: account.address, stake: 100 },
    ]) expect(workerBindingInput.safeParse(value).success).toBe(false);
    expect(workerControlInput.safeParse({ requestedState: 'running' }).success).toBe(false);
    expect(workerBindingProofInput.safeParse({ nonce: input.nonce, signature: '0x00', message: 'replacement' }).success).toBe(false);
  });

  test('domain comes from deployment identity and never accepts an arbitrary host', () => {
    expect(bindingDomain('production')).toBe('api.clawville.world');
    expect(bindingDomain('staging')).toBe('api-staging.clawville.world');
    expect(() => bindingDomain('localhost')).toThrow();
    expect(proofHash(input.nonce)).toMatch(/^[a-f0-9]{64}$/);
    const message = buildWorkerBindingMessage(input);
    expect(message).toContain('grants no spending, staking, borrowing, or signing authority');
    expect(message).toContain('permanently reserves');
  });
});
