import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { GradientBackground } from "../shared/GradientBackground";
import { PetSprite } from "../shared/PetSprite";
import { LogoReveal } from "../shared/LogoReveal";
import { CTAButton } from "../shared/CTAButton";
import { ALL_SPECIES, SPECIES_LABELS, type Species } from "../../constants/species";
import { COLORS } from "../../constants/colors";
import { FPS, SPRING_BOUNCY, SPRING_SNAPPY } from "../../constants/timing";

const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const SPECIES_TAGLINES: Record<Species, string> = {
  cat: "Coral Reef Hunter",
  dragon: "Deep-Sea Predator",
  fox: "Spiny & Sharp",
  owl: "Shell Collector",
  wolf: "Iron Crusher",
  bunny: "Bubble Dancer",
  phoenix: "Mantis Striker",
  turtle: "Armored Tank",
};

// Scene 1: Hook (0-2s, frames 0-60)
const SpeciesHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const textEntrance = spring({
    frame,
    fps,
    delay: 15,
    config: SPRING_BOUNCY,
  });
  const textScale = interpolate(textEntrance, [0, 1], [0.3, 1]);
  const textOpacity = interpolate(textEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 30,
        flexDirection: "column",
      }}
    >
      <LogoReveal size={56} delay={0} />

      <div
        style={{
          transform: `scale(${textScale})`,
          opacity: textOpacity,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 32,
            fontWeight: 700,
            color: "#FFFFFF",
            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
          }}
        >
          8 Lobster Species. Infinite Possibilities.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Species Showcase (2-10s, frames 60-300)
const SpeciesShowcase: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Each species gets ~1s (fps frames) of spotlight
  const soloIndex = Math.min(Math.floor(frame / fps), 7);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {ALL_SPECIES.map((species, i) => {
        // Calculate local frame relative to when this species appears
        const speciesStart = i * fps;
        const speciesEnd = (i + 1) * fps;
        const isActive = soloIndex === i;

        // Entrance spring for the active species
        const entrance = spring({
          frame,
          fps,
          delay: speciesStart,
          config: SPRING_BOUNCY,
        });

        // Fade out as next species comes in (last 8 frames of the slot)
        const fadeOut =
          i < 7
            ? interpolate(
                frame,
                [speciesEnd - 8, speciesEnd],
                [1, 0],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }
              )
            : 1;

        // Only render the current active species
        const opacity = isActive ? fadeOut : 0;
        if (opacity <= 0 && !isActive) return null;

        // Name entrance spring (slightly delayed after lobster)
        const nameEntrance = spring({
          frame,
          fps,
          delay: speciesStart + 5,
          config: SPRING_SNAPPY,
        });
        const nameSlideY = interpolate(nameEntrance, [0, 1], [30, 0]);
        const nameOpacity = interpolate(nameEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        // Tagline entrance (slightly delayed after name)
        const taglineEntrance = spring({
          frame,
          fps,
          delay: speciesStart + 12,
          config: SPRING_SNAPPY,
        });
        const taglineSlideY = interpolate(taglineEntrance, [0, 1], [20, 0]);
        const taglineOpacity = interpolate(
          taglineEntrance,
          [0, 0.5],
          [0, 1],
          { extrapolateRight: "clamp" }
        );

        const displayName = SPECIES_LABELS[species];

        return (
          <div
            key={species}
            style={{
              position: "absolute",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              opacity,
            }}
          >
            <PetSprite
              species={species}
              size={160}
              enterDelay={speciesStart}
              bob
            />

            <span
              style={{
                fontFamily: roboto,
                fontSize: 28,
                fontWeight: 700,
                color: "#FFFFFF",
                textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
                transform: `translateY(${nameSlideY}px)`,
                opacity: nameOpacity,
              }}
            >
              {displayName}
            </span>

            <span
              style={{
                fontFamily: roboto,
                fontSize: 22,
                fontWeight: 400,
                color: COLORS.panel,
                textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
                fontStyle: "italic",
                transform: `translateY(${taglineSlideY}px)`,
                opacity: taglineOpacity,
              }}
            >
              {SPECIES_TAGLINES[species]}
            </span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: All Together (10-13s, frames 300-390)
const AllTogether: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const cols = isVertical ? 2 : 4;
  const rows = isVertical ? 4 : 2;
  const spriteSize = isVertical ? 100 : 90;
  const gap = isVertical ? 16 : 24;
  const gridWidth = cols * (spriteSize + gap) - gap;
  const gridHeight = rows * (spriteSize + gap + 24) - gap;
  const startX = (width - gridWidth) / 2;
  const startY = (height - gridHeight) / 2 + 30;

  // Title entrance
  const titleEntrance = spring({
    frame,
    fps,
    delay: 0,
    config: SPRING_BOUNCY,
  });
  const titleScale = interpolate(titleEntrance, [0, 1], [0.3, 1]);
  const titleOpacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: startY - 60,
          width: "100%",
          textAlign: "center",
          transform: `scale(${titleScale})`,
          opacity: titleOpacity,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 36,
            fontWeight: 700,
            color: COLORS.neoToken,
            textShadow: `
              2px 2px 0px rgba(0,0,0,0.3),
              0 0 15px rgba(255,215,0,0.4)
            `,
          }}
        >
          Which will you choose?
        </span>
      </div>

      {/* Species grid */}
      {ALL_SPECIES.map((species, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * (spriteSize + gap);
        const y = startY + row * (spriteSize + gap + 24);

        // Staggered entrance: delay = index * 4 frames
        const entrance = spring({
          frame,
          fps,
          delay: i * 4,
          config: SPRING_BOUNCY,
        });
        const scale = interpolate(entrance, [0, 1], [0, 1]);
        const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        const displayName = SPECIES_LABELS[species];

        return (
          <div
            key={species}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: spriteSize,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              transform: `scale(${scale})`,
              opacity,
            }}
          >
            <PetSprite species={species} size={spriteSize} enterDelay={i * 4} bob />
            <span
              style={{
                fontFamily: roboto,
                fontSize: 12,
                fontWeight: 700,
                color: "#FFFFFF",
                textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                marginTop: 4,
                textAlign: "center",
              }}
            >
              {displayName}
            </span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: CTA (13-15s, frames 390-450)
const SpeciesCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        flexDirection: "column",
      }}
    >
      <LogoReveal size={56} delay={0} />
      <CTAButton
        text="Create Your Lobster"
        subtitle="play.clawville.com"
        delay={10}
      />
    </AbsoluteFill>
  );
};

// Main Video 15 composition
export const ChooseSpecies: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bgGradient1, COLORS.bgGradient2, COLORS.bgGradient3]} />

      <Sequence durationInFrames={2 * fps} premountFor={fps}>
        <SpeciesHook />
      </Sequence>

      <Sequence from={2 * fps} durationInFrames={8 * fps} premountFor={fps}>
        <SpeciesShowcase />
      </Sequence>

      <Sequence from={10 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <AllTogether />
      </Sequence>

      <Sequence from={13 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <SpeciesCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
