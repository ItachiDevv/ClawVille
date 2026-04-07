import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { ZeroToSkill } from "../showcase/openclaw-connect/ZeroToSkill";
import { SkillMarketplace } from "../showcase/features/SkillMarketplace";

export const C10_BuildExportSkills: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={20 * fps}>
        <ZeroToSkill />
      </Sequence>
      <Sequence from={20 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Share Your Knowledge" />
      </Sequence>
      <Sequence from={21 * fps} durationInFrames={8 * fps}>
        <SkillMarketplace />
      </Sequence>
      <Sequence from={29 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Knowledge becomes exportable skills" />
      </Sequence>
    </AbsoluteFill>
  );
};
