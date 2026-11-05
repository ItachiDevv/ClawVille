/**
 * Outbound x402: an avatar wallet pays a THIRD-PARTY seller (MCP hub step 2,
 * phase 2, mode B). First vendor: Studios.
 *
 * Safety rules (brain plan `plans/mcp-hub-step2-studios-user-spend.md` section 4):
 *   - We never settle a third-party payment through our own facilitator. The
 *     signed payload goes to the seller, and the seller settles it.
 *   - We sign the seller's quote entry UNCHANGED (scheme `exact`, Solana
 *     mainnet, USDC), chosen by filter, never by position. `custodial-x402.ts`
 *     `prepareCustodialExactPayment` adds our own fields and must NOT be used
 *     here; keep the two primitives apart.
 *   - The quote's `payTo` must be one of the vendor's pinned wallets.
 *   - The caps come from the human's spend rules and the ledger, checked under
 *     the same per-avatar advisory lock as spend-rule writes. The ledger row is
 *     written BEFORE the wallet signs. An unclear outcome is 'ambiguous' and is
 *     never retried automatically; it still counts toward the daily cap.
 *   - Vendor text is untrusted. We log status codes only, never vendor bodies.
 */

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { and, db, eq, inArray, sql, userSpendPolicies, vendorSpendLedger, wallets } from '@clawville/database';
import type { SpendVendorId } from '@clawville/shared';
import { decryptWalletRow } from './keypair-vault';
import { toSpendPolicyView } from './spend-policy';
import { usdcMintForNetwork } from './x402-payai';
import { prepareWithMainnetRpcFallback, resolveAgentPayRail } from './agent-pay';

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ATOMIC_PER_CENT = 10_000n;
const QUOTE_TIMEOUT_MS = 30_000;
const PAID_CALL_TIMEOUT_MS = 120_000;

export interface VendorPin {
  vendor: SpendVendorId;
  payTo: readonly string[];
  maxCallAtomic: bigint;
}

export interface VendorCallInput {
  avatarId: string;
  actor: 'human' | 'agent';
  pin: VendorPin;
  tool: string;
  idempotencyKey: string;
  url: string;
  body: Record<string, unknown>;
}

export type VendorCallFailure =
  | 'duplicate_request'
  | 'vendor_unreachable'
  | 'vendor_refused'
  | 'vendor_quote_invalid'
  | 'vendor_pay_to_changed'
  | 'spend_rules_not_set'
  | 'vendor_not_allowed'
  | 'over_per_call_cap'
  | 'over_daily_cap'
  | 'wallet_missing'
  | 'payment_prepare_failed'
  | 'payment_refused'
  | 'payment_ambiguous';

export type VendorCallResult =
  | {
    ok: true;
    ledgerId: string;
    usdcAtomic: string;
    usdCents: number;
    txSignature: string | null;
    responseJson: unknown;
  }
  | { ok: false; code: VendorCallFailure; ledgerId?: string; httpStatus?: number };

export interface OutboundDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  loadSigningWallet: (avatarId: string) => Promise<{ publicKey: string; secretKey: Uint8Array } | null>;
  signPayment: (input: {
    paymentRequired: PaymentRequired;
    requirement: PaymentRequirements;
    secretKey: Uint8Array;
    publicKey: string;
  }) => Promise<string>;
}

/** Pick the Solana mainnet USDC `exact` entry. Never by index. */
export function selectSolanaUsdcRequirement(paymentRequired: PaymentRequired): PaymentRequirements | null {
  const mint = usdcMintForNetwork('mainnet');
  const matches = (paymentRequired.accepts ?? []).filter((entry) => entry.scheme === 'exact'
    && entry.network === SOLANA_MAINNET
    && entry.asset === mint);
  return matches.length === 1 ? matches[0]! : null;
}

export type QuoteCheck =
  | { ok: true; amount: bigint }
  | { ok: false; code: 'vendor_quote_invalid' | 'vendor_pay_to_changed' };

export function checkQuote(requirement: PaymentRequirements, pin: VendorPin): QuoteCheck {
  if (!/^[1-9]\d{0,18}$/.test(String(requirement.amount))) return { ok: false, code: 'vendor_quote_invalid' };
  const amount = BigInt(requirement.amount);
  if (amount > pin.maxCallAtomic) return { ok: false, code: 'vendor_quote_invalid' };
  if (!pin.payTo.includes(requirement.payTo)) return { ok: false, code: 'vendor_pay_to_changed' };
  const feePayer = (requirement.extra as { feePayer?: unknown } | undefined)?.feePayer;
  if (typeof feePayer !== 'string' || feePayer.length < 32) return { ok: false, code: 'vendor_quote_invalid' };
  return { ok: true, amount };
}

