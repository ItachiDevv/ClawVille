'use client';

/**
 * useActivityWs — single WebSocket lifecycle hook for the Q2 activity room.
 *
 * Owns:
 *  - Connecting to `wss://api.clawville.world/api/activities/:id/rooms/:roomId/ws`
 *    (derives base from `NEXT_PUBLIC_API_URL`; protocol swapped http(s) → ws(s)).
 *  - Sending the auth frame on `open` (Lucia cookie attaches automatically;
 *    we still pass `sessionToken` per protocol — empty string when relying
 *    on the cookie, agent sessionId when running headless).
 *  - Routing inbound frames into `useActivityStore.applyServerFrame()`.
 *  - Ping/pong roundtrip → `setPing(ms)`.
 *  - Reconnect with backoff on unexpected close (10s grace per backend §3.6).
 *
 * Wire format: plain JSON (text frames). The hub on the API side
 * (`apps/api/src/services/activity/activity-ws-hub.ts`) calls JSON.parse
 * on inbound frames and JSON.stringify on outbound — confirmed against
 * source. MessagePack-binary is reserved for a later optimization pass and
 * is gated by `@msgpack/msgpack` dep landing (not in web's package.json
 * today; not adding to keep chunk #4 free of new runtime deps per plan
 * §"Out of scope … new runtime deps that aren't already in dependencies").
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientFrame, ServerFrame } from '@clawville/shared';
import { useActivityStore, type ConnectionStatus } from '@/stores/activity';

// ─── Tuning constants ───────────────────────────────────────────────────────

/** Heartbeat cadence per backend §3.4 — 1 Hz. */
const PING_INTERVAL_MS = 1000;

/**
 * Backend §3.6: "10s reconnect grace with existing sessionId". We retry
 * every 1.5s up to 10s total before the user sees `closed`.
 */
const RECONNECT_GRACE_MS = 10_000;
const RECONNECT_DELAY_MS = 1500;

// ─── Hook signature ─────────────────────────────────────────────────────────

export interface UseActivityWsOptions {
  /** Activity definition id (e.g. 'bumper-shells'). */
  activityId: string;
  /** Room UUID assigned by matchmaker. */
  roomId: string;
  /** Public room short code (`Q7X3RT`); required for the auth frame. */
  shortCode: string;
  /**
   * Lucia session token mirror — pass empty string when the browser cookie
   * is sufficient (server resolves Lucia OR `X-Clawville-Agent-Session`).
   * Agents pass their `agentSessionId`. The auth frame requires a non-empty
   * string, so we send `'cookie'` placeholder when the caller passes ''
   * (server's `requireAuthOrAgentSession` middleware re-resolves via cookie).
   */
  sessionToken?: string;
  /** Set to false to skip opening (e.g. waiting on avatarId / shortCode). */
  enabled?: boolean;
}

