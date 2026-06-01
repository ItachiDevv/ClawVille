'use client';

/**
 * ActivityResultsModal — chunk #9 of Q2 Activity Portals.
 *
 * Diablo-style match-end reveal modal. Replaces the minimal scaffolding
 * card that previously rendered inside `bumper-shells-hud.tsx` when the
 * match phase flipped to `'ended'`.
 *
 * Storyboard (skippable via tap/click/ESC at any phase):
 *
 *   t=0.0s   overlay fades in (opacity 0→0.85, 300ms)
 *   t=0.3s   placement banner slides in from top
 *   t=0.8s   avatar portrait pops (scale 0.9→1.0, overshoot)
 *   t=1.4s   stats section fades in line-by-line (80ms stagger)
 *   t=2.6s   podium section pops
 *   t=3.6s   rewards section rolls in (per-item 120ms stagger, chime per row)
 *   t=4.5s   NEW cosmetic/title callout flash (when applicable)
 *   t=5.2s   CTAs fade in
 *
 * `prefers-reduced-motion` collapses all phases to an instant fade-in,
 * matching the WCAG 2.1 motion guidance.
 *
 * Data flow:
 *   1. Fast first paint from `useActivityStore.event.match_ended.rewardPreview`
 *   2. Authoritative replace from `GET /api/activities/:id/rooms/:roomId/results`
 *      (joined with display names — see `apps/api/src/routes/activities.ts`)
 *
 * Spec reference: `.claude/plans/q2-research/frontend-spec.md` §6.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAvatar } from '@/hooks/use-avatar';
import { useActivityStore } from '@/stores/activity';
import { useQuestStore, triggerQuestCheck } from '@/stores/quest';
import { playActivitySound } from '@/lib/activity-audio';
import { TOTAL_CHECKPOINTS_PER_RACE } from '@clawville/shared';

// ─── API types (mirror of `GET /api/activities/:id/rooms/:roomId/results`) ──

interface AuthoritativeResultRow {
  resultId: string;
  avatarId: string;
  agentId: string | null;
  displayName: string;
  subjectType: 'avatar' | 'agent' | string;
  placement: number;
  score: number | null;
  scoreMs: number | null;
  tokensAwarded: number;
  leaderboardPoints: number;
  isPersonalBest: boolean | null;
  createdAt: string;
}

interface ResultsApiResponse {
  room: {
    id: string;
    activityId: string;
    shortCode: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
  };
  results: AuthoritativeResultRow[];
}

// ─── Reduced motion gate ────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

// ─── Audio helpers (graceful fallback when /sounds/* aren't shipped yet) ────

interface SoundLoader {
  play: (key: 'victory' | 'tick') => void;
}

// Flip to `true` once /public/sounds/quest-complete.wav and quest-tick.wav
// ship. Until then, leaving this `false` skips the preload entirely so the
// browser doesn't log 404s on every match-end reveal.
const QUEST_SOUNDS_AVAILABLE = false;

function useRevealSounds(reduced: boolean): SoundLoader {
  // Audio assets are optional — the modal degrades to silent reveal when the
  // .wav files aren't shipped. The Audio() error handler swallows failures at
  // runtime but the browser still surfaces a 404 to devtools, so we gate the
  // whole preload behind QUEST_SOUNDS_AVAILABLE to keep the console clean.
  const ctxRef = useRef<{ victory: HTMLAudioElement | null; tick: HTMLAudioElement | null }>({
    victory: null,
    tick: null,
  });
  useEffect(() => {
    if (reduced || typeof window === 'undefined' || !QUEST_SOUNDS_AVAILABLE) return;
    try {
      const v = new Audio('/sounds/quest-complete.wav');
      v.preload = 'auto';
      v.volume = 0.4;
      // Mark as "OK to play" only after metadata loads — failed loads stay null
      v.addEventListener(
        'canplaythrough',
        () => {
          ctxRef.current.victory = v;
        },
        { once: true },
      );
      v.addEventListener('error', () => {
        ctxRef.current.victory = null;
      });
      const t = new Audio('/sounds/quest-tick.wav');
      t.preload = 'auto';
      t.volume = 0.3;
      t.addEventListener(
        'canplaythrough',
        () => {
          ctxRef.current.tick = t;
        },
        { once: true },
      );
      t.addEventListener('error', () => {
        ctxRef.current.tick = null;
      });
    } catch {
      /* audio not supported */
    }
    return () => {
      ctxRef.current.victory?.pause();
      ctxRef.current.tick?.pause();
      ctxRef.current = { victory: null, tick: null };
    };
  }, [reduced]);

  return {
    play: (key) => {
      if (reduced) return;
      const a = key === 'victory' ? ctxRef.current.victory : ctxRef.current.tick;
      if (!a) return;
      try {
        const clone = a.cloneNode(true) as HTMLAudioElement;
        clone.volume = a.volume;
        void clone.play().catch(() => {
          /* autoplay denied — silently ignore */
        });
      } catch {
        /* play threw — silently ignore */
      }
    },
  };
}

