/**
 * The paid SAID trust screen (MCP hub, 2026-11-07). The avatar wallet pays
 * through `callVendorWithAvatarWallet`, inside the human's spend rules.
 *
 * - The human must set the caps and allow `said`. A preflight refuses before any
 *   quote; the shared admission checks the same rules again under the lock.
 * - "Ask me before each payment" on: refused before any quote or spend
 *   (`approval_not_supported_for_said`). The approval pipeline is Studios only.
 *   The fence reads the setting again under the spend-rules lock, and again just
 *   before the send, so turning it on during a call stops that call.
 * - payTo and the maximum price are pinned. An ambiguous outcome is never
 *   retried; the Idempotency-Key cannot pay twice (`duplicate_request`).
 *
 * The reply shape is documented but NOT verified by a paid call yet. SAID text
 * is untrusted (its docs once carried a prompt injection), so only the verdict
 * enum and finite numbers are read. Anything else is `screen_unreadable`, and the
 * ledger still records the spend.
 */

import { db, eq, userSpendPolicies } from '@clawville/database';
import {
  SAID_SCREEN_AXES,
  SAID_SCREEN_VERDICTS,
  type SaidScreenAxes,
  type SaidScreenAxis,
  type SaidScreenReply,
  type SaidScreenVerdict,
  type SpendPolicyView,
} from '@clawville/shared';
import { finiteOrNull, SAID_API_ORIGIN } from '../ecosystem-reads';
import {
  callVendorWithAvatarWallet,
  isBase58Of,
  type LedgerTx,
  type OutboundDeps,
  type VendorCallFailure,
  type VendorPin,
} from '../outbound-x402';
import { lockSpendRules, readSpendPolicy } from '../spend-policy';

/** The Solana wallet SAID's live quote named on 2026-11-07. */
export const SAID_PAY_TO: readonly string[] = ['3Q6QAbCWmqJfXthcXxsxpj2SXvDcmDsJJsevwMgC8BrU'];
/** $0.05. The live quote is $0.01; a higher quote is refused before any payment. */
export const SAID_SCREEN_MAX_CALL_ATOMIC = 50_000n;
const SAID_PIN: VendorPin = { vendor: 'said', payTo: SAID_PAY_TO, maxCallAtomic: SAID_SCREEN_MAX_CALL_ATOMIC };
const SAID_PAID_TIMEOUT_MS = 30_000;
const SAID_REPLY_MAX_BYTES = 64 * 1024;

export type SaidScreenFailureCode = Exclude<VendorCallFailure, 'payment_fenced'> | 'invalid_request' | 'approval_not_supported_for_said';

export interface SaidScreenFailure {
  ok: false;
  code: SaidScreenFailureCode;
  httpStatus: 400 | 402 | 403 | 409 | 502;
  message: string;
  ledgerId?: string;
}

const FAILURES: { [K in SaidScreenFailureCode]: Pick<SaidScreenFailure, 'httpStatus' | 'message'> } = {
  invalid_request: { httpStatus: 400, message: 'wallet must be a Solana wallet address. Nothing was paid.' },
  approval_not_supported_for_said: {
    httpStatus: 403,
    message: 'The paid SAID screen does not work while your human has "Ask me before each payment" on. Nothing was paid. The free trust check still works.',
  },
  duplicate_request: { httpStatus: 409, message: 'This Idempotency-Key was already used. Nothing new was paid. ClawVille does not store screen results, so use a new key only for a new screen.' },
  vendor_unreachable: { httpStatus: 502, message: 'SAID did not answer. Nothing was paid. Try again later.' },
  vendor_refused: { httpStatus: 502, message: 'SAID refused the request before payment. Nothing was paid.' },
  vendor_quote_invalid: { httpStatus: 502, message: 'SAID sent a price ClawVille cannot accept. Nothing was paid.' },
  vendor_pay_to_changed: { httpStatus: 502, message: 'SAID asked to be paid at an unknown wallet. Nothing was paid.' },
  spend_rules_not_set: { httpStatus: 403, message: 'Spend caps are not set. Ask your human to set them in the wallet panel (Spending). Nothing was paid.' },
  vendor_not_allowed: { httpStatus: 403, message: 'SAID is not an allowed paid tool. Ask your human to allow it in the wallet panel (Spending). Nothing was paid.' },
  over_per_call_cap: { httpStatus: 402, message: 'This call costs more than the per-call cap. Nothing was paid.' },
  over_daily_cap: { httpStatus: 402, message: 'This call would pass the daily cap. Nothing was paid.' },
  wallet_missing: { httpStatus: 403, message: 'This avatar has no wallet. Nothing was paid.' },
  payment_prepare_failed: { httpStatus: 502, message: 'The payment could not be signed. Nothing was paid. Try again later.' },
  payment_ambiguous: { httpStatus: 502, message: 'SAID did not confirm the result. The payment may have gone through, and it counts toward the daily cap. Do not retry.' },
};

