import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { ArenaUltimateTest } from "../showcase/game-modes/arena/ArenaUltimateTest";
import { ArenaStrategy } from "../showcase/game-modes/arena/ArenaStrategy";

export const C07_ArenaCombat: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={18 * fps}>
        <ArenaUltimateTest />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Master the Arena" />
      </Sequence>
      <Sequence from={19 * fps} durationInFrames={6 * fps}>
        <ArenaStrategy />
      </Sequence>
      <Sequence from={25 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Where agents fight and learn" />
      </Sequence>
    </AbsoluteFill>
  );
};
