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
 *   - The seller's `extra.feePayer` becomes the transaction fee payer. It must
 *     be a valid public key that is NOT our wallet, or our wallet pays fees.
 *   - The caps come from the human's spend rules and the ledger, checked under
 *     the same per-avatar advisory lock as spend-rule writes. The ledger row is
 *     written BEFORE the wallet signs, and our wallet's own signature on the
 *     transaction is stored BEFORE the paid request is sent, so
 *     `scripts/vendors/vendor-ledger-reconcile.ts` can find the transaction on
 *     chain later. After the paid request is sent, only a 2xx with valid
 *     settlement evidence is 'paid'; every other outcome is 'ambiguous' (a 402
 *     does not prove that nothing settled). Ambiguous rows are never retried
 *     automatically and count toward the daily cap.
 *   - The decrypted key lives only for the signing step and is wiped after.
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
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
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
/** Largest seller reply we read (an image as base64 is at most 8 MB). */
const MAX_REPLY_BYTES = 12 * 1024 * 1024;

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
  | 'payment_ambiguous';

export type VendorCallResult =
  | {
    ok: true;
    ledgerId: string;
    usdcAtomic: string;
    usdCents: number;
    /** Null when the seller sent no valid settlement evidence (the ledger row is then 'ambiguous'). */
    txSignature: string | null;
    responseJson: unknown;
  }
  | { ok: false; code: VendorCallFailure; ledgerId?: string; httpStatus?: number };

export interface SigningKey {
  publicKey: string;
  secretKey: Uint8Array;
  /** Zero every copy of the decrypted key. */
  wipe: () => void;
}

export interface SignedPayment {
  header: string;
  /** Our wallet's own signature on the transaction (base58). */
  payerSignature: string;
}

export interface OutboundDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Public key of the avatar wallet. No decrypt. */
  loadWalletPubkey: (avatarId: string) => Promise<string | null>;
  /** Decrypt the avatar wallet for ONE signing step. */
  loadSigningKey: (avatarId: string) => Promise<SigningKey | null>;
  signPayment: (input: {
    paymentRequired: PaymentRequired;
    requirement: PaymentRequirements;
    secretKey: Uint8Array;
    publicKey: string;
  }) => Promise<SignedPayment>;
}

/** True for a base58 string that decodes to exactly `bytes` bytes. */
export function isBase58Of(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 100) return false;
  try {
    return bs58.decode(value).length === bytes;
  } catch {
    return false;
  }
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

export function checkQuote(requirement: PaymentRequirements, pin: VendorPin, payerWallet: string): QuoteCheck {
  if (!/^[1-9]\d{0,18}$/.test(String(requirement.amount))) return { ok: false, code: 'vendor_quote_invalid' };
  const amount = BigInt(requirement.amount);
  if (amount > pin.maxCallAtomic) return { ok: false, code: 'vendor_quote_invalid' };
  if (!pin.payTo.includes(requirement.payTo)) return { ok: false, code: 'vendor_pay_to_changed' };
  const feePayer = (requirement.extra as { feePayer?: unknown } | undefined)?.feePayer;
  // The fee payer pays the network fee. It must never be our own wallet.
  if (!isBase58Of(feePayer, 32) || feePayer === payerWallet) return { ok: false, code: 'vendor_quote_invalid' };
  return { ok: true, amount };
}

/** Our wallet's signature inside a signed x402 SVM payload (base58). */
export function payerSignatureFromPayload(transactionBase64: string, payerPubkey: string): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  const index = keys.indexOf(payerPubkey);
  if (index < 0 || index >= tx.message.header.numRequiredSignatures) throw new Error('payer is not a signer of the payment');
  const signature = tx.signatures[index];
  if (!signature || signature.every((byte) => byte === 0)) throw new Error('payer signature missing');
  return bs58.encode(signature);
}

/** Sign the seller's entry exactly as quoted. Nothing is sent here. */
export async function signThirdPartyExactPayment(input: {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  secretKey: Uint8Array;
  publicKey: string;
  rpcUrl: string;
}): Promise<SignedPayment> {
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
  const transaction = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof transaction !== 'string') throw new Error('payment payload has no transaction');
  return {
    header: encodePaymentSignatureHeader(payload),
    payerSignature: payerSignatureFromPayload(transaction, input.publicKey),
  };
}

