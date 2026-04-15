'use client';

import { useGameStore } from '@/stores/game';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { MAP_LOCATIONS } from '@clawville/shared';

const MM_W = 160;
const MM_H = MM_W * (MAP_HEIGHT / MAP_WIDTH); // preserve aspect ratio
const SCALE_X = MM_W / MAP_WIDTH;
const SCALE_Y = MM_H / MAP_HEIGHT;

export default function Minimap() {
  const petPosition = useGameStore((s) => s.petPosition);
  const nearLocation = useGameStore((s) => s.nearLocation);
  const visitedBuildings = useGameStore((s) => s.visitedBuildings);

  const petX = petPosition.x * SCALE_X;
  const petY = petPosition.y * SCALE_Y;

  return (
    <div
      className="fixed top-4 left-4 z-40 rounded-lg overflow-hidden border-2 border-yellow-600/60 shadow-claw hidden md:block"
      style={{ width: MM_W, height: MM_H }}
    >
      {/* Background */}
      <svg width={MM_W} height={MM_H} className="bg-[#3a7a3a]">
        {/* Path grid — simplified horizontal/vertical lines (160x160 grid) */}
        <g opacity={0.3}>
          {/* Vertical paths at approx tile column positions */}
          {[32, 64, 96, 128].map((col) => (
            <line
              key={`v${col}`}
              x1={col * TILE_SIZE * SCALE_X}
              y1={0}
              x2={col * TILE_SIZE * SCALE_X}
              y2={MM_H}
              stroke="#b8946a"
              strokeWidth={2}
            />
          ))}
          {/* Horizontal paths */}
          {[32, 64, 96, 128].map((row) => (
            <line
              key={`h${row}`}
              x1={0}
              y1={row * TILE_SIZE * SCALE_Y}
              x2={MM_W}
              y2={row * TILE_SIZE * SCALE_Y}
              stroke="#b8946a"
              strokeWidth={2}
            />
          ))}
        </g>

        {/* Building zones */}
        {buildingZones.map((zone) => {
          const isNear = nearLocation === zone.id;
          const isVisited = visitedBuildings.has(zone.id);
          const loc = MAP_LOCATIONS.find((l) => l.id === zone.id);

          return (
            <g key={zone.id}>
              <rect
                x={zone.x * TILE_SIZE * SCALE_X}
                y={zone.y * TILE_SIZE * SCALE_Y}
                width={zone.width * TILE_SIZE * SCALE_X}
                height={zone.height * TILE_SIZE * SCALE_Y}
                fill={isNear ? '#ffd700' : isVisited ? '#6b7280' : '#4b5563'}
                opacity={isNear ? 0.9 : 0.7}
                rx={1}
              />
              {isNear && loc && (
                <text
                  x={zone.x * TILE_SIZE * SCALE_X + (zone.width * TILE_SIZE * SCALE_X) / 2}
                  y={zone.y * TILE_SIZE * SCALE_Y - 2}
                  textAnchor="middle"
                  fontSize={6}
                  fill="white"
                  fontWeight="bold"
                >
                  {loc.name}
                </text>
              )}
            </g>
          );
        })}

        {/* Pet position — pulsing dot */}
        <circle cx={petX} cy={petY} r={4} fill="#ffd700" opacity={0.4}>
          <animate attributeName="r" values="4;6;4" dur="1.5s" repeatCount="indefinite" />
        </circle>
        <circle cx={petX} cy={petY} r={3} fill="#ffd700" />
        <circle cx={petX} cy={petY} r={1.5} fill="#fff" />
      </svg>

      {/* Glass overlay effect */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent pointer-events-none" />
    </div>
  );
}
