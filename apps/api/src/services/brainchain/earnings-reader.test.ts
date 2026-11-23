import { expect, test } from 'bun:test';
import { encodeAbiParameters, encodeEventTopics, pad, parseAbi, toHex, type Hex } from 'viem';
import { readWorkerEarnings, earningsQuerySchema } from './earnings-reader';
import { BRAINCHAIN_CONTRACTS } from './contracts';

const board = BRAINCHAIN_CONTRACTS.mainnet.boards[0]!;
const address = `0x${'1'.repeat(40)}` as const;
const hash = `0x${'a'.repeat(64)}` as const;
const worker = { id: '11111111-1111-4111-8111-111111111111', address, environment: 'mainnet' as const, chainId: 274663 };
const abi = parseAbi(['event BountyPaid(uint256 indexed id, bytes32 indexed model, address indexed account, uint128 bounty, uint128 fee)']);
function receipt(index = 0, block = 1000, bounty = 9007199254740993000n, fee = 7n) {
  return { address: board.address as string, blockNumber: toHex(block), blockHash: hash as string, transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
    logIndex: toHex(index), removed: false,
    topics: encodeEventTopics({ abi, eventName: 'BountyPaid', args: { id: BigInt(index), model: pad(address, { size: 32 }), account: address } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }], [bounty, fee]) };
}
type Receipt = ReturnType<typeof receipt>;
function fixture(logs: Receipt[] = []) {
  const ranges: [bigint, bigint][] = [];
  let codeReads = 0;
  const reader = {
    snapshot: async () => ({ environment: 'mainnet' as const, chainId: 274663 as const, address, observedAt: '2026-11-09T00:00:00.000Z', blockAgeSeconds: 3,
      executionEligible: false as const, freshness: { state: 'recent' as const, maxBlockAgeSeconds: 120 }, provisional: true as const,
      block: { number: '5000', hash, timestamp: '1794182400' }, manifestHash: hash, allowed: false,
      stake: { stakedAtomic: '0', unstakingAtomic: '0', unlocksAtUnix: '0', priceAtomic: '0', registered: false, held: '0' },
      balances: { gasWei: '0', brainAtomic: '0', usdgAtomic: '123' }, terms: { minStakeAtomic: '0', bondAtomic: '0', timelockSeconds: '0' } }),
    block: async (number: bigint) => ({ number: toHex(number), hash, timestamp: '0x01' }),
    assertCode: async () => { codeReads++; },
    paidLogs: async (_board: string, _model: string, _account: string, from: bigint, to: bigint) => {
      ranges.push([from, to]); return logs.filter(log => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to);
    },
  };
  return { reader, ranges, codeReads: () => codeReads };
}
test('exact net receipt amounts, balances, canonical anchor, coverage, and next cursor stay separate', async () => {
  const f = fixture([receipt()]);
  const page = await readWorkerEarnings(worker, {}, f.reader);
  expect(page.balances.usdgAtomic).toBe('123');
  expect(page.history.pageNetAtomic).toBe('9007199254740992993');
  expect(page.history.receipts[0]?.netAtomic).toBe('9007199254740992993');
  expect(page.history).toMatchObject({ fromBlock: '965', throughBlock: '2964', nextBlock: '2965', coverage: 'selected_board_range' });
  expect(page.provisional).toBe(true);
  expect(f.codeReads()).toBe(1);
});
test('dense ranges shrink and resume without dropping receipts', async () => {
  const logs = Array.from({ length: 11 }, (_, index) => receipt(index, 1000 + index * 100));
  const f = fixture(logs);
  const first = await readWorkerEarnings(worker, {}, f.reader);
  expect(f.ranges.length).toBeGreaterThan(1);
  const second = await readWorkerEarnings(worker, { fromBlock: first.history.nextBlock! }, f.reader);
  expect(first.history.receipts.length + second.history.receipts.length).toBe(11);
  expect(BigInt(second.history.fromBlock)).toBe(BigInt(first.history.throughBlock!) + 1n);
});
test('an overfull single block fails instead of dropping or advancing receipts', async () => {
  await expect(readWorkerEarnings(worker, { fromBlock: '1000' }, fixture(Array.from({ length: 11 }, (_, index) => receipt(index))).reader)).rejects.toThrow('page bound');
});
test('foreign, duplicate, removed, invalid net and noncanonical receipts fail closed', async () => {
  for (const logs of [
    [receipt(), receipt()], [{ ...receipt(), removed: true }], [{ ...receipt(), address }],
    [{ ...receipt(), blockHash: `0x${'b'.repeat(64)}` }], [receipt(0, 1000, 2n, 3n)],
    [{ ...receipt(), topics: encodeEventTopics({ abi, eventName: 'BountyPaid', args: { id: 0n, model: pad(address, { size: 32 }), account: `0x${'2'.repeat(40)}` } }) as Hex[] }],
  ]) await expect(readWorkerEarnings(worker, {}, fixture(logs).reader)).rejects.toThrow();
});
test('unknown boards, predeployment cursors and malformed cursor fields fail', async () => {
  expect(earningsQuerySchema.safeParse({ fromBlock: '01' }).success).toBe(false);
  expect(earningsQuerySchema.safeParse({ fromBlock: '1e3' }).success).toBe(false);
  expect(earningsQuerySchema.safeParse({ fromBlock: '18446744073709551616' }).success).toBe(false);
  expect(earningsQuerySchema.safeParse({ avatarId: 'foreign' }).success).toBe(false);
  await expect(readWorkerEarnings(worker, { board: address }, fixture().reader)).rejects.toThrow('Unknown board');
  await expect(readWorkerEarnings(worker, { fromBlock: '0' }, fixture().reader)).rejects.toThrow('deployment');
  await expect(readWorkerEarnings({ ...worker, chainId: 1 }, {}, fixture().reader)).rejects.toThrow('chain mismatch');
});
test('future ranges stay empty without a repeated cursor; retired boards remain explicit', async () => {
  const future = fixture();
  const page = await readWorkerEarnings(worker, { fromBlock: '6000' }, future.reader);
  expect(page.history).toMatchObject({ throughBlock: null, nextBlock: null, receipts: [], pageNetAtomic: '0' });
  expect(future.ranges).toHaveLength(0);
  const retired = await readWorkerEarnings(worker, { board: BRAINCHAIN_CONTRACTS.mainnet.boards[1]!.address }, fixture().reader);
  expect(retired.history.fromBlock).toBe('839');
});
test('anchor changes after receipt validation invalidate the entire observation', async () => {
  const f = fixture([receipt()]);
  let anchors = 0;
  f.reader.block = async number => ({ number: toHex(number), timestamp: '0x01', hash: number === 5000n && ++anchors > 1 ? `0x${'b'.repeat(64)}` as typeof hash : hash });
  await expect(readWorkerEarnings(worker, {}, f.reader)).rejects.toThrow('Anchor changed');
});
