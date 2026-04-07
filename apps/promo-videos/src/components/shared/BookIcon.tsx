import React from "react";
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SPRING_BOUNCY } from "../../constants/timing";
import { COLORS } from "../../constants/colors";

type BookIconProps = {
  icon: string;
  name: string;
  price: number;
  size?: number;
  delay?: number;
  style?: React.CSSProperties;
};

export const BookIcon: React.FC<BookIconProps> = ({
  icon,
  name,
  price,
  size = 80,
  delay = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    delay,
    config: SPRING_BOUNCY,
  });

  const scale = interpolate(entrance, [0, 1], [0, 1]);
  const bobOffset =
    Math.sin(((frame - delay) / fps) * 2 * Math.PI * 2) * 3;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        transform: `scale(${scale}) translateY(${bobOffset}px)`,
        ...style,
      }}
    >
      <div
        style={{
          width: size,
          height: size * 1.2,
          background: `linear-gradient(135deg, ${COLORS.panelBg}, ${COLORS.primary})`,
          borderRadius: 8,
          border: `3px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size * 0.5,
          boxShadow: "3px 3px 0px rgba(0,0,0,0.2)",
        }}
      >
        {icon}
      </div>
      <span
        style={{
          fontFamily: "Roboto, sans-serif",
          fontSize: 14,
          fontWeight: 700,
          color: COLORS.panel,
          textAlign: "center",
          maxWidth: size * 1.5,
          textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontFamily: "Roboto, sans-serif",
          fontSize: 16,
          fontWeight: 700,
          color: COLORS.clawToken,
        }}
      >
        {price} NT
      </span>
    </div>
  );
};
