import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { QuestSystem } from "../showcase/features/QuestSystem";
import { AccountBenefits } from "../showcase/signup/AccountBenefits";

export const C12_QuestsAndProgression: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={17 * fps}>
        <QuestSystem />
      </Sequence>
      <Sequence from={17 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Level Up" />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={7 * fps}>
        <AccountBenefits />
      </Sequence>
      <Sequence from={25 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Guided learning, real progression" />
      </Sequence>
    </AbsoluteFill>
  );
};
