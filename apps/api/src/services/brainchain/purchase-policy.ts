import { randomBytes, createHash } from 'node:crypto';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { BRAINCHAIN_BUYER_LANE } from '@clawville/shared';

export const BUYER_LANE = BRAINCHAIN_BUYER_LANE;
export class BrainchainPurchaseError extends Error {
  constructor(readonly code: 'invalid_request'|'purchase_not_found'|'unsupported_payment_lane'|'quote_refused'|'owner_grant_required'|'human_approval_required'|'over_per_call_cap'|'over_daily_cap'|'payer_conflict'|'invalid_proof'|'order_conflict'|'purchase_unavailable'|'execution_disabled'|'payment_uncertain'|'receipt_unavailable'|'associated_token_account_required') { super(`BrainChain purchase refused: ${code}`); }
}
export const buyerAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
export const buyerHash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const buyerSignature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export const purchaseBodySchema = z.object({
  title: z.string().trim().min(1).max(120).refine(value => !/[\r\n\u2028\u2029]/.test(value)),
  brief: z.string().trim().min(1).max(32000), levels: z.array(z.string().trim().min(1).max(200)).min(2).max(3).refine(values => new Set(values).size === values.length).describe('Quality levels in best-first order. With two only the first passes; with three the second or better passes.'),
}).strict().refine(value => Buffer.byteLength(canonical({ ...value, passIndex: value.levels.length === 3 ? 1 : 0 })) <= 64000);
export type BuyerTaskBody = z.infer<typeof purchaseBodySchema>;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
export function buyerDigest(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value), 'utf8').digest('hex'); }
const requirementSchema = z.object({ scheme: z.literal('exact'), network: z.string().max(100), amount: z.string().regex(/^[1-9][0-9]{0,19}$/),
  asset: z.string().max(128), payTo: z.string().max(128), maxTimeoutSeconds: z.number().int().positive().max(600), extra: z.record(z.unknown()).optional() }).strict();
