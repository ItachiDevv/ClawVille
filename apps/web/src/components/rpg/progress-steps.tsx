'use client';

import type { CSSProperties, ReactNode } from 'react';

import { getRarity, type RarityId } from './rarity';

/**
 * ProgressSteps — horizontal rune-dot lifecycle tracker.
 *
 * Covers quest lifecycle (accepted → in_progress → submitted → in_review →
 * approved) and bounty attempt lifecycle (claimed → in_progress → submitted
 * → approved), plus any other ordered RPG state machine a future feature
 * wants. Both quest-board-modal and bounty-board-modal used to inline their
 * own near-identical copies of this component; promoting it here keeps the
 * visual language consistent and drops ~140 lines of duplication.
 *
 * Two visual shapes: `circle` (quest default, soft RPG feel) and `diamond`
 * (bounty default, a tighter rune-sigil look). Coloring is driven by a
 * `tier` prop that pulls from the shared `RARITY_TIERS` palette, so
 * downstream modals can match their frame tier by handing the same tier
 * string to both `<RpgModal tier={...}>` and `<ProgressSteps tier={...}>`.
 *
 * Failed state (`failed={true}`) flips the current-step dot red instead
 * of the tier color, with a matching red glow. Completed steps (indices
 * before the current one) show a softer cyan tint regardless of tier so
 * the "path walked so far" is visually distinct from "where you are now".
 *
 * Pure CSS transitions, no framer-motion, no GSAP, cheap on Iris Xe.
 */

export interface ProgressStep {
  /** Stable identifier — typically the workflow state string. */
  id: string;
  /** Human label shown under the dot. Kept short — ~12 chars max. */
  label: string;
}

export type ProgressStepShape = 'circle' | 'diamond';

export interface ProgressStepsProps {
  /** Ordered list of lifecycle steps. First is start, last is terminal. */
  steps: ReadonlyArray<ProgressStep>;
  /** Current step id. Must match one of `steps[].id`. */
  current: string;
  /**
   * Set true when the current step represents a rejection / failure.
   * The current dot flips to red and the "path completed so far" still
   * renders up to but not including the current index.
   */
  failed?: boolean;
  /**
   * Rune shape for the step markers. `circle` is the softer quest-board
   * feel; `diamond` is the rotated-square bounty feel.
   * @default 'circle'
   */
  shape?: ProgressStepShape;
  /**
   * Rarity tier that colours the "current" dot. Completed dots stay cyan
   * regardless of tier for consistency across all features.
   * @default 'rare'
   */
  tier?: RarityId;
  /** Optional className on the outer flex container. */
  className?: string;
  /** Inline style override on the outer container. */
  style?: CSSProperties;
}

const DOT_SIZE = 11;
const LABEL_FONT_SIZE = 8;
const CONNECTOR_MARGIN_INLINE = 4;

const COMPLETED_DOT_BG = 'rgba(56, 189, 248, 0.6)'; // soft cyan
const COMPLETED_DOT_BORDER = 'rgba(56, 189, 248, 0.55)';
const IDLE_DOT_BG = 'rgba(148, 163, 184, 0.18)';
const IDLE_DOT_BORDER = 'rgba(148, 163, 184, 0.28)';

const COMPLETED_CONNECTOR =
  'linear-gradient(90deg, rgba(56, 189, 248, 0.55) 0%, rgba(56, 189, 248, 0.2) 100%)';
const IDLE_CONNECTOR = 'rgba(148, 163, 184, 0.18)';

const FAILED_DOT_BG = '#ef4444';
const FAILED_DOT_BORDER = '#fca5a5';

export function ProgressSteps({
  steps,
  current,
  failed = false,
  shape = 'circle',
  tier = 'rare',
  className,
  style,
}: ProgressStepsProps): ReactNode {
  const currentIndex = steps.findIndex((s) => s.id === current);
  const rarity = getRarity(tier);

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 0,
        margin: '10px 0 6px',
        ...style,
      }}
    >
      {steps.map((step, i) => {
        const isCompleted = i < currentIndex && !failed;
        const isCurrent = i === currentIndex;
        const isLast = i === steps.length - 1;

        const currentColor = failed ? FAILED_DOT_BG : rarity.base;
        const currentBorder = failed ? FAILED_DOT_BORDER : rarity.base;

        const dotBg = isCurrent
          ? currentColor
          : isCompleted
            ? COMPLETED_DOT_BG
            : IDLE_DOT_BG;

        const dotBorder = isCurrent
          ? currentBorder
          : isCompleted
            ? COMPLETED_DOT_BORDER
            : IDLE_DOT_BORDER;

        const dotShadow = isCurrent ? `0 0 8px ${currentColor}aa` : 'none';

        // Diamond shape is a rotated square with a slightly rounded radius
        // so it reads as a rune sigil, not a harsh cube.
        const isDiamond = shape === 'diamond';
        const dotStyle: CSSProperties = isDiamond
          ? {
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderRadius: 2,
              transform: isCurrent ? 'rotate(45deg) scale(1.1)' : 'rotate(45deg)',
              background: dotBg,
              border: `2px solid ${dotBorder}`,
              boxShadow: dotShadow,
              transition: 'all 220ms ease',
            }
          : {
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderRadius: 999,
              background: dotBg,
              border: `2px solid ${dotBorder}`,
              boxShadow: dotShadow,
              transform: isCurrent ? 'scale(1.1)' : 'scale(1)',
              transition: 'all 220ms ease',
            };

        return (
          <div
            key={step.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              flex: isLast ? '0 0 auto' : '1 1 0',
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              }}
            >
              <div aria-hidden style={dotStyle} />
              <span
                style={{
                  fontSize: LABEL_FONT_SIZE,
                  marginTop: 5,
                  whiteSpace: 'nowrap',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  color: isCompleted || isCurrent ? '#cbd5e1' : '#475569',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                {step.label}
              </span>
            </div>
            {!isLast && (
              <div
                aria-hidden
                style={{
                  flex: 1,
                  height: 1,
                  marginTop: 6,
                  marginInline: CONNECTOR_MARGIN_INLINE,
                  background: isCompleted ? COMPLETED_CONNECTOR : IDLE_CONNECTOR,
                  transition: 'background 500ms ease',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