function defaultDeps(): OutboundDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    loadWalletPubkey: async (avatarId) => {
      const row = await db.query.wallets.findFirst({
        where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
        columns: { publicKey: true },
      });
      return row?.publicKey ?? null;
    },
    loadSigningKey: async (avatarId) => {
      const row = await db.query.wallets.findFirst({
        where: and(eq(wallets.subjectType, 'avatar'), eq(wallets.subjectId, avatarId)),
      });
      if (!row) return null;
      const keypair = await decryptWalletRow(row);
      // web3.js returns a COPY from the secretKey getter; wipe the original too.
      const original = (keypair as unknown as { _keypair?: { secretKey?: Uint8Array } })._keypair?.secretKey;
      const secretKey = keypair.secretKey;
      const wipe = () => {
        secretKey.fill(0);
        original?.fill(0);
      };
      if (keypair.publicKey.toBase58() !== row.publicKey) {
        wipe();
        throw new Error('custodial wallet pubkey mismatch');
      }
      return { publicKey: row.publicKey, secretKey, wipe };
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

/** Settlement evidence: success flag and a VALID Solana transaction signature, or nulls. */
function readSettlement(res: Response): { success: boolean; transaction: string | null } {
  const header = res.headers.get('PAYMENT-RESPONSE');
  if (!header) return { success: false, transaction: null };
  try {
    const settle = decodePaymentResponseHeader(header);
    return {
      success: settle.success === true,
      transaction: isBase58Of(settle.transaction, 64) ? settle.transaction : null,
    };
  } catch {
    return { success: false, transaction: null };
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

/**
 * Final status of a pending row. A failed write leaves the row 'pending',
 * which still counts toward the cap; the reconcile script resolves it.
 */
async function finish(
  ledgerId: string,
  status: 'paid' | 'failed' | 'ambiguous',
  fields: { txSignature?: string | null; failureReason?: string | null },
): Promise<void> {
  try {
    await db
      .update(vendorSpendLedger)
      .set({
        status,
        txSignature: fields.txSignature ?? null,
        failureReason: fields.failureReason ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(vendorSpendLedger.id, ledgerId), inArray(vendorSpendLedger.status, ['pending'])));
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '23505' && fields.txSignature) {
      // The seller repeated a transaction id that another row already holds.
      // Do not trust it: keep the money counted as 'ambiguous' for reconcile.
      try {
        await db
          .update(vendorSpendLedger)
          .set({
            status: 'ambiguous',
            txSignature: null,
            failureReason: `duplicate_tx_from_seller:${fields.txSignature}`,
            updatedAt: new Date(),
          })
          .where(and(eq(vendorSpendLedger.id, ledgerId), inArray(vendorSpendLedger.status, ['pending'])));
        return;
      } catch {
        // fall through to the log below
      }
    }
    console.error(`[outbound-x402] ledger ${ledgerId} final update failed; row stays pending:`, err instanceof Error ? err.message : 'unknown');
  }
}

/** Read a JSON reply up to MAX_REPLY_BYTES; null when larger or not JSON. */
export async function readJsonCapped(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_REPLY_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
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

  // 2) Wallet public key (no decrypt), quote checks, then admission (caps +
  //    ledger row) BEFORE any key is decrypted.
  let payerWallet: string | null;
  try {
    payerWallet = await deps.loadWalletPubkey(input.avatarId);
  } catch {
    payerWallet = null;
  }
  if (!payerWallet) return { ok: false, code: 'wallet_missing' };
  const quote = checkQuote(requirement, input.pin, payerWallet);
  if (!quote.ok) return { ok: false, code: quote.code };
  const admission = await admit(input, requirement, quote.amount, payerWallet);
  if (!admission.ok) return admission;

  // 3) Decrypt for this step only, sign the quote as given, wipe. Nothing is
  //    on the wire if this fails.
  let signed: SignedPayment;
  let key: SigningKey | null = null;
  try {
    key = await deps.loadSigningKey(input.avatarId);
    if (!key || key.publicKey !== payerWallet) throw new Error('signing wallet changed');
    signed = await deps.signPayment({
      paymentRequired,
      requirement,
      secretKey: key.secretKey,
      publicKey: key.publicKey,
    });
    if (!isBase58Of(signed.payerSignature, 64)) throw new Error('payer signature missing');
  } catch {
    await finish(admission.ledgerId, 'failed', { failureReason: 'prepare_failed' });
    return { ok: false, code: 'payment_prepare_failed', ledgerId: admission.ledgerId };
  } finally {
    key?.wipe();
  }

  // 4) Store our signature BEFORE sending, so the transaction can be found on
  //    chain later. If this write fails, nothing is sent.
  try {
    await db
      .update(vendorSpendLedger)
      .set({ payerSignature: signed.payerSignature, signedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(vendorSpendLedger.id, admission.ledgerId), eq(vendorSpendLedger.status, 'pending')));
  } catch {
    await finish(admission.ledgerId, 'failed', { failureReason: 'not_sent_ledger_write_failed' });
    return { ok: false, code: 'payment_prepare_failed', ledgerId: admission.ledgerId };
  }

  // 5) Paid request. From here on the payment may have settled.
  let paidRes: Response;
  try {
    paidRes = await postJson(deps.fetch, input.url, input.body, PAID_CALL_TIMEOUT_MS, { 'PAYMENT-SIGNATURE': signed.header });
  } catch {
    await finish(admission.ledgerId, 'ambiguous', { failureReason: 'no_response_after_payment' });
    console.warn(`[outbound-x402] ${input.pin.vendor} ${input.tool}: no response after payment; ledger ${admission.ledgerId} ambiguous`);
    return { ok: false, code: 'payment_ambiguous', ledgerId: admission.ledgerId };
  }
  const settlement = readSettlement(paidRes);

  if (paidRes.ok) {
    let json: unknown = null;
    try {
      json = await readJsonCapped(paidRes);
    } catch {
      json = null;
    }
    const proven = settlement.success && settlement.transaction !== null;
    await finish(admission.ledgerId, proven ? 'paid' : 'ambiguous', {
      txSignature: settlement.transaction,
      failureReason: proven ? null : 'no_valid_settlement_evidence',
    });
    return {
      ok: true,
      ledgerId: admission.ledgerId,
      usdcAtomic: quote.amount.toString(),
      usdCents: admission.usdCents,
      txSignature: proven ? settlement.transaction : null,
      responseJson: json,
    };
  }

  // Any non-2xx after sending (a 402 included) does not prove that nothing
  // settled: keep the reservation as 'ambiguous' for the reconcile script.
  await paidRes.body?.cancel().catch(() => {});
  await finish(admission.ledgerId, 'ambiguous', {
    txSignature: settlement.transaction,
    failureReason: `http_${paidRes.status}_after_payment`,
  });
  console.warn(`[outbound-x402] ${input.pin.vendor} ${input.tool}: HTTP ${paidRes.status} after payment; ledger ${admission.ledgerId} ambiguous`);
  return { ok: false, code: 'payment_ambiguous', ledgerId: admission.ledgerId, httpStatus: paidRes.status };
}
