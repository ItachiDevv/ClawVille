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
import { SpeechBubble } from "../../../shared/SpeechBubble";
import { BookIcon } from "../../../shared/BookIcon";
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

// Scene 2: Connect Command (1-4s, frames 30-120)
const ConnectScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const terminalEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });

  const terminalScale = interpolate(terminalEntrance, [0, 1], [0.6, 1]);
  const terminalOpacity = interpolate(terminalEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Green checkmark appears after typing finishes (~1.5s)
  const checkDelay = Math.round(fps * 1.5);
  const checkEntrance = spring({
    frame,
    fps,
    delay: checkDelay,
    config: SPRING_BOUNCY,
  });

  const checkScale = interpolate(checkEntrance, [0, 1], [0, 1.3]);
  const checkOpacity = interpolate(checkEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 24 }}
    >
      <div
        style={{
          transform: `scale(${terminalScale})`,
          opacity: terminalOpacity,
        }}
      >
        <TerminalBlock
          lines={[
            "openclaw connect --world",
            "Connecting to ClawVille...",
            "Bot linked successfully!",
          ]}
          charsPerSecond={35}
          width={isVertical ? 340 : 460}
        />
      </div>

      {/* Green checkmark */}
      <div
        style={{
          transform: `scale(${checkScale})`,
          opacity: checkOpacity,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: COLORS.green,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: `0 0 20px ${COLORS.green}80`,
            fontSize: 28,
            color: COLORS.white,
            fontWeight: 700,
          }}
        >
          ✓
        </div>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 22,
            fontWeight: 700,
            color: COLORS.green,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Connected
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Enter World (4-8s, frames 120-240)
const EnterWorldScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Avatar walks from left to center
  const walkProgress = spring({
    frame,
    fps,
    config: SPRING_SMOOTH,
    durationInFrames: 2 * fps,
  });

  const avatarX = interpolate(
    walkProgress,
    [0, 1],
    [isVertical ? -100 : -150, isVertical ? width * 0.5 - 60 : width * 0.5 - 80]
  );

  // "Connected" badge glows
  const badgeEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 1.5),
    config: SPRING_BOUNCY,
  });

  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowIntensity = 8 + Math.sin(glowPhase) * 6;

  return (
    <AbsoluteFill>
      <MapBackground zoom={1.6} tintColor="#000" tintOpacity={0.2} panXRange={[-0.1, 0.1]} />

      {/* Avatar sprite walking */}
      <div
        style={{
          position: "absolute",
          left: avatarX,
          top: height * 0.5 - 60,
        }}
      >
        <PetSprite species="fox" size={isVertical ? 100 : 120} bob />
      </div>

      {/* Connected badge */}
      <div
        style={{
          position: "absolute",
          left: avatarX + (isVertical ? 30 : 40),
          top: height * 0.5 - (isVertical ? 100 : 110),
          transform: `scale(${badgeScale})`,
        }}
      >
        <div
          style={{
            background: COLORS.green,
            borderRadius: 20,
            padding: "6px 16px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            boxShadow: `0 0 ${glowIntensity}px ${COLORS.green}80`,
          }}
        >
          <span style={{ fontSize: 14 }}>🔌</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            Connected
          </span>
        </div>
      </div>

      {/* Scene label */}
      <div
        style={{
          position: "absolute",
          bottom: isVertical ? 60 : 40,
          left: 0,
          right: 0,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 32 : 36,
            color: COLORS.gold,
            textShadow: "2px 2px 0px rgba(0,0,0,0.5)",
          }}
        >
          Entering the World
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Building Visit (8-12s, frames 240-360)
const BuildingVisitScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Building zooms in
  const buildingEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });

  const buildingScale = interpolate(buildingEntrance, [0, 1], [0.3, 1]);
  const buildingOpacity = interpolate(buildingEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // NPC appears with speech
  const npcDelay = Math.round(fps * 0.8);
  const npcEntrance = spring({
    frame,
    fps,
    delay: npcDelay,
    config: SPRING_BOUNCY,
  });
  const npcScale = interpolate(npcEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: "linear-gradient(180deg, #1a0a2e 0%, #2d1b4e 100%)",
      }}
    >
      {/* Building icon */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          alignItems: "center",
          gap: isVertical ? 24 : 40,
          transform: `scale(${buildingScale})`,
          opacity: buildingOpacity,
        }}
      >
        <div
          style={{
            width: isVertical ? 120 : 140,
            height: isVertical ? 140 : 160,
            background: `linear-gradient(180deg, ${COLORS.panel}, ${COLORS.panelBorder})`,
            borderRadius: 16,
            border: `4px solid ${COLORS.panelBorder}`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            boxShadow: "4px 4px 0px rgba(0,0,0,0.3)",
          }}
        >
          <span style={{ fontSize: 48 }}>🧪</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: "#3E2723",
            }}
          >
            Alpha Lab
          </span>
        </div>

        {/* NPC + Speech */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            transform: `scale(${npcScale})`,
          }}
        >
          <PetSprite species="owl" size={80} enterDelay={npcDelay} bob />
          <SpeechBubble
            text="Welcome! Let me teach you about token sniping strategies..."
            delay={npcDelay + 10}
            maxWidth={isVertical ? 260 : 280}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Knowledge Gained (12-16s, frames 360-480)
const KnowledgeGainedScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const knowledgeItems = [
    { icon: "🧪", name: "Token Sniping", price: 15 },
    { icon: "📊", name: "Jupiter Routing", price: 20 },
    { icon: "🐋", name: "Wallet Tracking", price: 25 },
  ];

  // Title entrance
  const titleEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });

  const titleOpacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(titleEntrance, [0, 1], [30, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 28 : 24,
        flexDirection: "column",
      }}
    >
      {/* Title */}
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 36,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
        }}
      >
        Knowledge Gained!
      </span>

      {/* Knowledge pills */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 20 : 28,
          alignItems: "center",
        }}
      >
        {knowledgeItems.map((item, i) => (
          <BookIcon
            key={item.name}
            icon={item.icon}
            name={item.name}
            price={item.price}
            size={isVertical ? 70 : 80}
            delay={i * 10 + 8}
          />
        ))}
      </div>

      {/* +3 Skills label */}
      <div
        style={{
          opacity: interpolate(
            spring({
              frame,
              fps,
              delay: Math.round(fps * 1.5),
              config: SPRING_BOUNCY,
            }),
            [0, 1],
            [0, 1]
          ),
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 24,
            fontWeight: 700,
            color: COLORS.green,
            textShadow: `0 0 12px ${COLORS.green}60`,
          }}
        >
          +3 Skills Learned
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 24 }}
    >
      <LogoReveal size={56} />
      <CTAButton text="Connect & Explore" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S04 composition (18s)
export const OpenclawWorld: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-openclaw-connect.mp4" startFrom={0} tintOpacity={0.4} />
      <LiveBadge />
      <ParticleField count={20} color={COLORS.green} speed={0.8} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="OpenClaw in World Mode"
          subtitle="Connect your bot, explore, learn"
          accentColor={COLORS.green}
        />
      </Sequence>

      {/* Scene 2: Connect (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <ConnectScene />
      </Sequence>

      {/* Scene 3: Enter World (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <EnterWorldScene />
      </Sequence>

      {/* Scene 4: Building Visit (8-12s) */}
      <Sequence from={8 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BuildingVisitScene />
      </Sequence>

      {/* Scene 5: Knowledge Gained (12-16s) */}
      <Sequence from={12 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <KnowledgeGainedScene />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
