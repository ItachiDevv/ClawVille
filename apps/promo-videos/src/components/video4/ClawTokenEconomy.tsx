import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { MapBackground } from "../shared/MapBackground";
import { ParticleField } from "../shared/ParticleField";
import { ClawTokenIcon } from "../shared/ClawTokenIcon";
import { ClawPanel } from "../shared/ClawPanel";
import { StatBar } from "../shared/StatBar";
import { PetSprite } from "../shared/PetSprite";
import { CTAButton } from "../shared/CTAButton";
import { LogoReveal } from "../shared/LogoReveal";
import { COLORS } from "../../constants/colors";
import { SPRING_BOUNCY, SPRING_SNAPPY, SPRING_SMOOTH, FPS } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Seeded random for coin positions
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Scene 1: Coin Rain (0-2.5s, frames 0-75)
const CoinRain: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const coins = useMemo(
    () =>
      Array.from({ length: 35 }, (_, i) => ({
        x: seededRandom(i * 3) * width,
        startY: -50 - seededRandom(i * 5) * 200,
        speed: 150 + seededRandom(i * 7) * 200,
        size: 20 + seededRandom(i * 11) * 20,
        phase: seededRandom(i * 13) * Math.PI * 2,
      })),
    [width]
  );

  const titleEntrance = spring({
    frame,
    fps,
    delay: 15,
    config: SPRING_BOUNCY,
  });
  const titleScale = interpolate(titleEntrance, [0, 1], [0.3, 1]);

  return (
    <AbsoluteFill>
      {/* Falling coins */}
      {coins.map((coin, i) => {
        const t = frame / fps;
        const y = coin.startY + coin.speed * t;
        if (y > height + 50) return null;
        const wobbleX = Math.sin(t * 3 + coin.phase) * 15;
        const rotation = (t * 180 + coin.phase * 57) % 360;
        const opacity = interpolate(y, [-50, 0, height * 0.8, height], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: coin.x + wobbleX,
              top: y,
              opacity,
              transform: `rotate(${rotation}deg)`,
            }}
          >
            <ClawTokenIcon size={coin.size} />
          </div>
        );
      })}

      {/* Title */}
      <div
        style={{
          position: "absolute",
          width: "100%",
          top: height / 2 - 40,
          textAlign: "center",
          transform: `scale(${titleScale})`,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 56,
            color: COLORS.clawToken,
            textShadow: `
              3px 3px 0px rgba(0,0,0,0.3),
              0 0 30px rgba(255,215,0,0.5)
            `,
          }}
        >
          ClawTokens
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Earning Methods (2.5-7s, frames 75-210)
const EarningMethods: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const methods = [
    { icon: "\u{1F3E0}", action: "Visit a Building", reward: "+1 CT" },
    { icon: "\u{1F4AC}", action: "Chat with NPCs", reward: "+1 CT" },
    { icon: "\u{2694}\u{FE0F}", action: "Win Arena Battles", reward: "+5 CT" },
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 34,
          color: COLORS.clawToken,
          textShadow: "2px 2px 0px rgba(0,0,0,0.3)",
          marginBottom: 20,
        }}
      >
        Earn ClawTokens
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: isVertical ? 20 : 16,
          alignItems: "center",
        }}
      >
        {methods.map((method, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: i * 15,
            config: SPRING_SNAPPY,
          });
          const slideX = interpolate(
            entrance,
            [0, 1],
            [i % 2 === 0 ? -300 : 300, 0]
          );
          const opacity = interpolate(entrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={method.action}
              style={{ transform: `translateX(${slideX}px)`, opacity }}
            >
              <ClawPanel width={isVertical ? 380 : 420}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                  }}
                >
                  <span style={{ fontSize: 36 }}>{method.icon}</span>
                  <div style={{ flex: 1 }}>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 20,
                        fontWeight: 700,
                        color: COLORS.primary,
                      }}
                    >
                      {method.action}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <ClawTokenIcon size={24} />
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 20,
                        fontWeight: 700,
                        color: COLORS.secondary,
                      }}
                    >
                      {method.reward}
                    </span>
                  </div>
                </div>
              </ClawPanel>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Shop Mockup (7-12s, frames 210-360)
