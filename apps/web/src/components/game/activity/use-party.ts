'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
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

function responseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.error === 'string') return record.error;
  return fallback;
}

async function readPartyResponse(
  response: Response,
  fallback: string,
): Promise<PartyResponse> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(responseMessage(body, fallback));
  }
  return body as PartyResponse;
}

export function useParty(activityId: string | null) {
  const [party, setParty] = useState<ActivityParty | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const generationRef = useRef(0);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<ActivityParty | null> => {
      if (!activityId) {
        setParty(null);
        setError(null);
        setLoaded(true);
        return null;
      }
      const response = await fetch(`${API_BASE}/api/activities/party/me`, {
        credentials: 'include',
        signal,
      });
      const data = await readPartyResponse(response, 'Could not load your party');
      setParty(data.party);
      setError(null);
      setLoaded(true);
      return data.party;
    },
    [activityId],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!activityId) {
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
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [activityId, refresh]);

  const mutate = useCallback(
    async (
      path: string,
      init: RequestInit,
      fallback: string,
    ): Promise<ActivityParty | null> => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          ...init,
          credentials: 'include',
        });
        const data = await readPartyResponse(response, fallback);
        // Apply the mutation response immediately, then reconcile against the
        // canonical /party/me view so succession/disband state cannot drift.
        if ('party' in data) setParty(data.party);
        return await refresh();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : fallback;
        setError(message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
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
