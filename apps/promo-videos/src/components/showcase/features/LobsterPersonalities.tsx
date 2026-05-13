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
import { AvatarSprite } from "../../shared/AvatarSprite";
import { SpeechBubble } from "../../shared/SpeechBubble";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
} from "../../../constants/timing";
import { PET_PERSONALITY_SAMPLES } from "../../../constants/showcase";
import { ARCHETYPES } from "../../../constants/archetypes";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Archetype Grid (1-5s, frames 30-150)
const ArchetypeGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 14 : 16,
        padding: isVertical ? "40px 24px" : 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: "#E91E63",
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        14 Unique Personalities
      </span>

      {/* Show 4 sample personalities */}
      {PET_PERSONALITY_SAMPLES.map((sample, i) => {
        const sampleEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.2 + i * 0.35) * fps),
          config: SPRING_SNAPPY,
        });
        const sampleSlideX = interpolate(
          sampleEntrance,
          [0, 1],
          [i % 2 === 0 ? -300 : 300, 0]
        );
        const sampleOpacity = interpolate(sampleEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={sample.archetype}
            style={{
              transform: `translateX(${sampleSlideX}px)`,
              opacity: sampleOpacity,
            }}
          >
            <ClawPanel width={isVertical ? 360 : 440}>
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
                    borderRadius: "50%",
                    background: `linear-gradient(135deg, #E91E63, #9C27B0)`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
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
                    {sample.archetype.charAt(0)}
                  </span>
                </div>
                <div style={{ flex: 1 }}>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {sample.archetype}
                  </span>
                  <div>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 13,
                        color: "#795548",
                        fontStyle: "italic",
                      }}
                    >
                      "{sample.quote}"
                    </span>
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 12,
                    color: "#E91E63",
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                >
                  {sample.tone}
                </span>
              </div>
            </ClawPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: Same Question, Different Answers (5-9s, frames 150-270)
const SameQuestion: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Question prompt
  const questionEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  // Two different responses
  const response1Delay = Math.round(1 * fps);
  const response2Delay = Math.round(2 * fps);

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
      {/* Question prompt */}
      <div
        style={{
          opacity: interpolate(questionEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `translateY(${interpolate(questionEntrance, [0, 1], [-20, 0])}px)`,
        }}
      >
        <div
          style={{
            background: "rgba(255,255,255,0.1)",
            border: "2px solid rgba(255,255,255,0.3)",
            borderRadius: 16,
            padding: "12px 24px",
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
            You ask: "What is DeFi?"
          </span>
        </div>
      </div>

      {/* Avatar 1: Brave Adventurer */}
      <div
        style={{
          display: "flex",
          alignItems: isVertical ? "flex-start" : "center",
          gap: 12,
          flexDirection: isVertical ? "column" : "row",
          width: "100%",
          maxWidth: isVertical ? 400 : 560,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AvatarSprite species="dragon" size={56} enterDelay={response1Delay} bob />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 13,
              fontWeight: 700,
              color: "#E91E63",
            }}
          >
            Brave
          </span>
        </div>
        <SpeechBubble
          text="DeFi? It's the wild frontier of finance! Charge in headfirst!"
          delay={response1Delay}
          maxWidth={isVertical ? 320 : 380}
          direction="left"
        />
      </div>

      {/* Avatar 2: Curious Scholar */}
      <div
        style={{
          display: "flex",
          alignItems: isVertical ? "flex-end" : "center",
          gap: 12,
          flexDirection: isVertical ? "column" : "row-reverse",
          width: "100%",
          maxWidth: isVertical ? 400 : 560,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AvatarSprite species="owl" size={56} enterDelay={response2Delay} bob />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 13,
              fontWeight: 700,
              color: "#E91E63",
            }}
          >
            Scholar
          </span>
        </div>
        <SpeechBubble
          text="DeFi refers to decentralized financial protocols built on smart contracts..."
          delay={response2Delay}
          maxWidth={isVertical ? 320 : 380}
          direction="right"
        />
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Tone Examples (9-13s, frames 270-390)
const ToneExamples: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const tones = [
    { archetype: "Mischievous Trickster", tone: "playful", color: "#FF9800" },
    { archetype: "Gentle Healer", tone: "warm", color: "#4CAF50" },
    { archetype: "Fierce Battler", tone: "intense", color: "#F44336" },
    { archetype: "Mystical Seer", tone: "cryptic", color: "#9C27B0" },
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 14 : 16,
        padding: isVertical ? "40px 24px" : 40,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 32,
          color: "#E91E63",
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Every Voice is Unique
      </span>

      {tones.map((tone, i) => {
        const toneEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.2 + i * 0.3) * fps),
          config: SPRING_SNAPPY,
        });
        const toneScale = interpolate(toneEntrance, [0, 1], [0.8, 1]);
        const toneOpacity = interpolate(toneEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={tone.archetype}
            style={{
              opacity: toneOpacity,
              transform: `scale(${toneScale})`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: `${tone.color}20`,
                border: `2px solid ${tone.color}50`,
                borderRadius: 16,
                padding: "10px 20px",
                width: isVertical ? 360 : 440,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: tone.color,
                  boxShadow: `0 0 8px ${tone.color}`,
                }}
              />
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  fontWeight: 700,
                  color: COLORS.white,
                  minWidth: isVertical ? 140 : 180,
                }}
              >
                {tone.archetype}
              </span>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 14,
                  color: tone.color,
                  fontStyle: "italic",
                  textTransform: "uppercase",
                }}
              >
                {tone.tone}
              </span>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 5: Personality Impact (13-16s, frames 390-480)
