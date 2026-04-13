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
import { GradientBackground } from "../shared/GradientBackground";
import { MapBackground } from "../shared/MapBackground";
import { NeopetsPanel } from "../shared/NeopetsPanel";
import { PetSprite } from "../shared/PetSprite";
import { SpeechBubble } from "../shared/SpeechBubble";
import { TerminalBlock } from "../shared/TerminalBlock";
import { TypewriterText } from "../shared/TypewriterText";
import { ParticleField } from "../shared/ParticleField";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import {
  FPS,
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
const { fontFamily: robotoMono } = loadRobotoMono("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

// Scene 1: Hook -- "Your bot just walked into a building" (0-3s)
const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const line2Entrance = spring({
    frame,
    fps,
    delay: Math.round(1.5 * fps),
    config: SPRING_SNAPPY,
  });
  const line2Y = interpolate(line2Entrance, [0, 1], [40, 0]);
  const line2Opacity = interpolate(line2Entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 20,
        flexDirection: "column",
        padding: 40,
      }}
    >
      <ParticleField count={15} color={COLORS.clawToken} speed={0.5} />
      <TypewriterText
        text="Your bot just walked into a building..."
        charsPerSecond={30}
        style={{
          fontFamily: roboto,
          fontSize: isVertical ? 34 : 36,
          fontWeight: 700,
          color: "#FFFFFF",
          textShadow: "2px 2px 6px rgba(0,0,0,0.6)",
          textAlign: "center",
        }}
      />
      <div
        style={{
          opacity: line2Opacity,
          transform: `translateY(${line2Y}px)`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 30 : 32,
            fontWeight: 700,
            color: COLORS.clawToken,
            textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
          }}
        >
          ...and learned something new.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: OpenClaw connects bot to the world (3-7s)
const BotConnects: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Terminal typing the connect command
  const terminalEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const terminalOpacity = interpolate(terminalEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const terminalSlideY = interpolate(terminalEntrance, [0, 1], [60, 0]);

  // Lobster appears after terminal
  const petEntrance = spring({
    frame,
    fps,
    delay: Math.round(2 * fps),
    config: SPRING_BOUNCY,
  });
  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);
  const petOpacity = interpolate(petEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // "Connected!" label
  const connectedEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.8 * fps),
    config: SPRING_SNAPPY,
  });
  const connectedOpacity = interpolate(connectedEntrance, [0, 1], [0, 1]);
  const connectedScale = interpolate(connectedEntrance, [0, 1], [0.5, 1]);

  // Glow pulse on the connected badge
  const glowPhase = (frame / fps) * 2 * Math.PI;
  const glowIntensity = 6 + Math.sin(glowPhase) * 4;

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
      {/* Terminal with OpenClaw registration */}
      <div
        style={{
          opacity: terminalOpacity,
          transform: `translateY(${terminalSlideY}px)`,
        }}
      >
        <TerminalBlock
          lines={[
            "POST /api/openclaw/register",
            '  mode: "avatar"',
            '  species: "spiny"',
            '  gateway: "https://openclaw.io"',
            "  -> 200 OK  agent_id: oc-7f3a",
          ]}
          startFrame={10}
          charsPerSecond={35}
          width={isVertical ? 420 : 520}
        />
      </div>

      {/* Bot avatar materializes */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          opacity: petOpacity,
          transform: `scale(${petScale})`,
        }}
      >
        <PetSprite species="fox" size={isVertical ? 100 : 90} enterDelay={Math.round(2 * fps)} bob />
        <div
          style={{
            opacity: connectedOpacity,
            transform: `scale(${connectedScale})`,
          }}
        >
          <div
            style={{
              background: "rgba(76, 175, 80, 0.9)",
              borderRadius: 20,
              padding: "8px 20px",
              boxShadow: `0 0 ${glowIntensity}px rgba(76,175,80,0.6)`,
            }}
          >
            <span
              style={{
                fontFamily: robotoMono,
                fontSize: 16,
                fontWeight: 700,
                color: "#FFFFFF",
              }}
            >
              OpenClaw Connected
            </span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Bot enters building, talks to NPC, learns (7-14s)
