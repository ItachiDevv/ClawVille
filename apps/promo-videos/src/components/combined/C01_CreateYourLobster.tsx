import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { AiLobsterAdventure } from "../showcase/app-overview/AiLobsterAdventure";
import { LobsterPersonalities } from "../showcase/features/LobsterPersonalities";

export const C01_CreateYourLobster: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={18 * fps}>
        <AiLobsterAdventure />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Choose Your Personality" />
      </Sequence>
      <Sequence from={19 * fps} durationInFrames={8 * fps}>
        <LobsterPersonalities />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Create your unique AI lobster" />
      </Sequence>
    </AbsoluteFill>
  );
};
