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
import { RecordingBackground, LiveBadge } from "../../shared/RecordingBackground";
import { ParticleField } from "../../shared/ParticleField";
import { ClawPanel } from "../../shared/ClawPanel";
import { PetSprite } from "../../shared/PetSprite";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { StatBar } from "../../shared/StatBar";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
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

// Scene 2: New Player - Empty Profile (1-4s, frames 30-120)
const NewPlayer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const profileEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const profileScale = interpolate(profileEntrance, [0, 1], [0.8, 1]);
  const profileOpacity = interpolate(profileEntrance, [0, 0.5], [0, 1], {
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
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 34,
          color: COLORS.panel,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Day 1: A Fresh Start
      </span>

      <div
        style={{
          opacity: profileOpacity,
          transform: `scale(${profileScale})`,
        }}
      >
        <ClawPanel width={isVertical ? 340 : 400}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              alignItems: "center",
            }}
          >
            <PetSprite species="bunny" size={80} enterDelay={10} bob />
            <span
              style={{
                fontFamily: roboto,
                fontSize: 20,
                fontWeight: 700,
                color: "#3E2723",
              }}
            >
              New Player
            </span>
            <div
              style={{
                display: "flex",
                gap: 20,
                flexWrap: "wrap",
                justifyContent: "center",
              }}
            >
              {[
                { label: "Level", value: "0" },
                { label: "Skills", value: "0" },
                { label: "Tokens", value: "100" },
              ].map((stat) => (
                <div
                  key={stat.label}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
                      color: "#795548",
                    }}
                  >
                    {stat.label}
                  </span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 22,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {stat.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: First Steps (4-7s, frames 120-210)
const FirstSteps: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const worldEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SMOOTH,
  });

  // Pet walks into world
  const petX = interpolate(worldEntrance, [0, 1], [-200, 0]);
  const petOpacity = interpolate(worldEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // First chat bubble
  const chatEntrance = spring({
    frame,
    fps,
    delay: Math.round(1.5 * fps),
    config: SPRING_SNAPPY,
  });
  const chatOpacity = interpolate(chatEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const chatSlideY = interpolate(chatEntrance, [0, 1], [20, 0]);

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
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 32,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Entering The Depths
      </span>

      <div
        style={{
          transform: `translateX(${petX}px)`,
          opacity: petOpacity,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <PetSprite species="bunny" size={isVertical ? 90 : 80} enterDelay={0} bob />

        <div
          style={{
            opacity: chatOpacity,
            transform: `translateY(${chatSlideY}px)`,
          }}
        >
          <div
            style={{
              background: "rgba(255,255,255,0.95)",
              borderRadius: 16,
              padding: "10px 18px",
              boxShadow: "2px 2px 8px rgba(0,0,0,0.15)",
              maxWidth: isVertical ? 240 : 300,
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 16,
                color: "#333",
                lineHeight: 1.4,
              }}
            >
              Hi! I'm your new pet. Let's explore!
            </span>
          </div>
        </div>
      </div>

      {/* Map indicator */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {["📚", "🧪", "🎨", "💻", "🏪"].map((icon, i) => {
          const iconEntrance = spring({
            frame,
            fps,
            delay: Math.round((1 + i * 0.3) * fps),
            config: SPRING_BOUNCY,
          });
          return (
            <div
              key={i}
              style={{
                fontSize: 28,
                opacity: interpolate(iconEntrance, [0, 0.5], [0, 1], {
                  extrapolateRight: "clamp",
                }),
                transform: `scale(${interpolate(iconEntrance, [0, 1], [0, 1])})`,
              }}
            >
              {icon}
            </div>
          );
        })}
        <span
          style={{
            fontFamily: roboto,
            fontSize: 14,
            color: COLORS.white,
            opacity: 0.7,
          }}
        >
          15 buildings
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Growing (7-11s, frames 210-330)
const Growing: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 20 : 24,
        padding: 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 34,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          opacity: interpolate(titleEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        Watch Your Lobster Grow
      </span>

      {/* Animated stat bars */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          width: isVertical ? 340 : 400,
        }}
      >
        <StatBar
          label="Skills"
          value={0.53}
          color="#4CAF50"
          width={isVertical ? 220 : 280}
          delay={Math.round(0.3 * fps)}
        />
        <StatBar
          label="Knowledge"
          value={0.7}
          color="#2196F3"
          width={isVertical ? 220 : 280}
          delay={Math.round(0.6 * fps)}
        />
        <StatBar
          label="Tokens"
          value={0.45}
          color={COLORS.gold}
          width={isVertical ? 220 : 280}
          delay={Math.round(0.9 * fps)}
        />
      </div>

      {/* Counter stats */}
      <div
        style={{
          display: "flex",
          gap: isVertical ? 24 : 40,
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <AnimatedCounter
            from={0}
            to={8}
            delay={Math.round(1.2 * fps)}
            style={{
              fontFamily: roboto,
              fontSize: 40,
              fontWeight: 700,
              color: COLORS.green,
            }}
          />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              color: COLORS.white,
              opacity: 0.8,
            }}
          >
            Skills Learned
          </span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <AnimatedCounter
            from={0}
            to={200}
            delay={Math.round(1.5 * fps)}
            style={{
              fontFamily: roboto,
              fontSize: 40,
              fontWeight: 700,
              color: COLORS.gold,
            }}
          />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              color: COLORS.white,
              opacity: 0.8,
            }}
          >
            ClawTokens Earned
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Master (11-15s, frames 330-450)
const Master: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });

  const skills = [
    "DeFi Basics",
    "Token Analysis",
    "LP Strategies",
    "On-Chain Data",
    "Smart Contracts",
    "MEV Protection",
    "NFT Trading",
    "Governance",
  ];

  // Published badge
  const publishEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.5 * fps),
    config: SPRING_BOUNCY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
        padding: isVertical ? "40px 24px" : 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 36,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          opacity: interpolate(titleEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `scale(${interpolate(titleEntrance, [0, 1], [0.8, 1])})`,
        }}
      >
        Skill Master
      </span>

      {/* Skill grid */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
          maxWidth: isVertical ? 380 : 500,
        }}
      >
        {skills.map((skill, i) => {
          const skillEntrance = spring({
            frame,
            fps,
            delay: Math.round((0.3 + i * 0.15) * fps),
            config: SPRING_SNAPPY,
          });
          const skillScale = interpolate(skillEntrance, [0, 1], [0, 1]);
          const skillOpacity = interpolate(skillEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={skill}
              style={{
                opacity: skillOpacity,
                transform: `scale(${skillScale})`,
              }}
            >
              <div
                style={{
                  background: `linear-gradient(135deg, ${COLORS.gold}30, ${COLORS.gold}10)`,
                  border: `2px solid ${COLORS.gold}60`,
                  borderRadius: 12,
                  padding: "6px 14px",
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 14,
                    fontWeight: 700,
                    color: COLORS.gold,
                  }}
                >
                  {skill}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Marketplace publish */}
      <div
        style={{
          opacity: interpolate(publishEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `scale(${interpolate(publishEntrance, [0, 1], [0, 1])})`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #4CAF50, #2E7D32)",
            borderRadius: 20,
            padding: "8px 20px",
            boxShadow: "0 0 16px rgba(76,175,80,0.5)",
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
            📤 Published to Marketplace
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (15-18s, frames 450-540)
const MasterCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={52} />
      <CTAButton text="Begin Your Journey" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main composition
export const NewPlayerToMaster: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-explore-buildings.mp4" startFrom={5} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color={COLORS.blue} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="New Player to Skill Master"
          subtitle="The complete journey"
          accentColor={COLORS.blue}
        />
      </Sequence>

      {/* Scene 2: New Player (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <NewPlayer />
      </Sequence>

      {/* Scene 3: First Steps (4-7s) */}
      <Sequence from={4 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <FirstSteps />
      </Sequence>

      {/* Scene 4: Growing (7-11s) */}
      <Sequence from={7 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Growing />
      </Sequence>

      {/* Scene 5: Master (11-15s) */}
      <Sequence from={11 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Master />
      </Sequence>

      {/* Scene 6: CTA (15-18s) */}
      <Sequence from={15 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <MasterCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
