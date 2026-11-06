'use client';

/**
 * SpendingCard: the human sets the spend rules for paid third-party tools
 * (GET/PUT /api/wallet/spend-policy, MCP hub step 2). Caps start unset, and an
 * unset cap means the agent cannot pay any tool. Only a signed-in, non-guest
 * human can save; the agent reads the same rules through its session.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SPEND_CAP_MAX_USD_CENTS,
  STUDIOS_CHARACTER_SHOTS_PER_DAY_DEFAULT,
  STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT,
  STUDIOS_RECASTS_PER_DAY_DEFAULT,
  STUDIOS_VIDEOS_PER_DAY_DEFAULT,
  STUDIOS_KEY_IMAGES_PER_DAY_MAX,
  isSpendPolicyRaise,
  type SpendVendorId,
} from '@clawville/shared';
import { api, ApiError } from '@/lib/api';
import { WalletSignError, signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { useAuthMe } from '@/hooks/use-auth-me';
import { centsToUsdText, parseUsdToCents } from '@/lib/usd-cents';

export const SPEND_POLICY_QUERY_KEY = ['spend-policy'] as const;
/** GET /api/vendors/studios/approvals (Approvals card and the /game notice). */
export const STUDIOS_APPROVALS_QUERY_KEY = ['studios-approvals'] as const;

const VENDOR_LABELS: Record<SpendVendorId, string> = {
  studios: 'Studios by Claw Hunter (images and video)',
};

/** The own-key images per day from the form text, or an error for the form. */
export function parseImagesPerDay(text: string): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return { ok: false, reason: 'enter a whole number.' };
  const value = Number(trimmed);
  if (value > STUDIOS_KEY_IMAGES_PER_DAY_MAX) return { ok: false, reason: `at most ${STUDIOS_KEY_IMAGES_PER_DAY_MAX}.` };
  return { ok: true, value };
}

/** Plain text for a failed save. Branches on the API `code`, never on raw text. */
export function saveErrorText(error: unknown): string {
  // The wallet's own messages are plain text written for people.
  if (error instanceof WalletSignError) return error.message;
  if (error instanceof ApiError) {
    if (error.code === 'spend_policy_needs_wallet_link') {
      return 'Link your own wallet first (below). Your linked wallet must approve higher caps, and it signs each payment you approve.';
    }
    if (error.code === 'spend_policy_needs_wallet_proof' || error.code === 'spend_policy_invalid_wallet_proof') {
      return 'Your linked wallet must approve higher caps. Approve the signature in your wallet and try again.';
    }
    if (error.code === 'spend_policy_needs_human_login') {
      return 'For your safety, sign out and sign in again in this browser. Then save your spend rules.';
    }
    if (error.code === 'spend_policy_human_only') {
      return 'Only you can change spend rules, from your own browser sign-in.';
    }
    if (error.status === 400) return 'Check the amounts and try again.';
  }
  return 'Saving failed. Try again.';
}

export function useHumanSpendPolicy() {
  const { data: auth } = useAuthMe();
  const signedIn = !!auth?.user && !auth.user.isGuest;
  const query = useQuery({
    queryKey: SPEND_POLICY_QUERY_KEY,
    queryFn: api.getSpendPolicy,
    enabled: signedIn,
    retry: false,
    staleTime: 30_000,
  });
  return { signedIn, query };
}

