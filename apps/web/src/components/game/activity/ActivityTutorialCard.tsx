'use client';

/**
 * ActivityTutorialCard — first-time-in-activity Nori intro card (chunk #12).
 *
 * Spec: `.claude/plans/q2-research/frontend-spec.md` §10.1.
 *
 * UX:
 *  - Renders inline inside `<ActivityLobbyModal>` only on an avatar's first
 *    ever entry to that activity.
 *  - Layout: small RuneFrame card with Nori avatar + 1-2 sentences in her
 *    voice + "Got it" button.
 *  - "Don't show again (all activities)" link sets the global skip flag
 *    so power-users only see this once total, not once per activity.
 *
 * Persistence (localStorage):
 *  - `clawville-activity-tutorial-seen-v1` — JSON `string[]` of activity IDs
 *    the player has dismissed.
 *  - `clawville-activity-tutorial-skip-all` — `'1'` once the user opts out
 *    of all future tutorial cards.
 *
 * Both keys are versioned (`-v1` suffix) so we can ship a tutorial-rewrite
 * later without forcing existing players to re-see updated cards. (Bump to
 * `-v2` to force a re-show.)
 *
 * Copy decisions:
 *  - Bumper Shells = "ram opponents off the edge" (accurate to chunk #4 sim).
 *  - Reef Race = "two laps around the reef" (matches the authoritative sim).
 *  - Cove games (blackjack / baccarat / slots / holdem / texas-holdem-mtt) added
 *    P-player-facing — Nori-voiced, kept in sync with town-guide.ts knowledge[]
 *    (CLAUDE.md "Three-Surface Game-Flow Knowledge Sync"). The MTT deck
 *    specifically calls out: buy-in pool, rising blinds, table rebalancing
 *    ("you may be moved"), the action bar + turn clock, and flat CT payout +
 *    placement → leaderboard.
 *  - All stay in Nori's voice (welcoming, concise — see CLAUDE.md Town Guide
 *    rules + town-guide.ts style).
 */

import { useCallback } from 'react';
import { RuneFrame, RpgButton } from '@/components/rpg';

// ─── Storage keys (versioned — bump to force re-show) ──────────────────────
const SEEN_KEY = 'clawville-activity-tutorial-seen-v1';
const SKIP_ALL_KEY = 'clawville-activity-tutorial-skip-all';

// ─── Activity copy (canonical — keep in sync with Nori knowledge[]) ────────

export type ActivityTutorialActivityId =
  | 'bumper-shells'
  | 'reef-race'
  // Cove games — Nori-voiced decks kept in sync with town-guide.ts knowledge[].
  | 'holdem'
  | 'blackjack'
  | 'baccarat'
  | 'slots'
  | 'texas-holdem-mtt';

interface TutorialCopy {
  title: string;
  voice: string;
  controlsHint: string;
}

const COPY: Record<ActivityTutorialActivityId, TutorialCopy> = {
  'bumper-shells': {
    title: "Nori's Quick Tour: Bumper Shells",
    voice:
      "Ram opponents off the edge. Use Current Surges to chase, drop Pufferfish Mines for ambushes, and if you're losing — Whirlpool Slam flips the board.",
    controlsHint: 'WASD move · SPACE boost · Q (or B on mobile) use power-up',
  },
  'reef-race': {
    title: "Nori's Quick Tour: Reef Race",
    voice:
      "Two laps around the reef. Hit the boost pads, use Turbo Bubbles to overtake, and don't let the Tide Wave catch you near the front.",
    controlsHint: 'WASD steer · SPACE boost · Q (or B on mobile) use Turbo',
  },
  // ── Cove: Texas Hold'em (cash table, 6-max vs house bots) ────────────────
  holdem: {
    title: "Nori's Quick Tour: Hold'em",
    voice:
      "It's 6-max No-Limit — your seat plus five house bots. Buy in for 20–500 vCLAW (those become your chips), play preflop to river, and fold, check, call, bet or raise your way to the pot. Walk away anytime and cash out whatever's in front of you.",
    controlsHint: 'Tap an action when the ring lights up · slide to size a bet/raise',
  },
  // ── Cove: Blackjack (vs dealer, 6-deck shoe) ─────────────────────────────
  blackjack: {
    title: "Nori's Quick Tour: Blackjack",
    voice:
      'Beat the dealer without busting past 21. Bet 5–500 vCLAW, then hit, stand, double, split or surrender — blackjack pays 3:2, dealer stands on soft 17. Count the shoe if you can; the deck is provably fair and every hand is replayable.',
    controlsHint: 'Tap Hit / Stand / Double / Split when it’s your turn',
  },
  // ── Cove: Baccarat (Punto Banco, no decisions) ───────────────────────────
  baccarat: {
    title: "Nori's Quick Tour: Baccarat",
    voice:
      'One bet per coup — PLAYER, BANKER or TIE (5–500 vCLAW) — then the dealer plays both hands by the fixed rules. PLAYER pays 1:1, BANKER pays 0.95:1 (the 5% commission), TIE pays 8:1. No decisions to make; just pick a side.',
    controlsHint: 'Pick PLAYER / BANKER / TIE, set your stake, deal',
  },
  // ── Cove: Slots (provably-fair reels) ────────────────────────────────────
  slots: {
    title: "Nori's Quick Tour: Slots",
    voice:
      'Spin the reels for a payline win — wild multipliers stack and three scatters trigger a bonus. Every spin is provably fair: verify any result at /cove/verify. Bet in vCLAW; guests get a demo shoe.',
    controlsHint: 'Set your bet, hit Spin · hold for turbo spins',
  },
  // ── Cove: Texas Hold'em MTT (single-table sit-n-go tournament) ──────────
  // KEEP IN SYNC with town-guide.ts knowledge[] (the MTT entry) — same-diff
  // rule. Covers: buy-in pool, rising blinds, rebalancing ("you may be
  // moved"), the action bar + turn clock, flat-CT payout + placement →
  // leaderboard.
  'texas-holdem-mtt': {
    title: "Nori's Quick Tour: Poker Tournament",
    voice:
      "It's a sit-n-go: pay one vCLAW buy-in into a shared prize pool, get an equal chip stack (chips aren't vCLAW), and play hands as the blinds rise on a timer. With more entrants the engine balances tables — you may be MOVED to a new table mid-tournament, that's normal. Bust and you lock a finishing place; the pool pays down the top spots (50/30/20 by default) in real vCLAW, and your placement scores the free leaderboard.",
    controlsHint:
      'Act before the turn clock empties (it auto-folds/checks) · slide to size a raise',
  },
};

