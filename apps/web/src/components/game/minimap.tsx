'use client';

import { useRef } from 'react';
import { useGameStore } from '@/stores/game';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { MAP_LOCATIONS } from '@clawville/shared';
import { findPath } from '@/lib/pixi/client-pathfinding';

const MM_W = 180;
const MM_H = MM_W * (MAP_HEIGHT / MAP_WIDTH); // preserve aspect
const SCALE_X = MM_W / MAP_WIDTH;
const SCALE_Y = MM_H / MAP_HEIGHT;

// Village-center tile (180, 180) = map center (Phase 6.2: 360×360 grid)
const CENTER_TILE_PX_X = (MAP_WIDTH / 2);
const CENTER_TILE_PX_Y = (MAP_HEIGHT / 2);

// Per-building accent colors tied to the skill category (so each building
// has a distinct minimap silhouette even before hover).
const BUILDING_ACCENT: Record<string, string> = {
  'visual-creation': '#fde68a',      // pineapple yellow
  'memory-rag': '#a5b4fc',       // squidward indigo
  'api-integrations': '#fca5a5',    // salty spitoon red
  'cron-automation': '#93c5fd',           // downtown blue
  'app-publishing': '#d9f99d',        // boating school green
  'deployment-ops': '#fed7aa',     // lighthouse orange
  'mcp-tool-use': '#f9a8d4',      // krusty krab pink
  'code-development': '#c4b5fd',        // chum bucket violet
  'messaging-channels': '#67e8f9',     // sandy treedome cyan
  'agent-security': '#fbbf24',  // patrick rock yellow
  // Phase 6.0.1 entertainment buildings
  'cove': '#fbbf24',           // pyramid cove gold
  'claw-arcade': '#f472b6',      // arcade city neon pink
};

