'use client';
import { useEffect, useRef, useState } from 'react';
import { useParty } from './use-party';
import { useGameStore } from '@/stores/game';
import { ACTIVITY_REGISTRY } from '@clawville/shared';
import { reloadWorldRenderer } from '@/lib/world-renderer-mode';
import { activityRequest } from './activity-request';
const POLL_MS = 2000;
/** Only the authorized participant's server-assigned room selects a destination. */
export function matchedActivity3DUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.matchedActivityId !== 'string' || !ACTIVITY_REGISTRY.some((a) => a.id === row.matchedActivityId && a.status === 'live')) return null;
  if (typeof row.matchedRoomId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(row.matchedRoomId)) return null;
  if (typeof row.matchedRoomShortCode !== 'string' || !/^[a-zA-Z0-9]{1,12}$/.test(row.matchedRoomShortCode)) return null;
  return `/activity/${encodeURIComponent(row.matchedActivityId)}/${encodeURIComponent(row.matchedRoomId)}?shortCode=${encodeURIComponent(row.matchedRoomShortCode)}&view=3d`;
}
/** Renderer recovery is separate from modal lifetime and never queues an avatar. */
export default function Activity2DRecovery({ enabled, partyEligible = true, isCurrent }: { enabled: boolean; partyEligible?: boolean; isCurrent?: () => boolean }) {
  const { party, leave, busy, error } = useParty(null, { enabled: enabled && partyEligible, isCurrent });
  const lastLeave = useRef({ partyId: '', at: 0 });
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !party || busy || isCurrent?.() === false) return;
    const now = Date.now();
    if (lastLeave.current.partyId === party.id && now - lastLeave.current.at < 5000) return;
    lastLeave.current = { partyId: party.id, at: now };

    void leave();
  }, [enabled, party, busy, leave, isCurrent]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      if (stopped || isCurrent?.() === false) return;
      controller = new AbortController();

      try {
        // Queue-status resolves match assignment globally from the current identity.
        // The fixed query activity never supplies the destination activity.
        // Cancel pending solo/ambiguous queue rows too, even without a party.
        let leaveError: unknown = null;
        try { await activityRequest('/api/activities/bumper-shells/leave-queue', { method: 'POST' }, controller.signal); }
        catch (error) { leaveError = error; }
        if (stopped || isCurrent?.() === false) return;
        const data = await activityRequest<unknown>('/api/activities/bumper-shells/queue-status', {}, controller.signal);
        if (stopped || isCurrent?.() === false) return;
        setStatusError(leaveError instanceof Error ? leaveError.message : null);
        const destination = matchedActivity3DUrl(data);
        if (!destination && data && typeof data === 'object' && (data as Record<string, unknown>).matchedRoomId) {
          throw new Error('Your assigned activity cannot open here. Switch to 3D to recover.');
        }
        if (destination) {
          useGameStore.getState().addToast('3D', 'Your activity match already exists. Opening its 3D view.', 5000);
          stopped = true; window.location.assign(destination); return;
        }
      } catch (caught) {
        if (!stopped) setStatusError(caught instanceof Error ? caught.message : 'Activity recovery failed. Switch to 3D.');
      } finally {

        if (!stopped && isCurrent?.() !== false) timer = setTimeout(poll, POLL_MS);
      }
    }
    void poll();
    return () => { stopped = true; controller?.abort(); if (timer) clearTimeout(timer); };
  }, [enabled, isCurrent]);
  if (!enabled || (!error && !statusError)) return null;
  return <div role="alert" className="pointer-events-auto fixed left-1/2 top-20 z-50 max-w-sm -translate-x-1/2 rounded border border-amber-300 bg-slate-950 p-3 text-sm text-white">
    <p>{error ?? statusError}</p>
    <button className="mt-2 min-h-12 rounded border px-3" onClick={() => reloadWorldRenderer('3d')}>Switch to 3D</button>
  </div>;
}
