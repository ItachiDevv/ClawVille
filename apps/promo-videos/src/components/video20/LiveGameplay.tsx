import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  staticFile,
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
import {
  ALL_SCENES,
  RECORDING_INTRO_DURATION,
  RECORDING_OUTRO_DURATION,
  RECORDING_TITLE_CARD_DURATION,
  type RecordingScene,
} from "../../constants/live-recordings";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
const { fontFamily: robotoMono } = loadRobotoMono("normal", {
  weights: ["400"],
  subsets: ["latin"],
});

// --- Title Card ---

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
        zIndex: 10,
      }}
    >
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

// --- Video Scene (replaces ImageScene) ---

const VideoScene: React.FC<{
  scene: RecordingScene;
}> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const entrance = spring({
    frame,
    fps,
    delay: Math.round(RECORDING_TITLE_CARD_DURATION * fps * 0.5),
    config: SPRING_SMOOTH,
  });
  const vidOpacity = interpolate(entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const vidScale = interpolate(entrance, [0, 1], [0.94, 1]);

  // Fade out at end of scene
  const sceneDur = scene.duration * fps;
  const fadeOut = interpolate(
    frame,
    [sceneDur - Math.round(0.5 * fps), sceneDur],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const labelEntrance = spring({
    frame,
    fps,
    delay: Math.round((RECORDING_TITLE_CARD_DURATION + 0.3) * fps),
    config: SPRING_SNAPPY,
  });
  const labelOpacity = interpolate(labelEntrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });

  // "LIVE" badge pulse
  const pulse = 0.8 + Math.sin((frame / fps) * 4) * 0.2;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 12,
        padding: isVertical ? "40px 20px" : "30px 40px",
        opacity: fadeOut,
      }}
    >
      <div
        style={{
          position: "relative",
          opacity: vidOpacity,
          transform: `scale(${vidScale})`,
          borderRadius: 12,
          overflow: "hidden",
          border: `3px solid ${scene.badgeColor}44`,
          boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 20px ${scene.badgeColor}22`,
          maxWidth: isVertical ? "95%" : "85%",
          maxHeight: isVertical ? "65%" : "75%",
        }}
      >
        <OffthreadVideo
          src={staticFile(scene.videoSrc)}
          style={{
            width: isVertical ? 1000 : 1400,
            objectFit: "cover",
          }}
        />

        {/* LIVE indicator */}
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "rgba(0,0,0,0.7)",
            borderRadius: 6,
            padding: "4px 10px",
            opacity: pulse,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#EF5350",
              boxShadow: "0 0 6px rgba(239,83,80,0.8)",
            }}
          />
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 11,
              color: "#EF5350",
              fontWeight: 700,
              letterSpacing: 2,
            }}
          >
            LIVE
          </span>
        </div>

        {/* Scene badge overlay */}
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: `${scene.badgeColor}cc`,
            borderRadius: 6,
            padding: "4px 10px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 11,
              color: "#fff",
              fontWeight: 700,
              letterSpacing: 1,
            }}
          >
            {scene.badge}
          </span>
        </div>
      </div>

      {/* Label bar */}
      <div style={{ opacity: labelOpacity }}>
        <div
          style={{
            background: "rgba(0,0,0,0.6)",
            border: `1px solid ${scene.badgeColor}44`,
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
            {scene.label}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Section Divider ---

const SectionDivider: React.FC<{
  title: string;
  emoji: string;
  color: string;
}> = ({ title, emoji, color }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const titleIn = spring({ frame, fps, delay: 3, config: SPRING_BOUNCY });
  const titleScale = interpolate(titleIn, [0, 1], [0.3, 1]);
  const titleOpacity = interpolate(titleIn, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div
        style={{
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: isVertical ? 64 : 72, marginBottom: 8 }}>
          {emoji}
        </div>
        <span
          style={{
            fontFamily: lobster,
            fontSize: isVertical ? 42 : 48,
            color,
            textShadow: `2px 2px 10px ${color}44`,
          }}
        >
          {title}
        </span>
      </div>
    </AbsoluteFill>
  );
};

// --- Intro Scene ---

const IntroScene: React.FC = () => {
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

  const badgeIn = spring({
    frame,
    fps,
    delay: Math.round(1.4 * fps),
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
          ClawVille Live
        </span>
      </div>

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
          Real gameplay footage
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          opacity: interpolate(badgeIn, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `scale(${interpolate(badgeIn, [0, 1], [0, 1])})`,
        }}
      >
        <div
          style={{
            background: "rgba(102,187,106,0.15)",
            border: "2px solid rgba(102,187,106,0.5)",
            borderRadius: 20,
            padding: "8px 16px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 13,
              color: "#66BB6A",
              fontWeight: 700,
            }}
          >
            GAME MODE
          </span>
        </div>
        <div
          style={{
            background: "rgba(239,83,80,0.15)",
            border: "2px solid rgba(239,83,80,0.5)",
            borderRadius: 20,
            padding: "8px 16px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 13,
              color: "#EF5350",
              fontWeight: 700,
            }}
          >
            ARENA MODE
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- Outro Scene ---

const OutroScene: React.FC = () => {
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
          Play Now
        </span>
      </div>

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
          Train your AI lobster. Battle in the arena. Export your skills.
        </span>
      </div>

      <div
        style={{
          opacity: ctaOpacity,
          transform: `scale(${ctaScale})`,
        }}
      >
        <CTAButton text="Start Playing" subtitle="play.clawville.com" />
      </div>
    </AbsoluteFill>
  );
};

// --- Main Composition ---

export const LiveGameplay: React.FC = () => {
  const { fps } = useVideoConfig();

  const introFrames = RECORDING_INTRO_DURATION * fps;
  const outroFrames = RECORDING_OUTRO_DURATION * fps;
  const gameDividerFrames = Math.round(1.5 * fps);
  const arenaDividerFrames = Math.round(1.5 * fps);

  const gameScenes = ALL_SCENES.slice(0, 5);
  const arenaScenes = ALL_SCENES.slice(5);

  // Build timeline
  let offset = introFrames;

  // Game mode divider
  const gameDividerStart = offset;
  offset += gameDividerFrames;

  // Game scenes
  const gameTimings = gameScenes.map((scene) => {
    const start = offset;
    const dur = scene.duration * fps;
    offset += dur;
    return { ...scene, startFrame: start, durationFrames: dur };
  });

  // Arena mode divider
  const arenaDividerStart = offset;
  offset += arenaDividerFrames;

  // Arena scenes
  const arenaTimings = arenaScenes.map((scene) => {
    const start = offset;
    const dur = scene.duration * fps;
    offset += dur;
    return { ...scene, startFrame: start, durationFrames: dur };
  });

  const outroStart = offset;

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bg, COLORS.bgGradient1, COLORS.bgLight]} />

      {/* Intro */}
      <Sequence durationInFrames={introFrames}>
        <AbsoluteFill>
          <MapBackground
            zoom={1.3}
            tintColor={COLORS.bg}
            tintOpacity={0.75}
            panX={0.03}
            panY={0}
          />
        </AbsoluteFill>
        <IntroScene />
      </Sequence>

      {/* Game Mode divider */}
      <Sequence from={gameDividerStart} durationInFrames={gameDividerFrames}>
        <SectionDivider title="Game Mode" emoji="🌊" color="#66BB6A" />
      </Sequence>

      {/* Game scenes */}
      {gameTimings.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationFrames}
        >
          <Sequence durationInFrames={Math.round(RECORDING_TITLE_CARD_DURATION * fps)}>
            <TitleCard
              title={scene.title}
              subtitle={scene.subtitle}
              badge={scene.badge}
              badgeColor={scene.badgeColor}
            />
          </Sequence>
          <VideoScene scene={scene} />
        </Sequence>
      ))}

      {/* Arena Mode divider */}
      <Sequence from={arenaDividerStart} durationInFrames={arenaDividerFrames}>
        <SectionDivider title="Arena Mode" emoji="⚔️" color="#EF5350" />
      </Sequence>

      {/* Arena scenes */}
      {arenaTimings.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationFrames}
        >
          <Sequence durationInFrames={Math.round(RECORDING_TITLE_CARD_DURATION * fps)}>
            <TitleCard
              title={scene.title}
              subtitle={scene.subtitle}
              badge={scene.badge}
              badgeColor={scene.badgeColor}
            />
          </Sequence>
          <VideoScene scene={scene} />
        </Sequence>
      ))}

      {/* Outro */}
      <Sequence from={outroStart} durationInFrames={outroFrames}>
        <OutroScene />
      </Sequence>
    </AbsoluteFill>
  );
};
