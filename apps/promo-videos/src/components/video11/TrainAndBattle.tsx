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
import { GradientBackground } from "../shared/GradientBackground";
import { MapBackground } from "../shared/MapBackground";
import { PetSprite } from "../shared/PetSprite";
import { ClawPanel } from "../shared/ClawPanel";
import { SpeechBubble } from "../shared/SpeechBubble";
import { ClawTokenIcon } from "../shared/ClawTokenIcon";
import { BookIcon } from "../shared/BookIcon";
import { DamageNumber } from "../shared/DamageNumber";
import { HPBar } from "../shared/HPBar";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import { FPS, SPRING_BOUNCY, SPRING_SNAPPY } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Hook — Split screen (0-3s, frames 0-90)
const SplitHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // LEARN text spring
  const learnEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_BOUNCY,
  });
  const learnScale = interpolate(learnEntrance, [0, 1], [0.3, 1]);
  const learnOpacity = interpolate(learnEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // FIGHT text spring
  const fightEntrance = spring({
    frame,
    fps,
    delay: 15,
    config: SPRING_BOUNCY,
  });
  const fightScale = interpolate(fightEntrance, [0, 1], [0.3, 1]);
  const fightOpacity = interpolate(fightEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Divider flash
  const dividerOpacity = interpolate(frame, [20, 25, 40], [0, 0.8, 0.3], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      {/* Left half — green tones */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: width / 2,
          height,
          overflow: "hidden",
        }}
      >
        <GradientBackground colors={[COLORS.primary, COLORS.bgGradient2, COLORS.bgGradient3]} />
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: 56,
              fontWeight: 700,
              color: COLORS.panel,
              opacity: learnOpacity,
              transform: `scale(${learnScale})`,
              textShadow: `
                2px 2px 0px rgba(0,0,0,0.3),
                0 0 20px rgba(255,255,255,0.3)
              `,
            }}
          >
            LEARN
          </span>
        </div>
      </div>

      {/* Right half — dark/red tones */}
      <div
        style={{
          position: "absolute",
          left: width / 2,
          top: 0,
          width: width / 2,
          height,
          overflow: "hidden",
        }}
      >
        <GradientBackground colors={[COLORS.bg, "#2d1111", "#1a0505"]} />
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: 56,
              fontWeight: 700,
              color: COLORS.danger,
              opacity: fightOpacity,
              transform: `scale(${fightScale})`,
              textShadow: `
                2px 2px 0px rgba(0,0,0,0.3),
                0 0 20px rgba(244,67,54,0.3)
              `,
            }}
          >
            FIGHT
          </span>
        </div>
      </div>

      {/* Center divider line */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 2,
          top: 0,
          width: 4,
          height,
          backgroundColor: COLORS.clawToken,
          opacity: dividerOpacity,
          boxShadow: `0 0 15px ${COLORS.clawToken}`,
        }}
      />
    </AbsoluteFill>
  );
};

