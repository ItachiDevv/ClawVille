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
import { AvatarSprite } from "../../shared/AvatarSprite";
import { ClawPanel } from "../../shared/ClawPanel";
import { BookIcon } from "../../shared/BookIcon";
import { TerminalBlock } from "../../shared/TerminalBlock";
import { HPBar } from "../../shared/HPBar";
import { DamageNumber } from "../../shared/DamageNumber";
import { CTAButton } from "../../shared/CTAButton";
import { PARADE_BOOKS } from "../../../constants/books";
import { MARKETPLACE_ITEMS } from "../../../constants/showcase";
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

// Scene 2: Learn Phase (1-5s, frames 30-150)
const LearnPhase: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Knowledge pills
  const knowledgePills = [
    "DeFi Strategies",
    "Token Sniping",
    "LP Management",
    "MEV Protection",
    "On-Chain Analysis",
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 20 : 24,
        padding: isVertical ? 40 : 60,
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
        Learn Crypto Skills
      </span>

      {/* Book parade */}
      <div
        style={{
          display: "flex",
          gap: isVertical ? 16 : 28,
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        {PARADE_BOOKS.slice(0, 4).map((book, i) => (
          <BookIcon
            key={book.id}
            icon={book.icon}
            name={book.name}
            price={book.price}
            size={isVertical ? 56 : 64}
            delay={i * 8}
          />
        ))}
      </div>

      {/* Knowledge pills appear */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          justifyContent: "center",
          maxWidth: isVertical ? 340 : 500,
        }}
      >
        {knowledgePills.map((pill, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: fps * 1.5 + i * 6,
            config: SPRING_SNAPPY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const y = interpolate(entrance, [0, 1], [20, 0]);

          return (
            <div
              key={pill}
              style={{
                transform: `scale(${scale}) translateY(${y}px)`,
                background: "rgba(76, 175, 80, 0.25)",
                border: `2px solid ${COLORS.green}`,
                borderRadius: 20,
                padding: "8px 16px",
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 14,
                  fontWeight: 700,
                  color: COLORS.star,
                }}
              >
                {pill}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Build Phase (5-9s, frames 150-270)
const BuildPhase: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const headerEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const headerOpacity = interpolate(headerEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 28,
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
          opacity: headerOpacity,
        }}
      >
        Export as SKILL.md
      </span>

      <TerminalBlock
        lines={[
          "clawville build --skill",
          "",
          "# CryptoWolf's Skills",
          "## DeFi Mastery (Lv. 3)",
          "- Jupiter swap routing",
          "- Raydium LP strategies",
          "- Orca whirlpool positions",
          "",
          "## Token Analysis (Lv. 2)",
          "- Pump.fun bonding curves",
          "- On-chain wallet tracking",
          "",
          "Build complete! Ready to publish.",
        ]}
        startFrame={10}
        charsPerSecond={45}
        width={isVertical ? 340 : 420}
      />
    </AbsoluteFill>
  );
};

// Scene 4: Compete Phase (9-14s, frames 270-420)
const CompetePhase: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Damage flash timing
  const hit1Frame = fps * 1.5;
  const hit2Frame = fps * 3;

  const leftHP = frame > hit2Frame ? 55 : 80;
  const rightHP = frame > hit1Frame ? 40 : 70;

  const vsEntrance = spring({
    frame,
    fps,
    delay: 10,
    config: SPRING_BOUNCY,
  });
  const vsScale = interpolate(vsEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: COLORS.red,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
        }}
      >
        Arena Battle
      </span>

      {/* Battle scene */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: isVertical ? 24 : 60,
          position: "relative",
        }}
      >
        {/* Left avatar */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <AvatarSprite species="dragon" size={isVertical ? 100 : 110} bob />
          <HPBar hp={leftHP} maxHp={100} width={isVertical ? 120 : 160} label="CryptoDragon" />
        </div>

        {/* VS badge */}
        <div
          style={{
            transform: `scale(${vsScale})`,
            fontFamily: lobster,
            fontSize: isVertical ? 36 : 44,
            color: COLORS.gold,
            textShadow:
              "2px 2px 0px rgba(0,0,0,0.5), 0 0 15px rgba(255,215,0,0.5)",
          }}
        >
          VS
        </div>

        {/* Right avatar */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <AvatarSprite
            species="wolf"
            size={isVertical ? 100 : 110}
            bob
            flipX
          />
          <HPBar hp={rightHP} maxHp={100} width={isVertical ? 120 : 160} label="AlphaWolf" />
        </div>

        {/* Damage numbers */}
        {frame > hit1Frame && (
          <DamageNumber
            damage={30}
            delay={hit1Frame}
            x={isVertical ? width * 0.55 : width * 0.58}
            y={-40}
            isCritical
          />
        )}
        {frame > hit2Frame && (
          <DamageNumber
            damage={25}
            delay={hit2Frame}
            x={isVertical ? -width * 0.1 : -width * 0.05}
            y={-30}
          />
        )}
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Marketplace (14-18s, frames 420-540)
const Marketplace: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 20,
        padding: isVertical ? 40 : 60,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 28 : 34,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
        }}
      >
        Skill Marketplace
      </span>

      {MARKETPLACE_ITEMS.map((item, i) => {
        const entrance = spring({
          frame,
          fps,
          delay: i * 12,
          config: SPRING_SNAPPY,
        });
        const slideY = interpolate(entrance, [0, 1], [60, 0]);
        const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={item.name}
            style={{
              transform: `translateY(${slideY}px)`,
              opacity,
            }}
          >
            <ClawPanel width={isVertical ? 340 : 440}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {item.name}
                  </span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 13,
                      color: "#795548",
                    }}
                  >
                    by {item.author} &middot; {item.votes} votes
                  </span>
                </div>
                <div
                  style={{
                    background: `linear-gradient(135deg, ${COLORS.gold}, #FFA000)`,
                    borderRadius: 20,
                    padding: "6px 14px",
                    border: `2px solid ${COLORS.panelBorder}`,
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {item.price} NT
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
      <CTAButton text="Start Learning" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S03 composition (20s)
export const LearnCryptoCompete: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-combat-closeup.mp4" startFrom={1} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={22} color={COLORS.gold} speed={0.5} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Learn Crypto, Build Skills, Compete"
          subtitle="From knowledge to marketplace mastery"
        />
      </Sequence>

      {/* Scene 2: Learn Phase (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <LearnPhase />
      </Sequence>

      {/* Scene 3: Build Phase (5-9s) */}
      <Sequence from={5 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <BuildPhase />
      </Sequence>

      {/* Scene 4: Compete Phase (9-14s) */}
      <Sequence from={9 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <CompetePhase />
      </Sequence>

      {/* Scene 5: Marketplace (14-18s) */}
      <Sequence from={14 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Marketplace />
      </Sequence>

      {/* Scene 6: CTA (18-20s) */}
      <Sequence from={18 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
