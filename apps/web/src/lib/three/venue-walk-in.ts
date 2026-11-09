import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useTransitionStore } from '@/components/transitions/SceneTransition';
import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { TRADING_FLOOR_DOOR_PX } from './trading-floor/trading-floor-location';
import { isStageSceneAvailable } from '@/lib/world-renderer-mode';
// ---------------------------------------------------------------------------
// Cove walk-in flow — Phase 6.0.3
//
// 1. Avatar pathfinds toward the cove door position (game-px coords).
//    Door target: ~300 game-px east of cove building center so the avatar
//    approaches from the plaza rather than teleporting inside the building.
//    The door sits at WORLD (−4820, 0) — invariant across world grows.
//    Derived from the map center so a future grow re-centers automatically:
//      game-px x = MAP_WIDTH/2 − 4820,  game-px y = MAP_HEIGHT/2 (center row).
//    Phase 0 land (2026-06-15): center 5760→9216 ⇒ door (940,5760)→(4396,9216).
// 2. When within DOOR_ARRIVE_DIST (200 game-px) of door target OR after
//    MAX_WAIT_MS (1500ms) — whichever comes first — trigger the SceneTransition.
// 3. SceneTransition fades to black (500ms), mid-fade pushes to /cove,
//    cove page fades in (500ms). Total flow ≤ 3s per plan acceptance criteria.
// ---------------------------------------------------------------------------

// Tunnel corridor (pass 4): group anchor world X = -3510; mouth at local X=+135 = world -3375.
// Door target = mid-tunnel (local X≈+60 = world -3450) so avatar walks INTO the corridor
// before the fade fires, making it feel like they're stepping through.
// Pass 1–3 value: MAP_WIDTH/2 - 3650 (outside arch). Pass 4: MAP_WIDTH/2 - 3450.
// Pass 5: tunnel extended to 470wu; mouth at world -3275, mid-tunnel at world -3400.
// MAP_WIDTH/2 - 3400 = world X -3400 = local X+110, well inside the 470wu corridor.
/** Cove door position in game-px — targets mid-tunnel interior so avatar walks through. */
const COVE_DOOR_PX = { x: MAP_WIDTH / 2 - 3400, y: MAP_HEIGHT / 2 };
// Trading Floor door target — derived from the `cron-automation` ring zone in
// trading-floor-location.ts, so a ring move or a world grow carries it.
/** Avatar must be within this distance (game-px) to trigger the fade. */
const DOOR_ARRIVE_DIST = 200;
/** Hard timeout before triggering fade even if avatar hasn't arrived. */
const MAX_WALK_WAIT_MS = 1500;
/** Idempotency guard: true while a venue walk-in is in flight (clickPath + poll
 *  running, before the SceneTransition fires). A second trigger for the SAME
 *  venue — double-click, the click/E race, or a fast-travel arrival landing
 *  here — is a no-op so the walk is not restarted from the current position.
 *  One box per venue; cross-venue supersede is the token below. */
const _coveWalkInPending = { value: false };
const _tradingFloorWalkInPending = { value: false };

/**
 * Cross-venue supersede token (Codex adversarial finding, 2026-09-19).
 *
 * Per-venue guards alone let TWO polls run at once: click the Cove, then the
 * Trading Floor inside the 1500 ms window, and the cove poll still owns the
 * click path it no longer set. Whichever poll fires first clears the path and
 * navigates, so the player's LATER choice silently loses.
 *
 * Every start bumps this counter and captures its value. A poll whose captured
 * value no longer matches is stale: it returns without clearing the path and
 * without navigating, leaving the newest walk-in untouched. Monotonic, so a
 * stale poll can never alias a live one.
 */
let _walkInToken = 0;
/** The guard box of the walk-in currently in flight, if any. */
let _activeWalkInPending: { value: boolean } | null = null;

/** Invalidate the in-flight walk-in (if any) and return the new token. */
function supersedeActiveWalkIn(): number {
  _walkInToken += 1;
  if (_activeWalkInPending) {
    _activeWalkInPending.value = false;
    _activeWalkInPending = null;
  }
  return _walkInToken;
}

/**
 * True when the world no longer owns the walk: the body was dropped for the
 * free-flying explore camera, or the route already left /game by some other
 * path. An environment with no real `location` (tests, SSR) must NOT count as
 * "left /game", or the poll would cancel itself immediately.
 */
function walkInAbandoned(controlMode: string): boolean {
  if (controlMode === 'explore') return true;
  if (typeof window === 'undefined') return false;
  const pathname = window.location?.pathname;
  return typeof pathname === 'string' && pathname.length > 0 && pathname !== '/game';
}

/** Stage venues reachable by a walk-in from /game. */
type WalkInVenuePath = '/cove' | '/trading-floor';

function navigateToStageVenue(to: WalkInVenuePath): void {
  if (
    requestWorldStageNavigation({
      to,
      onExpired: () => {
        if (
          typeof window !== 'undefined' &&
          window.location.pathname === '/game'
        ) {
          useTransitionStore.getState().triggerTransition({ to });
        }
      },
    })
  ) {
    return;
  }
  useTransitionStore.getState().triggerTransition({ to });
}

