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
import { SpeechBubble } from "../shared/SpeechBubble";
import { NeopetsPanel } from "../shared/NeopetsPanel";
import { AnimatedCounter } from "../shared/AnimatedCounter";
import { TerminalBlock } from "../shared/TerminalBlock";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import { LEARNING_STEPS } from "../../constants/buildings";
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

// Scene 1: Hook (0-3s, frames 0-90)
const LearnHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <ParticleField count={20} color={COLORS.neoToken} speed={0.6} />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <PetSprite species="cat" size={isVertical ? 140 : 120} enterDelay={0} bob />
        <Sequence from={10} layout="none">
          <SpeechBubble
            text="Time to learn!"
            direction="left"
            delay={0}
            maxWidth={240}
          />
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Learning Journey Timeline (3-9s, frames 90-270)
const LearningJourney: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Determine which counter target to show based on step completion
  const stepsCompleted = LEARNING_STEPS.reduce((count, _, i) => {
    const stepDelay = i * 1.5 * fps;
    // Checkmark appears after panel + 0.8s
    const checkDelay = stepDelay + Math.round(0.8 * fps);
    const checkEntrance = spring({
      frame,
      fps,
      delay: checkDelay,
      config: SPRING_BOUNCY,
    });
    return count + (checkEntrance > 0.5 ? 1 : 0);
  }, 0);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: isVertical ? "column" : "row",
        gap: isVertical ? 16 : 40,
        padding: 40,
      }}
    >
      {/* Left: Learning steps */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: isVertical ? 12 : 16,
          flex: isVertical ? undefined : 1,
          maxWidth: isVertical ? 450 : 500,
        }}
      >
        {LEARNING_STEPS.map((step, i) => {
          const stepDelay = Math.round(i * 1.5 * fps);
          const panelEntrance = spring({
            frame,
            fps,
            delay: stepDelay,
            config: SPRING_SNAPPY,
          });
          const panelSlideX = interpolate(panelEntrance, [0, 1], [-200, 0]);
          const panelOpacity = interpolate(panelEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          // Checkmark springs in after panel
          const checkDelay = stepDelay + Math.round(0.8 * fps);
          const checkEntrance = spring({
            frame,
            fps,
            delay: checkDelay,
            config: SPRING_BOUNCY,
          });
          const checkScale = interpolate(checkEntrance, [0, 1], [0, 1]);
          const checkOpacity = interpolate(checkEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={step.building}
              style={{
                opacity: panelOpacity,
                transform: `translateX(${panelSlideX}px)`,
              }}
            >
              <NeopetsPanel width={isVertical ? 400 : 440}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 16,
                        fontWeight: 700,
                        color: COLORS.panel,
                      }}
                    >
                      {step.building}
                    </span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 14,
                        color: COLORS.accent,
                      }}
                    >
                      Learned: {step.knowledge}
                    </span>
                  </div>
                  {/* Checkmark */}
                  <div
                    style={{
                      opacity: checkOpacity,
                      transform: `scale(${checkScale})`,
                      fontSize: 28,
                      flexShrink: 0,
                    }}
                  >
                    {"\u2705"}
                  </div>
                </div>
              </NeopetsPanel>
            </div>
          );
        })}
      </div>

      {/* Right: Knowledge counter */}
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
            fontFamily: lobster,
            fontSize: isVertical ? 24 : 28,
            color: COLORS.neoToken,
            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
          }}
        >
          Knowledge
        </span>
        <AnimatedCounter
          from={0}
          to={16}
          delay={Math.round(0.8 * fps)}
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 48 : 56,
            fontWeight: 700,
            color: COLORS.neoToken,
            textShadow: "2px 2px 6px rgba(0,0,0,0.5)",
          }}
        />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 16,
            color: COLORS.panel,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          entries learned
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: SKILL.md Export (9-14s, frames 270-420)
const SkillExport: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Panel slides up from bottom
  const panelEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const panelSlideY = interpolate(panelEntrance, [0, 1], [300, 0]);
  const panelOpacity = interpolate(panelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Export text springs in
  const textEntrance = spring({
    frame,
    fps,
    delay: Math.round(3 * fps),
    config: SPRING_SNAPPY,
  });
  const textOpacity = interpolate(textEntrance, [0, 1], [0, 1]);
  const textSlideY = interpolate(textEntrance, [0, 1], [30, 0]);

  // Download arrow bounce
  const arrowEntrance = spring({
    frame,
    fps,
    delay: Math.round(3.5 * fps),
    config: SPRING_BOUNCY,
  });
  const arrowScale = interpolate(arrowEntrance, [0, 1], [0, 1]);
  const arrowBobY =
    frame > Math.round(3.5 * fps)
      ? Math.sin(((frame - Math.round(3.5 * fps)) / fps) * 3 * Math.PI * 2) * 6
      : 0;

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
      {/* Terminal panel slides up */}
      <div
        style={{
          opacity: panelOpacity,
          transform: `translateY(${panelSlideY}px)`,
        }}
      >
        <NeopetsPanel
          width={isVertical ? 460 : 600}
          style={{
            background: `${COLORS.bgLight}ee`,
          }}
        >
          <TerminalBlock
            lines={[
              "# ClawVille Knowledge Export",
              "## Crypto Knowledge",
              "- Token sniping strategies...",
              "- Jupiter DEX aggregation...",
              "- Whale wallet tracking...",
              "- Bonding curve mathematics...",
            ]}
            startFrame={10}
            charsPerSecond={35}
            width={isVertical ? 400 : 540}
          />
        </NeopetsPanel>
      </div>

      {/* Export text */}
      <div
        style={{
          opacity: textOpacity,
          transform: `translateY(${textSlideY}px)`,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 20,
            fontWeight: 700,
            color: COLORS.panel,
            textShadow: "1px 1px 4px rgba(0,0,0,0.5)",
          }}
        >
          Export as SKILL.md {"\u2192"} Deploy to Production
        </span>

        {/* Download arrow */}
        <div
          style={{
            transform: `scale(${arrowScale}) translateY(${arrowBobY}px)`,
            fontSize: 40,
            color: COLORS.neoToken,
            textShadow: `0 0 12px rgba(255,215,0,0.5)`,
          }}
        >
          {"\u2B07"}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (14-16s, frames 420-480)
const ExportCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleEntrance = spring({
    frame,
    fps,
    delay: 0,
    config: SPRING_SMOOTH,
  });
  const titleOpacity = interpolate(titleEntrance, [0, 1], [0, 1]);
  const titleSlideY = interpolate(titleEntrance, [0, 1], [20, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        flexDirection: "column",
      }}
    >
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleSlideY}px)`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 32,
            color: COLORS.neoToken,
            textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
          }}
        >
          Knowledge that travels with your bot
        </span>
      </div>
      <CTAButton text="Export Knowledge" />
    </AbsoluteFill>
  );
};

// Main Video 9 composition
export const LearnThenExport: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <MapBackground
        zoom={1.4}
        tintColor={COLORS.bg}
        tintOpacity={0.5}
        panX={-0.05}
        panYRange={[-0.03, 0.03]}
      />

      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <LearnHook />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <LearningJourney />
      </Sequence>

      <Sequence from={9 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <SkillExport />
      </Sequence>

      <Sequence from={14 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <ExportCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
