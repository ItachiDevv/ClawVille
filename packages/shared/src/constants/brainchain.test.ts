import { describe, expect, test } from 'bun:test';
import {
  BRAINCHAIN_CAPABILITIES,
  BRAINCHAIN_CURRICULUM_SECTIONS,
  BRAINCHAIN_NETWORKS,
  BRAINCHAIN_OFFICE_KNOWLEDGE,
  buildBrainchainOfficeManual,
} from './brainchain';

describe('reviewed BrainChain curriculum', () => {
  test('manual and teacher knowledge preserve each reviewed safety paragraph', () => {
    const manual = buildBrainchainOfficeManual();
    const knowledge = BRAINCHAIN_OFFICE_KNOWLEDGE.join('\n');
    for (const section of BRAINCHAIN_CURRICULUM_SECTIONS) {
      for (const paragraph of section.paragraphs) {
        expect(manual).toContain(paragraph);
        expect(knowledge).toContain(paragraph);
      }
    }
    expect(manual).toContain('House-task output can become public after grading even when rejected.');
    expect(manual).toContain('A Solana payout request does not authorize an RH USDG fallback.');
  });

  test('the capability menu never enables unsupported payment or execution actions', () => {
    const available = BRAINCHAIN_CAPABILITIES.filter((capability) => capability.status === 'available');
    expect(available.map((capability) => capability.id)).toEqual(['office_knowledge']);
    expect(BRAINCHAIN_CAPABILITIES.find((capability) => capability.id === 'solana_funding')?.status).toBe('source-present');
    expect(BRAINCHAIN_CAPABILITIES.find((capability) => capability.id === 'solana_task_purchase')?.status).toBe('not-verified');
    expect(BRAINCHAIN_CAPABILITIES.find((capability) => capability.id === 'solana_cash_out')?.status).toBe('unavailable');
    expect(BRAINCHAIN_CAPABILITIES.find((capability) => capability.id === 'hosted_worker')?.status).toBe('planned');
  });

  test('practice distinguishes testnet from mainnet without secret-key commands', () => {
    expect(BRAINCHAIN_NETWORKS.testnet.chainId).not.toBe(BRAINCHAIN_NETWORKS.mainnet.chainId);
    const manual = buildBrainchainOfficeManual();
    expect(manual).toContain('verify chain ID 274630 before any worker transaction');
    expect(manual).toContain('48-hour mainnet application timelock');
    expect(manual).not.toMatch(/(?:export|set|\$env:)\s*BRAINCHAIN_(?:WORKER|SOLANA)_KEY\s*=/i);
    expect(manual).not.toContain('BRAINCHAIN_PAY_ON=solana');
    expect(manual).toContain('brainchain-worker@0.19.2');
    expect(manual).toContain('export BRAINCHAIN_NETWORK=testnet');
    expect(manual).toContain('new-key --file "$BRAINCHAIN_WORKER_KEY_FILE"');
    expect(manual).toContain('https://brain.testnet.usebrainchain.com/testnet/gas');
    expect(manual).toContain('brainchain-worker join --name');
    expect(manual).toContain('brainchain-worker run --exec');
  });
});
