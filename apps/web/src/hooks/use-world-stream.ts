'use client';

import { useEffect, useRef } from 'react';
import { useNpcStore } from '@/stores/npc';
import { usePlayerStore } from '@/stores/players';
import { useResearchStore } from '@/stores/research';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { measureSpike } from '@/lib/perf-tracker';

const WORLD_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const MAX_RETRIES = 20;
const RETRY_DELAY_BASE = 3000;
const RETRY_DELAY_MAX = 60000;
/** Position upload rate — matches the server NPC sim tick (5 Hz / 200 ms). */
const POSITION_UPLOAD_INTERVAL_MS = 200;
/** Minimum game-pixel movement that flips activity from 'idle' → 'walking'. */
const ACTIVITY_MOTION_EPSILON_PX = 0.5;

interface JoinResponse {
  roomId: string;
  sessionId: string;
}

/**
 * Multiplayer Phase 1 world stream — REPLACES `useNpcStream`.
 *
 * Lifecycle:
 *   1. Read optional `?room=CODE` query param from `window.location`.
 *   2. POST `/api/world/join` with `{ roomId?: code }` — server returns the
 *      assigned `{ roomId, sessionId }`. Sessionless guests get a fingerprint
 *      session via the existing middleware.
 *   3. Open SSE to `/api/world/:roomId/stream`. Subscribe to `snapshot` events,
 *      route the unified payload through both `useNpcStore.updateFromSnapshot`
 *      AND `usePlayerStore.updateFromSnapshot`.
 *   4. Start a 5 Hz interval that POSTs the local `avatarPositionRef` +
 *      heading + activity to `/api/world/position`. The heading is computed
 *      from a 1-tick velocity tracker (atan2(vx, vy) matches the VRM facing
 *      convention used elsewhere in the renderer).
 *   5. On unmount: close SSE, clear position interval, call `/api/world/leave`
 *      best-effort (fire-and-forget — server GCs stale players after 30 s).
 *
 * Reconnect: standard exp backoff (3 s, 6 s, 12 s … capped 60 s, up to 20
 * attempts). Mirrors `useNpcStream`. The position interval keeps running
 * across reconnects — server is idempotent on `lastPositionUpdateAt`.
 */
