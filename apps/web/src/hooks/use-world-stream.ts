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
import {
  WORLD_STREAM_TICK_MS,
  createWorldStreamMachineState,
  decide,
  type ActivePresenceActivity,
  type WorldPresencePolicy,
  type WorldStreamMachineInput,
} from '@/hooks/world-stream-machine';
import { decideWorldDownlink } from '@/hooks/world-downlink-policy';

const WORLD_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const MAX_RETRIES = 20;
const RETRY_DELAY_BASE = 3000;
const RETRY_DELAY_MAX = 60000;
const JOIN_TIMEOUT_MS = 15_000;
const RECOVERY_WAIT_CEILING_MS = 30_000;
/** Position upload rate — matches the server NPC sim tick (5 Hz / 200 ms). */
/** Minimum game-pixel movement that flips activity from 'idle' → 'walking'. */
const ACTIVITY_MOTION_EPSILON_PX = 0.5;
/** Minimum heading change that warrants an absolute pose upload. */
const HEADING_MOTION_EPSILON_RAD = 0.01;

interface ActivePresencePose {
  x: number;
  y: number;
  dirZ: number;
  activity: ActivePresenceActivity;
}

interface SentPresencePose {
  x: number;
  y: number;
  dirZ: number;
  activity: string;
}

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

type JoinOutcome =
  | { kind: 'joined'; data: JoinResponse }
  | { kind: 'superseded' }
  | { kind: 'failed' }
  | { kind: 'timeout' };

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
 *   4. A mount-owned 5 Hz machine interval triggers bootstrap/recovery and
 *      POSTs active movement or the 10 s route-specific remote heartbeat. The
 *      heading is computed from a 1-tick velocity tracker (atan2(vx, vy)
 *      matches the VRM facing convention used elsewhere in the renderer).
 *   5. On unmount: close SSE, clear position interval, call `/api/world/leave`
 *      best-effort (fire-and-forget — server GCs stale players after 30 s).
 *
 * Reconnect: standard exp backoff (3 s, 6 s, 12 s … capped 60 s, up to 20
 * attempts). Mirrors `useNpcStream`. The position interval keeps running
 * across reconnects — server is idempotent on `lastPositionUpdateAt`.
 */
