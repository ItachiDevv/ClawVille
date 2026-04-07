import React from "react";
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS } from "../../constants/colors";

type DamageNumberProps = {
  damage: number;
  delay?: number;
  x?: number;
  y?: number;
  isCritical?: boolean;
};

export const DamageNumber: React.FC<DamageNumberProps> = ({
  damage,
  delay = 0,
  x = 0,
  y = 0,
  isCritical = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    delay,
    config: { damping: 12, mass: 0.3 },
  });

  const elapsed = Math.max(0, frame - delay);
  const floatY = interpolate(elapsed, [0, fps * 1.5], [0, -60], {
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(elapsed, [fps * 0.8, fps * 1.5], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(entrance, [0, 1], [2, 1]);

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y + floatY,
        opacity,
        transform: `scale(${scale})`,
        fontFamily: "Roboto, sans-serif",
        fontSize: isCritical ? 36 : 28,
        fontWeight: 700,
        color: isCritical ? "#FF1744" : COLORS.danger,
        textShadow: `
          2px 2px 0px rgba(0,0,0,0.5),
          0 0 10px ${isCritical ? "rgba(255,0,0,0.5)" : "transparent"}
        `,
        pointerEvents: "none",
      }}
    >
      -{damage}
    </div>
  );
};
