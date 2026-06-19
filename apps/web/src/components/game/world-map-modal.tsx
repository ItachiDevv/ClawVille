'use client';

/**
 * world-map-modal.tsx — the WORLD MAP, the fast-travel WARP surface
 * (town-fast-travel, 2026-06-19).
 *
 * Opened from the minimap "⤢ Map" button (`openWorldMap()`), which freezes
 * movement. This is a LARGE interactive map — distinct from the always-on
 * minimap (which stays the WALK surface via click-to-path). Here, clicking a
 * building marker (or open map space) WARPS the player there via `warpTo()`,
 * masked by the <WarpOverlay> flash.
 *
 * Coordinate system (REUSED from minimap.tsx — single source of truth):
 *   • The world is MAP_WIDTH × MAP_HEIGHT game-px (== @clawville/shared
 *     WORLD_PX_*). avatarPosition + warpTo() are in this game-px space.
 *   • Building zones: game-px center = (zone.x + zone.width/2) * TILE_SIZE.
 *   • Owned parcels (GET /api/land/me) carry gridX/gridY tile coords; game-px =
 *     gridX * TILE_SIZE. The seed (seed-land-parcels.ts) stamps
 *     gridX = floor((cx + 9216)/32), and game-px = worldWu + 9216, so
 *     gridX*32 ≈ the parcel's game-px center. This is the same TILE_SIZE=32 /
 *     OFFSET=-MAP_WIDTH/2 mapping character-positions.ts uses to place NPCs
 *     (worldWu = gridX*TILE_SIZE + OFFSET) — land-parcels.tsx renders the 3D
 *     pads from cx/cz directly, but the grid↔game-px identity is the same.
 *   • Screen projection: game-px * SCALE → SVG viewBox coords.
 *
 * Warp target per building: we warp to the building's CHARACTER position (where
 * the teacher NPC stands, ~1300wu in front of the building face) when one
 * exists, so the player lands in talking range rather than on top of the
 * structure. Buildings with no character (cove, claw-arcade) warp to the zone
 * center game-px.
 *
 * Iris Xe / WebGPU: pure SVG + DOM/CSS. NO per-building <Canvas>, NO drei
 * <Text>/<Billboard>. The hover "holo preview" is a CSS card with the
 * building's emoji icon + a scanline HUD aesthetic — NO pre-baked thumbnail
 * exists in the repo (only GLB models), so this is a STYLIZED PLACEHOLDER (see
 * the orchestrator report flag). If a thumbnail asset ships later, swap the
 * placeholder block for an <img>.
 *
 * Mobile / iPad: RpgModal supplies the responsive sheet + backdrop + Escape; we
 * gate the side-panel layout on useIsMobile() (never a bare md:) so a phone /
 * iPad collapses the holo card under the map instead of beside it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { MAP_LOCATIONS } from '@clawville/shared';
import { CHARACTER_POSITIONS } from '@/lib/three/character-positions';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { api } from '@/lib/api';
import { RpgModal, RpgButton } from '@/components/rpg';
import type { LandParcelDTO } from '@/components/game/land/types';

// ── SVG canvas dimensions (viewBox units). Preserve world aspect (square). ────
const MAP_VB = 1000; // square viewBox; world is square (MAP_WIDTH === MAP_HEIGHT)
const SCALE = MAP_VB / MAP_WIDTH;

// World offset (tile-space origin → world origin), mirrors character-positions.ts
// OFFSET = -MAP_WIDTH/2. game-px = worldWu + HALF. So game-px(parcel) = gridX*TILE_SIZE.
const TILE_PX = TILE_SIZE; // 32 — game-px per grid tile

// Per-building accent (matches minimap.tsx BUILDING_ACCENT for visual parity).
const BUILDING_ACCENT: Record<string, string> = {
  'visual-creation': '#fde68a',
  'memory-rag': '#a5b4fc',
  'api-integrations': '#fca5a5',
  'cron-automation': '#93c5fd',
  'app-publishing': '#d9f99d',
  'deployment-ops': '#fed7aa',
  'mcp-tool-use': '#f9a8d4',
  'code-development': '#c4b5fd',
  'messaging-channels': '#67e8f9',
  'agent-security': '#fbbf24',
  cove: '#fbbf24',
  'claw-arcade': '#f472b6',
};

interface BuildingMarker {
  id: string;
  name: string;
  icon: string;
  accent: string;
  /** SVG viewBox coords for the marker dot. */
  vx: number;
  vy: number;
  /** game-px warp destination (character position if one exists, else zone center). */
  warpX: number;
  warpY: number;
}

