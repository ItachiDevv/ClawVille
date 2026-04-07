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
import { RecordingBackground, LiveBadge } from "../../../shared/RecordingBackground";
import { ParticleField } from "../../../shared/ParticleField";
import { NeopetsPanel } from "../../../shared/NeopetsPanel";
import { SpeechBubble } from "../../../shared/SpeechBubble";
import { BookIcon } from "../../../shared/BookIcon";
import { NeoTokenIcon } from "../../../shared/NeoTokenIcon";
import { AnimatedCounter } from "../../../shared/AnimatedCounter";
import { CTAButton } from "../../../shared/CTAButton";
import { LogoReveal } from "../../../shared/LogoReveal";
import { TitleScreen } from "../../shared/TitleScreen";
import { COLORS } from "../../../../constants/colors";
import { SPRING_BOUNCY, SPRING_SNAPPY, SPRING_SMOOTH } from "../../../../constants/timing";
import { BUILDING_THEMES } from "../../../../constants/buildings";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Map Reveal (1-5s, frames 30-150)
const MapReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Header text
  const headerEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const headerY = interpolate(headerEntrance, [0, 1], [-60, 0]);
  const headerOpacity = interpolate(headerEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Building markers pop up
  const markers = BUILDING_THEMES.slice(0, 8);
  const cols = isVertical ? 3 : 4;
  const markerSize = isVertical ? 56 : 52;
  const gap = isVertical ? 14 : 20;
  const gridW = cols * (markerSize + gap) - gap;
  const startX = (width - gridW) / 2;
  const startY = isVertical ? height * 0.4 : height * 0.35;

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          paddingTop: 40,
        }}
      >
        {/* Header */}
        <div
          style={{
            position: "absolute",
            top: isVertical ? 60 : 40,
            width: "100%",
            textAlign: "center",
            transform: `translateY(${headerY}px)`,
            opacity: headerOpacity,
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: isVertical ? 34 : 40,
              color: COLORS.gold,
              textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
            }}
          >
            15 Buildings to Discover
          </span>
        </div>

        {/* Building markers grid */}
        {markers.map((building, i) => {
          const delay = 10 + i * 5;
          const entrance = spring({
            frame,
            fps,
            delay,
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const col = i % cols;
          const row = Math.floor(i / cols);

          return (
            <div
              key={building.name}
              style={{
                position: "absolute",
                left: startX + col * (markerSize + gap),
                top: startY + row * (markerSize + gap + 20),
                width: markerSize,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                transform: `scale(${scale})`,
              }}
            >
              <div
                style={{
                  width: markerSize,
                  height: markerSize,
                  borderRadius: 12,
                  background: `linear-gradient(135deg, ${COLORS.panel}, ${COLORS.gold})`,
                  border: `3px solid ${COLORS.panelBorder}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: markerSize * 0.5,
                  boxShadow: "3px 3px 0px rgba(0,0,0,0.2)",
                }}
              >
                {building.icon}
              </div>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 11,
                  fontWeight: 700,
                  color: COLORS.white,
                  textAlign: "center",
                  textShadow: "1px 1px 2px rgba(0,0,0,0.6)",
                  maxWidth: markerSize + 10,
                }}
              >
                {building.name}
              </span>
            </div>
          );
        })}

        {/* Counter */}
        <div
          style={{
            position: "absolute",
            bottom: isVertical ? 80 : 50,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 20,
              color: COLORS.panel,
              textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            +7 more buildings...
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 3: Building Tour (5-10s, frames 150-300)
const BuildingTour: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const tourBuildings = [
    { ...BUILDING_THEMES[0], crypto: "Learn token sniping strategies" },
    { ...BUILDING_THEMES[4], crypto: "Master Jupiter aggregator routing" },
    { ...BUILDING_THEMES[9], crypto: "Track whale wallets on-chain" },
    { ...BUILDING_THEMES[7], crypto: "Explore Pump.fun & bonding curves" },
  ];

  const panelW = isVertical ? width - 80 : 400;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 16 : 14,
        flexDirection: "column",
        padding: isVertical ? 40 : 60,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 34,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          marginBottom: 8,
        }}
      >
        Crypto Knowledge Hub
      </span>

      {tourBuildings.map((b, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: i * 12,
          config: SPRING_SNAPPY,
        });
        const slideX = interpolate(
          entrance,
          [0, 1],
          [i % 2 === 0 ? -400 : 400, 0]
        );
        const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={b.name}
            style={{
              transform: `translateX(${slideX}px)`,
              opacity,
            }}
          >
            <NeopetsPanel width={panelW}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <span style={{ fontSize: 32 }}>{b.icon}</span>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {b.name}
                  </div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 14,
                      color: "#795548",
                      marginTop: 2,
                    }}
                  >
                    {b.crypto}
                  </div>
                </div>
              </div>
            </NeopetsPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: NPC Interaction (10-15s, frames 300-450)
const NPCInteraction: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Building entrance animation
  const doorOpen = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const doorScale = interpolate(doorOpen, [0, 1], [0.8, 1]);
  const doorOpacity = interpolate(doorOpen, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Book purchase pop
  const bookDelay = fps * 3;
  const bookEntrance = spring({
    frame,
    fps,
    delay: bookDelay,
    config: SPRING_BOUNCY,
  });
  const bookScale = interpolate(bookEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Building header */}
      <div
        style={{
          position: "absolute",
          top: isVertical ? 60 : 40,
          opacity: doorOpacity,
          transform: `scale(${doorScale})`,
        }}
      >
        <NeopetsPanel width={isVertical ? 300 : 360}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: 28 }}>🧪</span>
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

      {/* NPC dialogue */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          maxWidth: isVertical ? width - 60 : 500,
          padding: "0 30px",
        }}
      >
        <SpeechBubble
          text="Welcome! Want to learn token sniping?"
          delay={15}
          direction="left"
        />
        <SpeechBubble
          text="Yes! Show me the strategies!"
          delay={fps * 1.5}
          direction="right"
        />
        <SpeechBubble
          text="Here's the Alpha Sniper Playbook..."
          delay={fps * 2.5}
          direction="left"
        />
      </div>

      {/* Book purchase */}
      <div
        style={{
          position: "absolute",
          bottom: isVertical ? 100 : 70,
          transform: `scale(${bookScale})`,
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <BookIcon
          icon="🧪"
          name="Alpha Sniper Playbook"
          price={15}
          size={70}
          delay={bookDelay}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 16,
              fontWeight: 700,
              color: COLORS.green,
              textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
            }}
          >
            Purchased!
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Token Reward (15-18s, frames 450-540)
const TokenReward: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const entrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const scale = interpolate(entrance, [0, 1], [0.5, 1]);
  const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Coin spin
  const spinAngle = (frame / fps) * 360;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 34 : 40,
          color: COLORS.gold,
          textShadow: `2px 2px 0px rgba(0,0,0,0.4), 0 0 20px rgba(255,215,0,0.4)`,
        }}
      >
        Earn ClawTokens!
      </span>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <NeoTokenIcon size={isVertical ? 72 : 80} />
        <AnimatedCounter
          from={85}
          to={142}
          delay={10}
          prefix="+"
          suffix=" NT"
          style={{
            fontFamily: roboto,
            fontSize: 48,
            fontWeight: 700,
            color: COLORS.gold,
            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 8,
        }}
      >
        {[
          { label: "NPC Chat", reward: "+1 NT/msg" },
          { label: "Building Visit", reward: "+1 NT" },
          { label: "Book Purchase", reward: "Knowledge + XP" },
        ].map((item, i) => {
          const itemEntrance = spring({
            frame,
            fps,
            delay: 15 + i * 8,
            config: SPRING_SNAPPY,
          });
          const itemOpacity = interpolate(itemEntrance, [0, 1], [0, 1]);
          const slideX = interpolate(itemEntrance, [0, 1], [30, 0]);

          return (
            <div
              key={item.label}
              style={{
                opacity: itemOpacity,
                transform: `translateX(${slideX}px)`,
                display: "flex",
                gap: 12,
                alignItems: "center",
                fontFamily: roboto,
                fontSize: 18,
                color: COLORS.white,
                textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
              }}
            >
              <span style={{ color: COLORS.green, fontWeight: 700 }}>{item.reward}</span>
              <span>{item.label}</span>
            </div>
          );
        })}
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
      <LogoReveal size={56} />
      <CTAButton text="Explore Now" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S13 composition (20s)
export const ExploreTheDepths: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="game-explore-buildings.mp4" startFrom={3} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={20} color={COLORS.green} speed={0.6} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Explore The Depths"
          subtitle="15 buildings to discover"
          accentColor={COLORS.green}
        />
      </Sequence>

      {/* Scene 2: Map Reveal (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <MapReveal />
      </Sequence>

      {/* Scene 3: Building Tour (5-10s) */}
      <Sequence from={5 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <BuildingTour />
      </Sequence>

      {/* Scene 4: NPC Interaction (10-15s) */}
      <Sequence from={10 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <NPCInteraction />
      </Sequence>

      {/* Scene 5: Token Reward (15-18s) */}
      <Sequence from={15 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <TokenReward />
      </Sequence>

      {/* Scene 6: CTA (18-20s) */}
      <Sequence from={18 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
