import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  staticFile,
  Img,
  OffthreadVideo,
} from "remotion";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { loadFont as loadRobotoMono } from "@remotion/google-fonts/RobotoMono";
import { GradientBackground } from "../shared/GradientBackground";
import { MapBackground } from "../shared/MapBackground";
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

// --- Title Card -- reusable section header ---

const TitleCard: React.FC<{
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: string;
}> = ({ title, subtitle, badge, badgeColor }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleIn = spring({ frame, fps, delay: 5, config: SPRING_BOUNCY });
  const titleScale = interpolate(titleIn, [0, 1], [0.5, 1]);
  const titleOpacity = interpolate(titleIn, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  const subtitleIn = spring({
    frame,
    fps,
    delay: Math.round(0.4 * fps),
    config: SPRING_SMOOTH,
  });
  const subtitleOpacity = interpolate(subtitleIn, [0, 1], [0, 1]);
  const subtitleY = interpolate(subtitleIn, [0, 1], [20, 0]);

  const badgeIn = spring({
    frame,
    fps,
    delay: Math.round(0.2 * fps),
    config: SPRING_SNAPPY,
  });
  const badgeOpacity = interpolate(badgeIn, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Fade out at end of card
  const fadeOut = interpolate(
    frame,
    [Math.round(1 * fps), Math.round(1.3 * fps)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 16 : 12,
        opacity: fadeOut,
      }}
    >
      {/* Mode badge */}
      <div style={{ opacity: badgeOpacity }}>
        <div
          style={{
            background: `${badgeColor}22`,
            border: `2px solid ${badgeColor}88`,
            borderRadius: 20,
            padding: "6px 18px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 13,
              color: badgeColor,
              textTransform: "uppercase" as const,
              letterSpacing: 3,
              fontWeight: 700,
            }}
          >
            {badge}
          </span>
        </div>
      </div>

      {/* Title */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 38 : 44,
            color: "#FFFFFF",
            textShadow: "2px 2px 8px rgba(0,0,0,0.6)",
          }}
        >
          {title}
        </span>
      </div>

      {/* Subtitle */}
      <div
        style={{
          opacity: subtitleOpacity,
          transform: `translateY(${subtitleY}px)`,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 18 : 20,
            color: "rgba(255,255,255,0.7)",
            textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
          }}
        >
          {subtitle}
        </span>
      </div>
    </AbsoluteFill>
  );
};

// --- GIF Scene -- shows title card then GIF with border ---

