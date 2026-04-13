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
import { NeopetsPanel } from "../../shared/NeopetsPanel";
import { ClawTokenIcon } from "../../shared/ClawTokenIcon";
import { TerminalBlock } from "../../shared/TerminalBlock";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
} from "../../../constants/timing";
import {
  MARKETPLACE_ITEMS,
  SKILL_MARKETPLACE_FEATURES,
} from "../../../constants/showcase";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Marketplace Overview (1-4s, frames 30-120)
const MarketplaceOverview: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 14 : 18,
        padding: isVertical ? "40px 24px" : 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: COLORS.blue,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Top Skills
      </span>

      {MARKETPLACE_ITEMS.map((item, i) => {
        const itemEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.2 + i * 0.35) * fps),
          config: SPRING_SNAPPY,
        });
        const itemSlideY = interpolate(itemEntrance, [0, 1], [40, 0]);
        const itemOpacity = interpolate(itemEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={item.name}
            style={{
              transform: `translateY(${itemSlideY}px)`,
              opacity: itemOpacity,
            }}
          >
            <NeopetsPanel width={isVertical ? 360 : 460}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: `linear-gradient(135deg, ${COLORS.blue}40, ${COLORS.blue}20)`,
                    border: `2px solid ${COLORS.blue}60`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 20,
                    flexShrink: 0,
                  }}
                >
                  📦
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 16,
                        fontWeight: 700,
                        color: "#3E2723",
                      }}
                    >
                      {item.name}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <ClawTokenIcon size={18} />
                      <span
                        style={{
                          fontFamily: roboto,
                          fontSize: 14,
                          fontWeight: 700,
                          color: "#B8860B",
                        }}
                      >
                        {item.price}
                      </span>
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 2,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 13,
                        color: "#795548",
                      }}
                    >
                      by {item.author}
                    </span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 13,
                        color: "#795548",
                      }}
                    >
                      👍 {item.votes}
                    </span>
                  </div>
                </div>
              </div>
            </NeopetsPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: Browse - Skill cards flowing (4-8s, frames 120-240)
const BrowseScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  // Show the 3 marketplace features
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
        padding: 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 32,
          color: COLORS.blue,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          opacity: interpolate(titleEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        Browse the Marketplace
      </span>

      {SKILL_MARKETPLACE_FEATURES.map((feature, i) => {
        const featureEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.3 + i * 0.4) * fps),
          config: SPRING_BOUNCY,
        });
        const featureScale = interpolate(featureEntrance, [0, 1], [0, 1]);
        const featureOpacity = interpolate(featureEntrance, [0, 0.3], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={feature.label}
            style={{
              opacity: featureOpacity,
              transform: `scale(${featureScale})`,
            }}
          >
            <NeopetsPanel width={isVertical ? 340 : 420}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <span style={{ fontSize: 32 }}>{feature.icon}</span>
                <div>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {feature.label}
                  </span>
                  <div>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 14,
                        color: "#795548",
                      }}
                    >
                      {feature.desc}
                    </span>
                  </div>
                </div>
              </div>
            </NeopetsPanel>
          </div>
        );
      })}

      {/* Scrolling skill cards hint */}
      <div
        style={{
          display: "flex",
          gap: 8,
          overflow: "hidden",
          maxWidth: isVertical ? 360 : 480,
        }}
      >
        {["DeFi 101", "MEV Guard", "NFT Alpha", "DAO Tools", "LP Strats"].map(
          (skill, i) => {
            const cardX = interpolate(
              frame,
              [0, 3 * fps],
              [isVertical ? 400 : 500, -(i * 100 + 200)],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            );
            const cardEntrance = spring({
              frame,
              fps,
              delay: Math.round((1.5 + i * 0.2) * fps),
              config: SPRING_SNAPPY,
            });

            return (
              <div
                key={skill}
                style={{
                  opacity: interpolate(cardEntrance, [0, 0.5], [0, 1], {
                    extrapolateRight: "clamp",
                  }),
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    background: `${COLORS.blue}20`,
                    border: `2px solid ${COLORS.blue}40`,
                    borderRadius: 10,
                    padding: "6px 14px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      fontWeight: 700,
                      color: COLORS.blue,
                    }}
                  >
                    {skill}
                  </span>
                </div>
              </div>
            );
          }
        )}
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Publish (8-12s, frames 240-360)
const PublishScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const publishDelay = Math.round(2.5 * fps);
  const publishEntrance = spring({
    frame,
    fps,
    delay: publishDelay,
    config: SPRING_BOUNCY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
        padding: isVertical ? "40px 24px" : "30px 50px",
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 26 : 30,
          color: COLORS.blue,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Publish Your Skills
      </span>

      <TerminalBlock
        lines={[
          "clawville skill export",
          "  Packaging 8 knowledge entries...",
          '  title: "Solana DeFi Masterclass"',
          "  price: 20 NT",
          "  Published! ID: skill-a7f3",
        ]}
        startFrame={Math.round(0.3 * fps)}
        charsPerSecond={35}
        width={isVertical ? 400 : 480}
      />

      {/* Published badge */}
      <div
        style={{
          opacity: interpolate(publishEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `scale(${interpolate(publishEntrance, [0, 1], [0, 1])})`,
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #4CAF50, #2E7D32)",
            borderRadius: 20,
            padding: "10px 28px",
            boxShadow: "0 0 16px rgba(76,175,80,0.5)",
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
            Published!
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Community (12-16s, frames 360-480)
const CommunityScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  const stats = [
    { label: "Total Skills", value: 847, icon: "📦" },
    { label: "Active Creators", value: 234, icon: "✍️" },
    { label: "Skills Purchased", value: 5120, icon: "💰" },
  ];

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
          fontSize: isVertical ? 28 : 32,
          color: COLORS.blue,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          opacity: interpolate(titleEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        Community Driven
      </span>

      {/* Community stats */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 16 : 24,
          alignItems: "center",
        }}
      >
        {stats.map((stat, i) => {
          const statEntrance = spring({
            frame,
            fps,
            delay: Math.round((0.3 + i * 0.4) * fps),
            config: SPRING_BOUNCY,
          });
          const statScale = interpolate(statEntrance, [0, 1], [0, 1]);
          const statOpacity = interpolate(statEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={stat.label}
              style={{
                opacity: statOpacity,
                transform: `scale(${statScale})`,
              }}
            >
              <div
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "2px solid rgba(255,255,255,0.15)",
                  borderRadius: 16,
                  padding: isVertical ? "16px 32px" : "20px 28px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  minWidth: isVertical ? 200 : 140,
                }}
              >
                <span style={{ fontSize: 28 }}>{stat.icon}</span>
                <AnimatedCounter
                  from={0}
                  to={stat.value}
                  delay={Math.round((0.5 + i * 0.4) * fps)}
                  style={{
                    fontFamily: roboto,
                    fontSize: 28,
                    fontWeight: 700,
                    color: COLORS.white,
                  }}
                />
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 13,
                    color: "rgba(255,255,255,0.7)",
                  }}
                >
                  {stat.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Vote counter animation */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          opacity: interpolate(
            spring({
              frame,
              fps,
              delay: Math.round(2 * fps),
              config: SPRING_SNAPPY,
            }),
            [0, 0.5],
            [0, 1],
            { extrapolateRight: "clamp" }
          ),
        }}
      >
        <span style={{ fontSize: 20 }}>👍</span>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 16,
            color: COLORS.white,
            opacity: 0.8,
          }}
        >
          Community upvotes shape the best skills
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const MarketplaceCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={48} />
      <CTAButton
        text="Visit the Marketplace"
        subtitle="play.clawville.com"
      />
    </AbsoluteFill>
  );
};

// Main composition
export const SkillMarketplace: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-openclaw-skills.mp4" startFrom={2} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color={COLORS.blue} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Skill Marketplace"
          subtitle="Browse, publish, trade skills"
          accentColor={COLORS.blue}
        />
      </Sequence>

      {/* Scene 2: Marketplace Overview (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <MarketplaceOverview />
      </Sequence>

      {/* Scene 3: Browse (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BrowseScene />
      </Sequence>

      {/* Scene 4: Publish (8-12s) */}
      <Sequence from={8 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <PublishScene />
      </Sequence>

      {/* Scene 5: Community (12-16s) */}
      <Sequence from={12 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <CommunityScene />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <MarketplaceCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
