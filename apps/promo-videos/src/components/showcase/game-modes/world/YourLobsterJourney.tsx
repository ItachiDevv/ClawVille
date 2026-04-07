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
import { RecordingBackground, LiveBadge } from "../../../shared/RecordingBackground";
import { ParticleField } from "../../../shared/ParticleField";
import { PetSprite } from "../../../shared/PetSprite";
import { NeopetsPanel } from "../../../shared/NeopetsPanel";
import { SpeechBubble } from "../../../shared/SpeechBubble";
import { StatBar } from "../../../shared/StatBar";
import { CTAButton } from "../../../shared/CTAButton";
import { LogoReveal } from "../../../shared/LogoReveal";
import { TitleScreen } from "../../shared/TitleScreen";
import { COLORS } from "../../../../constants/colors";
import { SPRING_BOUNCY, SPRING_SNAPPY } from "../../../../constants/timing";
import { ARCHETYPES } from "../../../../constants/archetypes";
import type { Species } from "../../../../constants/species";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const SHOWCASE_SPECIES: { species: Species; name: string }[] = [
  { species: "dragon", name: "Dragon" },
  { species: "fox", name: "Fox" },
  { species: "owl", name: "Owl" },
];

// Scene 2: Species Choice (1-4s, frames 30-120)
const SpeciesChoice: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const headerEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const headerOpacity = interpolate(headerEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const spriteSize = isVertical ? 130 : 120;
  const spacing = isVertical ? 30 : 50;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Header */}
      <div
        style={{
          position: "absolute",
          top: isVertical ? 70 : 50,
          opacity: headerOpacity,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 32 : 38,
            color: COLORS.gold,
            textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          }}
        >
          Choose Your Species
        </span>
      </div>

      {/* 3 species bounce in */}
      <div
        style={{
          display: "flex",
          gap: spacing,
          alignItems: "flex-end",
        }}
      >
        {SHOWCASE_SPECIES.map((s, i) => {
          const delay = 8 + i * 10;
          const entrance = spring({
            frame,
            fps,
            delay,
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const slideY = interpolate(entrance, [0, 1], [80, 0]);

          return (
            <div
              key={s.species}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                transform: `scale(${scale}) translateY(${slideY}px)`,
              }}
            >
              <PetSprite species={s.species} size={spriteSize} enterDelay={delay} bob />
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 20,
                  fontWeight: 700,
                  color: COLORS.white,
                  textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
                }}
              >
                {s.name}
              </span>
            </div>
          );
        })}
      </div>

      {/* "8 species" count */}
      <div
        style={{
          position: "absolute",
          bottom: isVertical ? 80 : 50,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            color: COLORS.panel,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          8 unique species to choose from
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Archetype Selection (4-7s, frames 120-210)
const ArchetypeSelect: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const archetypes = ARCHETYPES.slice(0, 5);
  const panelW = isVertical ? width - 80 : 420;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 14 : 12,
        flexDirection: "column",
        padding: isVertical ? 40 : 60,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 34,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          marginBottom: 10,
        }}
      >
        Pick a Personality
      </span>

      {archetypes.map((arch, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: i * 6,
          config: SPRING_SNAPPY,
        });
        const slideX = interpolate(
          entrance,
          [0, 1],
          [i % 2 === 0 ? -350 : 350, 0]
        );
        const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        // Highlight the selected one
        const isSelected = i === 1;
        const glowSize = isSelected
          ? 4 + Math.sin((frame / fps) * Math.PI * 3) * 3
          : 0;

        return (
          <div
            key={arch.id}
            style={{
              transform: `translateX(${slideX}px)`,
              opacity,
            }}
          >
            <NeopetsPanel
              width={panelW}
              style={
                isSelected
                  ? {
                      boxShadow: `0 0 ${glowSize}px ${COLORS.gold}, 4px 4px 0px rgba(0,0,0,0.3)`,
                      border: `4px solid ${COLORS.gold}`,
                    }
                  : undefined
              }
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 20,
                    fontWeight: 700,
                    color: "#3E2723",
                  }}
                >
                  {isSelected ? `> ${arch.label}` : arch.label}
                </span>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 15,
                    color: "#795548",
                    fontStyle: "italic",
                  }}
                >
                  {arch.tone}
                </span>
              </div>
            </NeopetsPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: Customization (7-11s, frames 210-330)
