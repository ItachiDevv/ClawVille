'use client';

/**
 * yard-editor-primer.tsx — the one-time "how decorating works" card.
 *
 * WHY IT EXISTS
 * -------------
 * The yard editor ships four modes, an auto-stacking ghost, and a silent exit
 * rule, none of which is discoverable from the panel alone. The founder's
 * verdict on the shipped land economy was that a player would give up inside
 * ten seconds. This card is the ten seconds of reading that stops that.
 *
 * It covers exactly the things a player cannot infer from the UI:
 *   • the four verbs (place / move / rotate / remove),
 *   • that stacking exists at all, and what it can stack on,
 *   • that WALKING AWAY closes the editor. That is real, silent behaviour:
 *     `lib/three/yard-editor-three.tsx` exits build mode from a per-frame check
 *     the moment the avatar passes 1.2x the parcel radius. It is the FIRST row
 *     of the card, in gold, because the body scrolls and it is the only rule
 *     here whose surprise costs the player their place. See the ORDER note on
 *     `rows` below.
 *
 * SHAPE — modelled on `first-time-backup-modal.tsx`: a self-contained fixed
 * card that reads storage on mount, is dismissed by an explicit button, and
 * writes the key on dismiss.
 *
 * DELIBERATELY NOT A MODAL. There is no full-screen backdrop and nothing
 * outside the card takes pointer events, so the editor's Done button and its
 * mode buttons stay reachable the whole time the card is up. On desktop the
 * card sits in the left column, clear of the editor drawer on the right; on
 * touch it sits above the bottom sheet.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { LandStructureType } from '@clawville/shared';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  clampKitStructureLevel,
  stackingHintLines,
  yardPieceCostLine,
} from '@/lib/land-yard-editor';
import { useLandStore } from '@/stores/land';

/**
 * Namespaced so it can never collide with `clawville-tutorial-seen`
 * (components/game/tutorial-overlay.tsx), which gates a different deck.
 */
export const YARD_PRIMER_STORAGE_KEY = 'clawville-yard-primer-seen';

const TEXT = '#f0f9ff';
const MUTED = '#bae6fd';
const GOLD = '#fde68a';

interface PrimerRow {
  readonly label: string;
  readonly body: string;
  /**
   * Renders in the card's gold, not the muted body colour. Exactly ONE row
   * carries it: the silent-exit rule (see the ORDER note below).
   */
  readonly accent?: boolean;
}

