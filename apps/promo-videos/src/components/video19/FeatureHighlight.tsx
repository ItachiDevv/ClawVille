import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  staticFile,
} from "remotion";
import { Img } from "remotion";
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
  FEATURE_SCENES,
  INTRO_DURATION,
  OUTRO_DURATION,
  TITLE_CARD_DURATION,
} from "../../constants/feature-highlight";

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

// --- Image Scene ---

const ImageScene: React.FC<{
  imgSrc: string;
  label: string;
  titleCardDuration?: number;
}> = ({ imgSrc, label, titleCardDuration = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isVertical = height > width;

  const entrance = spring({
    frame,
    fps,
    delay: Math.round(titleCardDuration * fps),
    config: SPRING_SMOOTH,
  });
  const imgOpacity = interpolate(entrance, [0, 0.5], [0, 1], {
    extrapolateRight: "clamp",
  });
  const imgScale = interpolate(entrance, [0, 1], [0.92, 1]);

  // Subtle Ken Burns zoom effect on the screenshot
  const sceneDuration = 8 * fps; // approx
  const kenBurns = interpolate(frame, [0, sceneDuration], [1, 1.08], {
    extrapolateRight: "clamp",
  });

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
      <div
        style={{
          opacity: imgOpacity,
          transform: `scale(${imgScale})`,
          borderRadius: 12,
          overflow: "hidden",
          border: "3px solid rgba(255,255,255,0.15)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          maxWidth: isVertical ? "95%" : "85%",
          maxHeight: isVertical ? "70%" : "80%",
        }}
      >
        <div style={{ transform: `scale(${kenBurns})`, transformOrigin: "center center" }}>
          <Img
            src={staticFile(imgSrc)}
            style={{ width: isVertical ? 1000 : 1400, objectFit: "contain" }}
          />
        </div>
      </div>

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

  const featureCountIn = spring({
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
      <ParticleField count={30} color={COLORS.clawToken} speed={0.5} />

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
            color: COLORS.clawToken,
            textShadow: "3px 3px 10px rgba(0,0,0,0.6)",
          }}
        >
          ClawVille
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
          Feature Highlight
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          opacity: interpolate(featureCountIn, [0, 0.5], [0, 1], {
            extrapolateRight: "clamp",
          }),
          transform: `scale(${interpolate(featureCountIn, [0, 1], [0, 1])})`,
        }}
      >
        <div
          style={{
            background: "rgba(255,215,0,0.15)",
            border: "2px solid rgba(255,215,0,0.5)",
            borderRadius: 20,
            padding: "8px 20px",
          }}
        >
          <span
            style={{
              fontFamily: robotoMono,
              fontSize: 14,
              color: COLORS.clawToken,
              fontWeight: 700,
            }}
          >
            8 FEATURES
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
      <ParticleField count={35} color={COLORS.clawToken} speed={0.6} />

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
            color: COLORS.clawToken,
            textShadow: `2px 2px ${glow}px rgba(255,215,0,0.5)`,
          }}
        >
          Start Playing Today
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
          Create your lobster. Explore The Depths. Train your AI. Battle in the
          arena.
        </span>
      </div>

      <div
        style={{
          opacity: ctaOpacity,
          transform: `scale(${ctaScale})`,
        }}
      >
        <CTAButton text="Play Now" subtitle="play.clawville.com" />
      </div>
    </AbsoluteFill>
  );
};

// --- Main Composition ---

export const FeatureHighlight: React.FC = () => {
  const { fps } = useVideoConfig();

  // Compute scene start times from durations
  let offset = INTRO_DURATION * fps;
  const sceneTimings = FEATURE_SCENES.map((scene) => {
    const start = offset;
    const dur = scene.duration * fps;
    offset += dur;
    return { ...scene, startFrame: start, durationFrames: dur };
  });

  return (
    <AbsoluteFill>
      <GradientBackground colors={[COLORS.bg, COLORS.bgGradient1, COLORS.bgLight]} />

      {/* Intro (0 - INTRO_DURATION) */}
      <Sequence durationInFrames={INTRO_DURATION * fps}>
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

      {/* Feature scenes */}
      {sceneTimings.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationFrames}
        >
          {/* Title card overlay for first TITLE_CARD_DURATION seconds */}
          <Sequence durationInFrames={Math.round(TITLE_CARD_DURATION * fps)}>
            <TitleCard
              title={scene.title}
              subtitle={scene.subtitle}
              badge={scene.badge}
              badgeColor={scene.badgeColor}
            />
          </Sequence>
          {/* Screenshot with Ken Burns */}
          <ImageScene
            imgSrc={scene.imgSrc}
            label={scene.label}
            titleCardDuration={0}
          />
        </Sequence>
      ))}

      {/* Outro */}
      <Sequence from={offset} durationInFrames={OUTRO_DURATION * fps}>
        <OutroScene />
      </Sequence>
    </AbsoluteFill>
  );
};
