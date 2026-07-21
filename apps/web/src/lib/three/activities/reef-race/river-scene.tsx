'use client';

/**
 * river-scene.tsx — SURF ROAD scene block for Reef Race.
 *
 * ─── 2026-06-23 SURF ROAD REBUILD ────────────────────────────────────────────
 * The founder reframed the vision: Reef Race is no longer a river through a
 * land canyon — it is RAINBOW ROAD. A glowing FLOATING WATER RIBBON winding
 * through an abstract COSMIC VOID. There is NO land, NO island, NO ground, NO
 * sky-dome-over-terrain. The water ribbon IS the world.
 *
 * This file used to assemble the whole land-disc atmosphere: a sky dome, two
 * spline-following grass/sand GROUND RIBBONS (GroundShader), scenery prop
 * InstancedMeshes (trees/rocks/fences/grass on the banks), bank walls, power-up
 * boxes, a flat WaterSurf ribbon at WATER_Y=-200, and rocky cliffs. ALL OF THAT
 * IS REMOVED. What remains:
 *
 *   - <CosmicVoid />   — the gradient void dome + starfield + glow motes
 *                        (cosmic-void.tsx). v5.1: palette softened from pure-space
 *                        to warm canyon-dusk atmosphere (still abstract/floating).
 *   - <SurfRibbon />  — the glowing floating water ribbon + neon banked rails +
 *                       crest glow (surf-ribbon.tsx). Rides the render-only
 *                       elevation + bank profile. THE WORLD.
 *   - <CanyonRiver /> — NEW (v5.1). Rock canyon walls + thin earthy land
 *                       shoulders swept along the same spline + elevation datum.
 *                       Both geometry pieces lift/bank WITH the ribbon (parity
 *                       contract preserved). 2 draw calls. (canyon-river.tsx)
 *   - <RacingKarts /> — 5 decorative spline karts (preview only; hidden in
 *                       gameplay where server karts render via ReefRacePlayer).
 *   - <Ramps />       — jump-ramp wedge meshes at the 6 spline ramp volumes.
 *   - <ReefRaceTrackFurniture /> — R18c seeded obstacle/creature/rip layout,
 *                       exactly 6 built-in-material instanced draws.
 *   - <ReefRaceBoostPads /> — boost portals at the authoritative spline zones.
 *
 * Iris Xe invariants (unchanged): ShaderMaterial only on plain Mesh; no
 * InstancedMesh+ShaderMaterial; no drei <Text>/<Billboard>; import 'three' (not
 * 'three/webgpu'); module-scope geo/mat; frustumCulled=false on swept meshes;
 * ≤ 3 lights (parent owns lighting). Draw calls: void 4 + ribbon 2 + canyon 1
 * + shoulder 1 + ramps 2 + furniture 6 + boost portals 2
 * (+ karts ≤5 in preview). Furniture's incremental ledger is exactly 6.
 *
 * REMOVED (2026-06-23 SURF ROAD): GroundShader + buildGroundRibbonGeo + the two
 * ground ribbons, SkyDome + makeDomeGeo, ScenerySpawner + PropInstances +
 * SPAWNER_DEFS + all scenery GLB preloads, PowerUpBoxes + _powerupMat, WaterSurf
 * (its flat ribbon is superseded by the elevated SurfRibbon), all the WATER_Y /
 * GROUND_* / DOME_* constants. RockyCliffs / FinishGate / DistanceMarkers /
 * Bridge were already removed on the prior closed-loop pass.
 */

import { CosmicVoid } from './cosmic-void';
import { SurfRibbon } from './surf-ribbon';
import { CanyonRiver } from './canyon-river';
import { RacingKarts } from './racing-karts';
import { Ramps } from './ramps';
import ReefRaceBoostPads from './ReefRaceBoostPads';
import ReefRaceTrackFurniture from './ReefRaceTrackFurniture';

// ─── Public composite component ───────────────────────────────────────────────

/**
 * RiverScene — drop-in SURF ROAD block for Reef Race.
 *
 * Wire into any R3F Canvas that uses the spline track:
 *   - /preview/reef-race-v2: inside <SceneContents>
 *   - ReefRaceScene.tsx: inside production <SceneContents>
 *
 * Does NOT own lighting, fog, or the chase camera — the parent scene manages
 * those. The parent SHOULD use the cosmic-void background colour ('#0c1a2e')
 * and the cool hemisphere fill (see reef-race-config HEMI_*).
 *
 * @param showDemoKarts - Defaults true (preview). Real gameplay passes false so
 *   the 5 decorative spline karts don't compete with the server-driven
 *   ReefRacePlayer karts.
 * @param showDemoPickups - Retained for call-site compatibility; the decorative
 *   power-up boxes were removed in the SURF ROAD rebuild (server power-ups
 *   render via <ReefRacePickups />). Ignored.
 */
export function RiverScene({
  showDemoKarts = true,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  showDemoPickups = true,
}: { showDemoKarts?: boolean; showDemoPickups?: boolean } = {}) {
  return (
    <>
      {/* The abstract cosmic void — gradient dome + starfield + drifting motes */}
      <CosmicVoid />

      {/* THE WORLD: glowing floating water ribbon + neon banked rails + crests.
          Rides reefTrackElevationAt(t) + reefTrackBankAngleAt(t). */}
      <SurfRibbon />

      {/* Floating canyon: rock cliff walls + thin land shoulders hugging each
          bank. Geometry swept along the same spline + elevation datum — land
          floats and undulates WITH the ribbon through every climb/dip/bank. */}
      <CanyonRiver />

      {/* 5 decorative surfboard karts along the spline (preview only) */}
      {showDemoKarts && <RacingKarts />}

      {/* Jump-ramp wedge meshes at the 6 spline ramp volumes */}
      <Ramps />

      {/* R18c: authoritative seeded obstacles, moving creature telegraphs, and
          off-line rip-current streaks. Six instanced built-in-material draws. */}
      <ReefRaceTrackFurniture />

      {/* v2 mechanics — boost-pad glowing floor markers at the 4 spline
          boost-pad volumes. Server-positioned when `reefSplineZones` is
          available, client-mirrored fallback otherwise. */}
      <ReefRaceBoostPads />
    </>
  );
}
