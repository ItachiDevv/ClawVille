/**
 * Per-avatar spend rules for paid third-party tools (MCP hub step 2, phase 1).
 *
 * The human owner sets the rules; the agent reads them. The only writer is
 * `writeSpendPolicy`, which the route calls from a human Lucia session only.
 * Caps start unset (NULL) and an unset cap refuses every paid call
 * (`configured === false`). No money moves in this module.
 */

import { z } from 'zod';
import { db, eq, sql, userSpendPolicies } from '@clawville/database';
import {
  SPEND_CAP_MAX_USD_CENTS,
  SPEND_VENDOR_IDS,
  STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT,
  STUDIOS_KEY_IMAGES_PER_DAY_MAX,
  isSpendPolicyRaise,
  type SpendPolicyValues,
  type SpendPolicyView,
  type SpendVendorId,
} from '@clawville/shared';
import { verifySpendProof } from './spend-policy-proof';

const capSchema = z.number().int().min(0).max(SPEND_CAP_MAX_USD_CENTS).nullable();

export const spendPolicyInputSchema = z
  .object({
    dailyCapUsdCents: capSchema,
    perCallCapUsdCents: capSchema,
    allowedVendors: z
      .array(z.enum(SPEND_VENDOR_IDS))
      .max(32)
      .transform((vendors) => [...new Set(vendors)]),
    // Optional: when absent, the saved value (or the default) stays.
    studiosKeyImagesPerDay: z.number().int().min(0).max(STUDIOS_KEY_IMAGES_PER_DAY_MAX).optional(),
    // Optional: "ask me before each payment". Absent keeps the saved value.
    requireApproval: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => input.dailyCapUsdCents === null
      || input.perCallCapUsdCents === null
      || input.perCallCapUsdCents <= input.dailyCapUsdCents,
    { message: 'per_call_cap_above_daily_cap', path: ['perCallCapUsdCents'] },
  );

export type SpendPolicyInput = z.infer<typeof spendPolicyInputSchema>;

/** The full values: an absent own-key image count or approval setting keeps the current one. */
export function resolveSpendPolicyValues(input: SpendPolicyInput, current: SpendPolicyView): SpendPolicyValues {
  return {
    ...input,
    studiosKeyImagesPerDay: input.studiosKeyImagesPerDay ?? current.studiosKeyImagesPerDay,
    requireApproval: input.requireApproval ?? current.requireApproval,
  };
}

type PolicyRow = {
  dailyCapUsdCents: number | null;
  perCallCapUsdCents: number | null;
  allowedVendors: string[];
  studiosKeyImagesPerDay?: number | null;
  requireApproval?: boolean | null;
  updatedAt: Date | string | null;
};

export function toSpendPolicyView(row: PolicyRow | null | undefined): SpendPolicyView {
  const dailyCapUsdCents = row?.dailyCapUsdCents ?? null;
  const perCallCapUsdCents = row?.perCallCapUsdCents ?? null;
  const allowedVendors = (row?.allowedVendors ?? []).filter(
    (vendor): vendor is SpendVendorId => (SPEND_VENDOR_IDS as readonly string[]).includes(vendor),
  );
  const updatedAt = row?.updatedAt ?? null;
  return {
    dailyCapUsdCents,
    perCallCapUsdCents,
    allowedVendors,
    studiosKeyImagesPerDay: row?.studiosKeyImagesPerDay ?? STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT,
    requireApproval: row?.requireApproval ?? false,
    configured: dailyCapUsdCents !== null && perCallCapUsdCents !== null,
    updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(),
  };
}

export async function readSpendPolicy(avatarId: string): Promise<SpendPolicyView> {
  const [row] = await db
    .select({
      dailyCapUsdCents: userSpendPolicies.dailyCapUsdCents,
      perCallCapUsdCents: userSpendPolicies.perCallCapUsdCents,
      allowedVendors: userSpendPolicies.allowedVendors,
      studiosKeyImagesPerDay: userSpendPolicies.studiosKeyImagesPerDay,
      requireApproval: userSpendPolicies.requireApproval,
      updatedAt: userSpendPolicies.updatedAt,
    })
    .from(userSpendPolicies)
    .where(eq(userSpendPolicies.avatarId, avatarId))
    .limit(1);
  return toSpendPolicyView(row);
}

type Executor = Pick<typeof db, 'select' | 'insert' | 'execute'>;

const policyColumns = {
  dailyCapUsdCents: userSpendPolicies.dailyCapUsdCents,
  perCallCapUsdCents: userSpendPolicies.perCallCapUsdCents,
  allowedVendors: userSpendPolicies.allowedVendors,
  studiosKeyImagesPerDay: userSpendPolicies.studiosKeyImagesPerDay,
  requireApproval: userSpendPolicies.requireApproval,
  updatedAt: userSpendPolicies.updatedAt,
};

async function upsertSpendPolicy(
  executor: Executor,
  avatarId: string,
  userId: string,
  input: SpendPolicyInput,
): Promise<SpendPolicyView> {
  // An undefined studiosKeyImagesPerDay or requireApproval leaves the column
  // unchanged on update.
  const values = {
    dailyCapUsdCents: input.dailyCapUsdCents,
    perCallCapUsdCents: input.perCallCapUsdCents,
    allowedVendors: input.allowedVendors,
    studiosKeyImagesPerDay: input.studiosKeyImagesPerDay,
    requireApproval: input.requireApproval,
    updatedByUserId: userId,
    updatedAt: new Date(),
  };
  const [row] = await executor
    .insert(userSpendPolicies)
    .values({ avatarId, ...values })
    .onConflictDoUpdate({ target: userSpendPolicies.avatarId, set: values })
    .returning(policyColumns);
  return toSpendPolicyView(row);
}

/**
 * Unchecked writer, for tests and fixtures only. Routes use
 * `applySpendPolicyChange`, which checks the raise rule.
 */
export async function writeSpendPolicy(
  avatarId: string,
  userId: string,
  input: SpendPolicyInput,
): Promise<SpendPolicyView> {
  return upsertSpendPolicy(db, avatarId, userId, input);
}

export interface SpendProofInput {
  nonce: string;
  signature: string;
}

export type SpendPolicyChangeResult =
  | { kind: 'saved'; view: SpendPolicyView }
  | { kind: 'needs_wallet_link' }
  | { kind: 'needs_wallet_proof' }
  | { kind: 'invalid_proof'; reason: 'invalid_challenge' | 'invalid_signature' };

/**
 * Human-only writer with the phase 1b raise rule. The caller has already proved
 * that `userId` owns `avatarId` through a human session.
 *
 * One transaction holds a per-avatar advisory lock, reads the saved values,
 * and decides whether `input` is a raise (see `isSpendPolicyRaise`; turning
 * "ask me before each payment" off is one). A raise needs a signature from the user's linked wallet over the exact new values.
 * A lower or equal change saves without one. The lock stops a concurrent lower
 * change from turning an unchecked write into a raise.
 */
export async function applySpendPolicyChange(
  avatarId: string,
  userId: string,
  input: SpendPolicyInput,
  proof: SpendProofInput | null,
): Promise<SpendPolicyChangeResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`spend-policy:${avatarId}`}, 0))`);
    const [current] = await tx
      .select(policyColumns)
      .from(userSpendPolicies)
      .where(eq(userSpendPolicies.avatarId, avatarId))
      .limit(1);
    const currentView = toSpendPolicyView(current);
    const next = resolveSpendPolicyValues(input, currentView);
    // "Ask me before each payment" needs the linked wallet: it signs each
    // approval, so with no wallet nobody could ever approve a payment.
    if (next.requireApproval && !currentView.requireApproval) {
      const ownerRows = await tx.execute<{ linked_wallet_pubkey: string | null }>(
        sql`SELECT linked_wallet_pubkey FROM users WHERE id = ${userId} FOR SHARE`,
      );
      if (!Array.from(ownerRows)[0]?.linked_wallet_pubkey) return { kind: 'needs_wallet_link' } as const;
    }
    if (isSpendPolicyRaise(currentView, next)) {
      // FOR SHARE conflicts with the wallet-link FOR UPDATE: a wallet change
      // cannot commit between this read and the policy write, so a proof from
      // a wallet that is being replaced cannot save a raise.
      const ownerRows = await tx.execute<{ linked_wallet_pubkey: string | null }>(
        sql`SELECT linked_wallet_pubkey FROM users WHERE id = ${userId} FOR SHARE`,
      );
      const walletPubkey = Array.from(ownerRows)[0]?.linked_wallet_pubkey ?? null;
      if (!walletPubkey) return { kind: 'needs_wallet_link' } as const;
      if (!proof) return { kind: 'needs_wallet_proof' } as const;
      const verdict = verifySpendProof({ userId, values: next, walletPubkey, ...proof });
      if (verdict !== 'ok') return { kind: 'invalid_proof', reason: verdict } as const;
    }
    return { kind: 'saved', view: await upsertSpendPolicy(tx, avatarId, userId, input) } as const;
  });
}
