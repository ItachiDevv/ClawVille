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
import { TypewriterText } from "../../shared/TypewriterText";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { ParticleField } from "../../shared/ParticleField";
import { CTAButton } from "../../shared/CTAButton";
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

// Scene 2: Open Modal (1-4s, frames 30-120)
const OpenModal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Cursor moves to button
  const cursorProgress = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SMOOTH,
  });
  const cursorX = interpolate(cursorProgress, [0, 1], [width * 0.3, width * 0.5]);
  const cursorY = interpolate(cursorProgress, [0, 1], [height * 0.6, height * 0.45]);

  // Click ripple
  const clickFrame = Math.round(1 * fps);
  const clickProgress = spring({
    frame,
    fps,
    delay: clickFrame,
    config: SPRING_SNAPPY,
  });
  const rippleScale = interpolate(clickProgress, [0, 1], [0, 2]);
  const rippleOpacity = interpolate(clickProgress, [0, 1], [0.8, 0]);

  // Modal slides up
  const modalEntrance = spring({
    frame,
    fps,
    delay: Math.round(1.3 * fps),
    config: SPRING_BOUNCY,
  });
  const modalY = interpolate(modalEntrance, [0, 1], [400, 0]);
  const modalOpacity = interpolate(modalEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      {/* Connect button before click */}
      <div
        style={{
          position: "absolute",
          top: height * 0.35,
          opacity: interpolate(modalEntrance, [0, 0.5], [1, 0], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.green}, ${COLORS.greenDark})`,
            borderRadius: 30,
            padding: "14px 36px",
            boxShadow: "0 4px 12px rgba(76,175,80,0.4)",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 22,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            Connect OpenClaw
          </span>
        </div>
      </div>

      {/* Cursor indicator */}
      <div
        style={{
          position: "absolute",
          left: cursorX,
          top: cursorY,
          width: 20,
          height: 20,
          zIndex: 10,
          opacity: interpolate(modalEntrance, [0, 0.5], [1, 0], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "12px solid white",
            borderTop: "4px solid transparent",
            borderBottom: "16px solid transparent",
            filter: "drop-shadow(2px 2px 2px rgba(0,0,0,0.5))",
          }}
        />
        {/* Click ripple */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 30,
            height: 30,
            borderRadius: "50%",
            border: `2px solid ${COLORS.green}`,
            transform: `scale(${rippleScale})`,
            opacity: rippleOpacity,
          }}
        />
      </div>

      {/* Modal panel slides up */}
      <div
        style={{
          opacity: modalOpacity,
          transform: `translateY(${modalY}px)`,
        }}
      >
        <ClawPanel width={isVertical ? 400 : 480}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 28,
                color: "#3E2723",
              }}
            >
              Connect OpenClaw
            </span>
            <div
              style={{
                width: "100%",
                height: 44,
                background: "#fff",
                border: "2px solid #ccc",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                padding: "0 12px",
              }}
            >
              <span
                style={{
                  fontFamily: robotoMono,
                  fontSize: 15,
                  color: "#999",
                }}
              >
                Enter gateway URL...
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                justifyContent: "center",
              }}
            >
              {["DeFi", "MEV", "NFTs", "Trading"].map((skill) => (
                <div
                  key={skill}
                  style={{
                    background: "rgba(76,175,80,0.15)",
                    border: "1px solid rgba(76,175,80,0.3)",
                    borderRadius: 12,
                    padding: "4px 12px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      color: "#3E2723",
                    }}
                  >
                    {skill}
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

// Scene 3: Enter URL (4-7s, frames 120-210)
const EnterURL: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Checkmark pop
  const checkDelay = Math.round(2 * fps);
  const checkEntrance = spring({
    frame,
    fps,
    delay: checkDelay,
    config: SPRING_BOUNCY,
  });
  const checkScale = interpolate(checkEntrance, [0, 1], [0, 1]);
  const checkOpacity = interpolate(checkEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Glow on input field
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowSize = checkEntrance > 0.5 ? 4 + Math.sin(glowPhase) * 3 : 0;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      <ClawPanel width={isVertical ? 400 : 500}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 20,
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: 24,
              color: "#3E2723",
            }}
          >
            Gateway URL
          </span>

          {/* URL input field */}
          <div
            style={{
              width: "100%",
              height: 48,
              background: "#fff",
              border: `2px solid ${checkEntrance > 0.5 ? COLORS.green : "#ccc"}`,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              padding: "0 14px",
              boxShadow: `0 0 ${glowSize}px rgba(76,175,80,0.5)`,
              gap: 10,
            }}
          >
            <span style={{ fontSize: 16 }}>🔗</span>
            <TypewriterText
              text="openclaw.io/gateway"
              charsPerSecond={18}
              startFrame={5}
              style={{
                fontFamily: robotoMono,
                fontSize: 17,
                color: "#333",
              }}
            />
          </div>

          {/* Green checkmark */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              opacity: checkOpacity,
              transform: `scale(${checkScale})`,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: COLORS.green,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 2px 8px rgba(76,175,80,0.5)",
              }}
            >
              <span style={{ color: COLORS.white, fontSize: 20, fontWeight: 700 }}>
                {"\u2713"}
              </span>
            </div>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 18,
                fontWeight: 700,
                color: COLORS.green,
              }}
            >
              Valid Gateway
            </span>
          </div>
        </div>
      </ClawPanel>
    </AbsoluteFill>
  );
};

// Scene 4: Connected (7-11s, frames 210-330)
const Connected: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Green badge glow
  const badgeEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowIntensity = 8 + Math.sin(glowPhase) * 6;

  // Skill pills
  const skills = ["DeFi Basics", "Token Sniping", "MEV Protection", "NFT Minting", "Staking", "Governance"];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 24 : 20,
        padding: 40,
      }}
    >
      {/* Avatar + connected badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          transform: `scale(${badgeScale})`,
        }}
      >
        <PetSprite species="fox" size={isVertical ? 100 : 90} enterDelay={0} bob />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 24 }}>🔌</span>
            <div
              style={{
                background: "rgba(76,175,80,0.9)",
                borderRadius: 20,
                padding: "6px 18px",
                boxShadow: `0 0 ${glowIntensity}px rgba(76,175,80,0.6)`,
              }}
            >
              <span
                style={{
                  fontFamily: robotoMono,
                  fontSize: 15,
                  fontWeight: 700,
                  color: COLORS.white,
                }}
              >
                Connected
              </span>
            </div>
          </div>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            openclaw.io/gateway
          </span>
        </div>
      </div>

      {/* Skill pill badges */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          justifyContent: "center",
          maxWidth: isVertical ? 380 : 500,
        }}
      >
        {skills.map((skill, i) => {
          const pillEntrance = spring({
            frame,
            fps,
            delay: Math.round((1 + i * 0.3) * fps),
            config: SPRING_BOUNCY,
          });
          const pillScale = interpolate(pillEntrance, [0, 1], [0, 1]);
          const pillOpacity = interpolate(pillEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={skill}
              style={{
                opacity: pillOpacity,
                transform: `scale(${pillScale})`,
              }}
            >
              <div
                style={{
                  background: `linear-gradient(135deg, ${COLORS.gold}, #FFA000)`,
                  borderRadius: 20,
                  padding: "6px 16px",
                  boxShadow: "2px 2px 4px rgba(0,0,0,0.3)",
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#3E2723",
                  }}
                >
                  {skill}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Timer (11-13s, frames 330-390)
const TimerScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const entrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const scale = interpolate(entrance, [0, 1], [0.5, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 32 : 36,
          color: COLORS.white,
          textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
          transform: `scale(${scale})`,
        }}
      >
        Total time:
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          transform: `scale(${scale})`,
        }}
      >
        <AnimatedCounter
          from={0}
          to={30}
          delay={10}
          style={{
            fontFamily: robotoMono,
            fontSize: isVertical ? 72 : 80,
            fontWeight: 700,
            color: COLORS.green,
            textShadow: `0 0 20px rgba(76,175,80,0.5)`,
          }}
        />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 28,
            color: "rgba(255,255,255,0.8)",
          }}
        >
          seconds
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (13-15s, frames 390-450)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <CTAButton text="Connect Now" subtitle="openclaw.io/register" />
    </AbsoluteFill>
  );
};

// Main S17 composition
export const Connect30Seconds: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-openclaw-connect.mp4" startFrom={2} tintOpacity={0.4} />
      <LiveBadge />
      <ParticleField count={20} color={COLORS.green} speed={0.6} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Connect OpenClaw in 30 Seconds"
          subtitle="Quick, easy, powerful"
          accentColor={COLORS.green}
        />
      </Sequence>

      {/* Scene 2: Open Modal (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <OpenModal />
      </Sequence>

      {/* Scene 3: Enter URL (4-7s) */}
      <Sequence from={4 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <EnterURL />
      </Sequence>

      {/* Scene 4: Connected (7-11s) */}
      <Sequence from={7 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Connected />
      </Sequence>

      {/* Scene 5: Timer (11-13s) */}
      <Sequence from={11 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <TimerScene />
      </Sequence>

      {/* Scene 6: CTA (13-15s) */}
      <Sequence from={13 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
