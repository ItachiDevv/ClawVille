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
import { TitleScreen } from "../shared/TitleScreen";
import { RecordingBackground, LiveBadge } from "../../shared/RecordingBackground";
import { ParticleField } from "../../shared/ParticleField";
import { PetSprite } from "../../shared/PetSprite";
import { ClawPanel } from "../../shared/ClawPanel";
import { SpeechBubble } from "../../shared/SpeechBubble";
import { AnimatedCounter } from "../../shared/AnimatedCounter";
import { CTAButton } from "../../shared/CTAButton";
import { ALL_SPECIES } from "../../../constants/species";
import type { Species } from "../../../constants/species";
import { BUILDING_THEMES } from "../../../constants/buildings";
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

// Scene 2: Map Overview (1-5s, frames 30-150)
const MapOverview: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const counterEntrance = spring({
    frame,
    fps,
    delay: fps * 0.5,
    config: SPRING_BOUNCY,
  });
  const counterScale = interpolate(counterEntrance, [0, 1], [0.3, 1]);

  return (
    <AbsoluteFill>
      {/* Slow zoom map - rendered by parent MapBackground */}

      {/* Counter overlay */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 16,
          flexDirection: "column",
        }}
      >
        <div
          style={{
            transform: `scale(${counterScale})`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: isVertical ? 20 : 24,
              fontWeight: 700,
              color: COLORS.white,
              textShadow: "2px 2px 4px rgba(0,0,0,0.6)",
            }}
          >
            Buildings to Explore
          </span>
          <AnimatedCounter
            to={15}
            delay={fps}
            style={{
              fontFamily: lobster,
              fontSize: isVertical ? 80 : 96,
              color: COLORS.gold,
              textShadow:
                "3px 3px 0px rgba(0,0,0,0.4), 0 0 30px rgba(255,215,0,0.5)",
            }}
          />
          <span
            style={{
              fontFamily: roboto,
              fontSize: 18,
              color: COLORS.panel,
              textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            Each with unique crypto knowledge
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 3: Species Grid (5-9s, frames 150-270)
const SpeciesGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const cols = isVertical ? 2 : 4;
  const spriteSize = isVertical ? 120 : 110;
  const gridGap = isVertical ? 16 : 24;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
      }}
    >
      {/* Title */}
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 36,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
        }}
      >
        8 Unique Species
      </span>

      {/* Grid of all 8 species */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: gridGap,
          maxWidth: isVertical ? 320 : 640,
        }}
      >
        {ALL_SPECIES.map((species, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 6,
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const rotate = interpolate(entrance, [0, 1], [15, 0]);

          return (
            <div
              key={species}
              style={{
                transform: `scale(${scale}) rotate(${rotate}deg)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                width: spriteSize,
              }}
            >
              <PetSprite
                species={species}
                size={spriteSize - 20}
                enterDelay={i * 6}
                bob
              />
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 14,
                  fontWeight: 700,
                  color: COLORS.white,
                  textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                  textTransform: "capitalize",
                }}
              >
                {species}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Building Tour (9-14s, frames 270-420)
const BuildingTour: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const showcaseBuildings = [
    BUILDING_THEMES[0], // Alpha Lab
    BUILDING_THEMES[4], // DEX Trading Floor
    BUILDING_THEMES[10], // DAO HQ
    BUILDING_THEMES[13], // DeFi Terminal
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 16 : 20,
        flexDirection: "column",
        padding: isVertical ? 40 : 60,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          marginBottom: 8,
        }}
      >
        Crypto Learning Hubs
      </span>

      {showcaseBuildings.map((building, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: i * 15,
          config: SPRING_SNAPPY,
        });
        const slideX = interpolate(
          entrance,
          [0, 1],
          [i % 2 === 0 ? -500 : 500, 0]
        );
        const opacity = interpolate(entrance, [0, 0.3], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={building.name}
            style={{
              transform: `translateX(${slideX}px)`,
              opacity,
            }}
          >
            <ClawPanel width={isVertical ? 340 : 460}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                }}
              >
                <span style={{ fontSize: 32 }}>{building.icon}</span>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 20,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {building.name}
                  </span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
                      color: "#795548",
                    }}
                  >
                    {building.focus}
                  </span>
                </div>
              </div>
            </ClawPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 5: NPC Chat (14-18s, frames 420-540)
const NPCChat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 28,
        flexDirection: "column",
        padding: isVertical ? 40 : 80,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 26 : 32,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
        }}
      >
        Chat with AI NPCs
      </span>

      {/* Pet asking */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          width: "100%",
          maxWidth: isVertical ? 380 : 500,
        }}
      >
        <PetSprite species="cat" size={56} enterDelay={0} bob={false} />
        <SpeechBubble
          text="How does Jupiter route my swaps?"
          delay={8}
          maxWidth={isVertical ? 260 : 340}
        />
      </div>

      {/* NPC replying */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          width: "100%",
          maxWidth: isVertical ? 380 : 500,
          flexDirection: "row-reverse",
        }}
      >
        <PetSprite
          species="owl"
          size={56}
          enterDelay={fps}
          bob={false}
          flipX
        />
        <SpeechBubble
          text="Jupiter splits your trade across multiple DEXs to find the best price with minimal slippage!"
          delay={fps * 1.5}
          direction="right"
          maxWidth={isVertical ? 260 : 340}
        />
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (18-20s, frames 540-600)
const CTAScene: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <CTAButton text="Explore the World" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S02 composition (20s)
export const WorldOfClawville: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-explore-buildings.mp4" startFrom={1} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={20} color={COLORS.gold} speed={0.4} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="The World of ClawVille"
          subtitle="15 buildings, 8 species, endless learning"
        />
      </Sequence>

      {/* Scene 2: Map Overview (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <MapOverview />
      </Sequence>

      {/* Scene 3: Species Grid (5-9s) */}
      <Sequence from={5 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <SpeciesGrid />
      </Sequence>

      {/* Scene 4: Building Tour (9-14s) */}
      <Sequence from={9 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <BuildingTour />
      </Sequence>

      {/* Scene 5: NPC Chat (14-18s) */}
      <Sequence from={14 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <NPCChat />
      </Sequence>

      {/* Scene 6: CTA (18-20s) */}
      <Sequence from={18 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