export default function YardEditorPrimer() {
  const isMobile = useIsMobile();
  const buildMode = useLandStore((state) => state.buildMode);
  const structure = useLandStore((state) =>
    buildMode ? (state.structures.get(buildMode.parcelCode) ?? null) : null,
  );
  // null = storage not read yet, so nothing flashes during hydration.
  const [seen, setSeen] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setSeen(localStorage.getItem(YARD_PRIMER_STORAGE_KEY) !== null);
    } catch {
      // Storage blocked (private mode) — treat as unseen and let the dismiss
      // hold for this session only.
      setSeen(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(YARD_PRIMER_STORAGE_KEY, 'true');
    } catch {
      /* storage blocked — the state flip below still hides it */
    }
    setSeen(true);
  }, []);

  if (!buildMode || seen !== false) return null;

  // Same clamp the editor drawer uses, and reachable for the same reason: the
  // editor only opens on a parcel with an ACTIVE structure, so a null here is
  // the brief window before the owner overlay hydrates. Both the clamp bounds
  // and the price below come from the shared constants, never a typed number.
  const level = clampKitStructureLevel(structure?.level);
  const structureType: LandStructureType = structure?.structureType ?? 'home';

  const tapVerb = isMobile ? 'Tap' : 'Click';
  // ORDER IS LOAD-BEARING (2026-08-10). "Leaving" is FIRST, not last.
  //
  // The body below scrolls, and on a landscape phone the card has about 124px
  // to live in (see the band maths in `shell`), of which roughly 76px is
  // scrollable content. A first-timer reads about the first third only. The
  // silent-exit rule is the ONE rule here that causes a surprising loss of
  // context (the editor closes with no prompt when you walk off), so it cannot
  // be the row that gets scrolled past. First position puts it in grid row 1 in
  // every layout this card has: single column in portrait, the leftmost cell of
  // the first row in landscape (`auto-fit` gives three columns at 844px wide),
  // and the top line on desktop. The gold accent marks it as the one to read.
  const rows: readonly PrimerRow[] = [
    {
      label: 'Leaving',
      body: 'Walk off your lot and the editor closes by itself. Press Done to close it where you stand.',
      accent: true,
    },
    {
      label: 'Place',
      body: `Pick a piece from the list, then ${tapVerb.toLowerCase()} a square in your yard.`,
    },
    {
      label: 'Cost',
      body: yardPieceCostLine(structureType),
    },
    {
      label: 'Move',
      body: `Switch to Move, ${tapVerb.toLowerCase()} one of your pieces, then ${tapVerb.toLowerCase()} its new square. Moving is free.`,
    },
    {
      label: 'Rotate',
      body: isMobile
        ? 'Use the Rotate button before you place a piece.'
        : 'Press R, or use the Rotate button, before you place a piece.',
    },
    {
      label: 'Remove',
      body: `Switch to Remove and ${tapVerb.toLowerCase()} a piece. There is no refund.`,
    },
    ...stackingHintLines(level).map((line, index) => ({
      label: index === 0 ? 'Stacking' : '',
      body: line,
    })),
  ];

  const shell: CSSProperties = {
    position: 'fixed',
    zIndex: 80,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 16,
    border: '1.5px solid rgba(251,191,36,0.44)',
    background:
      'linear-gradient(158deg, rgba(7,24,44,0.98), rgba(12,34,58,0.98))',
    boxShadow: '0 26px 72px rgba(2,8,23,0.62), 0 0 30px rgba(251,191,36,0.14)',
    color: TEXT,
    backdropFilter: 'blur(14px)',
    ...(isMobile
      ? {
          // ANCHORED BETWEEN the safe top and the editor sheet, not sized from
          // a bare fraction of the viewport.
          //
          // The sheet (`yard-editor-overlay.tsx`) is bottom-anchored at
          // `maxHeight: min(62dvh, 620px)`, so its TOP edge is
          // `100dvh - min(62dvh, 620px)`. The old `min(38dvh - 16px, 360px)`
          // measured the free band from the top of the VIEWPORT, not from the
          // top of this card, so every pixel of `env(safe-area-inset-top)` was
          // double counted: on a 844dvh device with a real 47px top inset the
          // card started at y=59 and ran to y=364 while the sheet started at
          // y=321, a 43px full-width overlap that hid one surface's header
          // controls behind the other's. Devtools cannot catch it because it
          // resolves `env(safe-area-inset-*)` to 0.
          //
          // So the band is now sheetTop - cardTop - gap, expressed exactly:
          //   (100dvh - min(62dvh, 620px)) - (safe-area-inset-top + 12) - 12
          // `max(0px, ...)` keeps it well-defined on an absurdly short screen
          // (the card hides rather than covering the sheet).
          top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
          left: 12,
          right: 12,
          maxHeight:
            'min(max(0px, calc(100dvh - min(62dvh, 620px) - env(safe-area-inset-top, 0px) - 24px)), 360px)',
        }
      : {
          // The editor drawer is `right: 20, width: 348`. Anchoring BOTH edges
          // (rather than a `width` calc with a `minWidth` floor) is what keeps
          // the card off the drawer at every width: the old floor won below
          // about 612px of viewport width and the card slid under the drawer,
          // which `useIsMobile()` cannot catch because it is touch-based, not
          // width-based. 20 + 348 + 24 of gap = 392.
          top: 96,
          left: 24,
          right: 392,
          width: 'auto',
          maxHeight: 'min(60vh, 540px)',
        }),
  };

  return (
    <aside aria-label="How decorating works" style={shell}>
      {/* The eyebrow line is desktop-only: on a phone in landscape the whole
          card has about 124px to live in, and every row of chrome comes out of
          the scrollable body. */}
      <div
        style={{
          padding: isMobile ? '6px 12px 5px' : '14px 16px 10px',
          borderBottom: '1px solid rgba(251,191,36,0.22)',
          background: 'rgba(3,15,29,0.42)',
        }}
      >
        {/* On touch the dismiss button rides in the HEADER instead of its own
            footer. A full-width footer costs ~55px of a 132px card on a
            landscape phone, which is most of the reading area; inline it shares
            the header's line and gives that height back to the content. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <span style={{ minWidth: 0 }}>
            {!isMobile && (
              <span
                style={{
                  display: 'block',
                  color: GOLD,
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                }}
              >
                First time here
              </span>
            )}
            <span
              style={{
                display: 'block',
                marginTop: isMobile ? 0 : 2,
                color: TEXT,
                fontSize: isMobile ? 13 : 16,
                fontWeight: 950,
                lineHeight: 1.2,
              }}
            >
              How decorating works
            </span>
          </span>
          {isMobile && <DismissButton onClick={dismiss} inline />}
        </div>
      </div>

      {/* On touch the card lives in the band above the editor sheet, which on a
          landscape phone is only about 124px tall. A single column there showed
          ONE line of six rows, so the primer taught nothing. `auto-fit` uses the
          width landscape actually has (three columns at 844px wide) and falls
          back to one column in portrait, with no width media query involved. */}
      <div
        style={{
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          padding: isMobile ? '6px 12px 8px' : '10px 16px 12px',
          display: 'grid',
          gridTemplateColumns: isMobile
            ? 'repeat(auto-fit, minmax(220px, 1fr))'
            : undefined,
          alignContent: 'start',
          columnGap: 12,
          rowGap: isMobile ? 5 : 8,
        }}
      >
        {rows.map((row) => (
          <p
            key={`${row.label}:${row.body}`}
            style={{
              margin: 0,
              paddingLeft: 8,
              borderLeft: row.accent
                ? '2px solid rgba(251,191,36,0.95)'
                : row.label
                  ? '2px solid rgba(251,191,36,0.42)'
                  : '2px solid rgba(251,191,36,0.14)',
              color: row.accent ? GOLD : MUTED,
              fontSize: 12,
              lineHeight: isMobile ? 1.3 : 1.45,
            }}
          >
            {row.label ? (
              <span style={{ color: TEXT, fontWeight: 900 }}>{row.label}. </span>
            ) : null}
            {row.body}
          </p>
        ))}
      </div>

      {!isMobile && (
        <div
          style={{
            padding: '10px 16px 14px',
            borderTop: '1px solid rgba(251,191,36,0.18)',
            background: 'rgba(3,15,29,0.34)',
          }}
        >
          <DismissButton onClick={dismiss} />
        </div>
      )}
    </aside>
  );
}

/** 44px tap target either way; `inline` is the compact header placement. */
function DismissButton({ onClick, inline = false }: { onClick: () => void; inline?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flexShrink: 0,
        width: inline ? undefined : '100%',
        minHeight: 44,
        padding: inline ? '0 14px' : undefined,
        borderRadius: 10,
        border: '1px solid rgba(251,191,36,0.62)',
        background: 'rgba(180,83,9,0.72)',
        color: '#fff7ed',
        fontSize: 13,
        fontWeight: 900,
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        touchAction: 'manipulation',
      }}
    >
      {inline ? 'Got it' : 'Got it, let me build'}
    </button>
  );
}