// ─── localStorage helpers (defensive — never throw) ────────────────────────

function loadSeenSet(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function saveSeenSet(seen: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    /* quota exceeded / private mode — silently drop */
  }
}

function isSkipAll(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SKIP_ALL_KEY) === '1';
  } catch {
    return false;
  }
}

function setSkipAll(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SKIP_ALL_KEY, '1');
  } catch {
    /* silent */
  }
}

// ─── Pure predicate (callable from outside the component) ──────────────────

/**
 * Returns true if this activityId has not been dismissed AND the user has not
 * opted out of all tutorials. Safe to call during SSR (always returns false).
 */
export function shouldShowActivityTutorial(
  activityId: ActivityTutorialActivityId | string,
): boolean {
  if (typeof window === 'undefined') return false;
  if (isSkipAll()) return false;
  return !loadSeenSet().has(activityId);
}

/**
 * Mark an activity tutorial as seen (without rendering the card).
 * Used by callers that want to suppress the card via a different code path
 * (e.g. an explicit skip button somewhere else in the lobby).
 */
export function markActivityTutorialSeen(
  activityId: ActivityTutorialActivityId | string,
): void {
  const seen = loadSeenSet();
  seen.add(activityId);
  saveSeenSet(seen);
}

// ─── Public component ──────────────────────────────────────────────────────

export interface ActivityTutorialCardProps {
  activityId: ActivityTutorialActivityId;
  /** Fired after the user dismisses the card (either path). */
  onDismiss?: () => void;
}

export default function ActivityTutorialCard({
  activityId,
  onDismiss,
}: ActivityTutorialCardProps) {
  const copy = COPY[activityId];

  const handleGotIt = useCallback(() => {
    markActivityTutorialSeen(activityId);
    onDismiss?.();
  }, [activityId, onDismiss]);

  const handleSkipAll = useCallback(() => {
    setSkipAll();
    markActivityTutorialSeen(activityId);
    onDismiss?.();
  }, [activityId, onDismiss]);

  if (!copy) return null;

  return (
    <RuneFrame
      tier="rare"
      glow="subtle"
      style={{
        padding: 14,
        marginBottom: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
        }}
      >
        {/* Nori avatar disc */}
        <div
          aria-hidden
          style={{
            flex: '0 0 auto',
            width: 44,
            height: 44,
            borderRadius: '50%',
            background:
              'radial-gradient(circle at 30% 30%, #fde68a 0%, #facc15 55%, #b45309 100%)',
            border: '2px solid rgba(250, 204, 21, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            boxShadow: '0 0 14px rgba(250, 204, 21, 0.35)',
          }}
        >
          🌊
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: '#fde68a',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              marginBottom: 4,
            }}
          >
            {copy.title}
          </div>

          <div
            style={{
              color: 'rgba(254, 243, 199, 0.95)',
              fontSize: 13,
              lineHeight: 1.5,
              marginBottom: 8,
              fontStyle: 'italic',
            }}
          >
            “{copy.voice}”
            <div
              style={{
                color: 'rgba(253, 230, 138, 0.7)',
                fontSize: 10,
                fontStyle: 'normal',
                marginTop: 2,
                letterSpacing: '0.04em',
              }}
            >
              — Nori, Town Guide
            </div>
          </div>

          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 10,
              color: 'rgba(148, 163, 184, 0.85)',
              letterSpacing: '0.06em',
              marginBottom: 10,
            }}
          >
            {copy.controlsHint}
          </div>

          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <RpgButton variant="primary" size="sm" onClick={handleGotIt}>
              Got it
            </RpgButton>
            <button
              type="button"
              onClick={handleSkipAll}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(148, 163, 184, 0.85)',
                fontSize: 11,
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: 0,
                fontFamily: 'inherit',
              }}
              aria-label="Don't show tutorial cards again for any activity"
            >
              Don&apos;t show again (all activities)
            </button>
          </div>
        </div>
      </div>
    </RuneFrame>
  );
}
