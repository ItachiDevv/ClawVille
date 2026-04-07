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
import { TypewriterText } from "../../shared/TypewriterText";
import { ParticleField } from "../../shared/ParticleField";
import { CTAButton } from "../../shared/CTAButton";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import { SIGNUP_STEPS } from "../../../constants/showcase";
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

// Scene 2: Signup Form (1-4s, frames 30-120)
const SignupForm: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const formEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const formScale = interpolate(formEntrance, [0, 1], [0.8, 1]);
  const formOpacity = interpolate(formEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  const fields = [
    { label: "Username", value: "CryptoExplorer", typeDelay: 15 },
    { label: "Email", value: "explorer@email.com", typeDelay: Math.round(1 * fps) },
    { label: "Password", value: "**********", typeDelay: Math.round(1.8 * fps) },
  ];

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
          opacity: formOpacity,
          transform: `scale(${formScale})`,
        }}
      >
        <ClawPanel width={isVertical ? 380 : 420}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 26,
                color: "#3E2723",
                textAlign: "center",
              }}
            >
              Create Account
            </span>

            {fields.map((field) => (
              <div key={field.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#795548",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                  }}
                >
                  {field.label}
                </span>
                <div
                  style={{
                    height: 40,
                    background: "#fff",
                    border: "2px solid #ddd",
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 12px",
                  }}
                >
                  <TypewriterText
                    text={field.value}
                    startFrame={field.typeDelay}
                    charsPerSecond={20}
                    style={{
                      fontFamily: roboto,
                      fontSize: 15,
                      color: field.label === "Password" ? "#999" : "#333",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Species Select (4-7s, frames 120-210)
const SpeciesSelect: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const speciesOptions: Array<{ species: "fox" | "dragon" | "cat"; label: string }> = [
    { species: "fox", label: "Fox" },
    { species: "dragon", label: "Dragon" },
    { species: "cat", label: "Cat" },
  ];

  // Selected index (fox gets selected)
  const selectDelay = Math.round(1.5 * fps);
  const selectProgress = spring({
    frame,
    fps,
    delay: selectDelay,
    config: SPRING_BOUNCY,
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
          fontSize: 28,
          color: COLORS.gold,
          textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
        }}
      >
        Choose Your Species
      </span>

      <div
        style={{
          display: "flex",
          gap: isVertical ? 16 : 24,
          alignItems: "center",
        }}
      >
        {speciesOptions.map((opt, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: Math.round(i * 0.3 * fps),
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);

          // Selected state (index 0 = fox)
          const isSelected = i === 0;
          const selectedScale = isSelected
            ? interpolate(selectProgress, [0, 1], [1, 1.2])
            : interpolate(selectProgress, [0, 1], [1, 0.85]);
          const selectedOpacity = isSelected
            ? 1
            : interpolate(selectProgress, [0, 1], [1, 0.5]);
          const borderColor = isSelected && selectProgress > 0.5
            ? COLORS.gold
            : "transparent";
          const glowSize = isSelected && selectProgress > 0.5 ? 8 : 0;

          return (
            <div
              key={opt.species}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                transform: `scale(${scale * selectedScale})`,
                opacity: selectedOpacity,
              }}
            >
              <div
                style={{
                  borderRadius: 16,
                  border: `3px solid ${borderColor}`,
                  padding: 8,
                  boxShadow: `0 0 ${glowSize}px rgba(255,215,0,0.5)`,
                  background: isSelected && selectProgress > 0.5
                    ? "rgba(255,215,0,0.1)"
                    : "transparent",
                }}
              >
                <PetSprite species={opt.species} size={isVertical ? 90 : 80} enterDelay={Math.round(i * 0.3 * fps)} bob />
              </div>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  fontWeight: 700,
                  color: COLORS.white,
                  textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
                }}
              >
                {opt.label}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Creation Steps (7-11s, frames 210-330)
const CreationSteps: React.FC = () => {
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
      {SIGNUP_STEPS.map((step, i) => {
        const stepDelay = Math.round(i * 0.7 * fps);
        const stepEntrance = spring({
          frame,
          fps,
          delay: stepDelay,
          config: SPRING_SNAPPY,
        });
        const slideY = interpolate(stepEntrance, [0, 1], [40, 0]);
        const opacity = interpolate(stepEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        // Checkmark animation
        const checkDelay = stepDelay + Math.round(0.5 * fps);
        const checkEntrance = spring({
          frame,
          fps,
          delay: checkDelay,
          config: SPRING_BOUNCY,
        });
        const checkScale = interpolate(checkEntrance, [0, 1], [0, 1]);

        return (
          <div
            key={step.label}
            style={{
              transform: `translateY(${slideY}px)`,
              opacity,
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            {/* Checkmark */}
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: checkEntrance > 0.5 ? COLORS.green : "rgba(255,255,255,0.15)",
                border: `2px solid ${checkEntrance > 0.5 ? COLORS.green : "rgba(255,255,255,0.3)"}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: `scale(${checkEntrance > 0 ? checkScale : 1})`,
                flexShrink: 0,
              }}
            >
              {checkEntrance > 0.5 && (
                <span
                  style={{
                    color: COLORS.white,
                    fontSize: 16,
                    fontWeight: 700,
                  }}
                >
                  {"\u2713"}
                </span>
              )}
            </div>

            <ClawPanel width={isVertical ? 310 : 400}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 24 }}>{step.emoji}</span>
                <div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 17,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {step.label}
                  </div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      color: "#795548",
                    }}
                  >
                    {step.desc}
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

// Scene 5: Welcome (11-15s, frames 330-450)
const WelcomeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // "Welcome!" banner
  const bannerEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const bannerScale = interpolate(bannerEntrance, [0, 1], [0.3, 1]);

  // Pet on map
  const petEntrance = spring({
    frame,
    fps,
    delay: Math.round(1 * fps),
    config: SPRING_BOUNCY,
  });
  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);

  // Confetti particles (simple dots)
  const confettiColors = [COLORS.gold, COLORS.green, COLORS.blue, "#FF5722", "#9C27B0"];

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
        {/* Confetti */}
        {confettiColors.map((color, i) => {
          const angle = (i / confettiColors.length) * Math.PI * 2;
          const dist = 80 + bannerEntrance * 120;
          const x = Math.cos(angle + frame * 0.02) * dist;
          const y = Math.sin(angle + frame * 0.02) * dist - 20;

          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: width / 2 + x,
                top: height / 2 + y - 40,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: color,
                opacity: bannerEntrance * 0.8,
                boxShadow: `0 0 6px ${color}`,
              }}
            />
          );
        })}

        {/* Welcome banner */}
        <div
          style={{
            transform: `scale(${bannerScale})`,
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: isVertical ? 48 : 56,
              color: COLORS.gold,
              textShadow: `2px 2px 0px rgba(0,0,0,0.4), 0 0 30px rgba(255,215,0,0.3)`,
            }}
          >
            Welcome!
          </span>
        </div>

        {/* Pet */}
        <div style={{ transform: `scale(${petScale})` }}>
          <PetSprite species="fox" size={isVertical ? 110 : 100} enterDelay={Math.round(1 * fps)} bob />
        </div>

        {/* Subtitle */}
        <div
          style={{
            opacity: petEntrance,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 20,
              color: COLORS.white,
              textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            Your adventure begins now
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (15-18s, frames 450-540)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <CTAButton text="Create Account" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S21 composition
export const CreateAccount: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-pet-chat-shop.mp4" startFrom={3} tintOpacity={0.5} />
      <LiveBadge />
      <ParticleField count={18} color={COLORS.gold} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Create Your Account"
          subtitle="Unlock the full experience"
          accentColor={COLORS.gold}
        />
      </Sequence>

      {/* Scene 2: Signup Form (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <SignupForm />
      </Sequence>

      {/* Scene 3: Species Select (4-7s) */}
      <Sequence from={4 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <SpeciesSelect />
      </Sequence>

      {/* Scene 4: Creation Steps (7-11s) */}
      <Sequence from={7 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <CreationSteps />
      </Sequence>

      {/* Scene 5: Welcome (11-15s) */}
      <Sequence from={11 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <WelcomeScene />
      </Sequence>

      {/* Scene 6: CTA (15-18s) */}
      <Sequence from={15 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
