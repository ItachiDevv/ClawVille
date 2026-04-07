import React from "react";
import {
  spring,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Roboto";
import { SPRING_BOUNCY } from "../../constants/timing";
import { COLORS } from "../../constants/colors";

const { fontFamily: roboto } = loadFont("normal", {
  weights: ["700"],
  subsets: ["latin"],
});

type CTAButtonProps = {
  text: string;
  delay?: number;
  subtitle?: string;
};

export const CTAButton: React.FC<CTAButtonProps> = ({
  text,
  delay = 0,
  subtitle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    delay,
    config: SPRING_BOUNCY,
  });

  const scale = interpolate(entrance, [0, 1], [0.5, 1]);
  const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const pulsePhase = ((frame - delay) / fps) * 2 * Math.PI;
  const glowIntensity = 10 + Math.sin(pulsePhase) * 8;
  const pulseScale = 1 + Math.sin(pulsePhase * 1.5) * 0.03;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        opacity,
        transform: `scale(${scale * pulseScale})`,
      }}
    >
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.secondary})`,
          borderRadius: 50,
          padding: "18px 48px",
          boxShadow: `0 0 ${glowIntensity}px rgba(0,229,255,0.6), 4px 4px 0px rgba(0,0,0,0.3)`,
          border: `3px solid ${COLORS.primary}`,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 28,
            fontWeight: 700,
            color: "#0A1628",
            letterSpacing: 1,
          }}
        >
          {text}
        </span>
      </div>
      {subtitle && (
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            color: COLORS.panel,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
};
