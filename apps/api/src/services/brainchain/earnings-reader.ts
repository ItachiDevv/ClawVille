import { decodeEventLog, parseAbi, pad, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { BrainchainEarningsPage } from '@clawville/shared';
import { BRAINCHAIN_CONTRACTS, type BrainChainEnvironment } from './contracts';
import { BrainChainReadError, createBrainChainReader } from './chain-client';

const decimalBlock = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(value => value.length <= 20 && /^\d+$/.test(value) && BigInt(value) < 2n ** 64n);
export const earningsQuerySchema = z.object({
  board: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase()).optional(),
  fromBlock: decimalBlock.optional(),
}).strict();
const paymentAbi = parseAbi(['event BountyPaid(uint256 indexed id, bytes32 indexed model, address indexed account, uint128 bounty, uint128 fee)']);
type Reader = Pick<ReturnType<typeof createBrainChainReader>, 'snapshot' | 'block' | 'paidLogs' | 'assertCode'>;

/** Bounded canonical receipt page; never indexes, settles, transfers, or infers lifetime income. */
export async function readWorkerEarnings(
  worker: { id: string; environment: BrainChainEnvironment; chainId: number; address: string },
  query: z.infer<typeof earningsQuerySchema>, reader: Reader,
): Promise<BrainchainEarningsPage> {
  query = earningsQuerySchema.parse(query);
  const manifest = BRAINCHAIN_CONTRACTS[worker.environment];
  if (worker.chainId !== manifest.chainId) throw new BrainChainReadError('Worker chain mismatch');
  const board = manifest.boards.find(entry => entry.address === (query.board ?? manifest.contracts.board));
  if (!board) throw new BrainChainReadError('Unknown board');
  const from = BigInt(query.fromBlock ?? board.fromBlock);
  if (from < BigInt(board.fromBlock)) throw new BrainChainReadError('Range precedes deployment');
  const snapshot = await reader.snapshot(worker.address as Address);
  const anchor = BigInt(snapshot.block.number);
  const at = await reader.block(anchor);
  if (at.hash.toLowerCase() !== snapshot.block.hash.toLowerCase()) throw new BrainChainReadError('Anchor changed');
  await reader.assertCode(board.address as Address, at);
  let through: bigint | null = from > anchor ? null : (from + 1999n < anchor ? from + 1999n : anchor);
  const model = pad(worker.address as Address, { size: 32 }).toLowerCase() as Hex;
  let logs: Awaited<ReturnType<Reader['paidLogs']>> = [];
  if (through !== null) {
    while (true) {
      logs = await reader.paidLogs(board.address as Address, model, worker.address as Address, from, through);
      if (logs.length <= 10) break;
      if (through === from) throw new BrainChainReadError('Payment block exceeds page bound');
      through = from + (through - from) / 2n;
    }
  }
  const seen = new Set<string>();
  const positions = new Set<string>();
  const hashes = new Map<string, string>();
  const receipts: BrainchainEarningsPage['history']['receipts'] = [];
  for (const log of logs) {
    const number = BigInt(log.blockNumber);
    const key = `${log.transactionHash.toLowerCase()}:${BigInt(log.logIndex)}`;
    const position = `${number}:${BigInt(log.logIndex)}`;
    if (log.removed || log.address.toLowerCase() !== board.address || number < from || through === null || number > through
      || number >= 2n ** 64n || BigInt(log.logIndex) > 2147483647n || seen.has(key) || positions.has(position)) throw new BrainChainReadError('Invalid payment receipt');
    seen.add(key);
    positions.add(position);
    const decoded = decodeEventLog({ abi: paymentAbi, eventName: 'BountyPaid', data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
    const { id, model: paidModel, account, bounty, fee } = decoded.args;
    if (paidModel.toLowerCase() !== model || account.toLowerCase() !== worker.address.toLowerCase() || fee > bounty) throw new BrainChainReadError('Foreign payment receipt');
    let hash = hashes.get(number.toString());
    if (!hash) { hash = (await reader.block(number)).hash.toLowerCase(); hashes.set(number.toString(), hash); }
    if (hash !== log.blockHash.toLowerCase()) throw new BrainChainReadError('Payment block changed');
    receipts.push({ taskId: id.toString(), transactionHash: log.transactionHash.toLowerCase(), logIndex: BigInt(log.logIndex).toString(),
      blockNumber: number.toString(), blockHash: hash, bountyAtomic: bounty.toString(), feeAtomic: fee.toString(), netAtomic: (bounty - fee).toString() });
  }
  receipts.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : 1);
  if ((await reader.block(anchor)).hash.toLowerCase() !== at.hash.toLowerCase()) throw new BrainChainReadError('Anchor changed');
  return { workerId: worker.id, environment: worker.environment, chainId: manifest.chainId, address: worker.address.toLowerCase(),
    observedAt: snapshot.observedAt, blockAgeSeconds: snapshot.blockAgeSeconds, provisional: true, freshness: snapshot.freshness,
    block: snapshot.block, balances: snapshot.balances, stake: snapshot.stake,
    history: { boardAddress: board.address, deploymentBlock: String(board.fromBlock), fromBlock: from.toString(), throughBlock: through?.toString() ?? null,
      nextBlock: through !== null && through < anchor ? (through + 1n).toString() : null, coverage: 'selected_board_range',
      pageNetAtomic: receipts.reduce((sum, receipt) => sum + BigInt(receipt.netAtomic), 0n).toString(), receipts,
      boards: manifest.boards.map(entry => ({ ...entry, fromBlock: String(entry.fromBlock) })) } };
}

export async function readOwnedWorkerEarnings(avatarId: string, workerId: string, input: unknown) {
  // Resolve ownership before RPC, including cache access if a cache is added later.
  const { ownedWorker } = await import('./tasks');
  const worker = await ownedWorker(avatarId, workerId);
  const query = earningsQuerySchema.parse(input);
  return readWorkerEarnings({ ...worker, environment: worker.environment as BrainChainEnvironment }, query, createBrainChainReader(worker.environment as BrainChainEnvironment));
}
