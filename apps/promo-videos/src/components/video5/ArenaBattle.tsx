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
import { MapBackground } from "../shared/MapBackground";
import { ParticleField } from "../shared/ParticleField";
import { PetSprite } from "../shared/PetSprite";
import { HPBar } from "../shared/HPBar";
import { DamageNumber } from "../shared/DamageNumber";
import { CTAButton } from "../shared/CTAButton";
import { LogoReveal } from "../shared/LogoReveal";
import { COLORS } from "../../constants/colors";
import { FPS, SPRING_BOUNCY, SPRING_SNAPPY } from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 1: Faceoff (0-3s, frames 0-90)
const Faceoff: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Abyssal slides in from left
  const abyssalSlide = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const abyssalX = interpolate(abyssalSlide, [0, 1], [-200, 0]);

  // Crusher slides in from right
  const crusherSlide = spring({
    frame,
    fps,
    delay: 8,
    config: SPRING_SNAPPY,
  });
  const crusherX = interpolate(crusherSlide, [0, 1], [200, 0]);

  // VS text
  const vsEntrance = spring({
    frame,
    fps,
    delay: 20,
    config: SPRING_BOUNCY,
  });
  const vsScale = interpolate(vsEntrance, [0, 1], [3, 1]);
  const vsOpacity = interpolate(vsEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Flash on VS appear
  const flashOpacity = interpolate(frame, [20, 22, 30], [0, 0.6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const petSize = isVertical ? 160 : 140;
  const petSpacing = isVertical ? 100 : 180;

  return (
    <AbsoluteFill>
      {/* Flash */}
      <AbsoluteFill
        style={{
          backgroundColor: "white",
          opacity: flashOpacity,
        }}
      />

      {/* Abyssal (left) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - petSpacing - petSize / 2 + abyssalX,
          top: height / 2 - petSize / 2 - 30,
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
            color: COLORS.panel,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Drake Lv12
        </span>
        <HPBar hp={85} maxHp={85} width={petSize} />
        <PetSprite species="dragon" size={petSize} enterDelay={0} bob />
      </div>

      {/* Crusher (right) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + petSpacing - petSize / 2 + crusherX,
          top: height / 2 - petSize / 2 - 30,
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
            color: COLORS.panel,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Shadow Lv10
        </span>
        <HPBar hp={72} maxHp={72} width={petSize} />
        <PetSprite species="wolf" size={petSize} enterDelay={8} flipX bob />
      </div>

      {/* VS Text */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 60,
          top: height / 2 - 40,
          width: 120,
          textAlign: "center",
          opacity: vsOpacity,
          transform: `scale(${vsScale})`,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 64,
            color: COLORS.danger,
            textShadow: `
              3px 3px 0px rgba(0,0,0,0.4),
              0 0 20px rgba(255,82,82,0.5)
            `,
          }}
        >
          VS
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Attack Exchanges (3-10s, frames 90-300)
const AttackExchanges: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 140 : 120;
  const petSpacing = isVertical ? 100 : 180;

  // 3 attack exchanges at frames 0, 70, 140
  const attacks = [
    { frame: 0, attacker: "dragon", damage: 12, targetHp: 60 },
    { frame: 70, attacker: "wolf", damage: 8, targetHp: 77 },
    { frame: 140, attacker: "dragon", damage: 18, targetHp: 42 },
  ];

  // Calculate current HP
  let dragonHp = 85;
  let wolfHp = 72;
  for (const atk of attacks) {
    if (frame >= atk.frame + 15) {
      if (atk.attacker === "dragon") wolfHp = atk.targetHp;
      else dragonHp = atk.targetHp;
    }
  }

  // Current active attack
  const activeAttack = attacks.find(
    (a) => frame >= a.frame && frame < a.frame + 60
  );

  // Lunge calculations
  let dragonOffsetX = 0;
  let wolfOffsetX = 0;
  let dragonTilt = 0;
  let wolfTilt = 0;

  if (activeAttack) {
    const attackFrame = frame - activeAttack.frame;
    const lungeT = attackFrame / 30;
    const lungeProgress =
      lungeT < 0.3
        ? lungeT / 0.3
        : lungeT < 0.5
          ? 1
          : 1 - (lungeT - 0.5) / 0.5;
    const clampedLunge = Math.max(0, Math.min(1, lungeProgress));
    const lungeDistance = 60;

    if (activeAttack.attacker === "dragon") {
      dragonOffsetX = clampedLunge * lungeDistance;
      dragonTilt = clampedLunge * 8;
    } else {
      wolfOffsetX = -clampedLunge * lungeDistance;
      wolfTilt = -clampedLunge * 8;
    }

    // Knockback on defender
    if (attackFrame > 12 && attackFrame < 30) {
      const kbT = (attackFrame - 12) / 18;
      const knockback = Math.sin(kbT * Math.PI) * 20;
      if (activeAttack.attacker === "dragon") wolfOffsetX += knockback;
      else dragonOffsetX -= knockback;
    }
  }

  // Screen shake
  let shakeX = 0;
  let shakeY = 0;
  if (activeAttack) {
    const attackFrame = frame - activeAttack.frame;
    if (attackFrame > 10 && attackFrame < 25) {
      const shakeIntensity = 5 * (1 - (attackFrame - 10) / 15);
      shakeX = Math.sin(attackFrame * 2.5) * shakeIntensity;
      shakeY = Math.cos(attackFrame * 3.1) * shakeIntensity * 0.5;
    }
  }

  return (
    <AbsoluteFill
      style={{
        transform: `translate(${shakeX}px, ${shakeY}px)`,
      }}
    >
      {/* Dragon */}
      <div
        style={{
          position: "absolute",
          left:
            width / 2 -
            petSpacing -
            petSize / 2 +
            dragonOffsetX,
          top: height / 2 - petSize / 2,
          transform: `rotate(${dragonTilt}deg)`,
        }}
      >
        <HPBar hp={dragonHp} maxHp={85} width={petSize} label="Drake Lv12" />
        <PetSprite species="dragon" size={petSize} enterDelay={0} bob />
      </div>

      {/* Wolf */}
      <div
        style={{
          position: "absolute",
          left:
            width / 2 +
            petSpacing -
            petSize / 2 +
            wolfOffsetX,
          top: height / 2 - petSize / 2,
          transform: `rotate(${wolfTilt}deg)`,
        }}
      >
        <HPBar hp={wolfHp} maxHp={72} width={petSize} label="Shadow Lv10" />
        <PetSprite species="wolf" size={petSize} enterDelay={0} flipX bob />
      </div>

      {/* Damage numbers */}
      {attacks.map((atk, i) => {
        const attackFrame = frame - atk.frame;
        if (attackFrame < 12 || attackFrame > 50) return null;
        const targetX =
          atk.attacker === "dragon"
            ? width / 2 + petSpacing
            : width / 2 - petSpacing;
        return (
          <DamageNumber
            key={i}
            damage={atk.damage}
            delay={atk.frame + 12}
            x={targetX - 20}
            y={height / 2 - petSize / 2 - 20}
            isCritical={atk.damage >= 15}
          />
        );
      })}

      {/* Slash arcs */}
      {attacks.map((atk, i) => {
        const attackFrame = frame - atk.frame;
        if (attackFrame < 8 || attackFrame > 25) return null;
        const arcProgress = (attackFrame - 8) / 17;
        const arcOpacity = 1 - arcProgress;
        const arcX =
          atk.attacker === "dragon"
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

// Scene 3: KO + Victory (10-13s, frames 300-390)
const VictoryScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;
  const petSize = isVertical ? 160 : 140;

  // Wolf death spin
  const deathProgress = interpolate(frame, [0, fps * 1.5], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  const wolfRotation = deathProgress * 360;
  const wolfScale = 1 - deathProgress * 0.6;
  const wolfOpacity = interpolate(frame, [fps * 0.8, fps * 1.5], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const wolfY = deathProgress * 30;

  // Dragon victory bounce
  const victoryBounce = spring({
    frame,
    fps,
    delay: Math.round(fps * 0.8),
    config: SPRING_BOUNCY,
  });
  const dragonBounceY =
    Math.abs(Math.sin(((frame - fps * 0.8) / fps) * 4 * Math.PI * 2)) *
    20 *
    Math.max(0, 1 - (frame - fps * 0.8) / (fps * 2));
  const dragonScale = interpolate(victoryBounce, [0, 1], [1, 1.15]);

  // Level up banner
  const bannerEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 1.5),
    config: SPRING_BOUNCY,
  });
  const bannerScale = interpolate(bannerEntrance, [0, 1], [0, 1]);
  const bannerOpacity = interpolate(bannerEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // KO text
  const koEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: { damping: 8, mass: 0.3 },
  });
  const koScale = interpolate(koEntrance, [0, 1], [3, 1]);
  const koOpacity = interpolate(
    frame,
    [5, 10, fps * 1.5, fps * 2],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );

  return (
    <AbsoluteFill>
      <ParticleField count={30} color={COLORS.neoToken} speed={1.5} />

      {/* Crusher defeated */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + 100 - petSize / 2,
          top: height / 2 - petSize / 2 + wolfY,
          opacity: wolfOpacity,
          transform: `rotate(${wolfRotation}deg) scale(${wolfScale})`,
        }}
      >
        <PetSprite species="wolf" size={petSize} enterDelay={0} bob={false} flipX />
      </div>

      {/* Abyssal celebrating */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 100 - petSize / 2,
          top: height / 2 - petSize / 2 - dragonBounceY,
          transform: `scale(${dragonScale})`,
        }}
      >
        <PetSprite species="dragon" size={petSize} enterDelay={0} bob />
      </div>

      {/* KO text */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 60,
          top: height / 2 - 100,
          opacity: koOpacity,
          transform: `scale(${koScale})`,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 56,
            color: COLORS.danger,
            textShadow: `
              3px 3px 0px rgba(0,0,0,0.4),
              0 0 15px rgba(255,82,82,0.5)
            `,
          }}
        >
          KO!
        </span>
      </div>

      {/* Level Up Banner */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 150,
          top: isVertical ? height / 2 + 140 : height / 2 + 120,
          width: 300,
          textAlign: "center",
          opacity: bannerOpacity,
          transform: `scale(${bannerScale})`,
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.neoToken}, ${COLORS.secondary})`,
            borderRadius: 12,
            padding: "10px 24px",
            border: `3px solid ${COLORS.border}`,
            boxShadow: `0 0 20px rgba(255,215,0,0.5)`,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 24,
              fontWeight: 700,
              color: COLORS.primary,
            }}
          >
            LEVEL UP! Lv13
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: CTA (13-15s, frames 390-450)
const ArenaCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Mini leaderboard
  const leaderboard = [
    { name: "Drake", level: 13, wins: 47 },
    { name: "Shadow", level: 10, wins: 31 },
    { name: "Blaze", level: 15, wins: 62 },
  ].sort((a, b) => b.wins - a.wins);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 30,
      }}
    >
      <LogoReveal size={48} />
      <CTAButton text="Enter the Arena" />

      {/* Mini Leaderboard */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginTop: 16,
        }}
      >
        {leaderboard.map((entry, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: 10 + i * 6,
            config: { damping: 200 },
          });
          const opacity = interpolate(entrance, [0, 1], [0, 1]);
          const slideY = interpolate(entrance, [0, 1], [20, 0]);

          return (
            <div
              key={entry.name}
              style={{
                opacity,
                transform: `translateY(${slideY}px)`,
                display: "flex",
                gap: 16,
                alignItems: "center",
                fontFamily: roboto,
                fontSize: 16,
                color: COLORS.panel,
                textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
              }}
            >
              <span style={{ fontWeight: 700, color: COLORS.neoToken, width: 24 }}>
                #{i + 1}
              </span>
              <span style={{ width: 80 }}>{entry.name}</span>
              <span style={{ color: COLORS.info }}>Lv{entry.level}</span>
              <span>{entry.wins}W</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Main Video 5 composition
export const ArenaBattle: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <MapBackground zoom={1.6} tintColor="#330000" tintOpacity={0.4} panX={0.05} panYRange={[-0.03, 0.03]} />

      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <Faceoff />
      </Sequence>

      <Sequence from={3 * fps} durationInFrames={7 * fps} premountFor={fps}>
        <AttackExchanges />
      </Sequence>

      <Sequence from={10 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <VictoryScene />
      </Sequence>

      <Sequence from={13 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <ArenaCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
