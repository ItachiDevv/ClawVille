import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { TRADE_MINTS } from '@clawville/shared';
import { fetchParsedTransactionJson } from '../trade-observer';
import { decodeSwapFromParsedTransaction } from '../trade-verifier';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/trade');
const NAME = 'jupiter-fleet-sol-usdc';
const WALLET = 'vaLqeo9HSaA5JbbDiL5GbusBG9jsKgQ6KXW8AUDZ3ZX';
const fixture = () => JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${NAME}.json`), 'utf8'));
const signature = () => JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${NAME}.source.json`), 'utf8')).signature as string;

function fakeFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; requests: Array<{ url: string; body: unknown }> } {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe('trade observer transaction fetch', () => {
  test('requests the raw jsonParsed document (v0 supported) and returns it unchanged', async () => {
    const { fetchImpl, requests } = fakeFetch({ jsonrpc: '2.0', id: 1, result: fixture() });
    const raw = await fetchParsedTransactionJson({ rpcUrl: 'https://rpc.test/', signature: signature(), fetchImpl });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({
      method: 'getTransaction',
      params: [signature(), { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    });
    expect(raw).toEqual(fixture());
    // The document the observer now feeds the verifier decodes as the fleet's Jupiter swap.
    expect(decodeSwapFromParsedTransaction({ signature: signature(), raw, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'swap', dex: 'jupiter', inputMint: TRADE_MINTS.WSOL, outputMint: TRADE_MINTS.USDC });
  });

  test('an explicit null loadedAddresses does not refuse a version-0 document', () => {
    const raw = fixture();
    raw.meta.loadedAddresses = null;
    expect(decodeSwapFromParsedTransaction({ signature: signature(), raw, expectedWallet: WALLET })).toMatchObject({ kind: 'swap', dex: 'jupiter' });
  });

  test('an unknown signature is null; an RPC error or HTTP failure throws', async () => {
    expect(await fetchParsedTransactionJson({ rpcUrl: 'https://rpc.test/', signature: signature(), fetchImpl: fakeFetch({ jsonrpc: '2.0', id: 1, result: null }).fetchImpl })).toBeNull();
    await expect(fetchParsedTransactionJson({ rpcUrl: 'https://rpc.test/', signature: signature(), fetchImpl: fakeFetch({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } }).fetchImpl })).rejects.toThrow('rpc_error_-32602');
    await expect(fetchParsedTransactionJson({ rpcUrl: 'https://rpc.test/', signature: signature(), fetchImpl: fakeFetch({}, 502).fetchImpl })).rejects.toThrow('rpc_http_502');
  });

  test('the web3.js parsed shape (PublicKey objects) is what the verifier refuses: the 2026-09-17 regression', () => {
    // Reproduce what `connection.getParsedTransaction` hands back: PublicKey objects in
    // accountKeys[].pubkey. The verifier schema expects the raw JSON-RPC strings.
    const raw = fixture();
    for (const key of raw.transaction.message.accountKeys) key.pubkey = new PublicKey(key.pubkey);
    expect(() => decodeSwapFromParsedTransaction({ signature: signature(), raw, expectedWallet: WALLET })).toThrow(/Expected string, received object/);
    // web3.js types `ParsedMessageAccount.pubkey` as PublicKey; the default dep must not use it.
    const sample: Awaited<ReturnType<Connection['getParsedTransaction']>> = null;
    expect(sample).toBeNull();
  });
});
