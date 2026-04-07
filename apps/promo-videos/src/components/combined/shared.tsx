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
import { SPRING_SNAPPY } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

/** Brief section divider between combined scenes */
export const SectionDivider: React.FC<{
  title: string;
  accentColor?: string;
}> = ({ title, accentColor = "#00E5FF" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({ frame, fps, config: SPRING_SNAPPY });
  const scale = interpolate(entrance, [0, 1], [0.7, 1]);
  const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Line expand
  const lineWidth = interpolate(entrance, [0, 1], [0, 200]);

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #0A1628 0%, #0D1B2A 50%, #0A1628 100%)",
        justifyContent: "center",
        alignItems: "center",
        gap: 16,
      }}
    >
      <div
        style={{
          width: lineWidth,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
          opacity,
        }}
      />
      <span
        style={{
          fontFamily: lobster,
          fontSize: 28,
          color: accentColor,
          textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 15px ${accentColor}40`,
          transform: `scale(${scale})`,
          opacity,
          textAlign: "center",
          padding: "0 40px",
        }}
      >
        {title}
      </span>
      <div
        style={{
          width: lineWidth,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
          opacity,
        }}
      />
    </AbsoluteFill>
  );
};

/** Outro CTA for combined videos */
export const CombinedOutro: React.FC<{
  tagline?: string;
}> = ({ tagline = "Your agent is waiting" }) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();
  const isVertical = height > width;

  const entrance = spring({ frame, fps, config: SPRING_SNAPPY });
  const scale = interpolate(entrance, [0, 1], [0.5, 1]);
  const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  const taglineEntrance = spring({ frame, fps, delay: 12, config: { damping: 200 } });
  const taglineOpacity = interpolate(taglineEntrance, [0, 1], [0, 1]);

  const urlEntrance = spring({ frame, fps, delay: 20, config: SPRING_SNAPPY });
  const urlOpacity = interpolate(urlEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #0D1B2A 0%, #1B4D89 50%, #0A1628 100%)",
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 16,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 42 : 48,
          color: "#00E5FF",
          textShadow: "2px 2px 0px rgba(0,0,0,0.5), 0 0 20px rgba(0,229,255,0.3)",
          transform: `scale(${scale})`,
          opacity,
        }}
      >
        ClawVille
      </span>
      <span
        style={{
          fontFamily: roboto,
          fontSize: isVertical ? 20 : 22,
          color: "rgba(255,255,255,0.8)",
          opacity: taglineOpacity,
          textAlign: "center",
          padding: "0 40px",
        }}
      >
        {tagline}
      </span>
      <div
        style={{
          background: "linear-gradient(135deg, #00E676, #00C853)",
          borderRadius: 30,
          padding: "12px 32px",
          opacity: urlOpacity,
          boxShadow: "0 0 20px rgba(0,230,118,0.4)",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            fontWeight: 700,
            color: "#fff",
          }}
        >
          play.clawville.com
        </span>
      </div>
    </AbsoluteFill>
  );
};
