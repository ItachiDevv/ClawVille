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
  /**
   * Opaque non-reversible presence id for THIS session (server-derived). The
   * raw session token is never returned. We store it as localSessionId so the
   * player store can resolve `isLocal` against the `id` field on each
   * snapshot's players[].
   */
  id: string;
  /**
   * Sticky-room recovery ticket (2026-06-12). A signed, self-expiring token
   * naming the room this session landed in, bound to its publicId. The client
   * holds it and replays it on the NEXT recovery rejoin (a 409 or SSE
   * reconnect) so a server deploy/restart re-converges a group of friends into
   * the SAME room instead of auto-filling them apart. Opaque to the client.
   */
  roomTicket?: string;
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
  // Sticky-room recovery ticket from the last successful join. Replayed on a
  // recovery rejoin (409 or SSE reconnect) so a server restart re-lands us in
  // the same room as our group. null until the first join completes.
  const roomTicketRef = useRef<string | null>(null);
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

    /**
     * @param recovery When true, this is a rejoin AFTER an initial successful
     *   join was lost (a 409 from /position, or an SSE reconnect). We replay
     *   the prior roomId + recovery ticket so a server deploy/restart re-lands
     *   us in the SAME room as our group instead of auto-filling us apart.
     *   On the FIRST join (recovery=false) we send only the optional `?room=`
     *   deeplink invite code — no ticket exists yet, and sending a stale
     *   roomId on a fresh join would wrongly pin a room the user didn't intend.
     */
    async function join(recovery = false): Promise<JoinResponse | null> {
      const requestedRoom =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('room')
          : null;
      const body: { roomId?: string; roomTicket?: string } = {};
      if (recovery) {
        // Recovery rejoin: prefer the room we were actually in. The ticket is
        // the server-side proof; roomId is a hint the ticket already encodes,
        // but we send it too so the server has it even if ticket verification
        // is disabled in some future config. The deeplink code is irrelevant
        // here — we're recovering a known room, not following a fresh invite.
        if (roomIdRef.current) body.roomId = roomIdRef.current;
        if (roomTicketRef.current) body.roomTicket = roomTicketRef.current;
      } else if (requestedRoom) {
        body.roomId = requestedRoom;
      }
      try {
        const res = await fetch(`${WORLD_API_URL}/api/world/join`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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

    function stopPositionUpload() {
      if (positionInterval) {
        clearInterval(positionInterval);
        positionInterval = null;
      }
    }

    /**
     * Detects HTTP 409 from `/api/world/position` (server: "Session is not in
     * a room — call /api/world/join first") and recovers by tearing down the
     * stale 5 Hz interval, re-running the join flow (as a RECOVERY rejoin so the
     * sticky-room ticket re-converges our group post-restart), and re-arming the
     * interval if join succeeds. Guarded by `recoveryInFlight` so concurrent
     * 409s don't trigger multiple parallel rejoins.
     *
     * Sticky-room nuance (2026-06-12): a recovery rejoin can land us in a
     * DIFFERENT roomId than before — the server recreates the wiped room from
     * the ticket, but if that room had filled past the hard cap it spills us to
     * auto-fill. The SSE downlink is keyed on roomId AND gated on room
     * membership, so if the room changed we MUST re-point the stream (the old
     * room's stream would 403 / serve a stale room). When the room is unchanged
     * the existing SSE keeps flowing untouched.
     */
    let recoveryInFlight = false;
    async function recoverFrom409() {
      if (cancelled || recoveryInFlight) return;
      recoveryInFlight = true;
      stopPositionUpload();
      const prevRoomId = roomIdRef.current;
      try {
        const rejoined = await join(true);
        if (cancelled) return;
        if (rejoined) {
          sessionIdRef.current = rejoined.id;
          roomIdRef.current = rejoined.roomId;
          roomTicketRef.current = rejoined.roomTicket ?? roomTicketRef.current;
          setLocalSessionId(rejoined.id);
          setRoomId(rejoined.roomId);
          // Re-point the SSE if recovery placed us in a different room (the old
          // stream is now pointed at a room we're no longer a member of).
          if (rejoined.roomId !== prevRoomId) {
            es?.close();
            es = null;
            // Cancel any pending reconnect the old stream's onerror queued, so
            // we don't end up with two EventSources racing.
            if (retryTimeout) {
              clearTimeout(retryTimeout);
              retryTimeout = null;
            }
            retriesRef.current = 0;
            openStream(rejoined.roomId);
          }
          startPositionUpload();
        }
        // If rejoin failed, the next position upload won't fire (interval
        // stays stopped). The SSE downlink's onerror handler will eventually
        // tear down + bootstrap() retry the whole flow, restoring uploads.
      } finally {
        recoveryInFlight = false;
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
        // keepalive=true lets the request survive page nav. We DO inspect
        // status now — a 409 "Session is not in a room" means the server
        // GC'd our session (30s no-position-update timeout) and we need to
        // re-join. Other non-OK statuses are best-effort silent (server's
        // 10 Hz throttle returns 200 with {throttled:true}, not an error).
        fetch(`${WORLD_API_URL}/api/world/position`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).then((res) => {
          if (res.status === 409) {
            // Don't await — recovery runs async; this fetch handler returns
            // immediately so the interval can continue (though recoverFrom409
            // stops the interval almost immediately). Worst case: 1 more
            // upload fires before stopPositionUpload runs, also gets 409,
            // gets dropped by recoveryInFlight guard.
            void recoverFrom409();
          }
        }).catch(() => { /* network/abort — best-effort, GC handles stale */ });
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
      sessionIdRef.current = joined.id;
      roomIdRef.current = joined.roomId;
      roomTicketRef.current = joined.roomTicket ?? null;
      setLocalSessionId(joined.id);
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
