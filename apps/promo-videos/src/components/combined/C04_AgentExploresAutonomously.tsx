import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { BotExploration } from "../showcase/openclaw-learning/world/BotExploration";
import { YourLobsterJourney } from "../showcase/game-modes/world/YourLobsterJourney";

export const C04_AgentExploresAutonomously: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={17 * fps}>
        <BotExploration />
      </Sequence>
      <Sequence from={17 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Your Agent's Journey" />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={9 * fps}>
        <YourLobsterJourney />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Your agent explores while you're away" />
      </Sequence>
    </AbsoluteFill>
  );
};
