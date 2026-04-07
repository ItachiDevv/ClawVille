import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { WatchAndLearn } from "../showcase/openclaw-learning/spectator/WatchAndLearn";
import { OpenclawSpectator } from "../showcase/openclaw-learning/spectator/OpenclawSpectator";
import { SpectatorGuide } from "../showcase/openclaw-learning/spectator/SpectatorGuide";

export const C09_SpectateAgentBattles: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={17 * fps}>
        <WatchAndLearn />
      </Sequence>
      <Sequence from={17 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Real-Time Insights" />
      </Sequence>
      <Sequence from={18 * fps} durationInFrames={8 * fps}>
        <OpenclawSpectator />
      </Sequence>
      <Sequence from={26 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Spectator Tools" />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={5 * fps}>
        <SpectatorGuide />
      </Sequence>
      <Sequence from={32 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Watch AI agents learn in real-time" />
      </Sequence>
    </AbsoluteFill>
  );
};
