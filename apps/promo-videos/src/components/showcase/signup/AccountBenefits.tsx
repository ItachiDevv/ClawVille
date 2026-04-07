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
import { ClawPanel } from "../../shared/ClawPanel";
import { ParticleField } from "../../shared/ParticleField";
import { CTAButton } from "../../shared/CTAButton";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import { ACCOUNT_BENEFITS } from "../../../constants/showcase";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
} from "../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Without Account (1-4s, frames 30-120)
const WithoutAccount: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const panelEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const panelOpacity = interpolate(panelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const panelScale = interpolate(panelEntrance, [0, 1], [0.9, 1]);

  const limitedFeatures = [
    { label: "Save Progress", locked: true },
    { label: "Earn ClawTokens", locked: true },
    { label: "Publish Skills", locked: true },
    { label: "Marketplace", locked: true },
    { label: "Daily Rewards", locked: true },
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 16,
        padding: 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 28,
          color: "rgba(255,255,255,0.5)",
          textShadow: "1px 1px 3px rgba(0,0,0,0.3)",
        }}
      >
        Without an Account
      </span>

      <div
        style={{
          opacity: panelOpacity,
          transform: `scale(${panelScale})`,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            alignItems: "center",
          }}
        >
          {limitedFeatures.map((feat, i) => {
            const featEntrance = spring({
              frame,
              fps,
              delay: Math.round((0.3 + i * 0.25) * fps),
              config: SPRING_SNAPPY,
            });
            const featOpacity = interpolate(featEntrance, [0, 0.5], [0, 1], {
              extrapolateRight: "clamp",
            });

            return (
              <div
                key={feat.label}
                style={{
                  opacity: featOpacity,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: isVertical ? 300 : 340,
                }}
              >
                <div
                  style={{
                    width: isVertical ? 300 : 340,
                    padding: "10px 16px",
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 16,
                      color: "rgba(255,255,255,0.35)",
                      textDecoration: "line-through",
                    }}
                  >
                    {feat.label}
                  </span>
                  <span style={{ fontSize: 18 }}>🔒</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: With Account (4-9s, frames 120-270)
const WithAccount: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 14 : 12,
        padding: isVertical ? "40px 30px" : "40px 60px",
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 30,
          color: "#CE93D8",
          textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
          marginBottom: 4,
        }}
      >
        With an Account
      </span>

      {ACCOUNT_BENEFITS.map((benefit, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: Math.round(i * 0.5 * fps),
          config: SPRING_BOUNCY,
        });
        const scale = interpolate(entrance, [0, 1], [0, 1]);
        const opacity = interpolate(entrance, [0, 0.3], [0, 1], {
          extrapolateRight: "clamp",
        });
        const slideY = interpolate(entrance, [0, 1], [30, 0]);

        return (
          <div
            key={benefit.label}
            style={{
              transform: `scale(${scale}) translateY(${slideY}px)`,
              opacity,
            }}
          >
            <ClawPanel width={isVertical ? 360 : 440}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <span style={{ fontSize: 26 }}>{benefit.emoji}</span>
                <div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 17,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {benefit.label}
                  </div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      color: "#795548",
                    }}
                  >
                    {benefit.desc}
                  </div>
                </div>
              </div>
            </ClawPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: Comparison (9-13s, frames 270-390)
const Comparison: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const leftEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const leftSlideX = interpolate(leftEntrance, [0, 1], [-200, 0]);
  const leftOpacity = interpolate(leftEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const rightEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.4 * fps),
    config: SPRING_SNAPPY,
  });
  const rightSlideX = interpolate(rightEntrance, [0, 1], [200, 0]);
  const rightOpacity = interpolate(rightEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // "VS" badge
  const vsEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.8 * fps),
    config: SPRING_BOUNCY,
  });
  const vsScale = interpolate(vsEntrance, [0, 1], [0, 1]);

  const panelWidth = isVertical ? 180 : 220;

  const freeFeatures = [
    { label: "Explore Map", available: true },
    { label: "Chat with NPCs", available: true },
    { label: "Save Progress", available: false },
    { label: "Earn Tokens", available: false },
    { label: "Publish Skills", available: false },
  ];

  const accountFeatures = [
    { label: "Explore Map", available: true },
    { label: "Chat with NPCs", available: true },
    { label: "Save Progress", available: true },
    { label: "Earn Tokens", available: true },
    { label: "Publish Skills", available: true },
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: isVertical ? "column" : "row",
        gap: isVertical ? 16 : 24,
        padding: isVertical ? "30px 20px" : "40px 40px",
      }}
    >
      {/* Free tier */}
      <div
        style={{
          transform: `translateX(${leftSlideX}px)`,
          opacity: leftOpacity,
        }}
      >
        <ClawPanel
          width={panelWidth}
          style={{ background: "rgba(255,224,102,0.6)" }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 20,
                color: "#3E2723",
              }}
            >
              Free
            </span>
            {freeFeatures.map((f) => (
              <div
                key={f.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                }}
              >
                <span style={{ fontSize: 14 }}>
                  {f.available ? "\u2705" : "\u274C"}
                </span>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 12,
                    color: f.available ? "#3E2723" : "#999",
                    textDecoration: f.available ? "none" : "line-through",
                  }}
                >
                  {f.label}
                </span>
              </div>
            ))}
          </div>
        </ClawPanel>
      </div>

      {/* VS badge */}
      <div
        style={{
          transform: `scale(${vsScale})`,
          zIndex: 2,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: `linear-gradient(135deg, #9C27B0, #7B1FA2)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 12px rgba(156,39,176,0.5)",
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
            VS
          </span>
        </div>
      </div>

      {/* Account tier */}
      <div
        style={{
          transform: `translateX(${rightSlideX}px)`,
          opacity: rightOpacity,
        }}
      >
        <ClawPanel width={panelWidth}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 20,
                color: "#3E2723",
              }}
            >
              Account
            </span>
            {accountFeatures.map((f) => (
              <div
                key={f.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                }}
              >
                <span style={{ fontSize: 14 }}>{"\u2705"}</span>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 12,
                    color: "#3E2723",
                  }}
                >
                  {f.label}
                </span>
              </div>
            ))}
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (13-16s, frames 390-480)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <CTAButton text="Sign Up Free" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S22 composition
export const AccountBenefits: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-menu-skills-inventory.mp4" startFrom={0} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color="#CE93D8" speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Account Benefits"
          subtitle="Why create an account?"
          accentColor="#9C27B0"
        />
      </Sequence>

      {/* Scene 2: Without Account (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <WithoutAccount />
      </Sequence>

      {/* Scene 3: With Account (4-9s) */}
      <Sequence from={4 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <WithAccount />
      </Sequence>

      {/* Scene 4: Comparison (9-13s) */}
      <Sequence from={9 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Comparison />
      </Sequence>

      {/* Scene 5: CTA (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
