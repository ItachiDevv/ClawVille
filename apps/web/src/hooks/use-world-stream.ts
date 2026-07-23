'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LAND_PARCELS_QUERY_KEY } from '@/lib/land-query-keys';
import { useNpcStore } from '@/stores/npc';
import { usePlayerStore } from '@/stores/players';
import { useResearchStore } from '@/stores/research';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { measureSpike } from '@/lib/perf-tracker';
import { useWatchHeartbeat } from '@/hooks/use-watch-heartbeat';

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
  // Ambient-banter watcher heartbeat — visible-tab-only "a human is watching"
  // signal for the server's banter inference gate. See use-watch-heartbeat.ts.
  useWatchHeartbeat();
  const updateNpcsFromSnapshot = useNpcStore((s) => s.updateFromSnapshot);
  const setNpcConnected = useNpcStore((s) => s.setConnected);
  const updatePlayersFromSnapshot = usePlayerStore((s) => s.updateFromSnapshot);
  const setLocalSessionId = usePlayerStore((s) => s.setLocalSessionId);
  const setRoomId = usePlayerStore((s) => s.setRoomId);
  const clearPlayers = usePlayerStore((s) => s.clear);
  const addCollaborationEntries = useResearchStore((s) => s.addCollaborationEntries);
  // Live land-sync (2.1): invalidate the shared land query on a global `land`
  // SSE event so LandStateHydrator refetches and the in-world for-sale signs
  // update within ~1s of another player's buy/claim. The QueryClient instance is
  // stable (one per app), so listing it in the stream effect's deps is a no-op.
  const queryClient = useQueryClient();

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
    async function join(
      recovery = false,
    ): Promise<JoinResponse | { superseded: true } | null> {
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
        if (!res.ok) {
          // Identity-dedup ping-pong guard: a newer DELIBERATE login took over
          // this account's body and THIS was an automatic recovery rejoin, so
          // the server refuses with 409 `presence_superseded`. Surface a
          // distinct sentinel so the caller STOPS (not endless backoff+retry).
          if (res.status === 409) {
            const err = (await res.json().catch(() => null)) as { code?: string } | null;
            if (err?.code === 'presence_superseded') return { superseded: true };
          }
          return null;
        }
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
     * Terminal stop when the server reports `presence_superseded`: a newer
     * deliberate login (another tab/device) now owns this account's single
     * authoritative body. We must NOT keep trying to reclaim it (that would
     * ping-pong the two live sessions), so we cancel the whole stream, leave
     * uploads/SSE down, and tell the user. Reconnecting requires a reload —
     * which is correct, since they're intentionally active elsewhere.
     */
    function handleSuperseded() {
      cancelled = true;
      stopPositionUpload();
      es?.close();
      es = null;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
      setNpcConnected(false);
      try {
        useGameStore
          .getState()
          .addToast('↪️', 'Your session is now active in another tab or device.', 6000);
      } catch {
        /* toast is best-effort */
      }
    }

    /**
     * Drop our presence server-side. The React unmount cleanup covers SPA route
     * changes, but a HARD nav / reload / tab-close / bfcache-enter may tear down
     * the document before React unmount runs — `pagehide` fires there. Without
     * this, the body lingers up to STALE_PLAYER_MS (30s) and other clients (or a
     * fast reload of our own tab) see a stale duplicate. keepalive lets the POST
     * outlive the page; credentials carry our identity so the server resolves the
     * right presence to remove. A second /leave for an already-gone session no-ops.
     */
    function leaveBeacon() {
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        fetch(`${WORLD_API_URL}/api/world/leave`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          keepalive: true,
        }).catch(() => {
          /* fire-and-forget */
        });
      } catch {
        /* ignore — best-effort, GC handles stale */
      }
    }

    // Single in-flight latch shared by BOTH recovery triggers (the /position
    // 409 in player mode AND the SSE onerror in explore/spectate mode) so a
    // 409 and a stream error can't fire two concurrent ticketed rejoins.
    //
    // Sticky-room nuance (2026-06-12): a recovery rejoin can land us in a
    // DIFFERENT roomId than before — the server recreates the wiped room from
    // the ticket, but if that room had filled past the hard cap it spills us to
    // auto-fill. rejoinWithTicket always re-points the SSE at whatever room the
    // rejoin returns, so a changed roomId is handled transparently.
    let recoveryInFlight = false;
    // Set when the onerror handler schedules a BARE same-url reopen (the cheap
    // transient-blip path). Cleared by the stream's `open` handler (blip healed,
    // zero /join cost) OR when we escalate to a ticketed rejoin. If onerror
    // fires AGAIN while this is still set, the bare reopen itself failed — that
    // is the membership-loss signal (a restart wiped our room → the stream 403s
    // on every reopen), so the next attempt escalates to the ticketed /join.
    // This protects the scarce /join budget (server: 3 per 60s per IP) — a
    // transient network blip costs zero /join, only a confirmed membership loss
    // spends one. See es.onerror below.
    let lastAttemptWasBareReopen = false;

    /**
     * Replay the join flow as a RECOVERY rejoin (ticketed), then refresh the
     * session/room/ticket refs + store and RE-POINT the SSE at the room the
     * rejoin landed us in. Returns the rejoined room id on success, or null if
     * the rejoin failed (caller decides how to back off).
     *
     * This is the single authoritative recovery primitive. `recoverFrom409`
     * (player mode) and the SSE onerror handler (explore/spectate mode, where
     * no /position upload ever runs to surface a 409) both delegate here so the
     * ref/store/stream-repoint logic can never drift between the two paths.
     *
     * Always tears down + reopens the SSE against the rejoined room. Both
     * recovery triggers reach here only when membership was (or is about to be)
     * lost — a /position 409 means the server GC'd/restarted our session, and
     * an SSE onerror after a restart means the membership gate is now 403ing —
     * so unconditionally re-pointing the stream is correct and removes any race
     * between the two triggers over who owns reopening the (now stale) stream.
     */
    async function rejoinWithTicket(): Promise<string | null> {
      if (cancelled || recoveryInFlight) return null;
      recoveryInFlight = true;
      try {
        const rejoined = await join(true);
        if (cancelled || !rejoined) return null;
        if ('superseded' in rejoined) {
          handleSuperseded();
          return null;
        }
        sessionIdRef.current = rejoined.id;
        roomIdRef.current = rejoined.roomId;
        roomTicketRef.current = rejoined.roomTicket ?? roomTicketRef.current;
        setLocalSessionId(rejoined.id);
        setRoomId(rejoined.roomId);
        // Re-point the SSE at the room the rejoin landed us in. After a restart
        // the prior stream is dead (onerror) or about to 403 (membership wiped),
        // so we always close + reopen — idempotent if the room is unchanged.
        es?.close();
        es = null;
        // Cancel any pending reconnect a prior onerror queued, so we don't end
        // up with two EventSources racing.
        if (retryTimeout) {
          clearTimeout(retryTimeout);
          retryTimeout = null;
        }
        retriesRef.current = 0;
        openStream(rejoined.roomId);
        return rejoined.roomId;
      } finally {
        recoveryInFlight = false;
      }
    }

    async function recoverFrom409() {
      if (cancelled || recoveryInFlight) return;
      stopPositionUpload();
      const roomId = await rejoinWithTicket();
      if (cancelled) return;
      if (roomId) {
        startPositionUpload();
      }
      // If rejoin failed, the next position upload won't fire (interval stays
      // stopped). The SSE downlink's onerror handler will eventually tear down
      // + ticketed-rejoin the whole flow, restoring uploads.
    }

    function startPositionUpload() {
      if (positionInterval) return;
      positionInterval = setInterval(() => {
        // Skip upload until we've joined a room — sessionId is the auth
        // anchor server-side. Also skip modes where the client does not own
        // the body: explore is spectator-only and autonomous is server-driven.
        const sid = sessionIdRef.current;
        if (!sid) return;
        const { controlMode } = useGameStore.getState();
        if (controlMode === 'explore' || controlMode === 'autonomous') return;

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
        // Stream is live again — whatever the prior failure was (a transient
        // blip that a bare reopen healed, or a ticketed rejoin), it's resolved.
        // Clear the bare-reopen escalation flag so a future error starts fresh.
        lastAttemptWasBareReopen = false;
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

      // Live land-sync (2.1): the server fans a global `land` event to every
      // world-stream subscriber when any player buys/claims a parcel (land is
      // GLOBAL state, not per-room). Invalidate the shared land query so
      // LandStateHydrator refetches authoritative ownership and the in-world
      // for-sale signs update live — no reload, no 60s wait. We refetch rather
      // than trust the event payload, so a malformed event is a harmless refetch.
      es.addEventListener('land', () => {
        void queryClient.invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY });
      });

      es.onerror = () => {
        setNpcConnected(false);
        es?.close();
        es = null;
        // A concurrent ticketed rejoin (e.g. a /position 409 in player mode)
        // is already re-establishing the stream — don't queue a second path.
        if (recoveryInFlight) return;
        retriesRef.current++;
        if (cancelled || retriesRef.current >= MAX_RETRIES) return;
        const delay = Math.min(
          RETRY_DELAY_BASE * Math.pow(2, retriesRef.current - 1),
          RETRY_DELAY_MAX,
        );
        // Membership-loss recovery (2026-06-12, finding R2-4). After an API
        // restart the room registry is wiped, so the stream's membership gate
        // returns 403 and reopening the SAME url just 403s forever. In
        // explore/spectate mode (Hatcher launch) no /position upload ever runs,
        // so the 409 recovery path can never fire — this onerror handler is the
        // ONLY recovery trigger.
        //
        // Two-step escalation to protect the scarce /join budget (server: 3 per
        // 60s per IP — see joinRateLimiter in world.ts):
        //   1. First error → BARE same-url reopen. A transient network blip
        //      (room still valid server-side) heals here for zero /join cost;
        //      the `open` handler clears lastAttemptWasBareReopen.
        //   2. If the bare reopen ALSO errors (flag still set) → membership was
        //      really lost (a restart 403s every reopen). Now escalate: replay
        //      the ticketed /join FIRST (re-acquiring room membership + a fresh
        //      ticket) via rejoinWithTicket, which re-points the stream at the
        //      room the rejoin returns. If the rejoin fails (API still down) we
        //      fall back to a bare reopen so the exp-backoff loop stays alive
        //      and re-escalates on the next error.
        // This spends a /join only on a CONFIRMED membership loss, never on a
        // transient blip — so a flapping stream can't exhaust the 3/min budget.
        const canRejoin = sessionIdRef.current !== null && roomTicketRef.current !== null;
        const shouldEscalate = canRejoin && lastAttemptWasBareReopen;
        retryTimeout = setTimeout(() => {
          if (cancelled) return;
          if (shouldEscalate) {
            lastAttemptWasBareReopen = false;
            void rejoinWithTicket().then((rejoinedRoomId) => {
              // Rejoin failed (null) — API likely still restarting. Reopen the
              // last-known room (a bare reopen) to keep the exp-backoff loop
              // alive; the next onerror re-escalates to the ticketed rejoin.
              if (!cancelled && rejoinedRoomId === null) {
                lastAttemptWasBareReopen = true;
                openStream(roomId);
              }
            });
          } else {
            // Step 1 (or no ticket yet): cheap same-url reopen. Mark it so a
            // follow-on error escalates to the ticketed rejoin.
            lastAttemptWasBareReopen = true;
            openStream(roomId);
          }
        }, delay);
      };
    }

    async function bootstrap() {
      const joined = await join();
      if (cancelled) return;
      if (joined && 'superseded' in joined) {
        // Fresh bootstrap joins never carry a recovery ticket, so the server
        // won't normally supersede them — but handle it defensively so a race
        // (e.g. a second tab opened a beat earlier) parks this tab cleanly
        // instead of looping.
        handleSuperseded();
        return;
      }
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

    // pagehide fires on reload / tab-close / hard nav / bfcache-enter — the
    // cases where React unmount may not run before the page is gone. See
    // leaveBeacon. (visibilitychange→hidden is intentionally NOT used: a plain
    // tab-switch would leave+rejoin-churn and burn the 3/60s join budget.)
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', leaveBeacon);
    }

    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', leaveBeacon);
      }
      es?.close();
      if (retryTimeout) clearTimeout(retryTimeout);
      if (positionInterval) clearInterval(positionInterval);
      setNpcConnected(false);
      // Best-effort leave — server GCs stale players via 30 s timeout.
      leaveBeacon();
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
    queryClient,
  ]);
}
