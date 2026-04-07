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
import { ClawPanel } from "../../../shared/ClawPanel";
import { CTAButton } from "../../../shared/CTAButton";
import { LogoReveal } from "../../../shared/LogoReveal";
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

// Scene 2: Bot Enters (1-4s, frames 30-120)
const BotEnters: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 160 : 140;

  // Avatar scales in from 0
  const petEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);

  // "Connected" badge appears after avatar
  const badgeEntrance = spring({
    frame,
    fps,
    delay: 20,
    config: SPRING_SNAPPY,
  });
  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);
  const badgeOpacity = interpolate(badgeEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // HP bar fades in
  const hpEntrance = spring({
    frame,
    fps,
    delay: 35,
    config: SPRING_SMOOTH,
  });
  const hpOpacity = interpolate(hpEntrance, [0, 1], [0, 1]);

  // Flash when avatar appears
  const flashOpacity = interpolate(frame, [8, 12, 20], [0, 0.5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <ParticleField count={30} color={COLORS.red} speed={2} />

      {/* Flash */}
      <AbsoluteFill
        style={{ backgroundColor: COLORS.red, opacity: flashOpacity }}
      />

      {/* Avatar */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - petSize / 2,
          top: height / 2 - petSize / 2 - 20,
          transform: `scale(${petScale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: 22,
            fontWeight: 700,
            color: COLORS.white,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Blaze Lv15
        </span>
        <div style={{ opacity: hpOpacity }}>
          <HPBar hp={90} maxHp={90} width={petSize} />
        </div>
        <PetSprite species="phoenix" size={petSize} enterDelay={0} bob />
      </div>

      {/* Connected badge */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 80,
          top: isVertical ? height / 2 + petSize / 2 + 40 : height / 2 + petSize / 2 + 20,
          width: 160,
          textAlign: "center",
          opacity: badgeOpacity,
          transform: `scale(${badgeScale})`,
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #4CAF50, #2E7D32)",
            borderRadius: 20,
            padding: "8px 20px",
            border: "2px solid rgba(255,255,255,0.3)",
            boxShadow: "0 0 15px rgba(76,175,80,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 18 }}>&#x1F50C;</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 16,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            Connected
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Combat (4-10s, frames 120-300)
const Combat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 130 : 120;
  const petSpacing = isVertical ? 90 : 170;

  // 4 attack exchanges
  const attacks = [
    { frame: 0, attacker: "phoenix", damage: 14, targetHp: 68 },
    { frame: 50, attacker: "dragon", damage: 10, targetHp: 80 },
    { frame: 100, attacker: "phoenix", damage: 18, targetHp: 50 },
    { frame: 150, attacker: "dragon", damage: 12, targetHp: 68 },
  ];

  let phoenixHp = 90;
  let dragonHp = 82;
  for (const atk of attacks) {
    if (frame >= atk.frame + 15) {
      if (atk.attacker === "phoenix") dragonHp = atk.targetHp;
      else phoenixHp = atk.targetHp;
    }
  }

  const activeAttack = attacks.find(
    (a) => frame >= a.frame && frame < a.frame + 45
  );

  let phoenixOffsetX = 0;
  let dragonOffsetX = 0;
  let phoenixTilt = 0;
  let dragonTilt = 0;

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
    const lungeDistance = 55;

    if (activeAttack.attacker === "phoenix") {
      phoenixOffsetX = clampedLunge * lungeDistance;
      phoenixTilt = clampedLunge * 8;
    } else {
      dragonOffsetX = -clampedLunge * lungeDistance;
      dragonTilt = -clampedLunge * 8;
    }

    if (attackFrame > 12 && attackFrame < 30) {
      const kbT = (attackFrame - 12) / 18;
      const knockback = Math.sin(kbT * Math.PI) * 18;
      if (activeAttack.attacker === "phoenix") dragonOffsetX += knockback;
      else phoenixOffsetX -= knockback;
    }
  }

  // Screen shake
  let shakeX = 0;
  let shakeY = 0;
  if (activeAttack) {
    const attackFrame = frame - activeAttack.frame;
    if (attackFrame > 10 && attackFrame < 25) {
      const shakeIntensity = 6 * (1 - (attackFrame - 10) / 15);
      shakeX = Math.sin(attackFrame * 2.5) * shakeIntensity;
      shakeY = Math.cos(attackFrame * 3.1) * shakeIntensity * 0.5;
    }
  }

  return (
    <AbsoluteFill style={{ transform: `translate(${shakeX}px, ${shakeY}px)` }}>
      {/* Phoenix (left) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - petSpacing - petSize / 2 + phoenixOffsetX,
          top: height / 2 - petSize / 2,
          transform: `rotate(${phoenixTilt}deg)`,
        }}
      >
        <HPBar hp={phoenixHp} maxHp={90} width={petSize} label="Blaze Lv15" />
        <PetSprite species="phoenix" size={petSize} enterDelay={0} bob />
      </div>

      {/* Dragon (right) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + petSpacing - petSize / 2 + dragonOffsetX,
          top: height / 2 - petSize / 2,
          transform: `rotate(${dragonTilt}deg)`,
        }}
      >
        <HPBar hp={dragonHp} maxHp={82} width={petSize} label="Drakon Lv12" />
        <PetSprite species="dragon" size={petSize} enterDelay={0} flipX bob />
      </div>

      {/* Damage numbers */}
      {attacks.map((atk, i) => {
        const attackFrame = frame - atk.frame;
        if (attackFrame < 12 || attackFrame > 50) return null;
        const targetX =
          atk.attacker === "phoenix"
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
          atk.attacker === "phoenix"
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

// Scene 4: Victory (10-14s, frames 300-420)
const Victory: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;
  const petSize = isVertical ? 150 : 140;

  // Dragon death spin
  const deathProgress = interpolate(frame, [0, fps * 1.5], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  const dragonRotation = deathProgress * 360;
  const dragonScale = 1 - deathProgress * 0.6;
  const dragonOpacity = interpolate(frame, [fps * 0.8, fps * 1.5], [1, 0], {
    extrapolateLeft: "clamp",
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
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Phoenix victory bounce
  const victoryBounce = spring({
    frame,
    fps,
    delay: Math.round(fps * 0.8),
    config: SPRING_BOUNCY,
  });
  const phoenixScale = interpolate(victoryBounce, [0, 1], [1, 1.15]);
  const phoenixBounceY =
    Math.abs(Math.sin(((frame - fps * 0.8) / fps) * 4 * Math.PI * 2)) *
    20 *
    Math.max(0, 1 - (frame - fps * 0.8) / (fps * 2));

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

  // Knowledge pill
  const pillEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 2.5),
    config: SPRING_SNAPPY,
  });
  const pillScale = interpolate(pillEntrance, [0, 1], [0, 1]);
  const pillOpacity = interpolate(pillEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <ParticleField count={35} color={COLORS.gold} speed={1.5} />

      {/* Dragon dying */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + 100 - petSize / 2,
          top: height / 2 - petSize / 2 + deathProgress * 30,
          opacity: dragonOpacity,
          transform: `rotate(${dragonRotation}deg) scale(${dragonScale})`,
        }}
      >
        <PetSprite species="dragon" size={petSize} enterDelay={0} bob={false} flipX />
      </div>

      {/* Phoenix celebrating */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 100 - petSize / 2,
          top: height / 2 - petSize / 2 - phoenixBounceY,
          transform: `scale(${phoenixScale})`,
        }}
      >
        <PetSprite species="phoenix" size={petSize} enterDelay={0} bob />
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
            color: COLORS.red,
            textShadow: `3px 3px 0px rgba(0,0,0,0.4), 0 0 15px rgba(244,67,54,0.5)`,
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
          top: isVertical ? height / 2 + 130 : height / 2 + 110,
          width: 300,
          textAlign: "center",
          opacity: bannerOpacity,
          transform: `scale(${bannerScale})`,
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.gold}, #FFA000)`,
            borderRadius: 12,
            padding: "10px 24px",
            border: `3px solid ${COLORS.panelBorder}`,
            boxShadow: "0 0 20px rgba(255,215,0,0.5)",
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 24,
              fontWeight: 700,
              color: "#3E2723",
            }}
          >
            LEVEL UP! Lv16
          </span>
        </div>
      </div>

      {/* Knowledge pill */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 120,
          top: isVertical ? height / 2 + 190 : height / 2 + 170,
          width: 240,
          textAlign: "center",
          opacity: pillOpacity,
          transform: `scale(${pillScale})`,
        }}
      >
        <div
          style={{
            background: "rgba(33,150,243,0.9)",
            borderRadius: 20,
            padding: "8px 20px",
            border: "2px solid rgba(255,255,255,0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>&#x1F4D6;</span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: COLORS.white,
            }}
          >
            +1 Knowledge Gained
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: Knowledge Panel (14-16s, frames 420-480)
const KnowledgePanel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const knowledgeItems = [
    { icon: "\u2694\uFE0F", label: "Battle Strategy", desc: "Counter-attack timing" },
    { icon: "\u{1F6E1}\uFE0F", label: "MEV Protection", desc: "Transaction ordering defense" },
    { icon: "\u26A1", label: "Flash Loan Basics", desc: "Atomic arbitrage patterns" },
  ];

  const panelEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const panelScale = interpolate(panelEntrance, [0, 1], [0.8, 1]);
  const panelOpacity = interpolate(panelEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          transform: `scale(${panelScale})`,
          opacity: panelOpacity,
        }}
      >
        <ClawPanel width={isVertical ? 340 : 420}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 26,
                color: "#3E2723",
                textAlign: "center",
              }}
            >
              Battle Knowledge Gained
            </span>
            {knowledgeItems.map((item, i) => {
              const itemEntrance = spring({
                frame,
                fps,
                delay: 8 + i * 6,
                config: SPRING_SNAPPY,
              });
              const itemX = interpolate(itemEntrance, [0, 1], [60, 0]);
              const itemOpacity = interpolate(itemEntrance, [0, 0.5], [0, 1], {
                extrapolateRight: "clamp",
              });

              return (
                <div
                  key={item.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    opacity: itemOpacity,
                    transform: `translateX(${itemX}px)`,
                  }}
                >
                  <span style={{ fontSize: 24 }}>{item.icon}</span>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 18,
                        fontWeight: 700,
                        color: "#3E2723",
                      }}
                    >
                      {item.label}
                    </span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 14,
                        color: "#795548",
                      }}
                    >
                      {item.desc}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const ArenaCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={52} />
      <CTAButton text="Enter the Arena" subtitle="play.clawville.com/arena" />
    </AbsoluteFill>
  );
};

// Main S07 composition - 18s
export const OpenclawArena: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-battle-royale.mp4" startFrom={2} tintOpacity={0.4} />
      <LiveBadge />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="OpenClaw in the Arena"
          subtitle="Battle with your connected bot"
          accentColor="#F44336"
        />
      </Sequence>

      {/* Scene 2: Bot Enters (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <BotEnters />
      </Sequence>

      {/* Scene 3: Combat (4-10s) */}
      <Sequence from={4 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <Combat />
      </Sequence>

      {/* Scene 4: Victory (10-14s) */}
      <Sequence from={10 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Victory />
      </Sequence>

      {/* Scene 5: Knowledge Panel (14-16s) */}
      <Sequence from={14 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <KnowledgePanel />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <ArenaCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
