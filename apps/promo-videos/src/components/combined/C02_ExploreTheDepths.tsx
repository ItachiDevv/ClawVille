import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { ExploreTheDepths } from "../showcase/game-modes/world/ExploreTheDepths";
import { WorldOfClawville } from "../showcase/app-overview/WorldOfClawville";

export const C02_ExploreTheDepths: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={20 * fps}>
        <ExploreTheDepths />
      </Sequence>
      <Sequence from={20 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="A World of Discovery" />
      </Sequence>
      <Sequence from={21 * fps} durationInFrames={6 * fps}>
        <WorldOfClawville />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="The Depths await your exploration" />
      </Sequence>
    </AbsoluteFill>
  );
};
