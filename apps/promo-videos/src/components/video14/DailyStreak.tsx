import React, { useMemo } from "react";
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
import { ParticleField } from "../shared/ParticleField";
import { NeopetsPanel } from "../shared/NeopetsPanel";
import { ClawTokenIcon } from "../shared/ClawTokenIcon";
import { PetSprite } from "../shared/PetSprite";
import { StatBar } from "../shared/StatBar";
import { AnimatedCounter } from "../shared/AnimatedCounter";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import {
  FPS,
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Seeded random for particle positions
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Scene 1: Calendar Hook (0-3s, frames 0-90)
const CalendarHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const COLS = 7;
  const ROWS = 4;
  const TOTAL = COLS * ROWS;
  const squareSize = 36;
  const gap = 8;
  const gridWidth = COLS * (squareSize + gap) - gap;
  const gridHeight = ROWS * (squareSize + gap) - gap;
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
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: COLORS.bg,
      }}
    >
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: startY - 70,
          width: "100%",
          textAlign: "center",
          transform: `scale(${titleScale})`,
          opacity: titleOpacity,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 40,
            color: COLORS.clawToken,
            textShadow: `
              2px 2px 0px rgba(0,0,0,0.3),
              0 0 20px rgba(255,215,0,0.4)
            `,
          }}
        >
          Never Miss a Day
        </span>
      </div>

      {/* Calendar grid */}
      {Array.from({ length: TOTAL }, (_, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x = startX + col * (squareSize + gap);
        const y = startY + row * (squareSize + gap);

        // Each square lights up with staggered delay of 2 frames
        const squareEntrance = spring({
          frame,
          fps,
          delay: 10 + i * 2,
          config: SPRING_BOUNCY,
        });
        const squareScale = interpolate(squareEntrance, [0, 1], [0, 1]);
        const isLit = squareEntrance > 0.01;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: squareSize,
              height: squareSize,
              borderRadius: 6,
              backgroundColor: isLit ? COLORS.clawToken : "rgba(255,255,255,0.08)",
              border: `2px solid ${isLit ? COLORS.border : "rgba(255,255,255,0.15)"}`,
              transform: `scale(${isLit ? squareScale : 1})`,
              boxShadow: isLit
                ? `0 0 8px rgba(255,215,0,0.4)`
                : "none",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 2: Streak Rewards (3-9s, frames 90-270)
const StreakRewards: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const milestones = [
    { day: "Day 1", reward: "+15 ClawTokens", iconSize: 28 },
    { day: "Day 7", reward: "+50 Bonus ClawTokens", iconSize: 36 },
    { day: "Day 14", reward: "+100 Bonus", iconSize: 44 },
    { day: "Day 30", reward: "+250 Mega Bonus!", iconSize: 56 },
  ];

  // Gold particle burst around Day 30 panel
  const day30Entrance = spring({
    frame,
    fps,
    delay: 3 * Math.round(0.5 * fps),
    config: SPRING_SNAPPY,
  });

  const burstParticles = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => ({
        angle: (i / 12) * Math.PI * 2,
        speed: 40 + seededRandom(i * 7) * 60,
        size: 3 + seededRandom(i * 11) * 4,
      })),
    []
  );

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 16,
        flexDirection: "column",
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 34,
          color: COLORS.clawToken,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          marginBottom: 12,
        }}
      >
        Streak Rewards
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: isVertical ? 16 : 12,
          alignItems: "center",
          position: "relative",
        }}
      >
        {milestones.map((milestone, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * Math.round(0.5 * fps),
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

          const isDay30 = i === 3;
          const glowIntensity = isDay30
            ? 10 + Math.sin(((frame - 3 * 0.5 * fps) / fps) * 4) * 8
            : 0;

          return (
            <div
              key={milestone.day}
              style={{
                transform: `translateX(${slideX}px)`,
                opacity,
                position: "relative",
              }}
            >
              <NeopetsPanel
                width={isVertical ? 380 : 440}
                style={
                  isDay30
                    ? {
                        boxShadow: `0 0 ${glowIntensity}px rgba(255,215,0,0.6), 4px 4px 0px rgba(0,0,0,0.3)`,
                      }
                    : undefined
                }
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                  }}
                >
                  <ClawTokenIcon size={milestone.iconSize} />
                  <div style={{ flex: 1 }}>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 18,
                        fontWeight: 700,
                        color: "#3E2723",
                      }}
                    >
                      {milestone.day}:
                    </span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 18,
                        fontWeight: 400,
                        color: "#5D4037",
                        marginLeft: 8,
                      }}
                    >
                      {milestone.reward}
                    </span>
                  </div>
                </div>
              </NeopetsPanel>

              {/* Gold particle burst for Day 30 */}
              {isDay30 &&
                burstParticles.map((p, pi) => {
                  const burstProgress = interpolate(
                    day30Entrance,
                    [0.5, 1],
                    [0, 1],
                    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                  );
                  const bx = Math.cos(p.angle) * p.speed * burstProgress;
                  const by = Math.sin(p.angle) * p.speed * burstProgress;
                  const bOpacity = interpolate(
                    burstProgress,
                    [0, 0.3, 1],
                    [0, 1, 0],
                    { extrapolateRight: "clamp" }
                  );

                  return (
                    <div
                      key={pi}
                      style={{
                        position: "absolute",
                        left: `calc(50% + ${bx}px)`,
                        top: `calc(50% + ${by}px)`,
                        width: p.size,
                        height: p.size,
                        borderRadius: "50%",
                        backgroundColor: COLORS.clawToken,
                        opacity: bOpacity,
                        boxShadow: `0 0 ${p.size * 2}px ${COLORS.clawToken}`,
                        pointerEvents: "none",
                      }}
                    />
                  );
                })}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Level Progression (9-13s, frames 270-390)