const ShopMockup: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Token counter animation: 100 -> 88 when purchase happens at frame 90
  const purchaseFrame = fps * 3;
  const purchaseHappened = frame >= purchaseFrame;
  const tokenCount = purchaseHappened
    ? interpolate(frame, [purchaseFrame, purchaseFrame + 10], [100, 88], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 100;

  // Purchase flash
  const purchaseFlash = purchaseHappened
    ? interpolate(
        frame,
        [purchaseFrame, purchaseFrame + 5, purchaseFrame + 15],
        [0, 0.5, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      )
    : 0;

  // Cursor animation moving to buy button
  const cursorProgress = interpolate(
    frame,
    [fps * 1.5, purchaseFrame - 5],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.quad),
    }
  );

  const cursorStartX = width * 0.7;
  const cursorStartY = height * 0.3;
  const cursorEndX = width * 0.5 + 60;
  const cursorEndY = height * 0.5 + 50;
  const cursorX = interpolate(cursorProgress, [0, 1], [cursorStartX, cursorEndX]);
  const cursorY = interpolate(cursorProgress, [0, 1], [cursorStartY, cursorEndY]);

  return (
    <AbsoluteFill>
      {/* Purchase flash */}
      <AbsoluteFill
        style={{
          backgroundColor: COLORS.clawToken,
          opacity: purchaseFlash,
        }}
      />

      {/* Token counter */}
      <div
        style={{
          position: "absolute",
          top: 40,
          right: 40,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(0,0,0,0.5)",
          borderRadius: 20,
          padding: "8px 16px",
        }}
      >
        <ClawTokenIcon size={28} />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 24,
            fontWeight: 700,
            color: COLORS.clawToken,
          }}
        >
          {Math.round(tokenCount)}
        </span>
      </div>

      {/* Shop panel */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 180,
          top: height / 2 - 100,
        }}
      >
        <ClawPanel width={360}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 48 }}>{"\u{1F3E6}"}</span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 22,
                fontWeight: 700,
                color: COLORS.primary,
              }}
            >
              DeFi Deep Dive
            </span>
            <span
              style={{
                fontFamily: roboto,
                fontSize: 14,
                color: COLORS.bgGradient2,
                textAlign: "center",
              }}
            >
              AMMs, liquidity pools, yield farming
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <ClawTokenIcon size={20} />
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 18,
                  fontWeight: 700,
                  color: COLORS.secondary,
                }}
              >
                12 CT
              </span>
            </div>
            <div
              style={{
                background: purchaseHappened
                  ? COLORS.success
                  : `linear-gradient(135deg, ${COLORS.clawToken}, ${COLORS.secondary})`,
                borderRadius: 8,
                padding: "8px 24px",
                border: `2px solid ${COLORS.border}`,
                marginTop: 8,
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  fontWeight: 700,
                  color: purchaseHappened ? COLORS.panel : COLORS.primary,
                }}
              >
                {purchaseHappened ? "Purchased!" : "Buy"}
              </span>
            </div>
          </div>
        </ClawPanel>
      </div>

      {/* Animated cursor */}
      {!purchaseHappened && (
        <div
          style={{
            position: "absolute",
            left: cursorX,
            top: cursorY,
            fontSize: 24,
            filter: "drop-shadow(2px 2px 2px rgba(0,0,0,0.3))",
            transform: "rotate(-10deg)",
          }}
        >
          {"\u{1F446}"}
        </div>
      )}
    </AbsoluteFill>
  );
};

// Scene 4: Before/After Intelligence (12-16s, frames 360-480)
const IntelligenceComparison: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 30,
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
        Watch Your Lobster Grow
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 30 : 60,
          alignItems: "center",
        }}
      >
        {/* Before */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 18,
              color: COLORS.panel,
              fontWeight: 700,
            }}
          >
            Before
          </span>
          <PetSprite species="fox" size={80} enterDelay={0} bob />
          <StatBar label="DeFi" value={0.1} delay={10} width={160} color="#78909C" />
          <StatBar label="NFTs" value={0.05} delay={15} width={160} color="#78909C" />
          <StatBar label="Solana" value={0.08} delay={20} width={160} color="#78909C" />
        </div>

        {/* Arrow */}
        <div
          style={{
            fontSize: 40,
            color: COLORS.accent,
            transform: isVertical ? "rotate(90deg)" : "none",
          }}
        >
          {"\u{27A1}\u{FE0F}"}
        </div>

        {/* After */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 18,
              color: COLORS.accent,
              fontWeight: 700,
            }}
          >
            After
          </span>
          <PetSprite species="fox" size={80} enterDelay={5} bob />
          <StatBar label="DeFi" value={0.85} delay={fps + 10} width={160} color={COLORS.success} />
          <StatBar label="NFTs" value={0.7} delay={fps + 15} width={160} color={COLORS.info} />
          <StatBar label="Solana" value={0.9} delay={fps + 20} width={160} color="#7C4DFF" />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (16-18s, frames 480-540)
const EconomyCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 24 }}
    >
      <LogoReveal size={48} />
      <CTAButton text="Build Your Lobster's Empire" />
    </AbsoluteFill>
  );
};

// Main Video 4 composition
export const ClawTokenEconomy: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <MapBackground zoom={1.3} tintColor={COLORS.bg} tintOpacity={0.35} panXRange={[-0.05, 0.05]} />
      <ParticleField count={10} color={COLORS.clawToken} speed={0.3} />

      <Sequence durationInFrames={Math.round(2.5 * fps)} premountFor={fps}>
        <CoinRain />
      </Sequence>

      <Sequence
        from={Math.round(2.5 * fps)}
        durationInFrames={Math.round(4.5 * fps)}
        premountFor={fps}
      >
        <EarningMethods />
      </Sequence>

      <Sequence from={7 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <ShopMockup />
      </Sequence>

      <Sequence from={12 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <IntelligenceComparison />
      </Sequence>

      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <EconomyCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