/** Build the building marker list ONCE — buildingZones + MAP_LOCATIONS are frozen. */
function useBuildingMarkers(): BuildingMarker[] {
  return useMemo(() => {
    return buildingZones.map((zone) => {
      const loc = MAP_LOCATIONS.find((l) => l.id === zone.id);
      // Zone center in game-px.
      const centerPxX = (zone.x + zone.width / 2) * TILE_SIZE;
      const centerPxY = (zone.y + zone.height / 2) * TILE_SIZE;
      // Prefer the teacher-NPC position so the player lands in talking range.
      // CHARACTER_POSITIONS worldX/worldZ are world-wu; game-px = world + HALF.
      const charPos = CHARACTER_POSITIONS[zone.id];
      const warpX = charPos ? charPos.worldX + MAP_WIDTH / 2 : centerPxX;
      const warpY = charPos ? charPos.worldZ + MAP_HEIGHT / 2 : centerPxY;
      return {
        id: zone.id,
        name: loc?.name ?? zone.id,
        icon: loc?.icon ?? '📍',
        accent: BUILDING_ACCENT[zone.id] ?? '#94a3b8',
        vx: centerPxX * SCALE,
        vy: centerPxY * SCALE,
        warpX,
        warpY,
      };
    });
  }, []);
}

export default function WorldMapModal() {
  const open = useGameStore((s) => s.worldMapOpen);
  const close = useGameStore((s) => s.closeWorldMap);
  const warpTo = useGameStore((s) => s.warpTo);
  const controlMode = useGameStore((s) => s.controlMode);
  const avatarPosition = useGameStore((s) => s.avatarPosition);
  const addToast = useGameStore((s) => s.addToast);
  const isMobile = useIsMobile();
  const { data: avatar } = useAvatar();

  const markers = useBuildingMarkers();
  const svgRef = useRef<SVGSVGElement>(null);

  const [hovered, setHovered] = useState<string | null>(null);
  const [ownedParcels, setOwnedParcels] = useState<LandParcelDTO[]>([]);

  // Only a controllable player avatar can warp (warpTo() is gated to 'player').
  // Surface the gate in the UI so explore/npc/autonomous users see WHY warp is off.
  const canWarp = controlMode === 'player';

  // Load owned parcels for the parcel markers (best-effort; never blocks the map).
  useEffect(() => {
    if (!open || !avatar) return;
    let cancelled = false;
    api
      .getMyLand()
      .then((res) => {
        if (!cancelled) setOwnedParcels(res.parcels);
      })
      .catch(() => {
        /* ownership markers are best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [open, avatar]);

  // Clear hover when the modal closes so a reopen starts clean.
  useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  const doWarp = useCallback(
    (x: number, y: number, label: string) => {
      if (!canWarp) {
        addToast('🧭', 'Take control of your avatar to fast-travel.', 3500);
        return;
      }
      // warpTo() closes the map + fires the <WarpOverlay> flash; the overlay
      // performs the teleport at its midpoint.
      warpTo(x, y, label);
    },
    [canWarp, warpTo, addToast],
  );

  /** Click on open map space → warp to that game-px point. */
  const handleMapClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());
    // SVG viewBox → game-px, clamped to a safe inset off the world edge.
    const gx = Math.max(64, Math.min(MAP_WIDTH - 64, local.x / SCALE));
    const gy = Math.max(64, Math.min(MAP_HEIGHT - 64, local.y / SCALE));
    doWarp(gx, gy, 'Map point');
  };

  const hoveredMarker = hovered ? markers.find((m) => m.id === hovered) ?? null : null;

  // Player marker position in SVG coords.
  const playerVX = avatarPosition.x * SCALE;
  const playerVY = avatarPosition.y * SCALE;

  const mapSvg = (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${MAP_VB} ${MAP_VB}`}
      onClick={handleMapClick}
      className="block h-full w-full cursor-crosshair rounded-xl"
      style={{
        background: 'radial-gradient(ellipse at center, #0a3558 0%, #041726 70%, #020c16 100%)',
        aspectRatio: '1 / 1',
      }}
      role="img"
      aria-label="World map — click a building or open water to fast-travel"
    >
      <defs>
        <pattern id="wm-grid" width={MAP_VB / 12} height={MAP_VB / 12} patternUnits="userSpaceOnUse">
          <path
            d={`M ${MAP_VB / 12} 0 L 0 0 0 ${MAP_VB / 12}`}
            fill="none"
            stroke="rgba(34,211,238,0.07)"
            strokeWidth="0.8"
          />
        </pattern>
        <radialGradient id="wm-center-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="wm-player-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffd700" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#ffd700" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width={MAP_VB} height={MAP_VB} fill="url(#wm-grid)" />

      {/* Town-center glow + building ring guide */}
      <circle cx={MAP_VB / 2} cy={MAP_VB / 2} r={MAP_VB * 0.16} fill="url(#wm-center-glow)" />
      <circle
        cx={MAP_VB / 2}
        cy={MAP_VB / 2}
        r={130 * TILE_SIZE * SCALE}
        fill="none"
        stroke="rgba(34,211,238,0.16)"
        strokeWidth="1"
        strokeDasharray="4 5"
      />

      {/* Owned parcel markers — green diamonds. game-px = gridX/gridY * TILE_SIZE.
          getMyLand() returns only the caller's OWNED parcels, so every one here
          is the player's land. */}
      {ownedParcels.map((p) => {
        const px = p.gridX * TILE_PX * SCALE;
        const py = p.gridY * TILE_PX * SCALE;
        return (
          <g key={`parcel-${p.id}`} pointerEvents="none">
            <rect
              x={px - 6}
              y={py - 6}
              width={12}
              height={12}
              transform={`rotate(45 ${px} ${py})`}
              fill="rgba(74,222,128,0.55)"
              stroke="#bbf7d0"
              strokeWidth={1.2}
            />
          </g>
        );
      })}

      {/* Building markers — accent dots + icon hit halo. Hover → holo card. */}
      {markers.map((m) => {
        const isHover = hovered === m.id;
        return (
          <g
            key={m.id}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              doWarp(m.warpX, m.warpY, m.name);
            }}
            onMouseEnter={() => setHovered(m.id)}
            onMouseLeave={() => setHovered((cur) => (cur === m.id ? null : cur))}
          >
            {/* Generous transparent hit area so the marker is easy to tap. */}
            <circle cx={m.vx} cy={m.vy} r={22} fill="transparent" />
            {isHover && (
              <circle cx={m.vx} cy={m.vy} r={16} fill={m.accent} opacity={0.22}>
                <animate attributeName="r" values="13;19;13" dur="1.3s" repeatCount="indefinite" />
              </circle>
            )}
            <circle
              cx={m.vx}
              cy={m.vy}
              r={isHover ? 9 : 7}
              fill={m.accent}
              opacity={isHover ? 1 : 0.85}
              stroke={isHover ? '#ffffff' : 'rgba(2,12,22,0.6)'}
              strokeWidth={isHover ? 2 : 1}
            />
          </g>
        );
      })}

      {/* Player blip — pulsing gold. */}
      <circle cx={playerVX} cy={playerVY} r={16} fill="url(#wm-player-glow)" pointerEvents="none" />
      <circle cx={playerVX} cy={playerVY} r={6} fill="#ffd700" stroke="#fff" strokeWidth={1.5} pointerEvents="none">
        <animate attributeName="r" values="5;7;5" dur="1.5s" repeatCount="indefinite" />
      </circle>

      {/* Compass */}
      <g fontFamily="monospace" fill="rgba(255,255,255,0.35)" fontSize="22" textAnchor="middle">
        <text x={MAP_VB / 2} y={26}>N</text>
        <text x={MAP_VB / 2} y={MAP_VB - 8}>S</text>
        <text x={16} y={MAP_VB / 2 + 7} textAnchor="start">W</text>
        <text x={MAP_VB - 16} y={MAP_VB / 2 + 7} textAnchor="end">E</text>
      </g>
    </svg>
  );

  return (
    <RpgModal
      open={open}
      onClose={close}
      title="World Map"
      subtitle="Fast Travel"
      tier="epic"
      maxWidth={isMobile ? 560 : 1080}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] leading-relaxed text-slate-200">
          Tap a building to <span className="font-semibold text-cyan-200">warp</span> there, or click
          open water to travel to any spot. The minimap (top-left) still walks you there step by step.
        </p>
        {!canWarp && (
          <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200">
            Take control to warp
          </span>
        )}
      </div>

      <div className={isMobile ? 'flex flex-col gap-4' : 'grid grid-cols-[1fr_280px] gap-4'}>
        {/* Map */}
        <div className="relative w-full overflow-hidden rounded-xl border border-cyan-400/25 bg-[#04111e] shadow-[0_0_30px_rgba(0,229,255,0.18)]">
          {mapSvg}
        </div>

        {/* Holo preview / hint side panel */}
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.04] p-3">
          {hoveredMarker ? (
            <BuildingHoloCard
              name={hoveredMarker.name}
              icon={hoveredMarker.icon}
              accent={hoveredMarker.accent}
              canWarp={canWarp}
              onWarp={() => doWarp(hoveredMarker.warpX, hoveredMarker.warpY, hoveredMarker.name)}
            />
          ) : (
            <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center">
              <span className="text-3xl opacity-50">🗺️</span>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-cyan-200/70">
                Hover a beacon
              </p>
              <p className="text-[11px] leading-relaxed text-slate-300">
                Preview a destination and Quick&nbsp;Travel there. Gold = you. Green diamonds = your land.
              </p>
            </div>
          )}
        </div>
      </div>
    </RpgModal>
  );
}

/**
 * BuildingHoloCard — the hover "holographic preview" (cyan-glow scanline HUD).
 *
 * Stylized placeholder: NO pre-baked building thumbnail exists in the repo
 * (only GLB models), and a live per-building <Canvas> is banned on Iris Xe. So
 * the preview is a CSS holo plate (emoji icon over a scanline grid). If a
 * baked thumbnail asset ships later, swap the plate for an <img src=… />.
 */
function BuildingHoloCard({
  name,
  icon,
  accent,
  canWarp,
  onWarp,
}: {
  name: string;
  icon: string;
  accent: string;
  canWarp: boolean;
  onWarp: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      {/* Holo plate */}
      <div
        className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border"
        style={{
          borderColor: `${accent}66`,
          background: `linear-gradient(160deg, ${accent}1a 0%, rgba(4,17,30,0.9) 70%)`,
          boxShadow: `0 0 18px ${accent}33, inset 0 0 24px ${accent}1f`,
        }}
      >
        {/* Scanline overlay */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(34,211,238,0) 0px, rgba(34,211,238,0) 3px, rgba(34,211,238,0.12) 4px, rgba(34,211,238,0.12) 5px)',
            mixBlendMode: 'screen',
          }}
        />
        {/* Corner ticks */}
        <span className="absolute left-1.5 top-1.5 h-3 w-3 border-l-2 border-t-2" style={{ borderColor: accent }} />
        <span className="absolute right-1.5 top-1.5 h-3 w-3 border-r-2 border-t-2" style={{ borderColor: accent }} />
        <span className="absolute bottom-1.5 left-1.5 h-3 w-3 border-b-2 border-l-2" style={{ borderColor: accent }} />
        <span className="absolute bottom-1.5 right-1.5 h-3 w-3 border-b-2 border-r-2" style={{ borderColor: accent }} />
        <span
          className="text-5xl"
          style={{ filter: `drop-shadow(0 0 10px ${accent}aa)` }}
          aria-hidden
        >
          {icon}
        </span>
      </div>

      <div>
        <h4 className="font-clawville text-base leading-tight text-cyan-50">{name}</h4>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: accent }}>
          Beacon locked
        </p>
      </div>

      <RpgButton
        size="sm"
        variant="primary"
        onClick={onWarp}
        disabled={!canWarp}
        className="mt-auto"
      >
        {canWarp ? '⚡ Quick Travel' : 'Control to warp'}
      </RpgButton>
    </div>
  );
}