const Customization: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const entrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const scale = interpolate(entrance, [0, 1], [0.7, 1]);
  const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const statsDelay = 15;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      {/* Pet with name */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <PetSprite species="fox" size={isVertical ? 140 : 130} enterDelay={0} bob />
        <NeopetsPanel width={isVertical ? 240 : 260}>
          <div style={{ textAlign: "center" }}>
            <span
              style={{
                fontFamily: lobster,
                fontSize: 26,
                color: "#3E2723",
              }}
            >
              Blaze
            </span>
            <div
              style={{
                fontFamily: roboto,
                fontSize: 14,
                color: "#795548",
                marginTop: 2,
              }}
            >
              Curious Scholar - Fox
            </div>
          </div>
        </NeopetsPanel>
      </div>

      {/* Stats panel */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <StatBar label="Wisdom" value={0.7} color={COLORS.blue} delay={statsDelay} width={isVertical ? 200 : 220} />
        <StatBar label="Courage" value={0.5} color={COLORS.red} delay={statsDelay + 5} width={isVertical ? 200 : 220} />
        <StatBar label="Charisma" value={0.85} color={COLORS.gold} delay={statsDelay + 10} width={isVertical ? 200 : 220} />
        <StatBar label="Stealth" value={0.4} color={COLORS.darkGreen} delay={statsDelay + 15} width={isVertical ? 200 : 220} />
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Unique Dialogue (11-16s, frames 330-480)
const UniqueDialogue: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const headerEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const headerOpacity = interpolate(headerEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Question
  const questionDelay = 8;

  // Two pets respond differently
  const pet1Delay = fps * 1.5;
  const pet2Delay = fps * 3;

  const petSize = isVertical ? 100 : 90;
  const bubbleWidth = isVertical ? width - 120 : 320;

  return (
    <AbsoluteFill
      style={{
        padding: isVertical ? "40px 20px" : "30px 40px",
      }}
    >
      {/* Header */}
      <div
        style={{
          textAlign: "center",
          marginBottom: 16,
          opacity: headerOpacity,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 28 : 32,
            color: COLORS.gold,
            textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          }}
        >
          Same Question, Different Answers
        </span>
      </div>

      {/* Question */}
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <SpeechBubble
          text="What do you think about DeFi?"
          delay={questionDelay}
          maxWidth={bubbleWidth}
        />
      </div>

      {/* Pet 1 response */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <PetSprite species="dragon" size={petSize} enterDelay={pet1Delay} bob />
        <div style={{ flex: 1 }}>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 13,
              fontWeight: 700,
              color: COLORS.panel,
              textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
            }}
          >
            Drake (Fierce Battler)
          </span>
          <SpeechBubble
            text="DeFi is the ultimate battleground! I crush yield farms!"
            delay={pet1Delay + 5}
            maxWidth={bubbleWidth}
          />
        </div>
      </div>

      {/* Pet 2 response */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexDirection: "row-reverse",
        }}
      >
        <PetSprite species="owl" size={petSize} enterDelay={pet2Delay} bob />
        <div style={{ flex: 1 }}>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 13,
              fontWeight: 700,
              color: COLORS.panel,
              textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
              textAlign: "right",
              display: "block",
            }}
          >
            Sage (Curious Scholar)
          </span>
          <SpeechBubble
            text="DeFi protocols reveal fascinating mechanism design. Let me explain the math..."
            delay={pet2Delay + 5}
            direction="right"
            maxWidth={bubbleWidth}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={56} />
      <CTAButton text="Create Your Lobster" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S14 composition (18s)
export const YourLobsterJourney: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-pet-chat-shop.mp4" startFrom={1} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={20} color={COLORS.gold} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Your Lobster, Your Journey"
          subtitle="Every pet is unique"
          accentColor={COLORS.gold}
        />
      </Sequence>

      {/* Scene 2: Species Choice (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <SpeciesChoice />
      </Sequence>

      {/* Scene 3: Archetype (4-7s) */}
      <Sequence from={4 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <ArchetypeSelect />
      </Sequence>

      {/* Scene 4: Customization (7-11s) */}
      <Sequence from={7 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Customization />
      </Sequence>

      {/* Scene 5: Unique Dialogue (11-16s) */}
      <Sequence from={11 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <UniqueDialogue />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
