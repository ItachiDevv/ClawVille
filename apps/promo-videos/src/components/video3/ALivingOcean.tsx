import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  staticFile,
  Easing,
} from "remotion";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { MapBackground } from "../shared/MapBackground";
import { PetSprite } from "../shared/PetSprite";
import { SpeechBubble } from "../shared/SpeechBubble";
import { CTAButton } from "../shared/CTAButton";
import { LogoReveal } from "../shared/LogoReveal";
import { COLORS } from "../../constants/colors";
import { SPRING_SMOOTH, SPRING_BOUNCY, SPRING_SNAPPY, FPS } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Map Overview (0-3s, frames 0-90)
const MapOverview: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Zoom from full overview to center
  const zoomProgress = interpolate(frame, [0, fps * 2.5], [1, 1.8], {
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });

  // Building labels fade in
  const labelsOpacity = interpolate(frame, [fps * 1, fps * 2], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const mapW = width * 0.8;
  const mapH = mapW * (1154 / 1590);

  const buildings = [
    { name: "Web3 Library", x: 0.42, y: 0.06 },
    { name: "Airdrop Tree", x: 0.36, y: 0.3 },
    { name: "Alpha Lab", x: 0.26, y: 0.11 },
    { name: "Liquidity Pool", x: 0.51, y: 0.34 },
  ];

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center" }}
    >
      <div
        style={{
          transform: `scale(${zoomProgress})`,
          position: "relative",
        }}
      >
        <Img
          src={staticFile("map/clawville-map-real-full.png")}
          style={{
            width: mapW,
            height: mapH,
            borderRadius: 16,
            border: `3px solid ${COLORS.border}`,
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
          }}
        />
        {/* Building labels */}
        {buildings.map((b, i) => {
          const labelEntrance = spring({
            frame,
            fps,
            delay: Math.round(fps * 1.2 + i * 6),
            config: { damping: 200 },
          });
          return (
            <div
              key={b.name}
              style={{
                position: "absolute",
                left: b.x * mapW - 40,
                top: b.y * mapH - 12,
                opacity: interpolate(labelEntrance, [0, 1], [0, labelsOpacity]),
                transform: `scale(${interpolate(labelEntrance, [0, 1], [0.5, 1])})`,
              }}
            >
              <div
                style={{
                  background: "rgba(0,0,0,0.7)",
                  borderRadius: 6,
                  padding: "3px 8px",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 11,
                    color: COLORS.panel,
                    fontWeight: 700,
                  }}
                >
                  {b.name}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: NPC Movement (3-7s, frames 90-210)
const NpcMovement: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const npcs = [
    { species: "cat" as const, emoji: "\u{1F4DA}", startX: 0.1, endX: 0.4, y: 0.35 },
    { species: "owl" as const, emoji: "\u{1F3A8}", startX: 0.9, endX: 0.6, y: 0.55 },
    { species: "bunny" as const, emoji: "\u{1F6CD}\u{FE0F}", startX: 0.3, endX: 0.7, y: 0.7 },
  ];

  return (
    <AbsoluteFill>
      {/* Map background for this scene */}
      <MapBackground zoom={1.8} tintColor="#000" tintOpacity={0.15} />

      {npcs.map((npc, i) => {
        const moveProgress = interpolate(
          frame,
          [0, fps * 3.5],
          [0, 1],
          { extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }
        );
        const x = interpolate(
          moveProgress,
          [0, 1],
          [npc.startX * width, npc.endX * width]
        );
        const y = npc.y * height;
        const bobY = Math.sin((frame / fps) * 3 + i * 2) * 4;
        const flipX = npc.endX < npc.startX;

        return (
          <React.Fragment key={i}>
            <div
              style={{
                position: "absolute",
                left: x - 40,
                top: y - 40 + bobY,
              }}
            >
              <PetSprite
                species={npc.species}
                size={80}
                enterDelay={i * 8}
                bob={false}
                flipX={flipX}
              />
            </div>
            {/* Activity emoji */}
            <div
              style={{
                position: "absolute",
                left: x - 12,
                top: y - 60 + bobY,
                fontSize: 24,
                filter: "drop-shadow(1px 1px 2px rgba(0,0,0,0.3))",
              }}
            >
              {npc.emoji}
            </div>
          </React.Fragment>
        );
      })}

      <div
        style={{
          position: "absolute",
          top: isVertical ? 80 : 40,
          width: "100%",
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 36,
            color: COLORS.accent,
            textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          }}
        >
          Lobsters Live Their Own Lives
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: NPC Conversation (7-13.3s, frames 210-400)
const NpcConversation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;
  const petSize = isVertical ? 100 : 90;

  // Typing dots animation
  const showTyping = frame >= 10 && frame < 40;
  const typingDots = showTyping
    ? ".".repeat(1 + (Math.floor((frame / fps) * 3) % 3))
    : "";

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
          display: "flex",
          flexDirection: "column",
          gap: 20,
          maxWidth: isVertical ? 500 : 700,
          width: "100%",
        }}
      >
        {/* Two lobsters facing each other */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <PetSprite species="fox" size={petSize} enterDelay={0} bob />
            <span style={{ fontFamily: roboto, fontSize: 14, color: COLORS.panel, fontWeight: 700 }}>
              Snapper
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <PetSprite species="owl" size={petSize} enterDelay={5} flipX bob />
            <span style={{ fontFamily: roboto, fontSize: 14, color: COLORS.panel, fontWeight: 700 }}>
              Barnacle
            </span>
          </div>
        </div>

        {/* Typing indicator */}
        {showTyping && (
          <div
            style={{
              alignSelf: "flex-start",
              background: "rgba(255,255,255,0.2)",
              borderRadius: 12,
              padding: "6px 14px",
              fontFamily: roboto,
              fontSize: 20,
              color: COLORS.panel,
            }}
          >
            {typingDots}
          </div>
        )}

        {/* Chat bubbles */}
        <Sequence from={40} layout="none">
          <SpeechBubble
            text="Have you explored the new DeFi protocols on Solana?"
            direction="left"
            delay={0}
            maxWidth={isVertical ? 350 : 400}
          />
        </Sequence>

        <Sequence from={90} layout="none">
          <SpeechBubble
            text="Indeed! Jupiter aggregator routes are remarkably efficient."
            direction="right"
            delay={0}
            maxWidth={isVertical ? 350 : 400}
          />
        </Sequence>

        <Sequence from={140} layout="none">
          <SpeechBubble
            text="I learned about AMMs from the DeFi Deep Dive book!"
            direction="left"
            delay={0}
            maxWidth={isVertical ? 350 : 400}
          />
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Memory Formation (13.3-18s, frames 400-540)
const MemoryFormation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const memories = [
    "DeFi protocols",
    "Jupiter aggregator",
    "AMM trading",
    "Solana ecosystem",
  ];

  const centerX = width / 2;
  const centerY = height / 2;
  const nodeRadius = 120;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: 60,
          width: "100%",
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 32,
            color: COLORS.accent,
            textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          }}
        >
          Memories Form Connections
        </span>
      </div>

      {/* Connection lines */}
      <svg
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        {memories.map((_, i) => {
          const nextI = (i + 1) % memories.length;
          const angle1 = (i / memories.length) * Math.PI * 2 - Math.PI / 2;
          const angle2 = (nextI / memories.length) * Math.PI * 2 - Math.PI / 2;
          const x1 = centerX + Math.cos(angle1) * nodeRadius;
          const y1 = centerY + Math.sin(angle1) * nodeRadius;
          const x2 = centerX + Math.cos(angle2) * nodeRadius;
          const y2 = centerY + Math.sin(angle2) * nodeRadius;

          const lineOpacity = interpolate(
            frame,
            [fps * 1 + i * 10, fps * 2 + i * 10],
            [0, 0.5],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );

          return (
            <line
              key={`line-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={COLORS.accent}
              strokeWidth={2}
              opacity={lineOpacity}
            />
          );
        })}
        {/* Cross connections */}
        {memories.length >= 4 && (
          <>
            <line
              x1={centerX + Math.cos(-Math.PI / 2) * nodeRadius}
              y1={centerY + Math.sin(-Math.PI / 2) * nodeRadius}
              x2={centerX + Math.cos(Math.PI / 2) * nodeRadius}
              y2={centerY + Math.sin(Math.PI / 2) * nodeRadius}
              stroke={COLORS.accent}
              strokeWidth={1}
              opacity={interpolate(frame, [fps * 2.5, fps * 3.5], [0, 0.3], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })}
            />
            <line
              x1={centerX + Math.cos(0) * nodeRadius}
              y1={centerY + Math.sin(0) * nodeRadius}
              x2={centerX + Math.cos(Math.PI) * nodeRadius}
              y2={centerY + Math.sin(Math.PI) * nodeRadius}
              stroke={COLORS.accent}
              strokeWidth={1}
              opacity={interpolate(frame, [fps * 2.5, fps * 3.5], [0, 0.3], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })}
            />
          </>
        )}
      </svg>

      {/* Memory nodes */}
      {memories.map((memory, i) => {
        const angle = (i / memories.length) * Math.PI * 2 - Math.PI / 2;
        const x = centerX + Math.cos(angle) * nodeRadius;
        const y = centerY + Math.sin(angle) * nodeRadius;

        const nodeEntrance = spring({
          frame,
          fps,
          delay: i * 10,
          config: SPRING_BOUNCY,
        });
        const nodeScale = interpolate(nodeEntrance, [0, 1], [0, 1]);
        const nodeOpacity = interpolate(nodeEntrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        // Glow pulse
        const glowIntensity =
          8 + Math.sin(((frame / fps) * 2 + i) * Math.PI * 2) * 5;

        return (
          <div
            key={memory}
            style={{
              position: "absolute",
              left: x - 60,
              top: y - 20,
              width: 120,
              textAlign: "center",
              opacity: nodeOpacity,
              transform: `scale(${nodeScale})`,
            }}
          >
            <div
              style={{
                background: `rgba(0,229,255,0.15)`,
                borderRadius: 12,
                padding: "8px 12px",
                border: `2px solid ${COLORS.accent}`,
                boxShadow: `0 0 ${glowIntensity}px rgba(0,229,255,0.3)`,
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 13,
                  fontWeight: 700,
                  color: COLORS.accent,
                }}
              >
                {memory}
              </span>
            </div>
          </div>
        );
      })}

      {/* Central brain icon */}
      <div
        style={{
          position: "absolute",
          left: centerX - 25,
          top: centerY - 25,
          fontSize: 50,
          filter: "drop-shadow(0 0 10px rgba(0,229,255,0.5))",
        }}
      >
        {"\u{1F9E0}"}
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (18-20s, frames 540-600)
const WorldCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 24 }}
    >
      <LogoReveal size={48} />
      <CTAButton text="Explore The Depths" />
    </AbsoluteFill>
  );
};

// Main Video 3 composition
export const ALivingOcean: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <MapBackground zoomRange={[1, 1.6]} tintColor="#000" tintOpacity={0.2} panYRange={[-0.05, 0.05]} />

      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <MapOverview />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <NpcMovement />
      </Sequence>

      <Sequence
        from={7 * fps}
        durationInFrames={Math.round(6.3 * fps)}
        premountFor={fps}
      >
        <NpcConversation />
      </Sequence>

      <Sequence
        from={Math.round(13.3 * fps)}
        durationInFrames={Math.round(4.7 * fps)}
        premountFor={fps}
      >
        <MemoryFormation />
      </Sequence>

      <Sequence from={18 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <WorldCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