export interface UseActivityWsResult {
  send: (frame: ClientFrame) => boolean;
  ping: number;
  status: ConnectionStatus;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export function useActivityWs(opts: UseActivityWsOptions): UseActivityWsResult {
  const {
    activityId,
    roomId,
    shortCode,
    sessionToken = '',
    enabled = true,
  } = opts;

  // Per-tick ping state surfaced to consumers.
  const [ping, setPingLocal] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>('idle');

  // Long-lived refs so React closures don't capture stale wsRef.
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wall-clock when the last close fired — gates reconnect grace window. */
  const lastCloseAtRef = useRef<number>(0);
  /** True after the consumer-initiated unmount/close so we don't reconnect. */
  const intentionallyClosedRef = useRef(false);
  /** Track sentAt of the most-recent ping so pong can compute RTT. */
  const lastPingSentAtRef = useRef(0);

  // Derive WS URL from NEXT_PUBLIC_API_URL — same env var the rest of the
  // client uses (api.ts: HONO_API_URL fallback to localhost:4000 for dev).
  const wsUrl = useMemo(() => {
    if (!enabled || !roomId || !activityId) return null;
    const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const wsBase = base
      .replace(/^http:\/\//i, 'ws://')
      .replace(/^https:\/\//i, 'wss://');
    return `${wsBase}/api/activities/${encodeURIComponent(activityId)}/rooms/${encodeURIComponent(roomId)}/ws`;
  }, [activityId, roomId, enabled]);

  // ── send wrapper (stable identity via useRef) ────────────────────────────
  const sendRef = useRef<(frame: ClientFrame) => boolean>(() => false);
  sendRef.current = (frame: ClientFrame): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      // Buffer full / connection died mid-send — surface as a soft failure.
      console.warn('[useActivityWs] send failed:', err);
      return false;
    }
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!wsUrl) return;

    intentionallyClosedRef.current = false;
    const setStoreStatus = useActivityStore.getState().setConnectionStatus;
    const setStorePing = useActivityStore.getState().setPing;
    const applyFrame = useActivityStore.getState().applyServerFrame;

    function clearTimers() {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function open() {
      if (!wsUrl) return;
      setStatus('connecting');
      setStoreStatus('connecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        console.error('[useActivityWs] construction threw', err);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      // Clock-offset ping loop. MUST NOT start before the server has
      // processed our auth frame: the hub's `onMessage` is async and
      // unserialized, so a ping sent right after auth races the hub's
      // ~200ms identity DB lookup inside `registerConnection` — the hub
      // sees a pre-auth non-auth frame and closes 4001 `auth required`
      // (protocol §3.2: first frame must be auth). The hub sends NOTHING
      // until registration succeeds, so "any server frame received" is
      // proof auth completed — that's the trigger below in `onmessage`.
      // Until the first pong, snapshot reconciliation dead-reckons (its
      // designed fallback), so the ~1 RTT priming delay costs nothing.
      const sendPing = () => {
        const sentAt = Date.now();
        lastPingSentAtRef.current = sentAt;
        sendRef.current({ type: 'ping', sentAt });
      };
      let pingLoopStarted = false;

      ws.onopen = () => {
        setStatus('connected');
        setStoreStatus('connected');

        // First frame MUST be auth per backend §3.2.
        // The Lucia cookie is sent automatically with the WS upgrade because
        // the API hostname matches the cookie domain. We still ship a
        // sessionToken string because the protocol's Zod schema requires
        // `sessionToken: z.string().min(1)` — when the server resolves the
        // identity via cookie this value is ignored. For agent sessions,
        // pass the agent's sessionId via `sessionToken` prop.
        const authToken = sessionToken && sessionToken.length > 0 ? sessionToken : 'cookie';
        sendRef.current({ type: 'auth', sessionToken: authToken, shortCode });
      };

      ws.onmessage = (evt) => {
        // Stale-socket guard (Codex finding 2026-07-14): dependency-driven
        // socket replacement (e.g. an MTT table move changing roomId) closes
        // socket A and opens B; A's late-delivered frames must not feed the
        // NEW room's store, and its close below must not clear B's timers.
        if (wsRef.current !== ws) return;
        if (!pingLoopStarted) {
          // First server frame ⇒ auth registration completed server-side;
          // safe to start the 1 Hz clock-offset ping loop (see note above).
          pingLoopStarted = true;
          sendPing();
          pingIntervalRef.current = setInterval(sendPing, PING_INTERVAL_MS);
        }
        let frame: ServerFrame;
        try {
          // Server emits JSON text frames (confirmed against
          // `apps/api/src/services/activity/activity-ws-hub.ts:507` —
          // `ws.send(JSON.stringify(frame))`).
          frame = JSON.parse(evt.data as string) as ServerFrame;
        } catch (err) {
          console.warn('[useActivityWs] non-JSON frame received', err);
          return;
        }

        // Compute ping RTT for pong frames before delegating to the store.
        if (frame.type === 'pong') {
          const sentAt = frame.sentAt ?? lastPingSentAtRef.current;
          if (sentAt) {
            const rtt = Math.max(0, Date.now() - sentAt);
            setPingLocal(rtt);
            setStorePing(rtt);
          }
        }

        try {
          applyFrame(frame);
        } catch (err) {
          // Defensive — store mutations should never throw, but if they do
          // we don't want one bad frame to kill the socket.
          console.error('[useActivityWs] applyServerFrame threw', err);
        }
      };

      ws.onerror = (evt) => {
        console.warn('[useActivityWs] socket error', evt);
        // onclose will fire after; no state mutation here.
      };

      ws.onclose = (evt) => {
        // Stale-socket guard: if this socket was already replaced (cleanup
        // nulled wsRef and a new open() installed socket B), its delayed
        // onclose must not clear B's ping interval, null B out of wsRef, or
        // schedule a competing reconnect. The effect cleanup that replaced us
        // already cleared OUR timers via clearTimers().
        if (wsRef.current !== ws) return;
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        wsRef.current = null;
        lastCloseAtRef.current = Date.now();

        if (intentionallyClosedRef.current) {
          setStatus('closed');
          setStoreStatus('closed');
          return;
        }

        // 4xxx fatal codes — don't retry blindly. UNAUTHORIZED is the most
        // common (cookie expired); INTEGRITY/CONCURRENCY_CAP are server
        // policies the user can't recover from. Surface as `closed`.
        // 4001=UNAUTHORIZED, 4002=SLOW_READ (transient OK), 4003=INTEGRITY,
        // 4004=CONCURRENCY_CAP.
        if (evt.code === 4001 || evt.code === 4003 || evt.code === 4004) {
          console.warn(`[useActivityWs] fatal close code ${evt.code} — not reconnecting`);
          setStatus('closed');
          setStoreStatus('closed');
          return;
        }

        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (intentionallyClosedRef.current) return;
      const elapsed = lastCloseAtRef.current ? Date.now() - lastCloseAtRef.current : 0;
      if (elapsed > RECONNECT_GRACE_MS) {
        // Grace exhausted — give up.
        setStatus('closed');
        setStoreStatus('closed');
        return;
      }
      setStatus('reconnecting');
      setStoreStatus('reconnecting');
      reconnectTimerRef.current = setTimeout(() => {
        if (intentionallyClosedRef.current) return;
        open();
      }, RECONNECT_DELAY_MS);
    }

    open();

    return () => {
      intentionallyClosedRef.current = true;
      clearTimers();
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          // Best-effort graceful leave per protocol §"Client → Server: leave".
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'leave' }));
          }
        } catch {
          /* ignore */
        }
        try {
          ws.close(1000, 'unmount');
        } catch {
          /* ignore */
        }
      }
      wsRef.current = null;
      // Don't push `closed` into the store on unmount — the next page mount
      // resets it via `useActivityStore.getState().reset(roomId)`.
    };
  }, [wsUrl, shortCode, sessionToken]);

  return {
    send: sendRef.current,
    ping,
    status,
  };
}
