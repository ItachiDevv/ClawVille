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
import { PetSprite } from "../../shared/PetSprite";
import { ParticleField } from "../../shared/ParticleField";
import { CTAButton } from "../../shared/CTAButton";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import { ANON_BENEFITS } from "../../../constants/showcase";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
} from "../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Privacy Shield (1-4s, frames 30-120)
const PrivacyShield: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Lock icon entrance
  const lockEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const lockScale = interpolate(lockEntrance, [0, 1], [0, 1]);

  // Shield ring animation
  const shieldDelay = Math.round(0.6 * fps);
  const shieldEntrance = spring({
    frame,
    fps,
    delay: shieldDelay,
    config: SPRING_SNAPPY,
  });
  const shieldScale = interpolate(shieldEntrance, [0, 1], [0.3, 1]);
  const shieldOpacity = interpolate(shieldEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Pulsing shield glow
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowIntensity = shieldEntrance > 0.5 ? 10 + Math.sin(glowPhase) * 8 : 0;

  // Second ring
  const ring2Delay = Math.round(1 * fps);
  const ring2Entrance = spring({
    frame,
    fps,
    delay: ring2Delay,
    config: SPRING_SNAPPY,
  });
  const ring2Scale = interpolate(ring2Entrance, [0, 1], [0.3, 1.3]);
  const ring2Opacity = interpolate(ring2Entrance, [0, 0.5], [0, 0.4], {
    extrapolateRight: "clamp",
  });

  // Text
  const textEntrance = spring({
    frame,
    fps,
    delay: Math.round(1.5 * fps),
    config: SPRING_SNAPPY,
  });
  const textOpacity = interpolate(textEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const textY = interpolate(textEntrance, [0, 1], [20, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {/* Shield with lock */}
      <div style={{ position: "relative" }}>
        {/* Outer ring */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 160,
            height: 160,
            marginTop: -80,
            marginLeft: -80,
            borderRadius: "50%",
            border: "2px solid rgba(26,35,126,0.5)",
            transform: `scale(${ring2Scale})`,
            opacity: ring2Opacity,
          }}
        />
        {/* Shield ring */}
        <div
          style={{
            width: 120,
            height: 120,
            borderRadius: "50%",
            border: "3px solid #1a237e",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: `scale(${shieldScale})`,
            opacity: shieldOpacity,
            boxShadow: `0 0 ${glowIntensity}px rgba(26,35,126,0.6)`,
            background: "rgba(26,35,126,0.15)",
          }}
        >
          <div style={{ transform: `scale(${lockScale})` }}>
            <span style={{ fontSize: 48 }}>🔒</span>
          </div>
        </div>
      </div>

      {/* Text */}
      <div
        style={{
          opacity: textOpacity,
          transform: `translateY(${textY}px)`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 32 : 36,
            color: "#7986CB",
            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
          }}
        >
          Your Privacy. Your Choice.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Anon Benefits (4-9s, frames 120-270)
const AnonBenefits: React.FC = () => {
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
        padding: isVertical ? "40px 30px" : "40px 60px",
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 28,
          color: "#7986CB",
          textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
          marginBottom: 8,
        }}
      >
        Anonymous Mode
      </span>

      {ANON_BENEFITS.map((benefit, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: Math.round(i * 0.6 * fps),
          config: SPRING_SNAPPY,
        });
        const slideX = interpolate(
          entrance,
          [0, 1],
          [i % 2 === 0 ? -300 : 300, 0]
        );
        const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={benefit.label}
            style={{
              transform: `translateX(${slideX}px)`,
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
                <span style={{ fontSize: 28 }}>{benefit.emoji}</span>
                <div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {benefit.label}
                  </div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
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

// Scene 4: Play Demo (9-12s, frames 270-360)
const PlayDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Pet walking animation
  const walkCycle = (frame / fps) * 2;
  const bobOffset = Math.sin(walkCycle * Math.PI * 4) * 3;
  const petX = interpolate(frame, [0, Math.round(2.5 * fps)], [-60, 60], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Chat preview
  const chatEntrance = spring({
    frame,
    fps,
    delay: Math.round(1.5 * fps),
    config: SPRING_SNAPPY,
  });
  const chatScale = interpolate(chatEntrance, [0, 1], [0.5, 1]);
  const chatOpacity = interpolate(chatEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {/* Walking pet */}
        <div
          style={{
            transform: `translateX(${petX}px) translateY(${bobOffset}px)`,
          }}
        >
          <PetSprite
            species="wolf"
            size={isVertical ? 100 : 90}
            enterDelay={0}
            bob={false}
            flipX={petX > 0}
          />
        </div>

        {/* Chat preview bubble */}
        <div
          style={{
            opacity: chatOpacity,
            transform: `scale(${chatScale})`,
          }}
        >
          <div
            style={{
              background: "rgba(255,255,255,0.95)",
              borderRadius: 16,
              padding: "10px 20px",
              boxShadow: "2px 2px 8px rgba(0,0,0,0.2)",
              maxWidth: isVertical ? 300 : 280,
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 15,
                color: "#333",
                lineHeight: 1.4,
              }}
            >
              Tell me about staking rewards...
            </span>
          </div>
        </div>

        {/* "No account needed" label */}
        <div
          style={{
            opacity: chatOpacity,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 16 }}>🔒</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 15,
              color: "rgba(255,255,255,0.7)",
              fontStyle: "italic",
            }}
          >
            No account needed
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (12-15s, frames 360-450)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <CTAButton text="Play Anonymously" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S20 composition
export const GoAnonymous: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-world-exploration-npcs.mp4" startFrom={8} tintOpacity={0.5} />
      <LiveBadge />
      <ParticleField count={15} color="#7986CB" speed={0.4} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Go Anonymous"
          subtitle="Privacy-first gameplay"
          accentColor="#1a237e"
        />
      </Sequence>

      {/* Scene 2: Privacy Shield (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <PrivacyShield />
      </Sequence>

      {/* Scene 3: Anon Benefits (4-9s) */}
      <Sequence from={4 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <AnonBenefits />
      </Sequence>

      {/* Scene 4: Play Demo (9-12s) */}
      <Sequence from={9 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <PlayDemo />
      </Sequence>

      {/* Scene 5: CTA (12-15s) */}
      <Sequence from={12 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
