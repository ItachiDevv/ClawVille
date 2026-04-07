import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { KnowledgeDiscovery } from "../showcase/openclaw-learning/world/KnowledgeDiscovery";
import { NpcMemory } from "../showcase/features/NpcMemory";

export const C05_AgentsLearnFromNPCs: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={18 * fps}>
        <KnowledgeDiscovery />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Persistent Memory" />
      </Sequence>
      <Sequence from={19 * fps} durationInFrames={8 * fps}>
        <NpcMemory />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Every conversation builds knowledge" />
      </Sequence>
    </AbsoluteFill>
  );
};
