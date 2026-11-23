'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { activityRequest } from './activity-request';
const PARTY_POLL_MS = 5000;

export interface PartyMember {
  avatarId: string;
  displayName: string;
}

export interface ActivityParty {
  id: string;
  shortCode: string;
  leaderAvatarId: string;
  members: PartyMember[];
  createdAt: number;
  cap: number;
}

interface PartyResponse {
  ok: boolean;
  party: ActivityParty | null;
  alreadyInParty?: boolean;
}

export function useParty(activityId: string | null, options: { enabled?: boolean; isCurrent?: () => boolean } = {}) {
  const enabled = options.enabled ?? activityId !== null;
  const isCurrent = options.isCurrent;
  const [party, setParty] = useState<ActivityParty | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const generationRef = useRef(0);
  const mutationErrorRef = useRef<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<ActivityParty | null> => {
      if (!enabled || isCurrent?.() === false) {
        setParty(null);
        setError(null);
        setLoaded(true);
        return null;
      }
      const generation = generationRef.current;
      const data = await activityRequest<PartyResponse>('/api/activities/party/me', {}, signal);
      if (generation !== generationRef.current || signal?.aborted || isCurrent?.() === false) return null;
      setParty(data.party);
      if (!data.party) mutationErrorRef.current = null;
      setError(mutationErrorRef.current);
      setLoaded(true);
      return data.party;
    },
    [activityId, enabled, isCurrent],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!enabled) {
      setParty(null);
      setError(null);
      setLoaded(true);
      return;
    }
    setLoaded(false);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let stopped = false;

    const tick = async () => {
      controller = new AbortController();
      try {
        await refresh(controller.signal);
      } catch (caught) {
        if (
          !stopped &&
          generationRef.current === generation &&
          !(caught instanceof DOMException && caught.name === 'AbortError')
        ) {
          setError(caught instanceof Error ? caught.message : 'Could not load your party');
          setLoaded(true);
        }
      } finally {
        controller = null;
        if (!stopped && generationRef.current === generation) {
          timer = setTimeout(tick, PARTY_POLL_MS);
        }
      }
    };

    void tick();
    return () => {
      stopped = true;
      ++generationRef.current;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [activityId, enabled, refresh]);

  const mutate = useCallback(
    async (
      path: string,
      init: RequestInit,
      fallback: string,
    ): Promise<ActivityParty | null> => {
      if (isCurrent?.() === false) return null;
      const generation = generationRef.current;
      setBusy(true);
      try {
        const data = await activityRequest<PartyResponse>(path, init);
        if (generation !== generationRef.current || isCurrent?.() === false) return null;
        // Apply the mutation response immediately, then reconcile against the
        // canonical /party/me view so succession/disband state cannot drift.
        mutationErrorRef.current = null;
        if ('party' in data) setParty(data.party);
        return await refresh();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : fallback;
        if (generation === generationRef.current) { mutationErrorRef.current = message; setError(message); }
        return null;
      } finally {
        if (generation === generationRef.current) setBusy(false);
      }
    },
    [refresh, isCurrent],
  );

  const createParty = useCallback(
    () =>
      mutate(
        '/api/activities/party',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        'Could not create party',
      ),
    [mutate],
  );

  const joinByCode = useCallback(
    (shortCode: string) =>
      mutate(
        `/api/activities/party/${encodeURIComponent(shortCode)}/join`,
        { method: 'POST' },
        'Could not join party',
      ),
    [mutate],
  );

  const kick = useCallback(
    (avatarId: string) => {
      if (!party) return Promise.resolve(null);
      return mutate(
        `/api/activities/party/${encodeURIComponent(party.id)}/kick`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ avatarId }),
        },
        'Could not remove party member',
      );
    },
    [mutate, party],
  );

  const leave = useCallback(() => {
    if (!party) return Promise.resolve(null);
    return mutate(
      `/api/activities/party/${encodeURIComponent(party.id)}/leave`,
      { method: 'POST' },
      'Could not leave party',
    );
  }, [mutate, party]);

  return {
    party,
    error,
    busy,
    loaded,
    refresh,
    createParty,
    joinByCode,
    kick,
    leave,
  };
}