export function useWorldStream() {
  const updateNpcsFromSnapshot = useNpcStore((s) => s.updateFromSnapshot);
  const setNpcConnected = useNpcStore((s) => s.setConnected);
  const updatePlayersFromSnapshot = usePlayerStore((s) => s.updateFromSnapshot);
  const setLocalSessionId = usePlayerStore((s) => s.setLocalSessionId);
  const setRoomId = usePlayerStore((s) => s.setRoomId);
  const clearPlayers = usePlayerStore((s) => s.clear);
  const addCollaborationEntries = useResearchStore((s) => s.addCollaborationEntries);

  const retriesRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  // Velocity tracker for dirZ — set by the upload interval, read on the
  // next tick to compute atan2(vx, vy). Module-scope via ref so the
  // interval callback doesn't reallocate.
  const lastPosRef = useRef<{ x: number; y: number; ts: number } | null>(null);
  const lastDirZRef = useRef<number>(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let positionInterval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    async function join(): Promise<JoinResponse | null> {
      const requestedRoom =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('room')
          : null;
      try {
        const res = await fetch(`${WORLD_API_URL}/api/world/join`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestedRoom ? { roomId: requestedRoom } : {}),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as JoinResponse;
        return data;
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[useWorldStream] join failed', err);
        }
        return null;
      }
    }

    function startPositionUpload() {
      if (positionInterval) return;
      positionInterval = setInterval(() => {
        // Skip upload until we've joined a room — sessionId is the auth
        // anchor server-side. Also skip if the user has no avatar (explore
        // mode) — the spectator camera doesn't represent a player body.
        const sid = sessionIdRef.current;
        if (!sid) return;
        const { controlMode } = useGameStore.getState();
        if (controlMode === 'explore') return;

        const now = Date.now();
        const x = avatarPositionRef.x;
        const y = avatarPositionRef.y;
        const prev = lastPosRef.current;
        let activity = 'idle';
        if (prev) {
          const dx = x - prev.x;
          const dy = y - prev.y;
          const motionSq = dx * dx + dy * dy;
          if (motionSq > ACTIVITY_MOTION_EPSILON_PX * ACTIVITY_MOTION_EPSILON_PX) {
            activity = 'walking';
            // Heading derived from sustained motion only — atan2(vx, vy)
            // matches the VRM facing convention (see vrm-character-animator.ts
            // and player-avatar.tsx). When idle the last computed dirZ is
            // preserved so the remote avatar doesn't snap back to north.
            lastDirZRef.current = Math.atan2(dx, dy);
          }
        }
        lastPosRef.current = { x, y, ts: now };

        const body = JSON.stringify({
          x,
          y,
          dirZ: lastDirZRef.current,
          activity,
        });
        // Fire-and-forget. keepalive=true lets the request survive page nav.
        fetch(`${WORLD_API_URL}/api/world/position`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => { /* best-effort, GC handles stale */ });
      }, POSITION_UPLOAD_INTERVAL_MS);
    }

    function openStream(roomId: string) {
      if (cancelled || retriesRef.current >= MAX_RETRIES) return;
      const url = `${WORLD_API_URL}/api/world/${encodeURIComponent(roomId)}/stream`;
      es = new EventSource(url, { withCredentials: true });

      es.addEventListener('open', () => {
        retriesRef.current = 0;
        setNpcConnected(true);
      });

      es.addEventListener('snapshot', (event) => {
        try {
          const snapshot = measureSpike('sse:parse', () =>
            JSON.parse((event as MessageEvent).data),
          );
          setNpcConnected(true);

          // Route NPC slice through the existing store path (preserves the
          // identity-mutation perf optimization in updateFromSnapshot).
          // Guard on .npcs presence: backend may emit minimal player-only
          // snapshots while NPC roster is empty for that room.
          if (Array.isArray(snapshot.npcs)) {
            measureSpike('sse:npcUpdate', () => updateNpcsFromSnapshot(snapshot));
          }

          // Route player slice through the new store.
          if (Array.isArray(snapshot.players)) {
            measureSpike('sse:playerUpdate', () =>
              updatePlayersFromSnapshot(snapshot.players),
            );
          }

          if (
            Array.isArray(snapshot.collaborationEvents) &&
            snapshot.collaborationEvents.length > 0
          ) {
            measureSpike('sse:collabUpdate', () =>
              addCollaborationEntries(snapshot.collaborationEvents),
            );
          }
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[useWorldStream] snapshot parse/dispatch failed', err);
          }
        }
      });

      es.onerror = () => {
        setNpcConnected(false);
        es?.close();
        es = null;
        retriesRef.current++;
        if (!cancelled && retriesRef.current < MAX_RETRIES) {
          const delay = Math.min(
            RETRY_DELAY_BASE * Math.pow(2, retriesRef.current - 1),
            RETRY_DELAY_MAX,
          );
          retryTimeout = setTimeout(() => openStream(roomId), delay);
        }
      };
    }

    async function bootstrap() {
      const joined = await join();
      if (cancelled) return;
      if (!joined) {
        // Backoff + retry the whole join → stream flow.
        retriesRef.current++;
        if (retriesRef.current < MAX_RETRIES) {
          const delay = Math.min(
            RETRY_DELAY_BASE * Math.pow(2, retriesRef.current - 1),
            RETRY_DELAY_MAX,
          );
          retryTimeout = setTimeout(bootstrap, delay);
        }
        return;
      }
      sessionIdRef.current = joined.sessionId;
      roomIdRef.current = joined.roomId;
      setLocalSessionId(joined.sessionId);
      setRoomId(joined.roomId);
      openStream(joined.roomId);
      startPositionUpload();
    }

    bootstrap();

    return () => {
      cancelled = true;
      es?.close();
      if (retryTimeout) clearTimeout(retryTimeout);
      if (positionInterval) clearInterval(positionInterval);
      setNpcConnected(false);
      // Best-effort leave — server GCs stale players via 30 s timeout.
      const sid = sessionIdRef.current;
      if (sid) {
        fetch(`${WORLD_API_URL}/api/world/leave`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          keepalive: true,
        }).catch(() => { /* fire-and-forget */ });
      }
      sessionIdRef.current = null;
      roomIdRef.current = null;
      setLocalSessionId(null);
      clearPlayers();
    };
  }, [
    updateNpcsFromSnapshot,
    setNpcConnected,
    updatePlayersFromSnapshot,
    setLocalSessionId,
    setRoomId,
    clearPlayers,
    addCollaborationEntries,
  ]);
}
