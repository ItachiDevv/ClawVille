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
import { ClawTokenIcon } from "../shared/ClawTokenIcon";
import { AnimatedCounter } from "../shared/AnimatedCounter";
import { NeopetsPanel } from "../shared/NeopetsPanel";
import { PetSprite } from "../shared/PetSprite";
import { BookIcon } from "../shared/BookIcon";
import { StatBar } from "../shared/StatBar";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../constants/timing";
import { EARN_METHODS } from "../../constants/buildings";
import { PARADE_BOOKS } from "../../constants/books";

const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Hook (0-3s, frames 0-90)
const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Giant ClawTokenIcon entrance
  const coinEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const coinScale = interpolate(coinEntrance, [0, 1], [0.2, 1]);
  const coinOpacity = interpolate(coinEntrance, [0, 0.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Text entrance
  const textEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 1.2),
    config: SPRING_SNAPPY,
  });
  const textY = interpolate(textEntrance, [0, 1], [40, 0]);
  const textOpacity = interpolate(textEntrance, [0, 0.5], [0, 1], {
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
      {/* Giant ClawToken coin */}
      <div
        style={{
          transform: `scale(${coinScale})`,
          opacity: coinOpacity,
          marginBottom: 24,
        }}
      >
        <ClawTokenIcon size={120} />
      </div>

      {/* Animated counter */}
      <AnimatedCounter
        from={0}
        to={100}
        delay={10}
        style={{
          fontFamily: roboto,
          fontSize: 64,
          fontWeight: 700,
          color: COLORS.clawToken,
          textShadow: "0 0 20px rgba(255,215,0,0.4)",
        }}
      />

      {/* Subtitle text */}
      <div
        style={{
          marginTop: 20,
          opacity: textOpacity,
          transform: `translateY(${textY}px)`,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 26,
            fontWeight: 400,
            color: COLORS.panel,
            textShadow: "1px 1px 4px rgba(0,0,0,0.5)",
          }}
        >
          Every lobster starts with 100 ClawTokens
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Earn Methods (3-9s, frames 90-270)
const EarnMethodsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "column",
          flexWrap: isVertical ? "nowrap" : "wrap",
          gap: isVertical ? 18 : 14,
          alignItems: "center",
          justifyContent: "center",
          maxWidth: isVertical ? "90%" : "85%",
        }}
      >
        {EARN_METHODS.map((method, i) => {
          const fromLeft = i % 2 === 0;
          const entrance = spring({
            frame,
            fps,
            delay: Math.round(i * 0.4 * fps),
            config: SPRING_SNAPPY,
          });
          const slideX = interpolate(
            entrance,
            [0, 1],
            [fromLeft ? -400 : 400, 0]
          );
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={method.label}
              style={{
                transform: `translateX(${slideX}px)`,
                opacity,
              }}
            >
              <NeopetsPanel width={isVertical ? 360 : 420}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                  }}
                >
                  <span style={{ fontSize: 32 }}>{method.icon}</span>
                  <div style={{ flex: 1 }}>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 18,
                        fontWeight: 700,
                        color: COLORS.panel,
                      }}
                    >
                      {method.label}
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 17,
                      fontWeight: 700,
                      color: COLORS.clawToken,
                    }}
                  >
                    {method.reward}
                  </span>
                </div>
              </NeopetsPanel>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Spend on Books (9-14s, frames 270-420)
const SpendOnBooksScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const first3Books = PARADE_BOOKS.slice(0, 3);

  // Counter starts after 1.5s, finishes by 3s
  const counterDelay = Math.round(fps * 1.5);

  // "+Knowledge" text springs in after counter finishes (~3.5s into scene)
  const knowledgeEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 3.2),
    config: SPRING_BOUNCY,
  });
  const knowledgeScale = interpolate(knowledgeEntrance, [0, 1], [0.3, 1]);
  const knowledgeOpacity = interpolate(knowledgeEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // StatBar appears after knowledge text
  const statBarDelay = Math.round(fps * 3.8);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      {/* Book grid */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          gap: isVertical ? 24 : 36,
          justifyContent: "center",
          alignItems: "flex-start",
        }}
      >
        {first3Books.map((book, i) => (
          <BookIcon
            key={book.id}
            icon={book.icon}
            name={book.name}
            price={book.price}
            size={isVertical ? 65 : 80}
            delay={i * 8}
          />
        ))}
      </div>

      {/* Pet sprite below books */}
      <PetSprite species="cat" size={80} enterDelay={5} bob />

      {/* Counter counting down from 100 to 55 */}
      <AnimatedCounter
        from={100}
        to={55}
        delay={counterDelay}
        style={{
          fontFamily: roboto,
          fontSize: 48,
          fontWeight: 700,
          color: COLORS.danger,
          textShadow: "0 0 12px rgba(244,67,54,0.4)",
        }}
        prefix=""
        suffix=" CT"
      />

      {/* "+Knowledge" text */}
      <div
        style={{
          opacity: knowledgeOpacity,
          transform: `scale(${knowledgeScale})`,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 32,
            fontWeight: 700,
            color: COLORS.info,
            textShadow: "0 0 12px rgba(33,150,243,0.4)",
          }}
        >
          +Knowledge
        </span>
      </div>

      {/* Knowledge stat bar */}
      <StatBar
        label="Knowledge"
        value={0.6}
        delay={statBarDelay}
        width={isVertical ? 220 : 280}
        color={COLORS.info}
      />
    </AbsoluteFill>
  );
};

