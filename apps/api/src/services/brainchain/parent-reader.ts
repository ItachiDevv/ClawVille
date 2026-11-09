import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex, type Address, type Hex } from 'viem';
import { BrainChainReadError, blockSchema, createBrainChainReadRpc, rpcQuantity, type ChainBlock } from './chain-client';

/** Verified official worker network.ts and docs/workers. No runtime registry discovery. */
export const BRAINCHAIN_PARENT = {
  chainId: 4663,
  identity: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  reputation: '0x8004baa17c55a88189ae136b182e5fda19de9b63',
  issuer: '0xafb0c4ef895d4895040cdc6435b96d3ee8350c6e',
} as const;
export const parentReadAbi = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function getIdentityRegistry() view returns (address)',
  'function getSummary(uint256 agentId,address[] clientAddresses,string tag1,string tag2) view returns (uint64 count,int128 summaryValue,uint8 summaryValueDecimals)',
]);

export function createBrainChainParentReader(overrides: Parameters<typeof createBrainChainReadRpc>[1] = {}) {
  const rpc = createBrainChainReadRpc('robinhood', overrides);
  async function block(number: bigint): Promise<ChainBlock> {
    const value = blockSchema.parse(await rpc('eth_getBlockByNumber', [toHex(number), false]));
    if (BigInt(value.number) !== number || number >= 2n ** 64n) throw new BrainChainReadError('Parent block mismatch');
    return value;
  }
  async function anchor() {
    if (BigInt(rpcQuantity.parse(await rpc('eth_chainId'))) !== 4663n) throw new BrainChainReadError('Parent chain mismatch');
    const head = BigInt(rpcQuantity.parse(await rpc('eth_blockNumber')));
    return block(head > 12n ? head - 12n : 0n);
  }
  async function assertCode(address: Address, at: ChainBlock) {
    const code = await rpc('eth_getCode', [address, at.number]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new BrainChainReadError('Parent registry unavailable');
  }
  async function call(address: Address, functionName: typeof parentReadAbi[number]['name'], args: readonly unknown[], at: ChainBlock): Promise<unknown> {
    const data = encodeFunctionData({ abi: parentReadAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const result = await rpc('eth_call', [{ to: address, data }, at.number]);
    if (typeof result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new BrainChainReadError('Parent response invalid');
    return decodeFunctionResult({ abi: parentReadAbi, functionName, data: result as Hex });
  }
  async function association(agentId: bigint, workerAddress: Address, at: ChainBlock) {
    await Promise.all([assertCode(BRAINCHAIN_PARENT.identity, at), assertCode(BRAINCHAIN_PARENT.reputation, at)]);
    const [rawOwner, rawWallet, linkedRegistry] = await Promise.all([
      call(BRAINCHAIN_PARENT.identity, 'ownerOf', [agentId], at),
      call(BRAINCHAIN_PARENT.identity, 'getAgentWallet', [agentId], at),
      call(BRAINCHAIN_PARENT.reputation, 'getIdentityRegistry', [], at),
    ]);
    if (typeof rawOwner !== 'string' || typeof rawWallet !== 'string' || typeof linkedRegistry !== 'string'
      || linkedRegistry.toLowerCase() !== BRAINCHAIN_PARENT.identity) throw new BrainChainReadError('Registry association mismatch');
    const owner = rawOwner.toLowerCase(), registeredWallet = rawWallet.toLowerCase(), worker = workerAddress.toLowerCase();
    if (owner === `0x${'0'.repeat(40)}` || (owner !== worker && registeredWallet !== worker)) return null;
    return { owner, registeredWallet, kind: owner === worker ? registeredWallet === worker ? 'both' as const : 'owner' as const : 'registered_wallet' as const };
  }
  async function reputation(agentId: bigint, at: ChainBlock) {
    const result = await call(BRAINCHAIN_PARENT.reputation, 'getSummary', [agentId, [BRAINCHAIN_PARENT.issuer], 'brainchain', 'task'], at);
    if (!Array.isArray(result) || typeof result[0] !== 'bigint' || typeof result[1] !== 'bigint' || typeof result[2] !== 'number'
      || result[2] < 0 || result[2] > 18) throw new BrainChainReadError('Reputation response invalid');
    return { issuer: BRAINCHAIN_PARENT.issuer, tag1: 'brainchain' as const, tag2: 'task' as const,
      count: result[0].toString(), summaryValue: result[1].toString(), summaryValueDecimals: result[2] };
  }
  return { anchor, block, association, reputation };
}
