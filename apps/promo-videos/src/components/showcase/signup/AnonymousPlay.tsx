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
import { AvatarSprite } from "../../shared/AvatarSprite";
import { SpeechBubble } from "../../shared/SpeechBubble";
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

// Scene 2: One Click (1-4s, frames 30-120)
const OneClick: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Button entrance
  const buttonEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const buttonScale = interpolate(buttonEntrance, [0, 1], [0.3, 1]);

  // Click animation
  const clickDelay = Math.round(1.2 * fps);
  const clickProgress = spring({
    frame,
    fps,
    delay: clickDelay,
    config: SPRING_SNAPPY,
  });
  const clickScale = interpolate(clickProgress, [0, 0.5, 1], [1, 0.92, 1.05]);
  const rippleScale = interpolate(clickProgress, [0, 1], [0, 3]);
  const rippleOpacity = interpolate(clickProgress, [0, 1], [0.6, 0]);

  // "No forms!" text
  const noFormsEntrance = spring({
    frame,
    fps,
    delay: Math.round(1.8 * fps),
    config: SPRING_SNAPPY,
  });
  const noFormsOpacity = interpolate(noFormsEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Greyed-out form fields that fade away
  const formFade = interpolate(frame, [0, Math.round(0.8 * fps)], [0.4, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
      {/* Ghost form fields fading away */}
      <div
        style={{
          position: "absolute",
          top: isVertical ? "20%" : "15%",
          opacity: formFade,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
        }}
      >
        {["Email", "Password", "Confirm Password"].map((field) => (
          <div
            key={field}
            style={{
              width: 260,
              height: 36,
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 13,
                color: "rgba(255,255,255,0.3)",
              }}
            >
              {field}
            </span>
          </div>
        ))}
      </div>

      {/* Play Now button */}
      <div
        style={{
          transform: `scale(${buttonScale * clickScale})`,
          position: "relative",
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.blue}, #1565C0)`,
            borderRadius: 40,
            padding: "20px 56px",
            boxShadow: "0 6px 24px rgba(33,150,243,0.5)",
            border: "3px solid rgba(255,255,255,0.2)",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 30,
              fontWeight: 700,
              color: COLORS.white,
              letterSpacing: 1,
            }}
          >
            Play Now
          </span>
        </div>
        {/* Click ripple */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 60,
            height: 60,
            marginTop: -30,
            marginLeft: -30,
            borderRadius: "50%",
            border: `2px solid ${COLORS.blue}`,
            transform: `scale(${rippleScale})`,
            opacity: rippleOpacity,
          }}
        />
      </div>

      {/* "No forms needed!" text */}
      <div
        style={{
          opacity: noFormsOpacity,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 22,
            fontWeight: 700,
            color: COLORS.green,
            textShadow: "1px 1px 3px rgba(0,0,0,0.4)",
          }}
        >
          No signup. No forms. Just play.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Instant Game (4-8s, frames 120-240)
const InstantGame: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Avatar appears
  const avatarEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const avatarScale = interpolate(avatarEntrance, [0, 1], [0, 1]);

  // WASD keys
  const keys = [
    { key: "W", x: 0, y: -1 },
    { key: "A", x: -1, y: 0 },
    { key: "S", x: 0, y: 0 },
    { key: "D", x: 1, y: 0 },
  ];

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {/* Avatar on map */}
        <div style={{ transform: `scale(${avatarScale})` }}>
          <AvatarSprite species="bunny" size={isVertical ? 120 : 100} enterDelay={5} bob />
        </div>

        {/* WASD keys */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", gap: 4 }}>
            {keys.slice(0, 1).map((k, i) => {
              const keyDelay = Math.round((1 + i * 0.2) * fps);
              const keyEntrance = spring({
                frame,
                fps,
                delay: keyDelay,
                config: SPRING_BOUNCY,
              });
              const keyScale = interpolate(keyEntrance, [0, 1], [0, 1]);
              // Highlight key press animation
              const pressPhase = Math.sin(((frame - keyDelay) / fps) * 4);
              const isPressed = pressPhase > 0.7;

              return (
                <div
                  key={k.key}
                  style={{
                    width: 44,
                    height: 44,
                    background: isPressed
                      ? "rgba(33,150,243,0.8)"
                      : "rgba(255,255,255,0.15)",
                    border: `2px solid ${isPressed ? COLORS.blue : "rgba(255,255,255,0.3)"}`,
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transform: `scale(${keyScale})`,
                    boxShadow: isPressed ? "0 0 10px rgba(33,150,243,0.5)" : "none",
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
                    {k.key}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {keys.slice(1).map((k, i) => {
              const keyDelay = Math.round((1.2 + i * 0.2) * fps);
              const keyEntrance = spring({
                frame,
                fps,
                delay: keyDelay,
                config: SPRING_BOUNCY,
              });
              const keyScale = interpolate(keyEntrance, [0, 1], [0, 1]);
              const pressPhase = Math.sin(((frame - keyDelay) / fps) * 4 + i);
              const isPressed = pressPhase > 0.7;

              return (
                <div
                  key={k.key}
                  style={{
                    width: 44,
                    height: 44,
                    background: isPressed
                      ? "rgba(33,150,243,0.8)"
                      : "rgba(255,255,255,0.15)",
                    border: `2px solid ${isPressed ? COLORS.blue : "rgba(255,255,255,0.3)"}`,
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transform: `scale(${keyScale})`,
                    boxShadow: isPressed ? "0 0 10px rgba(33,150,243,0.5)" : "none",
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
                    {k.key}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 4: Explore (8-13s, frames 240-390)
const Explore: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Avatar walks to building
  const walkProgress = interpolate(frame, [0, Math.round(1.5 * fps)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const avatarX = interpolate(walkProgress, [0, 1], [isVertical ? -100 : -150, 0]);

  // Building appears
  const buildingEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const buildingOpacity = interpolate(buildingEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Speech bubble
  const bubbleDelay = Math.round(2.5 * fps);

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: isVertical ? "column" : "row",
          gap: 24,
          padding: 40,
        }}
      >
        {/* Building */}
        <div style={{ opacity: buildingOpacity }}>
          <div
            style={{
              width: isVertical ? 120 : 100,
              height: isVertical ? 140 : 120,
              background: "linear-gradient(to bottom, #8D6E63, #6D4C41)",
              borderRadius: "8px 8px 0 0",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              border: "3px solid #5D4037",
              boxShadow: "4px 4px 0px rgba(0,0,0,0.3)",
            }}
          >
            <span style={{ fontSize: 36 }}>🏦</span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 11,
                fontWeight: 700,
                color: COLORS.white,
                textAlign: "center",
              }}
            >
              Token Bank
            </span>
          </div>
        </div>

        {/* Avatar walking */}
        <div style={{ transform: `translateX(${avatarX}px)` }}>
          <AvatarSprite species="bunny" size={isVertical ? 90 : 80} enterDelay={0} bob />
        </div>

        {/* Chat bubble */}
        <div
          style={{
            position: "absolute",
            bottom: isVertical ? "25%" : "20%",
            maxWidth: isVertical ? 340 : 300,
          }}
        >
          <SpeechBubble
            text="Welcome! Let me teach you about DeFi lending..."
            delay={bubbleDelay}
            maxWidth={isVertical ? 320 : 280}
          />
        </div>
      </AbsoluteFill>
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
      <CTAButton text="Jump Right In" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S19 composition
export const AnonymousPlay: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-world-exploration-npcs.mp4" startFrom={0} tintOpacity={0.5} />
      <LiveBadge />
      <ParticleField count={18} color={COLORS.blue} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Jump Right In"
          subtitle="No signup needed to start playing"
          accentColor={COLORS.blue}
        />
      </Sequence>

      {/* Scene 2: One Click (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <OneClick />
      </Sequence>

      {/* Scene 3: Instant Game (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <InstantGame />
      </Sequence>

      {/* Scene 4: Explore (8-13s) */}
      <Sequence from={8 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <Explore />
      </Sequence>

      {/* Scene 5: CTA (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