export default function Minimap() {
  const avatarPosition = useGameStore((s) => s.avatarPosition);
  const nearLocation = useGameStore((s) => s.nearLocation);
  const visitedBuildings = useGameStore((s) => s.visitedBuildings);
  const setClickPath = useGameStore((s) => s.setClickPath);
  const controlMode = useGameStore((s) => s.controlMode);
  const movementFrozen = useGameStore((s) => s.movementFrozen);
  // World Map / fast-travel (town-fast-travel, 2026-06-19). The minimap stays
  // the WALK surface (click-to-path below); the "⤢ Map" button opens the large
  // World Map modal which is the WARP surface.
  const openWorldMap = useGameStore((s) => s.openWorldMap);
  const svgRef = useRef<SVGSVGElement>(null);

  const avatarX = avatarPosition.x * SCALE_X;
  const avatarY = avatarPosition.y * SCALE_Y;

  /** Convert a minimap click to map pixel coords, path-find from avatar, and dispatch. */
  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // Only player/autonomous modes have a ClickToMove consumer — NPC mode drives
    // the possessed NPC via NpcController (WASD/joystick), not clickPath.
    if (controlMode === 'npc' || controlMode === 'explore') return;
    if (movementFrozen) return;
    if (!svgRef.current) return;

    // SVG coordinate (viewBox) → map pixel coordinate
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());

    const mapX = Math.max(16, Math.min(MAP_WIDTH - 16, local.x / SCALE_X));
    const mapY = Math.max(16, Math.min(MAP_HEIGHT - 16, local.y / SCALE_Y));

    const path = findPath(avatarPosition.x, avatarPosition.y, mapX, mapY);
    if (path.length === 0) return;

    // If click landed inside a building zone, mark the path target so it
    // triggers the building interaction on arrival.
    const hitZone = buildingZones.find(
      (z) =>
        mapX >= z.x * TILE_SIZE &&
        mapX <= (z.x + z.width) * TILE_SIZE &&
        mapY >= z.y * TILE_SIZE &&
        mapY <= (z.y + z.height) * TILE_SIZE
    );
    setClickPath(path, hitZone?.id ?? null);
  };

  return (
    <div
      className="fixed top-4 left-4 z-40 hidden md:block"
      style={{ width: MM_W }}
    >
      {/* Outer frame + glow */}
      <div className="relative rounded-xl overflow-hidden border border-cyan-400/30 shadow-[0_0_30px_rgba(0,229,255,0.22)] bg-[#04111e]/95 backdrop-blur-md">
        {/* Header strip */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1.5 border-b border-cyan-500/15">
          <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-cyan-300/70">Sonar</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[8px] text-white/30">{Math.round(avatarPosition.x)},{Math.round(avatarPosition.y)}</span>
            {/* Expand → World Map (warp surface). Walk surface stays on the SVG below. */}
            <button
              type="button"
              onClick={openWorldMap}
              title="Open World Map (fast travel)"
              aria-label="Open World Map"
              className="flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] text-cyan-200 transition-colors hover:border-cyan-300/60 hover:bg-cyan-500/20"
            >
              <span aria-hidden>⤢</span>
              <span>Map</span>
            </button>
          </div>
        </div>

        <svg
          ref={svgRef}
          width={MM_W}
          height={MM_H}
          viewBox={`0 0 ${MM_W} ${MM_H}`}
          onClick={handleClick}
          className="cursor-crosshair block"
          style={{ background: 'radial-gradient(ellipse at center, #0a3558 0%, #031728 100%)' }}
        >
          <defs>
            {/* Sonar grid pattern */}
            <pattern id="sonar-grid" width={MM_W / 8} height={MM_H / 8} patternUnits="userSpaceOnUse">
              <path
                d={`M ${MM_W / 8} 0 L 0 0 0 ${MM_H / 8}`}
                fill="none"
                stroke="rgba(34,211,238,0.08)"
                strokeWidth="0.5"
              />
            </pattern>
            {/* Avatar glow */}
            <radialGradient id="avatar-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffd700" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#ffd700" stopOpacity="0" />
            </radialGradient>
            {/* Village center subtle glow */}
            <radialGradient id="center-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Sonar grid */}
          <rect width={MM_W} height={MM_H} fill="url(#sonar-grid)" />

          {/* Village center soft glow */}
          <circle
            cx={CENTER_TILE_PX_X * SCALE_X}
            cy={CENTER_TILE_PX_Y * SCALE_Y}
            r={MM_W * 0.22}
            fill="url(#center-glow)"
          />

          {/* Ring guide — dashed circle at the 100-tile building ring radius.
              Phase 6.1 (2026-05-18): grid expanded 160→240 tiles, ring expanded
              R=72→100 tiles. 12 buildings at 30° spacing. Circle guide is exact. */}
          <circle
            cx={CENTER_TILE_PX_X * SCALE_X}
            cy={CENTER_TILE_PX_Y * SCALE_Y}
            r={100 * TILE_SIZE * SCALE_X}
            fill="none"
            stroke="rgba(34,211,238,0.18)"
            strokeWidth="0.8"
            strokeDasharray="2 3"
          />

          {/* Building markers — accent-colored squares, glow on hover/near */}
          {buildingZones.map((zone) => {
            const isNear = nearLocation === zone.id;
            const isVisited = visitedBuildings.has(zone.id);
            const loc = MAP_LOCATIONS.find((l) => l.id === zone.id);
            const accent = BUILDING_ACCENT[zone.id] ?? '#94a3b8';
            const cx = (zone.x + zone.width / 2) * TILE_SIZE * SCALE_X;
            const cy = (zone.y + zone.height / 2) * TILE_SIZE * SCALE_Y;
            return (
              <g key={zone.id} className="group">
                {/* Glow halo when near */}
                {isNear && (
                  <circle cx={cx} cy={cy} r={7} fill={accent} opacity={0.25}>
                    <animate attributeName="r" values="6;9;6" dur="1.4s" repeatCount="indefinite" />
                  </circle>
                )}
                <rect
                  x={cx - 4}
                  y={cy - 4}
                  width={8}
                  height={8}
                  fill={accent}
                  opacity={isNear ? 1 : isVisited ? 0.8 : 0.55}
                  stroke={isNear ? '#ffffff' : 'rgba(0,0,0,0.3)'}
                  strokeWidth={isNear ? 1 : 0.5}
                  rx={1.5}
                  className="transition-all group-hover:opacity-100"
                />
                {/* Always-on title label on hover */}
                <title>{loc?.name ?? zone.id}{isVisited ? ' ✓' : ''}</title>
              </g>
            );
          })}

          {/* Avatar position — pulsing sonar blip */}
          <circle cx={avatarX} cy={avatarY} r={7} fill="url(#avatar-glow)" />
          <circle cx={avatarX} cy={avatarY} r={3.5} fill="#ffd700" stroke="#fff" strokeWidth={0.8}>
            <animate attributeName="r" values="3;4;3" dur="1.6s" repeatCount="indefinite" />
          </circle>
          <circle cx={avatarX} cy={avatarY} r={1} fill="#fff" />

          {/* Compass NSEW markers */}
          <g className="font-mono" fill="rgba(255,255,255,0.35)" fontSize="7" textAnchor="middle">
            <text x={MM_W / 2} y={8}>N</text>
            <text x={MM_W / 2} y={MM_H - 2}>S</text>
            <text x={6} y={MM_H / 2 + 2} textAnchor="start">W</text>
            <text x={MM_W - 6} y={MM_H / 2 + 2} textAnchor="end">E</text>
          </g>
        </svg>

        {/* Click hint */}
        <div className="px-3 py-1.5 border-t border-cyan-500/15 flex items-center justify-between">
          <span className="font-mono text-[8px] uppercase tracking-[0.25em] text-cyan-400/50">
            {nearLocation ? MAP_LOCATIONS.find((l) => l.id === nearLocation)?.name ?? nearLocation : 'Click to move'}
          </span>
          <span className="font-mono text-[8px] text-white/30">
            {visitedBuildings.size}/{buildingZones.length} visited
          </span>
        </div>
      </div>
    </div>
  );
}
