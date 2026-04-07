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
import { MapBackground } from "../shared/MapBackground";
import { ParticleField } from "../shared/ParticleField";
import { PetSprite } from "../shared/PetSprite";
import { ClawPanel } from "../shared/ClawPanel";
import { TypewriterText } from "../shared/TypewriterText";
import { TerminalBlock } from "../shared/TerminalBlock";
import { LogoReveal } from "../shared/LogoReveal";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import { FPS, SPRING_BOUNCY, SPRING_SNAPPY } from "../../constants/timing";
import { BUILDING_THEMES } from "../../constants/buildings";

const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Hook (0-3s, frames 0-90)
const HookScene: React.FC = () => {
  const { width, height } = useVideoConfig();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <ParticleField count={25} color={COLORS.accent} speed={0.5} />
      <div
        style={{
          position: "absolute",
          width: width * 0.8,
          textAlign: "center",
        }}
      >
        <TypewriterText
          text="What if your AI bot could learn... by playing a game?"
          startFrame={10}
          charsPerSecond={25}
          style={{
            fontFamily: roboto,
            fontSize: 40,
            fontWeight: 700,
            color: COLORS.panel,
            lineHeight: 1.4,
            textShadow: `0 0 20px rgba(0,229,255,0.3)`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: World Reveal (3-8s, frames 90-240)
const WorldReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Tint fading from dark to lighter
  const tintOpacity = interpolate(frame, [0, fps * 4], [0.5, 0.2], {
    extrapolateRight: "clamp",
  });

  // First 5 buildings
  const buildings = BUILDING_THEMES.slice(0, 5);

  // Scattered positions across the screen
  const positions = isVertical
    ? [
        { x: 0.2, y: 0.2 },
        { x: 0.7, y: 0.15 },
        { x: 0.15, y: 0.45 },
        { x: 0.75, y: 0.4 },
        { x: 0.45, y: 0.65 },
      ]
    : [
        { x: 0.12, y: 0.2 },
        { x: 0.55, y: 0.12 },
        { x: 0.85, y: 0.25 },
        { x: 0.25, y: 0.65 },
        { x: 0.7, y: 0.7 },
      ];

  return (
    <AbsoluteFill>
      <MapBackground
        zoomRange={[2.0, 1.2]}
        tintColor="#000"
        tintOpacity={tintOpacity}
        panYRange={[-0.05, 0.02]}
      />

      {buildings.map((building, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: 15 + i * 10,
          config: SPRING_BOUNCY,
        });
        const scale = interpolate(entrance, [0, 1], [0, 1]);
        const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
          extrapolateRight: "clamp",
        });
        const pos = positions[i];

        return (
          <div
            key={building.name}
            style={{
              position: "absolute",
              left: pos.x * width - (isVertical ? 80 : 90),
              top: pos.y * height - 25,
              opacity,
              transform: `scale(${scale})`,
            }}
          >
            <ClawPanel
              width={isVertical ? 160 : 180}
              style={{ padding: "8px 12px" }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 22 }}>{building.icon}</span>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 13,
                    fontWeight: 700,
                    color: COLORS.primary,
                  }}
                >
                  {building.name}
                </span>
              </div>
            </ClawPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: Bot Connection (8-13s, frames 240-390)
const BotConnection: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Terminal slides in from right
  const terminalSlide = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const terminalX = interpolate(terminalSlide, [0, 1], [400, 0]);

  // Green dot pulsing
  const dotPulse = Math.sin(((frame / fps) * 3) * Math.PI * 2);
  const dotScale = 1 + dotPulse * 0.15;
  const dotGlow = 6 + dotPulse * 4;

  // "Bot Connected" text entrance
  const connectedEntrance = spring({
    frame,
    fps,
    delay: fps * 2.5,
    config: SPRING_BOUNCY,
  });
  const connectedOpacity = interpolate(connectedEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const connectedScale = interpolate(connectedEntrance, [0, 1], [0.5, 1]);

  // Lobster entrance
  const petEntrance = spring({
    frame,
    fps,
    delay: fps * 3,
    config: SPRING_BOUNCY,
  });
  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);

  const terminalWidth = isVertical ? width * 0.85 : 480;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <ParticleField count={12} color={COLORS.success} speed={0.3} />

      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          alignItems: "center",
          gap: isVertical ? 30 : 50,
        }}
      >
        {/* Terminal Block */}
        <div
          style={{
            transform: `translateX(${terminalX}px)`,
          }}
        >
          <TerminalBlock
            lines={[
              'POST /api/openclaw/register',
              '{ mode: "avatar", name: "MyBot" }',
              '\u2192 200 OK { sessionId: "abc-123" }',
            ]}
            startFrame={15}
            charsPerSecond={35}
            width={terminalWidth}
          />
        </div>

        {/* Right side: connected status + lobster */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 20,
          }}
        >
          {/* Green dot + Bot Connected */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              opacity: connectedOpacity,
              transform: `scale(${connectedScale})`,
            }}
          >
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                backgroundColor: COLORS.success,
                transform: `scale(${dotScale})`,
                boxShadow: `0 0 ${dotGlow}px ${COLORS.success}`,
              }}
            />
            <span
              style={{
                fontFamily: roboto,
                fontSize: 22,
                fontWeight: 700,
                color: COLORS.success,
                textShadow: `0 0 8px rgba(0,230,118,0.4)`,
              }}
            >
              Bot Connected
            </span>
          </div>

          {/* Lobster */}
          <div
            style={{
              transform: `scale(${petScale})`,
            }}
          >
            <PetSprite species="cat" size={120} enterDelay={0} bob />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (13-15s, frames 390-450)
const TrainCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <ParticleField count={15} color={COLORS.accent} speed={0.6} />
      <LogoReveal size={48} />
      <CTAButton text="Train Your Bot" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main Video 6 composition
export const AITrainingWorld: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <HookScene />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <WorldReveal />
      </Sequence>

      <Sequence from={8 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <BotConnection />
      </Sequence>

      <Sequence from={13 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <TrainCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