/** Sign the seller's entry exactly as quoted. Nothing is sent here. */
export async function signThirdPartyExactPayment(input: {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  secretKey: Uint8Array;
  publicKey: string;
  rpcUrl: string;
}): Promise<string> {
  const signer = await createKeyPairSignerFromBytes(input.secretKey);
  if (String(signer.address) !== input.publicKey) throw new Error('outbound x402 signer does not match the wallet');
  const client = new x402Client();
  client.register(SOLANA_MAINNET, new ExactSvmScheme(signer, { rpcUrl: input.rpcUrl }));
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    resource: input.paymentRequired.resource,
    accepts: [input.requirement],
    ...(input.paymentRequired.extensions ? { extensions: input.paymentRequired.extensions } : {}),
  } as PaymentRequired);
  return encodePaymentSignatureHeader(payload);
}

function defaultDeps(): OutboundDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    loadSigningWallet: async (avatarId) => {
      const row = await db.query.wallets.findFirst({
        where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
      });
      if (!row) return null;
      const keypair = await decryptWalletRow(row);
      const publicKey = keypair.publicKey.toBase58();
      if (publicKey !== row.publicKey) throw new Error('custodial wallet pubkey mismatch');
      return { publicKey, secretKey: keypair.secretKey };
    },
    signPayment: async ({ paymentRequired, requirement, secretKey, publicKey }) => {
      // Always mainnet: the vendor quotes Solana mainnet. The rail only picks
      // the RPC host (AGENT_PAY_RPC_URL / SOLANA_MAINNET_RPC_URL / public).
      const rail = resolveAgentPayRail();
      const rpcUrl = rail.network === 'mainnet' && rail.rpcUrl
        ? rail.rpcUrl
        : process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
      return prepareWithMainnetRpcFallback(
        { network: 'mainnet' as const, rpcUrl, paymentRequired, requirement, secretKey, publicKey },
        (input) => signThirdPartyExactPayment(input),
      );
    },
  };
}

async function postJson(
  f: OutboundDeps['fetch'],
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  return f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
}

function readPaymentRequired(res: Response): PaymentRequired | null {
  const header = res.headers.get('PAYMENT-REQUIRED');
  if (!header) return null;
  try {
    return decodePaymentRequiredHeader(header);
  } catch {
    return null;
  }
}

function readSettlement(res: Response): { success: boolean; transaction: string | null } | null {
  const header = res.headers.get('PAYMENT-RESPONSE');
  if (!header) return null;
  try {
    const settle = decodePaymentResponseHeader(header);
    const tx = typeof settle.transaction === 'string' && settle.transaction.length > 0 ? settle.transaction : null;
    return { success: settle.success === true, transaction: tx };
  } catch {
    return null;
  }
}

type Admission =
  | { ok: true; ledgerId: string; usdCents: number }
  | { ok: false; code: VendorCallFailure; ledgerId?: string };

