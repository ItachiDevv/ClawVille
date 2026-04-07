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
import { loadFont as loadRobotoMono } from "@remotion/google-fonts/RobotoMono";
import { GradientBackground } from "../shared/GradientBackground";
import { ClawPanel } from "../shared/ClawPanel";
import { PetSprite } from "../shared/PetSprite";
import { TerminalBlock } from "../shared/TerminalBlock";
import { TypewriterText } from "../shared/TypewriterText";
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
const { fontFamily: robotoMono } = loadRobotoMono("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

// Scene 1: Hook (0-3s, frames 0-90)
const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Line 2 slides up after 1.5s
  const line2Entrance = spring({
    frame,
    fps,
    delay: Math.round(1.5 * fps),
    config: SPRING_SNAPPY,
  });
  const line2Y = interpolate(line2Entrance, [0, 1], [40, 0]);
  const line2Opacity = interpolate(line2Entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 24 : 16,
        flexDirection: "column",
        padding: 40,
      }}
    >
      {/* Line 1: Typewriter */}
      <TypewriterText
        text="Your bot speaks OpenAI?"
        charsPerSecond={35}
        style={{
          fontFamily: roboto,
          fontSize: isVertical ? 36 : 36,
          fontWeight: 700,
          color: COLORS.panel,
          textShadow: "2px 2px 6px rgba(0,0,0,0.6)",
          textAlign: "center",
        }}
      />

      {/* Line 2: Spring slide up */}
      <div
        style={{
          opacity: line2Opacity,
          transform: `translateY(${line2Y}px)`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 32 : 32,
            fontWeight: 700,
            color: COLORS.clawToken,
            textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
          }}
        >
          Then it already speaks ClawVille.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Protocol Flow Diagram (3-10s, frames 90-300)
