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
import { StatBar } from "../../shared/StatBar";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
import { ClawTokenIcon } from "../../shared/ClawTokenIcon";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../../constants/timing";
import { QUEST_TYPES } from "../../../constants/showcase";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Quest List (1-5s, frames 30-150)
const QuestList: React.FC = () => {
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
          fontSize: isVertical ? 28 : 34,
          color: COLORS.green,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Active Quests
      </span>

      {QUEST_TYPES.map((quest, i) => {
        const questEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.2 + i * 0.3) * fps),
          config: SPRING_SNAPPY,
        });
        const questSlideX = interpolate(
          questEntrance,
          [0, 1],
          [i % 2 === 0 ? -300 : 300, 0]
        );
        const questOpacity = interpolate(questEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={quest.label}
            style={{
              transform: `translateX(${questSlideX}px)`,
              opacity: questOpacity,
            }}
          >
            <ClawPanel width={isVertical ? 360 : 440}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 28 }}>{quest.icon}</span>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 16,
                        fontWeight: 700,
                        color: "#3E2723",
                      }}
                    >
                      {quest.label}
                    </span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#2E7D32",
                      }}
                    >
                      {quest.reward}
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div
                    style={{
                      width: "100%",
                      height: 8,
                      background: "rgba(0,0,0,0.1)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${quest.progress * 100}%`,
                        height: "100%",
                        background: `linear-gradient(90deg, ${COLORS.green}, ${COLORS.star})`,
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </div>
              </div>
            </ClawPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: Quest Progress (5-10s, frames 150-300)
const QuestProgress: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Animating the "Visit All Buildings" quest from 80% to 100%
  const quest = QUEST_TYPES[2]; // Visit All Buildings

  const fillProgress = spring({
    frame,
    fps,
    delay: Math.round(0.5 * fps),
    config: SPRING_SMOOTH,
    durationInFrames: Math.round(2.5 * fps),
  });
  const fillWidth = interpolate(fillProgress, [0, 1], [0.8, 1]);

  // Checkmarks appearing
  const buildings = ["📚", "🧪", "🎨", "💻", "🏪", "🐾", "🌳", "🌈"];
  const lastCheckDelay = Math.round(2 * fps);
  const checkEntrance = spring({
    frame,
    fps,
    delay: lastCheckDelay,
    config: SPRING_BOUNCY,
  });

  // Complete flash
  const completeEntrance = spring({
    frame,
    fps,
    delay: Math.round(3.5 * fps),
    config: SPRING_BOUNCY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 20 : 24,
        padding: 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 26 : 30,
          color: COLORS.green,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        {quest.icon} {quest.label}
      </span>

      {/* Progress bar */}
      <div
        style={{
          width: isVertical ? 340 : 420,
        }}
      >
        <StatBar
          label="Progress"
          value={fillWidth}
          color={COLORS.green}
          width={isVertical ? 240 : 320}
          height={24}
          delay={0}
        />
      </div>

      {/* Building checkmarks */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          justifyContent: "center",
          maxWidth: isVertical ? 340 : 440,
        }}
      >
        {buildings.map((icon, i) => {
          const isLast = i === buildings.length - 1;
          const iconDelay = isLast
            ? lastCheckDelay
            : Math.round((0.3 + i * 0.2) * fps);
          const iconEntrance = spring({
            frame,
            fps,
            delay: iconDelay,
            config: SPRING_SNAPPY,
          });

          return (
            <div
              key={i}
              style={{
                opacity: interpolate(iconEntrance, [0, 0.5], [0, 1], {
                  extrapolateRight: "clamp",
                }),
                transform: `scale(${interpolate(iconEntrance, [0, 1], [0.5, 1])})`,
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: "rgba(76,175,80,0.2)",
                  border: "2px solid rgba(76,175,80,0.5)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "relative",
                }}
              >
                <span style={{ fontSize: 24 }}>{icon}</span>
                <div
                  style={{
                    position: "absolute",
                    bottom: -4,
                    right: -4,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#4CAF50",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ fontSize: 12, color: COLORS.white }}>✓</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Almost there / Complete text */}
      <div
        style={{
          opacity: interpolate(completeEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `scale(${interpolate(completeEntrance, [0, 1], [0.5, 1])})`,
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.green}, ${COLORS.greenDark})`,
            borderRadius: 20,
            padding: "8px 24px",
            boxShadow: `0 0 16px rgba(76,175,80,0.5)`,
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
            15/15 Buildings Visited!
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Quest Complete (10-14s, frames 300-420)
const QuestComplete: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Banner entrance
  const bannerEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.3 * fps),
    config: SPRING_BOUNCY,
  });
  const bannerScale = interpolate(bannerEntrance, [0, 1], [0, 1]);

  // Glow burst
  const burstScale = interpolate(bannerEntrance, [0, 1], [0, 3]);
  const burstOpacity = interpolate(bannerEntrance, [0, 0.5, 1], [0, 0.6, 0]);

  // Golden pulse
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowSize = 15 + Math.sin(glowPhase) * 10;

  const rewardDelay = Math.round(1.2 * fps);

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
      {/* Glow burst */}
      <div
        style={{
          position: "absolute",
          width: 150,
          height: 150,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.green}60, transparent)`,
          transform: `scale(${burstScale})`,
          opacity: burstOpacity,
        }}
      />

      {/* Banner */}
      <div
        style={{
          transform: `scale(${bannerScale})`,
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.gold}, #FFA000)`,
            borderRadius: 20,
            padding: "16px 40px",
            boxShadow: `0 0 ${glowSize}px rgba(255,215,0,0.6), 4px 4px 0px rgba(0,0,0,0.3)`,
            border: `3px solid ${COLORS.panelBorder}`,
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: isVertical ? 32 : 40,
              color: "#3E2723",
            }}
          >
            Quest Complete!
          </span>
        </div>
      </div>

      {/* Reward */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 28 }}>🏘️</span>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 20,
            color: COLORS.white,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Visit All Buildings
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <ClawTokenIcon size={40} />
        <AnimatedCounter
          from={0}
          to={75}
          delay={rewardDelay}
          prefix="+"
          suffix=" NT"
          style={{
            fontFamily: roboto,
            fontSize: 40,
            fontWeight: 700,
            color: COLORS.gold,
            textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
          }}
        />
      </div>

      {/* XP bonus */}
      <div
        style={{
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
        <div
          style={{
            background: "rgba(255,255,255,0.1)",
            border: "2px solid rgba(255,255,255,0.3)",
            borderRadius: 16,
            padding: "8px 20px",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 16,
              fontWeight: 700,
              color: COLORS.star,
            }}
          >
            +250 XP Bonus
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (14-17s, frames 420-510)
const QuestCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={48} />
      <CTAButton text="Start Questing" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main composition
export const QuestSystem: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-menu-skills-inventory.mp4" startFrom={2} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color={COLORS.green} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Quest System"
          subtitle="Complete quests, earn rewards"
          accentColor={COLORS.green}
        />
      </Sequence>

      {/* Scene 2: Quest List (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <QuestList />
      </Sequence>

      {/* Scene 3: Quest Progress (5-10s) */}
      <Sequence from={5 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <QuestProgress />
      </Sequence>

      {/* Scene 4: Quest Complete (10-14s) */}
      <Sequence from={10 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <QuestComplete />
      </Sequence>

      {/* Scene 5: CTA (14-17s) */}
      <Sequence from={14 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <QuestCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