export function SpendingCard({ onSaved }: { onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const { signedIn, query } = useHumanSpendPolicy();
  const policy = query.data;
  const [daily, setDaily] = useState('');
  const [perCall, setPerCall] = useState('');
  const [vendors, setVendors] = useState<SpendVendorId[]>([]);
  const [imagesPerDay, setImagesPerDay] = useState(String(STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT));
  const [askFirst, setAskFirst] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!policy) return;
    setDaily(centsToUsdText(policy.dailyCapUsdCents));
    setPerCall(centsToUsdText(policy.perCallCapUsdCents));
    setVendors(policy.allowedVendors);
    setImagesPerDay(String(policy.studiosKeyImagesPerDay));
    setAskFirst(policy.requireApproval);
  }, [policy]);

  const save = useMutation({
    mutationFn: async (next: {
      dailyCapUsdCents: number | null;
      perCallCapUsdCents: number | null;
      allowedVendors: SpendVendorId[];
      studiosKeyImagesPerDay: number;
      requireApproval: boolean;
    }) => {
      const current = policy ?? {
        dailyCapUsdCents: null,
        perCallCapUsdCents: null,
        allowedVendors: [],
        studiosKeyImagesPerDay: STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT,
        studiosVideosPerDay: STUDIOS_VIDEOS_PER_DAY_DEFAULT,
        studiosCharacterShotsPerDay: STUDIOS_CHARACTER_SHOTS_PER_DAY_DEFAULT,
        studiosRecastsPerDay: STUDIOS_RECASTS_PER_DAY_DEFAULT,
        requireApproval: false,
        studiosPayMode: null,
      };
      // This card does not edit the per-class Studios counts (migration 0095)
      // or the Studios pay mode (migration 0096): the PUT leaves them out, so
      // the server keeps the saved values.
      const compared = {
        ...next,
        studiosVideosPerDay: current.studiosVideosPerDay,
        studiosCharacterShotsPerDay: current.studiosCharacterShotsPerDay,
        studiosRecastsPerDay: current.studiosRecastsPerDay,
        studiosPayMode: current.studiosPayMode,
      };
      if (!isSpendPolicyRaise(current, compared)) return api.putSpendPolicy(next);
      // A raise (turning "ask me before each payment" off is one) needs the
      // human's own linked wallet to sign the exact values.
      const challenge = await api.spendPolicyChallenge(next);
      const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
      return api.putSpendPolicy({ ...next, proof: { nonce: challenge.nonce, signature: signed.signatureBase58 } });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(SPEND_POLICY_QUERY_KEY, next);
      onSaved?.();
    },
    // The server decides what a raise is. After a refusal, reload the saved
    // rules so the next try compares against fresh values.
    onError: () => {
      queryClient.invalidateQueries({ queryKey: SPEND_POLICY_QUERY_KEY });
    },
  });

  const submit = () => {
    setFormError(null);
    const dailyCents = parseUsdToCents(daily, SPEND_CAP_MAX_USD_CENTS);
    const perCallCents = parseUsdToCents(perCall, SPEND_CAP_MAX_USD_CENTS);
    if (!dailyCents.ok) return setFormError(`Daily cap: ${dailyCents.reason}`);
    if (!perCallCents.ok) return setFormError(`Per-call cap: ${perCallCents.reason}`);
    const images = parseImagesPerDay(imagesPerDay);
    if (!images.ok) return setFormError(`Images per day with your own Studios key: ${images.reason}`);
    if (dailyCents.cents !== null && perCallCents.cents !== null && perCallCents.cents > dailyCents.cents) {
      return setFormError('The per-call cap cannot be above the daily cap.');
    }
    save.mutate({
      dailyCapUsdCents: dailyCents.cents,
      perCallCapUsdCents: perCallCents.cents,
      allowedVendors: vendors,
      studiosKeyImagesPerDay: images.value,
      requireApproval: askFirst,
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🧾</span>
        <h3 className="font-bold text-sm text-white">Spending</h3>
      </div>
      <div className="bg-sky-500/10 border border-sky-400/25 rounded-lg p-3 space-y-3">
        <p className="text-xs text-white/70 leading-relaxed">
          Some tools your agent can use cost money. Your agent pays them from your in-game wallet,
          only inside the caps you set here. Only you can change these rules; your agent can only read them.
          To set or raise a cap or a limit, your own linked wallet signs to approve it. Lowering needs no signature.
        </p>
        {!signedIn ? (
          <p className="text-xs text-white/60">Sign in to set spend rules for your agent.</p>
        ) : query.isLoading ? (
          <p className="text-xs text-white/60">Loading your spend rules...</p>
        ) : query.isError ? (
          <p className="text-xs text-red-300">Your spend rules did not load. Try again later.</p>
        ) : (
          <>
            {policy && !policy.configured && (
              <div className="text-xs text-amber-100 bg-amber-500/15 border border-amber-400/30 rounded-md px-3 py-2 leading-relaxed">
                Not set: your agent cannot pay any tool until you set both caps.
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-xs text-white/80 space-y-1">
                <span>Daily cap (US$)</span>
                <input
                  inputMode="decimal"
                  value={daily}
                  onChange={(e) => setDaily(e.target.value)}
                  placeholder="Not set"
                  className="w-full min-h-[44px] rounded-md bg-black/40 border border-white/15 px-3 text-sm text-white"
                />
              </label>
              <label className="text-xs text-white/80 space-y-1">
                <span>Per-call cap (US$)</span>
                <input
                  inputMode="decimal"
                  value={perCall}
                  onChange={(e) => setPerCall(e.target.value)}
                  placeholder="Not set"
                  className="w-full min-h-[44px] rounded-md bg-black/40 border border-white/15 px-3 text-sm text-white"
                />
              </label>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-xs text-white/80">Tools your agent may pay</legend>
              {(Object.keys(VENDOR_LABELS) as SpendVendorId[]).map((vendor) => (
                <label key={vendor} className="flex items-center gap-2 min-h-[44px] text-xs text-white/85">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={vendors.includes(vendor)}
                    onChange={(e) => setVendors((current) => (
                      e.target.checked ? [...current, vendor] : current.filter((v) => v !== vendor)
                    ))}
                  />
                  {VENDOR_LABELS[vendor]}
                </label>
              ))}
            </fieldset>
            <label className="block text-xs text-white/80 space-y-1">
              <span>Images per day with your own Studios key</span>
              <input
                inputMode="numeric"
                value={imagesPerDay}
                onChange={(e) => setImagesPerDay(e.target.value)}
                className="w-full min-h-[44px] rounded-md bg-black/40 border border-white/15 px-3 text-sm text-white"
              />
              <span className="block text-white/55 leading-relaxed">
                Applies only when you save your own Studios key (Studios images card). Studios bills your
                Studios account, so the caps above do not cover it. This counts every image on your key.
              </span>
            </label>
            <label className="flex items-start gap-3 min-h-[44px] text-xs text-white/85">
              <input
                type="checkbox"
                className="h-5 w-5 mt-0.5 shrink-0"
                checked={askFirst}
                onChange={(e) => setAskFirst(e.target.checked)}
              />
              <span className="space-y-1">
                <span className="block font-semibold">Ask me before each payment</span>
                <span className="block text-white/55 leading-relaxed">
                  Each paid image (your agent&apos;s and your own) waits in Approvals (below) until you approve it
                  with your linked wallet, or decline it. It expires after 15 minutes. Turning this on needs a
                  linked wallet; turning it off needs your linked wallet to sign.
                </span>
              </span>
            </label>
            {(formError || save.isError) && (
              <p className="text-xs text-red-300">
                {formError ?? saveErrorText(save.error)}
              </p>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={save.isPending}
              className="w-full min-h-[44px] rounded-md bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-sm font-bold text-white"
            >
              {save.isPending ? 'Saving...' : 'Save spend rules'}
            </button>
            {save.isSuccess && !formError && <p className="text-xs text-emerald-300">Saved.</p>}
          </>
        )}
      </div>
    </div>
  );
}
