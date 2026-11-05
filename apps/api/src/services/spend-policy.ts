/**
 * Per-avatar spend rules for paid third-party tools (MCP hub step 2, phase 1).
 *
 * The human owner sets the rules; the agent reads them. The only writer is
 * `writeSpendPolicy`, which the route calls from a human Lucia session only.
 * Caps start unset (NULL) and an unset cap refuses every paid call
 * (`configured === false`). No money moves in this module.
 */

import { z } from 'zod';
import { db, eq, userSpendPolicies } from '@clawville/database';
import {
  SPEND_CAP_MAX_USD_CENTS,
  SPEND_VENDOR_IDS,
  type SpendPolicyView,
  type SpendVendorId,
} from '@clawville/shared';

const capSchema = z.number().int().min(0).max(SPEND_CAP_MAX_USD_CENTS).nullable();

export const spendPolicyInputSchema = z
  .object({
    dailyCapUsdCents: capSchema,
    perCallCapUsdCents: capSchema,
    allowedVendors: z
      .array(z.enum(SPEND_VENDOR_IDS))
      .max(32)
      .transform((vendors) => [...new Set(vendors)]),
  })
  .strict()
  .refine(
    (input) => input.dailyCapUsdCents === null
      || input.perCallCapUsdCents === null
      || input.perCallCapUsdCents <= input.dailyCapUsdCents,
    { message: 'per_call_cap_above_daily_cap', path: ['perCallCapUsdCents'] },
  );

export type SpendPolicyInput = z.infer<typeof spendPolicyInputSchema>;

type PolicyRow = {
  dailyCapUsdCents: number | null;
  perCallCapUsdCents: number | null;
  allowedVendors: string[];
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
      updatedAt: userSpendPolicies.updatedAt,
    })
    .from(userSpendPolicies)
    .where(eq(userSpendPolicies.avatarId, avatarId))
    .limit(1);
  return toSpendPolicyView(row);
}

/** Human-only writer. The caller has already proved the user owns `avatarId`. */
export async function writeSpendPolicy(
  avatarId: string,
  userId: string,
  input: SpendPolicyInput,
): Promise<SpendPolicyView> {
  const now = new Date();
  const values = {
    dailyCapUsdCents: input.dailyCapUsdCents,
    perCallCapUsdCents: input.perCallCapUsdCents,
    allowedVendors: input.allowedVendors,
    updatedByUserId: userId,
    updatedAt: now,
  };
  const [row] = await db
    .insert(userSpendPolicies)
    .values({ avatarId, ...values })
    .onConflictDoUpdate({ target: userSpendPolicies.avatarId, set: values })
    .returning({
      dailyCapUsdCents: userSpendPolicies.dailyCapUsdCents,
      perCallCapUsdCents: userSpendPolicies.perCallCapUsdCents,
      allowedVendors: userSpendPolicies.allowedVendors,
      updatedAt: userSpendPolicies.updatedAt,
    });
  return toSpendPolicyView(row);
}
