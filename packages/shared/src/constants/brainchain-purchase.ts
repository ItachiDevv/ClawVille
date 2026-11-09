/** Explicit buyer lane. Other offered lanes need their own reviewed adapter. */
export const BRAINCHAIN_BUYER_LANE = {
  environment: 'testnet', chainId: 84532, network: 'eip155:84532', token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  recipient: '0xf848984c8a0d9e49cc9c97380c62b34c6f3b97d1', origin: 'https://brain.testnet.usebrainchain.com',
  endpoint: 'https://brain.testnet.usebrainchain.com/x402/tasks', rpc: 'https://sepolia.base.org',
  amountAtomic: '1000000', decimals: 6, domainName: 'USDC', domainVersion: '2', authorizationSeconds: 300,
} as const;
export const BRAINCHAIN_SOLANA_BUYER_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;
export type BrainchainBuyerNetwork = 'eip155:84532' | typeof BRAINCHAIN_SOLANA_BUYER_NETWORK;
export const BRAINCHAIN_BUYER_STATES = ['draft','quoted','reserved','captured','sending','uncertain','payment_observed','refunded','canceled','reorg_suspended'] as const;
export type BrainchainBuyerState = typeof BRAINCHAIN_BUYER_STATES[number];
export interface BrainchainBuyerRecovery {
  state:'not_started'|'incomplete'|'not_found'|'unavailable'|'ambiguous'|'payment_observed';checkedAt:string|null;scannedTransactions:number;hasMore:boolean;
  refundRelease:'unavailable';refundReleaseReason:'order_attribution_unverified';
}
export interface BrainchainBuyerOrder {
  id: string; environment: 'testnet'; chainId: 84532 | null; network?: BrainchainBuyerNetwork; state: BrainchainBuyerState;
  title: string; brief: string; levels: string[]; bodyHash: string; payer: string | null;
  amountAtomic: string; quoteExpiresAt: string | null; authorizationExpiresAt: string | null;
  remoteOrder: string | null; remoteState: string | null; taskId: string | null; taskBoard: string | null;
  paymentTransaction: string | null; refundTransaction: string | null; provisional: true; recovery?:BrainchainBuyerRecovery;
  requiresHumanApproval: boolean; humanApproved: boolean; createdAt: string; updatedAt: string;
}
export interface BrainchainBuyerAvailability {
  environment: 'testnet'; network: 'eip155:84532'; networks?: readonly BrainchainBuyerNetwork[]; executionEnabled: boolean; unsupported: readonly string[];
}