const GifScene: React.FC<{
  gifSrc: string;
  label: string;
  titleCardDuration?: number;
}> = ({ gifSrc, label, titleCardDuration = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  // GIF entrance
  const gifEntrance = spring({
    frame,
    fps,
    delay: Math.round(titleCardDuration * fps),
    config: SPRING_SMOOTH,
  });
  const gifOpacity = interpolate(gifEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const gifScale = interpolate(gifEntrance, [0, 1], [0.92, 1]);

  // Label entrance
  const labelEntrance = spring({
    frame,
    fps,
    delay: Math.round((titleCardDuration + 0.3) * fps),
    config: SPRING_SNAPPY,
  });
  const labelOpacity = interpolate(labelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 12,
        padding: isVertical ? "40px 20px" : "30px 40px",
      }}
    >
      {/* GIF container with border */}
      <div
        style={{
          opacity: gifOpacity,
          transform: `scale(${gifScale})`,
          borderRadius: 12,
          overflow: "hidden",
          border: "3px solid rgba(255,255,255,0.15)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          maxWidth: isVertical ? "95%" : "85%",
          maxHeight: isVertical ? "70%" : "80%",
        }}
      >
        <OffthreadVideo
          src={staticFile(gifSrc.replace(/\.gif$/, '.mp4'))}
          style={{
            width: isVertical ? 1000 : 1400,
            objectFit: "contain",
          }}
          muted
        />
      </div>

      {/* Label */}
      <div style={{ opacity: labelOpacity }}>
        <div
          style={{
            background: "rgba(0,0,0,0.6)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 8,
            padding: "6px 16px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 13,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            {label}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 1: Intro Title (0-3s) ---

const IntroTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleIn = spring({ frame, fps, delay: 8, config: SPRING_BOUNCY });
  const titleScale = interpolate(titleIn, [0, 1], [0.3, 1]);
  const titleOpacity = interpolate(titleIn, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  const subtitleIn = spring({
    frame,
    fps,
    delay: Math.round(0.8 * fps),
    config: SPRING_SMOOTH,
  });
  const subtitleOpacity = interpolate(subtitleIn, [0, 1], [0, 1]);
  const subtitleY = interpolate(subtitleIn, [0, 1], [30, 0]);

  // Mode badges
  const arenaBadgeIn = spring({
    frame,
    fps,
    delay: Math.round(1.4 * fps),
    config: SPRING_SNAPPY,
  });
  const worldBadgeIn = spring({
    frame,
    fps,
    delay: Math.round(1.7 * fps),
    config: SPRING_SNAPPY,
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 24 : 20,
      }}
    >
      <ParticleField count={30} color={COLORS.neoToken} speed={0.5} />

      {/* Main title */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 52 : 60,
            color: COLORS.neoToken,
            textShadow: "3px 3px 10px rgba(0,0,0,0.6)",
          }}
        >
          OpenClaw in Action
        </span>
      </div>

      {/* Subtitle */}
      <div
        style={{
          opacity: subtitleOpacity,
          transform: `translateY(${subtitleY}px)`,
          textAlign: "center",
          maxWidth: isVertical ? 400 : 600,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 20 : 22,
            color: "rgba(255,255,255,0.8)",
            lineHeight: 1.5,
          }}
        >
          Plug in your bot. Train across two game modes. Export real skills.
        </span>
      </div>

      {/* Mode badges */}
      <div style={{ display: "flex", gap: 16 }}>
        <div
          style={{
            opacity: interpolate(arenaBadgeIn, [0, 0.5], [0, 1], {
              extrapolateRight: "clamp",
            }),
            transform: `scale(${interpolate(arenaBadgeIn, [0, 1], [0, 1])})`,
          }}
        >
          <div
            style={{
              background: "rgba(244,67,54,0.15)",
              border: "2px solid rgba(244,67,54,0.5)",
              borderRadius: 20,
              padding: "8px 20px",
            }}
          >
            <span
              style={{
                fontFamily: robotoMono,
                fontSize: 14,
                color: "#EF5350",
                fontWeight: 700,
              }}
            >
              ARENA MODE
            </span>
          </div>
        </div>
        <div
          style={{
            opacity: interpolate(worldBadgeIn, [0, 0.5], [0, 1], {
              extrapolateRight: "clamp",
            }),
            transform: `scale(${interpolate(worldBadgeIn, [0, 1], [0, 1])})`,
          }}
        >
          <div
            style={{
              background: "rgba(76,175,80,0.15)",
              border: "2px solid rgba(76,175,80,0.5)",
              borderRadius: 20,
              padding: "8px 20px",
            }}
          >
            <span
              style={{
                fontFamily: robotoMono,
                fontSize: 14,
                color: "#66BB6A",
                fontWeight: 700,
              }}
            >
              WORLD MODE
            </span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Scene 8: Outro CTA (49-55s) ---

const OutroCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleIn = spring({ frame, fps, delay: 5, config: SPRING_SMOOTH });
  const titleOpacity = interpolate(titleIn, [0, 1], [0, 1]);
  const titleY = interpolate(titleIn, [0, 1], [30, 0]);

  const subtitleIn = spring({
    frame,
    fps,
    delay: Math.round(0.8 * fps),
    config: SPRING_SMOOTH,
  });
  const subtitleOpacity = interpolate(subtitleIn, [0, 1], [0, 1]);

  const ctaIn = spring({
    frame,
    fps,
    delay: Math.round(1.5 * fps),
    config: SPRING_BOUNCY,
  });
  const ctaScale = interpolate(ctaIn, [0, 1], [0, 1]);
  const ctaOpacity = interpolate(ctaIn, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Pulsing glow
  const glowPhase = (frame / fps) * 2;
  const glow = 8 + Math.sin(glowPhase) * 4;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: isVertical ? 28 : 24,
      }}
    >
      <ParticleField count={35} color={COLORS.neoToken} speed={0.6} />

      {/* Title */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 42 : 48,
            color: COLORS.neoToken,
            textShadow: `2px 2px ${glow}px rgba(255,215,0,0.5)`,
          }}
        >
          Your Bot. Your Skills.
        </span>
      </div>

      {/* Subtitle */}
      <div
        style={{
          opacity: subtitleOpacity,
          textAlign: "center",
          maxWidth: isVertical ? 380 : 500,
        }}
      >
        <span
          style={{
            fontFamily: roboto,
            fontSize: isVertical ? 18 : 20,
            color: "rgba(255,255,255,0.8)",
            lineHeight: 1.5,
          }}
        >
          Connect OpenClaw. Train in arena or world. Export SKILL.md to any
          framework.
        </span>
      </div>

      {/* CTA */}
      <div
        style={{
          opacity: ctaOpacity,
          transform: `scale(${ctaScale})`,
        }}
      >
        <CTAButton text="Start Training" subtitle="play.clawville.com" />
      </div>

      {/* npm install hint */}
      <div style={{ opacity: subtitleOpacity }}>
        <div
          style={{
            background: "rgba(0,0,0,0.5)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 8,
            padding: "8px 20px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 14,
              color: "rgba(255,255,255,0.6)",
            }}
          >
            npm i -g openclaw@latest
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Main Composition ---

export const OpenClawShowcase: React.FC = () => {
  const { fps } = useVideoConfig();

  // Scene timings (seconds)
  const S = {
    intro: { start: 0, dur: 3 },
    arenaConnect: { start: 3, dur: 8 },
    arenaCombat: { start: 11, dur: 8 },
    arenaLeaderboard: { start: 19, dur: 7 },
    worldConnect: { start: 26, dur: 8 },
    worldChatLearn: { start: 34, dur: 8 },
    worldExport: { start: 42, dur: 7 },
    outro: { start: 49, dur: 6 },
  };

  const TITLE_CARD_DUR = 1.5; // seconds for each title card

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bg, COLORS.bgGradient1, COLORS.bgLight]} />

      {/* Scene 1: Intro (0-3s) */}
      <Sequence durationInFrames={S.intro.dur * fps}>
        <AbsoluteFill>
          <MapBackground
            zoom={1.3}
            tintColor={COLORS.bg}
            tintOpacity={0.75}
            panX={0.03}
            panY={0}
          />
        </AbsoluteFill>
        <IntroTitle />
      </Sequence>

      {/* Scene 2: Arena Connect Bot (3-11s) */}
      <Sequence
        from={S.arenaConnect.start * fps}
        durationInFrames={S.arenaConnect.dur * fps}
      >
        <Sequence durationInFrames={Math.round(TITLE_CARD_DUR * fps)}>
          <TitleCard
            title="Connect Your Bot"
            subtitle="Register an OpenClaw avatar in the arena"
            badge="Arena Mode"
            badgeColor="#EF5350"
          />
        </Sequence>
        <GifScene
          gifSrc="gifs/arena-connect-bot.gif"
          label="Avatar registration + arena entry"
          titleCardDuration={0}
        />
      </Sequence>

      {/* Scene 3: Arena Combat + Settings (11-19s) */}
      <Sequence
        from={S.arenaCombat.start * fps}
        durationInFrames={S.arenaCombat.dur * fps}
      >
        <Sequence durationInFrames={Math.round(TITLE_CARD_DUR * fps)}>
          <TitleCard
            title="Combat & Settings"
            subtitle="Adjust speed, watch battles unfold"
            badge="Arena Mode"
            badgeColor="#EF5350"
          />
        </Sequence>
        <GifScene
          gifSrc="gifs/arena-combat.gif"
          label="Real-time combat + settings panel"
          titleCardDuration={0}
        />
      </Sequence>

      {/* Scene 4: Arena Leaderboard + Disconnect (19-26s) */}
      <Sequence
        from={S.arenaLeaderboard.start * fps}
        durationInFrames={S.arenaLeaderboard.dur * fps}
      >
        <Sequence durationInFrames={Math.round(TITLE_CARD_DUR * fps)}>
          <TitleCard
            title="Leaderboard & Rounds"
            subtitle="Track rankings, disconnect when done"
            badge="Arena Mode"
            badgeColor="#EF5350"
          />
        </Sequence>
        <GifScene
          gifSrc="gifs/arena-leaderboard.gif"
          label="Leaderboard + round transitions"
          titleCardDuration={0}
        />
      </Sequence>

      {/* Scene 5: World Connect (26-34s) */}
      <Sequence
        from={S.worldConnect.start * fps}
        durationInFrames={S.worldConnect.dur * fps}
      >
        <Sequence durationInFrames={Math.round(TITLE_CARD_DUR * fps)}>
          <TitleCard
            title="Connect in World"
            subtitle="Plug your bot into The Depths"
            badge="World Mode"
            badgeColor="#66BB6A"
          />
        </Sequence>
        <GifScene
          gifSrc="gifs/world-connect.gif"
          label="OpenClaw modal + bot connection"
          titleCardDuration={0}
        />
      </Sequence>

      {/* Scene 6: World Chat & Learn (34-42s) */}
      <Sequence
        from={S.worldChatLearn.start * fps}
        durationInFrames={S.worldChatLearn.dur * fps}
      >
        <Sequence durationInFrames={Math.round(TITLE_CARD_DUR * fps)}>
          <TitleCard
            title="Chat & Learn"
            subtitle="Your bot absorbs Solana knowledge"
            badge="World Mode"
            badgeColor="#66BB6A"
          />
        </Sequence>
        <GifScene
          gifSrc="gifs/world-chat-learn.gif"
          label="Lobster chat + knowledge acquisition"
          titleCardDuration={0}
        />
      </Sequence>

      {/* Scene 7: World Export (42-49s) */}
      <Sequence
        from={S.worldExport.start * fps}
        durationInFrames={S.worldExport.dur * fps}
      >
        <Sequence durationInFrames={Math.round(TITLE_CARD_DUR * fps)}>
          <TitleCard
            title="Export SKILL.md"
            subtitle="Package knowledge into a portable skill"
            badge="World Mode"
            badgeColor="#66BB6A"
          />
        </Sequence>
        <GifScene
          gifSrc="gifs/world-export.gif"
          label="Export + Build Skill + Disconnect"
          titleCardDuration={0}
        />
      </Sequence>

      {/* Scene 8: Outro CTA (49-55s) */}
      <Sequence
        from={S.outro.start * fps}
        durationInFrames={S.outro.dur * fps}
      >
        <OutroCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