// ─── Reveal phase machine ───────────────────────────────────────────────────

const PHASE_TIMINGS_MS = {
  banner: 300,
  portrait: 800,
  stats: 1400,
  podium: 2600,
  rewards: 3600,
  callout: 4500,
  ctas: 5200,
  done: 5800,
} as const;

type PhaseKey = keyof typeof PHASE_TIMINGS_MS;

function useRevealPhases(reduced: boolean, skipped: boolean) {
  const [active, setActive] = useState<Record<PhaseKey, boolean>>({
    banner: false,
    portrait: false,
    stats: false,
    podium: false,
    rewards: false,
    callout: false,
    ctas: false,
    done: false,
  });
  useEffect(() => {
    // Reduced motion OR skipped → all phases instantly active.
    if (reduced || skipped) {
      setActive({
        banner: true,
        portrait: true,
        stats: true,
        podium: true,
        rewards: true,
        callout: true,
        ctas: true,
        done: true,
      });
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    (Object.keys(PHASE_TIMINGS_MS) as PhaseKey[]).forEach((phase) => {
      timers.push(
        setTimeout(
          () => setActive((s) => ({ ...s, [phase]: true })),
          PHASE_TIMINGS_MS[phase],
        ),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, [reduced, skipped]);
  return active;
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface ActivityResultsModalProps {
  roomId: string;
  activityId: string;
  onPlayAgain: () => void;
  onBackToLobby: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ActivityResultsModal({
  roomId,
  activityId,
  onPlayAgain,
  onBackToLobby,
}: ActivityResultsModalProps) {
  const reduced = usePrefersReducedMotion();
  const [skipped, setSkipped] = useState(false);
  const phases = useRevealPhases(reduced, skipped);
  const sounds = useRevealSounds(reduced);

  // Avatar info for portrait
  const { data: avatar } = useAvatar();

  // Live store state — fast paint
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);
  const winners = useActivityStore((s) => s.winners);
  const rewardPreview = useActivityStore((s) => s.rewardPreview);
  const matchEndReason = useActivityStore((s) => s.matchEndReason);
  const eliminationsArr = useActivityStore((s) => s.events.eliminations);
  const hitsArr = useActivityStore((s) => s.events.hits);
  const scoresMap = useActivityStore((s) => s.scores);
  // Phase 4 (C-IMPL-1 fix 2026-04-25) — Reef Race match-end summary fields.
  // Each is a primitive store subscription; populated by event.match_ended
  // handler in apps/web/src/stores/activity.ts (line 790-804). null when
  // not present in this match's payload — sections render conditionally.
  const lastMatchPbDelta      = useActivityStore((s) => s.lastMatchPbDelta);
  const lastMatchStreakBest   = useActivityStore((s) => s.lastMatchStreakBest);
  const lastMatchDailyRank    = useActivityStore((s) => s.lastMatchDailyRank);
  const lastMatchPerfectBonus = useActivityStore((s) => s.lastMatchPerfectLapBonus);

  // Authoritative replace
  const [authResults, setAuthResults] = useState<AuthoritativeResultRow[] | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Fetch authoritative results
  useEffect(() => {
    if (!roomId || !activityId) return;
    let cancelled = false;
    (async () => {
      try {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
        const res = await fetch(
          `${apiBase}/api/activities/${activityId}/rooms/${roomId}/results`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          if (!cancelled) setAuthError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as ResultsApiResponse;
        if (!cancelled) setAuthResults(data.results);
      } catch (e) {
        if (!cancelled) setAuthError(e instanceof Error ? e.message : 'fetch failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, activityId]);

  // Derived data — placement, podium, my-row, reward
  const myAuthRow = useMemo<AuthoritativeResultRow | null>(() => {
    if (!authResults || !selfAvatarId) return null;
    return authResults.find((r) => r.avatarId === selfAvatarId) ?? null;
  }, [authResults, selfAvatarId]);

  const placement: number = useMemo(() => {
    if (myAuthRow) return myAuthRow.placement;
    if (rewardPreview?.placement) return rewardPreview.placement;
    if (selfAvatarId) {
      const w = winners.find((x) => x.avatarId === selfAvatarId);
      if (w) return w.placement;
    }
    return 0;
  }, [myAuthRow, rewardPreview, winners, selfAvatarId]);

  // Podium = top 3 (preferring authoritative); winners array fallback
  const podium: Array<{
    avatarId: string;
    placement: number;
    displayName: string;
    score: number | null;
    isSelf: boolean;
  }> = useMemo(() => {
    const rows: Array<{
      avatarId: string;
      placement: number;
      displayName: string;
      score: number | null;
      isSelf: boolean;
    }> = [];
    if (authResults && authResults.length > 0) {
      for (const r of authResults.slice(0, 3)) {
        rows.push({
          avatarId: r.avatarId,
          placement: r.placement,
          displayName: r.displayName,
          score: r.score,
          isSelf: r.avatarId === selfAvatarId,
        });
      }
      return rows;
    }
    // Fallback: combine winners + scores map
    for (const w of winners.slice(0, 3)) {
      const s = scoresMap.get(w.avatarId);
      rows.push({
        avatarId: w.avatarId,
        placement: w.placement,
        displayName: s?.displayName ?? shortAvatarId(w.avatarId),
        score: s?.score ?? null,
        isSelf: w.avatarId === selfAvatarId,
      });
    }
    return rows;
  }, [authResults, winners, scoresMap, selfAvatarId]);

  const remainingRoster: AuthoritativeResultRow[] = useMemo(() => {
    if (!authResults) return [];
    return authResults.slice(3);
  }, [authResults]);

  // Effective reward — authoritative tokens/points override preview
  const effectiveTokens: number = myAuthRow?.tokensAwarded ?? rewardPreview?.tokens ?? 0;
  const effectivePoints: number =
    myAuthRow?.leaderboardPoints ?? rewardPreview?.leaderboardPoints ?? 0;
  const isPersonalBest =
    myAuthRow?.isPersonalBest ?? rewardPreview?.isPersonalBest ?? false;
  const firstPlayBonus = rewardPreview?.firstPlayOfDayBonus ?? false;
  const focusBonus = rewardPreview?.focusBonus ?? false;

  // Player stats — pulled from store events arrays + scores map. The
  // server's `event.match_ended` payload doesn't yet carry per-player
  // knockouts/times-bumped/damage attribution (fast-follow flagged in
  // GameFeatures.md §19.13). We render only what's reliably attributable
  // to the local player + a world-wide eliminations counter for context.
  const myStats = useMemo(() => {
    if (!selfAvatarId) return null;
    return {
      score: scoresMap.get(selfAvatarId)?.score ?? null,
      eliminationsWitnessed: eliminationsArr.length,
    };
  }, [selfAvatarId, eliminationsArr, scoresMap]);

  // ── Quest counter increments (fire ONCE per modal open) ──────────────
  const incrementCounter = useQuestStore((s) => s.incrementCounter);
  const recordDistinct = useQuestStore((s) => s.recordDistinct);
  const firedOnceRef = useRef(false);
  useEffect(() => {
    if (firedOnceRef.current) return;
    firedOnceRef.current = true;
    incrementCounter('activityMatchesPlayed', 1);
    if (placement === 1) incrementCounter('activityMatchesWon', 1);
    // Tier 5 "Reef Veteran" requires distinct activityIds (Bumper Shells
    // AND Reef Race). Track which activity types the player has finished.
    if (activityId) recordDistinct('distinctActivityTypes', activityId);
    triggerQuestCheck();
  }, [incrementCounter, recordDistinct, placement, activityId]);

  // ── Sound triggers wired to phase activation ─────────────────────────
  const playedVictoryRef = useRef(false);
  const playedRewardChimesRef = useRef(0);
  const playedPbRef = useRef(false);
  useEffect(() => {
    if (phases.banner && !playedVictoryRef.current) {
      playedVictoryRef.current = true;
      // Legacy quest-complete one-shot — kept for backwards compat with
      // the previous sound system.
      sounds.play('victory');
      // Chunk #12 — placement-tier-aware fanfare from the activity bus.
      // 1st = victory-fanfare; 2nd = silver; 3rd = bronze; 4+ = defeat.
      if (placement === 1) {
        playActivitySound('victory-fanfare');
      } else if (placement === 2) {
        playActivitySound('placement-silver');
      } else if (placement === 3) {
        playActivitySound('placement-bronze');
      } else if (placement >= 4) {
        playActivitySound('defeat');
      }
    }
  }, [phases.banner, sounds, placement]);
  useEffect(() => {
    if (phases.rewards && isPersonalBest && !playedPbRef.current) {
      playedPbRef.current = true;
      playActivitySound('pb-chime');
    }
  }, [phases.rewards, isPersonalBest]);
  useEffect(() => {
    if (phases.rewards && playedRewardChimesRef.current === 0) {
      // Tick once for tokens, once for leaderboard points (capped at 3 chimes).
      const chimes = [effectiveTokens > 0, effectivePoints > 0, isPersonalBest].filter(
        Boolean,
      ).length;
      let count = 0;
      const id = setInterval(() => {
        if (count >= chimes) {
          clearInterval(id);
          return;
        }
        sounds.play('tick');
        count++;
      }, 120);
      playedRewardChimesRef.current = chimes;
      return () => clearInterval(id);
    }
    return undefined;
  }, [phases.rewards, sounds, effectiveTokens, effectivePoints, isPersonalBest]);

  // ── Skip handler — click/tap/ESC ─────────────────────────────────────
  const handleSkip = () => {
    if (!skipped) setSkipped(true);
  };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!phases.ctas) {
          handleSkip();
        }
        // After CTAs visible, ESC → back to lobby
        else {
          onBackToLobby();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases.ctas, onBackToLobby]);

  // ── Banner config by placement ───────────────────────────────────────
  const bannerCfg = (() => {
    if (placement === 1) {
      return {
        text: '1st PLACE',
        accent: '#facc15',
        glow: '0 0 36px rgba(250, 204, 21, 0.55)',
        ribbon: 'gold',
        prefix: '✨',
        suffix: '✨',
      };
    }
    if (placement === 2) {
      return {
        text: '2nd PLACE',
        accent: '#cbd5e1',
        glow: '0 0 28px rgba(203, 213, 225, 0.4)',
        ribbon: 'silver',
        prefix: '🥈',
        suffix: '',
      };
    }
    if (placement === 3) {
      return {
        text: '3rd PLACE',
        accent: '#f97316',
        glow: '0 0 28px rgba(249, 115, 22, 0.4)',
        ribbon: 'bronze',
        prefix: '🥉',
        suffix: '',
      };
    }
    if (placement >= 4) {
      return {
        text: `You placed ${placement}${ordinalSuffix(placement)}`,
        accent: '#94a3b8',
        glow: 'none',
        ribbon: 'flat',
        prefix: '',
        suffix: '',
      };
    }
    return {
      text: matchEndReason === 'forfeit' ? 'Forfeited' : 'Match Complete',
      accent: '#94a3b8',
      glow: 'none',
      ribbon: 'flat',
      prefix: '',
      suffix: '',
    };
  })();

  // Map modelKey → species emoji so VRM players (Milady) get the correct icon
  // instead of falling back to the lobster. GLB models keep their original emoji.
  const avatarEmoji = (() => {
    const mk = (avatar as { modelKey?: string } | null | undefined)?.modelKey ?? '';
    if (mk.startsWith('milady') || mk.startsWith('vrm')) return '🪷';
    if (mk === 'crayfish') return '🦐';
    if (mk === 'sea_horse' || mk === 'seahorse') return '🐴';
    // Default lobster / unknown GLB keys
    return '🦞';
  })();
  const avatarName = avatar?.name ?? 'Agent';

  // Phase 4 (C-IMPL-1 fix 2026-04-25) — activity-aware labels. The previous
  // hard-coded "BUMPER SHELLS" subtitle + "LAST SHELL STANDING" tagline
  // showed on the Reef Race match-end modal too — visible UX bug. Resolve
  // from the `activityId` prop (passed through from the HUD parent).
  const isReefRace = activityId === 'reef-race';
  const isBumperShells = activityId === 'bumper-shells';
  const activityLabel = isReefRace
    ? 'REEF RACE'
    : isBumperShells
      ? 'BUMPER SHELLS'
      : (activityId || 'ACTIVITY').toUpperCase();
  const activityCompleteTag = isReefRace
    ? 'CHECKERED FLAG'
    : isBumperShells
      ? 'LAST SHELL STANDING'
      : 'MATCH COMPLETE';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Match results"
      onClick={(e) => {
        // Click on the backdrop (not on the inner card) → skip
        if (e.target === e.currentTarget) handleSkip();
      }}
      onTouchStart={(e) => {
        if (e.target === e.currentTarget) handleSkip();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(3, 10, 22, 0.86)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 30,
        pointerEvents: 'auto',
        animation: reduced ? 'none' : 'arm-fadein 300ms ease-out forwards',
        opacity: reduced ? 1 : undefined,
        backdropFilter: 'blur(4px)',
      }}
    >
      <ResultsCss />
      <div
        className="arm-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(420px, 92vw)',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: '20px 22px 24px',
          background:
            'linear-gradient(160deg, rgba(15, 31, 58, 0.96) 0%, rgba(3, 10, 22, 0.98) 100%)',
          border: `1px solid ${bannerCfg.ribbon === 'flat' ? 'rgba(56, 189, 248, 0.45)' : `${bannerCfg.accent}88`}`,
          borderRadius: 12,
          boxShadow: `${bannerCfg.glow !== 'none' ? bannerCfg.glow + ',' : ''} 0 12px 48px rgba(0,0,0,0.6), inset 0 0 32px rgba(56, 189, 248, 0.08)`,
          color: '#e2e8f0',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        {/* Skip hint — top right */}
        <button
          type="button"
          onClick={handleSkip}
          aria-label="Skip reveal animation"
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            background: 'transparent',
            border: 'none',
            color: 'rgba(148, 163, 184, 0.6)',
            fontSize: 9,
            letterSpacing: '0.14em',
            cursor: 'pointer',
            padding: '4px 8px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          {phases.ctas ? 'ESC TO LEAVE' : 'TAP/ESC TO SKIP'}
        </button>

        {/* PHASE 1 — Placement banner */}
        <div
          className={phases.banner ? 'arm-phase-on arm-banner' : 'arm-phase-off'}
          style={{
            textAlign: 'center',
            marginTop: 6,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 24,
              fontWeight: 900,
              letterSpacing: '0.12em',
              color: bannerCfg.accent,
              textShadow: bannerCfg.glow !== 'none' ? `0 0 18px ${bannerCfg.accent}aa` : 'none',
              lineHeight: 1.1,
            }}
          >
            {bannerCfg.prefix && <span style={{ marginRight: 8 }}>{bannerCfg.prefix}</span>}
            {bannerCfg.text}
            {bannerCfg.suffix && <span style={{ marginLeft: 8 }}>{bannerCfg.suffix}</span>}
          </div>
          <div
            style={{
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'rgba(148, 163, 184, 0.7)',
              marginTop: 4,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {matchEndReason === 'forfeit'
              ? 'BY FORFEIT'
              : matchEndReason === 'aborted'
                ? 'ROUND ABORTED'
                : activityCompleteTag}
          </div>
        </div>

        {/* PHASE 2 — Avatar portrait */}
        <div
          className={phases.portrait ? 'arm-phase-on arm-portrait' : 'arm-phase-off'}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            marginBottom: 14,
          }}
        >
          <div
            aria-hidden
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 40,
              background:
                'radial-gradient(circle at 30% 30%, rgba(56, 189, 248, 0.35), rgba(3, 10, 22, 0.9))',
              border: `2px solid ${bannerCfg.accent}`,
              boxShadow: `inset 0 0 18px ${bannerCfg.accent}66, 0 0 24px ${bannerCfg.accent}44`,
            }}
          >
            {avatarEmoji}
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: '#f1f5f9',
              marginTop: 4,
              textShadow: '0 0 8px rgba(56, 189, 248, 0.35)',
            }}
          >
            {avatarName}
          </div>
          <div
            style={{
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'rgba(148, 163, 184, 0.7)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {activityLabel}
          </div>
        </div>

        {/* PHASE 3 — Stats */}
        {myStats && (
          <div
            className={phases.stats ? 'arm-phase-on' : 'arm-phase-off'}
            style={{ marginBottom: 16 }}
          >
            <SectionHeader label="Your Stats" />
            <StatRow
              label="Final Placement"
              value={`#${placement || '—'}`}
              delayIdx={0}
              animate={phases.stats && !reduced && !skipped}
            />
            {myStats.score !== null && (
              <StatRow
                label="Match Score"
                value={String(myStats.score)}
                delayIdx={1}
                animate={phases.stats && !reduced && !skipped}
              />
            )}
            <StatRow
              label="Eliminations Witnessed"
              value={String(myStats.eliminationsWitnessed)}
              delayIdx={2}
              animate={phases.stats && !reduced && !skipped}
            />
          </div>
        )}

        {/* PHASE 4 — Podium */}
        {podium.length > 0 && (
          <div
            className={phases.podium ? 'arm-phase-on arm-podium' : 'arm-phase-off'}
            style={{ marginBottom: 16 }}
          >
            <SectionHeader label="Podium" />
            {podium.map((row) => (
              <PodiumRow key={row.avatarId} row={row} />
            ))}
            {remainingRoster.length > 0 && (
              <details
                style={{
                  marginTop: 6,
                  fontSize: 10,
                  color: 'rgba(148, 163, 184, 0.7)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  letterSpacing: '0.06em',
                }}
              >
                <summary
                  style={{
                    cursor: 'pointer',
                    padding: '4px 12px',
                    listStyle: 'none',
                  }}
                >
                  +{remainingRoster.length} more{' '}
                  <span style={{ opacity: 0.7 }}>(tap to expand)</span>
                </summary>
                <div style={{ paddingTop: 4 }}>
                  {remainingRoster.map((r) => (
                    <div
                      key={r.avatarId}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '2px 12px',
                        opacity: r.avatarId === selfAvatarId ? 1 : 0.7,
                        color: r.avatarId === selfAvatarId ? '#86efac' : undefined,
                      }}
                    >
                      <span>
                        #{r.placement} {r.displayName}
                      </span>
                      {r.score !== null && <span>{r.score} pts</span>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* PHASE 5 — Rewards */}
        <div
          className={phases.rewards ? 'arm-phase-on' : 'arm-phase-off'}
          style={{ marginBottom: 14 }}
        >
          <SectionHeader label="Rewards" />
          <RewardRow
            icon="🪙"
            label="ClawTokens"
            value={`+${effectiveTokens}`}
            tone="gold"
            delayIdx={0}
            animate={phases.rewards && !reduced && !skipped}
          />
          <RewardRow
            icon="📈"
            label="Leaderboard Score"
            value={`+${effectivePoints}`}
            tone="cyan"
            delayIdx={1}
            animate={phases.rewards && !reduced && !skipped}
          />
          {firstPlayBonus && (
            <RewardRow
              icon="🌅"
              label="First Play of Day Bonus"
              value="+15"
              tone="green"
              delayIdx={2}
              animate={phases.rewards && !reduced && !skipped}
            />
          )}
          {focusBonus && (
            <RewardRow
              icon="🎯"
              label="Focus Bonus"
              value="+25%"
              tone="green"
              delayIdx={3}
              animate={phases.rewards && !reduced && !skipped}
            />
          )}
          {/* Phase 4 (C-IMPL-1) — perfect-lap bonus row. Only renders for
              Reef Race matches with a non-zero bonus credited (streak ≥ 36
              cleared the entire race). The +25 is server-authoritative. */}
          {isReefRace && lastMatchPerfectBonus !== null && lastMatchPerfectBonus > 0 && (
            <RewardRow
              icon="✨"
              label="Perfect Race Bonus"
              value={`+${lastMatchPerfectBonus}`}
              tone="green"
              delayIdx={4}
              animate={phases.rewards && !reduced && !skipped}
            />
          )}
          {authError && !authResults && (
            <div
              style={{
                fontSize: 10,
                color: 'rgba(252, 165, 165, 0.7)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                padding: '4px 12px',
              }}
            >
              Live preview shown — full results unavailable ({authError})
            </div>
          )}
        </div>

        {/* PHASE 6 — NEW callout sections.
            Reef Race (C-IMPL-1 fix 2026-04-25): three independent
            achievement blocks — PB delta, perfect-line streak, daily rank.
            Each renders ONLY if its corresponding store field is populated
            (server-driven — fields are written by the per-recipient
            event.match_ended handler in stores/activity.ts).
            Bumper Shells / other activities: the legacy
            "⭐ NEW PERSONAL BEST ⭐" callout still fires from
            `isPersonalBest` (server-flagged via the score path). */}
        {isReefRace ? (
          <>
            {/* PB delta block — "🏆 NEW PERSONAL BEST: 12.34s (was 12.89s)" */}
            {lastMatchPbDelta && (
              <div
                className={phases.callout ? 'arm-phase-on arm-callout' : 'arm-phase-off'}
                style={{
                  textAlign: 'center',
                  marginBottom: 10,
                  padding: '10px 16px',
                  border: '1px solid rgba(250, 204, 21, 0.6)',
                  borderRadius: 6,
                  background: 'rgba(250, 204, 21, 0.1)',
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  color: '#facc15',
                  textShadow: '0 0 12px rgba(250, 204, 21, 0.55)',
                }}
              >
                <span aria-hidden style={{ marginRight: 6 }}>🏆</span>
                NEW PERSONAL BEST:{' '}
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatLapMs(lastMatchPbDelta.newMs)}
                </span>
                {lastMatchPbDelta.oldMs !== null && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'rgba(250, 204, 21, 0.7)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    (was{' '}
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatLapMs(lastMatchPbDelta.oldMs)}
                    </span>
                    , −
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatLapDeltaMs(
                        lastMatchPbDelta.oldMs - lastMatchPbDelta.newMs,
                      )}
                    </span>
                    )
                  </span>
                )}
              </div>
            )}
            {/* Streak best block — "🌟 PERFECT LAP × 36" or "⚡ PERFECT
                LINE STREAK: N checkpoints" depending on whether the player
                cleared every checkpoint in the match (streak ≥ 36). */}
            {lastMatchStreakBest !== null && lastMatchStreakBest > 0 && (
              <div
                className={phases.callout ? 'arm-phase-on arm-callout' : 'arm-phase-off'}
                style={{
                  textAlign: 'center',
                  marginBottom: 10,
                  padding: '8px 14px',
                  border: `1px solid ${
                    lastMatchStreakBest >= TOTAL_CHECKPOINTS_PER_RACE
                      ? 'rgba(103, 232, 249, 0.6)'
                      : 'rgba(251, 146, 60, 0.55)'
                  }`,
                  borderRadius: 6,
                  background:
                    lastMatchStreakBest >= TOTAL_CHECKPOINTS_PER_RACE
                      ? 'rgba(103, 232, 249, 0.08)'
                      : 'rgba(251, 146, 60, 0.08)',
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  color:
                    lastMatchStreakBest >= TOTAL_CHECKPOINTS_PER_RACE
                      ? '#67e8f9'
                      : '#fb923c',
                  textShadow:
                    lastMatchStreakBest >= TOTAL_CHECKPOINTS_PER_RACE
                      ? '0 0 12px rgba(103, 232, 249, 0.55)'
                      : '0 0 12px rgba(251, 146, 60, 0.45)',
                }}
              >
                {lastMatchStreakBest >= TOTAL_CHECKPOINTS_PER_RACE ? (
                  <>
                    <span aria-hidden style={{ marginRight: 6 }}>🌟</span>
                    PERFECT LAP × {lastMatchStreakBest}
                  </>
                ) : (
                  <>
                    <span aria-hidden style={{ marginRight: 6 }}>⚡</span>
                    PERFECT LINE STREAK: {lastMatchStreakBest} CHECKPOINTS
                  </>
                )}
              </div>
            )}
            {/* Daily rank block — "🦞 #N LOBSTER OF THE DAY". Server returns
                rank only when the just-set PB cracks the top 100 of the
                last-24h leaderboard (C2 fix — direct indexed scan, NOT the
                public 60s leaderboard cache). */}
            {lastMatchDailyRank !== null && lastMatchDailyRank > 0 && (
              <div
                className={phases.callout ? 'arm-phase-on arm-callout' : 'arm-phase-off'}
                style={{
                  textAlign: 'center',
                  marginBottom: 14,
                  padding: '8px 14px',
                  border: '1px solid rgba(56, 189, 248, 0.55)',
                  borderRadius: 6,
                  background: 'rgba(56, 189, 248, 0.08)',
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  color: '#7dd3fc',
                  textShadow: '0 0 12px rgba(56, 189, 248, 0.45)',
                }}
              >
                <span aria-hidden style={{ marginRight: 6 }}>🦞</span>
                {lastMatchDailyRank === 1
                  ? '#1 LOBSTER OF THE DAY'
                  : `#${lastMatchDailyRank} LOBSTER OF THE DAY`}
              </div>
            )}
          </>
        ) : (
          isPersonalBest && (
            <div
              className={phases.callout ? 'arm-phase-on arm-callout' : 'arm-phase-off'}
              style={{
                textAlign: 'center',
                marginBottom: 14,
                padding: '8px 16px',
                border: '1px solid rgba(250, 204, 21, 0.6)',
                borderRadius: 6,
                background: 'rgba(250, 204, 21, 0.1)',
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: '0.1em',
                color: '#facc15',
                textShadow: '0 0 12px rgba(250, 204, 21, 0.55)',
              }}
            >
              ⭐ NEW PERSONAL BEST ⭐
            </div>
          )
        )}

        {/* PHASE 7 — CTAs */}
        <div
          className={phases.ctas ? 'arm-phase-on' : 'arm-phase-off'}
          style={{
            display: 'flex',
            gap: 10,
            justifyContent: 'center',
            marginTop: 8,
          }}
        >
          <button
            type="button"
            onClick={onPlayAgain}
            aria-label={`Play another ${isReefRace ? 'Reef Race' : isBumperShells ? 'Bumper Shells' : 'match'}`}
            style={{
              padding: '11px 22px',
              background: 'linear-gradient(180deg, #facc15 0%, #ca8a04 100%)',
              border: 'none',
              borderRadius: 8,
              color: '#0a1628',
              fontFamily: 'inherit',
              fontWeight: 800,
              letterSpacing: '0.1em',
              fontSize: 12,
              cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(250, 204, 21, 0.45)',
              transition: 'transform 120ms ease, filter 120ms ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(1.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.filter = 'brightness(1)')}
          >
            ▶ PLAY AGAIN
          </button>
          <button
            type="button"
            onClick={onBackToLobby}
            aria-label="Return to ClawVille lobby"
            style={{
              padding: '11px 22px',
              background: 'linear-gradient(180deg, rgba(56, 189, 248, 0.18) 0%, rgba(3, 10, 22, 0.95) 100%)',
              border: '1px solid rgba(56, 189, 248, 0.55)',
              borderRadius: 8,
              color: '#e0f2fe',
              fontFamily: 'inherit',
              fontWeight: 700,
              letterSpacing: '0.1em',
              fontSize: 12,
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(56, 189, 248, 0.18)',
              transition: 'transform 120ms ease, filter 120ms ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(1.1)')}
            onMouseLeave={(e) => (e.currentTarget.style.filter = 'brightness(1)')}
          >
            ← BACK TO LOBBY
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 6,
        padding: '0 4px',
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'rgba(56, 189, 248, 0.65)',
        }}
      >
        {label}
      </span>
      <span
        aria-hidden
        style={{
          flex: 1,
          height: 1,
          background:
            'linear-gradient(90deg, rgba(56, 189, 248, 0.35) 0%, transparent 100%)',
        }}
      />
    </div>
  );
}

function StatRow({
  label,
  value,
  delayIdx,
  animate,
}: {
  label: string;
  value: string;
  delayIdx: number;
  animate: boolean;
}) {
  return (
    <div
      className={animate ? 'arm-row-in' : ''}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '4px 12px',
        fontSize: 12,
        color: '#cbd5e1',
        animationDelay: animate ? `${delayIdx * 80}ms` : undefined,
        opacity: animate ? 0 : 1,
        animationFillMode: 'forwards',
      }}
    >
      <span>{label}</span>
      <span
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontWeight: 700,
          color: '#f1f5f9',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PodiumRow({
  row,
}: {
  row: {
    avatarId: string;
    placement: number;
    displayName: string;
    score: number | null;
    isSelf: boolean;
  };
}) {
  const medal = row.placement === 1 ? '🥇' : row.placement === 2 ? '🥈' : '🥉';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '4px 12px',
        fontSize: 13,
        fontWeight: row.isSelf ? 700 : 500,
        color: row.isSelf ? '#86efac' : '#e2e8f0',
        background: row.isSelf ? 'rgba(34, 197, 94, 0.08)' : 'transparent',
        borderRadius: 4,
      }}
    >
      <span>
        <span style={{ marginRight: 8 }}>{medal}</span>
        {row.displayName}
        {row.isSelf && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 9,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: '#86efac',
              letterSpacing: '0.1em',
            }}
          >
            (YOU)
          </span>
        )}
      </span>
      {row.score !== null && (
        <span
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
            color: 'rgba(226, 232, 240, 0.85)',
          }}
        >
          {row.score} pts
        </span>
      )}
    </div>
  );
}

