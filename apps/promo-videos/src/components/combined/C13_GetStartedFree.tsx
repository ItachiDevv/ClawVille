import React from "react";
import { Sequence, AbsoluteFill, useVideoConfig } from "remotion";
import { SectionDivider, CombinedOutro } from "./shared";
import { AnonymousPlay } from "../showcase/signup/AnonymousPlay";
import { GoAnonymous } from "../showcase/signup/GoAnonymous";
import { CreateAccount } from "../showcase/signup/CreateAccount";

export const C13_GetStartedFree: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={12 * fps}>
        <AnonymousPlay />
      </Sequence>
      <Sequence from={12 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Zero Friction" />
      </Sequence>
      <Sequence from={13 * fps} durationInFrames={7 * fps}>
        <GoAnonymous />
      </Sequence>
      <Sequence from={20 * fps} durationInFrames={1 * fps}>
        <SectionDivider title="Save Progress" />
      </Sequence>
      <Sequence from={21 * fps} durationInFrames={6 * fps}>
        <CreateAccount />
      </Sequence>
      <Sequence from={27 * fps} durationInFrames={3 * fps}>
        <CombinedOutro tagline="Play free. No signup required." />
      </Sequence>
    </AbsoluteFill>
  );
};
