'use client';

/**
 * "Ask me before each payment": the /game notice while a payment waits for
 * the human. It opens the wallet panel (Approvals card). This file owns the
 * notice's position.
 *
 * Touch layout (`useIsMobile()`): the quest tracker's top-centre pill renders
 * `ApprovalTrackerSlot` in its own flex row, to the RIGHT of the pill and
 * top-aligned with it. The notice therefore never covers the tracker
 * (collapsed or expanded: the list grows down beside it), sits below the z-50
 * top-centre stack (agent pill, mode toggle) exactly like the tracker, and
 * stays far above the bottom prompt pills and the emote hotbar (also on a
 * 844x390 phone in landscape: 124 -> 168 px, the prompt starts at ~177 px).
 * While that slot is mounted, the stand-alone notice renders nothing.
 *
 * Stand-alone `ApprovalNotice`: on desktop (the tracker lives in the left
 * column there), or on touch when the tracker is not mounted, a pill at the
 * tracker's top-centre place. Registered in `GAME_HUD` at
 * `HUD_Z.approvalNotice` (48): above the hotbar, below every dialog.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';
import { STUDIOS_APPROVALS_QUERY_KEY, useHumanSpendPolicy } from './spending-card';

const POLL_MS = 30_000;

export function useStudiosApprovals() {
  const { signedIn, query: policyQuery } = useHumanSpendPolicy();
  const query = useQuery({
    queryKey: STUDIOS_APPROVALS_QUERY_KEY,
    queryFn: api.studiosApprovals,
    enabled: signedIn,
    retry: false,
    staleTime: 10_000,
    // Poll only while the rule is on or a request still waits (one can wait
    // after the human turned the rule off; it expires in 15 minutes).
    refetchInterval: (q) => (
      policyQuery.data?.requireApproval || (q.state.data?.approvals.length ?? 0) > 0 ? POLL_MS : false
    ),
  });
  return { signedIn, query, approvals: query.data?.approvals ?? [] };
}

/** How many tracker slots are mounted (0 or 1 in practice). */
const useTrackerSlotStore = create<{ slots: number; add: () => void; remove: () => void }>((set) => ({
  slots: 0,
  add: () => set((s) => ({ slots: s.slots + 1 })),
  remove: () => set((s) => ({ slots: Math.max(0, s.slots - 1) })),
}));

function useWaitingNotice() {
  const { approvals } = useStudiosApprovals();
  const walletOpen = useGameStore((s) => s.walletLinkModalOpen);
  const openWallet = useGameStore((s) => s.openWalletLink);
  return { count: walletOpen ? 0 : approvals.length, openWallet };
}

function plural(count: number): string {
  return `${count} payment${count === 1 ? '' : 's'}`;
}

/**
 * Rendered by the quest tracker's touch placement, in the same flex row as
 * its pill. A 44x44 button: the count, with a full label for screen readers.
 */
export function ApprovalTrackerSlot() {
  const add = useTrackerSlotStore((s) => s.add);
  const remove = useTrackerSlotStore((s) => s.remove);
  useEffect(() => {
    add();
    return remove;
  }, [add, remove]);
  const { count, openWallet } = useWaitingNotice();
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={openWallet}
      data-testid="approval-notice"
      aria-label={`${plural(count)} to approve. Open the wallet.`}
      title={`${plural(count)} to approve`}
      className="shrink-0 min-w-[44px] min-h-[44px] h-11 px-2 rounded-full border border-amber-300/50 bg-amber-500/90 text-slate-950 font-bold shadow-lg flex flex-col items-center justify-center leading-none"
    >
      <span className="text-sm">{count}</span>
      <span className="text-[10px]">to pay</span>
    </button>
  );
}

/** The stand-alone pill: desktop, or touch with no tracker mounted. */
export function ApprovalNotice() {
  const isMobile = useIsMobile();
  const trackerSlots = useTrackerSlotStore((s) => s.slots);
  const { count, openWallet } = useWaitingNotice();
  if (count === 0 || (isMobile && trackerSlots > 0)) return null;
  const label = isMobile
    ? `${plural(count)} to approve`
    : `${plural(count)} wait${count === 1 ? 's' : ''} for your approval. Open the wallet.`;
  return (
    <button
      type="button"
      onClick={openWallet}
      data-testid="approval-notice"
      className={`fixed left-1/2 -translate-x-1/2 z-[48] min-h-[44px] rounded-full border border-amber-300/50 bg-amber-500/90 text-slate-950 font-bold shadow-lg ${isMobile ? 'top-[7.75rem] px-4 text-xs' : 'top-[8.5rem] px-5 text-sm'}`}
    >
      {label}
    </button>
  );
}