interface WalkInSpec {
  /** Door target in game-px. */
  readonly doorPx: { readonly x: number; readonly y: number };
  readonly to: WalkInVenuePath;
  /** DOM event the camera controller listens for, or null for no camera push. */
  readonly cameraEvent: string | null;
}

/**
 * Shared walk-in: set a two-waypoint click-path to the venue door, poll
 * `avatarPositionRef` until arrival (or timeout), then hand the crossing to the
 * persistent stage.
 *
 * Deliberately avoids React state so it can be called from the module-scope
 * BUILDING_MODELS onClick without needing a hook context.
 */
function startVenueWalkIn(
  spec: WalkInSpec,
  pending: { value: boolean },
): void {
  if (!isStageSceneAvailable(spec.to.slice(1))) { useGameStore.getState().addToast('3D', 'This venue needs the 3D view. Use the view selector to switch.'); return; }
  const store = useGameStore.getState();

  // Only walk in player/npc mode — in explore mode there is no avatar to walk.
  if (store.controlMode === 'explore') {
    // Fallback for explore mode: direct transition, no walk. Still supersedes,
    // so a poll started before the mode flip cannot navigate afterwards.
    supersedeActiveWalkIn();
    navigateToStageVenue(spec.to);
    return;
  }

  // Idempotent for the SAME venue: a second click must not restart the walk
  // from wherever the avatar has got to.
  if (pending.value) return;

  // A DIFFERENT venue was in flight: the newest choice wins outright.
  const token = supersedeActiveWalkIn();
  pending.value = true;
  _activeWalkInPending = pending;

  /** Release this walk-in's ownership. Safe to call from a stale poll. */
  function release(): void {
    pending.value = false;
    if (_activeWalkInPending === pending) _activeWalkInPending = null;
  }

  // Two waypoints: current position → door target.
  // player-avatar.tsx (the clickPath consumer) drives the avatar along it.
  store.setClickPath(
    [
      { x: avatarPositionRef.x, y: avatarPositionRef.y },
      { x: spec.doorPx.x, y: spec.doorPx.y },
    ],
    null,
  );

  // Signal the camera controller to push toward the venue. The handler in
  // World3DCanvas.tsx reads this event and drifts the camera for ~1.2s.
  if (spec.cameraEvent !== null && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(spec.cameraEvent));
  }

  const startMs = Date.now();

  function poll() {
    // Superseded by a later walk-in: do NOTHING. Clearing the click path or
    // navigating here is exactly the bug this token exists to stop.
    if (_walkInToken !== token) return;

    const current = useGameStore.getState();
    if (walkInAbandoned(current.controlMode)) {
      release();
      current.clearClickPath();
      return;
    }

    const dx = avatarPositionRef.x - spec.doorPx.x;
    const dy = avatarPositionRef.y - spec.doorPx.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = Date.now() - startMs;

    if (dist <= DOOR_ARRIVE_DIST || elapsed >= MAX_WALK_WAIT_MS) {
      // Avatar has arrived (or timed out) — clear the path and fade.
      release();
      current.clearClickPath();
      navigateToStageVenue(spec.to);
      return;
    }

    requestAnimationFrame(poll);
  }

  requestAnimationFrame(poll);
}

const COVE_WALK_IN: WalkInSpec = {
  doorPx: COVE_DOOR_PX,
  to: '/cove',
  cameraEvent: 'cove-walkin-start',
};

const TRADING_FLOOR_WALK_IN: WalkInSpec = {
  doorPx: TRADING_FLOOR_DOOR_PX,
  to: '/trading-floor',
  // No bespoke camera push yet — the stage fade covers the crossing. Adding
  // one means a second listener in World3DCanvas, which is not worth a slot
  // whose door already faces the default camera heading.
  cameraEvent: null,
};

/** triggerCoveWalkIn() — called when the user clicks/presses E on the cove. */
export function triggerCoveWalkIn(): void {
  startVenueWalkIn(COVE_WALK_IN, _coveWalkInPending);
}

/**
 * triggerTradingFloorWalkIn() — the Trading Floor's cove-shaped entry
 * (founder order 2026-09-19). Walks the avatar to the building's north face,
 * then crosses to the `/trading-floor` stage slot.
 */
export function triggerTradingFloorWalkIn(): void {
  startVenueWalkIn(TRADING_FLOOR_WALK_IN, _tradingFloorWalkInPending);
}

/** Test seam — both walk-in guards, so a test can assert idempotency. */
export function readVenueWalkInPendingForTests(): {
  cove: boolean;
  tradingFloor: boolean;
} {
  return {
    cove: _coveWalkInPending.value,
    tradingFloor: _tradingFloorWalkInPending.value,
  };
}

/** Test seam — clears both guards and the supersede token between cases. */
export function resetVenueWalkInPendingForTests(): void {
  _coveWalkInPending.value = false;
  _tradingFloorWalkInPending.value = false;
  _activeWalkInPending = null;
  _walkInToken += 1;
}

