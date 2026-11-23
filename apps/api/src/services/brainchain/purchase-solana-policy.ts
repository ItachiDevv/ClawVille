import { z } from 'zod';
import bs58 from 'bs58';
import { BrainchainPurchaseError, buyerDigest, canonical, type BuyerQuote } from './purchase-policy';

/** Pinned unsigned interface observation, 2026-11-09. No settlement claim. */
export const SOLANA_BUYER_LANE = Object.freeze({
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  rpc: 'https://api.devnet.solana.com',
  token: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  recipient: 'AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi',
  feePayer: 'BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP',
  amountAtomic: '1000000', decimals: 6, authorizationSeconds: 300,
  endpoint: 'https://brain.testnet.usebrainchain.com/x402/tasks',
} as const);
export const solanaBuyerAddress = z.string().min(32).max(44).refine(value => {
  try { return bs58.decode(value).length === 32 && bs58.encode(bs58.decode(value)) === value; } catch { return false; }
});
export const solanaBuyerSignature = z.string().min(64).max(88).refine(value => {
  try { return bs58.decode(value).length === 64 && bs58.encode(bs58.decode(value)) === value; } catch { return false; }
});
export function selectSolanaBuyerQuote(raw: unknown, now = Date.now()): BuyerQuote {
  const challenge = z.object({ x402Version: z.literal(2), accepts: z.array(z.record(z.unknown())).min(1).max(16),
    resource: z.object({ url: z.literal(SOLANA_BUYER_LANE.endpoint) }).passthrough(),
  }).passthrough().safeParse(raw);
  if (!challenge.success) throw new BrainchainPurchaseError('quote_refused');
  const matches = challenge.data.accepts.filter(item => item.network === SOLANA_BUYER_LANE.network);
  if (matches.length !== 1) throw new BrainchainPurchaseError('unsupported_payment_lane');
  const parsed = z.object({ scheme: z.literal('exact'), network: z.literal(SOLANA_BUYER_LANE.network),
    amount: z.literal(SOLANA_BUYER_LANE.amountAtomic), asset: z.literal(SOLANA_BUYER_LANE.token),
    payTo: z.literal(SOLANA_BUYER_LANE.recipient), maxTimeoutSeconds: z.number().int().positive().max(300),
    extra: z.object({ feePayer: z.literal(SOLANA_BUYER_LANE.feePayer) }).strict(),
  }).strict().safeParse(matches[0]);
  if (!parsed.success || Buffer.byteLength(canonical(challenge.data.resource)) > 4000) throw new BrainchainPurchaseError('quote_refused');
  const resource = challenge.data.resource as BuyerQuote['resource'];
  const requirement = parsed.data;
  return Object.freeze({ resource, requirement, hash: buyerDigest({ resource, requirement }), expiresAtMs: now + requirement.maxTimeoutSeconds * 1000 });
}
