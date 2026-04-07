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
import { MapBackground } from "../../../shared/MapBackground";
import { ParticleField } from "../../../shared/ParticleField";
import { PetSprite } from "../../../shared/PetSprite";
import { CTAButton } from "../../../shared/CTAButton";
import { TerminalBlock } from "../../../shared/TerminalBlock";
import { LogoReveal } from "../../../shared/LogoReveal";
import { COLORS } from "../../../../constants/colors";
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

// Scene 2: Bot Intro (1-5s, frames 30-150)
const BotIntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });

  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);

  // Badge pops in after pet
  const badgeDelay = Math.round(fps * 0.6);
  const badgeEntrance = spring({
    frame,
    fps,
    delay: badgeDelay,
    config: SPRING_BOUNCY,
  });

  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1.2]);

  // Auto-pilot indicator pulsing
  const pulsePhase = (frame / fps) * 3 * Math.PI;
  const pulseOpacity = 0.7 + Math.sin(pulsePhase) * 0.3;

  // Label entrance
  const labelDelay = Math.round(fps * 1.2);
  const labelEntrance = spring({
    frame,
    fps,
    delay: labelDelay,
    config: SPRING_SNAPPY,
  });

  const labelOpacity = interpolate(labelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const labelY = interpolate(labelEntrance, [0, 1], [20, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 16,
        flexDirection: "column",
      }}
    >
      {/* Pet with bot badge */}
      <div style={{ position: "relative", transform: `scale(${petScale})` }}>
        <PetSprite species="dragon" size={isVertical ? 140 : 160} bob />

        {/* Bot badge */}
        <div
          style={{
            position: "absolute",
            top: -8,
            right: -12,
            transform: `scale(${badgeScale})`,
            background: `linear-gradient(135deg, #7E57C2, #CE93D8)`,
            borderRadius: 12,
            padding: "4px 12px",
            boxShadow: "2px 2px 6px rgba(0,0,0,0.3)",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            BOT
          </span>
        </div>
      </div>

      {/* Auto-pilot indicator */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          opacity: pulseOpacity,
          transform: `scale(${badgeScale > 0.1 ? 1 : 0})`,
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: COLORS.green,
            boxShadow: `0 0 10px ${COLORS.green}`,
          }}
        />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            fontWeight: 700,
            color: COLORS.green,
            textShadow: `0 0 8px ${COLORS.green}60`,
          }}
        >
          Auto-Pilot Active
        </span>
      </div>

      {/* Label */}
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: COLORS.panel,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          opacity: labelOpacity,
          transform: `translateY(${labelY}px)`,
        }}
      >
        Your Bot Explores for You
      </span>
    </AbsoluteFill>
  );
};