function RewardRow({
  icon,
  label,
  value,
  tone,
  delayIdx,
  animate,
}: {
  icon: string;
  label: string;
  value: string;
  tone: 'gold' | 'cyan' | 'green';
  delayIdx: number;
  animate: boolean;
}) {
  const accent =
    tone === 'gold' ? '#facc15' : tone === 'cyan' ? '#38bdf8' : '#86efac';
  return (
    <div
      className={animate ? 'arm-row-in' : ''}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 12px',
        margin: '3px 0',
        fontSize: 12,
        color: '#cbd5e1',
        background: `linear-gradient(90deg, ${accent}1a 0%, transparent 100%)`,
        borderLeft: `2px solid ${accent}`,
        borderRadius: '0 4px 4px 0',
        animationDelay: animate ? `${delayIdx * 120}ms` : undefined,
        opacity: animate ? 0 : 1,
        animationFillMode: 'forwards',
      }}
    >
      <span>
        <span style={{ marginRight: 8 }} aria-hidden>
          {icon}
        </span>
        {label}
      </span>
      <span
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontWeight: 800,
          color: accent,
          textShadow: `0 0 8px ${accent}66`,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortAvatarId(avatarId: string): string {
  return avatarId.length > 8 ? `…${avatarId.slice(-6)}` : avatarId;
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/**
 * Format a lap time in milliseconds to "S.SS s" or "M:SS.SS" — Reef Race
 * PB delta block (Phase 4 C-IMPL-1 fix). Sub-60s laps stay short
 * ("12.34s") to keep the headline readable; >60s falls back to mm:ss.SS
 * for the (admittedly unusual) case that a lap exceeded a minute.
 */
function formatLapMs(ms: number): string {
  if (ms <= 0) return '0.00s';
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `${min}:${sec.toFixed(2).padStart(5, '0')}`;
}

/**
 * Format a positive lap delta (oldMs - newMs) for the "(was X, −Y)"
 * suffix on the PB delta block. Always positive — caller has already
 * verified the new time is faster than the old.
 */
function formatLapDeltaMs(deltaMs: number): string {
  if (deltaMs <= 0) return '0.00s';
  if (deltaMs < 1000) {
    return `${(deltaMs / 1000).toFixed(2)}s`;
  }
  return `${(deltaMs / 1000).toFixed(2)}s`;
}

// ─── Inline scoped CSS ──────────────────────────────────────────────────────

function ResultsCss() {
  // Single mount per modal — keys are scoped under arm-* so we don't collide.
  return (
    <style>{`
      @keyframes arm-fadein {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes arm-banner-in {
        0%   { transform: translateY(-24px); opacity: 0; }
        60%  { transform: translateY(4px); opacity: 1; }
        100% { transform: translateY(0); opacity: 1; }
      }
      @keyframes arm-portrait-in {
        0%   { transform: scale(0.85); opacity: 0; }
        60%  { transform: scale(1.06); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes arm-row-in {
        from { transform: translateY(8px); opacity: 0; }
        to   { transform: translateY(0); opacity: 1; }
      }
      @keyframes arm-podium-in {
        from { transform: scale(0.96); opacity: 0; }
        to   { transform: scale(1); opacity: 1; }
      }
      @keyframes arm-callout-pulse {
        0%   { transform: scale(0.95); }
        40%  { transform: scale(1.06); }
        100% { transform: scale(1); }
      }

      .arm-phase-off { opacity: 0; pointer-events: none; }
      .arm-phase-on  { opacity: 1; pointer-events: auto; transition: opacity 200ms ease-out; }

      .arm-banner    { animation: arm-banner-in 480ms cubic-bezier(0.2, 0.9, 0.3, 1.4); }
      .arm-portrait  { animation: arm-portrait-in 420ms cubic-bezier(0.2, 0.9, 0.3, 1.6); }
      .arm-podium    { animation: arm-podium-in 320ms ease-out; }
      .arm-callout   { animation: arm-callout-pulse 540ms ease-out; }
      .arm-row-in    { animation: arm-row-in 320ms ease-out; }

      @media (prefers-reduced-motion: reduce) {
        .arm-banner, .arm-portrait, .arm-podium, .arm-callout, .arm-row-in {
          animation: none !important;
        }
        .arm-phase-on, .arm-phase-off {
          opacity: 1 !important;
          transition: none !important;
        }
      }
    `}</style>
  );
}
