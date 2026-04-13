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
import { NeopetsPanel } from "../../shared/NeopetsPanel";
import { ClawTokenIcon } from "../../shared/ClawTokenIcon";
import { BookIcon } from "../../shared/BookIcon";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../../constants/timing";
import { EARN_METHODS } from "../../../constants/buildings";
import { KNOWLEDGE_BOOKS } from "../../../constants/books";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Token Intro (1-4s, frames 30-120)
const TokenIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const coinEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const coinScale = interpolate(coinEntrance, [0, 1], [0, 1]);

  // Glow pulse
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowSize = 30 + Math.sin(glowPhase) * 20;

  const labelEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.8 * fps),
    config: SPRING_SNAPPY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 24,
        padding: 40,
      }}
    >
      {/* Glow behind coin */}
      <div
        style={{
          position: "absolute",
          width: 200,
          height: 200,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.gold}50, transparent)`,
          boxShadow: `0 0 ${glowSize}px ${COLORS.gold}40`,
          opacity: interpolate(coinEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      />

      <div style={{ transform: `scale(${coinScale})` }}>
        <ClawTokenIcon size={isVertical ? 120 : 140} />
      </div>

      <div
        style={{
          opacity: interpolate(labelEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `translateY(${interpolate(labelEntrance, [0, 1], [20, 0])}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 36 : 44,
            color: COLORS.gold,
            textShadow: `2px 2px 0px rgba(0,0,0,0.3), 0 0 20px ${COLORS.gold}30`,
          }}
        >
          ClawTokens
        </span>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            color: COLORS.white,
            opacity: 0.8,
          }}
        >
          The currency of ClawVille
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Earn Methods (4-8s, frames 120-240)
const EarnMethods: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 14 : 16,
        padding: isVertical ? "40px 24px" : 40,
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
        4 Ways to Earn
      </span>

      {EARN_METHODS.map((method, i) => {
        const methodEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.2 + i * 0.3) * fps),
          config: SPRING_SNAPPY,
        });
        const methodSlideX = interpolate(
          methodEntrance,
          [0, 1],
          [i % 2 === 0 ? -300 : 300, 0]
        );
        const methodOpacity = interpolate(methodEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={method.label}
            style={{
              transform: `translateX(${methodSlideX}px)`,
              opacity: methodOpacity,
            }}
          >
            <NeopetsPanel width={isVertical ? 360 : 440}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 28 }}>{method.icon}</span>
                <div style={{ flex: 1 }}>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {method.label}
                  </span>
                </div>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#2E7D32",
                  }}
                >
                  {method.reward}
                </span>
              </div>
            </NeopetsPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: Spend - Shop Items (8-12s, frames 240-360)
const SpendScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  const booksToShow = KNOWLEDGE_BOOKS.slice(0, 4);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
        padding: 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 32,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          opacity: interpolate(titleEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        Spend on Knowledge
      </span>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: isVertical ? 16 : 20,
          justifyContent: "center",
          maxWidth: isVertical ? 380 : 520,
        }}
      >
        {booksToShow.map((book, i) => (
          <BookIcon
            key={book.id}
            icon={book.icon}
            name={book.name}
            price={book.price}
            size={isVertical ? 65 : 72}
            delay={Math.round((0.3 + i * 0.3) * fps)}
          />
        ))}
      </div>

      {/* Balance indicator */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          opacity: interpolate(
            spring({
              frame,
              fps,
              delay: Math.round(2 * fps),
              config: SPRING_SNAPPY,
            }),
            [0, 0.5],
            [0, 1],
            { extrapolateRight: "clamp" }
          ),
        }}
      >
        <ClawTokenIcon size={28} />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            fontWeight: 700,
            color: COLORS.gold,
          }}
        >
          Balance: 215 NT
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Economy Flow (12-16s, frames 360-480)
const EconomyFlow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const steps = [
    { emoji: "💬", label: "Earn" },
    { emoji: "📖", label: "Learn" },
    { emoji: "📤", label: "Publish" },
    { emoji: "💰", label: "Earn More" },
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 24,
        padding: 40,
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
        The ClawToken Cycle
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          alignItems: "center",
          gap: 0,
        }}
      >
        {steps.map((step, i) => {
          const stepEntrance = spring({
            frame,
            fps,
            delay: Math.round((0.3 + i * 0.4) * fps),
            config: SPRING_SNAPPY,
          });
          const stepScale = interpolate(stepEntrance, [0, 1], [0, 1]);
          const stepOpacity = interpolate(stepEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <React.Fragment key={step.label}>
              {i > 0 && (
                <div
                  style={{
                    opacity: stepOpacity,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: isVertical ? "4px 0" : "0 4px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 24,
                      color: COLORS.gold,
                      transform: isVertical
                        ? "rotate(90deg)"
                        : "none",
                    }}
                  >
                    →
                  </span>
                </div>
              )}
              <div
                style={{
                  opacity: stepOpacity,
                  transform: `scale(${stepScale})`,
                }}
              >
                <div
                  style={{
                    width: isVertical ? 100 : 90,
                    height: isVertical ? 100 : 90,
                    borderRadius: "50%",
                    background: `linear-gradient(135deg, ${COLORS.gold}30, ${COLORS.gold}10)`,
                    border: `3px solid ${COLORS.gold}60`,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                  }}
                >
                  <span style={{ fontSize: 28 }}>{step.emoji}</span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      fontWeight: 700,
                      color: COLORS.gold,
                    }}
                  >
                    {step.label}
                  </span>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Circular arrow connecting last to first */}
      <div
        style={{
          opacity: interpolate(
            spring({
              frame,
              fps,
              delay: Math.round(2.5 * fps),
              config: SPRING_SNAPPY,
            }),
            [0, 0.5],
            [0, 1],
            { extrapolateRight: "clamp" }
          ),
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 16,
            color: COLORS.white,
            opacity: 0.8,
            fontStyle: "italic",
          }}
        >
          Knowledge creates value — forever
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const EconomyCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={48} />
      <CTAButton text="Start Earning" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main composition
export const ClawtokenEconomy: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="shop-books.mp4" startFrom={0} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={20} color={COLORS.gold} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="The ClawToken Economy"
          subtitle="Earn, spend, trade"
        />
      </Sequence>

      {/* Scene 2: Token Intro (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <TokenIntro />
      </Sequence>

      {/* Scene 3: Earn Methods (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <EarnMethods />
      </Sequence>

      {/* Scene 4: Spend (8-12s) */}
      <Sequence from={8 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <SpendScene />
      </Sequence>

      {/* Scene 5: Economy Flow (12-16s) */}
      <Sequence from={12 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <EconomyFlow />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <EconomyCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