// Scene 3: Autonomous Walk (5-10s, frames 150-300)
const AutonomousWalkScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Pet translates across the screen
  const walkDuration = 5 * fps;
  const walkProgress = Math.min(frame / walkDuration, 1);
  const petX = interpolate(
    walkProgress,
    [0, 0.3, 0.6, 1],
    [
      isVertical ? -60 : -80,
      isVertical ? width * 0.3 : width * 0.25,
      isVertical ? width * 0.6 : width * 0.55,
      isVertical ? width * 0.85 : width * 0.8,
    ]
  );

  // 3 building icons pop at waypoints
  const buildings = [
    { icon: "🧪", name: "Alpha Lab", triggerAt: 0.2 },
    { icon: "🏪", name: "DEX Floor", triggerAt: 0.5 },
    { icon: "🐋", name: "Whale Cove", triggerAt: 0.8 },
  ];

  return (
    <AbsoluteFill>
      <MapBackground
        zoom={1.5}
        tintColor="#000"
        tintOpacity={0.25}
        panXRange={[-0.15, 0.15]}
      />

      {/* Path trail (dotted line) */}
      <div
        style={{
          position: "absolute",
          top: height * 0.5 + 30,
          left: 40,
          right: 40,
          height: 3,
          background: `repeating-linear-gradient(90deg, ${COLORS.green}60 0px, ${COLORS.green}60 8px, transparent 8px, transparent 16px)`,
          opacity: 0.6,
        }}
      />

      {/* Building waypoint icons */}
      {buildings.map((b, i) => {
        const visible = walkProgress >= b.triggerAt - 0.05;
        const popEntrance = visible
          ? spring({
              frame: frame - Math.round(b.triggerAt * walkDuration),
              fps,
              config: SPRING_BOUNCY,
            })
          : 0;

        const popScale = interpolate(
          typeof popEntrance === "number" ? popEntrance : 0,
          [0, 1],
          [0, 1]
        );

        const xPos = interpolate(
          b.triggerAt,
          [0, 1],
          [isVertical ? 40 : 60, isVertical ? width - 40 : width - 60]
        );

        return (
          <div
            key={b.name}
            style={{
              position: "absolute",
              left: xPos - 30,
              top: height * 0.5 - 60,
              transform: `scale(${popScale})`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 12,
                background: COLORS.panel,
                border: `3px solid ${COLORS.panelBorder}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
                boxShadow: "3px 3px 0px rgba(0,0,0,0.2)",
              }}
            >
              {b.icon}
            </div>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 11,
                fontWeight: 700,
                color: COLORS.white,
                textShadow: "1px 1px 2px rgba(0,0,0,0.8)",
                textAlign: "center",
                whiteSpace: "nowrap",
              }}
            >
              {b.name}
            </span>

            {/* Checkmark if passed */}
            {walkProgress > b.triggerAt + 0.1 && (
              <div
                style={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: COLORS.green,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  color: COLORS.white,
                  fontWeight: 700,
                  boxShadow: `0 0 6px ${COLORS.green}80`,
                }}
              >
                ✓
              </div>
            )}
          </div>
        );
      })}

      {/* Moving pet */}
      <div
        style={{
          position: "absolute",
          left: petX - 40,
          top: height * 0.5 - 20,
        }}
      >
        <PetSprite species="dragon" size={80} bob />
        {/* Auto badge */}
        <div
          style={{
            position: "absolute",
            top: -16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(126,87,194,0.9)",
            borderRadius: 8,
            padding: "2px 8px",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 10,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            Auto
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Learning Log (10-14s, frames 300-420)
const LearningLogScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const terminalEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });

  const terminalScale = interpolate(terminalEntrance, [0, 1], [0.7, 1]);
  const terminalOpacity = interpolate(terminalEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Stats entrance
  const statsDelay = Math.round(fps * 2);
  const statsEntrance = spring({
    frame,
    fps,
    delay: statsDelay,
    config: SPRING_BOUNCY,
  });

  const statsScale = interpolate(statsEntrance, [0, 1], [0.5, 1]);
  const statsOpacity = interpolate(statsEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 24 : 20,
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 26 : 32,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          opacity: terminalOpacity,
        }}
      >
        Learning Log
      </span>

      {/* Terminal showing learned topics */}
      <div
        style={{
          transform: `scale(${terminalScale})`,
          opacity: terminalOpacity,
        }}
      >
        <TerminalBlock
          lines={[
            "bot-explore --autonomous",
            "[+] Token sniping strategies",
            "[+] Jupiter routing optimized",
            "[+] Wallet tracking methods",
            "[+] Pump.fun bonding curves",
            "4 skills acquired. +8 ClawTokens earned.",
          ]}
          charsPerSecond={40}
          width={isVertical ? 320 : 440}
        />
      </div>

      {/* Stats row */}
      <div
        style={{
          display: "flex",
          gap: isVertical ? 20 : 32,
          opacity: statsOpacity,
          transform: `scale(${statsScale})`,
        }}
      >
        {[
          { label: "Buildings", value: "3", icon: "🏠" },
          { label: "Skills", value: "+4", icon: "📚" },
          { label: "Tokens", value: "+8", icon: "💰" },
        ].map((stat, i) => (
          <div
            key={stat.label}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span style={{ fontSize: 24 }}>{stat.icon}</span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 22,
                fontWeight: 700,
                color: COLORS.gold,
              }}
            >
              {stat.value}
            </span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 12,
                color: COLORS.panel,
              }}
            >
              {stat.label}
            </span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (14-17s, frames 420-510)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 24 }}
    >
      <LogoReveal size={56} />
      <CTAButton text="Let Your Bot Explore" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S06 composition (17s)
export const BotExploration: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-world-exploration-npcs.mp4" startFrom={5} playbackRate={0.8} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color="#CE93D8" speed={0.6} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Bot-Powered Exploration"
          subtitle="Your AI bot explores autonomously"
          accentColor="#CE93D8"
        />
      </Sequence>

      {/* Scene 2: Bot Intro (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BotIntroScene />
      </Sequence>

      {/* Scene 3: Autonomous Walk (5-10s) */}
      <Sequence from={5 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <AutonomousWalkScene />
      </Sequence>

      {/* Scene 4: Learning Log (10-14s) */}
      <Sequence from={10 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <LearningLogScene />
      </Sequence>

      {/* Scene 5: CTA (14-17s) */}
      <Sequence from={14 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
