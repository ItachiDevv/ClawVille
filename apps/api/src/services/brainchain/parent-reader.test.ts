import { expect, test } from 'bun:test';
import { decodeFunctionData, encodeFunctionResult, getAddress, toHex, type Hex } from 'viem';
import { BRAINCHAIN_PARENT, createBrainChainParentReader, parentReadAbi } from './parent-reader';
const worker = `0x${'1'.repeat(40)}` as const;
const other = `0x${'2'.repeat(40)}` as const;
const hash = `0x${'a'.repeat(64)}` as const;
function fixture(owner: string = worker, wallet: string = worker, chainId = 4663, registry: string = BRAINCHAIN_PARENT.identity) {
  const calls: { to: string; name: string; args: readonly unknown[] | undefined; block: string }[] = [];
  const reader = createBrainChainParentReader({ validateUrl: async url => ({ ok: true, url }), fetch: (async (url, init) => {
    expect(url).toBe('https://rpc.mainnet.chain.robinhood.com');
    const request = JSON.parse(String(init?.body)); let result: unknown;
    if (request.method === 'eth_chainId') result = toHex(chainId);
    else if (request.method === 'eth_blockNumber') result = toHex(5012);
    else if (request.method === 'eth_getBlockByNumber') result = { number: request.params[0], hash, timestamp: toHex(1794230000) };
    else if (request.method === 'eth_getCode') { expect(request.params[1]).toBe(toHex(5000)); result = '0x01'; }
    else {
      const call = decodeFunctionData({ abi: parentReadAbi, data: request.params[0].data as Hex });
      calls.push({ to: request.params[0].to, name: call.functionName, args: call.args, block: request.params[1] });
      const values: Record<string, unknown> = { ownerOf: owner, getAgentWallet: wallet, getIdentityRegistry: registry, getSummary: [8n, 875n, 1] };
      result = encodeFunctionResult({ abi: parentReadAbi, functionName: call.functionName, result: values[call.functionName] } as Parameters<typeof encodeFunctionResult>[0]);
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch });
  return { reader, calls };
}
test('owner, registered wallet and issuer-filtered reputation use the same parent block', async () => {
  const f = fixture(); const at = await f.reader.anchor();
  expect(await f.reader.association(462n, worker, at)).toEqual({ owner: worker, registeredWallet: worker, kind: 'both' });
  expect(await f.reader.reputation(462n, at)).toMatchObject({ count: '8', summaryValue: '875', summaryValueDecimals: 1 });
  expect(f.calls.every(call => call.block === at.number)).toBe(true);
  expect(f.calls.find(call => call.name === 'getSummary')?.args).toEqual([462n, [getAddress(BRAINCHAIN_PARENT.issuer)], 'brainchain', 'task']);
  expect(f.calls.filter(call => ['ownerOf', 'getAgentWallet'].includes(call.name)).every(call => call.to === BRAINCHAIN_PARENT.identity)).toBe(true);
});
test('registered wallet association never becomes owner association; unrelated identities fail', async () => {
  for (const [owner, wallet, expected] of [[other, worker, 'registered_wallet'], [worker, other, 'owner'], [other, other, null]] as const) {
    const f = fixture(owner, wallet); const at = await f.reader.anchor();
    expect((await f.reader.association(462n, worker, at))?.kind ?? null).toBe(expected);
  }
});
test('wrong parent chain and mismatched reputation identity registry fail', async () => {
  await expect(fixture(worker, worker, 1).reader.anchor()).rejects.toThrow('chain mismatch');
  const f = fixture(worker, worker, 4663, other);
  await expect(f.reader.association(462n, worker, await f.reader.anchor())).rejects.toThrow('association mismatch');
});
