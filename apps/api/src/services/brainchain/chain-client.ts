import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { validateOutboundUrlResolved } from '../hatcher-config';
import { BRAINCHAIN_CONTRACTS, type BrainChainEnvironment } from './contracts';

// ABI subset verified against worker b71f3b24ddbda4fe31026dfa66fc23c12194c800/src/{abi,chain}.ts.
export const workerReadAbi = parseAbi([
  'function workerAllowed(address) view returns (bool)',
  'function get(address) view returns ((uint128 staked,uint128 unstaking,uint64 unlocksAt,uint128 price,bool registered))',
  'function minStake() view returns (uint128)', 'function held(address) view returns (uint32)',
  'function bond() view returns (uint128)', 'function timelock() view returns (uint64)',
  'function balanceOf(address) view returns (uint256)',
]);
export const taskReadAbi = parseAbi([
  'function get(uint256 id) view returns ((address poster,uint128 bounty,uint64 deadline,uint8 status,bool accepted,bool disputed,bool disputedByModel,bytes32 model,bytes32 briefHash,bytes32 resultHash,uint64 submittedAt,uint64 gradedAt,uint64 disputedAt,uint64 postedAt,address payee,address feeRecipient,uint16 feeBps,uint16 hireThresholdBps,uint16 gradeThresholdBps,uint16 ruleThresholdBps,uint64 gradeWindow,uint64 disputeWindow,uint64 ruleWindow))',
]);
export const workerHireAbi = parseAbi(['event WorkerHired(uint256 indexed id,bytes32 indexed model,uint256 indexed decisionId)']);
export const rpcQuantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
export const rpcHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const rpcData = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export const blockSchema = z.object({ number: rpcQuantity, hash: rpcHash, timestamp: rpcQuantity });
export type ChainBlock = z.infer<typeof blockSchema>;
export const logSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), topics: z.array(rpcHash).max(4), data: rpcData,
  blockNumber: rpcQuantity, blockHash: rpcHash, transactionHash: rpcHash, logIndex: rpcQuantity,
  removed: z.boolean().optional(),
});
export type ChainLog = z.infer<typeof logSchema>;
export class BrainChainReadError extends Error { readonly code = 'chain_read_unavailable'; }
export const manifestHash = (environment: BrainChainEnvironment) => createHash('sha256').update(JSON.stringify(BRAINCHAIN_CONTRACTS[environment])).digest('hex');
const permittedMethods = new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call','eth_getBalance','eth_getLogs']);

