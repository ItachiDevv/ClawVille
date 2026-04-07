import React from "react";
import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { LogoReveal } from "../shared/LogoReveal";
import { CTAButton } from "../shared/CTAButton";
import { ParticleField } from "../shared/ParticleField";
import { SPRING_BOUNCY, SPRING_SNAPPY, FPS } from "../../constants/timing";
import { COLORS } from "../../constants/colors";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// ─── Branded Intro (0-3s) ───────────────────────────────────────────
const BrandedIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  const logoE = spring({ frame, fps, config: SPRING_BOUNCY });
  const titleE = spring({ frame, fps, delay: 10, config: SPRING_SNAPPY });
  const subE = spring({ frame, fps, delay: 18, config: { damping: 200 } });
  const lineW = interpolate(titleE, [0, 1], [0, isV ? 300 : 500]);

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${COLORS.bg} 0%, ${COLORS.bgGradient2} 40%, ${COLORS.bgGradient1} 100%)`,
        justifyContent: "center",
        alignItems: "center",
        gap: 20,
      }}
    >
      <ParticleField count={25} color={COLORS.accent} speed={1.2} />
      <div style={{ transform: `scale(${interpolate(logoE, [0, 1], [0.3, 1])})`, opacity: interpolate(logoE, [0, 0.5], [0, 1], { extrapolateRight: "clamp" }) }}>
        <LogoReveal size={isV ? 52 : 60} />
      </div>
      <div style={{ width: lineW, height: 2, background: `linear-gradient(90deg, transparent, ${COLORS.accent}, transparent)` }} />
      <span style={{
        fontFamily: lobster, fontSize: isV ? 34 : 42, color: COLORS.accent,
        textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 20px ${COLORS.accent}4D`,
        opacity: interpolate(titleE, [0, 0.5], [0, 1], { extrapolateRight: "clamp" }),
        transform: `translateY(${interpolate(titleE, [0, 1], [30, 0])}px)`,
        textAlign: "center", padding: "0 30px",
      }}>
        Skill Creation
      </span>
      <span style={{
        fontFamily: roboto, fontSize: isV ? 18 : 20, color: "rgba(255,255,255,0.8)",
        opacity: interpolate(subE, [0, 1], [0, 1]), textAlign: "center", padding: "0 40px",
      }}>
        Your agent learns. You export skills.
      </span>
    </AbsoluteFill>
  );
};

// ─── Recording Scene with overlay callout ───────────────────────────
const RecordingScene: React.FC<{
  src: string;
  startFrom: number;
  label: string;
  callout?: string;
  calloutDelay?: number;
}> = ({ src, startFrom, label, callout, calloutDelay = 20 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  // Label bar at bottom
  const labelE = spring({ frame, fps, delay: 5, config: SPRING_SNAPPY });
  const labelY = interpolate(labelE, [0, 1], [60, 0]);
  const labelOp = interpolate(labelE, [0, 0.4], [0, 1], { extrapolateRight: "clamp" });

  // Callout badge
  const calloutE = callout ? spring({ frame, fps, delay: calloutDelay, config: SPRING_BOUNCY }) : 0;
  const calloutScale = interpolate(calloutE as number, [0, 1], [0, 1]);
  const calloutOp = interpolate(calloutE as number, [0, 0.3], [0, 1], { extrapolateRight: "clamp" });

  // LIVE dot
  const pulse = 0.7 + Math.sin(frame * 0.15) * 0.3;

  return (
    <AbsoluteFill>
      {/* Full-screen recording */}
      <OffthreadVideo
        src={staticFile(`recordings/${src}`)}
        startFrom={Math.round(startFrom * 30)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />

      {/* Subtle vignette */}
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)" }} />

      {/* LIVE badge top-right */}
      <div style={{
        position: "absolute", top: 16, right: 16,
        display: "flex", alignItems: "center", gap: 8,
        background: "rgba(0,0,0,0.65)", borderRadius: 20, padding: "6px 14px",
        border: "1px solid rgba(255,255,255,0.15)",
      }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.danger, opacity: pulse, boxShadow: `0 0 6px ${COLORS.danger}` }} />
        <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.9)", letterSpacing: 1 }}>LIVE</span>
      </div>

      {/* ClawVille watermark top-left */}
      <div style={{
        position: "absolute", top: 16, left: 16,
        background: "rgba(0,0,0,0.5)", borderRadius: 16, padding: "5px 14px",
        border: `1px solid ${COLORS.accent}4D`,
      }}>
        <span style={{ fontFamily: lobster, fontSize: 16, color: COLORS.accent, textShadow: "1px 1px 2px rgba(0,0,0,0.5)" }}>ClawVille</span>
      </div>

      {/* Bottom label bar */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
        padding: isV ? "40px 24px 24px" : "30px 32px 20px",
        transform: `translateY(${labelY}px)`, opacity: labelOp,
      }}>
        <span style={{
          fontFamily: roboto, fontSize: isV ? 20 : 24, fontWeight: 700, color: "#fff",
          textShadow: "1px 1px 3px rgba(0,0,0,0.5)",
        }}>{label}</span>
      </div>

      {/* Feature callout badge */}
      {callout && (
        <div style={{
          position: "absolute",
          top: isV ? 70 : 60, right: isV ? 16 : 24,
          background: `linear-gradient(135deg, ${COLORS.secondary}E6, ${COLORS.secondary}CC)`,
          borderRadius: 12, padding: "8px 16px",
          transform: `scale(${calloutScale})`, opacity: calloutOp,
          boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
          border: "2px solid rgba(255,255,255,0.3)",
        }}>
          <span style={{ fontFamily: roboto, fontSize: 14, fontWeight: 700, color: "#fff" }}>{callout}</span>
        </div>
      )}
    </AbsoluteFill>
  );
};

