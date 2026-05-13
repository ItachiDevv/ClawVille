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
import { TitleScreen } from "../../shared/TitleScreen";
import { RecordingBackground, LiveBadge } from "../../../shared/RecordingBackground";
import { ParticleField } from "../../../shared/ParticleField";
import { AvatarSprite } from "../../../shared/AvatarSprite";
import { SpeechBubble } from "../../../shared/SpeechBubble";
import { BookIcon } from "../../../shared/BookIcon";
import { ClawPanel } from "../../../shared/ClawPanel";
import { CTAButton } from "../../../shared/CTAButton";
import { AnimatedCounter } from "../../../shared/AnimatedCounter";
import { TypewriterText } from "../../../shared/TypewriterText";
import { LogoReveal } from "../../../shared/LogoReveal";
import { COLORS } from "../../../../constants/colors";
import { BUILDING_THEMES } from "../../../../constants/buildings";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Building Grid (1-5s, frames 30-150)
const BuildingGridScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const buildings = BUILDING_THEMES.slice(0, 4);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 16 : 20,
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          opacity: interpolate(
            spring({ frame, fps, config: SPRING_SNAPPY }),
            [0, 1],
            [0, 1]
          ),
        }}
      >
        15 Buildings to Explore
      </span>

      {/* 2x2 building grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isVertical ? "1fr 1fr" : "repeat(4, 1fr)",
          gap: isVertical ? 14 : 18,
          padding: isVertical ? "0 20px" : "0 40px",
        }}
      >
        {buildings.map((b, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 8 + 6,
            config: SPRING_BOUNCY,
          });

          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const slideY = interpolate(entrance, [0, 1], [40, 0]);

          return (
            <div
              key={b.name}
              style={{
                transform: `scale(${scale}) translateY(${slideY}px)`,
              }}
            >
              <ClawPanel
                width={isVertical ? 160 : 170}
                style={{ padding: "12px 14px" }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span style={{ fontSize: 32 }}>{b.icon}</span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
                      fontWeight: 700,
                      color: "#3E2723",
                      textAlign: "center",
                    }}
                  >
                    {b.name}
                  </span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 11,
                      color: "#795548",
                      textAlign: "center",
                    }}
                  >
                    {b.focus}
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

// Scene 3: Enter Building (5-9s, frames 150-270)
const EnterBuildingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Zoom into building
  const zoomIn = spring({
    frame,
    fps,
    config: SPRING_SMOOTH,
    durationInFrames: fps,
  });

  const buildingScale = interpolate(zoomIn, [0, 1], [0.6, 1]);

  // NPC pops in
  const npcDelay = Math.round(fps * 0.8);
  const npcEntrance = spring({
    frame,
    fps,
    delay: npcDelay,
    config: SPRING_BOUNCY,
  });

  const npcScale = interpolate(npcEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: "linear-gradient(180deg, #0d1b2a 0%, #1b2838 100%)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: isVertical ? 20 : 24,
          transform: `scale(${buildingScale})`,
        }}
      >
        {/* Building header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 40 }}>📚</span>
          <span
            style={{
              fontFamily: lobster,
              fontSize: isVertical ? 28 : 34,
              color: COLORS.panel,
              textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
            }}
          >
            Web3 Library
          </span>
        </div>

        {/* NPC with speech */}
        <div
          style={{
            display: "flex",
            flexDirection: isVertical ? "column" : "row",
            alignItems: "center",
            gap: isVertical ? 16 : 24,
            transform: `scale(${npcScale})`,
          }}
        >
          <AvatarSprite species="owl" size={isVertical ? 90 : 100} enterDelay={npcDelay} bob />
          <SpeechBubble
            text="Blockchains are distributed ledgers that enable trustless transactions..."
            delay={npcDelay + 8}
            maxWidth={isVertical ? 240 : 280}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Learn (9-13s, frames 270-390)
const LearnScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });

  const titleOpacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Book floats from bottom
  const bookEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 0.5),
    config: SPRING_BOUNCY,
  });

  const bookY = interpolate(bookEntrance, [0, 1], [80, 0]);
  const bookScale = interpolate(bookEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 24 : 20,
        flexDirection: "column",
      }}
    >
      {/* Knowledge text */}
      <div
        style={{
          opacity: titleOpacity,
          maxWidth: isVertical ? 340 : 480,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 26 : 30,
            color: COLORS.blue,
            textShadow: `0 0 12px ${COLORS.blue}40`,
          }}
        >
          Skill Acquired
        </span>
      </div>

      {/* Typewriter knowledge text */}
      <ClawPanel width={isVertical ? 340 : 460}>
        <TypewriterText
          text="Solana uses Proof of History (PoH) to achieve 400ms block times, enabling high-speed DeFi trading..."
          charsPerSecond={35}
          style={{
            fontFamily: roboto,
            fontSize: 16,
            color: "#3E2723",
            lineHeight: 1.5,
          }}
        />
      </ClawPanel>

      {/* Floating book */}
      <div
        style={{
          transform: `translateY(${bookY}px) scale(${bookScale})`,
        }}
      >
        <BookIcon icon="📚" name="Blockchain Fundamentals" price={15} size={70} />
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Knowledge Count (13-16s, frames 390-480)
const KnowledgeCountScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const labelEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  const labelOpacity = interpolate(labelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Glow effect on counter
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowSize = 20 + Math.sin(glowPhase) * 10;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 16 : 12,
        flexDirection: "column",
      }}
    >
      {/* Big animated counter */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          textShadow: `0 0 ${glowSize}px ${COLORS.gold}60`,
        }}
      >
        <AnimatedCounter
          from={0}
          to={15}
          delay={4}
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 80 : 100,
            color: COLORS.gold,
            textShadow: `2px 2px 0px rgba(0,0,0,0.4), 0 0 ${glowSize}px ${COLORS.gold}60`,
          }}
        />
      </div>

      {/* Label */}
      <span
        style={{
          fontFamily: roboto,
          fontSize: isVertical ? 24 : 28,
          fontWeight: 700,
          color: COLORS.panel,
          opacity: labelOpacity,
          textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
        }}
      >
        Skills Discovered
      </span>

      {/* Skill icons row */}
      <div
        style={{
          display: "flex",
          gap: 8,
          opacity: labelOpacity,
          marginTop: 8,
        }}
      >
        {["🧪", "📊", "🐋", "🎨", "💻"].map((emoji, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 5 + 15,
            config: SPRING_BOUNCY,
          });

          return (
            <div
              key={i}
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: `${COLORS.panel}30`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
                transform: `scale(${interpolate(entrance, [0, 1], [0, 1])})`,
              }}
            >
              {emoji}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 24 }}
    >
      <LogoReveal size={56} />
      <CTAButton text="Start Discovering" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S05 composition (18s)
export const KnowledgeDiscovery: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-building-chat-learn.mp4" startFrom={1} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={22} color={COLORS.blue} speed={0.7} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Knowledge Discovery"
          subtitle="Every building teaches something new"
          accentColor={COLORS.blue}
        />
      </Sequence>

      {/* Scene 2: Building Grid (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BuildingGridScene />
      </Sequence>

      {/* Scene 3: Enter Building (5-9s) */}
      <Sequence from={5 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <EnterBuildingScene />
      </Sequence>

      {/* Scene 4: Learn (9-13s) */}
      <Sequence from={9 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <LearnScene />
      </Sequence>

      {/* Scene 5: Knowledge Count (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <KnowledgeCountScene />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
