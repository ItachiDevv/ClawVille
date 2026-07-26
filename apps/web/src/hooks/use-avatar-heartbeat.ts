'use client';

/**
 * useAvatarHeartbeat — presence heartbeat for the logged-in avatar while the
 * HUMAN is driving it (agent-magic-link-onboarding D3, 2026-07-02).
 *
 * Why this exists: when a connected agent's human takes the wheel (Controlled /
 * 'player' mode — e.g. after clicking the agent's magic control link), the
 * server suppresses the agent's own in-world `ocb-` body so there is no double
 * body, via a short-TTL mark (`markHumanControlledOpenClaw`, TTL ≈ 15s). The
 * mark is re-armed by `POST /api/avatars/me/heartbeat` carrying
 * `{ controlMode: 'player' }`, so the client MUST re-send on a cadence shorter
 * than that TTL for the suppression to hold. Before this hook the endpoint had
 * ZERO web callers (`api.sendHeartbeat` was dead code — live position sync
 * goes over the world-stream `/api/world/position` uplink instead), so the
 * suppression could never hold; this hook is the driver.
 *
 * Cadence:
 *  - PLAYER_HEARTBEAT_INTERVAL_MS = 10s — must be < the server's ≈15s
 *    suppression TTL; 10s leaves a 5s margin for network latency and mild
 *    background-tab timer throttling. (If the tab is hidden long enough for
 *    Chrome's intensive throttling to stretch the interval past the TTL, the
 *    suppression lapses and the agent body returns — acceptable and arguably
 *    correct: a human who tabbed away is not driving.)
 *  - MODE_POLL_INTERVAL_MS = 1s — the tick itself is just a
 *    `useGameStore.getState()` read + comparison (no React subscription, no
 *    re-renders — hot-path discipline per CLAUDE.md), so polling at 1s is
 *    effectively free and lets an entry into 'player' (ticket landing,
 *    Autonomous→Controlled toggle) send its first heartbeat within ≤1s
 *    instead of waiting a full 10s beat.
 *
 * Send gate: heartbeats fire ONLY while `controlMode === 'player'`. In
 * 'autonomous'/'npc'/'explore' nothing is sent — the server mark simply
 * expires (≤15s) and the agent body returns, which is the designed release
 * path (D3: "'autonomous'/absent → no mark → suppression lapses"). Not
 * sending outside 'player' also keeps `bridge.reportUserActivity` (which the
 * heartbeat route calls, snapping the avatar back to user control) from
 * fighting the agent while it self-drives.
 *
 * Security: this is a plain Lucia-cookie authed call. It never touches (and
 * must never touch) an agent sessionId — the client cannot hold the agent
 * bearer after a reload by design (see game/page.tsx agent-session hydration).
 */

import { useEffect } from 'react';
import { WORLD_PX_WIDTH, WORLD_PX_HEIGHT } from '@clawville/shared';
import { useGameStore, avatarPositionRef, type ControlMode } from '@/stores/game';
import { api } from '@/lib/api';

/** Re-send cadence while the human drives — MUST stay < the server's ≈15s suppression TTL. */
const PLAYER_HEARTBEAT_INTERVAL_MS = 10_000;
/** Cheap store-poll tick — catches mode flips fast without a React subscription. */
const MODE_POLL_INTERVAL_MS = 1_000;
/** Soft retry delay after a failed send — quicker than a full beat, but never 1 Hz hammering. */
const FAILURE_RETRY_MS = 3_000;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * @param enabled Gate from the world-layout owner:
 *   `isAuthenticated && !isGuest && !!avatar`.
 *   The endpoint is `requireAuth` and guests never reach 'player' mode, so
 *   this keeps unauthenticated sessions from 401-spamming. Must be passed
 *   (not conditionally calling the hook) to respect the Rules of Hooks.
 */
export function useAvatarHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    // Effect-local state — recreated whenever `enabled` flips, which is the
    // correct reset semantics (a fresh login starts a fresh cadence).
    let inFlight = false;
    let lastAttemptAt = 0;
    let lastFailed = false;
    let lastMode: ControlMode | null = null;

    const tick = () => {
      const { controlMode } = useGameStore.getState();
      // Transition detection: entering 'player' (ticket landing, toggle from
      // Autonomous) sends immediately so the no-double-body suppression takes
      // hold without waiting out a full 10s beat.
      const enteredPlayer = controlMode === 'player' && lastMode !== 'player';
      lastMode = controlMode;
      if (controlMode !== 'player') return; // release path = server TTL lapse
      if (inFlight) return;

      const now = Date.now();
      const waitMs = lastFailed ? FAILURE_RETRY_MS : PLAYER_HEARTBEAT_INTERVAL_MS;
      if (!enteredPlayer && now - lastAttemptAt < waitMs) return;

      inFlight = true;
      lastAttemptAt = now;
      // avatarPositionRef is the per-frame-accurate game-px position (written
      // by the movement loop; same source the world-stream uplink reads).
      // Defensive clamp: the server's Zod schema rejects out-of-bounds with a
      // 400, and the ref should always be in-bounds — the clamp is free
      // insurance against a transient out-of-map write.
      const x = clamp(avatarPositionRef.x, 0, WORLD_PX_WIDTH);
      const y = clamp(avatarPositionRef.y, 0, WORLD_PX_HEIGHT);
      api
        .sendHeartbeat(x, y, 'player')
        .then(() => {
          lastFailed = false;
        })
        .catch(() => {
          // Best-effort: a lapse just means the agent body reappears until
          // the next successful beat. Retry sooner (3s) but never at 1 Hz.
          lastFailed = true;
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const id = setInterval(tick, MODE_POLL_INTERVAL_MS);
    // Immediate first check — a ticket-landed human is already in 'player'
    // when this mounts; don't leave the agent's body up for an extra second.
    tick();

    return () => clearInterval(id);
  }, [enabled]);
}
