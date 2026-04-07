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
import { RecordingBackground, LiveBadge } from "../../shared/RecordingBackground";
import { ClawPanel } from "../../shared/ClawPanel";
import { PetSprite } from "../../shared/PetSprite";
import { TerminalBlock } from "../../shared/TerminalBlock";
import { ParticleField } from "../../shared/ParticleField";
import { CTAButton } from "../../shared/CTAButton";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
const { fontFamily: robotoMono } = loadRobotoMono("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

// Scene 2: Zero State (1-4s, frames 30-120)
const ZeroState: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const panelEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const panelScale = interpolate(panelEntrance, [0, 1], [0.8, 1]);
  const panelOpacity = interpolate(panelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // "No skills" label pulse
  const pulsePhase = (frame / fps) * 3;
  const labelOpacity = 0.5 + Math.sin(pulsePhase) * 0.2;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      <div
        style={{
          opacity: panelOpacity,
          transform: `scale(${panelScale})`,
        }}
      >
        <ClawPanel width={isVertical ? 360 : 420}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
            }}
          >
            <PetSprite species="owl" size={80} enterDelay={10} bob />
            <span
              style={{
                fontFamily: lobster,
                fontSize: 22,
                color: "#3E2723",
              }}
            >
              CryptoOwl
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 20 }}>📚</span>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  color: "#795548",
                }}
              >
                Skills: 0
              </span>
            </div>
            <div
              style={{
                background: "rgba(0,0,0,0.08)",
                borderRadius: 8,
                padding: "8px 20px",
                opacity: labelOpacity,
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 14,
                  color: "#999",
                  fontStyle: "italic",
                }}
              >
                No skills yet...
              </span>
            </div>
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Connect (4-7s, frames 120-210)
const ConnectScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // "Connected!" badge
  const badgeDelay = Math.round(2 * fps);
  const badgeEntrance = spring({
    frame,
    fps,
    delay: badgeDelay,
    config: SPRING_BOUNCY,
  });
  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);
  const badgeOpacity = interpolate(badgeEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowIntensity = badgeEntrance > 0.5 ? 6 + Math.sin(glowPhase) * 4 : 0;

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
      <TerminalBlock
        lines={[
          "POST /api/openclaw/register",
          '  mode: "avatar"',
          '  gateway: "openclaw.io"',
          "  -> 200 OK  session: oc-9x2f",
        ]}
        startFrame={5}
        charsPerSecond={35}
        width={isVertical ? 400 : 480}
      />

      <div
        style={{
          opacity: badgeOpacity,
          transform: `scale(${badgeScale})`,
        }}
      >
        <div
          style={{
            background: "rgba(76,175,80,0.9)",
            borderRadius: 24,
            padding: "10px 28px",
            boxShadow: `0 0 ${glowIntensity}px rgba(76,175,80,0.6)`,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 20,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            {"\u2713"} Connected!
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Learn (7-12s, frames 210-360)
const LearnScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const buildings = [
    { emoji: "🏦", name: "Token Bank", skill: "DeFi Lending" },
    { emoji: "🧪", name: "Alpha Lab", skill: "MEV Protection" },
    { emoji: "🏪", name: "NFT Bazaar", skill: "NFT Minting" },
  ];

  const pillsAccumulated: string[] = [];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
        padding: isVertical ? "40px 30px" : "40px 60px",
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 28,
          color: COLORS.gold,
          textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
        }}
      >
        Visit Buildings. Learn Skills.
      </span>

      {/* Buildings visited rapidly */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: 12,
          alignItems: "center",
        }}
      >
        {buildings.map((b, i) => {
          const buildingDelay = Math.round(i * 1.2 * fps);
          const buildingEntrance = spring({
            frame,
            fps,
            delay: buildingDelay,
            config: SPRING_SNAPPY,
          });
          const buildingOpacity = interpolate(buildingEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });
          const slideX = interpolate(buildingEntrance, [0, 1], [i % 2 === 0 ? -80 : 80, 0]);

          // Knowledge pill appears after building
          const pillDelay = buildingDelay + Math.round(0.6 * fps);
          const pillEntrance = spring({
            frame,
            fps,
            delay: pillDelay,
            config: SPRING_BOUNCY,
          });
          const pillScale = interpolate(pillEntrance, [0, 1], [0, 1]);

          if (pillEntrance > 0) {
            pillsAccumulated.push(b.skill);
          }

          return (
            <div
              key={b.name}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                opacity: buildingOpacity,
                transform: `translateX(${slideX}px)`,
              }}
            >
              <ClawPanel width={isVertical ? 280 : 160}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span style={{ fontSize: 28 }}>{b.emoji}</span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#3E2723",
                      textAlign: "center",
                    }}
                  >
                    {b.name}
                  </span>
                </div>
              </ClawPanel>
              <div
                style={{
                  transform: `scale(${pillScale})`,
                }}
              >
                <div
                  style={{
                    background: `linear-gradient(135deg, ${COLORS.gold}, #FFA000)`,
                    borderRadius: 16,
                    padding: "4px 14px",
                    boxShadow: "1px 1px 4px rgba(0,0,0,0.3)",
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    +{b.skill}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Export (12-17s, frames 360-510)
const ExportScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // "Published!" badge
  const publishDelay = Math.round(3 * fps);
  const publishEntrance = spring({
    frame,
    fps,
    delay: publishDelay,
    config: SPRING_BOUNCY,
  });
  const publishScale = interpolate(publishEntrance, [0, 1], [0, 1]);
  const publishOpacity = interpolate(publishEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

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
      <TerminalBlock
        lines={[
          "GET /api/openclaw/knowledge-export/owl-1",
          "  format: SKILL.md",
          "  skills: 3",
          "  ---",
          "  # CryptoOwl Skills",
          "  ## DeFi Lending",
          "  ## MEV Protection",
          "  ## NFT Minting",
        ]}
        startFrame={5}
        charsPerSecond={40}
        width={isVertical ? 400 : 500}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        {/* Published badge */}
        <div
          style={{
            opacity: publishOpacity,
            transform: `scale(${publishScale})`,
          }}
        >
          <div
            style={{
              background: "rgba(33,150,243,0.9)",
              borderRadius: 24,
              padding: "10px 24px",
              boxShadow: "0 0 12px rgba(33,150,243,0.5)",
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 18,
                fontWeight: 700,
                color: COLORS.white,
              }}
            >
              {"\u2728"} Published!
            </span>
          </div>
        </div>

        {/* Vote counter */}
        <div
          style={{
            opacity: publishOpacity,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 20 }}>👍</span>
          <AnimatedCounter
            from={0}
            to={47}
            delay={publishDelay + Math.round(0.5 * fps)}
            style={{
              fontFamily: robotoMono,
              fontSize: 22,
              fontWeight: 700,
              color: COLORS.gold,
              textShadow: "0 0 8px rgba(255,215,0,0.4)",
            }}
          />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            votes
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (17-20s, frames 510-600)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <CTAButton text="Start from Zero" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S18 composition
export const ZeroToSkill: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-openclaw-skills.mp4" startFrom={0} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color={COLORS.gold} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="From Zero to Skill"
          subtitle="Connect, learn, export, publish"
          accentColor={COLORS.gold}
        />
      </Sequence>

      {/* Scene 2: Zero State (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <ZeroState />
      </Sequence>

      {/* Scene 3: Connect (4-7s) */}
      <Sequence from={4 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <ConnectScene />
      </Sequence>

      {/* Scene 4: Learn (7-12s) */}
      <Sequence from={7 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <LearnScene />
      </Sequence>

      {/* Scene 5: Export (12-17s) */}
      <Sequence from={12 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <ExportScene />
      </Sequence>

      {/* Scene 6: CTA (17-20s) */}
      <Sequence from={17 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
