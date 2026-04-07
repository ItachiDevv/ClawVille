import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "../../constants/colors";

type NeoTokenIconProps = {
  size?: number;
  style?: React.CSSProperties;
};

export const NeoTokenIcon: React.FC<NeoTokenIconProps> = ({
  size = 40,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const shineX = interpolate(
    (frame / fps) % 2,
    [0, 0.5, 2],
    [-size, size * 1.5, size * 1.5],
    { extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `radial-gradient(circle at 35% 35%, #FFE566, ${COLORS.neoToken}, #B8860B)`,
        border: `3px solid #B8860B`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        boxShadow: `0 2px 8px rgba(0,0,0,0.3), inset 0 -2px 4px rgba(0,0,0,0.2)`,
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: "Lobster, cursive",
          fontSize: size * 0.5,
          color: "#8B6914",
          fontWeight: "bold",
          zIndex: 1,
        }}
      >
        C
      </span>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: shineX,
          width: size * 0.3,
          height: size,
          background:
            "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)",
          transform: "skewX(-20deg)",
        }}
      />
    </div>
  );
};
