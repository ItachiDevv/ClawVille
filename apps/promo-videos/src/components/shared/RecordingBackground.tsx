import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
} from "remotion";

type RecordingBackgroundProps = {
  src: string;
  tintOpacity?: number;
  tintColor?: string;
  startFrom?: number;
  playbackRate?: number;
  vignette?: boolean;
  scale?: number;
  fadeInFrames?: number;
};

export const RecordingBackground: React.FC<RecordingBackgroundProps> = ({
  src,
  tintOpacity = 0.45,
  tintColor = "#000",
  startFrom = 0,
  playbackRate = 1,
  vignette = true,
  scale = 1.05,
  fadeInFrames = 15,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, fadeInFrames], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          overflow: "hidden",
        }}
      >
        <OffthreadVideo
          src={staticFile(`recordings/${src}`)}
          startFrom={Math.round(startFrom * 30)}
          playbackRate={playbackRate}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </AbsoluteFill>

      {tintOpacity > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: tintColor,
            opacity: tintOpacity,
          }}
        />
      )}

      {vignette && (
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.7) 100%)",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export const LiveBadge: React.FC<{ label?: string; top?: number; right?: number }> = ({
  label = "LIVE GAMEPLAY",
  top = 20,
  right = 20,
}) => {
  const frame = useCurrentFrame();
  const pulse = 0.8 + Math.sin(frame * 0.15) * 0.2;

  return (
    <div
      style={{
        position: "absolute",
        top,
        right,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "rgba(0,0,0,0.6)",
        borderRadius: 20,
        padding: "6px 14px",
        border: "1px solid rgba(255,255,255,0.2)",
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#f44336",
          opacity: pulse,
          boxShadow: "0 0 6px #f44336",
        }}
      />
      <span
        style={{
          fontFamily: "monospace",
          fontSize: 11,
          fontWeight: 700,
          color: "rgba(255,255,255,0.9)",
          letterSpacing: 1,
        }}
      >
        {label}
      </span>
    </div>
  );
};
