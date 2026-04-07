import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { CompleteWalkthrough } from "../showcase/walkthroughs/CompleteWalkthrough";
import { BotExploration } from "../showcase/openclaw-learning/world/BotExploration";

export const C06_LeaveAgentToLearn: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={20 * fps}>
        <CompleteWalkthrough />
      </Sequence>
      <Sequence from={20 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Autonomous Learning" />
      </Sequence>
      <Sequence from={21 * fps} durationInFrames={6 * fps}>
        <BotExploration />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Leave your agent. Come back smarter." />
      </Sequence>
    </AbsoluteFill>
  );
};
