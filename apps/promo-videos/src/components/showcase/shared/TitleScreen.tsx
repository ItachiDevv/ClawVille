import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { ParticleField } from "../../shared/ParticleField";
import { LogoReveal } from "../../shared/LogoReveal";
import { SPRING_BOUNCY, SPRING_SNAPPY } from "../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

interface TitleScreenProps {
  title: string;
  subtitle: string;
  accentColor?: string;
}

export const TitleScreen: React.FC<TitleScreenProps> = ({
  title,
  subtitle,
  accentColor = "#FFD700",
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const logoEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });

  const titleEntrance = spring({
    frame,
    fps,
    delay: 8,
    config: SPRING_SNAPPY,
  });

  const subtitleEntrance = spring({
    frame,
    fps,
    delay: 12,
    config: { damping: 200 },
  });

  const logoScale = interpolate(logoEntrance, [0, 1], [0.3, 1]);
  const titleY = interpolate(titleEntrance, [0, 1], [40, 0]);
  const titleOpacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const subtitleOpacity = interpolate(subtitleEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill>
      {/* Dark gradient background */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(135deg, #1a0a2e 0%, #2d1b4e 50%, #0d0d1a 100%)",
        }}
      />

      {/* Particles */}
      <ParticleField count={20} color={accentColor} speed={1.5} />

      {/* Content */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: isVertical ? 20 : 16,
        }}
      >
        <div
          style={{
            transform: `scale(${logoScale})`,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <LogoReveal size={isVertical ? 52 : 56} />
        </div>

        <div
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 38 : 44,
            color: accentColor,
            textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 20px ${accentColor}40`,
            textAlign: "center",
            transform: `translateY(${titleY}px)`,
            opacity: titleOpacity,
            padding: "0 40px",
            lineHeight: 1.2,
          }}
        >
          {title}
        </div>

        <div
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 20 : 22,
            color: "rgba(255,255,255,0.8)",
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            textAlign: "center",
            opacity: subtitleOpacity,
            padding: "0 60px",
            lineHeight: 1.4,
          }}
        >
          {subtitle}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
