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
import { TitleScreen } from "../shared/TitleScreen";
import { RecordingBackground, LiveBadge } from "../../shared/RecordingBackground";
import { ParticleField } from "../../shared/ParticleField";
import { PetSprite } from "../../shared/PetSprite";
import { ClawPanel } from "../../shared/ClawPanel";
import { SpeechBubble } from "../../shared/SpeechBubble";
import { BookIcon } from "../../shared/BookIcon";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { ClawTokenIcon } from "../../shared/ClawTokenIcon";
import { TerminalBlock } from "../../shared/TerminalBlock";
import { LogoReveal } from "../../shared/LogoReveal";
import { CTAButton } from "../../shared/CTAButton";
import { ALL_SPECIES } from "../../../constants/species";
import { SHOWCASE_ARCHETYPES } from "../../../constants/archetypes";
import { BUILDING_THEMES } from "../../../constants/buildings";
import { PARADE_BOOKS } from "../../../constants/books";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Avatar Creation (1-5s, frames 30-150)
const PetCreation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const species = [ALL_SPECIES[0], ALL_SPECIES[1], ALL_SPECIES[2]]; // cat, dragon, fox

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 24 : 20,
        flexDirection: "column",
      }}
    >
      {/* Title */}
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 32 : 38,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
        }}
      >
        Create Your Lobster
      </span>

      {/* 3 avatars bounce in */}
      <div
        style={{
          display: "flex",
          gap: isVertical ? 30 : 50,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {species.map((s, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 12,
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const y = interpolate(entrance, [0, 1], [80, 0]);

          return (
            <div
              key={s}
              style={{
                transform: `scale(${scale}) translateY(${y}px)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
              }}
            >
              <PetSprite
                species={s}
                size={isVertical ? 120 : 110}
                enterDelay={i * 12}
                bob
              />
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  fontWeight: 700,
                  color: COLORS.white,
                  textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                  textTransform: "capitalize",
                }}
              >
                {s}
              </span>
            </div>
          );
        })}
      </div>

      {/* Archetype labels slide alternating left/right */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "center",
          marginTop: 12,
        }}
      >
        {SHOWCASE_ARCHETYPES.slice(0, 3).map((arch, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: 30 + i * 10,
            config: SPRING_SNAPPY,
          });
          const slideX = interpolate(
            entrance,
            [0, 1],
            [i % 2 === 0 ? -400 : 400, 0]
          );
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={arch.id}
              style={{
                transform: `translateX(${slideX}px)`,
                opacity,
              }}
            >
              <ClawPanel width={isVertical ? 300 : 380}>
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
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {arch.label}
                  </span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
                      color: "#795548",
                      fontStyle: "italic",
                    }}
                  >
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

// Scene 3: World Exploration (5-9s, frames 150-270)
const WorldExploration: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Avatar walks across screen
  const walkProgress = interpolate(frame, [0, 3 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });
  const avatarX = interpolate(walkProgress, [0, 1], [-100, width + 100]);

  // Building icons pop in
  const buildings = BUILDING_THEMES.slice(0, 6);

  return (
    <AbsoluteFill>
      {/* Header */}
      <div
        style={{
          position: "absolute",
          top: isVertical ? 60 : 30,
          left: 0,
          right: 0,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 30 : 36,
            color: COLORS.gold,
            textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          }}
        >
          Explore 15 Buildings
        </span>
      </div>

      {/* Walking avatar */}
      <div
        style={{
          position: "absolute",
          left: avatarX,
          top: height * (isVertical ? 0.35 : 0.3),
        }}
      >
        <PetSprite species="fox" size={90} bob />
      </div>

      {/* Building icons grid */}
      <div
        style={{
          position: "absolute",
          bottom: isVertical ? 120 : 60,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          flexWrap: "wrap",
          gap: isVertical ? 16 : 24,
          padding: "0 40px",
        }}
      >
        {buildings.map((b, i) => {
          const pop = spring({
            frame,
            fps,
            delay: i * 8 + 10,
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(pop, [0, 1], [0, 1]);

          return (
            <div
              key={b.name}
              style={{
                transform: `scale(${scale})`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.15)",
                  border: `2px solid ${COLORS.gold}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 28,
                }}
              >
                {b.icon}
              </div>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 11,
                  color: COLORS.white,
                  textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                  textAlign: "center",
                  maxWidth: 70,
                }}
              >
                {b.name}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Learning Montage (9-13s, frames 270-390)
const LearningMontage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const tokenPulse = 1 + Math.sin((frame / fps) * 4 * Math.PI) * 0.1;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 24,
        flexDirection: "column",
        padding: isVertical ? 40 : 60,
      }}
    >
      {/* NPC Chat bubble */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 16,
          width: isVertical ? "90%" : "70%",
        }}
      >
        <PetSprite species="owl" size={60} enterDelay={0} bob={false} />
        <SpeechBubble
          text="Let me teach you about Solana validators..."
          delay={5}
          maxWidth={isVertical ? 260 : 340}
        />
      </div>

      {/* Books floating */}
      <div
        style={{
          display: "flex",
          gap: isVertical ? 20 : 32,
          justifyContent: "center",
        }}
      >
        {PARADE_BOOKS.slice(0, 3).map((book, i) => (
          <BookIcon
            key={book.id}
            icon={book.icon}
            name={book.name}
            price={book.price}
            size={isVertical ? 60 : 70}
            delay={fps + i * 10}
          />
        ))}
      </div>

      {/* Counter + Token */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          marginTop: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              color: COLORS.panel,
              textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
            }}
          >
            Knowledge
          </span>
          <AnimatedCounter
            to={24}
            delay={fps * 1.5}
            style={{
              fontFamily: lobster,
              fontSize: 48,
              color: COLORS.gold,
              textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
            }}
          />
        </div>

        <div
          style={{
            transform: `scale(${tokenPulse})`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <ClawTokenIcon size={52} />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: COLORS.gold,
            }}
          >
            Earn ClawTokens
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Skill Export (13-16s, frames 390-480)
const SkillExport: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const arrowEntrance = spring({
    frame,
    fps,
    delay: fps * 2,
    config: SPRING_SNAPPY,
  });
  const arrowX = interpolate(arrowEntrance, [0, 1], [-40, 0]);
  const arrowOpacity = interpolate(arrowEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 24 : 32,
        flexDirection: isVertical ? "column" : "row",
        padding: isVertical ? 40 : 60,
      }}
    >
      {/* Terminal */}
      <TerminalBlock
        lines={[
          "clawville export --format skill.md",
          "",
          "# My Avatar's Knowledge",
          "## DeFi Strategies",
          "- Jupiter routing optimized",
          "- LP position management",
          "",
          "Exported 24 skills successfully!",
        ]}
        startFrame={5}
        charsPerSecond={50}
        width={isVertical ? 340 : 380}
      />

      {/* Arrow to marketplace */}
      <div
        style={{
          transform: `translateX(${arrowX}px)`,
          opacity: arrowOpacity,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 40 }}>{isVertical ? "\u2B07" : "\u27A1"}</span>
        <ClawPanel width={isVertical ? 280 : 240}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 18,
                fontWeight: 700,
                color: "#3E2723",
              }}
            >
              Skill Marketplace
            </span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 14,
                color: "#795548",
              }}
            >
              Sell to other players
            </span>
          </div>
        </ClawPanel>
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
      <CTAButton
        text="Start Your Adventure"
        subtitle="play.clawville.com"
      />
    </AbsoluteFill>
  );
};

// Main S01 composition (18s)
export const AiLobsterAdventure: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-world-exploration-npcs.mp4" startFrom={2} tintOpacity={0.5} />
      <LiveBadge />
      <ParticleField count={25} color={COLORS.gold} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Your AI Lobster Adventure"
          subtitle="Create, explore, learn crypto, build skills"
        />
      </Sequence>

      {/* Scene 2: Avatar Creation (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <PetCreation />
      </Sequence>

      {/* Scene 3: World Exploration (5-9s) */}
      <Sequence from={5 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <WorldExploration />
      </Sequence>

      {/* Scene 4: Learning Montage (9-13s) */}
      <Sequence from={9 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <LearningMontage />
      </Sequence>

      {/* Scene 5: Skill Export (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <SkillExport />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
