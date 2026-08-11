import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  admitPosterUsdcSpend,
  PosterUsdcSpendAdmissionError,
} from '../usdc-spend-admission';

const POSTER = '22222222-2222-4222-8222-222222222222';

function txWithLiabilities(outgoingLiabilitiesAtomic: bigint) {
  let call = 0;
  return {
    execute: async () => {
      call += 1;
      if (call === 1) return [];
      if (call === 2) return [{ public_key: 'poster-wallet' }];
      return [{
        open_holds: '0',
        outgoing_liabilities: outgoingLiabilitiesAtomic.toString(),
        consumed_hold: null,
      }];
    },
  };
}

async function admitWithLiabilities(outgoingLiabilitiesAtomic: bigint) {
  return admitPosterUsdcSpend(txWithLiabilities(outgoingLiabilitiesAtomic) as never, {
    posterAvatarId: POSTER,
    amountAtomic: 6_000_000n,
    readBalance: async () => 10_000_000n,
  });
}

describe('USDC spend admission reconcile liabilities', () => {
  it('counts an ambiguous agent payment until it is proven no-broadcast/resolved', async () => {
    await expect(admitWithLiabilities(5_000_000n)).rejects.toMatchObject({
      code: 'insufficient_usdc',
      detail: { outgoingLiabilitiesBaseUnits: '5000000', requiredBaseUnits: '11000000' },
    } satisfies Partial<PosterUsdcSpendAdmissionError>);

    await expect(admitWithLiabilities(0n)).resolves.toMatchObject({
      outgoingLiabilitiesAtomic: 0n,
      requiredAtomic: 6_000_000n,
    });
  });

  it('counts an ambiguous withdrawal until an operator moves it to a resolved terminal state', async () => {
    await expect(admitWithLiabilities(5_000_000n)).rejects.toMatchObject({
      code: 'insufficient_usdc',
    } satisfies Partial<PosterUsdcSpendAdmissionError>);

    await expect(admitWithLiabilities(0n)).resolves.toMatchObject({
      balanceAtomic: 10_000_000n,
      requiredAtomic: 6_000_000n,
    });
  });

  it('binds those behaviors to the production SQL predicates', () => {
    const source = readFileSync(resolve(__dirname, '../usdc-spend-admission.ts'), 'utf8');
    expect(source).toContain("p.status = 'reconcile' AND p.cap_exempt IS NOT TRUE");
    expect(source).toContain("w.status IN ('pending', 'sending', 'reconcile')");
    expect(source).toContain('AND backing.bounty_id IS NULL');
  });
});
