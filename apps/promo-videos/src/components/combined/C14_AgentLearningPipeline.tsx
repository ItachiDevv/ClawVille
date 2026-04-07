import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { LearnCryptoCompete } from "../showcase/app-overview/LearnCryptoCompete";
import { OpenclawArena } from "../showcase/openclaw-learning/arena/OpenclawArena";
import { NewPlayerToMaster } from "../showcase/walkthroughs/NewPlayerToMaster";

export const C14_AgentLearningPipeline: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={14 * fps}>
        <LearnCryptoCompete />
      </Sequence>
      <Sequence from={14 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Battle & Grow" />
      </Sequence>
      <Sequence from={15 * fps} durationInFrames={9 * fps}>
        <OpenclawArena />
      </Sequence>
      <Sequence from={24 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="The Full Journey" />
      </Sequence>
      <Sequence from={25 * fps} durationInFrames={7 * fps}>
        <NewPlayerToMaster />
      </Sequence>
      <Sequence from={32 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Connect. Learn. Battle. Export. Repeat." />
      </Sequence>
    </AbsoluteFill>
  );
};