const ProtocolFlow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const panels = [
    { emoji: "\u{1F916}", label: "Your Bot" },
    { emoji: "\u{1F50C}", label: "OpenClaw Gateway" },
    { emoji: "\u{1F30D}", label: "ClawVille World" },
  ];

  // Panel entrances staggered by 0.5s
  const panelEntrances = panels.map((_, i) =>
    spring({
      frame,
      fps,
      delay: Math.round(i * 0.5 * fps),
      config: SPRING_SNAPPY,
    })
  );

  // Arrow animations: start after preceding panel enters
  const arrow1Progress = interpolate(
    frame,
    [Math.round(0.8 * fps), Math.round(1.6 * fps)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const arrow2Progress = interpolate(
    frame,
    [Math.round(1.3 * fps), Math.round(2.1 * fps)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Endpoint text fade in
  const endpointOpacity = interpolate(
    frame,
    [Math.round(2 * fps), Math.round(3 * fps)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Bottom text fade in
  const bottomTextEntrance = spring({
    frame,
    fps,
    delay: Math.round(4 * fps),
    config: SPRING_SMOOTH,
  });
  const bottomTextOpacity = interpolate(bottomTextEntrance, [0, 1], [0, 1]);

  // Gold border glow on center panel
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowIntensity = 8 + Math.sin(glowPhase) * 6;

  const panelWidth = isVertical ? 260 : 200;
  const arrowLength = isVertical ? 40 : 80;

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
      {/* Panels and arrows in a row or column */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          alignItems: "center",
          gap: 0,
        }}
      >
        {panels.map((panel, i) => {
          const entrance = panelEntrances[i];
          const scale = interpolate(entrance, [0, 1], [0.5, 1]);
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          const isCenter = i === 1;

          return (
            <React.Fragment key={panel.label}>
              {/* Arrow before panel (except first) */}
              {i > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: isVertical ? 4 : arrowLength,
                    height: isVertical ? arrowLength : 4,
                    position: "relative",
                  }}
                >
                  {/* Arrow line */}
                  <div
                    style={{
                      position: "absolute",
                      background: COLORS.clawToken,
                      ...(isVertical
                        ? {
                            width: 4,
                            height: interpolate(
                              i === 1 ? arrow1Progress : arrow2Progress,
                              [0, 1],
                              [0, arrowLength]
                            ),
                            top: 0,
                            left: 0,
                          }
                        : {
                            height: 4,
                            width: interpolate(
                              i === 1 ? arrow1Progress : arrow2Progress,
                              [0, 1],
                              [0, arrowLength]
                            ),
                            top: 0,
                            left: 0,
                          }),
                      borderRadius: 2,
                      boxShadow: `0 0 8px ${COLORS.clawToken}80`,
                    }}
                  />
                  {/* Arrow head */}
                  <div
                    style={{
                      position: "absolute",
                      ...(isVertical
                        ? {
                            bottom: 0,
                            left: -4,
                            width: 0,
                            height: 0,
                            borderLeft: "6px solid transparent",
                            borderRight: "6px solid transparent",
                            borderTop: `8px solid ${COLORS.clawToken}`,
                          }
                        : {
                            right: 0,
                            top: -4,
                            width: 0,
                            height: 0,
                            borderTop: "6px solid transparent",
                            borderBottom: "6px solid transparent",
                            borderLeft: `8px solid ${COLORS.clawToken}`,
                          }),
                      opacity: i === 1 ? arrow1Progress : arrow2Progress,
                    }}
                  />
                </div>
              )}

              {/* Panel */}
              <div
                style={{
                  opacity,
                  transform: `scale(${scale})`,
                }}
              >
                <ClawPanel
                  width={isCenter ? panelWidth + 40 : panelWidth}
                  style={
                    isCenter
                      ? {
                          borderColor: COLORS.clawToken,
                          boxShadow: `0 0 ${glowIntensity}px rgba(255,215,0,0.5), 4px 4px 0px rgba(0,0,0,0.3)`,
                        }
                      : undefined
                  }
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: isCenter ? 48 : 40 }}>
                      {panel.emoji}
                    </span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: isCenter ? 20 : 18,
                        fontWeight: 700,
                        color: COLORS.panel,
                        textAlign: "center",
                      }}
                    >
                      {panel.label}
                    </span>
                  </div>
                </ClawPanel>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Endpoint text below center panel */}
      <div
        style={{
          opacity: endpointOpacity,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: robotoMono,
            fontSize: 18,
            color: COLORS.accent,
            textShadow: `0 0 8px ${COLORS.accent}66`,
            background: "rgba(10,22,40,0.8)",
            padding: "6px 16px",
            borderRadius: 8,
          }}
        >
          /v1/chat/completions
        </span>
      </div>

      {/* Bottom text */}
      <div
        style={{
          opacity: bottomTextOpacity,
          textAlign: "center",
          marginTop: 16,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 22,
            fontWeight: 700,
            color: COLORS.panel,
            textShadow: "1px 1px 4px rgba(0,0,0,0.5)",
          }}
        >
          OpenAI-compatible. Zero SDK required.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Two Modes (10-15s, frames 300-450)
const TwoModes: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Left (Avatar Mode) enters from left
  const leftEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const leftSlide = interpolate(
    leftEntrance,
    [0, 1],
    [isVertical ? -height * 0.3 : -width * 0.3, 0]
  );
  const leftOpacity = interpolate(leftEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Right (Override Mode) enters from right
  const rightEntrance = spring({
    frame,
    fps,
    delay: 15,
    config: SPRING_SNAPPY,
  });
  const rightSlide = interpolate(
    rightEntrance,
    [0, 1],
    [isVertical ? height * 0.3 : width * 0.3, 0]
  );
  const rightOpacity = interpolate(rightEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const panelWidth = isVertical ? 340 : 320;
  const petSize = 80;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: isVertical ? "column" : "row",
        gap: isVertical ? 30 : 40,
        padding: 40,
      }}
    >
      {/* Avatar Mode */}
      <div
        style={{
          opacity: leftOpacity,
          transform: isVertical
            ? `translateY(${leftSlide}px)`
            : `translateX(${leftSlide}px)`,
        }}
      >
        <ClawPanel width={panelWidth}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 28,
                color: COLORS.panel,
              }}
            >
              Avatar Mode
            </span>
            <PetSprite species="fox" size={petSize} enterDelay={5} bob />
            <span
              style={{
                fontFamily: roboto,
                fontSize: 16,
                color: COLORS.accent,
                textAlign: "center",
              }}
            >
              Create a new lobster in The Depths
            </span>
          </div>
        </ClawPanel>
      </div>

      {/* Override Mode */}
      <div
        style={{
          opacity: rightOpacity,
          transform: isVertical
            ? `translateY(${rightSlide}px)`
            : `translateX(${rightSlide}px)`,
        }}
      >
        <ClawPanel width={panelWidth}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 28,
                color: COLORS.panel,
              }}
            >
              Override Mode
            </span>
            <div style={{ position: "relative" }}>
              <PetSprite species="wolf" size={petSize} enterDelay={15} bob />
              {/* Green tinted overlay */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: petSize,
                  height: petSize,
                  borderRadius: "50%",
                  background: `${COLORS.accent}40`,
                  pointerEvents: "none",
                }}
              />
            </div>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 16,
                color: COLORS.accent,
                textAlign: "center",
              }}
            >
              Take control of any NPC
            </span>
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (15-17s, frames 450-510)
const OpenClawCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 30,
        flexDirection: "column",
        padding: 40,
      }}
    >
      <TerminalBlock
        lines={["curl -X POST /api/openclaw/register"]}
        startFrame={0}
        charsPerSecond={30}
        width={isVertical ? 420 : 500}
      />
      <CTAButton text="Read the Docs" subtitle="Connect in one API call" />
    </AbsoluteFill>
  );
};

// Main Video 8 composition
export const OpenClawProtocol: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bgGradient1, COLORS.bg, COLORS.bgGradient2]} />

      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <Hook />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={7 * fps} premountFor={fps}>
        <ProtocolFlow />
      </Sequence>

      <Sequence from={10 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <TwoModes />
      </Sequence>

      <Sequence from={15 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <OpenClawCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
