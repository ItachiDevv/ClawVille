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
import { NeoTokenIcon } from "../../shared/NeoTokenIcon";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
} from "../../../constants/timing";
import { DAILY_REWARD_DAYS } from "../../../constants/showcase";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Calendar - 7-day streak (1-4s, frames 30-120)
const CalendarScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

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
          fontSize: isVertical ? 28 : 34,
          color: "#FF9800",
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        7-Day Login Streak
      </span>

      {/* Calendar grid */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: isVertical ? 10 : 14,
          justifyContent: "center",
          maxWidth: isVertical ? 380 : 520,
        }}
      >
        {DAILY_REWARD_DAYS.map((day, i) => {
          const dayDelay = Math.round((0.3 + i * 0.25) * fps);
          const dayEntrance = spring({
            frame,
            fps,
            delay: dayDelay,
            config: SPRING_SNAPPY,
          });
          const dayScale = interpolate(dayEntrance, [0, 1], [0, 1]);
          const dayOpacity = interpolate(dayEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          // Checkmark appears slightly after the card
          const checkDelay = dayDelay + Math.round(0.3 * fps);
          const checkEntrance = spring({
            frame,
            fps,
            delay: checkDelay,
            config: SPRING_BOUNCY,
          });
          const checkScale = interpolate(checkEntrance, [0, 1], [0, 1]);

          const isDay7 = day.day === 7;

          return (
            <div
              key={day.day}
              style={{
                opacity: dayOpacity,
                transform: `scale(${dayScale})`,
              }}
            >
              <div
                style={{
                  background: isDay7
                    ? `linear-gradient(135deg, ${COLORS.gold}, #FFA000)`
                    : COLORS.panel,
                  border: `3px solid ${isDay7 ? "#B8860B" : COLORS.panelBorder}`,
                  borderRadius: 12,
                  padding: "10px 14px",
                  width: isVertical ? 56 : 64,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  position: "relative",
                  boxShadow: isDay7
                    ? "0 0 16px rgba(255,215,0,0.5)"
                    : "2px 2px 0px rgba(0,0,0,0.2)",
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 12,
                    fontWeight: 700,
                    color: isDay7 ? "#3E2723" : "#795548",
                  }}
                >
                  Day {day.day}
                </span>
                <span style={{ fontSize: 20 }}>{day.icon}</span>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#3E2723",
                  }}
                >
                  {day.reward}
                </span>

                {/* Checkmark overlay */}
                <div
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: "#4CAF50",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transform: `scale(${checkScale})`,
                    boxShadow: "1px 1px 3px rgba(0,0,0,0.3)",
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
                      color: COLORS.white,
                      fontWeight: 700,
                    }}
                  >
                    ✓
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Daily Reward Collection (4-8s, frames 120-240)
const RewardCollection: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const tokenEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.3 * fps),
    config: SPRING_BOUNCY,
  });
  const tokenScale = interpolate(tokenEntrance, [0, 1], [0, 1.2]);

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
          color: "#FF9800",
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Daily Reward Claimed!
      </span>

      <div
        style={{
          transform: `scale(${tokenScale})`,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <NeoTokenIcon size={isVertical ? 72 : 80} />
        <AnimatedCounter
          from={0}
          to={20}
          delay={Math.round(0.6 * fps)}
          prefix="+"
          suffix=" NT"
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 44 : 52,
            fontWeight: 700,
            color: COLORS.gold,
            textShadow: "2px 2px 6px rgba(0,0,0,0.4)",
          }}
        />
      </div>

      {/* Streak multiplier */}
      <NeopetsPanel width={isVertical ? 300 : 340}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            justifyContent: "center",
          }}
        >
          <span style={{ fontSize: 24 }}>🔥</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 18,
              fontWeight: 700,
              color: "#3E2723",
            }}
          >
            Day 3 Streak Active!
          </span>
        </div>
      </NeopetsPanel>
    </AbsoluteFill>
  );
};

// Scene 4: Day 7 Mega Reward (8-13s, frames 240-390)
const StreakBonus: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Glow burst
  const burstEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.5 * fps),
    config: SPRING_BOUNCY,
  });
  const burstScale = interpolate(burstEntrance, [0, 1], [0, 2.5]);
  const burstOpacity = interpolate(burstEntrance, [0, 0.5, 1], [0, 0.8, 0.2]);

  // Golden glow pulse
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowIntensity = 20 + Math.sin(glowPhase) * 15;

  const trophyEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.8 * fps),
    config: SPRING_BOUNCY,
  });
  const trophyScale = interpolate(trophyEntrance, [0, 1], [0, 1]);

  const counterDelay = Math.round(1.5 * fps);

  // Celebration particles
  const celebrationEntrance = spring({
    frame,
    fps,
    delay: Math.round(2 * fps),
    config: SPRING_SNAPPY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
        padding: 40,
      }}
    >
      {/* Golden burst */}
      <div
        style={{
          position: "absolute",
          width: 200,
          height: 200,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.gold}80, ${COLORS.gold}20, transparent)`,
          transform: `scale(${burstScale})`,
          opacity: burstOpacity,
        }}
      />

      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 32 : 38,
          color: COLORS.gold,
          textShadow: `2px 2px 0px rgba(0,0,0,0.3), 0 0 ${glowIntensity}px ${COLORS.gold}60`,
        }}
      >
        Day 7 Mega Reward!
      </span>

      <div
        style={{
          transform: `scale(${trophyScale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <span style={{ fontSize: 72 }}>🏆</span>
        <AnimatedCounter
          from={0}
          to={100}
          delay={counterDelay}
          prefix="+"
          suffix=" NT"
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 48 : 56,
            fontWeight: 700,
            color: COLORS.gold,
            textShadow: `2px 2px 6px rgba(0,0,0,0.4), 0 0 20px ${COLORS.gold}40`,
          }}
        />
      </div>

      {/* Celebration emojis */}
      <div
        style={{
          display: "flex",
          gap: 16,
          opacity: interpolate(celebrationEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        {["🎉", "✨", "🌟", "🎊", "💫"].map((emoji, i) => {
          const emojiEntrance = spring({
            frame,
            fps,
            delay: Math.round((2 + i * 0.15) * fps),
            config: SPRING_BOUNCY,
          });
          return (
            <span
              key={i}
              style={{
                fontSize: 32,
                transform: `scale(${interpolate(emojiEntrance, [0, 1], [0, 1])}) translateY(${Math.sin(((frame + i * 10) / fps) * 3) * 5}px)`,
              }}
            >
              {emoji}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (13-16s, frames 390-480)
const RewardsCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={48} />
      <CTAButton text="Claim Your Rewards" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main composition
export const DailyRewards: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="daily-rewards.mp4" startFrom={0} tintOpacity={0.5} />
      <LiveBadge />
      <ParticleField count={15} color="#FF9800" speed={0.6} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Daily Rewards & Streaks"
          subtitle="Login daily for growing rewards"
          accentColor="#FF9800"
        />
      </Sequence>

      {/* Scene 2: Calendar (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CalendarScene />
      </Sequence>

      {/* Scene 3: Rewards (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <RewardCollection />
      </Sequence>

      {/* Scene 4: Streak Bonus (8-13s) */}
      <Sequence from={8 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <StreakBonus />
      </Sequence>

      {/* Scene 5: CTA (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <RewardsCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
