import React from "react";
import {
  spring,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SPRING_SMOOTH } from "../../constants/timing";

type AnimatedCounterProps = {
  from?: number;
  to: number;
  delay?: number;
  prefix?: string;
  suffix?: string;
  style?: React.CSSProperties;
};

export const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  from = 0,
  to,
  delay = 0,
  prefix = "",
  suffix = "",
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame,
    fps,
    delay,
    config: SPRING_SMOOTH,
    durationInFrames: fps * 1.5,
  });

  const value = Math.round(interpolate(progress, [0, 1], [from, to]));

  return (
    <span style={style}>
      {prefix}
      {value}
      {suffix}
    </span>
  );
};
