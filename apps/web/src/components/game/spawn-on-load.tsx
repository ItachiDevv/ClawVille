'use client';

/**
 * spawn-on-load.tsx — home-vs-town spawn placement (town-fast-travel, 2026-06-19).
 *
 * Renders NOTHING. On game mount, for a logged-in player whose avatar has
 * `spawnPreference === 'home'` AND a `homeParcelId` that resolves (via
 * GET /api/land/me) to an OWNED parcel with gridX/gridY, it repositions the
 * avatar to that parcel's WORLD coords + the same session scatter the town
 * spawn uses. Otherwise it leaves the town-center spawn (the store default)
 * untouched.
 *
 * Coordinate conversion (EXACT, reused — see land-parcels.tsx / seed):
 *   The seed stamps  gridX = floor((parcel.cx + HALF_MAP_WU) / TILE_SIZE),
 *   HALF_MAP_WU = (576/2)*32 = 9216 = MAP_WIDTH/2 (== -OFFSET).
 *   game-px = worldWu + HALF_MAP_WU, and worldWu = gridX*TILE_SIZE + OFFSET,
 *   so  game-px(parcel center) = gridX * TILE_SIZE  (and gridY * TILE_SIZE).
 *   TILE_SIZE = 32, OFFSET = -MAP_WIDTH/2 — matches land-parcels.tsx exactly.
 *
 * The async RACE (avatar + land data resolve AFTER the first mount):
 *   The store seeds avatarPosition at the SCATTERED TOWN spawn synchronously.
 *   We capture that initial position, derive the session SCATTER (initial −
 *   town base), and only reposition if BOTH:
 *     (a) we haven't already repositioned this mount (one-shot ref), AND
 *     (b) the avatar is STILL at the town spawn — i.e. the player hasn't walked
 *         yet (avatarPositionRef ≈ the captured initial within EPS). If the
 *         player already moved, we DON'T yank them — a late land fetch must
 *         never teleport a walking player. The home position carries the SAME
 *         scatter delta so two players who both home-spawn don't stack.
 *
 * Camera: we use setAvatarPosition (writes avatarPositionRef + the throttled
 * reactive field) and requestCameraFocus so the follow-cam SNAPS to the home
 * spot on first paint instead of slow-panning from town center
 * (FPSFollowCamera drains the focus — same path the warp uses). Because we only
 * reposition while the player is stationary at spawn, this is a one-frame
 * re-anchor at load, never a jarring mid-play snap.
 */

import { useEffect, useRef } from 'react';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE } from '@/lib/pixi/tilemap-data';

// Town-center BASE spawn (pre-scatter) — mirrors SPAWN_PX base in stores/game.ts:
//   x = MAP_WIDTH/2,  y = MAP_HEIGHT/2 + 540  (world Z = +540, south of Nori).
const TOWN_BASE_X = MAP_WIDTH / 2;
const TOWN_BASE_Y = MAP_HEIGHT / 2 + 540;

// "Hasn't moved" tolerance (game-px) — compared against the EXACT captured
// initial spawn, not the scatter clamp box. The reactive store write is
// throttled to 10Hz and the per-frame ref is exact, so any real step easily
// exceeds this; a hair of tolerance covers float noise only.
const STATIONARY_EPS = 4;

export default function SpawnOnLoad() {
  const { data: avatar } = useAvatar();
  const setAvatarPosition = useGameStore((s) => s.setAvatarPosition);
  const requestCameraFocus = useGameStore((s) => s.requestCameraFocus);

  // One-shot per mount — never reposition twice (a useAvatar refetch must not
  // re-run the placement).
  const placedRef = useRef(false);
  // The EXACT scattered town spawn captured at first effect run (before the
  // player can have moved). We compare the live ref against THIS to decide
  // "stationary" — far tighter than the ±200/±180 scatter clamp box (which a
  // player who took a short walk could still sit inside, wrongly reading as
  // stationary and getting yanked home mid-step).
  const initialSpawnRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Capture the initial spawn position ONCE, as early as possible — the store
    // seeds avatarPosition at the scattered town spawn synchronously, so this
    // first read (before any async land fetch) is the un-walked starting point.
    if (initialSpawnRef.current === null) {
      initialSpawnRef.current = { x: avatarPositionRef.x, y: avatarPositionRef.y };
    }
    if (placedRef.current) return;
    if (!avatar) return; // wait for the authed avatar to resolve

    const pref = (avatar as { spawnPreference?: 'home' | 'town' }).spawnPreference;
    const homeParcelId = (avatar as { homeParcelId?: string | null }).homeParcelId ?? null;

    // Town preference (or no home set) — leave the default town spawn as-is.
    if (pref !== 'home' || !homeParcelId) {
      placedRef.current = true; // decided: nothing to do this mount
      return;
    }

    let cancelled = false;
    (async () => {
      let parcels;
      try {
        const res = await api.getMyLand();
        parcels = res.parcels;
      } catch {
        // Land fetch failed — keep the town spawn (best-effort), mark decided.
        if (!cancelled) placedRef.current = true;
        return;
      }
      if (cancelled || placedRef.current) return;

      const home = parcels.find((p) => p.id === homeParcelId && p.ownerAvatarId !== null);
      if (!home) {
        // Home no longer owned / resolvable — stay at town spawn.
        placedRef.current = true;
        return;
      }

      // RACE GUARD: only reposition if the player is STILL at the exact spawn
      // we captured at mount (hasn't walked). Comparing against the captured
      // initial position — not the scatter clamp box — means a player who took
      // even a short step is correctly treated as "moved" and never yanked.
      const initial = initialSpawnRef.current;
      if (!initial) {
        placedRef.current = true; // shouldn't happen (captured above); bail safe
        return;
      }
      const movedX = Math.abs(avatarPositionRef.x - initial.x);
      const movedY = Math.abs(avatarPositionRef.y - initial.y);
      if (movedX > STATIONARY_EPS || movedY > STATIONARY_EPS) {
        placedRef.current = true; // player walked — don't yank them
        return;
      }

      // The session scatter is the captured spawn minus the town base — re-apply
      // it to the home position so two home-spawners don't stack on the same px.
      const scatterX = initial.x - TOWN_BASE_X;
      const scatterY = initial.y - TOWN_BASE_Y;
      // game-px home center = gridX/gridY * TILE_SIZE (exact conversion above),
      // plus the SAME session scatter.
      const homeX = home.gridX * TILE_SIZE + scatterX;
      const homeY = home.gridY * TILE_SIZE + scatterY;
      // Clamp inside the world (defensive — parcels are well within bounds).
      const clampedX = Math.max(64, Math.min(MAP_WIDTH - 64, homeX));
      const clampedY = Math.max(64, Math.min(MAP_HEIGHT - 64, homeY));

      placedRef.current = true;
      setAvatarPosition(clampedX, clampedY);
      // Snap the follow camera to the home spot on first paint (no slow pan
      // from town center). FPSFollowCamera drains this; in explore mode it's a
      // harmless no-op (the player isn't embodied there anyway).
      requestCameraFocus(clampedX, clampedY);
    })();

    return () => {
      cancelled = true;
    };
  }, [avatar, setAvatarPosition, requestCameraFocus]);

  return null;
}
