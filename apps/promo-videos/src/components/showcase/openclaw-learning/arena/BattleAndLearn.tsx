import React from "react";
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
import { RecordingBackground, LiveBadge } from "../../../shared/RecordingBackground";
import { ParticleField } from "../../../shared/ParticleField";
import { PetSprite } from "../../../shared/PetSprite";
import { HPBar } from "../../../shared/HPBar";
import { DamageNumber } from "../../../shared/DamageNumber";
import { NeopetsPanel } from "../../../shared/NeopetsPanel";
import { BookIcon } from "../../../shared/BookIcon";
import { CTAButton } from "../../../shared/CTAButton";
import { LogoReveal } from "../../../shared/LogoReveal";
import { TypewriterText } from "../../../shared/TypewriterText";
import { TitleScreen } from "../../shared/TitleScreen";
import { COLORS } from "../../../../constants/colors";
import {
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Pre-Battle (1-4s, frames 30-120)
const PreBattle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 140 : 130;
  const petSpacing = isVertical ? 100 : 180;

  // Wolf slides in from left
  const wolfSlide = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const wolfX = interpolate(wolfSlide, [0, 1], [-200, 0]);

  // Bunny slides in from right
  const bunnySlide = spring({
    frame,
    fps,
    delay: 8,
    config: SPRING_SNAPPY,
  });
  const bunnyX = interpolate(bunnySlide, [0, 1], [200, 0]);

  // VS text
  const vsEntrance = spring({
    frame,
    fps,
    delay: 18,
    config: SPRING_BOUNCY,
  });
  const vsScale = interpolate(vsEntrance, [0, 1], [3, 1]);
  const vsOpacity = interpolate(vsEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Flash on VS appear
  const flashOpacity = interpolate(frame, [18, 20, 28], [0, 0.5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Stats comparison panel
  const statsEntrance = spring({
    frame,
    fps,
    delay: 30,
    config: SPRING_SNAPPY,
  });
  const statsOpacity = interpolate(statsEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const statsY = interpolate(statsEntrance, [0, 1], [30, 0]);

  const stats = [
    { label: "ATK", left: 24, right: 18 },
    { label: "DEF", left: 16, right: 22 },
    { label: "SPD", left: 20, right: 14 },
  ];

  return (
    <AbsoluteFill>
      {/* Flash */}
      <AbsoluteFill
        style={{ backgroundColor: "white", opacity: flashOpacity }}
      />

      {/* Wolf (left) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - petSpacing - petSize / 2 + wolfX,
          top: height / 2 - petSize / 2 - (isVertical ? 60 : 40),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 20,
            fontWeight: 700,
            color: COLORS.white,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Fang Lv14
        </span>
        <HPBar hp={88} maxHp={88} width={petSize} />
        <PetSprite species="wolf" size={petSize} enterDelay={0} bob />
      </div>

      {/* Bunny (right) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + petSpacing - petSize / 2 + bunnyX,
          top: height / 2 - petSize / 2 - (isVertical ? 60 : 40),
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 20,
            fontWeight: 700,
            color: COLORS.white,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Hoppy Lv12
        </span>
        <HPBar hp={75} maxHp={75} width={petSize} />
        <PetSprite species="bunny" size={petSize} enterDelay={8} flipX bob />
      </div>

      {/* VS Text */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 60,
          top: height / 2 - (isVertical ? 80 : 50),
          width: 120,
          textAlign: "center",
          opacity: vsOpacity,
          transform: `scale(${vsScale})`,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 56,
            color: COLORS.red,
            textShadow: `3px 3px 0px rgba(0,0,0,0.4), 0 0 20px rgba(244,67,54,0.5)`,
          }}
        >
          VS
        </span>
      </div>

      {/* Stats comparison */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - (isVertical ? 140 : 160),
          bottom: isVertical ? 80 : 40,
          width: isVertical ? 280 : 320,
          opacity: statsOpacity,
          transform: `translateY(${statsY}px)`,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {stats.map((stat) => (
          <div
            key={stat.label}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: roboto,
              fontSize: 16,
              fontWeight: 700,
            }}
          >
            <span
              style={{
                color: stat.left > stat.right ? COLORS.green : COLORS.white,
                textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                width: 30,
                textAlign: "right",
              }}
            >
              {stat.left}
            </span>
            <span
              style={{
                color: COLORS.gold,
                textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                width: 50,
                textAlign: "center",
              }}
            >
              {stat.label}
            </span>
            <span
              style={{
                color: stat.right > stat.left ? COLORS.green : COLORS.white,
                textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                width: 30,
                textAlign: "left",
              }}
            >
              {stat.right}
            </span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Battle (4-10s, frames 120-300)
const Battle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 130 : 120;
  const petSpacing = isVertical ? 90 : 170;

  // 4 attack exchanges
  const attacks = [
    { frame: 0, attacker: "wolf", damage: 15, targetHp: 60 },
    { frame: 45, attacker: "bunny", damage: 9, targetHp: 79 },
    { frame: 90, attacker: "wolf", damage: 18, targetHp: 42 },
    { frame: 135, attacker: "bunny", damage: 11, targetHp: 68 },
  ];

  let wolfHp = 88;
  let bunnyHp = 75;
  for (const atk of attacks) {
    if (frame >= atk.frame + 15) {
      if (atk.attacker === "wolf") bunnyHp = atk.targetHp;
      else wolfHp = atk.targetHp;
    }
  }

  const activeAttack = attacks.find(
    (a) => frame >= a.frame && frame < a.frame + 40
  );

  let wolfOffsetX = 0;
  let bunnyOffsetX = 0;
  let wolfTilt = 0;
  let bunnyTilt = 0;

  if (activeAttack) {
    const af = frame - activeAttack.frame;
    const lungeT = af / 28;
    const lp =
      lungeT < 0.3
        ? lungeT / 0.3
        : lungeT < 0.5
          ? 1
          : 1 - (lungeT - 0.5) / 0.5;
    const clamped = Math.max(0, Math.min(1, lp));
    const dist = 55;

    if (activeAttack.attacker === "wolf") {
      wolfOffsetX = clamped * dist;
      wolfTilt = clamped * 8;
    } else {
      bunnyOffsetX = -clamped * dist;
      bunnyTilt = -clamped * 8;
    }

    if (af > 12 && af < 28) {
      const kbT = (af - 12) / 16;
      const kb = Math.sin(kbT * Math.PI) * 18;
      if (activeAttack.attacker === "wolf") bunnyOffsetX += kb;
      else wolfOffsetX -= kb;
    }
  }

  // Screen shake
  let shakeX = 0;
  let shakeY = 0;
  if (activeAttack) {
    const af = frame - activeAttack.frame;
    if (af > 10 && af < 24) {
      const si = 6 * (1 - (af - 10) / 14);
      shakeX = Math.sin(af * 2.5) * si;
      shakeY = Math.cos(af * 3.1) * si * 0.5;
    }
  }

  return (
    <AbsoluteFill style={{ transform: `translate(${shakeX}px, ${shakeY}px)` }}>
      {/* Wolf (left) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - petSpacing - petSize / 2 + wolfOffsetX,
          top: height / 2 - petSize / 2,
          transform: `rotate(${wolfTilt}deg)`,
        }}
      >
        <HPBar hp={wolfHp} maxHp={88} width={petSize} label="Fang Lv14" />
        <PetSprite species="wolf" size={petSize} enterDelay={0} bob />
      </div>

      {/* Bunny (right) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + petSpacing - petSize / 2 + bunnyOffsetX,
          top: height / 2 - petSize / 2,
          transform: `rotate(${bunnyTilt}deg)`,
        }}
      >
        <HPBar hp={bunnyHp} maxHp={75} width={petSize} label="Hoppy Lv12" />
        <PetSprite species="bunny" size={petSize} enterDelay={0} flipX bob />
      </div>

      {/* Damage numbers */}
      {attacks.map((atk, i) => {
        const af = frame - atk.frame;
        if (af < 12 || af > 48) return null;
        const tx =
          atk.attacker === "wolf"
            ? width / 2 + petSpacing
            : width / 2 - petSpacing;
        return (
          <DamageNumber
            key={i}
            damage={atk.damage}
            delay={atk.frame + 12}
            x={tx - 20}
            y={height / 2 - petSize / 2 - 20}
            isCritical={atk.damage >= 15}
          />
        );
      })}

      {/* Slash arcs */}
      {attacks.map((atk, i) => {
        const af = frame - atk.frame;
        if (af < 8 || af > 25) return null;
        const arcProgress = (af - 8) / 17;
        const arcOpacity = 1 - arcProgress;
        const arcX =
          atk.attacker === "wolf"
            ? width / 2 + petSpacing - 40
            : width / 2 - petSpacing + 40;

        return (
          <div
            key={`slash-${i}`}
            style={{
              position: "absolute",
              left: arcX,
              top: height / 2 - 30,
              width: 60,
              height: 60,
              borderRadius: "50%",
              border: `3px solid rgba(255,255,255,${arcOpacity})`,
              borderTopColor: "transparent",
              borderLeftColor: "transparent",
              transform: `rotate(${arcProgress * 180}deg) scale(${0.5 + arcProgress})`,
              opacity: arcOpacity,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: Knowledge Reward (10-14s, frames 300-420)
const KnowledgeReward: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Winner pet (wolf) bounces in
  const winnerEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const winnerScale = interpolate(winnerEntrance, [0, 1], [0, 1]);

  // Book appears
  const bookEntrance = spring({
    frame,
    fps,
    delay: 15,
    config: SPRING_BOUNCY,
  });

  // Typewriter text
  const textDelay = Math.round(fps * 1.2);

  // Panel fade in
  const panelEntrance = spring({
    frame,
    fps,
    delay: textDelay,
    config: SPRING_SNAPPY,
  });
  const panelOpacity = interpolate(panelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const panelY = interpolate(panelEntrance, [0, 1], [20, 0]);

  // Glow pulse on book
  const glowPhase = (frame / fps) * Math.PI * 2;
  const glowIntensity = 15 + Math.sin(glowPhase) * 10;

  return (
    <AbsoluteFill>
      <ParticleField count={20} color={COLORS.blue} speed={1} />

      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: isVertical ? 24 : 20,
        }}
      >
        {/* Winner pet + book row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 30,
            transform: `scale(${winnerScale})`,
          }}
        >
          <PetSprite species="wolf" size={isVertical ? 120 : 100} enterDelay={0} bob />
          <div
            style={{
              filter: `drop-shadow(0 0 ${glowIntensity}px rgba(33,150,243,0.5))`,
            }}
          >
            <BookIcon
              icon="\u{1F6E1}\uFE0F"
              name="MEV Protection"
              price={0}
              size={isVertical ? 70 : 60}
              delay={15}
            />
          </div>
        </div>

        {/* Learned text panel */}
        <div
          style={{
            opacity: panelOpacity,
            transform: `translateY(${panelY}px)`,
          }}
        >
          <NeopetsPanel width={isVertical ? 320 : 400}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontFamily: lobster,
                  fontSize: 22,
                  color: "#3E2723",
                }}
              >
                Knowledge Gained!
              </span>
              <TypewriterText
                text="Learned: MEV Protection - Defend against frontrunning and sandwich attacks on Solana"
                startFrame={textDelay + 5}
                charsPerSecond={40}
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  color: "#5D4037",
                  textAlign: "center",
                  lineHeight: 1.4,
                }}
              />
            </div>
          </NeopetsPanel>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (14-17s, frames 420-510)
const LearnCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={52} />
      <CTAButton text="Battle & Learn" subtitle="Every fight teaches something" />
    </AbsoluteFill>
  );
};

// Main S09 composition - 17s
export const BattleAndLearn: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-kills-respawns.mp4" startFrom={1} tintOpacity={0.45} />
      <LiveBadge />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Battle & Learn"
          subtitle="Every fight teaches something"
          accentColor="#FFD700"
        />
      </Sequence>

      {/* Scene 2: Pre-Battle (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <PreBattle />
      </Sequence>

      {/* Scene 3: Battle (4-10s) */}
      <Sequence from={4 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <Battle />
      </Sequence>

      {/* Scene 4: Knowledge Reward (10-14s) */}
      <Sequence from={10 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <KnowledgeReward />
      </Sequence>

      {/* Scene 5: CTA (14-17s) */}
      <Sequence from={14 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <LearnCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