// ─── Branded Outro (last 4s) ────────────────────────────────────────
const BrandedOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${COLORS.bg} 0%, ${COLORS.bgGradient2} 50%, ${COLORS.bgGradient1} 100%)`,
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <ParticleField count={20} color={COLORS.accent} speed={0.8} />
      <LogoReveal size={isV ? 48 : 56} />
      <CTAButton text="Build Your Skills" subtitle="play.clawville.com" delay={10} />
    </AbsoluteFill>
  );
};

// ─── Main Composition (45s) ─────────────────────────────────────────
// Flow: Intro(3s) -> Connect OpenClaw(8s) -> Chat & Learn(8s) -> Buy Books(6s) -> Skills Inventory(8s) -> Export Skills(8s) -> Outro(4s)
export const SkillCreationPromo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {/* Branded intro */}
      <Sequence durationInFrames={3 * fps}>
        <BrandedIntro />
      </Sequence>

      {/* Scene 1: Connect your agent via OpenClaw */}
      <Sequence from={3 * fps} durationInFrames={8 * fps}>
        <RecordingScene
          src="game-openclaw-connect.mp4"
          startFrom={3}
          label="Connect your AI agent via OpenClaw"
          callout="Any AI provider"
          calloutDelay={30}
        />
      </Sequence>

      {/* Scene 2: Chat with building NPCs - knowledge transfer */}
      <Sequence from={11 * fps} durationInFrames={8 * fps}>
        <RecordingScene
          src="game-building-chat-learn.mp4"
          startFrom={2}
          label="NPCs teach your agent crypto knowledge"
          callout="+1 Knowledge"
          calloutDelay={45}
        />
      </Sequence>

      {/* Scene 3: Buy knowledge books from shops */}
      <Sequence from={19 * fps} durationInFrames={6 * fps}>
        <RecordingScene
          src="shop-books.mp4"
          startFrom={0}
          label="Buy knowledge books with ClawTokens"
          callout="18 Unique Books"
        />
      </Sequence>

      {/* Scene 4: Skills inventory & management */}
      <Sequence from={25 * fps} durationInFrames={8 * fps}>
        <RecordingScene
          src="game-menu-skills-inventory.mp4"
          startFrom={5}
          label="Track your agent's growing skill set"
          callout="Skill Builder"
          calloutDelay={25}
        />
      </Sequence>

      {/* Scene 5: OpenClaw skills export */}
      <Sequence from={33 * fps} durationInFrames={8 * fps}>
        <RecordingScene
          src="game-openclaw-skills.mp4"
          startFrom={1}
          label="Export skills as SKILL.md for any platform"
          callout="Portable Skills"
          calloutDelay={30}
        />
      </Sequence>

      {/* Branded outro */}
      <Sequence from={41 * fps} durationInFrames={4 * fps}>
        <BrandedOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