/** Read-only fixed-host RPC. No wallet client, dynamic URL, arbitrary HTTP method, or transaction method exists. */
export function createBrainChainReadRpc(target: BrainChainEnvironment | 'robinhood', overrides: {
  fetch?: typeof fetch; validateUrl?: typeof validateOutboundUrlResolved; timeoutMs?: number;
} = {}) {
  const url = target === 'robinhood' ? 'https://rpc.mainnet.chain.robinhood.com' : BRAINCHAIN_CONTRACTS[target].rpc;
  const fetcher = overrides.fetch ?? fetch;
  const deadline = Date.now() + 30_000;
  let id = 0;
  async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
    if (!permittedMethods.has(method)) throw new BrainChainReadError('Unsupported read');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BrainChainReadError('Read session deadline');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrainChainReadError('RPC deadline')); }, Math.min(overrides.timeoutMs ?? 5000, remaining)); });
    const request = async () => {
      const approved = await (overrides.validateUrl ?? validateOutboundUrlResolved)(url);
      if (!approved.ok || controller.signal.aborted) throw new BrainChainReadError('RPC host unavailable');
      const requestId = ++id;
      const response = await fetcher(url, { method: 'POST', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) {
        await response.body?.cancel(); throw new BrainChainReadError('RPC response unavailable');
      }
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      let count = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          count += part.value.byteLength;
          if (count > 1_048_576) { await reader.cancel(); throw new BrainChainReadError('RPC response too large'); }
          chunks.push(part.value);
        }
      } finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
      const bytes = new Uint8Array(count); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(requestId), result: z.unknown(), error: z.unknown().optional() })
        .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (envelope.error !== undefined || !('result' in envelope)) throw new BrainChainReadError('RPC refused read');
      return envelope.result;
    };
    try { return await Promise.race([request(), timeout]); }
    catch { throw new BrainChainReadError('Chain read failed'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return rpc;
}

/** Worker reads retain the existing pinned transport and shared read deadline. */
export function createBrainChainReader(environment: BrainChainEnvironment, overrides: {
  fetch?: typeof fetch; validateUrl?: typeof validateOutboundUrlResolved; timeoutMs?: number;
} = {}) {
  const manifest = BRAINCHAIN_CONTRACTS[environment];
  const rpc = createBrainChainReadRpc(environment, overrides);
  async function assertChain() {
    if (BigInt(rpcQuantity.parse(await rpc('eth_chainId'))) !== BigInt(manifest.chainId)) throw new BrainChainReadError('Chain mismatch');
  }
  async function block(number: bigint): Promise<ChainBlock> {
    const value = blockSchema.parse(await rpc('eth_getBlockByNumber', [toHex(number), false]));
    if (BigInt(value.number) !== number) throw new BrainChainReadError('Block mismatch');
    return value;
  }
  async function stableBlock() {
    await assertChain();
    const head = BigInt(rpcQuantity.parse(await rpc('eth_blockNumber')));
    // This is a provisional rewind margin, never a claim of parent-chain settlement finality.
    return block(head > 12n ? head - 12n : 0n);
  }
  async function assertCode(address: string, at: ChainBlock) {
    const code = rpcData.parse(await rpc('eth_getCode', [address, at.number]));
    if (code === '0x') throw new BrainChainReadError('Pinned contract has no code');
  }
  async function workerCall(address: Address, functionName: typeof workerReadAbi[number]['name'], args: readonly [Address] | readonly [], at: ChainBlock):Promise<unknown> {
    const data = encodeFunctionData({ abi: workerReadAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const result = rpcData.parse(await rpc('eth_call', [{ to: address, data }, at.number])) as Hex;
    return decodeFunctionResult({ abi: workerReadAbi, functionName, data: result });
  }
  async function snapshot(address: Address) {
    const at = await stableBlock();
    for (const contract of Object.values(manifest.contracts)) await assertCode(contract, at);
    const c = manifest.contracts;
    const [allowed, stake, held, gas, brain, usdg, minStake, bond, timelock] = await Promise.all([
      workerCall(c.board,'workerAllowed',[address],at), workerCall(c.staking,'get',[address],at), workerCall(c.staking,'held',[address],at),
      rpc('eth_getBalance',[address,at.number]), workerCall(c.brain,'balanceOf',[address],at), workerCall(c.usdg,'balanceOf',[address],at),
      workerCall(c.staking,'minStake',[],at), workerCall(c.bonds,'bond',[],at), workerCall(c.executor,'timelock',[],at),
    ]);
    const staking=z.object({staked:z.bigint().nonnegative(),unstaking:z.bigint().nonnegative(),unlocksAt:z.bigint().nonnegative(),price:z.bigint().nonnegative(),registered:z.boolean()}).parse(stake);
    const scalar=z.union([z.bigint().nonnegative(),z.number().int().nonnegative().safe()]).transform(String);
    const observedAt=new Date();
    const blockAgeSeconds=Math.max(0,Math.floor(observedAt.getTime()/1000)-Number(BigInt(at.timestamp)));
    if ((await block(BigInt(at.number))).hash !== at.hash) throw new BrainChainReadError('Block changed during read');
    return { environment, chainId: manifest.chainId, address: address.toLowerCase(), observedAt: observedAt.toISOString(),blockAgeSeconds,
      executionEligible:false as const,freshness:{state:blockAgeSeconds>120?'stale' as const:'recent' as const,maxBlockAgeSeconds:120},
      block: { number: BigInt(at.number).toString(), hash: at.hash, timestamp: BigInt(at.timestamp).toString() },
      manifestHash: manifestHash(environment), provisional: true as const, allowed:z.boolean().parse(allowed),
      stake: { stakedAtomic: staking.staked.toString(), unstakingAtomic: staking.unstaking.toString(), unlocksAtUnix: staking.unlocksAt.toString(), priceAtomic: staking.price.toString(), registered: staking.registered, held: scalar.parse(held) },
      balances: { gasWei: BigInt(rpcQuantity.parse(gas)).toString(), brainAtomic: scalar.parse(brain), usdgAtomic: scalar.parse(usdg) },
      terms: { minStakeAtomic: scalar.parse(minStake), bondAtomic: scalar.parse(bond), timelockSeconds: scalar.parse(timelock) },
    };
  }
  async function hiredLogs(board: Address, model: Hex, from: bigint, to: bigint) {
    if (!manifest.boards.some((entry) => entry.address === board.toLowerCase()) || from < 0n || to < from || to - from >= 50_000n) throw new BrainChainReadError('Invalid log range');
    const { toEventSelector } = await import('viem');
    const result = await rpc('eth_getLogs', [{ address: board, fromBlock: toHex(from), toBlock: toHex(to),
      topics: [toEventSelector('WorkerHired(uint256,bytes32,uint256)'), null, model] }]);
    return z.array(logSchema).max(1000).parse(result);
  }
  async function task(board: Address, taskId: bigint, at: ChainBlock) {
    if (!manifest.boards.some((entry) => entry.address === board.toLowerCase())) throw new BrainChainReadError('Unknown board');
    const data = encodeFunctionData({ abi: taskReadAbi, functionName: 'get', args: [taskId] });
    const result = rpcData.parse(await rpc('eth_call', [{ to: board, data }, at.number])) as Hex;
    return decodeFunctionResult({ abi: taskReadAbi, functionName: 'get', data: result });
  }
  async function paidLogs(board: Address, model: Hex, account: Address, from: bigint, to: bigint) {
    if (!manifest.boards.some((entry) => entry.address === board.toLowerCase()) || from < 0n || to < from || to - from >= 2000n) throw new BrainChainReadError('Invalid payment range');
    const { toEventSelector, pad } = await import('viem');
    const result = await rpc('eth_getLogs', [{ address: board, fromBlock: toHex(from), toBlock: toHex(to),
      topics: [toEventSelector('BountyPaid(uint256,bytes32,address,uint128,uint128)'), null, model, pad(account, { size: 32 })] }]);
    return z.array(logSchema).max(1000).parse(result);
  }
  return { snapshot, stableBlock, block, assertChain, assertCode, hiredLogs, paidLogs, task };
}
