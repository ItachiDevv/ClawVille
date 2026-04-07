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

const ACCENT = "#009688";

const GUIDE_STEPS = [
  { num: "1", label: "Find a Match", desc: "Browse live arena battles", icon: "🔍" },
  { num: "2", label: "Click Watch", desc: "Join as a spectator instantly", icon: "👁️" },
  { num: "3", label: "Learn", desc: "Absorb knowledge passively", icon: "🧠" },
];

const SPECTATOR_FEATURES = [
  { icon: "📊", label: "Live Stats", desc: "Real-time battle analytics" },
  { icon: "💡", label: "Strategy Tips", desc: "AI-detected move patterns" },
  { icon: "📚", label: "Auto-Learn", desc: "Knowledge gained automatically" },
  { icon: "🏆", label: "Leaderboard", desc: "Top spectator learners" },
];

const BENEFITS = [
  { icon: "🆓", label: "Free to Watch", color: "#4CAF50" },
  { icon: "🛡️", label: "No Risk", color: "#2196F3" },
  { icon: "✨", label: "Pure Learning", color: "#FF9800" },
];

// Scene 2: How to Spectate (1-4s, frames 30-120)
const HowToSpectateScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const titleScale = interpolate(titleEntrance, [0, 1], [0.5, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 24 : 20,
        padding: isVertical ? 30 : 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 32 : 38,
          color: ACCENT,
          textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 15px ${ACCENT}40`,
          transform: `scale(${titleScale})`,
        }}
      >
        How to Spectate
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 16 : 24,
          alignItems: "center",
        }}
      >
        {GUIDE_STEPS.map((step, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: 8 + i * 10,
            config: SPRING_SNAPPY,
          });
          const slideY = interpolate(entrance, [0, 1], [80, 0]);
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });
          const scale = interpolate(entrance, [0, 1], [0.7, 1]);

          return (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                transform: `translateY(${slideY}px) scale(${scale})`,
                opacity,
              }}
            >
              {/* Step number circle */}
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: "50%",
                  background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT}CC)`,
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  boxShadow: `0 0 15px ${ACCENT}60`,
                  border: "3px solid rgba(255,255,255,0.3)",
                }}
              >
                <span style={{ fontSize: 28 }}>{step.icon}</span>
              </div>

              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 20,
                  fontWeight: 700,
                  color: COLORS.white,
                  textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
                }}
              >
                {step.label}
              </span>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 14,
                  color: "rgba(255,255,255,0.7)",
                  textAlign: "center",
                }}
              >
                {step.desc}
              </span>

              {/* Arrow between steps */}
              {i < GUIDE_STEPS.length - 1 && !isVertical && (
                <div
                  style={{
                    position: "absolute",
                    right: -16,
                    top: "50%",
                    fontSize: 20,
                    color: ACCENT,
                    opacity: entrance,
                  }}
                >
                  {">"}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Battle Preview (4-8s, frames 120-240)
const BattlePreviewScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const entrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const scale = interpolate(entrance, [0, 1], [0.6, 1]);

  // Simulate battle action with avatar movement
  const battlePhase = (frame / fps) * 1.5;
  const leftShake = Math.sin(battlePhase * 8) * 4;
  const rightShake = Math.sin(battlePhase * 8 + Math.PI) * 4;

  // Pulsing spectator count
  const spectatorPulse = 1 + Math.sin((frame / fps) * 3) * 0.05;

  const arenaW = isVertical ? width * 0.9 : width * 0.65;
  const arenaH = isVertical ? height * 0.5 : height * 0.65;

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center" }}
    >
      <div
        style={{
          width: arenaW,
          height: arenaH,
          background:
            "linear-gradient(180deg, rgba(0,150,136,0.1) 0%, rgba(0,0,0,0.3) 100%)",
          border: `3px solid ${ACCENT}50`,
          borderRadius: 20,
          position: "relative",
          transform: `scale(${scale})`,
          overflow: "hidden",
        }}
      >
        {/* Arena header */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            padding: "8px 16px",
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: ACCENT,
            }}
          >
            LIVE BATTLE
          </span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              color: COLORS.gold,
              transform: `scale(${spectatorPulse})`,
              display: "inline-block",
            }}
          >
            👁️ 24 watching
          </span>
        </div>

        {/* Fighters */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-around",
            alignItems: "center",
            height: "100%",
            paddingTop: 30,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              transform: `translateX(${leftShake}px)`,
            }}
          >
            <PetSprite species="wolf" size={isVertical ? 72 : 90} bob />
            <HPBar hp={82} maxHp={100} width={isVertical ? 90 : 120} />
            <span
              style={{
                fontFamily: roboto,
                fontSize: 13,
                fontWeight: 700,
                color: COLORS.white,
              }}
            >
              CryptoWolf
            </span>
          </div>

          <div
            style={{
              fontFamily: lobster,
              fontSize: 28,
              color: COLORS.gold,
              textShadow: "2px 2px 0px rgba(0,0,0,0.5)",
            }}
          >
            VS
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              transform: `translateX(${rightShake}px)`,
            }}
          >
            <PetSprite species="fox" size={isVertical ? 72 : 90} flipX bob />
            <HPBar hp={65} maxHp={100} width={isVertical ? 90 : 120} />
            <span
              style={{
                fontFamily: roboto,
                fontSize: 13,
                fontWeight: 700,
                color: COLORS.white,
              }}
            >
              AlphaFox
            </span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Features List (8-12s, frames 240-360)
const FeaturesListScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 14,
        padding: isVertical ? 30 : 50,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: ACCENT,
          textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 12px ${ACCENT}40`,
          marginBottom: 8,
        }}
      >
        Spectator Features
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: isVertical ? 12 : 10,
          width: isVertical ? "90%" : "60%",
        }}
      >
        {SPECTATOR_FEATURES.map((feat, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 10,
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

          return (
            <div
              key={i}
              style={{
                transform: `translateX(${slideX}px)`,
                opacity,
              }}
            >
              <ClawPanel>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                  }}
                >
                  <span style={{ fontSize: 30 }}>{feat.icon}</span>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 18,
                        fontWeight: 700,
                        color: "#3E2723",
                      }}
                    >
                      {feat.label}
                    </span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 14,
                        color: "#795548",
                      }}
                    >
                      {feat.desc}
                    </span>
                  </div>
                </div>
              </ClawPanel>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Benefits (12-16s, frames 360-480)
const BenefitsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 28 : 24,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 36,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          transform: `scale(${interpolate(titleEntrance, [0, 1], [0.5, 1])})`,
        }}
      >
        Why Spectate?
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 20 : 32,
          alignItems: "center",
        }}
      >
        {BENEFITS.map((b, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: 8 + i * 10,
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          // Gentle float
          const floatY = Math.sin((frame / fps) * 2 + i * 1.5) * 4;

          return (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                transform: `scale(${scale}) translateY(${floatY}px)`,
                opacity,
              }}
            >
              <div
                style={{
                  width: isVertical ? 80 : 90,
                  height: isVertical ? 80 : 90,
                  borderRadius: "50%",
                  background: `linear-gradient(135deg, ${b.color}30, ${b.color}10)`,
                  border: `3px solid ${b.color}`,
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  fontSize: isVertical ? 36 : 40,
                  boxShadow: `0 0 20px ${b.color}40`,
                }}
              >
                {b.icon}
              </div>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: isVertical ? 18 : 20,
                  fontWeight: 700,
                  color: COLORS.white,
                  textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
                }}
              >
                {b.label}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
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
      <CTAButton text="Start Watching" subtitle="Free spectator mode" />
    </AbsoluteFill>
  );
};

// Main S11 composition — 18s
export const SpectatorGuide: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-overview-pan.mp4" startFrom={3} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color={ACCENT} speed={0.7} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Spectator's Guide"
          subtitle="Everything you need to know about watching"
          accentColor={ACCENT}
        />
      </Sequence>

      {/* Scene 2: How to Spectate (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <HowToSpectateScene />
      </Sequence>

      {/* Scene 3: Battle Preview (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BattlePreviewScene />
      </Sequence>

      {/* Scene 4: Features List (8-12s) */}
      <Sequence from={8 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <FeaturesListScene />
      </Sequence>

      {/* Scene 5: Benefits (12-16s) */}
      <Sequence from={12 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BenefitsScene />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
