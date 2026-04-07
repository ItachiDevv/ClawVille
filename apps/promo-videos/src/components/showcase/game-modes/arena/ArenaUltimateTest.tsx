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
import { SPRING_BOUNCY, SPRING_SNAPPY } from "../../../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Arena Entrance (1-4s, frames 30-120)
const ArenaEntrance: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Dark frame slides in from edges
  const frameEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const frameScale = interpolate(frameEntrance, [0, 1], [1.5, 1]);
  const frameOpacity = interpolate(frameEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // "ARENA" text slams in
  const textDelay = 12;
  const textEntrance = spring({
    frame,
    fps,
    delay: textDelay,
    config: SPRING_BOUNCY,
  });
  const textScale = interpolate(textEntrance, [0, 1], [3, 1]);
  const textOpacity = interpolate(textEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Flash on text appear
  const flashOpacity = interpolate(frame, [textDelay, textDelay + 2, textDelay + 8], [0, 0.5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Subtitle
  const subDelay = 25;
  const subEntrance = spring({
    frame,
    fps,
    delay: subDelay,
    config: { damping: 200 },
  });
  const subOpacity = interpolate(subEntrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill>
      {/* Flash */}
      <AbsoluteFill style={{ backgroundColor: COLORS.red, opacity: flashOpacity }} />

      {/* Dark arena border */}
      <AbsoluteFill
        style={{
          opacity: frameOpacity,
          transform: `scale(${frameScale})`,
          border: `8px solid rgba(244,67,54,0.6)`,
          borderRadius: 24,
          margin: isVertical ? 20 : 30,
          boxShadow: `inset 0 0 60px rgba(244,67,54,0.2), 0 0 40px rgba(244,67,54,0.3)`,
        }}
      />

      {/* ARENA text */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 16,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 64 : 80,
            color: COLORS.red,
            textShadow: `
              3px 3px 0px rgba(0,0,0,0.5),
              0 0 30px rgba(244,67,54,0.5),
              0 0 60px rgba(244,67,54,0.3)
            `,
            opacity: textOpacity,
            transform: `scale(${textScale})`,
            letterSpacing: 8,
          }}
        >
          ARENA
        </span>
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 20 : 24,
            color: COLORS.white,
            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
            opacity: subOpacity,
          }}
        >
          Prove Your Skills in Battle
        </span>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene 3: Matchup (4-8s, frames 120-240)
const Matchup: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 140 : 130;
  const petSpacing = isVertical ? 90 : 160;

  // Dragon slides in from left
  const dragonSlide = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const dragonX = interpolate(dragonSlide, [0, 1], [-250, 0]);

  // Phoenix slides in from right
  const phoenixSlide = spring({
    frame,
    fps,
    delay: 6,
    config: SPRING_SNAPPY,
  });
  const phoenixX = interpolate(phoenixSlide, [0, 1], [250, 0]);

  // VS text
  const vsDelay = 18;
  const vsEntrance = spring({
    frame,
    fps,
    delay: vsDelay,
    config: SPRING_BOUNCY,
  });
  const vsScale = interpolate(vsEntrance, [0, 1], [4, 1]);
  const vsOpacity = interpolate(vsEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Flash
  const flashOpacity = interpolate(frame, [vsDelay, vsDelay + 2, vsDelay + 8], [0, 0.5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: "white", opacity: flashOpacity }} />

      {/* Dragon (left) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - petSpacing - petSize / 2 + dragonX,
          top: height / 2 - petSize / 2 - 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 18,
              fontWeight: 700,
              color: COLORS.white,
              textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            Drake
          </span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: COLORS.gold,
              background: "rgba(0,0,0,0.4)",
              padding: "2px 8px",
              borderRadius: 8,
            }}
          >
            Lv14
          </span>
        </div>
        <HPBar hp={92} maxHp={92} width={petSize} />
        <PetSprite species="dragon" size={petSize} enterDelay={0} bob />
      </div>

      {/* Phoenix (right) */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + petSpacing - petSize / 2 + phoenixX,
          top: height / 2 - petSize / 2 - 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: roboto,
              fontSize: 18,
              fontWeight: 700,
              color: COLORS.white,
              textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            Blaze
          </span>
          <span
            style={{
              fontFamily: roboto,
              fontSize: 14,
              fontWeight: 700,
              color: COLORS.gold,
              background: "rgba(0,0,0,0.4)",
              padding: "2px 8px",
              borderRadius: 8,
            }}
          >
            Lv12
          </span>
        </div>
        <HPBar hp={78} maxHp={78} width={petSize} />
        <PetSprite species="phoenix" size={petSize} enterDelay={6} flipX bob />
      </div>

      {/* VS */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 50,
          top: height / 2 - 35,
          width: 100,
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
            textShadow: `
              3px 3px 0px rgba(0,0,0,0.4),
              0 0 20px rgba(244,67,54,0.5)
            `,
          }}
        >
          VS
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Scene 4: Battle (8-13s, frames 240-390)
const Battle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 130 : 120;
  const petSpacing = isVertical ? 90 : 160;

  // 4 attack exchanges
  const attacks = [
    { frame: 0, attacker: "dragon", damage: 14, targetHp: 64 },
    { frame: 40, attacker: "phoenix", damage: 10, targetHp: 82 },
    { frame: 80, attacker: "dragon", damage: 22, targetHp: 42 },
    { frame: 120, attacker: "phoenix", damage: 8, targetHp: 74 },
  ];

  let dragonHp = 92;
  let phoenixHp = 78;
  for (const atk of attacks) {
    if (frame >= atk.frame + 12) {
      if (atk.attacker === "dragon") phoenixHp = atk.targetHp;
      else dragonHp = atk.targetHp;
    }
  }

  // Lunge for current active attack
  const activeAttack = attacks.find(
    (a) => frame >= a.frame && frame < a.frame + 35
  );

  let dragonOffsetX = 0;
  let phoenixOffsetX = 0;

  if (activeAttack) {
    const af = frame - activeAttack.frame;
    const lungeT = af / 25;
    const lungeP =
      lungeT < 0.3 ? lungeT / 0.3 : lungeT < 0.5 ? 1 : 1 - (lungeT - 0.5) / 0.5;
    const clamped = Math.max(0, Math.min(1, lungeP));
    const dist = 50;

    if (activeAttack.attacker === "dragon") {
      dragonOffsetX = clamped * dist;
    } else {
      phoenixOffsetX = -clamped * dist;
    }

    // Knockback
    if (af > 10 && af < 25) {
      const kbT = (af - 10) / 15;
      const kb = Math.sin(kbT * Math.PI) * 18;
      if (activeAttack.attacker === "dragon") phoenixOffsetX += kb;
      else dragonOffsetX -= kb;
    }
  }

  // Screen shake
  let shakeX = 0;
  let shakeY = 0;
  if (activeAttack) {
    const af = frame - activeAttack.frame;
    if (af > 8 && af < 20) {
      const intensity = 4 * (1 - (af - 8) / 12);
      shakeX = Math.sin(af * 2.5) * intensity;
      shakeY = Math.cos(af * 3.1) * intensity * 0.5;
    }
  }

  return (
    <AbsoluteFill style={{ transform: `translate(${shakeX}px, ${shakeY}px)` }}>
      {/* Dragon */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - petSpacing - petSize / 2 + dragonOffsetX,
          top: height / 2 - petSize / 2,
        }}
      >
        <HPBar hp={dragonHp} maxHp={92} width={petSize} label="Drake Lv14" />
        <PetSprite species="dragon" size={petSize} enterDelay={0} bob />
      </div>

      {/* Phoenix */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + petSpacing - petSize / 2 + phoenixOffsetX,
          top: height / 2 - petSize / 2,
        }}
      >
        <HPBar hp={phoenixHp} maxHp={78} width={petSize} label="Blaze Lv12" />
        <PetSprite species="phoenix" size={petSize} enterDelay={0} flipX bob />
      </div>

      {/* Damage numbers */}
      {attacks.map((atk, i) => {
        const af = frame - atk.frame;
        if (af < 10 || af > 40) return null;
        const targetX =
          atk.attacker === "dragon"
            ? width / 2 + petSpacing
            : width / 2 - petSpacing;
        return (
          <DamageNumber
            key={i}
            damage={atk.damage}
            delay={atk.frame + 10}
            x={targetX - 20}
            y={height / 2 - petSize / 2 - 20}
            isCritical={atk.damage >= 18}
          />
        );
      })}

      {/* Slash arcs */}
      {attacks.map((atk, i) => {
        const af = frame - atk.frame;
        if (af < 6 || af > 22) return null;
        const progress = (af - 6) / 16;
        const arcOpacity = 1 - progress;
        const arcX =
          atk.attacker === "dragon"
            ? width / 2 + petSpacing - 35
            : width / 2 - petSpacing + 35;

        return (
          <div
            key={`slash-${i}`}
            style={{
              position: "absolute",
              left: arcX,
              top: height / 2 - 25,
              width: 50,
              height: 50,
              borderRadius: "50%",
              border: `3px solid rgba(255,255,255,${arcOpacity})`,
              borderTopColor: "transparent",
              borderLeftColor: "transparent",
              transform: `rotate(${progress * 180}deg) scale(${0.5 + progress})`,
              opacity: arcOpacity,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 5: Victory (13-16s, frames 390-480)
const Victory: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;
  const petSize = isVertical ? 150 : 140;

  // Phoenix defeat
  const deathProgress = interpolate(frame, [0, fps * 1.2], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  const phoenixRot = deathProgress * 360;
  const phoenixScale = 1 - deathProgress * 0.6;
  const phoenixOpacity = interpolate(frame, [fps * 0.6, fps * 1.2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Dragon celebration
  const victoryBounce = spring({
    frame,
    fps,
    delay: Math.round(fps * 0.6),
    config: SPRING_BOUNCY,
  });
  const dragonBounceY =
    Math.abs(Math.sin(((frame - fps * 0.6) / fps) * 4 * Math.PI * 2)) *
    18 *
    Math.max(0, 1 - (frame - fps * 0.6) / (fps * 2));
  const dragonScale = interpolate(victoryBounce, [0, 1], [1, 1.2]);

  // Reward panel
  const rewardDelay = Math.round(fps * 1.2);
  const rewardEntrance = spring({
    frame,
    fps,
    delay: rewardDelay,
    config: SPRING_BOUNCY,
  });
  const rewardScale = interpolate(rewardEntrance, [0, 1], [0, 1]);
  const rewardOpacity = interpolate(rewardEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // VICTORY text
  const victoryTextEntrance = spring({
    frame,
    fps,
    delay: 4,
    config: { damping: 8, mass: 0.3 },
  });
  const victoryTextScale = interpolate(victoryTextEntrance, [0, 1], [3, 1]);
  const victoryTextOpacity = interpolate(
    frame,
    [4, 10, fps * 1.5, fps * 2],
    [0, 1, 1, 0.7],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill>
      <ParticleField count={35} color={COLORS.gold} speed={1.5} />

      {/* Phoenix dying */}
      <div
        style={{
          position: "absolute",
          left: width / 2 + 100 - petSize / 2,
          top: height / 2 - petSize / 2 + deathProgress * 25,
          opacity: phoenixOpacity,
          transform: `rotate(${phoenixRot}deg) scale(${phoenixScale})`,
        }}
      >
        <PetSprite species="phoenix" size={petSize} enterDelay={0} bob={false} flipX />
      </div>

      {/* Dragon winner */}
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

      {/* VICTORY text */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 80,
          top: isVertical ? height * 0.15 : height * 0.12,
          width: 160,
          textAlign: "center",
          opacity: victoryTextOpacity,
          transform: `scale(${victoryTextScale})`,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 48,
            color: COLORS.gold,
            textShadow: `
              3px 3px 0px rgba(0,0,0,0.4),
              0 0 20px rgba(255,215,0,0.5)
            `,
          }}
        >
          VICTORY!
        </span>
      </div>

      {/* Reward panel */}
      <div
        style={{
          position: "absolute",
          left: width / 2 - 160,
          bottom: isVertical ? 80 : 50,
          width: 320,
          opacity: rewardOpacity,
          transform: `scale(${rewardScale})`,
        }}
      >
        <ClawPanel>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontFamily: roboto,
                fontSize: 18,
                fontWeight: 700,
                color: "#3E2723",
              }}
            >
              Battle Rewards
            </span>
            <div
              style={{
                display: "flex",
                gap: 24,
              }}
            >
              <span style={{ fontFamily: roboto, fontSize: 16, color: "#4CAF50", fontWeight: 700 }}>
                +150 NT
              </span>
              <span style={{ fontFamily: roboto, fontSize: 16, color: "#FF9800", fontWeight: 700 }}>
                +250 XP
              </span>
              <span style={{ fontFamily: roboto, fontSize: 16, color: "#2196F3", fontWeight: 700 }}>
                Lv15!
              </span>
            </div>
          </div>
        </ClawPanel>
      </div>
    </AbsoluteFill>
  );
};

// Scene 6: CTA (16-18s, frames 480-540)
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
      <CTAButton text="Enter the Arena" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S15 composition (18s)
export const ArenaUltimateTest: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-battle-royale.mp4" startFrom={0} tintOpacity={0.4} />
      <LiveBadge />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Arena: The Ultimate Test"
          subtitle="Prove your skills in battle"
          accentColor={COLORS.red}
        />
      </Sequence>

      {/* Scene 2: Arena Entrance (1-4s) */}
      <Sequence from={1 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <ArenaEntrance />
      </Sequence>

      {/* Scene 3: Matchup (4-8s) */}
      <Sequence from={4 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Matchup />
      </Sequence>

      {/* Scene 4: Battle (8-13s) */}
      <Sequence from={8 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <Battle />
      </Sequence>

      {/* Scene 5: Victory (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <Victory />
      </Sequence>

      {/* Scene 6: CTA (16-18s) */}
      <Sequence from={16 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
