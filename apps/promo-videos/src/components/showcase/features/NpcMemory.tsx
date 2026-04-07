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
import { SpeechBubble } from "../../shared/SpeechBubble";
import { TypewriterText } from "../../shared/TypewriterText";
import { CTAButton } from "../../shared/CTAButton";
import { LogoReveal } from "../../shared/LogoReveal";
import { TitleScreen } from "../shared/TitleScreen";
import { COLORS } from "../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
} from "../../../constants/timing";
import { NPC_MEMORY_EXAMPLES } from "../../../constants/showcase";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: NPC Intro (1-4s, frames 30-120)
const NpcIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const npcEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const npcScale = interpolate(npcEntrance, [0, 1], [0, 1]);

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
          fontSize: isVertical ? 28 : 34,
          color: "#009688",
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
        }}
      >
        NPCs That Remember
      </span>

      {/* NPC characters */}
      {NPC_MEMORY_EXAMPLES.map((npc, i) => {
        const npcItemEntrance = spring({
          frame,
          fps,
          delay: Math.round((0.3 + i * 0.35) * fps),
          config: SPRING_SNAPPY,
        });
        const npcItemSlideX = interpolate(
          npcItemEntrance,
          [0, 1],
          [i % 2 === 0 ? -200 : 200, 0]
        );
        const npcItemOpacity = interpolate(npcItemEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={npc.npc}
            style={{
              transform: `translateX(${npcItemSlideX}px)`,
              opacity: npcItemOpacity,
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
                <span style={{ fontSize: 32 }}>{npc.icon}</span>
                <div style={{ flex: 1 }}>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {npc.npc}
                  </span>
                  <div>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 14,
                        color: "#795548",
                      }}
                    >
                      {npc.memory}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "#009688",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ fontSize: 14, color: COLORS.white }}>🧠</span>
                </div>
              </div>
            </ClawPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: First Chat - NPC remembers nothing (4-8s, frames 120-240)
const FirstChat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const labelEntrance = spring({
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
        gap: isVertical ? 14 : 18,
        padding: isVertical ? "40px 24px" : 40,
      }}
    >
      {/* Visit label */}
      <div
        style={{
          opacity: interpolate(labelEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            background: "rgba(0,150,136,0.2)",
            border: "2px solid rgba(0,150,136,0.5)",
            borderRadius: 12,
            padding: "6px 16px",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: "#009688",
            }}
          >
            Visit #1 — First Meeting
          </span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 36 }}>📚</span>
        <span
          style={{
            fontFamily: lobster,
            fontSize: 24,
            color: "#009688",
          }}
        >
          Librarian
        </span>
      </div>

      {/* Conversation */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "100%",
          maxWidth: isVertical ? 400 : 500,
        }}
      >
        <SpeechBubble
          text="Hello there! Welcome to the Web3 Library. What would you like to learn about?"
          delay={Math.round(0.5 * fps)}
          maxWidth={isVertical ? 340 : 400}
          direction="left"
        />
        <div style={{ alignSelf: "flex-end" }}>
          <SpeechBubble
            text="Tell me about Solana validators."
            delay={Math.round(1.5 * fps)}
            maxWidth={isVertical ? 280 : 340}
            direction="right"
          />
        </div>
        <SpeechBubble
          text="Great choice! Let me explain how Solana's proof-of-stake validation works..."
          delay={Math.round(2.5 * fps)}
          maxWidth={isVertical ? 340 : 400}
          direction="left"
        />
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Return Chat - NPC references previous conversation (8-12s, frames 240-360)
const ReturnChat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const labelEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  // Memory indicator glow
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowSize = 6 + Math.sin(glowPhase) * 4;

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
      {/* Visit label */}
      <div
        style={{
          opacity: interpolate(labelEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            background: "rgba(0,150,136,0.2)",
            border: "2px solid rgba(0,150,136,0.5)",
            borderRadius: 12,
            padding: "6px 16px",
            boxShadow: `0 0 ${glowSize}px rgba(0,150,136,0.4)`,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: "#009688",
            }}
          >
            Visit #2 — They Remember!
          </span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 36 }}>📚</span>
        <span
          style={{
            fontFamily: lobster,
            fontSize: 24,
            color: "#009688",
          }}
        >
          Librarian
        </span>
        <span style={{ fontSize: 18 }}>🧠</span>
      </div>

      {/* Conversation with memory reference */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "100%",
          maxWidth: isVertical ? 400 : 500,
        }}
      >
        <SpeechBubble
          text="Welcome back! Last time we discussed Solana validators. Ready to go deeper into staking rewards?"
          delay={Math.round(0.5 * fps)}
          maxWidth={isVertical ? 340 : 420}
          direction="left"
        />
        <div style={{ alignSelf: "flex-end" }}>
          <SpeechBubble
            text="Yes! How do validators earn rewards?"
            delay={Math.round(2 * fps)}
            maxWidth={isVertical ? 280 : 340}
            direction="right"
          />
        </div>
      </div>

      {/* Memory indicator */}
      <div
        style={{
          opacity: interpolate(
            spring({
              frame,
              fps,
              delay: Math.round(2.5 * fps),
              config: SPRING_BOUNCY,
            }),
            [0, 0.3],
            [0, 1],
            { extrapolateRight: "clamp" }
          ),
        }}
      >
        <div
          style={{
            background: "rgba(0,150,136,0.15)",
            border: "1px solid rgba(0,150,136,0.4)",
            borderRadius: 12,
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 14 }}>🧠</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 13,
              color: "#009688",
              fontStyle: "italic",
            }}
          >
            Memory: "Discussed Solana validators (3 days ago)"
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Deep Conversation (12-16s, frames 360-480)
const DeepConversation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });

  const messages = [
    { speaker: "npc", text: "Building on your validator knowledge...", delay: Math.round(0.3 * fps) },
    { speaker: "pet", text: "What about slashing risks?", delay: Math.round(1.2 * fps) },
    { speaker: "npc", text: "Great question — slashing occurs when...", delay: Math.round(2 * fps) },
    { speaker: "pet", text: "And how does delegation work?", delay: Math.round(2.8 * fps) },
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 10 : 12,
        padding: isVertical ? "40px 20px" : "30px 50px",
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 24 : 28,
          color: "#009688",
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          opacity: interpolate(titleEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        Deep Conversations
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "100%",
          maxWidth: isVertical ? 420 : 520,
        }}
      >
        {messages.map((msg, i) => {
          const isNpc = msg.speaker === "npc";
          const msgEntrance = spring({
            frame,
            fps,
            delay: msg.delay,
            config: SPRING_SNAPPY,
          });
          const msgOpacity = interpolate(msgEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });
          const msgSlideX = interpolate(
            msgEntrance,
            [0, 1],
            [isNpc ? -60 : 60, 0]
          );

          return (
            <div
              key={i}
              style={{
                opacity: msgOpacity,
                transform: `translateX(${msgSlideX}px)`,
                display: "flex",
                justifyContent: isNpc ? "flex-start" : "flex-end",
              }}
            >
              <div
                style={{
                  background: isNpc
                    ? "rgba(0,150,136,0.15)"
                    : "rgba(255,255,255,0.1)",
                  border: `2px solid ${isNpc ? "rgba(0,150,136,0.4)" : "rgba(255,255,255,0.3)"}`,
                  borderRadius: 14,
                  padding: "8px 14px",
                  maxWidth: isVertical ? 300 : 360,
                }}
              >
                <TypewriterText
                  text={msg.text}
                  startFrame={msg.delay + 5}
                  charsPerSecond={35}
                  style={{
                    fontFamily: roboto,
                    fontSize: 15,
                    color: COLORS.white,
                    lineHeight: 1.4,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Depth indicator */}
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          opacity: interpolate(
            spring({
              frame,
              fps,
              delay: Math.round(3 * fps),
              config: SPRING_SNAPPY,
            }),
            [0, 0.5],
            [0, 1],
            { extrapolateRight: "clamp" }
          ),
        }}
      >
        {[1, 2, 3, 4, 5, 6].map((depth) => (
          <div
            key={depth}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: depth <= 4 ? "#009688" : "rgba(0,150,136,0.3)",
              boxShadow: depth <= 4 ? "0 0 4px rgba(0,150,136,0.5)" : "none",
            }}
          />
        ))}
        <span
          style={{
            fontFamily: roboto,
            fontSize: 12,
            color: "#009688",
            marginLeft: 4,
          }}
        >
          Conversation depth: 4/6
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const NpcCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={48} />
      <CTAButton text="Meet the NPCs" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main composition
export const NpcMemory: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="npc-activity.mp4" startFrom={0} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={16} color="#009688" speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="NPC Memory & Deep Conversations"
          subtitle="NPCs remember everything"
          accentColor="#009688"
        />
      </Sequence>

      {/* Scene 2: NPC Intro (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <NpcIntro />
      </Sequence>

      {/* Scene 3: First Chat (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <FirstChat />
      </Sequence>

      {/* Scene 4: Return Chat (8-12s) */}
      <Sequence from={8 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <ReturnChat />
      </Sequence>

      {/* Scene 5: Deep Conversation (12-16s) */}
      <Sequence from={12 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <DeepConversation />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <NpcCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
