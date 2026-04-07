import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

type HPBarProps = {
  hp: number;
  maxHp: number;
  width?: number;
  height?: number;
  label?: string;
};

export const HPBar: React.FC<HPBarProps> = ({
  hp,
  maxHp,
  width = 180,
  height = 16,
  label,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ratio = Math.max(0, Math.min(1, hp / maxHp));
  const displayRatio = interpolate(frame, [0, fps * 0.5], [1, ratio], {
    extrapolateRight: "clamp",
  });

  const color =
    displayRatio > 0.5
      ? "#4CAF50"
      : displayRatio > 0.25
        ? "#FF9800"
        : "#F44336";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <span
          style={{
            fontFamily: "Roboto, sans-serif",
            fontSize: 14,
            fontWeight: 700,
            color: "white",
            textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
          }}
        >
          {label}
        </span>
      )}
      <div
        style={{
          width,
          height,
          backgroundColor: "rgba(0,0,0,0.4)",
          borderRadius: height / 2,
          border: "2px solid rgba(255,255,255,0.3)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${displayRatio * 100}%`,
            height: "100%",
            backgroundColor: color,
            borderRadius: height / 2,
            boxShadow: `0 0 8px ${color}80`,
          }}
        />
        <span
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            fontFamily: "Roboto, sans-serif",
            fontSize: height * 0.7,
            fontWeight: 700,
            color: "white",
            textShadow: "1px 1px 1px rgba(0,0,0,0.5)",
          }}
        >
          {hp}/{maxHp}
        </span>
      </div>
    </div>
  );
};
