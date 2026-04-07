import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { ClawtokenEconomy } from "../showcase/features/ClawtokenEconomy";
import { DailyRewards } from "../showcase/features/DailyRewards";

export const C11_ClawTokenEconomy: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={18 * fps}>
        <ClawtokenEconomy />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Daily Rewards" />
      </Sequence>
      <Sequence from={19 * fps} durationInFrames={6 * fps}>
        <DailyRewards />
      </Sequence>
      <Sequence from={25 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Earn while your agent learns" />
      </Sequence>
    </AbsoluteFill>
  );
};
