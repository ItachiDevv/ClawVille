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
import { PetSprite } from "../../../shared/PetSprite";
import { HPBar } from "../../../shared/HPBar";
import { DamageNumber } from "../../../shared/DamageNumber";
import { ClawPanel } from "../../../shared/ClawPanel";
import { CTAButton } from "../../../shared/CTAButton";
import { LogoReveal } from "../../../shared/LogoReveal";
import { AnimatedCounter } from "../../../shared/AnimatedCounter";
import { TitleScreen } from "../../shared/TitleScreen";
import { COLORS } from "../../../../constants/colors";
import { ARENA_SETTINGS } from "../../../../constants/showcase";
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

// Scene 2: Training Setup (1-4s, frames 30-120)
const TrainingSetup: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const panelEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const panelScale = interpolate(panelEntrance, [0, 1], [0.5, 1]);
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
          opacity: panelOpacity,
          transform: `scale(${panelScale})`,
        }}
      >
        <ClawPanel width={isVertical ? 340 : 420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <span
              style={{
                fontFamily: lobster,
                fontSize: 28,
                color: "#3E2723",
                textAlign: "center",
              }}
            >
              Arena Settings
            </span>
            {ARENA_SETTINGS.map((setting, i) => {
              const itemEntrance = spring({
                frame,
                fps,
                delay: 10 + i * 6,
                config: SPRING_SNAPPY,
              });
              const slideX = interpolate(
                itemEntrance,
                [0, 1],
                [i % 2 === 0 ? -200 : 200, 0]
              );
              const itemOpacity = interpolate(
                itemEntrance,
                [0, 0.5],
                [0, 1],
                { extrapolateRight: "clamp" }
              );

              return (
                <div
                  key={setting.label}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    opacity: itemOpacity,
                    transform: `translateX(${slideX}px)`,
                    padding: "4px 0",
                    borderBottom:
                      i < ARENA_SETTINGS.length - 1
                        ? "1px solid rgba(0,0,0,0.1)"
                        : "none",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontSize: 22 }}>{setting.icon}</span>
                    <span
                      style={{
                        fontFamily: roboto,
                        fontSize: 18,
                        fontWeight: 700,
                        color: "#3E2723",
                      }}
                    >
                      {setting.label}
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#FF6F00",
                    }}
                  >
                    {setting.value}
                  </span>
                </div>
              );
            })}
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 3: Battle Montage (4-10s, frames 120-300)
const BattleMontage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 120 : 110;
  const petSpacing = isVertical ? 80 : 160;

  // 3 rounds, each ~60 frames
  const roundLength = 60;
  const currentRound = Math.min(2, Math.floor(frame / roundLength));

  const rounds = [
    {
      leftSpecies: "fox" as const,
      rightSpecies: "cat" as const,
      leftName: "Blitz Lv8",
      rightName: "Whiskers Lv7",
      attacks: [
        { f: 10, attacker: "left", damage: 11 },
        { f: 30, attacker: "right", damage: 8 },
      ],
      leftHp: [60, 60, 52],
      rightHp: [55, 44, 44],
    },
    {
      leftSpecies: "fox" as const,
      rightSpecies: "owl" as const,
      leftName: "Blitz Lv8",
      rightName: "Hoot Lv9",
      attacks: [
        { f: 10, attacker: "right", damage: 14 },
        { f: 30, attacker: "left", damage: 10 },
      ],
      leftHp: [52, 38, 38],
      rightHp: [65, 65, 55],
    },
    {
      leftSpecies: "fox" as const,
      rightSpecies: "turtle" as const,
      leftName: "Blitz Lv9",
      rightName: "Shell Lv10",
      attacks: [
        { f: 10, attacker: "left", damage: 16 },
        { f: 30, attacker: "right", damage: 9 },
      ],
      leftHp: [52, 52, 43],
      rightHp: [70, 54, 54],
    },
  ];

  const round = rounds[currentRound];
  const roundFrame = frame - currentRound * roundLength;

  // Determine HP
  let leftHp = round.leftHp[0];
  let rightHp = round.rightHp[0];
  for (let a = 0; a < round.attacks.length; a++) {
    if (roundFrame >= round.attacks[a].f + 15) {
      leftHp = round.leftHp[a + 1];
      rightHp = round.rightHp[a + 1];
    }
  }

  const activeAttack = round.attacks.find(
    (a) => roundFrame >= a.f && roundFrame < a.f + 40
  );

  let leftOffsetX = 0;
  let rightOffsetX = 0;

  if (activeAttack) {
    const af = roundFrame - activeAttack.f;
    const lungeT = af / 25;
    const lp =
      lungeT < 0.3
        ? lungeT / 0.3
        : lungeT < 0.5
          ? 1
          : 1 - (lungeT - 0.5) / 0.5;
    const clamped = Math.max(0, Math.min(1, lp));
    const dist = 50;

    if (activeAttack.attacker === "left") {
      leftOffsetX = clamped * dist;
    } else {
      rightOffsetX = -clamped * dist;
    }

    if (af > 10 && af < 25) {
      const kbT = (af - 10) / 15;
      const kb = Math.sin(kbT * Math.PI) * 15;
      if (activeAttack.attacker === "left") rightOffsetX += kb;
      else leftOffsetX -= kb;
    }
  }

  // Screen shake
  let shakeX = 0;
  let shakeY = 0;
  if (activeAttack) {
    const af = roundFrame - activeAttack.f;
    if (af > 8 && af < 22) {
      const si = 5 * (1 - (af - 8) / 14);
      shakeX = Math.sin(af * 2.5) * si;
      shakeY = Math.cos(af * 3.1) * si * 0.5;
    }
  }

  // Round transition flash
  const roundTransition = roundFrame < 5 ? (5 - roundFrame) / 5 : 0;

  return (
    <AbsoluteFill>
      {/* Round flash */}
      <AbsoluteFill
        style={{
          backgroundColor: "white",
          opacity: roundTransition * 0.4,
        }}
      />

      {/* Round indicator */}
      <div
        style={{
          position: "absolute",
          top: isVertical ? 60 : 30,
          left: 0,
          right: 0,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 28,
            color: COLORS.gold,
            textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          }}
        >
          Round {currentRound + 1}/3
        </span>
      </div>

      <AbsoluteFill
        style={{ transform: `translate(${shakeX}px, ${shakeY}px)` }}
      >
        {/* Left avatar */}
        <div
          style={{
            position: "absolute",
            left: width / 2 - petSpacing - petSize / 2 + leftOffsetX,
            top: height / 2 - petSize / 2,
          }}
        >
          <HPBar hp={leftHp} maxHp={60} width={petSize} label={round.leftName} />
          <PetSprite
            species={round.leftSpecies}
            size={petSize}
            enterDelay={0}
            bob
          />
        </div>

        {/* Right avatar */}
        <div
          style={{
            position: "absolute",
            left: width / 2 + petSpacing - petSize / 2 + rightOffsetX,
            top: height / 2 - petSize / 2,
          }}
        >
          <HPBar
            hp={rightHp}
            maxHp={round.rightHp[0]}
            width={petSize}
            label={round.rightName}
          />
          <PetSprite
            species={round.rightSpecies}
            size={petSize}
            enterDelay={0}
            flipX
            bob
          />
        </div>

        {/* Damage numbers */}
        {round.attacks.map((atk, i) => {
          const af = roundFrame - atk.f;
          if (af < 10 || af > 45) return null;
          const tx =
            atk.attacker === "left"
              ? width / 2 + petSpacing
              : width / 2 - petSpacing;
          return (
            <DamageNumber
              key={`r${currentRound}-${i}`}
              damage={atk.damage}
              delay={atk.f + 10}
              x={tx - 20}
              y={height / 2 - petSize / 2 - 20}
              isCritical={atk.damage >= 14}
            />
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 4: XP Gain (10-13s, frames 300-390)
const XPGain: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // XP counter animation
  const counterEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SMOOTH,
  });
  const counterOpacity = interpolate(counterEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Level badge pops
  const badgeEntrance = spring({
    frame,
    fps,
    delay: Math.round(fps * 1.5),
    config: SPRING_BOUNCY,
  });
  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);

  // Flash on level up
  const flashOpacity = interpolate(
    frame,
    [fps * 1.5, fps * 1.5 + 3, fps * 1.5 + 12],
    [0, 0.5, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill>
      <ParticleField count={25} color={COLORS.gold} speed={1.2} />

      {/* Flash */}
      <AbsoluteFill
        style={{ backgroundColor: COLORS.gold, opacity: flashOpacity }}
      />

      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: isVertical ? 30 : 24,
        }}
      >
        {/* XP Counter */}
        <div
          style={{
            opacity: counterOpacity,
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
              color: "rgba(255,255,255,0.7)",
              textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
            }}
          >
            Experience Earned
          </span>
          <AnimatedCounter
            from={0}
            to={500}
            delay={10}
            prefix="+"
            suffix=" XP"
            style={{
              fontFamily: lobster,
              fontSize: isVertical ? 64 : 72,
              color: COLORS.gold,
              textShadow: `2px 2px 0px rgba(0,0,0,0.4), 0 0 20px rgba(255,215,0,0.5)`,
            }}
          />
        </div>

        {/* Level badge */}
        <div
          style={{
            transform: `scale(${badgeScale})`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 100,
              height: 100,
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${COLORS.gold}, #FFA000)`,
              border: `4px solid ${COLORS.panelBorder}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 0 30px rgba(255,215,0,0.6)",
            }}
          >
            <span
              style={{
                fontFamily: lobster,
                fontSize: 36,
                color: "#3E2723",
              }}
            >
              Lv9
            </span>
          </div>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 22,
              fontWeight: 700,
              color: COLORS.gold,
              textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            Level Up!
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 5: Skills Unlocked (13-16s, frames 390-480)
const SkillsUnlocked: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const skills = [
    { icon: "\u{1F525}", label: "Fire Strike", desc: "Burn damage over time" },
    { icon: "\u{1F6E1}\uFE0F", label: "MEV Shield", desc: "Block frontrunning attacks" },
    { icon: "\u26A1", label: "Quick Swap", desc: "Instant token exchange" },
  ];

  const headerEntrance = spring({
    frame,
    fps,
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
        gap: 24,
      }}
    >
      <span
        style={{
          fontFamily: lobster,
          fontSize: 32,
          color: COLORS.gold,
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          opacity: headerOpacity,
        }}
      >
        Skills Unlocked!
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          gap: isVertical ? 16 : 24,
          alignItems: "center",
        }}
      >
        {skills.map((skill, i) => {
          const skillEntrance = spring({
            frame,
            fps,
            delay: 10 + i * 8,
            config: SPRING_BOUNCY,
          });
          const skillScale = interpolate(skillEntrance, [0, 1], [0, 1]);

          // Glow pulse
          const glowPhase = ((frame - 10 - i * 8) / fps) * Math.PI * 2;
          const glowIntensity = 8 + Math.sin(glowPhase) * 6;

          return (
            <div
              key={skill.label}
              style={{
                transform: `scale(${skillScale})`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 16,
                  background: `linear-gradient(135deg, ${COLORS.panel}, ${COLORS.gold})`,
                  border: `3px solid ${COLORS.panelBorder}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 36,
                  boxShadow: `0 0 ${glowIntensity}px rgba(255,215,0,0.5), 4px 4px 0px rgba(0,0,0,0.2)`,
                }}
              >
                {skill.icon}
              </div>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 16,
                  fontWeight: 700,
                  color: COLORS.white,
                  textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                  textAlign: "center",
                }}
              >
                {skill.label}
              </span>
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 13,
                  color: "rgba(255,255,255,0.7)",
                  textAlign: "center",
                  maxWidth: 100,
                }}
              >
                {skill.desc}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
const TrainingCTA: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <LogoReveal size={52} />
      <CTAButton text="Start Training" subtitle="play.clawville.com/arena" />
    </AbsoluteFill>
  );
};

// Main S08 composition - 18s
export const ArenaBotTraining: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-combat-closeup.mp4" startFrom={0} tintOpacity={0.4} />
      <LiveBadge />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Arena Bot Training"
          subtitle="Train through combat"
          accentColor="#FF9800"
        />
      </Sequence>

      {/* Scene 2: Training Setup (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <TrainingSetup />
      </Sequence>

      {/* Scene 3: Battle Montage (4-10s) */}
      <Sequence from={4 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <BattleMontage />
      </Sequence>

      {/* Scene 4: XP Gain (10-13s) */}
      <Sequence from={10 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <XPGain />
      </Sequence>

      {/* Scene 5: Skills Unlocked (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <SkillsUnlocked />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <TrainingCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
