// FEATURE_GATE: wallet_withdraw
// Status: DARK — the write path (`POST /withdraw`) refuses with a typed 503
//   `withdraw_disabled` unless `WALLET_WITHDRAW_ENABLED === 'true'` (default
//   OFF; the executor re-asserts the gate + a mainnet network guard). The
//   read path (`GET /balances`) is live regardless — it only READS balances.
// Metric to graduate: legal review of the custody model (wallet-service.ts /
//   wallets.ts carry an explicit "no meaningful on-chain value until legal
//   review" caveat — withdraw is exactly the flow that caveat anticipates),
//   PLUS the review chain (token-economy manager → adversarial money auditor
//   → Codex) clearing the flag flip, PLUS one staging smoke of each asset
//   (SOL/USDC/CLV) against a funded custodial wallet.
// Current reading: 0 withdrawals (gate has never been opened).
// Review deadline: 2026-08-08.
// On deadline: if go-live is not scheduled, stays dark or is deleted — never
//   rots half-reviewed.
// Reference: CLAUDE.md kill-the-build invariants; wallets.ts custody JSDoc;
//   services/wallet-withdraw-executor.ts header.

/**
 * CUSTODIAL WALLET WITHDRAW routes (2026-07-08, DARK behind
 * `WALLET_WITHDRAW_ENABLED`).
 *
 *   POST /api/wallet/withdraw — move the caller's OWN deposited on-chain
 *        SOL/USDC/CLV out of their custodial avatar wallet to a self-custody
 *        destination. REQUIRES an `Idempotency-Key` header — the
 *        (subject, key) UNIQUE makes any retry replay the existing row's
 *        state, never a second withdrawal. NO daily caps (removed 2026-07-09).
 *        CLV ONLY: a withdrawal that would drop the custodial CLV below the
 *        avatar's stacked agent-subject LAND-HOLD requirement refuses 409
 *        `hold_at_risk` (+ `holdAtRisk` payload) unless the body carries
 *        `acknowledgeHoldLoss: true` — informed consent, not enforcement (the
 *        land rent sweeper owns enforcement). The refusal is PRE-ROW, so the
 *        acknowledged retry reuses the same Idempotency-Key cleanly.
 *        USDC Tier-1 bounty holds instead back an active payment promise: a
 *        withdrawal that would break one refuses pre-row with
 *        `bounty_hold_active`. No acknowledgement can override it, and an
 *        admission-query failure refuses the withdrawal.
 *   GET  /api/wallet/balances — the caller's custodial-wallet SOL+USDC+CLV
 *        balances (atomic + ui). Read-only; available regardless of the flag.
 *
 * PARITY (Rule E5): both routes run `requireAuthOrAgentSession` (+
 * `requireNonGuestIdentity` on the write) — a logged-in human (Lucia cookie)
 * AND a connected/hosted agent (`X-Clawville-Agent-Session` → its bound
 * avatar) withdraw AS THEMSELVES from THEIR OWN avatar's custodial wallet
 * (`identity.avatarId`, never body-supplied). Non-ledger agent sessions
 * (ownership unproven) are 403'd — the cove/checkout/market real-money
 * convention. Guests are 403'd (demo economy). NO KYC.
 *
 * LEDGER-UNTOUCHED: nothing here (or in the executor) imports
 * `claw-token-ledger` or writes `avatars.clawTokens` — this moves ON-CHAIN
 * custody assets, NOT internal vCLAW. A withdrawal is NOT a cash-out.
 *
 * CUSTODY: the executor signs SERVER-SIDE with the avatar's custodial keypair
 * (defense-in-depth pubkey verification; key bytes never logged/echoed/
 * returned). The "secretKey returned exactly once" doctrine is untouched.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import {
  requestWithdrawal,
  getCustodialWalletBalances,
  resolveWithdrawSubject,
  WITHDRAW_ASSETS,
  type WithdrawResult,
} from '../services/wallet-withdraw-executor';

export const walletWithdrawRoutes = new Hono<ActivityAuthContext>();

// Populate `c.get('user')` from the Lucia cookie BEFORE requireAuthOrAgentSession
// (it reads `c.get('user')` for the human path). Mirrors market/x402-checkout.
walletWithdrawRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// POST /withdraw — the money write (Idempotency-Key REQUIRED)
// ---------------------------------------------------------------------------

const withdrawSchema = z
  .object({
    asset: z.enum(WITHDRAW_ASSETS),
    /** On-chain base units as an exact integer string (lamports / µUSDC / CLV atomic). */
    amountAtomic: z.string().regex(/^\d{1,20}$/),
    /** Base58 destination pubkey (executor re-validates: 32 bytes, ON-CURVE, non-self). */
    destination: z.string().min(32).max(44),
    /** CLV land-hold consent only. It never overrides a USDC bounty hold. */
    acknowledgeHoldLoss: z.boolean().optional(),
  })
  .strict();

