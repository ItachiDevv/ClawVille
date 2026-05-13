import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { GradientBackground } from "../shared/GradientBackground";
import { ParticleField } from "../shared/ParticleField";
import { AvatarSprite } from "../shared/AvatarSprite";
import { ClawPanel } from "../shared/ClawPanel";
import { LogoReveal } from "../shared/LogoReveal";
import { CTAButton } from "../shared/CTAButton";
import { ALL_SPECIES, SPECIES_LABELS } from "../../constants/species";
import { SHOWCASE_ARCHETYPES } from "../../constants/archetypes";
import { COLORS } from "../../constants/colors";
import { SPRING_BOUNCY, SPRING_SNAPPY, FPS } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Title Splash (0-2s)
const TitleSplash: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoEntrance = spring({ frame, fps, config: SPRING_BOUNCY });
  const subtitleEntrance = spring({ frame, fps, delay: 15, config: { damping: 200 } });

  const scale = interpolate(logoEntrance, [0, 1], [0.2, 1]);
  const subtitleOpacity = interpolate(subtitleEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
          transform: `scale(${scale})`,
        }}
      >
        <LogoReveal size={80} />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 28,
            color: COLORS.panel,
            opacity: subtitleOpacity,
            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
            textAlign: "center",
          }}
        >
          Choose Your Lobster
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Species Carousel (2-10s)
const SpeciesCarousel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;
  const speciesIds = ALL_SPECIES;

  const gridTransition = spring({
    frame,
    fps,
    delay: 4 * fps,
    config: { damping: 200 },
    durationInFrames: fps,
  });

  const cols = isVertical ? 2 : 4;
  const rows = isVertical ? 4 : 2;
  const spriteSize = isVertical ? 140 : 120;
  const gridGap = isVertical ? 20 : 30;
  const gridWidth = cols * (spriteSize + gridGap) - gridGap;
  const gridHeight = rows * (spriteSize + gridGap) - gridGap;
  const gridStartX = (width - gridWidth) / 2;
  const gridStartY = (height - gridHeight) / 2;

  return (
    <AbsoluteFill>
      {speciesIds.map((species, i) => {
        const showFrame = i * fps;
        if (frame < showFrame) return null;

        const col = i % cols;
        const row = Math.floor(i / cols);
        const gridX = gridStartX + col * (spriteSize + gridGap) + spriteSize / 2;
        const gridY = gridStartY + row * (spriteSize + gridGap) + spriteSize / 2;
        const centerX = width / 2;
        const centerY = height / 2;

        const x = interpolate(gridTransition, [0, 1], [centerX, gridX]);
        const y = interpolate(gridTransition, [0, 1], [centerY, gridY]);

        const soloIndex = Math.min(Math.floor(frame / fps), speciesIds.length - 1);
        const isSolo = gridTransition < 0.1;
        const soloOpacity = isSolo ? (soloIndex === i ? 1 : 0) : 1;

        return (
          <div
            key={species}
            style={{
              position: "absolute",
              left: x - spriteSize / 2,
              top: y - spriteSize / 2,
              opacity: soloOpacity,
            }}
          >
            <AvatarSprite species={species} size={spriteSize} enterDelay={showFrame} bob />
            <div
              style={{
                textAlign: "center",
                fontFamily: roboto,
                fontSize: 16,
                fontWeight: 700,
                color: COLORS.panel,
                textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
                marginTop: 4,
                opacity: gridTransition,
              }}
            >
              {SPECIES_LABELS[species]}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: Archetype Showcase (10-13s)
const ArchetypeShowcase: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 16,
        flexDirection: "column",
        padding: isVertical ? 40 : 60,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 36,
          color: COLORS.accent,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          marginBottom: 16,
        }}
      >
        Choose a Personality
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: isVertical ? 16 : 12, alignItems: "center" }}>
        {SHOWCASE_ARCHETYPES.map((arch, i) => {
          const entrance = spring({ frame, fps, delay: i * 8, config: SPRING_SNAPPY });
          const slideX = interpolate(entrance, [0, 1], [i % 2 === 0 ? -300 : 300, 0]);
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], { extrapolateRight: "clamp" });

          return (
            <div key={arch.id} style={{ transform: `translateX(${slideX}px)`, opacity }}>
              <ClawPanel width={isVertical ? 360 : 500}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: roboto, fontSize: 22, fontWeight: 700, color: COLORS.panel }}>
                    {arch.label}
                  </span>
                  <span style={{ fontFamily: roboto, fontSize: 16, color: COLORS.accent, fontStyle: "italic" }}>
                    {arch.tone}
                  </span>
                </div>
              </ClawPanel>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (13-15s)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 24 }}>
      <LogoReveal size={56} />
      <CTAButton text="Enter ClawVille" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main composition
export const MeetTheClaws: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <GradientBackground />
      <ParticleField count={25} color={COLORS.accent} speed={0.5} />

      <Sequence durationInFrames={2 * fps} premountFor={fps}>
        <TitleSplash />
      </Sequence>

      <Sequence from={2 * fps} durationInFrames={8 * fps} premountFor={fps}>
        <SpeciesCarousel />
      </Sequence>

      <Sequence from={10 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <ArchetypeShowcase />
      </Sequence>

      <Sequence from={13 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
