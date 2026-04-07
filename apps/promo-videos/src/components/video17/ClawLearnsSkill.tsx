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
import { loadFont as loadRobotoMono } from "@remotion/google-fonts/RobotoMono";
import { GradientBackground } from "../shared/GradientBackground";
import { MapBackground } from "../shared/MapBackground";
import { ClawPanel } from "../shared/ClawPanel";
import { PetSprite } from "../shared/PetSprite";
import { TerminalBlock } from "../shared/TerminalBlock";
import { TypewriterText } from "../shared/TypewriterText";
import { ParticleField } from "../shared/ParticleField";
import { CTAButton } from "../shared/CTAButton";
import { COLORS } from "../../constants/colors";
import {
  FPS,
  SPRING_BOUNCY,
  SPRING_SNAPPY,
  SPRING_SMOOTH,
} from "../../constants/timing";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
const { fontFamily: robotoMono } = loadRobotoMono("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

// --- Scene 1: Hook -- The claw descends into a building (0-3s) ---

const ClawDescends: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // Claw arm drops from above
  const clawDrop = spring({
    frame,
    fps,
    delay: Math.round(0.3 * fps),
    config: { damping: 12, stiffness: 80 },
  });
  const clawY = interpolate(clawDrop, [0, 1], [-200, 0]);

  // Building label fades in
  const labelEntrance = spring({
    frame,
    fps,
    delay: Math.round(1.2 * fps),
    config: SPRING_SNAPPY,
  });
  const labelOpacity = interpolate(labelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Tagline
  const tagEntrance = spring({
    frame,
    fps,
    delay: Math.round(2 * fps),
    config: SPRING_SMOOTH,
  });
  const tagOpacity = interpolate(tagEntrance, [0, 1], [0, 1]);
  const tagY = interpolate(tagEntrance, [0, 1], [30, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
        padding: 40,
      }}
    >
      <ParticleField count={20} color={COLORS.clawToken} speed={0.4} />

      {/* Claw arm visual */}
      <div
        style={{
          transform: `translateY(${clawY}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
        }}
      >
        {/* Cable */}
        <div
          style={{
            width: 4,
            height: 60,
            background: "linear-gradient(180deg, transparent, #888, #aaa)",
            borderRadius: 2,
          }}
        />
        {/* Claw body */}
        <div
          style={{
            fontSize: isVertical ? 80 : 72,
            lineHeight: 1,
            filter: "drop-shadow(0 4px 12px rgba(255,215,0,0.4))",
          }}
        >
          {"\uD83E\uDD1E"}
        </div>
      </div>

      {/* Building label */}
      <div style={{ opacity: labelOpacity }}>
        <ClawPanel width={isVertical ? 360 : 400}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: 28 }}>{"🏪"}</span>
            <span
              style={{
                fontFamily: lobster,
                fontSize: isVertical ? 22 : 26,
                color: "#3E2723",
              }}
            >
              DEX Trading Floor
            </span>
          </div>
        </ClawPanel>
      </div>

      {/* Tagline */}
      <div
        style={{
          opacity: tagOpacity,
          transform: `translateY(${tagY}px)`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 24 : 28,
            fontWeight: 700,
            color: COLORS.clawToken,
            textShadow: "2px 2px 6px rgba(0,0,0,0.5)",
          }}
        >
          Your claw is about to get smarter.
        </span>
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 2: Article scraping -- terminal showing URLs being fetched (3-7s) ---

const ArticleScrape: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const titleOpacity = interpolate(titleEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Progress bar fill
  const progressStart = Math.round(1 * fps);
  const progressEnd = Math.round(3.2 * fps);
  const progressFill = interpolate(frame, [progressStart, progressEnd], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });

  // Counter for articles scraped
  const articleCount = Math.min(
    19,
    Math.floor(
      interpolate(frame, [progressStart, progressEnd], [0, 19], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    )
  );

  // Badge pop-in
  const badgeEntrance = spring({
    frame,
    fps,
    delay: Math.round(3.4 * fps),
    config: SPRING_BOUNCY,
  });
  const badgeScale = interpolate(badgeEntrance, [0, 1], [0, 1]);
  const badgeOpacity = interpolate(badgeEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
        padding: isVertical ? "40px 24px" : "40px 60px",
      }}
    >
      {/* Section title */}
      <div style={{ opacity: titleOpacity, marginBottom: 8 }}>
        <span
          style={{
            fontFamily: robotoMono,
            fontSize: 14,
            color: COLORS.accent,
            textTransform: "uppercase" as const,
            letterSpacing: 3,
          }}
        >
          Phase 1 -- Fetching Articles
        </span>
      </div>

      {/* Terminal showing scrape progress */}
      <TerminalBlock
        lines={[
          "openclaw research --location bazaar",
          "  Scraping 20 curated articles...",
          "  [CoinGecko] Jupiter DEX aggregator",
          "  [Decrypt]   Raydium vs Orca compared",
          "  [Helius]    MEV protection on Solana",
          "  [CoinDesk]  Solana DEX trading volume",
          `  -> ${articleCount}/19 articles cached`,
        ]}
        startFrame={8}
        charsPerSecond={50}
        width={isVertical ? 440 : 540}
      />

      {/* Progress bar */}
      <div
        style={{
          width: isVertical ? 380 : 480,
          height: 12,
          borderRadius: 6,
          background: "rgba(255,255,255,0.1)",
          border: "1px solid rgba(255,255,255,0.15)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${progressFill}%`,
            height: "100%",
            borderRadius: 6,
            background: `linear-gradient(90deg, ${COLORS.accent}, #00bcd4)`,
            boxShadow: `0 0 10px rgba(0,229,255,0.4)`,
          }}
        />
      </div>

      {/* "19 articles cached" badge */}
      <div
        style={{
          opacity: badgeOpacity,
          transform: `scale(${badgeScale})`,
        }}
      >
        <div
          style={{
            background: "rgba(0,229,255,0.15)",
            border: `2px solid rgba(0,229,255,0.5)`,
            borderRadius: 24,
            padding: "8px 20px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 16,
              color: COLORS.accent,
            }}
          >
            {"\u2705"} 19 articles cached and ready
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 3: LLM reads articles in batches -- thought bubbles appear (7-13s) ---

const LLMReading: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const phaseLabel = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const phaseLabelOpacity = interpolate(phaseLabel, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Batch cards that slide in
  const batches = [
    { label: "Batch 1/5", articles: "Articles 1-4", delay: Math.round(0.5 * fps) },
    { label: "Batch 2/5", articles: "Articles 5-8", delay: Math.round(1.5 * fps) },
    { label: "Batch 3/5", articles: "Articles 9-12", delay: Math.round(2.5 * fps) },
    { label: "Batch 4/5", articles: "Articles 13-16", delay: Math.round(3.5 * fps) },
    { label: "Batch 5/5", articles: "Articles 17-19", delay: Math.round(4.3 * fps) },
  ];

  // Insights that pop in as the LLM discovers them
  const insights = [
    { text: "Jupiter = 95% of Solana DEX volume", delay: Math.round(1.8 * fps), color: "#66BB6A" },
    { text: "Jito protects against sandwich bots", delay: Math.round(2.8 * fps), color: "#42A5F5" },
    { text: "Set slippage tolerance carefully", delay: Math.round(3.8 * fps), color: "#FFA726" },
    { text: "Orca Whirlpools = concentrated LPs", delay: Math.round(4.6 * fps), color: "#AB47BC" },
  ];

  // Counter
  const insightCount = insights.filter((ins) => frame >= ins.delay + Math.round(0.3 * fps)).length;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "center",
        flexDirection: "column",
        gap: 12,
        padding: isVertical ? "50px 24px" : "36px 50px",
      }}
    >
      {/* Phase label */}
      <div style={{ opacity: phaseLabelOpacity, marginBottom: 4 }}>
        <span
          style={{
            fontFamily: robotoMono,
            fontSize: 14,
            color: "#66BB6A",
            textTransform: "uppercase" as const,
            letterSpacing: 3,
          }}
        >
          Phase 2 -- Reading + Extracting
        </span>
      </div>

      {/* Batch cards row */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          justifyContent: "center",
          marginBottom: 8,
        }}
      >
        {batches.map((batch, i) => {
          const batchEntrance = spring({
            frame,
            fps,
            delay: batch.delay,
            config: SPRING_SNAPPY,
          });
          const batchOpacity = interpolate(batchEntrance, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });
          const batchScale = interpolate(batchEntrance, [0, 1], [0.7, 1]);

          // Active batch has glow
          const isActive = i === batches.filter((b) => frame >= b.delay).length - 1;
          const glowPhase = (frame / fps) * 4;
          const glow = isActive ? 4 + Math.sin(glowPhase) * 3 : 0;

          return (
            <div
              key={batch.label}
              style={{
                opacity: batchOpacity,
                transform: `scale(${batchScale})`,
              }}
            >
              <div
                style={{
                  background: isActive
                    ? "rgba(102,187,106,0.2)"
                    : "rgba(255,255,255,0.05)",
                  border: `2px solid ${isActive ? "rgba(102,187,106,0.6)" : "rgba(255,255,255,0.15)"}`,
                  borderRadius: 10,
                  padding: "8px 14px",
                  boxShadow: glow > 0 ? `0 0 ${glow}px rgba(102,187,106,0.5)` : "none",
                  textAlign: "center" as const,
                }}
              >
                <div
                  style={{
                    fontFamily: robotoMono,
                    fontSize: 12,
                    color: isActive ? "#66BB6A" : "#888",
                    fontWeight: 700,
                  }}
                >
                  {batch.label}
                </div>
                <div
                  style={{
                    fontFamily: roboto,
                    fontSize: 11,
                    color: "rgba(255,255,255,0.5)",
                    marginTop: 2,
                  }}
                >
                  {batch.articles}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Insight counter */}
      <div style={{ marginBottom: 4 }}>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 16,
            fontWeight: 700,
            color: "#FFFFFF",
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          Insights discovered: {insightCount}/{insights.length}
        </span>
      </div>

      {/* Insight pills that appear */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "100%",
          maxWidth: isVertical ? 440 : 560,
          flex: 1,
          justifyContent: "center",
        }}
      >
        {insights.map((ins, i) => {
          const insEntrance = spring({
            frame,
            fps,
            delay: ins.delay,
            config: SPRING_BOUNCY,
          });
          const insOpacity = interpolate(insEntrance, [0, 0.3], [0, 1], {
            extrapolateRight: "clamp",
          });
          const insSlideX = interpolate(insEntrance, [0, 1], [80, 0]);
          const insScale = interpolate(insEntrance, [0, 1], [0.8, 1]);

          return (
            <div
              key={i}
              style={{
                opacity: insOpacity,
                transform: `translateX(${insSlideX}px) scale(${insScale})`,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              {/* Colored dot */}
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: ins.color,
                  boxShadow: `0 0 8px ${ins.color}`,
                  flexShrink: 0,
                }}
              />
              <div
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 10,
                  padding: "10px 16px",
                  flex: 1,
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 15,
                    color: "#FFFFFF",
                    lineHeight: 1.3,
                  }}
                >
                  {ins.text}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 4: Synthesis -- insights merge into knowledge entries (13-17s) ---

const Synthesis: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const phaseLabel = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const phaseLabelOpacity = interpolate(phaseLabel, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Left side: raw insights (fade in then compress)
  const rawInsights = [
    "Jupiter DEX aggregator dominance",
    "MEV risks and sandwich bots",
    "Slippage tolerance settings",
    "Orca concentrated liquidity",
    "Raydium pool monitoring",
    "Order types: market/limit/stop",
  ];

  const rawEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.3 * fps),
    config: SPRING_SMOOTH,
  });
  const rawOpacity = interpolate(rawEntrance, [0, 1], [0, 1]);

  // Arrow animation
  const arrowProgress = interpolate(
    frame,
    [Math.round(1.5 * fps), Math.round(2.5 * fps)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }
  );

  // Right side: synthesized entries (appear after arrow)
  const synthesized = [
    "Jupiter controls 95% of Solana DEX trading",
    "Use Jito for MEV sandwich bot protection",
    "Set slippage to 0.5-1% on volatile pairs",
    "Orca Whirlpools boost LP yield via ranges",
  ];

  // Compression visual -- raw insights shrink as synthesized appear
  const compressScale = interpolate(
    frame,
    [Math.round(1.5 * fps), Math.round(2.5 * fps)],
    [1, 0.7],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const compressOpacity = interpolate(
    frame,
    [Math.round(2 * fps), Math.round(2.8 * fps)],
    [1, 0.3],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // "Distilled" badge
  const distilledEntrance = spring({
    frame,
    fps,
    delay: Math.round(3 * fps),
    config: SPRING_BOUNCY,
  });
  const distilledScale = interpolate(distilledEntrance, [0, 1], [0, 1]);
  const distilledOpacity = interpolate(distilledEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 16,
        padding: isVertical ? "40px 20px" : "40px 50px",
      }}
    >
      <ParticleField count={10} color="#FFC107" speed={0.6} />

      {/* Phase label */}
      <div style={{ opacity: phaseLabelOpacity }}>
        <span
          style={{
            fontFamily: robotoMono,
            fontSize: 14,
            color: "#FFC107",
            textTransform: "uppercase" as const,
            letterSpacing: 3,
          }}
        >
          Phase 3 -- Synthesizing Knowledge
        </span>
      </div>

      {/* Main content: raw -> synthesized */}
      <div
        style={{
          display: "flex",
          flexDirection: isVertical ? "column" : "row",
          alignItems: "center",
          gap: isVertical ? 16 : 24,
          width: "100%",
          maxWidth: isVertical ? 460 : 900,
        }}
      >
        {/* Raw insights */}
        <div
          style={{
            flex: 1,
            opacity: rawOpacity * compressOpacity,
            transform: `scale(${compressScale})`,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontFamily: robotoMono,
              fontSize: 11,
              color: "#888",
              marginBottom: 4,
            }}
          >
            25 raw insights
          </div>
          {rawInsights.map((insight, i) => (
            <div
              key={i}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 6,
                padding: "5px 10px",
              }}
            >
              <span
                style={{
                  fontFamily: roboto,
                  fontSize: 12,
                  color: "rgba(255,255,255,0.6)",
                }}
              >
                {insight}
              </span>
            </div>
          ))}
        </div>

        {/* Arrow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: arrowProgress,
          }}
        >
          <div
            style={{
              width: isVertical ? 40 : 60,
              height: isVertical ? 40 : 4,
              position: "relative",
            }}
          >
            {/* Arrow glow */}
            <div
              style={{
                position: "absolute",
                ...(isVertical
                  ? { width: 4, height: 40, left: 18, top: 0 }
                  : { width: 60, height: 4, left: 0, top: 0 }),
                background: "linear-gradient(90deg, #FFC107, #FF9800)",
                borderRadius: 2,
                boxShadow: "0 0 12px rgba(255,193,7,0.5)",
              }}
            />
            <span
              style={{
                position: "absolute",
                ...(isVertical
                  ? { bottom: -8, left: 10 }
                  : { right: -12, top: -10 }),
                fontSize: 20,
                color: "#FFC107",
              }}
            >
              {isVertical ? "\u25BC" : "\u25B6"}
            </span>
          </div>
        </div>

        {/* Synthesized entries */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              fontFamily: robotoMono,
              fontSize: 11,
              color: "#FFC107",
              marginBottom: 4,
            }}
          >
            12 knowledge entries
          </div>
          {synthesized.map((entry, i) => {
            const entryEntrance = spring({
              frame,
              fps,
              delay: Math.round((2.2 + i * 0.3) * fps),
              config: SPRING_SNAPPY,
            });
            const entryOpacity = interpolate(entryEntrance, [0, 0.5], [0, 1], {
              extrapolateRight: "clamp",
            });
            const entrySlideX = interpolate(entryEntrance, [0, 1], [30, 0]);

            return (
              <div
                key={i}
                style={{
                  opacity: entryOpacity,
                  transform: `translateX(${entrySlideX}px)`,
                  background: "rgba(255,193,7,0.1)",
                  border: "2px solid rgba(255,193,7,0.3)",
                  borderRadius: 8,
                  padding: "8px 12px",
                }}
              >
                <span
                  style={{
                    fontFamily: roboto,
                    fontSize: 13,
                    color: "#FFFFFF",
                    fontWeight: 700,
                  }}
                >
                  {entry}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Distilled badge */}
      <div
        style={{
          opacity: distilledOpacity,
          transform: `scale(${distilledScale})`,
        }}
      >
        <div
          style={{
            background: "rgba(255,193,7,0.15)",
            border: "2px solid rgba(255,193,7,0.5)",
            borderRadius: 24,
            padding: "8px 20px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 15,
              color: "#FFC107",
            }}
          >
            {"\u2728"} 25 insights distilled into 12 entries
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 5: SKILL.md compiled -- terminal + lobster absorbs skill (17-21s) ---

const SkillCompiled: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const phaseLabel = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SNAPPY,
  });
  const phaseLabelOpacity = interpolate(phaseLabel, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Skill file being written
  const skillEntrance = spring({
    frame,
    fps,
    delay: Math.round(0.5 * fps),
    config: SPRING_SNAPPY,
  });
  const skillOpacity = interpolate(skillEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const skillSlideY = interpolate(skillEntrance, [0, 1], [40, 0]);

  // Lobster absorbs the skill -- glow effect
  const petEntrance = spring({
    frame,
    fps,
    delay: Math.round(2 * fps),
    config: SPRING_BOUNCY,
  });
  const petScale = interpolate(petEntrance, [0, 1], [0, 1]);
  const petOpacity = interpolate(petEntrance, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Knowledge ring pulse
  const ringPhase = (frame / fps) * 3;
  const ringRadius = 60 + Math.sin(ringPhase) * 8;
  const ringOpacity = 0.3 + Math.sin(ringPhase) * 0.2;

  // "+SKILL.md" flying text
  const skillFlyEntrance = spring({
    frame,
    fps,
    delay: Math.round(2.5 * fps),
    config: { damping: 15, stiffness: 120 },
  });
  const skillFlyY = interpolate(skillFlyEntrance, [0, 1], [40, -20]);
  const skillFlyOpacity = interpolate(skillFlyEntrance, [0, 0.3, 0.7, 1], [0, 1, 1, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
        padding: isVertical ? "40px 24px" : "40px 50px",
      }}
    >
      <ParticleField count={18} color="#AB47BC" speed={0.7} />

      {/* Phase label */}
      <div style={{ opacity: phaseLabelOpacity }}>
        <span
          style={{
            fontFamily: robotoMono,
            fontSize: 14,
            color: "#CE93D8",
            textTransform: "uppercase" as const,
            letterSpacing: 3,
          }}
        >
          Phase 4 -- Compiling SKILL.md
        </span>
      </div>

      {/* Skill file preview */}
      <div
        style={{
          opacity: skillOpacity,
          transform: `translateY(${skillSlideY}px)`,
        }}
      >
        <TerminalBlock
          lines={[
            "---",
            "name: clawbot-dex-trading-floor",
            'description: "DEX Trading Floor skill"',
            "format: elizaos-character",
            "---",
            "",
            "# Core Knowledge",
            "- Jupiter: 95% Solana DEX volume",
            "- Jito: MEV sandwich protection",
            "- Slippage: 0.5-1% volatile pairs",
          ]}
          startFrame={Math.round(0.6 * fps)}
          charsPerSecond={55}
          width={isVertical ? 420 : 480}
        />
      </div>

      {/* Lobster + absorption effect */}
      <div
        style={{
          position: "relative",
          opacity: petOpacity,
          transform: `scale(${petScale})`,
        }}
      >
        {/* Knowledge ring */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: ringRadius * 2,
            height: ringRadius * 2,
            borderRadius: "50%",
            border: `3px solid rgba(206,147,216,${ringOpacity})`,
            boxShadow: `0 0 20px rgba(206,147,216,${ringOpacity * 0.6})`,
            transform: "translate(-50%, -50%)",
          }}
        />
        <PetSprite species="cat" size={isVertical ? 90 : 80} enterDelay={Math.round(2 * fps)} bob />

        {/* Flying skill text */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: `translate(-50%, ${skillFlyY}px)`,
            opacity: skillFlyOpacity,
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 14,
              fontWeight: 700,
              color: "#CE93D8",
              textShadow: "0 0 8px rgba(206,147,216,0.6)",
              whiteSpace: "nowrap" as const,
            }}
          >
            +SKILL.md imprinted
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 6: Thought Log terminal -- real-time streaming view (21-26s) ---

const ThoughtLogStream: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const panelEntrance = spring({
    frame,
    fps,
    delay: 5,
    config: SPRING_SMOOTH,
  });
  const panelSlideY = interpolate(panelEntrance, [0, 1], [60, 0]);
  const panelOpacity = interpolate(panelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Log lines that type in sequentially
  const logLines = [
    { time: "12:34:01", phase: "FETCH", color: COLORS.accent, text: "Loading 19 articles for DEX Trading Floor..." },
    { time: "12:34:03", phase: "READ", color: "#66BB6A", text: "Reading articles 1-4 of 19..." },
    { time: "12:34:07", phase: "READ", color: "#66BB6A", text: "Learned: Jupiter = 95% of Solana DEX volume" },
    { time: "12:34:12", phase: "READ", color: "#66BB6A", text: "Reading articles 5-8 of 19..." },
    { time: "12:34:18", phase: "SYNTH", color: "#FFC107", text: "Synthesizing 25 insights..." },
    { time: "12:34:22", phase: "SKILL", color: "#CE93D8", text: "Compiling SKILL.md..." },
    { time: "12:34:23", phase: "DONE", color: "#66BB6A", text: "12 new knowledge entries learned!" },
  ];

  // Progress bar
  const progressFill = interpolate(
    frame,
    [Math.round(0.5 * fps), Math.round(4 * fps)],
    [5, 100],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }
  );

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 16,
        padding: isVertical ? "40px 20px" : "40px 50px",
      }}
    >
      {/* "What the player sees" label */}
      <span
        style={{
          fontFamily: roboto,
          fontSize: 18,
          fontWeight: 700,
          color: "#FFFFFF",
          textShadow: "1px 1px 4px rgba(0,0,0,0.5)",
        }}
      >
        Real-time Thought Log
      </span>

      {/* Terminal panel */}
      <div
        style={{
          opacity: panelOpacity,
          transform: `translateY(${panelSlideY}px)`,
          width: isVertical ? "95%" : "80%",
          maxWidth: 700,
        }}
      >
        {/* Header bar */}
        <div
          style={{
            background: "rgba(20,20,30,0.98)",
            borderTop: `2px solid rgba(102,187,106,0.4)`,
            borderLeft: "1px solid rgba(102,187,106,0.2)",
            borderRight: "1px solid rgba(102,187,106,0.2)",
            borderRadius: "8px 8px 0 0",
            padding: "8px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 12,
              color: "#66BB6A",
              fontWeight: 700,
            }}
          >
            {">"} RESEARCH LOG -- DEX Trading Floor
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <span style={{ fontFamily: robotoMono, fontSize: 10, color: "#888" }}>_</span>
            <span style={{ fontFamily: robotoMono, fontSize: 10, color: "#888" }}>-</span>
            <span style={{ fontFamily: robotoMono, fontSize: 10, color: "#888" }}>x</span>
          </div>
        </div>

        {/* Log body */}
        <div
          style={{
            background: "rgba(10,10,18,0.95)",
            borderLeft: "1px solid rgba(102,187,106,0.2)",
            borderRight: "1px solid rgba(102,187,106,0.2)",
            padding: "12px 16px",
            minHeight: isVertical ? 200 : 180,
          }}
        >
          {logLines.map((line, i) => {
            const lineDelay = Math.round((0.5 + i * 0.55) * fps);
            const lineEntrance = spring({
              frame,
              fps,
              delay: lineDelay,
              config: SPRING_SNAPPY,
            });
            const lineOpacity = interpolate(lineEntrance, [0, 0.5], [0, 1], {
              extrapolateRight: "clamp",
            });
            const lineSlideY = interpolate(lineEntrance, [0, 1], [12, 0]);

            return (
              <div
                key={i}
                style={{
                  opacity: lineOpacity,
                  transform: `translateY(${lineSlideY}px)`,
                  fontFamily: robotoMono,
                  fontSize: 12,
                  lineHeight: 1.8,
                  display: "flex",
                  gap: 8,
                }}
              >
                <span style={{ color: "#555", flexShrink: 0 }}>[{line.time}]</span>
                <span
                  style={{
                    color: line.color,
                    fontWeight: 700,
                    flexShrink: 0,
                    minWidth: 44,
                  }}
                >
                  {line.phase}
                </span>
                <span style={{ color: "rgba(255,255,255,0.8)" }}>{line.text}</span>
              </div>
            );
          })}
        </div>

        {/* Progress bar footer */}
        <div
          style={{
            background: "rgba(10,10,18,0.95)",
            borderLeft: "1px solid rgba(102,187,106,0.2)",
            borderRight: "1px solid rgba(102,187,106,0.2)",
            borderBottom: "1px solid rgba(102,187,106,0.2)",
            borderRadius: "0 0 8px 8px",
            padding: "8px 16px",
          }}
        >
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: "rgba(255,255,255,0.08)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progressFill}%`,
                height: "100%",
                borderRadius: 3,
                background: "linear-gradient(90deg, #66BB6A, #4CAF50)",
                boxShadow: "0 0 6px rgba(76,175,80,0.4)",
              }}
            />
          </div>
          <div
            style={{
              fontFamily: robotoMono,
              fontSize: 10,
              color: "#888",
              textAlign: "right" as const,
              marginTop: 4,
            }}
          >
            {Math.round(progressFill)}%
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 7: CTA (26-28s) ---

const ResearchCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleEntrance = spring({
    frame,
    fps,
    delay: 0,
    config: SPRING_SMOOTH,
  });
  const titleOpacity = interpolate(titleEntrance, [0, 1], [0, 1]);
  const titleSlideY = interpolate(titleEntrance, [0, 1], [20, 0]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
        flexDirection: "column",
      }}
    >
      <ParticleField count={25} color={COLORS.clawToken} speed={0.5} />
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleSlideY}px)`,
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: 34,
            color: COLORS.clawToken,
            textShadow: "2px 2px 6px rgba(0,0,0,0.5)",
          }}
        >
          Your claw reads. Your claw learns.
        </span>
        <span
          style={{
            fontFamily: roboto,
            fontSize: 20,
            color: "#FFFFFF",
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          15 buildings. 300 articles. Infinite knowledge.
        </span>
      </div>
      <CTAButton text="Start Researching" subtitle="play.clawville.com" />
    </AbsoluteFill>
  );
};

// --- Main Composition ---

export const ClawLearnsSkill: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bg, COLORS.bgGradient1, COLORS.bgLight]} />

      {/* Scene 1: Claw descends into building (0-3s) */}
      <Sequence durationInFrames={3 * fps} premountFor={fps}>
        <AbsoluteFill>
          <MapBackground zoom={1.4} tintColor={COLORS.bg} tintOpacity={0.7} panX={0.05} panY={0} />
        </AbsoluteFill>
        <ClawDescends />
      </Sequence>

      {/* Scene 2: Article scraping terminal (3-7s) */}
      <Sequence from={3 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <ArticleScrape />
      </Sequence>

      {/* Scene 3: LLM reads batches, insights appear (7-13s) */}
      <Sequence from={7 * fps} durationInFrames={6 * fps} premountFor={fps}>
        <LLMReading />
      </Sequence>

      {/* Scene 4: Synthesis -- insights merge (13-17s) */}
      <Sequence from={13 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <Synthesis />
      </Sequence>

      {/* Scene 5: SKILL.md compiled, lobster absorbs (17-21s) */}
      <Sequence from={17 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <SkillCompiled />
      </Sequence>

      {/* Scene 6: Thought Log terminal stream (21-26s) */}
      <Sequence from={21 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <ThoughtLogStream />
      </Sequence>

      {/* Scene 7: CTA (26-28s) */}
      <Sequence from={26 * fps} durationInFrames={2 * fps} premountFor={fps}>
        <ResearchCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
