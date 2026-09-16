import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { buildTradingSwapTransaction, fetchTradingQuote, parsedJupiterQuoteSchema } from '../trading-jupiter';

const fixtureDir = resolve(import.meta.dir, '__fixtures__/jupiter');
const expectedHashes: Record<string, string> = {
  'quote-usdc-ansem.json': '54229a5d86b49150d6d77261f56b84928ec37b1b528a828ad84341292d5ed0e3',
  'quote-usdc-clv.json': 'b290998a0dee84323ecdffdbff4eda1a1d0634035acc3b0592b17258bf191a2f',
  'quote-sol-ansem.json': 'ab4079a9ebf78d6dec79821d7493caa959025865ef82cbe0f547782db6b97956',
  'quote-ansem-usdc.json': 'f3cda1062769c520b230ad856b2f486374145ad628f59f0e00360f83504f0e07',
};

describe('Trading Jupiter fixture contract', () => {
  for (const filename of Object.keys(expectedHashes)) {
    test(`parses byte-identical ${filename}`, () => {
      const bytes = readFileSync(resolve(fixtureDir, filename));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHashes[filename]);
      expect(parsedJupiterQuoteSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success).toBe(true);
    });
  }

  test('fixture inventory contains exactly the frozen four', () => {
    expect(readdirSync(fixtureDir).sort()).toEqual(Object.keys(expectedHashes).sort());
  });

  test('rejects additive fields and accepts nullable instructionVersion', () => {
    const raw = JSON.parse(readFileSync(resolve(fixtureDir, 'quote-usdc-ansem.json'), 'utf8'));
    expect(parsedJupiterQuoteSchema.safeParse({ ...raw, unexpected: true }).success).toBe(false);
    const nested = structuredClone(raw);
    nested.routePlan[0].swapInfo.unexpected = true;
    expect(parsedJupiterQuoteSchema.safeParse(nested).success).toBe(false);
    expect(parsedJupiterQuoteSchema.safeParse({ ...raw, instructionVersion: null }).success).toBe(true);
  });

  test('refuses ExactOut, a non-null platform fee, and discontinuous routes', async () => {
    const raw = JSON.parse(readFileSync(resolve(fixtureDir, 'quote-usdc-ansem.json'), 'utf8'));
    for (const mutate of [
      (value: any) => { value.swapMode = 'ExactOut'; },
      (value: any) => { value.platformFee = { amount: '1', feeBps: 1 }; },
      (value: any) => { value.routePlan[1].swapInfo.inputMint = value.inputMint; },
    ]) {
      const value = structuredClone(raw);
      mutate(value);
      const fetchImpl = async () => Response.json(value);
      await expect(fetchTradingQuote({
        inputMint: raw.inputMint,
        outputMint: raw.outputMint,
        amountAtomic: BigInt(raw.inAmount),
        slippageBps: raw.slippageBps,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })).rejects.toThrow();
    }
  });

  test('requests ExactIn V1 and sends only the frozen swap-build fields', async () => {
    const raw = JSON.parse(readFileSync(resolve(fixtureDir, 'quote-usdc-ansem.json'), 'utf8'));
    let quoteUrl = '';
    const quote = await fetchTradingQuote({
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      amountAtomic: BigInt(raw.inAmount),
      slippageBps: raw.slippageBps,
      fetchImpl: (async (url) => {
        quoteUrl = String(url);
        return Response.json(raw);
      }) as typeof fetch,
    });
    const parsedUrl = new URL(quoteUrl);
    expect(parsedUrl.searchParams.get('swapMode')).toBe('ExactIn');
    expect(parsedUrl.searchParams.get('instructionVersion')).toBe('V1');

    const payer = Keypair.generate().publicKey;
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [],
    }).compileToV0Message());
    let body: Record<string, unknown> | null = null;
    await buildTradingSwapTransaction({
      quote,
      userPublicKey: payer.toBase58(),
      maxPriorityFeeLamports: 1_000n,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          swapTransaction: Buffer.from(tx.serialize()).toString('base64'),
          lastValidBlockHeight: 123,
        });
      }) as typeof fetch,
    });
    expect(Object.keys(body!).sort()).toEqual([
      'dynamicComputeUnitLimit',
      'prioritizationFeeLamports',
      'quoteResponse',
      'userPublicKey',
      'wrapAndUnwrapSol',
    ]);
  });
});