/** Cap check + ledger insert, in one transaction under the spend-rules lock. */
async function admit(input: VendorCallInput, requirement: PaymentRequirements, amount: bigint, payerWallet: string): Promise<Admission> {
  const usdCents = Number((amount + ATOMIC_PER_CENT - 1n) / ATOMIC_PER_CENT);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`spend-policy:${input.avatarId}`}, 0))`);
    const [existing] = await tx
      .select({ id: vendorSpendLedger.id })
      .from(vendorSpendLedger)
      .where(and(eq(vendorSpendLedger.avatarId, input.avatarId), eq(vendorSpendLedger.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (existing) return { ok: false, code: 'duplicate_request', ledgerId: existing.id } as const;

    const [policyRow] = await tx
      .select({
        dailyCapUsdCents: userSpendPolicies.dailyCapUsdCents,
        perCallCapUsdCents: userSpendPolicies.perCallCapUsdCents,
        allowedVendors: userSpendPolicies.allowedVendors,
        updatedAt: userSpendPolicies.updatedAt,
      })
      .from(userSpendPolicies)
      .where(eq(userSpendPolicies.avatarId, input.avatarId))
      .limit(1);
    const policy = toSpendPolicyView(policyRow);
    if (!policy.configured || policy.dailyCapUsdCents === null || policy.perCallCapUsdCents === null) {
      return { ok: false, code: 'spend_rules_not_set' } as const;
    }
    if (!policy.allowedVendors.includes(input.pin.vendor)) return { ok: false, code: 'vendor_not_allowed' } as const;
    if (amount > BigInt(policy.perCallCapUsdCents) * ATOMIC_PER_CENT) return { ok: false, code: 'over_per_call_cap' } as const;

    // Today = the current UTC day. Failed rows moved no money; every other
    // status (pending, paid, ambiguous) counts.
    const spent = await tx.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(usdc_atomic), 0)::text AS total
      FROM vendor_spend_ledger
      WHERE avatar_id = ${input.avatarId}
        AND status IN ('pending', 'paid', 'ambiguous')
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
    const spentToday = BigInt(Array.from(spent)[0]?.total ?? '0');
    if (spentToday + amount > BigInt(policy.dailyCapUsdCents) * ATOMIC_PER_CENT) {
      return { ok: false, code: 'over_daily_cap' } as const;
    }

    const [row] = await tx
      .insert(vendorSpendLedger)
      .values({
        avatarId: input.avatarId,
        vendor: input.pin.vendor,
        tool: input.tool,
        actor: input.actor,
        status: 'pending',
        usdcAtomic: amount.toString(),
        usdCents,
        payTo: requirement.payTo,
        payerWallet,
        network: SOLANA_MAINNET,
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: vendorSpendLedger.id });
    return { ok: true, ledgerId: row!.id, usdCents } as const;
  });
}

async function finish(
  ledgerId: string,
  status: 'paid' | 'failed' | 'ambiguous',
  fields: { txSignature?: string | null; failureReason?: string | null },
): Promise<void> {
  await db
    .update(vendorSpendLedger)
    .set({
      status,
      txSignature: fields.txSignature ?? null,
      failureReason: fields.failureReason ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(vendorSpendLedger.id, ledgerId), inArray(vendorSpendLedger.status, ['pending'])));
}

/**
 * One paid vendor call: quote, admit under the caps, sign the quote, send.
 * Returns the vendor's JSON only on a paid 2xx; callers must parse it
 * strictly and return only the fields they need.
 */
export async function callVendorWithAvatarWallet(
  input: VendorCallInput,
  depsOverride?: Partial<OutboundDeps>,
): Promise<VendorCallResult> {
  const deps = { ...defaultDeps(), ...depsOverride };

  // 1) Unpaid request: the seller answers 402 with its quote.
  let quoteRes: Response;
  try {
    quoteRes = await postJson(deps.fetch, input.url, input.body, QUOTE_TIMEOUT_MS);
  } catch {
    return { ok: false, code: 'vendor_unreachable' };
  }
  if (quoteRes.status !== 402) {
    await quoteRes.body?.cancel().catch(() => {});
    return { ok: false, code: 'vendor_refused', httpStatus: quoteRes.status };
  }
  const paymentRequired = readPaymentRequired(quoteRes);
  await quoteRes.body?.cancel().catch(() => {});
  const requirement = paymentRequired ? selectSolanaUsdcRequirement(paymentRequired) : null;
  if (!paymentRequired || !requirement) return { ok: false, code: 'vendor_quote_invalid' };
  const quote = checkQuote(requirement, input.pin);
  if (!quote.ok) return { ok: false, code: quote.code };

  // 2) Wallet, then admission (caps + ledger row) BEFORE signing.
  let wallet: { publicKey: string; secretKey: Uint8Array } | null;
  try {
    wallet = await deps.loadSigningWallet(input.avatarId);
  } catch {
    wallet = null;
  }
  if (!wallet) return { ok: false, code: 'wallet_missing' };
  const admission = await admit(input, requirement, quote.amount, wallet.publicKey);
  if (!admission.ok) return admission;

  // 3) Sign the quote as given. Nothing is on the wire if this fails.
  let paymentHeader: string;
  try {
    paymentHeader = await deps.signPayment({
      paymentRequired,
      requirement,
      secretKey: wallet.secretKey,
      publicKey: wallet.publicKey,
    });
  } catch {
    await finish(admission.ledgerId, 'failed', { failureReason: 'prepare_failed' });
    return { ok: false, code: 'payment_prepare_failed', ledgerId: admission.ledgerId };
  } finally {
    wallet.secretKey.fill(0);
  }

  // 4) Paid request. From here on the payment may have settled.
  let paidRes: Response;
  try {
    paidRes = await postJson(deps.fetch, input.url, input.body, PAID_CALL_TIMEOUT_MS, { 'PAYMENT-SIGNATURE': paymentHeader });
  } catch {
    await finish(admission.ledgerId, 'ambiguous', { failureReason: 'no_response_after_payment' });
    console.warn(`[outbound-x402] ${input.pin.vendor} ${input.tool}: no response after payment; ledger ${admission.ledgerId} ambiguous`);
    return { ok: false, code: 'payment_ambiguous', ledgerId: admission.ledgerId };
  }
  const settlement = readSettlement(paidRes);

  if (paidRes.ok) {
    let json: unknown = null;
    try {
      json = await paidRes.json();
    } catch {
      json = null;
    }
    await finish(admission.ledgerId, 'paid', {
      txSignature: settlement?.transaction ?? null,
      failureReason: settlement ? null : 'no_settlement_header',
    });
    return {
      ok: true,
      ledgerId: admission.ledgerId,
      usdcAtomic: quote.amount.toString(),
      usdCents: admission.usdCents,
      txSignature: settlement?.transaction ?? null,
      responseJson: json,
    };
  }

  await paidRes.body?.cancel().catch(() => {});
  if (paidRes.status === 402 && !settlement?.transaction) {
    await finish(admission.ledgerId, 'failed', { failureReason: 'vendor_refused_payment' });
    return { ok: false, code: 'payment_refused', ledgerId: admission.ledgerId, httpStatus: 402 };
  }
  await finish(admission.ledgerId, 'ambiguous', {
    txSignature: settlement?.transaction ?? null,
    failureReason: `http_${paidRes.status}_after_payment`,
  });
  console.warn(`[outbound-x402] ${input.pin.vendor} ${input.tool}: HTTP ${paidRes.status} after payment; ledger ${admission.ledgerId} ambiguous`);
  return { ok: false, code: 'payment_ambiguous', ledgerId: admission.ledgerId, httpStatus: paidRes.status };
}