export function useWorldStream(
  policy: WorldPresencePolicy,
  remoteActivity?: string,
  downlinkEnabled = true,
) {
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const remoteActivityRef = useRef(remoteActivity);
  remoteActivityRef.current = remoteActivity;
  const downlinkEnabledRef = useRef(downlinkEnabled);
  downlinkEnabledRef.current = downlinkEnabled;
  // Ambient-banter watcher heartbeat — visible-tab-only "a human is watching"
  // signal for the server's banter inference gate. See use-watch-heartbeat.ts.
  useWatchHeartbeat(policy === 'active');
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
  const frozenPositionRef = useRef<{ x: number; y: number; dirZ: number } | null>(
    null,
  );
  const initialActivePoseRef = useRef<ActivePresencePose | null>(null);
  const lastSentPoseRef = useRef<SentPresencePose | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let machineInterval: ReturnType<typeof setInterval> | null = null;
    let machineState = createWorldStreamMachineState();
    let cancelled = false;
    let streamEpoch = 0;
    let retryTokenSeq = 0;
    let activeRetryToken: number | null = null;
    let recoveryInFlight = false;
    let recoveryLeaseSeq = 0;
    let activeRecoveryLease: number | null = null;
    let lastAttemptWasBareReopen = false;

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
      signal?: AbortSignal,
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
          signal,
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

    async function joinWithBody(
      recovery: boolean,
      signal?: AbortSignal,
    ): Promise<JoinOutcome> {
      const joined = await join(recovery, signal);
      if (!joined) return { kind: 'failed' };
      if ('superseded' in joined) return { kind: 'superseded' };
      return { kind: 'joined', data: joined };
    }

    async function withDeadline<T>(
      operation: Promise<T>,
      ms: number,
    ): Promise<{ settled: T } | { timedOut: true }> {
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
      });
      try {
        return await Promise.race([
          operation.then((settled) => ({ settled })),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    async function joinBounded(): Promise<
      JoinResponse | { superseded: true } | null
    > {
      const controller = new AbortController();
      const outcome = await withDeadline(
        join(false, controller.signal),
        JOIN_TIMEOUT_MS,
      );
      if ('timedOut' in outcome) {
        controller.abort();
        return null;
      }
      return outcome.settled;
    }

    function dropFailedSource(source: EventSource) {
      if (es !== source) return;
      source.close();
      es = null;
    }

    function invalidateStream() {
      streamEpoch += 1;
      activeRetryToken = null;
      es?.close();
      es = null;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }
    }

    function closeStream() {
      invalidateStream();
      retriesRef.current = 0;
      lastAttemptWasBareReopen = false;
      setNpcConnected(false);
      clearPlayers();
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
      machineState = decide(machineState, {
        type: 'SUPERSEDED',
        now: Date.now(),
      }).nextState;
      cancelled = true;
      if (machineInterval) {
        clearInterval(machineInterval);
        machineInterval = null;
      }
      invalidateStream();
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
    // Set when the onerror handler schedules a BARE same-url reopen (the cheap
    // transient-blip path). Cleared by the stream's `open` handler (blip healed,
    // zero /join cost) OR when we escalate to a ticketed rejoin. If onerror
    // fires AGAIN while this is still set, the bare reopen itself failed — that
    // is the membership-loss signal (a restart wiped our room → the stream 403s
    // on every reopen), so the next attempt escalates to the ticketed /join.
    // This protects the scarce /join budget (server: 3 per 60s per IP) — a
    // transient network blip costs zero /join, only a confirmed membership loss
    // spends one. See es.onerror below.

    /**
     * Replay the join flow as a RECOVERY rejoin (ticketed), then refresh the
     * session/room/ticket refs + store and RE-POINT the SSE at the room the
     * rejoin landed us in. Returns the rejoined room id on success, or null if
     * the rejoin failed (caller decides how to back off).
     *
     * This is the single authoritative recovery primitive. The machine's 409
     * recovery and the SSE onerror handler both delegate here so the
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
      const lease = ++recoveryLeaseSeq;
      activeRecoveryLease = lease;

      let resolveDone!: (value: string | null) => void;
      const done = new Promise<string | null>((resolve) => {
        resolveDone = resolve;
      });
      const controller = new AbortController();
      const deadlineTimer = setTimeout(() => {
        controller.abort();
        resolveDone(settleRecovery(lease, { kind: 'timeout' }));
      }, JOIN_TIMEOUT_MS);

      void joinWithBody(true, controller.signal).then(
        (outcome) => {
          clearTimeout(deadlineTimer);
          resolveDone(settleRecovery(lease, outcome));
        },
        () => {
          clearTimeout(deadlineTimer);
          resolveDone(settleRecovery(lease, { kind: 'failed' }));
        },
      );

      return done;
    }

    function settleRecovery(
      lease: number,
      outcome: JoinOutcome,
    ): string | null {
      if (activeRecoveryLease !== lease) return null;
      activeRecoveryLease = null;
      recoveryInFlight = false;
      if (cancelled) return null;
      if (outcome.kind === 'superseded') {
        handleSuperseded();
        return null;
      }
      if (outcome.kind !== 'joined') {
        transitionMachine({ type: 'RECOVERY_FAILED', now: Date.now() });
        return null;
      }

      sessionIdRef.current = outcome.data.id;
      roomIdRef.current = outcome.data.roomId;
      roomTicketRef.current =
        outcome.data.roomTicket ?? roomTicketRef.current;
      setLocalSessionId(outcome.data.id);
      setRoomId(outcome.data.roomId);
      invalidateStream();
      retriesRef.current = 0;
      if (downlinkEnabledRef.current) {
        openStream(outcome.data.roomId);
      }
      transitionMachine({ type: 'RECOVERY_OK', now: Date.now() });
      return outcome.data.roomId;
    }

    function postPosition(body: string) {
      fetch(`${WORLD_API_URL}/api/world/position`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
        .then((res) => {
          if (res.status === 409) {
            transitionMachine({ type: 'POSITION_409', now: Date.now() });
          }
        })
        .catch(() => {
          /* network/abort — best-effort, GC handles stale */
        });
    }

    function sampleActivePosition(now: number): ActivePresencePose {
      const x = avatarPositionRef.x;
      const y = avatarPositionRef.y;
      const prev = lastPosRef.current;
      let activity: ActivePresenceActivity = 'idle';
      if (prev) {
        const dx = x - prev.x;
        const dy = y - prev.y;
        const motionSq = dx * dx + dy * dy;
        if (motionSq > ACTIVITY_MOTION_EPSILON_PX * ACTIVITY_MOTION_EPSILON_PX) {
          activity = 'walking';
          lastDirZRef.current = Math.atan2(dx, dy);
        }
      }
      lastPosRef.current = { x, y, ts: now };
      frozenPositionRef.current = { x, y, dirZ: lastDirZRef.current };
      const pose = { ...frozenPositionRef.current, activity };
      initialActivePoseRef.current ??= pose;
      return pose;
    }

    function activePoseChanged(pose: ActivePresencePose): boolean {
      const reference = lastSentPoseRef.current ?? initialActivePoseRef.current;
      if (!reference) return false;

      const dx = pose.x - reference.x;
      const dy = pose.y - reference.y;
      const positionChanged =
        dx * dx + dy * dy >
        ACTIVITY_MOTION_EPSILON_PX * ACTIVITY_MOTION_EPSILON_PX;
      const headingDelta = Math.abs(
        Math.atan2(
          Math.sin(pose.dirZ - reference.dirZ),
          Math.cos(pose.dirZ - reference.dirZ),
        ),
      );
      return (
        positionChanged ||
        headingDelta > HEADING_MOTION_EPSILON_RAD ||
        pose.activity !== reference.activity
      );
    }

    function uploadActivePosition(pose: ActivePresencePose) {
      lastSentPoseRef.current = pose;
      initialActivePoseRef.current = null;
      postPosition(JSON.stringify(pose));
    }

    function uploadRemotePosition() {
      const frozen = frozenPositionRef.current;
      if (!frozen) return;
      const pose = {
        ...frozen,
        activity: remoteActivityRef.current ?? 'idle',
      };
      lastSentPoseRef.current = pose;
      postPosition(JSON.stringify(pose));
    }

    async function recoverWithTicket(): Promise<string | null> {
      if (cancelled || recoveryInFlight) return null;
      return rejoinWithTicket();
    }

    function armRetry(
      roomId: string,
      delayMs: number,
      shouldEscalate: boolean,
      deferredSince: number | null = null,
    ) {
      const token = ++retryTokenSeq;
      activeRetryToken = token;
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        if (
          cancelled ||
          activeRetryToken !== token ||
          !downlinkEnabledRef.current
        ) {
          return;
        }

        if (recoveryInFlight) {
          const since = deferredSince ?? Date.now();
          if (Date.now() - since >= RECOVERY_WAIT_CEILING_MS) {
            activeRetryToken = null;
            return;
          }
          armRetry(roomId, delayMs, shouldEscalate, since);
          return;
        }

        if (!shouldEscalate) {
          lastAttemptWasBareReopen = true;
          openStream(roomId);
          return;
        }

        lastAttemptWasBareReopen = false;
        void recoverWithTicket().then((rejoinedRoomId) => {
          if (cancelled || rejoinedRoomId !== null) return;
          if (recoveryInFlight) {
            armRetry(
              roomId,
              delayMs,
              shouldEscalate,
              deferredSince ?? Date.now(),
            );
            return;
          }
          if (
            activeRetryToken !== token ||
            !downlinkEnabledRef.current
          ) {
            return;
          }
          lastAttemptWasBareReopen = true;
          openStream(roomId);
        });
      }, delayMs);
    }

    function runMachineAction(
      action: ReturnType<typeof decide>['actions'][number],
      now: number,
      activePose?: ActivePresencePose,
    ) {
      switch (action) {
        case 'BOOTSTRAP':
          void bootstrap();
          break;
        case 'RESET_ACTIVE_POSITION':
          lastPosRef.current = {
            x: avatarPositionRef.x,
            y: avatarPositionRef.y,
            ts: now,
          };
          break;
        case 'UPLOAD_ACTIVE':
          if (activePose) uploadActivePosition(activePose);
          break;
        case 'UPLOAD_REMOTE':
          uploadRemotePosition();
          break;
        case 'RECOVER':
          void recoverWithTicket();
          break;
      }
    }

    function transitionMachine(
      input: WorldStreamMachineInput,
      activePose?: ActivePresencePose,
    ) {
      const decision = decide(machineState, input);
      machineState = decision.nextState;
      for (const action of decision.actions) {
        runMachineAction(action, input.now, activePose);
      }
    }

    function runMachineTick() {
      const { controlMode } = useGameStore.getState();
      const now = Date.now();
      const currentPolicy = policyRef.current;
      const downlinkAction = decideWorldDownlink({
        wanted: downlinkEnabledRef.current,
        open: es !== null,
        pendingReopen: activeRetryToken !== null,
        recoveryInFlight,
        hasSession: sessionIdRef.current !== null,
        hasRoom: roomIdRef.current !== null,
      });
      if (downlinkAction === 'CLOSE') {
        closeStream();
      } else if (downlinkAction === 'OPEN') {
        openStream(roomIdRef.current!);
        void queryClient.invalidateQueries({
          queryKey: LAND_PARCELS_QUERY_KEY,
        });
      }
      const activePose =
        currentPolicy === 'active' ? sampleActivePosition(now) : undefined;
      transitionMachine({
        type: 'TICK',
        now,
        policy: currentPolicy,
        hasSession: sessionIdRef.current !== null,
        canUpload: controlMode !== 'explore' && controlMode !== 'autonomous',
        hasFrozenPosition: frozenPositionRef.current !== null,
        recoveryInFlight,
        poseChanged: activePose ? activePoseChanged(activePose) : false,
        activeActivity: activePose?.activity ?? 'idle',
      }, activePose);
    }

    function openStream(roomId: string) {
      if (cancelled || retriesRef.current >= MAX_RETRIES) return;
      activeRetryToken = null;
      streamEpoch += 1;
      const epoch = streamEpoch;
      const url = `${WORLD_API_URL}/api/world/${encodeURIComponent(roomId)}/stream`;
      const source = new EventSource(url, { withCredentials: true });
      es = source;

      source.addEventListener('open', () => {
        if (epoch !== streamEpoch) return;
        if (!downlinkEnabledRef.current) return;
        if (es !== source) return;
        retriesRef.current = 0;
        // Stream is live again — whatever the prior failure was (a transient
        // blip that a bare reopen healed, or a ticketed rejoin), it's resolved.
        // Clear the bare-reopen escalation flag so a future error starts fresh.
        lastAttemptWasBareReopen = false;
        setNpcConnected(true);
      });

      source.addEventListener('snapshot', (event) => {
        if (epoch !== streamEpoch) return;
        if (!downlinkEnabledRef.current) return;
        if (es !== source) return;
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
      source.addEventListener('land', () => {
        if (epoch !== streamEpoch) return;
        if (!downlinkEnabledRef.current) return;
        if (es !== source) return;
        void queryClient.invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY });
      });

      source.onerror = () => {
        if (epoch !== streamEpoch) return;
        if (!downlinkEnabledRef.current) return;
        if (es !== source) return;
        setNpcConnected(false);
        dropFailedSource(source);
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
        armRetry(roomId, delay, shouldEscalate);
      };
    }

    async function bootstrap() {
      const joined = await joinBounded();
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
        transitionMachine({ type: 'BOOTSTRAP_FAILED', now: Date.now() });
        return;
      }
      transitionMachine({ type: 'BOOTSTRAP_OK', now: Date.now() });
      sessionIdRef.current = joined.id;
      roomIdRef.current = joined.roomId;
      roomTicketRef.current = joined.roomTicket ?? null;
      setLocalSessionId(joined.id);
      setRoomId(joined.roomId);
      if (downlinkEnabledRef.current) {
        openStream(joined.roomId);
      }
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (!event.persisted) return;
      closeStream();
      sessionIdRef.current = null;
      roomIdRef.current = null;
      setLocalSessionId(null);
      clearPlayers();
    }

    machineInterval = setInterval(runMachineTick, WORLD_STREAM_TICK_MS);

    // pagehide fires on reload / tab-close / hard nav / bfcache-enter — the
    // cases where React unmount may not run before the page is gone. See
    // leaveBeacon. (visibilitychange→hidden is intentionally NOT used: a plain
    // tab-switch would leave+rejoin-churn and burn the 3/60s join budget.)
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', leaveBeacon);
      window.addEventListener('pageshow', handlePageShow);
    }

    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', leaveBeacon);
        window.removeEventListener('pageshow', handlePageShow);
      }
      invalidateStream();
      if (machineInterval) clearInterval(machineInterval);
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
