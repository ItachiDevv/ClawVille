import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { NeopetsPanel } from "../shared/NeopetsPanel";
import { NeoTokenIcon } from "../shared/NeoTokenIcon";
import { AnimatedCounter } from "../shared/AnimatedCounter";
import { CTAButton } from "../shared/CTAButton";
import { ParticleField } from "../shared/ParticleField";
import { COLORS } from "../../constants/colors";
import { FPS, SPRING_BOUNCY, SPRING_SNAPPY } from "../../constants/timing";
import { BUILDING_THEMES } from "../../constants/buildings";

const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Hook (0-2s, frames 0-60)
const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const entrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const scale = interpolate(entrance, [0, 1], [0.3, 1]);
  const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <ParticleField count={15} color={COLORS.accent} speed={0.4} />
      <div
        style={{
          textAlign: "center",
          opacity,
          transform: `scale(${scale})`,
          padding: "0 40px",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 48,
            fontWeight: 700,
            color: COLORS.accent,
            textShadow: `
              2px 2px 0px rgba(0,0,0,0.4),
              0 0 20px rgba(0,229,255,0.3)
            `,
            lineHeight: 1.3,
          }}
        >
          15 Buildings. 15 Skills. 1 Bot.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Skill Grid (2-14s, frames 60-420)
const SkillGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const columns = isVertical ? 2 : 3;
  const rows = isVertical ? 8 : 5;
  const panelWidth = isVertical ? width * 0.42 : 280;
  const gap = isVertical ? 10 : 14;
  const panelHeight = isVertical ? 52 : 56;

  // Calculate grid dimensions for centering
  const gridWidth = columns * panelWidth + (columns - 1) * gap;
  const gridHeight = Math.min(BUILDING_THEMES.length, rows * columns);
  const actualRows = Math.ceil(BUILDING_THEMES.length / columns);
  const totalGridHeight = actualRows * panelHeight + (actualRows - 1) * gap;

  const gridLeft = (width - gridWidth) / 2;
  const gridTop = (height - totalGridHeight) / 2;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
      }}
    >
      <ParticleField count={10} color={COLORS.accent} speed={0.2} />

      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: isVertical ? gridTop - 50 : gridTop - 45,
          width: "100%",
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 22 : 26,
            fontWeight: 700,
            color: COLORS.accent,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Crypto Skills Map
        </span>
      </div>

      {/* Grid */}
      {BUILDING_THEMES.map((building, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);

        const entrance = spring({
          frame,
          fps,
          delay: index * 6,
          config: SPRING_SNAPPY,
        });
        const scale = interpolate(entrance, [0, 1], [0, 1]);
        const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
          extrapolateRight: "clamp",
        });

        const x = gridLeft + col * (panelWidth + gap);
        const y = gridTop + row * (panelHeight + gap);

        return (
          <div
            key={building.name}
            style={{
              position: "absolute",
              left: x,
              top: y,
              opacity,
              transform: `scale(${scale})`,
              transformOrigin: "center center",
            }}
          >
            <NeopetsPanel
              width={panelWidth}
              style={{
                padding: isVertical ? "6px 10px" : "8px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: isVertical ? 16 : 20 }}>
                  {building.icon}
                </span>
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: isVertical ? 12 : 14,
                    fontWeight: 700,
                    color: COLORS.primary,
                  }}
                >
                  {building.name}
                </span>
              </div>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: isVertical ? 10 : 12,
                  fontStyle: "italic",
                  color: COLORS.bgGradient2,
                  paddingLeft: isVertical ? 24 : 28,
                }}
              >
                {building.focus}
              </span>
            </NeopetsPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 3: Counters (14-16s, frames 420-480)
const CountersScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // NeoTokenIcon spin
  const rotation = interpolate(frame, [0, fps * 2], [0, 360], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <ParticleField count={20} color={COLORS.accent} speed={0.8} />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
        }}
      >
        {/* Knowledge Books counter */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div style={{ transform: `rotate(${rotation}deg)` }}>
            <NeoTokenIcon size={48} />
          </div>
          <AnimatedCounter
            from={0}
            to={18}
            delay={5}
            suffix=" Knowledge Books"
            style={{
              fontFamily: roboto,
              fontSize: 36,
              fontWeight: 700,
              color: COLORS.accent,
              textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
            }}
          />
        </div>

        {/* Expert NPCs counter */}
        <AnimatedCounter
          from={0}
          to={15}
          delay={15}
          suffix=" Expert NPCs"
          style={{
            fontFamily: roboto,
            fontSize: 28,
            fontWeight: 700,
            color: COLORS.panel,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (16-18s, frames 480-540)
const SkillsCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const textEntrance = spring({
    frame,
    fps,
    delay: 0,
    config: SPRING_BOUNCY,
  });
  const textOpacity = interpolate(textEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const textY = interpolate(textEntrance, [0, 1], [30, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        gap: 28,
      }}
    >
      <ParticleField count={15} color={COLORS.accent} speed={0.5} />

      <div
        style={{
          opacity: textOpacity,
          transform: `translateY(${textY}px)`,
          textAlign: "center",
          padding: "0 40px",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 28,
            fontWeight: 400,
            color: COLORS.panel,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            lineHeight: 1.4,
          }}
        >
          Every conversation makes your bot smarter
        </span>
      </div>

      <CTAButton text="Start Learning" delay={10} />
    </AbsoluteFill>
  );
};

// Main Video 7 composition
export const FifteenSkills: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Sequence durationInFrames={2 * fps} premountFor={fps}>
        <HookScene />
      </Sequence>

      <Sequence from={2 * fps} durationInFrames={12 * fps} premountFor={fps}>
        <SkillGrid />
      </Sequence>

      <Sequence from={14 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CountersScene />
      </Sequence>

      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <SkillsCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
