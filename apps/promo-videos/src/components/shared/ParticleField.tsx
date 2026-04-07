import React, { useMemo } from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type ParticleFieldProps = {
  count?: number;
  color?: string;
  speed?: number;
};

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export const ParticleField: React.FC<ParticleFieldProps> = ({
  count = 20,
  color = "#00E5FF",
  speed = 1,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  const particles = useMemo(() => {
    return Array.from({ length: count }, (_, i) => ({
      x: seededRandom(i * 3) * width,
      y: seededRandom(i * 3 + 1) * height,
      size: 2 + seededRandom(i * 3 + 2) * 4,
      phase: seededRandom(i * 7) * Math.PI * 2,
      speedMul: 0.5 + seededRandom(i * 11) * 1,
    }));
  }, [count, width, height]);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {particles.map((p, i) => {
        const t = (frame / fps) * speed;
        const x = p.x + Math.sin(t * p.speedMul + p.phase) * 30;
        const y =
          ((p.y - t * 40 * p.speedMul) % (height + 20)) - 10;
        const adjustedY = y < -10 ? y + height + 20 : y;
        const opacity = interpolate(
          Math.sin(t * 2 + p.phase),
          [-1, 1],
          [0.3, 1]
        );
        const scale = interpolate(
          Math.sin(t * 3 + p.phase),
          [-1, 1],
          [0.6, 1.2]
        );

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: adjustedY,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              backgroundColor: color,
              opacity,
              transform: `scale(${scale})`,
              boxShadow: `0 0 ${p.size * 2}px ${color}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