// Scene 4: Growth Loop (14-17s, frames 420-510)
const GrowthLoopScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const loopNodes = [
    { label: "Earn", x: 0, y: -100 },     // top
    { label: "Buy", x: 100, y: 0 },       // right
    { label: "Learn", x: 0, y: 100 },     // bottom
    { label: "Level Up", x: -100, y: 0 },  // left
  ];

  // Arrows between nodes: top->right, right->bottom, bottom->left, left->top
  const arrows = [
    { fromIdx: 0, toIdx: 1, char: "\u2192" },
    { fromIdx: 1, toIdx: 2, char: "\u2193" },
    { fromIdx: 2, toIdx: 3, char: "\u2190" },
    { fromIdx: 3, toIdx: 0, char: "\u2191" },
  ];

  // Center text entrance
  const centerEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 1.8),
    config: SPRING_SMOOTH,
  });
  const centerOpacity = interpolate(centerEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const centerScale = interpolate(centerEntrance, [0, 1], [0.7, 1]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Loop nodes in diamond arrangement */}
      <div
        style={{
          position: "relative",
          width: 300,
          height: 300,
        }}
      >
        {loopNodes.map((node, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 6,
            config: SPRING_BOUNCY,
          });
          const scale = interpolate(entrance, [0, 1], [0, 1]);
          const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={node.label}
              style={{
                position: "absolute",
                left: 150 + node.x - 55,
                top: 150 + node.y - 22,
                transform: `scale(${scale})`,
                opacity,
              }}
            >
              <NeopetsPanel
                style={{
                  borderRadius: 50,
                  padding: "12px 20px",
                  textAlign: "center",
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 16,
                    fontWeight: 700,
                    color: COLORS.panel,
                    whiteSpace: "nowrap",
                  }}
                >
                  {node.label}
                </span>
              </NeopetsPanel>
            </div>
          );
        })}

        {/* Arrows between nodes */}
        {arrows.map((arrow, i) => {
          const from = loopNodes[arrow.fromIdx];
          const to = loopNodes[arrow.toIdx];
          const midX = 150 + (from.x + to.x) / 2;
          const midY = 150 + (from.y + to.y) / 2;

          const arrowEntrance = spring({
            frame,
            fps,
            delay: Math.round(fps * 0.8) + i * 6,
            config: SPRING_SNAPPY,
          });
          const arrowOpacity = interpolate(arrowEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });
          const arrowScale = interpolate(arrowEntrance, [0, 1], [0, 1]);

          return (
            <div
              key={`arrow-${i}`}
              style={{
                position: "absolute",
                left: midX - 12,
                top: midY - 12,
                fontSize: 24,
                color: COLORS.clawToken,
                opacity: arrowOpacity,
                transform: `scale(${arrowScale})`,
                textShadow: "0 0 8px rgba(255,215,0,0.5)",
              }}
            >
              {arrow.char}
            </div>
          );
        })}

        {/* Center text */}
        <div
          style={{
            position: "absolute",
            left: 150 - 100,
            top: 150 - 12,
            width: 200,
            textAlign: "center",
            opacity: centerOpacity,
            transform: `scale(${centerScale})`,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 13,
              fontWeight: 400,
              color: COLORS.panel,
              textShadow: "1px 1px 3px rgba(0,0,0,0.6)",
            }}
          >
            A self-reinforcing growth loop
          </span>
        </div>
      </div>

      {/* CTA Button at bottom */}
      <div style={{ marginTop: 40 }}>
        <CTAButton text="Start Earning" delay={Math.round(fps * 2)} />
      </div>
    </AbsoluteFill>
  );
};

// Main Video 12 composition — 17s (510 frames at 30fps)
export const ClawTokenEconomy2: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      {/* Scene 1: Hook (0-3s) */}
      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <HookScene />
      </Sequence>

      {/* Scene 2: Earn Methods (3-9s) */}
      <Sequence from={3 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <EarnMethodsScene />
      </Sequence>

      {/* Scene 3: Spend on Books (9-14s) */}
      <Sequence from={9 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <SpendOnBooksScene />
      </Sequence>

      {/* Scene 4: Growth Loop (14-17s) */}
      <Sequence from={14 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <GrowthLoopScene />
      </Sequence>
    </AbsoluteFill>
  );
};