const LearningConversation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Building label
  const buildingEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const buildingOpacity = interpolate(buildingEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const buildingSlideY = interpolate(buildingEntrance, [0, 1], [-30, 0]);

  // Chat messages appear in sequence
  const chatMessages = [
    { speaker: "npc", text: "Welcome to the Alpha Lab! Ready to learn about token sniping?", delay: Math.round(0.8 * fps) },
    { speaker: "bot", text: "Yes! How do I detect new token launches on Solana?", delay: Math.round(2.5 * fps) },
    { speaker: "npc", text: "Monitor Raydium pools. When liquidity is added, the token goes live.", delay: Math.round(4 * fps) },
  ];

  // Knowledge pills that appear after conversation
  const knowledgePills = [
    "Raydium pool monitoring",
    "Token launch detection",
    "Liquidity analysis",
  ];

  const pillStartDelay = Math.round(5.5 * fps);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 12 : 16,
        padding: isVertical ? "60px 30px" : "40px 60px",
      }}
    >
      {/* Building header */}
      <div
        style={{
          opacity: buildingOpacity,
          transform: `translateY(${buildingSlideY}px)`,
        }}
      >
        <NeopetsPanel width={isVertical ? 380 : 400}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: 32 }}>{"🧪"}</span>
            <span
              style={{
                fontFamily: lobster,
                fontSize: 24,
                color: "#3E2723",
              }}
            >
              Alpha Lab
            </span>
          </div>
        </NeopetsPanel>
      </div>

      {/* Chat conversation */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "100%",
          maxWidth: isVertical ? 460 : 600,
          flex: 1,
          justifyContent: "center",
        }}
      >
        {chatMessages.map((msg, i) => {
          const isBot = msg.speaker === "bot";
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
            [isBot ? 100 : -100, 0]
          );

          return (
            <div
              key={i}
              style={{
                opacity: msgOpacity,
                transform: `translateX(${msgSlideX}px)`,
                display: "flex",
                flexDirection: isBot ? "row-reverse" : "row",
                alignItems: "flex-start",
                gap: 10,
              }}
            >
              {/* Speaker avatar */}
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: isBot
                    ? `linear-gradient(135deg, ${COLORS.secondary}, #FF5722)`
                    : "linear-gradient(135deg, #7E57C2, #9C27B0)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  flexShrink: 0,
                  boxShadow: "2px 2px 4px rgba(0,0,0,0.3)",
                }}
              >
                {isBot ? "🦞" : "🧪"}
              </div>

              {/* Message bubble */}
              <div
                style={{
                  background: isBot
                    ? `rgba(255,107,53,0.15)`
                    : "rgba(126,87,194,0.15)",
                  border: `2px solid ${isBot ? "rgba(255,107,53,0.4)" : "rgba(126,87,194,0.4)"}`,
                  borderRadius: 16,
                  padding: "10px 16px",
                  maxWidth: isVertical ? 340 : 420,
                }}
              >
                <TypewriterText
                  text={msg.text}
                  startFrame={msg.delay + 5}
                  charsPerSecond={40}
                  style={{
                    fontFamily: roboto,
                    fontSize: 16,
                    color: "#FFFFFF",
                    lineHeight: 1.4,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Knowledge pills appear at bottom */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
        }}
      >
        {knowledgePills.map((pill, i) => {
          const pillEntrance = spring({
            frame,
            fps,
            delay: pillStartDelay + i * Math.round(0.4 * fps),
            config: SPRING_BOUNCY,
          });
          const pillScale = interpolate(pillEntrance, [0, 1], [0, 1]);
          const pillOpacity = interpolate(pillEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={pill}
              style={{
                opacity: pillOpacity,
                transform: `scale(${pillScale})`,
              }}
            >
              <div
                style={{
                  background: `linear-gradient(135deg, ${COLORS.clawToken}, #FFA000)`,
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
                  +{pill}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Knowledge synced back to OpenClaw bot (14-18s)
const KnowledgeSync: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Flow diagram: ClawVille World -> OpenClaw -> Your Bot
  const nodes = [
    { emoji: "🌊", label: "ClawVille World" },
    { emoji: "🔌", label: "OpenClaw Gateway" },
    { emoji: "🦞", label: "Your Bot" },
  ];

  // Data packets flowing through the pipeline
  const packetCount = 3;
  const packets = Array.from({ length: packetCount }, (_, i) => {
    const packetDelay = Math.round((1.5 + i * 0.6) * fps);
    const progress = interpolate(
      frame,
      [packetDelay, packetDelay + Math.round(1.2 * fps)],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    return progress;
  });

  // "Knowledge Synced" badge
  const syncedEntrance = spring({
    frame,
    fps,
    delay: Math.round(3.2 * fps),
    config: SPRING_BOUNCY,
  });
  const syncedScale = interpolate(syncedEntrance, [0, 1], [0, 1]);
  const syncedOpacity = interpolate(syncedEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  const nodeWidth = isVertical ? 240 : 200;
  const gapSize = isVertical ? 40 : 60;

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
      <ParticleField count={12} color="#4CAF50" speed={0.8} />

      {/* Pipeline nodes */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          alignItems: "center",
          gap: 0,
        }}
      >
        {nodes.map((node, i) => {
          const nodeEntrance = spring({
            frame,
            fps,
            delay: Math.round(i * 0.4 * fps),
            config: SPRING_SNAPPY,
          });
          const nodeScale = interpolate(nodeEntrance, [0, 1], [0.5, 1]);
          const nodeOpacity = interpolate(nodeEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <React.Fragment key={node.label}>
              {/* Arrow between nodes */}
              {i > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: isVertical ? 4 : gapSize,
                    height: isVertical ? gapSize : 4,
                    position: "relative",
                  }}
                >
                  {/* Animated data packets */}
                  {packets.map((progress, pIdx) => {
                    const packetPos = interpolate(
                      progress,
                      [0, 0.5, 1],
                      i === 1
                        ? [0, 0.5, 1]
                        : [-1, 0, 0.5]
                    );
                    if (packetPos < 0 || packetPos > 1) return null;
                    const px = isVertical ? 0 : packetPos * gapSize;
                    const py = isVertical ? packetPos * gapSize : 0;

                    return (
                      <div
                        key={pIdx}
                        style={{
                          position: "absolute",
                          left: isVertical ? -3 : px,
                          top: isVertical ? py : -3,
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: COLORS.clawToken,
                          boxShadow: `0 0 8px ${COLORS.clawToken}`,
                          opacity: interpolate(packetPos, [0, 0.5, 1], [0.4, 1, 0.4]),
                        }}
                      />
                    );
                  })}

                  {/* Static arrow line */}
                  <div
                    style={{
                      position: "absolute",
                      background: "rgba(255,255,255,0.3)",
                      ...(isVertical
                        ? { width: 2, height: gapSize, top: 0, left: 0 }
                        : { height: 2, width: gapSize, top: 0, left: 0 }),
                      borderRadius: 1,
                    }}
                  />
                </div>
              )}

              {/* Node panel */}
              <div
                style={{
                  opacity: nodeOpacity,
                  transform: `scale(${nodeScale})`,
                }}
              >
                <NeopetsPanel width={nodeWidth}>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 36 }}>{node.emoji}</span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 16,
                        fontWeight: 700,
                        color: "#3E2723",
                        textAlign: "center",
                      }}
                    >
                      {node.label}
                    </span>
                  </div>
                </NeopetsPanel>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Knowledge synced badge */}
      <div
        style={{
          opacity: syncedOpacity,
          transform: `scale(${syncedScale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            background: "rgba(76,175,80,0.2)",
            border: "2px solid rgba(76,175,80,0.6)",
            borderRadius: 12,
            padding: "12px 24px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 18,
              color: "#a0ffa0",
              textShadow: "0 0 8px rgba(160,255,160,0.4)",
            }}
          >
            {"\u2705"} 3 skills synced to your bot&apos;s memory
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (18-20s)
const LearnSkillCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleEntrance = spring({
    frame,
    fps,
    delay: 0,
    config: SPRING_SMOOTH,
  });
  const titleOpacity = interpolate(titleEntrance, [0, 1], [0, 1]);
  const titleSlideY = interpolate(titleEntrance, [0, 1], [20, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        flexDirection: "column",
      }}
    >
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleSlideY}px)`,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 32,
            color: COLORS.clawToken,
            textShadow: "2px 2px 4px rgba(0,0,0,0.4)",
          }}
        >
          Your bot learns. Your bot remembers.
        </span>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 20,
            color: "#FFFFFF",
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Connect via OpenClaw. Explore. Level up.
        </span>
      </div>
      <CTAButton text="Connect Your Bot" subtitle="openclaw.io/register" />
    </AbsoluteFill>
  );
};

// Main composition
export const AgentLearnsSkill: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      {/* Background: map for learning scenes, gradient for others */}
      <GradientBackground colors={[COLORS.bgGradient1, COLORS.bg, COLORS.bgLight]} />

      {/* Scene 1: Hook (0-3s) */}
      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <Hook />
      </Sequence>

      {/* Scene 2: Bot connects via OpenClaw (3-7s) */}
      <Sequence from={3 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BotConnects />
      </Sequence>

      {/* Scene 3: Learning conversation at Alpha Lab (7-14s) */}
      <Sequence from={7 * fps} durationInFrames={7 * fps} premountFor={fps}>
        <AbsoluteFill>
          <MapBackground
            zoom={1.6}
            tintColor={COLORS.bg}
            tintOpacity={0.65}
            panX={0.1}
            panY={-0.05}
          />
        </AbsoluteFill>
        <LearningConversation />
      </Sequence>

      {/* Scene 4: Knowledge syncs back (14-18s) */}
      <Sequence from={14 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <KnowledgeSync />
      </Sequence>

      {/* Scene 5: CTA (18-20s) */}
      <Sequence from={18 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <LearnSkillCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
