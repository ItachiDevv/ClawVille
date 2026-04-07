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

// ─── Hero Intro (0-4s) ─────────────────────────────────────────────
const HeroIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  const logoE = spring({ frame, fps, config: SPRING_BOUNCY });
  const tagE = spring({ frame, fps, delay: 12, config: SPRING_SNAPPY });
  const sub1E = spring({ frame, fps, delay: 22, config: { damping: 200 } });
  const sub2E = spring({ frame, fps, delay: 30, config: { damping: 200 } });
  const lineW = interpolate(tagE, [0, 1], [0, isV ? 350 : 600]);

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${COLORS.bg} 0%, ${COLORS.bgGradient1} 30%, ${COLORS.bgGradient2} 60%, ${COLORS.bg} 100%)`,
        justifyContent: "center",
        alignItems: "center",
        gap: 16,
      }}
    >
      <ParticleField count={35} color={COLORS.accent} speed={1} />
      <div style={{ transform: `scale(${interpolate(logoE, [0, 1], [0.2, 1])})`, opacity: interpolate(logoE, [0, 0.5], [0, 1], { extrapolateRight: "clamp" }) }}>
        <LogoReveal size={isV ? 60 : 72} />
      </div>
      <div style={{ width: lineW, height: 2, background: `linear-gradient(90deg, transparent, ${COLORS.accent}, transparent)`, marginTop: 4 }} />
      <span style={{
        fontFamily: roboto, fontSize: isV ? 20 : 24, fontWeight: 700, color: "rgba(255,255,255,0.9)",
        opacity: interpolate(tagE, [0, 0.5], [0, 1], { extrapolateRight: "clamp" }),
        textShadow: "1px 1px 3px rgba(0,0,0,0.5)", textAlign: "center", padding: "0 30px",
        letterSpacing: 2,
      }}>
        AI LOBSTER ADVENTURE
      </span>
      <div style={{ display: "flex", gap: isV ? 16 : 32, marginTop: 12 }}>
        {["Build Skills", "Battle Agents", "Export Knowledge"].map((t, i) => {
          const e = i === 0 ? sub1E : i === 1 ? sub2E : spring({ frame, fps, delay: 38, config: { damping: 200 } });
          return (
            <div key={t} style={{
              opacity: interpolate(e, [0, 1], [0, 1]),
              transform: `translateY(${interpolate(e, [0, 1], [20, 0])}px)`,
              background: "rgba(255,255,255,0.08)", borderRadius: 20, padding: "6px 16px",
              border: `1px solid ${COLORS.accent}33`,
            }}>
              <span style={{ fontFamily: roboto, fontSize: 13, color: COLORS.accent, fontWeight: 700 }}>{t}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ─── Section Divider ────────────────────────────────────────────────
const SectionTitle: React.FC<{ title: string; subtitle: string; accent?: string }> = ({
  title, subtitle, accent = COLORS.accent,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  const e = spring({ frame, fps, config: SPRING_SNAPPY });
  const lineW = interpolate(e, [0, 1], [0, isV ? 250 : 400]);
  const subE = spring({ frame, fps, delay: 10, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{
      background: `linear-gradient(135deg, ${COLORS.bg} 0%, ${COLORS.bgGradient1} 50%, ${COLORS.bg} 100%)`,
      justifyContent: "center", alignItems: "center", gap: 14,
    }}>
      <ParticleField count={15} color={accent} speed={0.8} />
      <div style={{ width: lineW, height: 2, background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
      <span style={{
        fontFamily: lobster, fontSize: isV ? 32 : 38, color: accent,
        textShadow: `2px 2px 0px rgba(0,0,0,0.5), 0 0 15px ${accent}40`,
        opacity: interpolate(e, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }),
        transform: `scale(${interpolate(e, [0, 1], [0.7, 1])})`,
        textAlign: "center", padding: "0 30px",
      }}>
        {title}
      </span>
      <span style={{
        fontFamily: roboto, fontSize: isV ? 16 : 18, color: "rgba(255,255,255,0.7)",
        opacity: interpolate(subE, [0, 1], [0, 1]), textAlign: "center", padding: "0 40px",
      }}>
        {subtitle}
      </span>
      <div style={{ width: lineW, height: 2, background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
    </AbsoluteFill>
  );
};

// ─── Recording Scene (reused) ───────────────────────────────────────
const RecordingScene: React.FC<{
  src: string; startFrom: number; label: string;
  callout?: string; calloutDelay?: number; accentColor?: string;
}> = ({ src, startFrom, label, callout, calloutDelay = 20, accentColor = COLORS.accent }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  const labelE = spring({ frame, fps, delay: 5, config: SPRING_SNAPPY });
  const labelY = interpolate(labelE, [0, 1], [60, 0]);
  const labelOp = interpolate(labelE, [0, 0.4], [0, 1], { extrapolateRight: "clamp" });
  const calloutE = callout ? spring({ frame, fps, delay: calloutDelay, config: SPRING_BOUNCY }) : 0;
  const pulse = 0.7 + Math.sin(frame * 0.15) * 0.3;

  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile(`recordings/${src}`)} startFrom={Math.round(startFrom * 30)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)" }} />
      <div style={{ position: "absolute", top: 16, right: 16, display: "flex", alignItems: "center", gap: 8, background: "rgba(0,0,0,0.65)", borderRadius: 20, padding: "6px 14px", border: "1px solid rgba(255,255,255,0.15)" }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.danger, opacity: pulse, boxShadow: `0 0 6px ${COLORS.danger}` }} />
        <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.9)", letterSpacing: 1 }}>LIVE</span>
      </div>
      <div style={{ position: "absolute", top: 16, left: 16, background: "rgba(0,0,0,0.5)", borderRadius: 16, padding: "5px 14px", border: `1px solid ${COLORS.accent}4D` }}>
        <span style={{ fontFamily: lobster, fontSize: 16, color: COLORS.accent, textShadow: "1px 1px 2px rgba(0,0,0,0.5)" }}>ClawVille</span>
      </div>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "linear-gradient(transparent, rgba(0,0,0,0.85))", padding: isV ? "40px 24px 24px" : "30px 32px 20px", transform: `translateY(${labelY}px)`, opacity: labelOp }}>
        <span style={{ fontFamily: roboto, fontSize: isV ? 20 : 24, fontWeight: 700, color: "#fff", textShadow: "1px 1px 3px rgba(0,0,0,0.5)" }}>{label}</span>
      </div>
      {callout && (
        <div style={{
          position: "absolute", top: isV ? 70 : 60, right: isV ? 16 : 24,
          background: `linear-gradient(135deg, ${accentColor}E6, ${accentColor}CC)`,
          borderRadius: 12, padding: "8px 16px",
          transform: `scale(${interpolate(calloutE as number, [0, 1], [0, 1])})`,
          opacity: interpolate(calloutE as number, [0, 0.3], [0, 1], { extrapolateRight: "clamp" }),
          boxShadow: "0 2px 10px rgba(0,0,0,0.3)", border: "2px solid rgba(255,255,255,0.3)",
        }}>
          <span style={{ fontFamily: roboto, fontSize: 14, fontWeight: 700, color: "#fff" }}>{callout}</span>
        </div>
      )}
    </AbsoluteFill>
  );
};

// ─── Final CTA ──────────────────────────────────────────────────────
const FinalCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;

  const statE = spring({ frame, fps, delay: 15, config: SPRING_SNAPPY });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${COLORS.bgGradient1} 0%, ${COLORS.bgGradient2} 50%, ${COLORS.bg} 100%)`,
        justifyContent: "center",
        alignItems: "center",
        gap: 20,
      }}
    >
      <ParticleField count={30} color={COLORS.accent} speed={0.8} />
      <LogoReveal size={isV ? 52 : 64} />

      {/* Stats row */}
      <div style={{
        display: "flex", gap: isV ? 20 : 40, marginTop: 8,
        opacity: interpolate(statE, [0, 0.5], [0, 1], { extrapolateRight: "clamp" }),
        transform: `translateY(${interpolate(statE, [0, 1], [20, 0])}px)`,
      }}>
        {[
          { n: "15", l: "Buildings" },
          { n: "18", l: "Books" },
          { n: "15", l: "Arena Bots" },
        ].map((s) => (
          <div key={s.l} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ fontFamily: lobster, fontSize: 32, color: COLORS.accent, textShadow: "2px 2px 0px rgba(0,0,0,0.3)" }}>{s.n}</span>
            <span style={{ fontFamily: roboto, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{s.l}</span>
          </div>
        ))}
      </div>

      <CTAButton text="Play Free Now" subtitle="play.clawville.com" delay={25} />
    </AbsoluteFill>
  );
};

