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
import { MapBackground } from "../shared/MapBackground";
import { ParticleField } from "../shared/ParticleField";
import { PetSprite } from "../shared/PetSprite";
import { BookIcon } from "../shared/BookIcon";
import { ClawPanel } from "../shared/ClawPanel";
import { CTAButton } from "../shared/CTAButton";
import { LogoReveal } from "../shared/LogoReveal";
import { PARADE_BOOKS } from "../../constants/books";
import { COLORS } from "../../constants/colors";
import { SPRING_BOUNCY, SPRING_SNAPPY, SPRING_SMOOTH, FPS } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Book Shop Exterior (0-2s, frames 0-60)
const BookShopExterior: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const titleEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const scale = interpolate(titleEntrance, [0, 1], [0.3, 1]);
  const opacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Book shop visual
  const shopEntrance = spring({
    frame,
    fps,
    delay: 10,
    config: SPRING_SMOOTH,
  });
  const shopY = interpolate(shopEntrance, [0, 1], [50, 0]);

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 30 }}
    >
      {/* Shop building representation */}
      <div
        style={{
          opacity: interpolate(shopEntrance, [0, 1], [0, 1]),
          transform: `translateY(${shopY}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            width: 200,
            height: 160,
            background: `linear-gradient(180deg, ${COLORS.primary}, ${COLORS.bgLight})`,
            borderRadius: "12px 12px 0 0",
            border: `4px solid ${COLORS.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 64,
            position: "relative",
          }}
        >
          {"\u{1F4DA}"}
          {/* Door */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              width: 50,
              height: 70,
              background: COLORS.bgGradient2,
              borderRadius: "8px 8px 0 0",
              border: `2px solid ${COLORS.border}`,
            }}
          />
        </div>
      </div>

      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 48,
            color: COLORS.accent,
            textShadow: "3px 3px 0px rgba(0,0,0,0.3)",
          }}
        >
          Web3 Library
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Book Parade (2-8s, frames 60-240)
const BookParade: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 32,
          color: COLORS.accent,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          position: "absolute",
          top: isVertical ? 120 : 60,
        }}
      >
        Knowledge Awaits
      </span>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: isVertical ? 24 : 32,
          maxWidth: isVertical ? 500 : 800,
          padding: 40,
        }}
      >
        {PARADE_BOOKS.map((book, i) => (
          <BookIcon
            key={book.id}
            icon={book.icon}
            name={book.name}
            price={book.price}
            size={isVertical ? 70 : 80}
            delay={i * 12}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Knowledge Absorption (8-13.3s, frames 240-400)
const KnowledgeAbsorption: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const totalOrbs = 12;
  const lobsterX = width / 2;
  const lobsterY = height / 2 + 20;
  const orbitRadius = isVertical ? 140 : 160;

  // Counter animation
  const counterTarget = 48;
  const counterProgress = interpolate(frame, [fps * 2, fps * 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const counterValue = Math.round(counterProgress * counterTarget);

  return (
    <AbsoluteFill>
      {/* Lobster at center */}
      <div
        style={{
          position: "absolute",
          left: lobsterX - 70,
          top: lobsterY - 70,
        }}
      >
        <PetSprite species="fox" size={140} enterDelay={0} bob />
      </div>

      {/* Knowledge orbs orbiting then absorbing */}
      {Array.from({ length: totalOrbs }).map((_, i) => {
        const orbitAngle =
          (i / totalOrbs) * Math.PI * 2 + (frame / fps) * 1.5;
        const absorbProgress = interpolate(
          frame,
          [fps * 2 + i * 5, fps * 3.5 + i * 5],
          [0, 1],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }
        );

        const currentRadius = orbitRadius * (1 - absorbProgress);
        const orbX = lobsterX + Math.cos(orbitAngle) * currentRadius - 8;
        const orbY = lobsterY + Math.sin(orbitAngle) * currentRadius * 0.6 - 8;

        const orbOpacity = absorbProgress > 0.9 ? 1 - (absorbProgress - 0.9) * 10 : 1;
        const orbScale = absorbProgress > 0.8 ? 1 - (absorbProgress - 0.8) * 5 : 1;

        // Orb colors cycle through ocean-crypto colors
        const colors = [
          COLORS.accent,
          COLORS.secondary,
          "#FF4081",
          COLORS.success,
          COLORS.warning,
          "#7C4DFF",
        ];
        const orbColor = colors[i % colors.length];

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: orbX,
              top: orbY,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${orbColor}, ${orbColor}80)`,
              opacity: orbOpacity,
              transform: `scale(${orbScale})`,
              boxShadow: `0 0 12px ${orbColor}80`,
            }}
          />
        );
      })}

      {/* Knowledge counter */}
      <div
        style={{
          position: "absolute",
          left: lobsterX - 50,
          top: lobsterY + 90,
          width: 100,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 28,
            fontWeight: 700,
            color: COLORS.accent,
            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
          }}
        >
          {counterValue}/48
        </span>
        <br />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 14,
            color: COLORS.panel,
          }}
        >
          Knowledge
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Topic Cards (13.3-17.3s, frames 400-520)
const TopicCards: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const topics = [
    { name: "DeFi", icon: "\u{1F3E6}", desc: "Yield farming, AMMs, liquidity" },
    { name: "Solana", icon: "\u{2600}\u{FE0F}", desc: "SPL tokens, Jupiter, speed" },
    { name: "NFTs", icon: "\u{1F5BC}\u{FE0F}", desc: "Art, culture, Metaplex" },
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
      <span
        style={{
          fontFamily: lobster,
          fontSize: 36,
          color: COLORS.accent,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          marginBottom: 16,
        }}
      >
        Master Every Topic
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 16 : 24,
          alignItems: "center",
        }}
      >
        {topics.map((topic, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 10,
            config: SPRING_SNAPPY,
          });
          const slideX = interpolate(entrance, [0, 1], [200, 0]);
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={topic.name}
              style={{
                transform: `translateX(${slideX}px)`,
                opacity,
              }}
            >
              <ClawPanel width={isVertical ? 320 : 220}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 40 }}>{topic.icon}</span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 22,
                      fontWeight: 700,
                      color: COLORS.primary,
                    }}
                  >
                    {topic.name}
                  </span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      color: COLORS.bgGradient2,
                      textAlign: "center",
                    }}
                  >
                    {topic.desc}
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

// Scene 5: CTA (17.3-20s, frames 520-600)
const LearnCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 24 }}
    >
      <LogoReveal size={48} />
      <CTAButton
        text="Teach Your Lobster"
        subtitle="Learn Together."
      />
    </AbsoluteFill>
  );
};

// Main Video 2 composition
export const LobsterLearnsCrypto: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <MapBackground zoom={1.5} tintColor="#0A1628" tintOpacity={0.35} panX={-0.1} panYRange={[0, 0.05]} />
      <ParticleField count={15} color={COLORS.accent} speed={0.4} />

      <Sequence durationInFrames={2 * fps} premountFor={fps}>
        <BookShopExterior />
      </Sequence>

      <Sequence from={2 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <BookParade />
      </Sequence>

      <Sequence
        from={8 * fps}
        durationInFrames={Math.round(5.3 * fps)}
        premountFor={fps}
      >
        <KnowledgeAbsorption />
      </Sequence>

      <Sequence
        from={Math.round(13.3 * fps)}
        durationInFrames={4 * fps}
        premountFor={fps}
      >
        <TopicCards />
      </Sequence>

      <Sequence
        from={Math.round(17.3 * fps)}
        durationInFrames={Math.round(2.7 * fps)}
        premountFor={fps}
      >
        <LearnCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