const challengeSchema = z.object({ x402Version: z.literal(2), accepts: z.array(requirementSchema).min(1).max(16),
  resource: z.object({ url: z.literal(BUYER_LANE.endpoint), description: z.string().max(2000).optional(), mimeType: z.literal('application/json').optional(),
    serviceName: z.string().max(100).optional(), tags: z.array(z.string().max(100)).max(20).optional(), iconUrl: z.string().max(500).optional() }).strict(),
  error: z.string().max(1000).optional(), extensions: z.record(z.unknown()).optional(),
}).strict();
export interface BuyerQuote { resource: z.infer<typeof challengeSchema>['resource']; requirement: z.infer<typeof requirementSchema>; hash: string; expiresAtMs: number }
export function selectBuyerQuote(raw: unknown, now = Date.now()): BuyerQuote {
  const challenge = challengeSchema.safeParse(raw); if (!challenge.success) throw new BrainchainPurchaseError('quote_refused');
  const matches = challenge.data.accepts.filter(item => item.network === BUYER_LANE.network && item.scheme === 'exact' && item.asset.toLowerCase() === BUYER_LANE.token);
  if (matches.length !== 1) throw new BrainchainPurchaseError('unsupported_payment_lane');
  const requirement = matches[0]!;
  if (requirement.payTo.toLowerCase() !== BUYER_LANE.recipient || requirement.amount !== BUYER_LANE.amountAtomic
    || requirement.maxTimeoutSeconds > BUYER_LANE.authorizationSeconds || !requirement.extra
    || canonical(requirement.extra) !== canonical({ name: BUYER_LANE.domainName, version: BUYER_LANE.domainVersion })) throw new BrainchainPurchaseError('quote_refused');
  const resource = challenge.data.resource;
  return Object.freeze({ resource, requirement, hash: buyerDigest({ resource, requirement }), expiresAtMs: now + requirement.maxTimeoutSeconds * 1000 });
}
export interface BuyerTerms {
  orderId: string; avatarId: string; payer: string; bodyHash: string; quoteHash: string; intentNonce: Hex; paymentNonce: Hex;
  validAfter: string; validBefore: string;
}
export function createBuyerTerms(input: Omit<BuyerTerms,'intentNonce'|'paymentNonce'|'validAfter'|'validBefore'>, quote: BuyerQuote, now = Date.now()): BuyerTerms {
  const seconds = Math.floor(now/1000);
  return Object.freeze({ ...input, intentNonce: `0x${randomBytes(32).toString('hex')}`, paymentNonce: `0x${randomBytes(32).toString('hex')}`,
    validAfter: String(seconds-1), validBefore: String(Math.min(seconds+Math.min(quote.requirement.maxTimeoutSeconds, BUYER_LANE.authorizationSeconds), Math.floor(quote.expiresAtMs/1000))) });
}
export function buyerTypedData(terms: BuyerTerms) {
  return {
    intent: { domain: { name: 'ClawVille BrainChain Purchase', version: '1', chainId: BUYER_LANE.chainId, salt: `0x${buyerDigest(BUYER_LANE.endpoint)}` as Hex }, primaryType: 'PurchaseIntent' as const,
      types: { PurchaseIntent: [ {name:'order',type:'bytes32'}, {name:'avatar',type:'bytes32'}, {name:'bodyHash',type:'bytes32'}, {name:'quoteHash',type:'bytes32'},
        {name:'endpointHash',type:'bytes32'}, {name:'token',type:'address'}, {name:'recipient',type:'address'}, {name:'payer',type:'address'}, {name:'amount',type:'uint256'},
        {name:'permanentAvatarBinding',type:'bool'}, {name:'paymentNonce',type:'bytes32'}, {name:'intentNonce',type:'bytes32'}, {name:'validBefore',type:'uint256'} ] },
      message: { order: `0x${buyerDigest(terms.orderId)}` as Hex, avatar: `0x${buyerDigest(terms.avatarId)}` as Hex,
        bodyHash: `0x${terms.bodyHash}` as Hex, quoteHash: `0x${terms.quoteHash}` as Hex, endpointHash: `0x${buyerDigest(BUYER_LANE.endpoint)}` as Hex,
        token: BUYER_LANE.token as Address, recipient: BUYER_LANE.recipient as Address, payer: terms.payer as Address, amount: BUYER_LANE.amountAtomic,
        permanentAvatarBinding: true, paymentNonce: terms.paymentNonce, intentNonce: terms.intentNonce, validBefore: terms.validBefore } },
    payment: { domain: { name: BUYER_LANE.domainName, version: BUYER_LANE.domainVersion, chainId: BUYER_LANE.chainId, verifyingContract: BUYER_LANE.token as Address },
      primaryType: 'TransferWithAuthorization' as const, types: { TransferWithAuthorization: [{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
        {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}] },
      message: { from: terms.payer as Address, to: BUYER_LANE.recipient as Address, value: BUYER_LANE.amountAtomic,
        validAfter: terms.validAfter, validBefore: terms.validBefore, nonce: terms.paymentNonce } },
  };
}
export async function verifyBuyerSignatures(terms: BuyerTerms, intentSignature: string, paymentSignature: string): Promise<void> {
  buyerSignature.parse(intentSignature); buyerSignature.parse(paymentSignature);
  const typed = buyerTypedData(terms);
  try {
    const intent = await recoverTypedDataAddress({ ...typed.intent, signature: intentSignature as Hex });
    const payment = await recoverTypedDataAddress({ ...typed.payment, signature: paymentSignature as Hex });
    if (intent.toLowerCase() !== terms.payer || payment.toLowerCase() !== terms.payer) throw new Error('mismatch');
  } catch { throw new BrainchainPurchaseError('invalid_proof'); }
}
export function buyerPaymentHeader(terms: BuyerTerms, quote: BuyerQuote, signature: string): string {
  const payload = { x402Version: 2, resource: quote.resource, accepted: quote.requirement,
    payload: { signature, authorization: buyerTypedData(terms).payment.message } };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
export function buyerHumanApprovalMessage(terms: BuyerTerms, body: BuyerTaskBody, nonce: string): string {
  return ['ClawVille BrainChain test purchase',`avatar: ${terms.avatarId}`,`order: ${terms.orderId}`,`title: ${body.title}`,
    `task hash: ${terms.bodyHash}`,`quote hash: ${terms.quoteHash}`,`payer: ${terms.payer}`,`network: ${BUYER_LANE.network}`,`token: ${BUYER_LANE.token}`,
    `recipient: ${BUYER_LANE.recipient}`,`amount: ${BUYER_LANE.amountAtomic} test USDC atomic units`,`expires: ${terms.validBefore}`,`nonce: ${nonce}`].join('\n');
}