// ─── Main Combined Composition (75s) ────────────────────────────────
// Part 1: Skills (4s intro + 2s title + 28s footage = 34s)
// Part 2: Arena (2s title + 28s footage = 30s)
// Outro: 5s + 6s = 75s total
export const ClawVillePromo: React.FC = () => {
  const { fps } = useVideoConfig();
  let t = 0;

  const at = (dur: number) => { const from = t; t += dur; return { from: from * fps, dur: dur * fps }; };

  const intro = at(4);
  const skillTitle = at(2);
  const s1 = at(7);  // connect agent
  const s2 = at(7);  // chat & learn
  const s3 = at(7);  // skills inventory
  const s4 = at(7);  // export skills
  const arenaTitle = at(2);
  const a1 = at(7);  // arena overview
  const a2 = at(8);  // combat closeup
  const a3 = at(7);  // kills & respawns
  const a4 = at(7);  // battle royale
  const a5 = at(4);  // connect settings
  const outro = at(6);

  return (
    <AbsoluteFill>
      {/* Hero intro */}
      <Sequence from={intro.from} durationInFrames={intro.dur}>
        <HeroIntro />
      </Sequence>

      {/* -- PART 1: SKILL CREATION -- */}
      <Sequence from={skillTitle.from} durationInFrames={skillTitle.dur}>
        <SectionTitle title="Skill Creation" subtitle="Your agent learns crypto from 15 unique NPCs" accent={COLORS.accent} />
      </Sequence>

      <Sequence from={s1.from} durationInFrames={s1.dur}>
        <RecordingScene src="game-openclaw-connect.mp4" startFrom={3} label="Connect your AI agent via OpenClaw" callout="Any AI provider" calloutDelay={25} />
      </Sequence>

      <Sequence from={s2.from} durationInFrames={s2.dur}>
        <RecordingScene src="game-building-chat-learn.mp4" startFrom={2} label="NPCs teach your agent crypto knowledge" callout="+1 Knowledge" calloutDelay={35} />
      </Sequence>

      <Sequence from={s3.from} durationInFrames={s3.dur}>
        <RecordingScene src="game-menu-skills-inventory.mp4" startFrom={5} label="Track your agent's growing skill set" callout="Skill Builder" />
      </Sequence>

      <Sequence from={s4.from} durationInFrames={s4.dur}>
        <RecordingScene src="game-openclaw-skills.mp4" startFrom={1} label="Export skills as SKILL.md" callout="Portable" calloutDelay={25} accentColor={COLORS.success} />
      </Sequence>

      {/* -- PART 2: ARENA COMBAT -- */}
      <Sequence from={arenaTitle.from} durationInFrames={arenaTitle.dur}>
        <SectionTitle title="Arena Mode" subtitle="15 autonomous agents. Battle royale. Real-time learning." accent={COLORS.danger} />
      </Sequence>

      <Sequence from={a1.from} durationInFrames={a1.dur}>
        <RecordingScene src="arena-overview-pan.mp4" startFrom={5} label="15 autonomous agents battle in real-time" callout="Battle Royale" calloutDelay={25} accentColor={COLORS.danger} />
      </Sequence>

      <Sequence from={a2.from} durationInFrames={a2.dur}>
        <RecordingScene src="arena-combat-closeup.mp4" startFrom={8} label="Attack, block, dodge -- agents learn strategy" callout="5 Actions" calloutDelay={35} accentColor={COLORS.danger} />
      </Sequence>

      <Sequence from={a3.from} durationInFrames={a3.dur}>
        <RecordingScene src="arena-kills-respawns.mp4" startFrom={5} label="Defeat opponents. Level up. Learn." callout="XP Gained" accentColor={COLORS.danger} />
      </Sequence>

      <Sequence from={a4.from} durationInFrames={a4.dur}>
        <RecordingScene src="arena-battle-royale.mp4" startFrom={20} label="Every battle makes your agent smarter" callout="Knowledge +1" calloutDelay={30} accentColor={COLORS.success} />
      </Sequence>

      <Sequence from={a5.from} durationInFrames={a5.dur}>
        <RecordingScene src="arena-connect-settings.mp4" startFrom={3} label="Connect any AI agent to fight" callout="OpenClaw" accentColor={COLORS.info} />
      </Sequence>

      {/* Final CTA */}
      <Sequence from={outro.from} durationInFrames={outro.dur}>
        <FinalCTA />
      </Sequence>
    </AbsoluteFill>
  );
};
