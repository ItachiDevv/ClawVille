/**
 * SAP worker pricing provisioning contract tests.
 *
 * These tests stay offline. Boundary validation must reject malformed tier
 * requests before custody/RPC work, while the executor dry-run test below uses
 * mocked wallet/RPC dependencies and never broadcasts.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';
import * as realDatabase from '@clawville/database';
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import idlJson from '@oobe-protocol-labs/synapse-sap-sdk/idl/synapse_agent_sap.json' with { type: 'json' };
import { registerSchema } from '../../../routes/sap-route-schemas';

const walletKeypair = Keypair.generate();
let sendCalls = 0;
let walletLookupCalls = 0;
let simulateCalls = 0;
let simulatedTx: Transaction | null = null;

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: {
    query: {
      wallets: {
        findFirst: async () => {
          walletLookupCalls += 1;
          return { subjectType: 'avatar', subjectId: 'worker-avatar' };
        },
      },
    },
  },
}));

mock.module('../../keypair-vault', () => ({
  decryptWalletRow: async () => walletKeypair,
}));

spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
  blockhash: Keypair.generate().publicKey.toBase58(),
  lastValidBlockHeight: 123,
});
// The exact overload is wider than the one this executor invokes; the cast keeps
// the fake focused on the response contract without weakening production types.
spyOn(Connection.prototype, 'simulateTransaction').mockImplementation(async (tx) => {
  simulateCalls += 1;
  simulatedTx = tx as Transaction;
  return {
    context: { slot: 1 },
    value: {
      err: null,
      logs: ['Program SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ invoke [1]'],
      accounts: null,
      unitsConsumed: 10_000,
      returnData: null,
      innerInstructions: null,
    },
  };
});
spyOn(Connection.prototype, 'sendRawTransaction').mockImplementation(async () => {
  sendCalls += 1;
  return 'must-not-broadcast';
});

process.env.SAP_ENABLED = 'true';
process.env.SAP_ESCROW_ENABLED = 'true';
process.env.SAP_USDC_ESCROW_ENABLED = 'true';
process.env.SAP_DRY_RUN = 'true';
process.env.SAP_CLUSTER = 'devnet';
process.env.SAP_RPC_URL = 'http://127.0.0.1:8899';

const {
  updateAgentPricingUsdc,
  validateUpdateAgentPricingUsdcInput,
} = await import('../sap-client');

const validPricing = {
  workerAvatarId: 'worker-avatar',
  tierId: 'standard-usdc',
  pricePerCall: 10_000n,
};

describe('SAP worker USDC pricing validation', () => {
  it('builds and simulates the executor without broadcasting', async () => {
    const result = await updateAgentPricingUsdc({
      ...validPricing,
      tierId: '  standard-usdc  ',
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.message);
    expect(result.dryRun).toBeTrue();
    if (!result.dryRun) throw new Error('expected dry-run result');
    expect(result.accepted).toBeTrue();
    expect(result.programReached).toBe('yes');
    expect(result.simulation.err).toBeNull();
    expect(result.accounts.wallet).toBe(walletKeypair.publicKey.toBase58());
    expect(result.accounts.agent).toBeString();
    expect(result.accounts.pricingMenu).toBeString();
    expect('signature' in result).toBeFalse();
    expect(sendCalls).toBe(0);
    expect(walletLookupCalls).toBe(1);
    expect(simulateCalls).toBe(1);

    const instruction = simulatedTx?.instructions[0];
    expect(instruction).toBeDefined();
    const decoded = new BorshInstructionCoder(idlJson as Idl).decode(instruction!.data);
    expect(decoded?.name).toBe('update_agent');
    const data = decoded?.data as Record<string, unknown>;
    expect(data.name).toBeNull();
    expect(data.description).toBeNull();
    expect(data.capabilities).toBeNull();
    expect(data.protocols).toBeNull();
    expect(data.agent_id).toBeNull();
    expect(data.agent_uri).toBeNull();
    expect(data.x402_endpoint).toBeNull();
    const pricing = data.pricing as Array<Record<string, unknown>>;
    expect(pricing).toHaveLength(1);
    expect(pricing[0].tier_id).toBe('standard-usdc');
    expect(String(pricing[0].price_per_call)).toBe('10000');
    expect(pricing[0].rate_limit).toBe(100);
    expect(pricing[0].max_calls_per_session).toBe(1000);
    expect(pricing[0].token_decimals).toBe(6);
    expect(pricing[0].token_type).toEqual({ Usdc: {} });
    expect(pricing[0].settlement_mode).toEqual({ Escrow: {} });
  });

  it('rejects invalid executor inputs before custody or RPC work', async () => {
    const invalidInputs = [
      { ...validPricing, tierId: '   ' },
      { ...validPricing, tierId: 'x'.repeat(33) },
      { ...validPricing, pricePerCall: 0n },
      { ...validPricing, pricePerCall: 0x1_0000_0000_0000_0000n },
      { ...validPricing, rateLimit: 0 },
      { ...validPricing, maxCallsPerSession: 0 },
    ];
    const walletBaseline = walletLookupCalls;
    const simulateBaseline = simulateCalls;

    for (const input of invalidInputs) {
      const result = await updateAgentPricingUsdc(input);
      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error('invalid pricing unexpectedly accepted');
      expect(result.code).toBe('invalid_amount');
    }
    expect(walletLookupCalls).toBe(walletBaseline);
    expect(simulateCalls).toBe(simulateBaseline);
    expect(sendCalls).toBe(0);
  });

  it('accepts the defaulted positive tier contract', () => {
    expect(validateUpdateAgentPricingUsdcInput(validPricing)).toBeNull();
  });

  it('rejects an empty, whitespace-only, or overlong tierId', () => {
    for (const tierId of ['', '   ', 'x'.repeat(33)]) {
      const result = validateUpdateAgentPricingUsdcInput({ ...validPricing, tierId });
      expect(result?.ok).toBeFalse();
      expect(result?.code).toBe('invalid_amount');
    }
  });

  it('rejects non-positive and out-of-u64 prices', () => {
    for (const pricePerCall of [0n, -1n, 0x1_0000_0000_0000_0000n]) {
      const result = validateUpdateAgentPricingUsdcInput({ ...validPricing, pricePerCall });
      expect(result?.ok).toBeFalse();
      expect(result?.code).toBe('invalid_amount');
    }
  });

  it('rejects non-positive, non-integer, and out-of-i32 limits', () => {
    for (const rateLimit of [0, -1, 1.5, 0x8000_0000]) {
      const result = validateUpdateAgentPricingUsdcInput({ ...validPricing, rateLimit });
      expect(result?.ok).toBeFalse();
      expect(result?.code).toBe('invalid_amount');
    }
    for (const maxCallsPerSession of [0, -1, 1.5, 0x8000_0000]) {
      const result = validateUpdateAgentPricingUsdcInput({ ...validPricing, maxCallsPerSession });
      expect(result?.ok).toBeFalse();
      expect(result?.code).toBe('invalid_amount');
    }
  });
});

describe('SAP register description schema', () => {
  it('requires a non-empty trimmed description', () => {
    for (const body of [
      { name: 'Worker' },
      { name: 'Worker', description: '' },
      { name: 'Worker', description: '   ' },
    ]) {
      expect(registerSchema.safeParse(body).success).toBeFalse();
    }

    const parsed = registerSchema.safeParse({
      name: 'Worker',
      description: '  Performs SAP work  ',
    });
    expect(parsed.success).toBeTrue();
    if (parsed.success) expect(parsed.data.description).toBe('Performs SAP work');
  });
});
