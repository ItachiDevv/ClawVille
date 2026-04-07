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

const ACCENT = "#00BCD4";

const KNOWLEDGE_PILLS = [
  { label: "MEV Protection", color: "#E91E63" },
  { label: "Sandwich Attack", color: "#9C27B0" },
  { label: "Flash Loan", color: "#FF9800" },
  { label: "Priority Fee", color: "#00BCD4" },
  { label: "Slippage Guard", color: "#4CAF50" },
  { label: "Jito Bundles", color: "#2196F3" },
];

const LEARNED_TOPICS = [
  { icon: "🛡️", label: "MEV Protection", desc: "Sandwich attack defense" },
  { icon: "⚡", label: "Flash Loans", desc: "Atomic arbitrage patterns" },
  { icon: "💰", label: "Fee Optimization", desc: "Priority fee strategies" },
  { icon: "🔗", label: "Jito Bundles", desc: "Transaction ordering" },
];

// Scene 2: Battle View (1-5s, frames 30-150)
const BattleViewScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const arenaEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });

  const eyeEntrance = spring({
    frame,
    fps,
    delay: 15,
    config: SPRING_SNAPPY,
  });

  const arenaScale = interpolate(arenaEntrance, [0, 1], [0.3, 1]);
  const eyeScale = interpolate(eyeEntrance, [0, 1], [0, 1]);
  const eyeOpacity = interpolate(eyeEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Pet attack animation
  const attackPhase = Math.floor((frame / fps) * 2) % 2;
  const leftPetX = attackPhase === 0 ? 15 : 0;
  const rightPetX = attackPhase === 1 ? -15 : 0;

  // Damage numbers appear on alternating beats
  const showDmg1 = frame > 20 && attackPhase === 0;
  const showDmg2 = frame > 35 && attackPhase === 1;

  const arenaW = isVertical ? width * 0.85 : width * 0.6;
  const arenaH = isVertical ? height * 0.45 : height * 0.55;

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center" }}
    >
      {/* Arena container */}
      <div
        style={{
          width: arenaW,
          height: arenaH,
          background:
            "radial-gradient(ellipse at center, rgba(0,188,212,0.15) 0%, transparent 70%)",
          border: `3px solid ${ACCENT}40`,
          borderRadius: 24,
          position: "relative",
          transform: `scale(${arenaScale})`,
          display: "flex",
          justifyContent: "space-around",
          alignItems: "center",
          padding: 20,
        }}
      >
        {/* Left fighter */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            transform: `translateX(${leftPetX}px)`,
          }}
        >
          <HPBar hp={75} maxHp={100} width={isVertical ? 100 : 140} label="DragonX" />
          <PetSprite species="dragon" size={isVertical ? 80 : 100} bob />
        </div>

        {/* VS badge */}
        <div
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 28 : 36,
            color: COLORS.gold,
            textShadow: "2px 2px 0px rgba(0,0,0,0.5), 0 0 15px rgba(255,215,0,0.4)",
          }}
        >
          VS
        </div>

        {/* Right fighter */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            transform: `translateX(${rightPetX}px)`,
          }}
        >
          <HPBar hp={60} maxHp={100} width={isVertical ? 100 : 140} label="PhoenixZ" />
          <PetSprite species="phoenix" size={isVertical ? 80 : 100} flipX bob />
        </div>

        {/* Damage numbers */}
        {showDmg1 && (
          <DamageNumber damage={12} x={arenaW * 0.65} y={arenaH * 0.3} delay={0} />
        )}
        {showDmg2 && (
          <DamageNumber damage={18} x={arenaW * 0.2} y={arenaH * 0.3} delay={0} isCritical />
        )}
      </div>

      {/* Spectator eye icon */}
      <div
        style={{
          position: "absolute",
          bottom: isVertical ? "18%" : "12%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          opacity: eyeOpacity,
          transform: `scale(${eyeScale})`,
        }}
      >
        <div
          style={{
            fontSize: isVertical ? 48 : 56,
            filter: `drop-shadow(0 0 10px ${ACCENT})`,
          }}
        >
          👁️
        </div>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 16,
            fontWeight: 700,
            color: ACCENT,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          SPECTATING LIVE
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Knowledge Stream (5-10s, frames 150-300)
const KnowledgeStreamScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const headerEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const headerOpacity = interpolate(headerEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Battle source on left, viewer on right
  const sourceX = isVertical ? width * 0.5 : width * 0.2;
  const sourceY = isVertical ? height * 0.2 : height * 0.45;
  const viewerX = isVertical ? width * 0.5 : width * 0.8;
  const viewerY = isVertical ? height * 0.75 : height * 0.45;

  return (
    <AbsoluteFill>
      {/* Header */}
      <div
        style={{
          position: "absolute",
          top: isVertical ? 30 : 20,
          width: "100%",
          textAlign: "center",
          opacity: headerOpacity,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 30 : 34,
            color: ACCENT,
            textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 15px ${ACCENT}40`,
          }}
        >
          Knowledge Flows to You
        </span>
      </div>

      {/* Battle source icon */}
      <div
        style={{
          position: "absolute",
          left: sourceX - 40,
          top: sourceY - 40,
          width: 80,
          height: 80,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${ACCENT}30 0%, transparent 70%)`,
          border: `2px solid ${ACCENT}60`,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontSize: 40,
        }}
      >
        ⚔️
      </div>

      {/* Viewer icon */}
      <div
        style={{
          position: "absolute",
          left: viewerX - 40,
          top: viewerY - 40,
          width: 80,
          height: 80,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.gold}30 0%, transparent 70%)`,
          border: `2px solid ${COLORS.gold}60`,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontSize: 40,
        }}
      >
        🧠
      </div>

      {/* Flowing knowledge pills */}
      {KNOWLEDGE_PILLS.map((pill, i) => {
        const startDelay = i * 18;
        const cycleDuration = fps * 2.5;
        const elapsed = Math.max(0, frame - startDelay);
        const cycleProgress = (elapsed % cycleDuration) / cycleDuration;
        const visible = frame >= startDelay;
        if (!visible) return null;

        // Interpolate pill position from source to viewer
        const pillX = interpolate(cycleProgress, [0, 1], [sourceX, viewerX]);
        const pillY =
          interpolate(cycleProgress, [0, 1], [sourceY, viewerY]) +
          Math.sin(cycleProgress * Math.PI * 3) * 20 * (i % 2 === 0 ? 1 : -1);
        const pillOpacity = interpolate(
          cycleProgress,
          [0, 0.1, 0.85, 1],
          [0, 1, 1, 0]
        );
        const pillScale = interpolate(
          cycleProgress,
          [0, 0.15, 0.85, 1],
          [0.5, 1, 1, 0.5]
        );

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: pillX - 60,
              top: pillY - 14,
              background: `${pill.color}DD`,
              borderRadius: 20,
              padding: "6px 16px",
              opacity: pillOpacity,
              transform: `scale(${pillScale})`,
              boxShadow: `0 0 12px ${pill.color}60`,
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 14,
                fontWeight: 700,
                color: COLORS.white,
                whiteSpace: "nowrap",
              }}
            >
              {pill.label}
            </span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: Stats Panel (10-14s, frames 300-420)
const StatsPanelScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const titleScale = interpolate(titleEntrance, [0, 1], [0.5, 1]);
  const titleOpacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 16,
        flexDirection: "column",
        padding: isVertical ? 30 : 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 36,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          transform: `scale(${titleScale})`,
          opacity: titleOpacity,
        }}
      >
        Learned from Watching
      </span>

      <ClawPanel width={isVertical ? 340 : 480}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {LEARNED_TOPICS.map((topic, i) => {
            const entrance = spring({
              frame,
              fps,
              delay: 10 + i * 8,
              config: SPRING_SNAPPY,
            });
            const slideX = interpolate(entrance, [0, 1], [200, 0]);
            const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
              extrapolateRight: "clamp",
            });

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  transform: `translateX(${slideX}px)`,
                  opacity,
                }}
              >
                <span style={{ fontSize: 28 }}>{topic.icon}</span>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {topic.label}
                  </span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
                      color: "#795548",
                    }}
                  >
                    {topic.desc}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </ClawPanel>
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
      <CTAButton text="Watch & Learn" subtitle="Spectate live battles" />
    </AbsoluteFill>
  );
};

// Main S10 composition — 17s
export const WatchAndLearn: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-overview-pan.mp4" startFrom={0} playbackRate={0.8} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={20} color={ACCENT} speed={0.8} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Watch & Learn"
          subtitle="Spectate battles, gain knowledge"
          accentColor={ACCENT}
        />
      </Sequence>

      {/* Scene 2: Battle View (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BattleViewScene />
      </Sequence>

      {/* Scene 3: Knowledge Stream (5-10s) */}
      <Sequence from={5 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <KnowledgeStreamScene />
      </Sequence>

      {/* Scene 4: Stats Panel (10-14s) */}
      <Sequence from={10 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <StatsPanelScene />
      </Sequence>

      {/* Scene 5: CTA (14-17s) */}
      <Sequence from={14 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
