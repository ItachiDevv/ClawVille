import React from "react";
import {
  spring,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { TypewriterText } from "./TypewriterText";
import { SPRING_SNAPPY } from "../../constants/timing";

type SpeechBubbleProps = {
  text: string;
  direction?: "left" | "right";
  delay?: number;
  maxWidth?: number;
};

export const SpeechBubble: React.FC<SpeechBubbleProps> = ({
  text,
  direction = "left",
  delay = 0,
  maxWidth = 300,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    delay,
    config: SPRING_SNAPPY,
  });

  const scale = interpolate(entrance, [0, 1], [0.5, 1]);
  const opacity = interpolate(entrance, [0, 1], [0, 1]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: direction === "left" ? "row" : "row-reverse",
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: direction === "left" ? "left center" : "right center",
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: 16,
          padding: "12px 18px",
          maxWidth,
          position: "relative",
          boxShadow: "2px 2px 8px rgba(0,0,0,0.15)",
        }}
      >
        <TypewriterText
          text={text}
          startFrame={delay + 5}
          charsPerSecond={25}
          style={{
            fontFamily: "Roboto, sans-serif",
            fontSize: 18,
            color: "#333",
            lineHeight: 1.4,
          }}
        />
      </div>
    </div>
  );
};