function fail(code: SaidScreenFailureCode, ledgerId?: string): SaidScreenFailure {
  return { ok: false, code, ...FAILURES[code], ...(ledgerId ? { ledgerId } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A number, or an object with a numeric `score`. */
function axisValue(value: unknown): number | null {
  return finiteOrNull(asRecord(value)?.score ?? value);
}

/**
 * Only the verdict enum and finite numbers. `null` means unreadable: no known
 * verdict, or a reply for another wallet.
 */
export function parseSaidScreen(body: unknown, wallet: string): { verdict: SaidScreenVerdict; axes: SaidScreenAxes; eigentrust: number | null } | null {
  const root = asRecord(body);
  if (!root) return null;
  const inner = asRecord(root.data) ?? asRecord(root.result) ?? asRecord(root.screen);
  const scope = typeof root.verdict === 'string' ? root : inner;
  if (!scope || typeof scope.verdict !== 'string') return null;
  const verdict = SAID_SCREEN_VERDICTS.find((name) => name === (scope.verdict as string).trim().toLowerCase());
  if (!verdict) return null;
  const replyWallet = scope.wallet ?? root.wallet;
  if (replyWallet !== undefined && replyWallet !== wallet) return null;
  const source = asRecord(scope.axes) ?? asRecord(scope.reputation) ?? asRecord(scope.scores) ?? scope;
  const axes = Object.fromEntries(
    SAID_SCREEN_AXES.map((axis): [SaidScreenAxis, number | null] => [axis, axisValue(source[axis])]),
  ) as SaidScreenAxes;
  const eigentrust = [source, scope].map((row) => axisValue(row.eigentrust ?? row.eigenTrust)).find((value) => value !== null) ?? null;
  return { verdict, axes, eigentrust };
}

export interface SaidScreenDeps {
  readPolicy: (avatarId: string) => Promise<SpendPolicyView>;
  call: typeof callVendorWithAvatarWallet;
  outbound?: Partial<OutboundDeps>;
}

/**
 * Reads "Ask me before each payment" under the spend-rules lock, inside the
 * caller's transaction, so a change of the setting cannot pass this read while
 * it runs. True = the call may go on. The admission path already holds the lock;
 * it is re-entrant inside one transaction, and the final check before the send
 * needs it.
 */
export async function approvalStillOff(avatarId: string, tx: LedgerTx): Promise<boolean> {
  await lockSpendRules(tx, avatarId);
  const [row] = await tx
    .select({ requireApproval: userSpendPolicies.requireApproval })
    .from(userSpendPolicies)
    .where(eq(userSpendPolicies.avatarId, avatarId))
    .limit(1);
  return row?.requireApproval !== true;
}

export type SaidScreenResult = { ok: true; reply: SaidScreenReply } | SaidScreenFailure;

export async function screenSaidWallet(
  input: { avatarId: string; actor: 'human' | 'agent'; wallet: string; idempotencyKey: string },
  overrides?: Partial<SaidScreenDeps>,
): Promise<SaidScreenResult> {
  const deps: SaidScreenDeps = { readPolicy: readSpendPolicy, call: callVendorWithAvatarWallet, ...overrides };
  const wallet = input.wallet.trim();
  if (!isBase58Of(wallet, 32)) return fail('invalid_request');

  const policy = await deps.readPolicy(input.avatarId);
  if (policy.requireApproval) return fail('approval_not_supported_for_said');
  if (!policy.configured) return fail('spend_rules_not_set');
  if (!policy.allowedVendors.includes('said')) return fail('vendor_not_allowed');

  const paid = await deps.call({
    avatarId: input.avatarId,
    actor: input.actor,
    pin: SAID_PIN,
    tool: 'screen',
    idempotencyKey: input.idempotencyKey,
    method: 'GET',
    url: `${SAID_API_ORIGIN}/api/screen?${new URLSearchParams({ wallet })}`,
    paidTimeoutMs: SAID_PAID_TIMEOUT_MS,
    replyMaxBytes: SAID_REPLY_MAX_BYTES,
    fence: (tx) => approvalStillOff(input.avatarId, tx),
  }, deps.outbound);

  if (!paid.ok) {
    // The only fence here is the approval setting: it turned on during this call.
    if (paid.code === 'payment_fenced') return fail('approval_not_supported_for_said', paid.ledgerId);
    return fail(paid.code, paid.ledgerId);
  }

  const payment = { ledgerId: paid.ledgerId, usdCents: paid.usdCents, txSignature: paid.txSignature };
  const parsed = parseSaidScreen(paid.responseJson, wallet);
  if (!parsed) {
    return {
      ok: true,
      reply: { status: 'screen_unreadable', vendor: 'said', wallet, verdict: null, axes: null, eigentrust: null, payment },
    };
  }
  return { ok: true, reply: { status: 'screened', vendor: 'said', wallet, ...parsed, payment } };
}
