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
import { ClawPanel } from "../../../shared/ClawPanel";
import { PetSprite } from "../../../shared/PetSprite";
import { CTAButton } from "../../../shared/CTAButton";
import { LogoReveal } from "../../../shared/LogoReveal";
import { TitleScreen } from "../../shared/TitleScreen";
import { COLORS } from "../../../../constants/colors";
import { SPRING_BOUNCY, SPRING_SNAPPY } from "../../../../constants/timing";
import { ARENA_SETTINGS } from "../../../../constants/showcase";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// Scene 2: Settings Panel (1-5s, frames 30-150)
const SettingsPanel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const headerEntrance = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
  });
  const headerOpacity = interpolate(headerEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

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
      {/* Header */}
      <span
        style={{
          fontFamily: lobster,
          fontSize: isVertical ? 30 : 36,
          color: "#CE93D8",
          textShadow: "2px 2px 0px rgba(0,0,0,0.4)",
          marginBottom: 10,
          opacity: headerOpacity,
        }}
      >
        Arena Settings
      </span>

      {/* Settings cards */}
      {ARENA_SETTINGS.map((setting, i) => {
        const delay = 8 + i * 8;
        const entrance = spring({
          frame,
          fps,
          delay,
          config: SPRING_BOUNCY,
        });
        const scale = interpolate(entrance, [0, 1], [0, 1]);
        const slideY = interpolate(entrance, [0, 1], [40, 0]);

        return (
          <div
            key={setting.label}
            style={{
              transform: `scale(${scale}) translateY(${slideY}px)`,
            }}
          >
            <ClawPanel width={panelW}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 28 }}>{setting.icon}</span>
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 20,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {setting.label}
                  </span>
                </div>
                <div
                  style={{
                    background: "rgba(126,87,194,0.15)",
                    borderRadius: 10,
                    padding: "4px 14px",
                    border: "2px solid #CE93D8",
                  }}
                >
                  <span
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#7E57C2",
                    }}
                  >
                    {setting.value}
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

// Scene 3: Strategy Tips (5-9s, frames 150-270)
const StrategyTips: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const tips = [
    { icon: "🎯", title: "Know Your Matchup", desc: "Check opponent stats before engaging" },
    { icon: "🧠", title: "Upgrade Knowledge", desc: "More books = stronger battle moves" },
    { icon: "⏱️", title: "Timing is Key", desc: "Use cooldowns wisely between rounds" },
  ];

  const panelW = isVertical ? width - 60 : 440;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: isVertical ? 20 : 18,
        flexDirection: "column",
        padding: isVertical ? 30 : 50,
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
        Strategy Tips
      </span>

      {tips.map((tip, i) => {
        const delay = i * 15;
        const entrance = spring({
          frame,
          fps,
          delay,
          config: SPRING_SNAPPY,
        });
        // Alternate slide direction
        const slideX = interpolate(
          entrance,
          [0, 1],
          [i % 2 === 0 ? -400 : 400, 0]
        );
        const opacity = interpolate(entrance, [0, 0.4], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={tip.title}
            style={{
              transform: `translateX(${slideX}px)`,
              opacity,
            }}
          >
            <ClawPanel width={panelW}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <span style={{ fontSize: 36 }}>{tip.icon}</span>
                <div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 20,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {tip.title}
                  </div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 15,
                      color: "#795548",
                      marginTop: 2,
                    }}
                  >
                    {tip.desc}
                  </div>
                </div>
              </div>
            </ClawPanel>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// Scene 4: Pre-Battle Config (9-13s, frames 270-390)
const PreBattleConfig: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const petSize = isVertical ? 120 : 110;

  // Pet entrance
  const petEntrance = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
  });
  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);

  // Config items appear
  const configItems = [
    { label: "Mode", value: "Ranked" },
    { label: "Bot Level", value: "Lv.12" },
    { label: "Rewards", value: "2x" },
  ];

  // Fight button
  const fightDelay = fps * 2;
  const fightEntrance = spring({
    frame,
    fps,
    delay: fightDelay,
    config: SPRING_BOUNCY,
  });
  const fightScale = interpolate(fightEntrance, [0, 1], [0.5, 1]);
  const fightOpacity = interpolate(fightEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Pulsing glow on fight button
  const pulsePhase = ((frame - fightDelay) / fps) * 2 * Math.PI;
  const glowIntensity = 12 + Math.sin(pulsePhase) * 10;
  const pulseScale = 1 + Math.sin(pulsePhase * 1.5) * 0.04;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 20,
      }}
    >
      {/* Pet ready */}
      <div
        style={{
          transform: `scale(${petScale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        <PetSprite species="wolf" size={petSize} enterDelay={0} bob />
        <span
          style={{
            fontFamily: roboto,
            fontSize: 18,
            fontWeight: 700,
            color: COLORS.white,
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Shadow Lv10
        </span>
      </div>

      {/* Config row */}
      <div
        style={{
          display: "flex",
          gap: isVertical ? 12 : 20,
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        {configItems.map((item, i) => {
          const entrance = spring({
            frame,
            fps,
            delay: 12 + i * 8,
            config: SPRING_SNAPPY,
          });
          const opacity = interpolate(entrance, [0, 1], [0, 1]);
          const slideY = interpolate(entrance, [0, 1], [20, 0]);

          return (
            <div
              key={item.label}
              style={{
                opacity,
                transform: `translateY(${slideY}px)`,
              }}
            >
              <ClawPanel width={isVertical ? 100 : 120}>
                <div
                  style={{
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 12,
                      color: "#795548",
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontFamily: roboto,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#3E2723",
                    }}
                  >
                    {item.value}
                  </div>
                </div>
              </ClawPanel>
            </div>
          );
        })}
      </div>

      {/* Fight button */}
      <div
        style={{
          opacity: fightOpacity,
          transform: `scale(${fightScale * pulseScale})`,
        }}
      >
        <div
          style={{
            background: `linear-gradient(135deg, ${COLORS.red}, #D32F2F)`,
            borderRadius: 50,
            padding: "16px 56px",
            boxShadow: `0 0 ${glowIntensity}px rgba(244,67,54,0.6), 4px 4px 0px rgba(0,0,0,0.3)`,
            border: "3px solid #B71C1C",
          }}
        >
          <span
            style={{
              fontFamily: lobster,
              fontSize: 36,
              color: COLORS.white,
              textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
              letterSpacing: 4,
            }}
          >
            FIGHT!
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Scene 5: CTA (13-16s, frames 390-480)
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
      <CTAButton text="Customize & Battle" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// Main S16 composition (16s)
export const ArenaStrategy: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <RecordingBackground src="arena-combat-closeup.mp4" startFrom={3} playbackRate={0.8} tintOpacity={0.45} />
      <LiveBadge />
      <ParticleField count={18} color="#CE93D8" speed={0.7} />

      {/* Scene 1: Title (0-1s) */}
      <Sequence durationInFrames={1 * fps} premountFor={fps}>
        <TitleScreen
          title="Arena Settings & Strategy"
          subtitle="Customize your battle experience"
          accentColor="#CE93D8"
        />
      </Sequence>

      {/* Scene 2: Settings Panel (1-5s) */}
      <Sequence from={1 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <SettingsPanel />
      </Sequence>

      {/* Scene 3: Strategy Tips (5-9s) */}
      <Sequence from={5 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <StrategyTips />
      </Sequence>

      {/* Scene 4: Pre-Battle Config (9-13s) */}
      <Sequence from={9 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <PreBattleConfig />
      </Sequence>

      {/* Scene 5: CTA (13-16s) */}
      <Sequence from={13 * fps} durationInFrames={3 * fps} premountFor={fps}>
        <CTAScene />
      </Sequence>
    </AbsoluteFill>
  );
};