const PersonalityImpact: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const impacts = [
    { icon: "💬", label: "Chat Style", desc: "How they speak to you" },
    { icon: "📖", label: "Learning Style", desc: "How they absorb knowledge" },
    { icon: "⚔️", label: "Battle Strategy", desc: "How they fight in the arena" },
  ];

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
          color: "#E91E63",
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        Personality Shapes Everything
      </span>

      {impacts.map((impact, i) => {
        const impactEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.3 + i * 0.4) * fps),
          config: SPRING_BOUNCY,
        });
        const impactScale = interpolate(impactEntrance, [0, 1], [0, 1]);
        const impactOpacity = interpolate(impactEntrance, [0, 0.3], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={impact.label}
            style={{
              opacity: impactOpacity,
              transform: `scale(${impactScale})`,
            }}
          >
            <ClawPanel width={isVertical ? 340 : 420}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <span style={{ fontSize: 32 }}>{impact.icon}</span>
                <div>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {impact.label}
                  </span>
                  <div>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 14,
                        color: "#795548",
                      }}
                    >
                      {impact.desc}
                    </span>
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

// Scene 6: CTA (16-18s, frames 480-540)
const PersonalityCTA: React.FC = () => {
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
        text="Choose Your Personality"
        subtitle="play.clawville.com"
      />
    </AbsoluteFill>
  );
};

// Main composition
export const LobsterPersonalities: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="avatar-stats.mp4" startFrom={0} tintOpacity={0.5} />
      <LiveBadge />
      <ParticleField count={18} color="#E91E63" speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Lobster Personalities"
          subtitle="14 unique archetypes"
          accentColor="#E91E63"
        />
      </Sequence>

      {/* Scene 2: Archetype Grid (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <ArchetypeGrid />
      </Sequence>

      {/* Scene 3: Same Question (5-9s) */}
      <Sequence from={5 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <SameQuestion />
      </Sequence>

      {/* Scene 4: Tone Examples (9-13s) */}
      <Sequence from={9 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <ToneExamples />
      </Sequence>

      {/* Scene 5: Personality Impact (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <PersonalityImpact />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <PersonalityCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
