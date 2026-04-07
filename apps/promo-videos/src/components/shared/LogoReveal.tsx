import React from "react";
import {
  spring,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Lobster";
import { SPRING_BOUNCY } from "../../constants/timing";
import { COLORS } from "../../constants/colors";

const { fontFamily: lobster } = loadFont();

type LogoRevealProps = {
  delay?: number;
  size?: number;
};

export const LogoReveal: React.FC<LogoRevealProps> = ({
  delay = 0,
  size = 72,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    delay,
    config: SPRING_BOUNCY,
  });

  const scale = interpolate(entrance, [0, 1], [0.3, 1]);
  const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: size,
          color: COLORS.accent,
          textShadow: `
            2px 2px 0px ${COLORS.primary},
            4px 4px 0px rgba(0,0,0,0.3),
            0 0 20px rgba(0,229,255,0.4)
          `,
          letterSpacing: 2,
        }}
      >
        ClawVille
      </span>
    </div>
  );
};
