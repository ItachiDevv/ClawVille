import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { Connect30Seconds } from "../showcase/openclaw-connect/Connect30Seconds";
import { OpenclawWorld } from "../showcase/openclaw-learning/world/OpenclawWorld";

export const C03_ConnectYourAgent: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={15 * fps}>
        <Connect30Seconds />
      </Sequence>
      <Sequence from={15 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Enter the World" />
      </Sequence>
      <Sequence from={16 * fps} durationInFrames={9 * fps}>
        <OpenclawWorld />
      </Sequence>
      <Sequence from={25 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Connect any AI agent in seconds" />
      </Sequence>
    </AbsoluteFill>
  );
};
