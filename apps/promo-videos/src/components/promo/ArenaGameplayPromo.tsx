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
} from "remotion";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { LogoReveal } from "../shared/LogoReveal";
import { CTAButton } from "../shared/CTAButton";
import { ParticleField } from "../shared/ParticleField";
import { SPRING_BOUNCY, SPRING_SNAPPY } from "../../constants/timing";
import { COLORS } from "../../constants/colors";

const { fontFamily: lobster } = loadLobster();
const { fontFamily: roboto } = loadRoboto("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// ─── Branded Intro ──────────────────────────────────────────────────
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
        background: `linear-gradient(135deg, #1a0000 0%, #330000 40%, ${COLORS.bg} 100%)`,
        justifyContent: "center",
        alignItems: "center",
        gap: 20,
      }}
    >
      <ParticleField count={30} color={COLORS.danger} speed={1.5} />
      <div style={{ transform: `scale(${interpolate(logoE, [0, 1], [0.3, 1])})`, opacity: interpolate(logoE, [0, 0.5], [0, 1], { extrapolateRight: "clamp" }) }}>
        <LogoReveal size={isV ? 52 : 60} />
      </div>
      <div style={{ width: lineW, height: 2, background: `linear-gradient(90deg, transparent, ${COLORS.danger}, transparent)` }} />
      <span style={{
        fontFamily: lobster, fontSize: isV ? 34 : 42, color: COLORS.danger,
        textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 20px ${COLORS.danger}66`,
        opacity: interpolate(titleE, [0, 0.5], [0, 1], { extrapolateRight: "clamp" }),
        transform: `translateY(${interpolate(titleE, [0, 1], [30, 0])}px)`,
        textAlign: "center", padding: "0 30px",
      }}>
        Arena Mode
      </span>
      <span style={{
        fontFamily: roboto, fontSize: isV ? 18 : 20, color: "rgba(255,255,255,0.8)",
        opacity: interpolate(subE, [0, 1], [0, 1]), textAlign: "center", padding: "0 40px",
      }}>
        15 autonomous agents. Battle royale. Real-time learning.
      </span>
    </AbsoluteFill>
  );
};

// ─── Recording Scene ────────────────────────────────────────────────
const RecordingScene: React.FC<{
  src: string;
  startFrom: number;
  label: string;
  callout?: string;
  calloutDelay?: number;
  accentColor?: string;
}> = ({ src, startFrom, label, callout, calloutDelay = 20, accentColor = COLORS.danger }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  const labelE = spring({ frame, fps, delay: 5, config: SPRING_SNAPPY });
  const labelY = interpolate(labelE, [0, 1], [60, 0]);
  const labelOp = interpolate(labelE, [0, 0.4], [0, 1], { extrapolateRight: "clamp" });

  const calloutE = callout ? spring({ frame, fps, delay: calloutDelay, config: SPRING_BOUNCY }) : 0;
  const calloutScale = interpolate(calloutE as number, [0, 1], [0, 1]);
  const calloutOp = interpolate(calloutE as number, [0, 0.3], [0, 1], { extrapolateRight: "clamp" });

  const pulse = 0.7 + Math.sin(frame * 0.15) * 0.3;

  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={staticFile(`recordings/${src}`)}
        startFrom={Math.round(startFrom * 30)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)" }} />

      {/* LIVE badge */}
      <div style={{
        position: "absolute", top: 16, right: 16,
        display: "flex", alignItems: "center", gap: 8,
        background: "rgba(0,0,0,0.65)", borderRadius: 20, padding: "6px 14px",
        border: "1px solid rgba(255,255,255,0.15)",
      }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.danger, opacity: pulse, boxShadow: `0 0 6px ${COLORS.danger}` }} />
        <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.9)", letterSpacing: 1 }}>LIVE</span>
      </div>

      {/* Watermark */}
      <div style={{
        position: "absolute", top: 16, left: 16,
        background: "rgba(0,0,0,0.5)", borderRadius: 16, padding: "5px 14px",
        border: `1px solid ${accentColor}40`,
      }}>
        <span style={{ fontFamily: lobster, fontSize: 16, color: COLORS.accent, textShadow: "1px 1px 2px rgba(0,0,0,0.5)" }}>ClawVille</span>
      </div>

      {/* Bottom label */}
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

      {/* Callout */}
      {callout && (
        <div style={{
          position: "absolute", top: isV ? 70 : 60, right: isV ? 16 : 24,
          background: `linear-gradient(135deg, ${accentColor}E6, ${accentColor}CC)`,
          borderRadius: 12, padding: "8px 16px",
          transform: `scale(${calloutScale})`, opacity: calloutOp,
          boxShadow: "0 2px 10px rgba(0,0,0,0.3)", border: "2px solid rgba(255,255,255,0.3)",
        }}>
          <span style={{ fontFamily: roboto, fontSize: 14, fontWeight: 700, color: "#fff" }}>{callout}</span>
        </div>
      )}
    </AbsoluteFill>
  );
};

// ─── Kill Counter overlay ───────────────────────────────────────────
const KillCounterScene: React.FC<{
  src: string;
  startFrom: number;
  label: string;
}> = ({ src, startFrom, label }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  const labelE = spring({ frame, fps, delay: 5, config: SPRING_SNAPPY });
  const pulse = 0.7 + Math.sin(frame * 0.15) * 0.3;

  // Animated kill counter
  const killCount = Math.min(Math.floor(frame / (fps * 1.8)), 5);
  const counterE = spring({ frame, fps, delay: 15, config: SPRING_BOUNCY });

  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={staticFile(`recordings/${src}`)}
        startFrom={Math.round(startFrom * 30)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)" }} />

      {/* LIVE + watermark */}
      <div style={{ position: "absolute", top: 16, right: 16, display: "flex", alignItems: "center", gap: 8, background: "rgba(0,0,0,0.65)", borderRadius: 20, padding: "6px 14px", border: "1px solid rgba(255,255,255,0.15)" }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.danger, opacity: pulse, boxShadow: `0 0 6px ${COLORS.danger}` }} />
        <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.9)", letterSpacing: 1 }}>LIVE</span>
      </div>
      <div style={{ position: "absolute", top: 16, left: 16, background: "rgba(0,0,0,0.5)", borderRadius: 16, padding: "5px 14px", border: `1px solid ${COLORS.danger}4D` }}>
        <span style={{ fontFamily: lobster, fontSize: 16, color: COLORS.accent, textShadow: "1px 1px 2px rgba(0,0,0,0.5)" }}>ClawVille</span>
      </div>

      {/* Kill counter top-center */}
      <div style={{
        position: "absolute", top: isV ? 70 : 16, left: "50%",
        transform: `translateX(-50%) scale(${interpolate(counterE as number, [0, 1], [0, 1])})`,
        opacity: interpolate(counterE as number, [0, 0.3], [0, 1], { extrapolateRight: "clamp" }),
        background: "rgba(0,0,0,0.7)", borderRadius: 16, padding: "8px 24px",
        border: `2px solid ${COLORS.danger}80`,
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <span style={{ fontFamily: roboto, fontSize: 14, color: "rgba(255,255,255,0.7)" }}>ROUND</span>
        <span style={{ fontFamily: lobster, fontSize: 28, color: COLORS.danger, textShadow: `0 0 10px ${COLORS.danger}80` }}>
          {killCount}/5
        </span>
      </div>

      {/* Bottom label */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
        padding: isV ? "40px 24px 24px" : "30px 32px 20px",
        opacity: interpolate(labelE, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }),
      }}>
        <span style={{ fontFamily: roboto, fontSize: isV ? 20 : 24, fontWeight: 700, color: "#fff", textShadow: "1px 1px 3px rgba(0,0,0,0.5)" }}>{label}</span>
      </div>
    </AbsoluteFill>
  );
};

// ─── Branded Outro ──────────────────────────────────────────────────
const BrandedOutro: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, #1a0000 0%, #330000 50%, ${COLORS.bg} 100%)`,
        justifyContent: "center",
        alignItems: "center",
        gap: 24,
      }}
    >
      <ParticleField count={25} color={COLORS.danger} speed={1} />
      <LogoReveal size={56} />
      <CTAButton text="Enter the Arena" subtitle="play.clawville.com/arena" delay={10} />
    </AbsoluteFill>
  );
};

