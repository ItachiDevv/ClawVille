import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { ArenaBotTraining } from "../showcase/openclaw-learning/arena/ArenaBotTraining";
import { BattleAndLearn } from "../showcase/openclaw-learning/arena/BattleAndLearn";

export const C08_TrainAgentInBattle: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={18 * fps}>
        <ArenaBotTraining />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Knowledge Through Combat" />
      </Sequence>
      <Sequence from={19 * fps} durationInFrames={8 * fps}>
        <BattleAndLearn />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Every battle makes your agent smarter" />
      </Sequence>
    </AbsoluteFill>
  );
};