const LevelProgression: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Level badge number interpolation
  const levelProgress = spring({
    frame,
    fps,
    delay: Math.round(0.5 * fps),
    config: SPRING_SMOOTH,
    durationInFrames: Math.round(2 * fps),
  });
  const levelNumber = Math.round(
    interpolate(levelProgress, [0, 1], [1, 10])
  );

  // Badge entrance
  const badgeEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);

  // Text entrance
  const textEntrance = spring({
    frame,
    fps,
    delay: Math.round(1.5 * fps),
    config: SPRING_SMOOTH,
  });
  const textOpacity = interpolate(textEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 16,
        flexDirection: "column",
      }}
    >
      {/* Lobster sprite */}
      <PetSprite species="dragon" size={100} enterDelay={0} bob />

      {/* Level badge */}
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: `radial-gradient(circle at 35% 35%, #FFE566, ${COLORS.clawToken}, #B8860B)`,
          border: `3px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${badgeScale})`,
          boxShadow: `0 0 12px rgba(255,215,0,0.5)`,
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
          Lv {levelNumber}
        </span>
      </div>

      {/* Stat bars */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          marginTop: 8,
        }}
      >
        <StatBar
          label="Knowledge"
          value={0.8}
          color={COLORS.primary}
          delay={0}
          width={220}
        />
        <StatBar
          label="Tokens"
          value={0.6}
          color={COLORS.clawToken}
          delay={Math.round(0.3 * fps)}
          width={220}
        />
        <StatBar
          label="Explored"
          value={1.0}
          color={COLORS.success}
          delay={Math.round(0.6 * fps)}
          width={220}
        />
      </div>

      {/* Description text */}
      <span
        style={{
          fontFamily: roboto,
          fontSize: 20,
          color: "#FFFFFF",
          textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          opacity: textOpacity,
          marginTop: 12,
          textAlign: "center",
        }}
      >
        Level up by learning and exploring
      </span>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (13-16s, frames 390-480)
const StreakCTA: React.FC = () => {
  const { fps } = useVideoConfig();

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
          color: COLORS.clawToken,
          textShadow: `
            2px 2px 0px rgba(0,0,0,0.3),
            0 0 20px rgba(255,215,0,0.4)
          `,
        }}
      >
        Start your streak today
      </span>

      <AnimatedCounter
        from={0}
        to={30}
        suffix=" Day Challenge"
        delay={10}
        style={{
          fontFamily: roboto,
          fontSize: 32,
          fontWeight: 700,
          color: "#FFFFFF",
          textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
        }}
      />

      <CTAButton text="Play Now" subtitle="play.clawville.com" delay={15} />
    </AbsoluteFill>
  );
};

// Main Video 14 composition
export const DailyStreak: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <ParticleField count={12} color={COLORS.clawToken} speed={0.3} />

      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <CalendarHook />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <StreakRewards />
      </Sequence>

      <Sequence from={9 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <LevelProgression />
      </Sequence>

      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <StreakCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