/** 8–64 chars of [A-Za-z0-9_-] — enough entropy to be a real client key, short
 *  enough for the varchar(64) column. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Map an executor refusal to its HTTP status (documented in the API contract). */
function errorStatus(code: Extract<WithdrawResult, { ok: false }>['code']): 400 | 403 | 404 | 409 | 500 | 502 | 503 {
  switch (code) {
    case 'withdraw_disabled':
      return 503;
    case 'amount_invalid':
    case 'invalid_destination':
    case 'self_send':
    case 'insufficient_balance':
    case 'insufficient_sol_for_fee':
      return 400;
    case 'wallet_missing':
    case 'withdrawal_not_found':
      return 404;
    case 'withdrawal_in_flight':
    case 'capture_lost':
    case 'not_resumable':
    case 'idempotency_conflict':
    // CLV consent gate: retry with `acknowledgeHoldLoss: true` (same key —
    // no row was created) to proceed. Body carries the `holdAtRisk` payload.
    case 'hold_at_risk':
    case 'bounty_hold_active':
      return 409;
    case 'balance_unavailable':
    case 'transient_failure':
    case 'resume_transient':
    case 'released_for_retry':
      return 503;
    case 'tx_failed':
    case 'send_ambiguous':
      return 502;
    case 'withdrawal_failed':
    case 'withdrawal_reconcile':
      return 409;
    case 'custody_failed':
      return 500;
    default:
      return 500;
  }
}

walletWithdrawRoutes.post(
  '/withdraw',
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  async (c) => {
    // E5 subject — the caller's OWN avatar; non-ledger agent sessions refused.
    const resolved = resolveWithdrawSubject(c.get('identity'));
    if ('error' in resolved) {
      return c.json({ error: resolved.error, code: resolved.error }, 403);
    }

    // Idempotency-Key header is REQUIRED — the exactly-once retry contract.
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return c.json({ error: 'idempotency_key_required', code: 'idempotency_key_required' }, 400);
    }
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return c.json({ error: 'idempotency_key_invalid', code: 'idempotency_key_invalid' }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json_body', code: 'invalid_json' }, 400);
    }
    const parsed = withdrawSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', code: 'invalid_request', details: parsed.error.flatten() },
        400,
      );
    }

    const result = await requestWithdrawal({
      subject: resolved.subject,
      asset: parsed.data.asset,
      amountAtomic: parsed.data.amountAtomic,
      destination: parsed.data.destination,
      idempotencyKey,
      acknowledgeHoldLoss: parsed.data.acknowledgeHoldLoss,
    });

    if (!result.ok) {
      return c.json(
        {
          error: result.code,
          code: result.code,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.withdrawalId ? { withdrawalId: result.withdrawalId } : {}),
          ...(result.txSignature ? { txSignature: result.txSignature } : {}),
          // `hold_at_risk` ONLY — the consent-gate payload the UI renders
          // (required vs post-withdrawal CLV + the at-risk parcels).
          ...(result.holdAtRisk ? { holdAtRisk: result.holdAtRisk } : {}),
        },
        errorStatus(result.code),
      );
    }

    return c.json(
      {
        withdrawal: {
          ...result.withdrawal,
          explorerUrl: result.withdrawal.txSignature
            ? `https://solscan.io/tx/${result.withdrawal.txSignature}`
            : null,
        },
        replay: result.replay,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /balances — read-only custodial balances (live regardless of the flag)
// ---------------------------------------------------------------------------

walletWithdrawRoutes.get('/balances', requireAuthOrAgentSession, noStorePrivate, async (c) => {
  const identity = c.get('identity');
  const result = await getCustodialWalletBalances(identity.avatarId);
  if (!result.ok) {
    return c.json({ error: result.code, code: result.code }, 404);
  }
  return c.json(result);
});

export default walletWithdrawRoutes;
