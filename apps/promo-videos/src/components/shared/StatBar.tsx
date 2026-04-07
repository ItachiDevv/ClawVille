import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { SPRING_SMOOTH } from "../../constants/timing";
import { COLORS } from "../../constants/colors";

type StatBarProps = {
  label: string;
  value: number;
  color?: string;
  width?: number;
  height?: number;
  delay?: number;
};

export const StatBar: React.FC<StatBarProps> = ({
  label,
  value,
  color = COLORS.success,
  width = 200,
  height = 20,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame,
    fps,
    delay,
    config: SPRING_SMOOTH,
  });

  const fillWidth = interpolate(progress, [0, 1], [0, value * width]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span
        style={{
          fontFamily: "Roboto, sans-serif",
          fontSize: 16,
          fontWeight: 700,
          color: COLORS.panel,
          minWidth: 80,
          textAlign: "right",
        }}
      >
        {label}
      </span>
      <div
        style={{
          width,
          height,
          backgroundColor: "rgba(0,0,0,0.3)",
          borderRadius: height / 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: fillWidth,
            height: "100%",
            backgroundColor: color,
            borderRadius: height / 2,
          }}
        />
      </div>
    </div>
  );
};
