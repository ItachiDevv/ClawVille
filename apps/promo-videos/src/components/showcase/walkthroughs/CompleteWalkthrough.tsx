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
import { RecordingBackground, LiveBadge } from "../../shared/RecordingBackground";
import { ParticleField } from "../../shared/ParticleField";
import { ClawPanel } from "../../shared/ClawPanel";
import { PetSprite } from "../../shared/PetSprite";
import { SpeechBubble } from "../../shared/SpeechBubble";
import { BookIcon } from "../../shared/BookIcon";
import { ClawTokenIcon } from "../../shared/ClawTokenIcon";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { TerminalBlock } from "../../shared/TerminalBlock";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../../constants/timing";
import { ALL_SPECIES } from "../../../constants/species";
import { KNOWLEDGE_BOOKS } from "../../../constants/books";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Signup Flow (1-4s, frames 30-120)
const SignupScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const steps = [
    { emoji: "🐾", label: "Pick Species" },
    { emoji: "🧠", label: "Choose Archetype" },
    { emoji: "✏️", label: "Name Your Lobster" },
  ];

  // Species selector animation
  const speciesIdx = Math.min(
    Math.floor(frame / (fps * 0.4)),
    ALL_SPECIES.length - 1
  );

  // "Created!" badge
  const createdEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.2 * fps),
    config: SPRING_BOUNCY,
  });
  const createdScale = interpolate(createdEntrance, [0, 1], [0, 1]);
  const createdOpacity = interpolate(createdEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 20 : 16,
        padding: 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 32 : 36,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Create Your Lobster
      </span>

      {/* Step indicators */}
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        {steps.map((step, i) => {
          const stepEntrance = spring({
            frame,
            fps,
            delay: i * Math.round(0.5 * fps),
            config: SPRING_SNAPPY,
          });
          const stepOpacity = interpolate(stepEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });
          const stepScale = interpolate(stepEntrance, [0, 1], [0.5, 1]);

          return (
            <div
              key={step.label}
              style={{
                opacity: stepOpacity,
                transform: `scale(${stepScale})`,
              }}
            >
              <ClawPanel width={isVertical ? 110 : 130}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span style={{ fontSize: 28 }}>{step.emoji}</span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#3E2723",
                      textAlign: "center",
                    }}
                  >
                    {step.label}
                  </span>
                </div>
              </ClawPanel>
            </div>
          );
        })}
      </div>

      {/* Species cycling display */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <PetSprite
          species={ALL_SPECIES[speciesIdx]}
          size={isVertical ? 100 : 90}
          enterDelay={0}
          bob
        />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 22,
            fontWeight: 700,
            color: COLORS.white,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          {ALL_SPECIES[speciesIdx].charAt(0).toUpperCase() +
            ALL_SPECIES[speciesIdx].slice(1)}
        </span>
      </div>

      {/* Created badge */}
      <div
        style={{
          opacity: createdOpacity,
          transform: `scale(${createdScale})`,
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #4CAF50, #2E7D32)",
            borderRadius: 24,
            padding: "10px 32px",
            boxShadow: "0 0 16px rgba(76,175,80,0.6)",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 22,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            Avatar Created!
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: First Building Visit (4-8s, frames 120-240)
const FirstBuilding: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Avatar walks toward building
  const walkProgress = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SMOOTH,
    durationInFrames: Math.round(1.5 * fps),
  });
  const avatarX = interpolate(walkProgress, [0, 1], [-80, 0]);

  // Building label
  const buildingEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.5 * fps),
    config: SPRING_SNAPPY,
  });

  // NPC speech
  const npcDelay = Math.round(1.5 * fps);

  // Book purchase
  const bookDelay = Math.round(2.8 * fps);
  const bookEntrance = spring({
    frame,
    fps,
    delay: bookDelay,
    config: SPRING_BOUNCY,
  });
  const bookScale = interpolate(bookEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 14,
        padding: isVertical ? "50px 30px" : "30px 50px",
      }}
    >
      {/* Building header */}
      <div
        style={{
          opacity: interpolate(buildingEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `translateY(${interpolate(buildingEntrance, [0, 1], [-20, 0])}px)`,
        }}
      >
        <ClawPanel width={isVertical ? 340 : 380}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: 28 }}>📚</span>
            <span
              style={{
                fontFamily: lobster,
                fontSize: 22,
                color: "#3E2723",
              }}
            >
              Web3 Library
            </span>
          </div>
        </ClawPanel>
      </div>

      {/* Avatar walking in */}
      <div style={{ transform: `translateX(${avatarX}px)` }}>
        <PetSprite species="fox" size={isVertical ? 80 : 72} enterDelay={0} bob />
      </div>

      {/* NPC conversation */}
      <SpeechBubble
        text="Welcome! Ready to learn blockchain fundamentals?"
        delay={npcDelay}
        maxWidth={isVertical ? 340 : 400}
        direction="left"
      />

      {/* Book purchase */}
      <div
        style={{
          transform: `scale(${bookScale})`,
          opacity: interpolate(bookEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        <BookIcon
          icon={KNOWLEDGE_BOOKS[0].icon}
          name={KNOWLEDGE_BOOKS[0].name}
          price={KNOWLEDGE_BOOKS[0].price}
          size={isVertical ? 70 : 60}
          delay={bookDelay}
        />
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Learn + Earn (8-12s, frames 240-360)
const LearnAndEarn: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Book absorption glow
  const absorbEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.5 * fps),
    config: SPRING_BOUNCY,
  });
  const absorbScale = interpolate(absorbEntrance, [0, 1], [1.5, 0]);
  const absorbOpacity = interpolate(absorbEntrance, [0, 0.8, 1], [0, 1, 0]);

  // Stats counters
  const counterDelay = Math.round(1.2 * fps);

  // Level up badge
  const levelEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.5 * fps),
    config: SPRING_BOUNCY,
  });
  const levelScale = interpolate(levelEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 24 : 20,
        padding: 40,
      }}
    >
      {/* Book absorption effect */}
      <div
        style={{
          position: "absolute",
          width: 120,
          height: 120,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.gold}60, transparent)`,
          transform: `scale(${absorbScale})`,
          opacity: absorbOpacity,
        }}
      />

      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 34,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Knowledge Absorbed!
      </span>

      {/* Stats row */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 16 : 32,
          alignItems: "center",
        }}
      >
        {/* Knowledge count */}
        <ClawPanel width={isVertical ? 260 : 220}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: 24 }}>📖</span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 16,
                fontWeight: 700,
                color: "#3E2723",
              }}
            >
              Knowledge:
            </span>
            <AnimatedCounter
              from={0}
              to={6}
              delay={counterDelay}
              prefix="+"
              style={{
                fontFamily: roboto,
                fontSize: 24,
                fontWeight: 700,
                color: "#2E7D32",
              }}
            />
          </div>
        </ClawPanel>

        {/* Token count */}
        <ClawPanel width={isVertical ? 260 : 220}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              justifyContent: "center",
            }}
          >
            <ClawTokenIcon size={28} />
            <span
              style={{
                fontFamily: roboto,
                fontSize: 16,
                fontWeight: 700,
                color: "#3E2723",
              }}
            >
              Tokens:
            </span>
            <AnimatedCounter
              from={100}
              to={115}
              delay={counterDelay}
              prefix="+"
              style={{
                fontFamily: roboto,
                fontSize: 24,
                fontWeight: 700,
                color: "#B8860B",
              }}
            />
          </div>
        </ClawPanel>
      </div>

      {/* Level up */}
      <div
        style={{
          opacity: interpolate(levelEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `scale(${levelScale})`,
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #7E57C2, #9C27B0)",
            borderRadius: 24,
            padding: "10px 28px",
            boxShadow: "0 0 20px rgba(156,39,176,0.5)",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 22,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            Level 1 → Level 2
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Build Skill (12-16s, frames 360-480)
const BuildSkill: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Terminal with SKILL.md
  const terminalDelay = Math.round(0.3 * fps);

  // Published badge
  const publishEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.2 * fps),
    config: SPRING_BOUNCY,
  });
  const publishScale = interpolate(publishEntrance, [0, 1], [0, 1]);

  // Upvote counter
  const upvoteDelay = Math.round(2.8 * fps);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 20 : 16,
        padding: isVertical ? "40px 24px" : "30px 60px",
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
        Export Your Knowledge
      </span>

      {/* Terminal */}
      <TerminalBlock
        lines={[
          "clawville export --format skill.md",
          "  Exporting 6 knowledge entries...",
          "  topics: [blockchain, DeFi, tokens]",
          '  output: "my-avatar-skill.md"',
          "  Done! Published to marketplace.",
        ]}
        startFrame={terminalDelay}
        charsPerSecond={40}
        width={isVertical ? 400 : 500}
      />

      <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
        {/* Published badge */}
        <div
          style={{
            opacity: interpolate(publishEntrance, [0, 0.3], [0, 1], {
              extrapolateRight: "clamp",
            }),
            transform: `scale(${publishScale})`,
          }}
        >
          <div
            style={{
              background: "linear-gradient(135deg, #4CAF50, #2E7D32)",
              borderRadius: 24,
              padding: "8px 24px",
              boxShadow: "0 0 12px rgba(76,175,80,0.5)",
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 18,
                fontWeight: 700,
                color: COLORS.white,
              }}
            >
              Published!
            </span>
          </div>
        </div>

        {/* Upvote counter */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 22 }}>👍</span>
          <AnimatedCounter
            from={0}
            to={12}
            delay={upvoteDelay}
            style={{
              fontFamily: roboto,
              fontSize: 22,
              fontWeight: 700,
              color: COLORS.gold,
            }}
          />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 16,
              color: COLORS.white,
              opacity: 0.8,
            }}
          >
            upvotes
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-20s, frames 480-600)
const WalkthroughCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const pillEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.3 * fps),
    config: SPRING_SNAPPY,
  });

  const stats = [
    { label: "Knowledge", value: "6 skills", icon: "📖" },
    { label: "Tokens", value: "115 NT", icon: "💰" },
    { label: "Level", value: "2", icon: "⭐" },
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        flexDirection: "column",
      }}
    >
      {/* Stat summary pills */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: 12,
          alignItems: "center",
        }}
      >
        {stats.map((stat, i) => {
          const sPillEntrance = spring({
            frame,
            fps,
            delay: Math.round((0.3 + i * 0.2) * fps),
            config: SPRING_SNAPPY,
          });
          const sPillScale = interpolate(sPillEntrance, [0, 1], [0.5, 1]);
          const sPillOpacity = interpolate(sPillEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={stat.label}
              style={{
                opacity: sPillOpacity,
                transform: `scale(${sPillScale})`,
              }}
            >
              <div
                style={{
                  background: "rgba(255,255,255,0.1)",
                  border: "2px solid rgba(255,255,255,0.3)",
                  borderRadius: 20,
                  padding: "8px 20px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 20 }}>{stat.icon}</span>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 16,
                    fontWeight: 700,
                    color: COLORS.white,
                  }}
                >
                  {stat.label}: {stat.value}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <LogoReveal size={48} />
      <CTAButton text="Start Your Journey" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main composition
export const CompleteWalkthrough: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-world-exploration-npcs.mp4" startFrom={3} playbackRate={0.8} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={20} color={COLORS.gold} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Complete Walkthrough"
          subtitle="Everything from signup to skill master"
        />
      </Sequence>

      {/* Scene 2: Signup (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <SignupScene />
      </Sequence>

      {/* Scene 3: First Building (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <FirstBuilding />
      </Sequence>

      {/* Scene 4: Learn + Earn (8-12s) */}
      <Sequence from={8 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <LearnAndEarn />
      </Sequence>

      {/* Scene 5: Build Skill (12-16s) */}
      <Sequence from={12 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BuildSkill />
      </Sequence>

      {/* Scene 6: CTA (16-20s) */}
      <Sequence from={16 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <WalkthroughCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
