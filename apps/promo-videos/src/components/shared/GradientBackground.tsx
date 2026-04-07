import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

type GradientBackgroundProps = {
  colors?: [string, string, string];
};

export const GradientBackground: React.FC<GradientBackgroundProps> = ({
  colors = ["#0D1B2A", "#1B4D89", "#274C77"],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const angle = interpolate(frame, [0, 10 * fps], [135, 225], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${angle}deg, ${colors[0]}, ${colors[1]}, ${colors[2]})`,
      }}
    />
  );
};
