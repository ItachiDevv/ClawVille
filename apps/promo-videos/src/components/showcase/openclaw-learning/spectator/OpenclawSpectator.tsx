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
import { ParticleField } from "../../../shared/ParticleField";
import { PetSprite } from "../../../shared/PetSprite";
import { ClawPanel } from "../../../shared/ClawPanel";
import { HPBar } from "../../../shared/HPBar";
import { DamageNumber } from "../../../shared/DamageNumber";
import { TerminalBlock } from "../../../shared/TerminalBlock";
import { CTAButton } from "../../../shared/CTAButton";
import { LogoReveal } from "../../../shared/LogoReveal";
import { COLORS } from "../../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
} from "../../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const ACCENT = "#4CAF50";

const TERMINAL_LINES = [
  "openclaw analyze --mode spectator",
  "  Watching: DragonX vs PhoenixZ",
  "  [Strategy] Counter-attack on low HP",
  "  [Pattern] Sandwich defense detected",
  "  [Learned] MEV protection tactic",
  "  Knowledge +3 entries saved",
];

const EXTRACTION_ARROWS = [
  { label: "Attack Pattern", delay: 0 },
  { label: "Defense Strat", delay: 12 },
  { label: "Token Timing", delay: 24 },
  { label: "MEV Counter", delay: 36 },
];

// Scene 2: Bot Spectating (1-5s, frames 30-150)
const BotSpectatingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });

  const badgeEntrance = spring({
    frame,
    fps,
    delay: 12,
    config: SPRING_SNAPPY,
  });

  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);
  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);
  const badgeOpacity = interpolate(badgeEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Eye tracking animation — eyes sweep left to right
  const eyeTrackX = Math.sin((frame / fps) * 2.5) * 20;
  const eyeTrackY = Math.cos((frame / fps) * 1.8) * 8;

  // Scanning line effect
  const scanProgress = ((frame / fps) * 0.5) % 1;
  const scanY = interpolate(scanProgress, [0, 1], [0, height * 0.6]);

  // Pulsing glow on pet
  const glowPulse = 8 + Math.sin((frame / fps) * 4) * 6;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 20 : 16,
      }}
    >
      {/* Scanning line */}
      <div
        style={{
          position: "absolute",
          left: "10%",
          right: "10%",
          top: height * 0.2 + scanY,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${ACCENT}80, transparent)`,
          boxShadow: `0 0 10px ${ACCENT}40`,
        }}
      />

      {/* Pet with spectating badge */}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          transform: `scale(${petScale})`,
        }}
      >
        {/* Glow ring behind pet */}
        <div
          style={{
            position: "absolute",
            width: isVertical ? 160 : 180,
            height: isVertical ? 160 : 180,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${ACCENT}20 0%, transparent 70%)`,
            boxShadow: `0 0 ${glowPulse}px ${ACCENT}40`,
            top: isVertical ? -10 : -15,
          }}
        />

        <PetSprite species="owl" size={isVertical ? 130 : 150} bob />

        {/* Spectating badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: `${ACCENT}DD`,
            borderRadius: 20,
            padding: "8px 20px",
            boxShadow: `0 0 15px ${ACCENT}60`,
            transform: `scale(${badgeScale})`,
            opacity: badgeOpacity,
          }}
        >
          <span style={{ fontSize: 18 }}>👁️</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 16,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            SPECTATING
          </span>
        </div>
      </div>

      {/* Tracking eyes indicator */}
      <div
        style={{
          display: "flex",
          gap: 20,
          alignItems: "center",
          marginTop: 12,
        }}
      >
        {/* Left eye */}
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.15)",
            border: `2px solid ${ACCENT}80`,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: ACCENT,
              position: "absolute",
              left: 10 + eyeTrackX * 0.3,
              top: 10 + eyeTrackY * 0.3,
              boxShadow: `0 0 6px ${ACCENT}`,
            }}
          />
        </div>

        <span
          style={{
            fontFamily: roboto,
            fontSize: 14,
            color: "rgba(255,255,255,0.6)",
            fontStyle: "italic",
          }}
        >
          Tracking battle data...
        </span>

        {/* Right eye */}
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.15)",
            border: `2px solid ${ACCENT}80`,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: ACCENT,
              position: "absolute",
              left: 10 + eyeTrackX * 0.3,
              top: 10 + eyeTrackY * 0.3,
              boxShadow: `0 0 6px ${ACCENT}`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Battle Feed (5-10s, frames 150-300)
const BattleFeedScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const arenaEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const arenaScale = interpolate(arenaEntrance, [0, 1], [0.7, 1]);
  const arenaOpacity = interpolate(arenaEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Battle action
  const battlePhase = Math.floor((frame / fps) * 2) % 2;

  // Data extraction panel position
  const panelX = isVertical ? width * 0.5 : width * 0.78;
  const panelY = isVertical ? height * 0.72 : height * 0.5;

  return (
    <AbsoluteFill>
      {/* Mini arena */}
      <div
        style={{
          position: "absolute",
          left: isVertical ? "5%" : "5%",
          top: isVertical ? "10%" : "10%",
          width: isVertical ? "90%" : "50%",
          height: isVertical ? "45%" : "80%",
          background: "rgba(0,0,0,0.3)",
          border: `2px solid ${ACCENT}40`,
          borderRadius: 16,
          display: "flex",
          justifyContent: "space-around",
          alignItems: "center",
          transform: `scale(${arenaScale})`,
          opacity: arenaOpacity,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            transform: `translateX(${battlePhase === 0 ? 8 : 0}px)`,
          }}
        >
          <PetSprite species="dragon" size={isVertical ? 64 : 80} bob />
          <HPBar hp={70} maxHp={100} width={isVertical ? 80 : 100} />
        </div>

        <span
          style={{
            fontFamily: lobster,
            fontSize: 22,
            color: COLORS.gold,
            textShadow: "1px 1px 0px rgba(0,0,0,0.5)",
          }}
        >
          VS
        </span>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            transform: `translateX(${battlePhase === 1 ? -8 : 0}px)`,
          }}
        >
          <PetSprite species="phoenix" size={isVertical ? 64 : 80} flipX bob />
          <HPBar hp={55} maxHp={100} width={isVertical ? 80 : 100} />
        </div>
      </div>

      {/* Data extraction arrows */}
      {EXTRACTION_ARROWS.map((arrow, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: arrow.delay,
          config: SPRING_SNAPPY,
        });
        const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        const arrowStartX = isVertical ? width * 0.5 : width * 0.55;
        const arrowStartY = isVertical
          ? height * 0.55 + i * 8
          : height * 0.2 + i * (height * 0.15);
        const arrowEndX = panelX - (isVertical ? 60 : 80);
        const arrowEndY = panelY - 40 + i * 28;

        const progress = interpolate(entrance, [0, 1], [0, 1]);
        const currentX = interpolate(progress, [0, 1], [arrowStartX, arrowEndX]);
        const currentY = interpolate(progress, [0, 1], [arrowStartY, arrowEndY]);

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: currentX,
              top: currentY,
              opacity,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ color: ACCENT, fontSize: 14 }}>{">>>"}</span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 13,
                fontWeight: 700,
                color: ACCENT,
                background: "rgba(0,0,0,0.5)",
                borderRadius: 8,
                padding: "3px 10px",
                whiteSpace: "nowrap",
              }}
            >
              {arrow.label}
            </span>
          </div>
        );
      })}

      {/* Bot receiving data */}
      <div
        style={{
          position: "absolute",
          right: isVertical ? "10%" : "5%",
          bottom: isVertical ? "8%" : "15%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <PetSprite species="owl" size={isVertical ? 60 : 72} bob />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 12,
            fontWeight: 700,
            color: ACCENT,
            background: "rgba(0,0,0,0.5)",
            borderRadius: 10,
            padding: "3px 10px",
          }}
        >
          Analyzing...
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Bot Knowledge (10-14s, frames 300-420)
const BotKnowledgeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const titleOpacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const terminalEntrance = spring({
    frame,
    fps,
    delay: 8,
    config: SPRING_SNAPPY,
  });
  const terminalScale = interpolate(terminalEntrance, [0, 1], [0.8, 1]);
  const terminalOpacity = interpolate(terminalEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
        padding: isVertical ? 20 : 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: ACCENT,
          textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 15px ${ACCENT}40`,
          opacity: titleOpacity,
        }}
      >
        Bot Learned Strategies
      </span>

      <div
        style={{
          transform: `scale(${terminalScale})`,
          opacity: terminalOpacity,
          width: isVertical ? "95%" : "65%",
        }}
      >
        <TerminalBlock
          lines={TERMINAL_LINES}
          startFrame={10}
          charsPerSecond={50}
        />
      </div>

      {/* Knowledge counter */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 8,
        }}
      >
        <span style={{ fontSize: 24 }}>📚</span>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            fontWeight: 700,
            color: COLORS.gold,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          +3 Knowledge Entries Saved
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (14-17s, frames 420-510)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={56} />
      <CTAButton text="Let Your Bot Watch" subtitle="Passive learning enabled" />
    </AbsoluteFill>
  );
};

// Main S12 composition — 17s
export const OpenclawSpectator: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-battle-royale.mp4" startFrom={5} tintOpacity={0.4} />
      <LiveBadge />
      <ParticleField count={22} color={ACCENT} speed={0.6} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="OpenClaw Spectator"
          subtitle="Your bot watches and learns too"
          accentColor={ACCENT}
        />
      </Sequence>

      {/* Scene 2: Bot Spectating (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BotSpectatingScene />
      </Sequence>

      {/* Scene 3: Battle Feed (5-10s) */}
      <Sequence from={5 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <BattleFeedScene />
      </Sequence>

      {/* Scene 4: Bot Knowledge (10-14s) */}
      <Sequence from={10 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BotKnowledgeScene />
      </Sequence>

      {/* Scene 5: CTA (14-17s) */}
      <Sequence from={14 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