// Scene 2: World Mode (3-8s, frames 90-240)
const WorldMode: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 120 : 100;

  // Chat panel slides in from right
  const panelEntrance = spring({
    frame,
    fps,
    delay: 15,
    config: SPRING_SNAPPY,
  });
  const panelSlideX = interpolate(panelEntrance, [0, 1], [300, 0]);
  const panelOpacity = interpolate(panelEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Book + Knowledge text entrance
  const bookEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.5 * fps),
    config: SPRING_BOUNCY,
  });
  const bookScale = interpolate(bookEntrance, [0, 1], [0, 1]);
  const bookOpacity = interpolate(bookEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // ClawToken entrance
  const tokenEntrance = spring({
    frame,
    fps,
    delay: Math.round(3.2 * fps),
    config: SPRING_BOUNCY,
  });
  const tokenScale = interpolate(tokenEntrance, [0, 1], [0, 1]);
  const tokenOpacity = interpolate(tokenEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  const panelX = isVertical ? width * 0.1 : width * 0.5;
  const panelWidth = isVertical ? width * 0.8 : 340;

  return (
    <AbsoluteFill>
      <MapBackground zoom={1.3} tintColor="#000" tintOpacity={0.1} />

      {/* Fox pet center-left */}
      <div
        style={{
          position: "absolute",
          left: isVertical ? width * 0.2 : width * 0.2,
          top: height * 0.4,
        }}
      >
        <PetSprite species="fox" size={petSize} enterDelay={5} bob />
      </div>

      {/* Chat panel sliding in from right */}
      <div
        style={{
          position: "absolute",
          left: panelX,
          top: isVertical ? height * 0.2 : height * 0.15,
          opacity: panelOpacity,
          transform: `translateX(${panelSlideX}px)`,
          width: panelWidth,
        }}
      >
        <ClawPanel width={panelWidth}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <SpeechBubble
              text="Bonding curves follow y = x\u00B2..."
              direction="left"
              delay={20}
              maxWidth={panelWidth - 60}
            />

            {/* Book + Knowledge */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                opacity: bookOpacity,
                transform: `scale(${bookScale})`,
              }}
            >
              <BookIcon
                icon="📖"
                name=""
                price={0}
                size={40}
                style={{ flexShrink: 0 }}
              />
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 18,
                  fontWeight: 700,
                  color: COLORS.success,
                }}
              >
                +Knowledge
              </span>
            </div>

            {/* ClawToken reward */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                opacity: tokenOpacity,
                transform: `scale(${tokenScale})`,
              }}
            >
              <ClawTokenIcon size={28} />
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 18,
                  fontWeight: 700,
                  color: COLORS.clawToken,
                }}
              >
                +1 CT
              </span>
            </div>
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Arena Mode (8-13s, frames 240-390)
const ArenaMode: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = 100;

  // Dragon slides in from left
  const dragonEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const dragonX = interpolate(
    dragonEntrance,
    [0, 1],
    [-200, isVertical ? width * 0.15 : width * 0.25]
  );

  // Wolf slides in from right
  const wolfEntrance = spring({
    frame,
    fps,
    delay: 12,
    config: SPRING_SNAPPY,
  });
  const wolfX = interpolate(
    wolfEntrance,
    [0, 1],
    [width + 200, isVertical ? width * 0.6 : width * 0.6]
  );

  // Level up banner entrance
  const bannerEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.5 * fps),
    config: SPRING_BOUNCY,
  });
  const bannerScale = interpolate(bannerEntrance, [0, 1], [0, 1]);
  const bannerOpacity = interpolate(bannerEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  const centerY = height * 0.5;

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bg, "#1a1020", "#0d0818"]} />

      {/* Dragon from left */}
      <div
        style={{
          position: "absolute",
          left: dragonX,
          top: centerY - petSize / 2,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <PetSprite species="dragon" size={petSize} enterDelay={5} bob />
      </div>

      {/* Wolf from right */}
      <div
        style={{
          position: "absolute",
          left: wolfX,
          top: centerY - petSize / 2,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <PetSprite species="wolf" size={petSize} enterDelay={12} flipX bob />
        {/* HP bar below wolf */}
        <div style={{ marginTop: 8 }}>
          <HPBar hp={42} maxHp={72} width={200} />
        </div>
      </div>

      {/* Damage number at center */}
      <DamageNumber
        damage={15}
        delay={1 * fps}
        x={width / 2 - 20}
        y={centerY - 60}
        isCritical={false}
      />

      {/* Level up banner at top */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 150,
          top: isVertical ? height * 0.2 : height * 0.12,
          width: 300,
          opacity: bannerOpacity,
          transform: `scale(${bannerScale})`,
        }}
      >
        <ClawPanel
          style={{
            textAlign: "center",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 24,
              fontWeight: 700,
              color: COLORS.clawToken,
              textShadow: `0 0 10px rgba(255,215,0,0.5)`,
            }}
          >
            Reached Lv 5!
          </span>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (13-15s, frames 390-450)
const TrainBattleCTA: React.FC = () => {
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
          Two modes. Infinite training.
        </span>
      </div>
      <CTAButton text="Choose Your Mode" delay={15} />
    </AbsoluteFill>
  );
};

// Main Video 11 composition
export const TrainAndBattle: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bg, COLORS.bgGradient2, COLORS.bgGradient3]} />

      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <SplitHook />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <WorldMode />
      </Sequence>

      <Sequence from={8 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <ArenaMode />
      </Sequence>

      <Sequence from={13 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <TrainBattleCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
