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
import { ParticleField } from "../shared/ParticleField";
import { NeopetsPanel } from "../shared/NeopetsPanel";
import { TypewriterText } from "../shared/TypewriterText";
import { LogoReveal } from "../shared/LogoReveal";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../constants/timing";
import { PIPELINE_STEPS } from "../../constants/buildings";

const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Hook (0-3s, frames 0-90)
const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const text = "What if training your AI... felt like playing a game?";
  const words = text.split(" ");

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <ParticleField count={15} color={COLORS.clawToken} speed={0.4} />

      <div
        style={{
          position: "absolute",
          width: width * 0.8,
          textAlign: "center",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0 10px",
        }}
      >
        {words.map((word, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: 8 + i * 4,
            config: SPRING_SNAPPY,
          });
          const wordY = interpolate(entrance, [0, 1], [30, 0]);
          const wordOpacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <span
              key={i}
              style={{
                fontFamily: roboto,
                fontSize: 36,
                fontWeight: 700,
                color: COLORS.panel,
                textShadow: "0 0 16px rgba(255,215,0,0.3)",
                lineHeight: 1.5,
                opacity: wordOpacity,
                transform: `translateY(${wordY}px)`,
                display: "inline-block",
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Training Pipeline (3-8s, frames 90-240)
const TrainingPipelineScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          alignItems: "center",
          gap: 0,
        }}
      >
        {PIPELINE_STEPS.map((step, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: Math.round(i * 0.8 * fps),
            config: SPRING_BOUNCY,
          });
          const stepScale = interpolate(entrance, [0, 1], [0, 1]);
          const stepOpacity = interpolate(entrance, [0, 0.4], [0, 1], {
            extrapolateRight: "clamp",
          });

          // Dashed line between steps
          const lineEntrance = spring({
            frame,
            fps,
            delay: Math.round((i + 0.5) * 0.8 * fps),
            config: SPRING_SMOOTH,
          });
          const lineLength = isVertical
            ? interpolate(lineEntrance, [0, 1], [0, 30])
            : interpolate(lineEntrance, [0, 1], [0, 40]);
          const lineOpacity = interpolate(lineEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <React.Fragment key={step.label}>
              {/* Step circle + label */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  opacity: stepOpacity,
                  transform: `scale(${stepScale})`,
                }}
              >
                {/* Circle with icon */}
                <div
                  style={{
                    width: isVertical ? 56 : 64,
                    height: isVertical ? 56 : 64,
                    borderRadius: "50%",
                    background: `linear-gradient(135deg, ${COLORS.panel}, ${COLORS.clawToken})`,
                    border: `3px solid ${COLORS.border}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 32,
                    boxShadow: "2px 2px 0px rgba(0,0,0,0.2)",
                  }}
                >
                  {step.icon}
                </div>
                {/* Label */}
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 16,
                    fontWeight: 700,
                    color: COLORS.panel,
                    textAlign: "center",
                  }}
                >
                  {step.label}
                </span>
                {/* Description */}
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 12,
                    fontWeight: 400,
                    color: "rgba(255,255,255,0.6)",
                    textAlign: "center",
                    maxWidth: isVertical ? 140 : 90,
                  }}
                >
                  {step.desc}
                </span>
              </div>

              {/* Dashed connector line between steps (not after last) */}
              {i < PIPELINE_STEPS.length - 1 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: isVertical ? "center" : "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    ...(isVertical
                      ? {
                          width: 3,
                          height: lineLength,
                          margin: "4px 0",
                        }
                      : {
                          height: 3,
                          width: lineLength,
                          margin: "0 4px",
                          marginTop: -40,
                        }),
                    opacity: lineOpacity,
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      backgroundImage: isVertical
                        ? `repeating-linear-gradient(to bottom, ${COLORS.clawToken} 0px, ${COLORS.clawToken} 4px, transparent 4px, transparent 8px)`
                        : `repeating-linear-gradient(to right, ${COLORS.clawToken} 0px, ${COLORS.clawToken} 4px, transparent 4px, transparent 8px)`,
                    }}
                  />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: What Your Bot Learns (8-14s, frames 240-420)
const BotLearnsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const learningLines = [
    "Token launch analysis (Pump.fun strategies)",
    "DEX routing optimization (Jupiter/Raydium)",
    "Whale wallet tracking (on-chain forensics)",
    "Risk management (position sizing, stop losses)",
  ];

  const panelWidth = isVertical ? width * 0.85 : 500;

  // Panel entrance
  const panelEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const panelScale = interpolate(panelEntrance, [0, 1], [0.8, 1]);
  const panelOpacity = interpolate(panelEntrance, [0, 0.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Bottom text entrance (springs in after all typewriter lines)
  const bottomEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 4.5),
    config: SPRING_BOUNCY,
  });
  const bottomScale = interpolate(bottomEntrance, [0, 1], [0.5, 1]);
  const bottomOpacity = interpolate(bottomEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          opacity: panelOpacity,
          transform: `scale(${panelScale})`,
        }}
      >
        <NeopetsPanel width={panelWidth}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {/* Title */}
            <span
              style={{
                fontFamily: roboto,
                fontSize: 24,
                fontWeight: 700,
                color: COLORS.panel,
                textAlign: "center",
              }}
            >
              What Your Bot Learns
            </span>

            {/* Learning lines with TypewriterText */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                paddingLeft: 12,
              }}
            >
              {learningLines.map((line, i) => {
                // Stagger start frames for each line
                const lineStartFrame = Math.round(fps * 0.8 + i * fps * 0.9);
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        color: COLORS.accent,
                        fontFamily: roboto,
                        fontSize: 16,
                      }}
                    >
                      {"\u2022"}
                    </span>
                    <TypewriterText
                      text={line}
                      startFrame={lineStartFrame}
                      charsPerSecond={28}
                      style={{
                        fontFamily: roboto,
                        fontSize: 16,
                        fontWeight: 400,
                        color: COLORS.panel,
                        lineHeight: 1.4,
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {/* Bottom text */}
            <div
              style={{
                textAlign: "center",
                marginTop: 8,
                opacity: bottomOpacity,
                transform: `scale(${bottomScale})`,
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 18,
                  fontWeight: 700,
                  color: COLORS.clawToken,
                  textShadow: "0 0 8px rgba(255,215,0,0.3)",
                }}
              >
                All exportable. All production-ready.
              </span>
            </div>
          </div>
        </NeopetsPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (14-17s, frames 420-510)
const CTAScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Text entrance
  const textEntrance = spring({
    frame,
    fps,
    delay: 10,
    config: SPRING_SNAPPY,
  });
  const textOpacity = interpolate(textEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const textY = interpolate(textEntrance, [0, 1], [20, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <ParticleField count={15} color={COLORS.clawToken} speed={0.5} />

      <LogoReveal size={72} />

      <div
        style={{
          opacity: textOpacity,
          transform: `translateY(${textY}px)`,
          textAlign: "center",
          maxWidth: "80%",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 24,
            fontWeight: 400,
            color: COLORS.panel,
            lineHeight: 1.5,
            textShadow: "1px 1px 4px rgba(0,0,0,0.5)",
          }}
        >
          Train smarter bots. In a world they'll never forget.
        </span>
      </div>

      <CTAButton text="Get Started" subtitle="play.clawville.com" delay={15} />
    </AbsoluteFill>
  );
};

// Main Video 13 composition — 17s (510 frames at 30fps)
export const GameToProduction: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      {/* Scene 1: Hook (0-3s) */}
      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <HookScene />
      </Sequence>

      {/* Scene 2: Training Pipeline (3-8s) */}
      <Sequence from={3 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <TrainingPipelineScene />
      </Sequence>

      {/* Scene 3: What Your Bot Learns (8-14s) */}
      <Sequence from={8 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <BotLearnsScene />
      </Sequence>

      {/* Scene 4: CTA (14-17s) */}
      <Sequence from={14 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
