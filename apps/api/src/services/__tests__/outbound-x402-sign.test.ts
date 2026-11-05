/**
 * What the avatar wallet REALLY signs for a third-party x402 quote. Runs the
 * real @x402/svm client against a fake local RPC (mint account + blockhash),
 * then decodes the transaction: one USDC TransferChecked of the quoted amount
 * to the payTo token account, the seller as fee payer, our signature present,
 * and no other instruction that moves funds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { PaymentRequired } from '@x402/core/types';
import { SOLANA_MAINNET, isBase58Of, signThirdPartyExactPayment } from '../outbound-x402';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAMS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);
const PAY_TO = 'HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa';
const FEE_PAYER = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';

function mintAccountData(): string {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(0, 0); // no mint authority
  data.writeBigUInt64LE(1_000_000_000n, 36); // supply
  data.writeUInt8(6, 44); // decimals
  data.writeUInt8(1, 45); // initialized
  data.writeUInt32LE(0, 46); // no freeze authority
  return data.toString('base64');
}

let server: ReturnType<typeof Bun.serve>;
let rpcUrl = '';

beforeAll(() => {
  const blockhash = bs58.encode(Buffer.alloc(32, 9));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { id: number; method: string } | Array<{ id: number; method: string }>;
      const answer = (call: { id: number; method: string }) => {
        if (call.method === 'getAccountInfo') {
          return { jsonrpc: '2.0', id: call.id, result: { context: { slot: 1 }, value: { data: [mintAccountData(), 'base64'], executable: false, lamports: 1_461_600, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 82 } } };
        }
        if (call.method === 'getLatestBlockhash') {
          return { jsonrpc: '2.0', id: call.id, result: { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 100 } } };
        }
        return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unexpected ${call.method}` } };
      };
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    },
  });
  rpcUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function ata(owner: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(USDC).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();
}

describe('signThirdPartyExactPayment', () => {
  it('signs exactly one USDC transfer of the quoted amount to the pinned payTo, with the seller paying fees', async () => {
    const payer = Keypair.generate();
    const requirement = { scheme: 'exact', network: SOLANA_MAINNET, amount: '5000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } };
    const paymentRequired = { x402Version: 2, resource: { url: 'https://mystudios.fun/api/v1/images/generations' }, accepts: [requirement] } as PaymentRequired;

    const signed = await signThirdPartyExactPayment({
      paymentRequired,
      requirement: requirement as never,
      secretKey: payer.secretKey,
      publicKey: payer.publicKey.toBase58(),
      rpcUrl,
    });
    expect(isBase58Of(signed.payerSignature, 64)).toBe(true);

    const payload = JSON.parse(Buffer.from(signed.header, 'base64').toString('utf8')) as {
      x402Version: number;
      accepted: Record<string, unknown>;
      payload: { transaction: string };
    };
    expect(payload.x402Version).toBe(2);
    // The seller's entry is sent back unchanged.
    expect(payload.accepted).toEqual(requirement);

    const tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, 'base64'));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys[0]).toBe(FEE_PAYER);
    expect(keys[0]).not.toBe(payer.publicKey.toBase58());

    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
    const transfers = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === TOKEN_PROGRAM);
    expect(transfers).toHaveLength(1);
    for (const program of programs) {
      expect(program === TOKEN_PROGRAM || program === COMPUTE_BUDGET || MEMO_PROGRAMS.has(program!)).toBe(true);
    }

    const ix = transfers[0]!;
    const data = Buffer.from(ix.data);
    expect(data[0]).toBe(12); // TransferChecked
    expect(data.readBigUInt64LE(1)).toBe(5000n);
    expect(data[9]).toBe(6);
    const accounts = ix.accountKeyIndexes.map((i) => keys[i]);
    expect(accounts[0]).toBe(ata(payer.publicKey.toBase58())); // source
    expect(accounts[1]).toBe(USDC); // mint
    expect(accounts[2]).toBe(ata(PAY_TO)); // destination
    expect(accounts[3]).toBe(payer.publicKey.toBase58()); // authority

    const payerIndex = keys.indexOf(payer.publicKey.toBase58());
    expect(bs58.encode(tx.signatures[payerIndex]!)).toBe(signed.payerSignature);
  });
});
