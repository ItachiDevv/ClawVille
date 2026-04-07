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
import { MapBackground } from "../shared/MapBackground";
import { PetSprite } from "../shared/PetSprite";
import { ClawPanel } from "../shared/ClawPanel";
import { SpeechBubble } from "../shared/SpeechBubble";
import { TypewriterText } from "../shared/TypewriterText";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import { FPS, SPRING_BOUNCY, SPRING_SNAPPY } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Hook (0-3s, frames 0-90)
const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Tint opacity: dawn (0.6) to bright (0.1) over 3s
  const tintOpacity = interpolate(frame, [0, 3 * fps], [0.6, 0.1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Title spring-scales in
  const titleEntrance = spring({
    frame,
    fps,
    delay: 10,
    config: SPRING_BOUNCY,
  });
  const titleScale = interpolate(titleEntrance, [0, 1], [0.3, 1]);
  const titleOpacity = interpolate(titleEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <MapBackground
        tintColor={COLORS.secondary}
        tintOpacity={tintOpacity}
        zoom={1.2}
      />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div
          style={{
            opacity: titleOpacity,
            transform: `scale(${titleScale})`,
            textAlign: "center",
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: 44,
              color: COLORS.clawToken,
              textShadow: `
                2px 2px 0px ${COLORS.border},
                4px 4px 0px rgba(0,0,0,0.3),
                0 0 30px rgba(255,215,0,0.5)
              `,
            }}
          >
            A World That Runs 24/7
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 2: NPC Life (3-10s, frames 90-300)
const NpcLife: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 100 : 90;

  // NPC positions with slow translateX movement
  const npcs = [
    { species: "cat" as const, startX: 0.15, y: 0.5, label: "NPC" },
    { species: "owl" as const, startX: 0.55, y: 0.45, label: "NPC" },
    { species: "fox" as const, startX: 0.75, y: 0.55, label: "NPC" },
  ];

  // Speech bubbles appear at frame 4*fps (= 1s into this scene, i.e. 4s total)
  const bubbleDelay1 = 1 * fps;
  const bubbleDelay2 = Math.round(2.5 * fps);

  return (
    <AbsoluteFill>
      <MapBackground zoom={1.4} tintColor="#000" tintOpacity={0.15} />

      {npcs.map((npc, i) => {
        // Slow drift: each NPC moves +100px over 7s
        const moveX = interpolate(frame, [0, 7 * fps], [0, 100], {
          extrapolateRight: "clamp",
        });
        const x = npc.startX * width + moveX;
        const y = npc.y * height;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - petSize / 2,
              top: y - petSize / 2,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            {/* NPC badge above */}
            <ClawPanel
              style={{
                padding: "4px 8px",
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 12,
                  fontWeight: 700,
                  color: COLORS.secondary,
                }}
              >
                {npc.label}
              </span>
            </ClawPanel>
            <PetSprite
              species={npc.species}
              size={petSize}
              enterDelay={i * 8}
              bob
            />
          </div>
        );
      })}

      {/* Speech bubble from cat */}
      <Sequence from={bubbleDelay1} layout="none">
        <div
          style={{
            position: "absolute",
            left: 0.15 * width + interpolate(
              Math.min(frame, 7 * fps),
              [0, 7 * fps],
              [0, 100],
              { extrapolateRight: "clamp" }
            ) + petSize / 2 + 10,
            top: 0.5 * height - petSize - 20,
          }}
        >
          <SpeechBubble
            text="Have you checked Jupiter today?"
            direction="left"
            delay={0}
            maxWidth={isVertical ? 260 : 240}
          />
        </div>
      </Sequence>

      {/* Speech bubble from owl (delay 1.5s after first) */}
      <Sequence from={bubbleDelay2} layout="none">
        <div
          style={{
            position: "absolute",
            left: 0.55 * width + interpolate(
              Math.min(frame, 7 * fps),
              [0, 7 * fps],
              [0, 100],
              { extrapolateRight: "clamp" }
            ) + petSize / 2 + 10,
            top: 0.45 * height - petSize - 20,
          }}
        >
          <SpeechBubble
            text="The DEX volume is wild..."
            direction="left"
            delay={0}
            maxWidth={isVertical ? 260 : 240}
          />
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};

// Scene 3: Memory Formation (10-15s, frames 300-450)
const MemoryFormation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // First panel: NPC Memory
  const panel1Entrance = spring({
    frame,
    fps,
    delay: 10,
    config: SPRING_SNAPPY,
  });
  const panel1Scale = interpolate(panel1Entrance, [0, 1], [0.5, 1]);
  const panel1Opacity = interpolate(panel1Entrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Second panel slides up (delay 1s)
  const panel2Entrance = spring({
    frame,
    fps,
    delay: 1 * fps,
    config: SPRING_SNAPPY,
  });
  const panel2SlideY = interpolate(panel2Entrance, [0, 1], [40, 0]);
  const panel2Opacity = interpolate(panel2Entrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Bottom text springs in
  const textEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.5 * fps),
    config: SPRING_BOUNCY,
  });
  const textScale = interpolate(textEntrance, [0, 1], [0.5, 1]);
  const textOpacity = interpolate(textEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      {/* Dark overlay */}
      <AbsoluteFill
        style={{
          backgroundColor: "rgba(0,0,0,0.6)",
        }}
      />

      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 20,
          padding: 40,
        }}
      >
        {/* First panel: NPC Memory */}
        <div
          style={{
            opacity: panel1Opacity,
            transform: `scale(${panel1Scale})`,
          }}
        >
          <ClawPanel width={400}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 20,
                  fontWeight: 700,
                  color: COLORS.panel,
                }}
              >
                NPC Memory
              </span>
              <TypewriterText
                text="Discussed Jupiter routing with the Alpha Lab keeper — Importance: High"
                startFrame={20}
                charsPerSecond={30}
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  color: COLORS.accent,
                  lineHeight: 1.4,
                }}
              />
            </div>
          </ClawPanel>
        </div>

        {/* Second panel: stat */}
        <div
          style={{
            opacity: panel2Opacity,
            transform: `translateY(${panel2SlideY}px)`,
          }}
        >
          <ClawPanel width={400}>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 16,
                fontWeight: 700,
                color: COLORS.accent,
              }}
            >
              30% of conversations use past memory context
            </span>
          </ClawPanel>
        </div>

        {/* Bottom text */}
        <div
          style={{
            opacity: textOpacity,
            transform: `scale(${textScale})`,
            marginTop: 16,
            textAlign: "center",
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: 32,
              color: COLORS.clawToken,
              textShadow: `
                2px 2px 0px rgba(0,0,0,0.4),
                0 0 20px rgba(255,215,0,0.4)
              `,
            }}
          >
            NPCs remember. Conversations evolve.
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (15-17s, frames 450-510)
const LivingWorldCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const textEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const textOpacity = interpolate(textEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });
  const textScale = interpolate(textEntrance, [0, 1], [0.5, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 30,
      }}
    >
      <div
        style={{
          opacity: textOpacity,
          transform: `scale(${textScale})`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 36,
            color: COLORS.panel,
            textShadow: `
              2px 2px 0px rgba(0,0,0,0.4),
              0 0 15px rgba(255,255,255,0.3)
            `,
          }}
        >
          Your bot joins a living ecosystem
        </span>
      </div>
      <CTAButton text="Enter The Depths" delay={15} />
    </AbsoluteFill>
  );
};

// Main Video 10 composition
export const LivingWorld: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <MapBackground
        zoomRange={[1, 1.4]}
        tintColor="#000"
        tintOpacity={0.2}
        panYRange={[-0.03, 0.03]}
      />

      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <Hook />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={7 * fps} premountFor={fps}>
        <NpcLife />
      </Sequence>

      <Sequence from={10 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <MemoryFormation />
      </Sequence>

      <Sequence from={15 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <LivingWorldCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