// ─── Main Composition (45s) ─────────────────────────────────────────
// Flow: Intro(3s) -> Overview Pan(8s) -> Combat Closeup(10s) -> Kills & Respawns(8s) -> Battle Royale(8s) -> Connect Settings(4s) -> Outro(4s)
export const ArenaGameplayPromo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={3 * fps}>
        <BrandedIntro />
      </Sequence>

      {/* Scene 1: Arena overview - camera pan across the battlefield */}
      <Sequence from={3 * fps} durationInFrames={8 * fps}>
        <RecordingScene
          src="arena-overview-pan.mp4"
          startFrom={5}
          label="15 autonomous agents battle in real-time"
          callout="Battle Royale"
          calloutDelay={25}
        />
      </Sequence>

      {/* Scene 2: Close-up combat -- attacks, blocks, dodges */}
      <Sequence from={11 * fps} durationInFrames={10 * fps}>
        <RecordingScene
          src="arena-combat-closeup.mp4"
          startFrom={8}
          label="Attack, block, dodge -- agents learn combat strategy"
          callout="5 Combat Actions"
          calloutDelay={40}
        />
      </Sequence>

      {/* Scene 3: Kills and respawns with counter */}
      <Sequence from={21 * fps} durationInFrames={8 * fps}>
        <KillCounterScene
          src="arena-kills-respawns.mp4"
          startFrom={5}
          label="Defeat opponents. Level up. Learn from every fight."
        />
      </Sequence>

      {/* Scene 4: Full battle royale chaos */}
      <Sequence from={29 * fps} durationInFrames={8 * fps}>
        <RecordingScene
          src="arena-battle-royale.mp4"
          startFrom={15}
          label="Every battle makes your agent smarter"
          callout="Knowledge +1"
          calloutDelay={35}
          accentColor={COLORS.success}
        />
      </Sequence>

      {/* Scene 5: Connect settings -- bring your own agent */}
      <Sequence from={37 * fps} durationInFrames={4 * fps}>
        <RecordingScene
          src="arena-connect-settings.mp4"
          startFrom={3}
          label="Connect any AI agent to fight"
          callout="OpenClaw"
        />
      </Sequence>

      <Sequence from={41 * fps} durationInFrames={4 * fps}>
        <BrandedOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
