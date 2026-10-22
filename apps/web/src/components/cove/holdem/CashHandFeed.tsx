'use client';

/**
 * Cash table action feed (2026-10-21). A compact, scrolling list of the
 * current (or last finished) hand's public actions, with street separators.
 * Pure DOM: no Three.js, no drei. Desktop: open column at the top right.
 * Mobile (useIsMobile in the parent): a 44 px toggle, collapsed by default.
 */

import { useEffect, useRef, useState } from 'react';
import type { CashFeedLine } from '@/lib/cove/holdem-cash-feed';
import styles from './SeatedHoldemHud.module.css';

/** Render cap: a long hand never grows the DOM without bound. */
const MAX_FEED_LINES = 60;

export function CashHandFeed({
  lines,
  handNumber,
  mobile,
}: {
  lines: readonly CashFeedLine[];
  handNumber: number | null;
  mobile: boolean;
}) {
  const [open, setOpen] = useState(!mobile);
  const listRef = useRef<HTMLOListElement | null>(null);
  const visible = lines.length > MAX_FEED_LINES ? lines.slice(-MAX_FEED_LINES) : lines;
  const lastKey = visible[visible.length - 1]?.key ?? null;

  useEffect(() => {
    setOpen(!mobile);
  }, [mobile]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [handNumber, lastKey, open]);

  if (handNumber == null || lines.length === 0) return null;

  return (
    <section
      className={styles.feed + (mobile ? ' ' + styles.feedMobile : '')}
      aria-label="Hand actions"
      data-testid="cash-action-feed"
    >
      <button
        type="button"
        className={styles.feedToggle}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="cash-action-feed-list"
      >
        <span className={styles.smallCaps}>Hand {handNumber} actions</span>
        <span aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <ol
          id="cash-action-feed-list"
          ref={listRef}
          className={styles.feedList}
          aria-live="polite"
          aria-relevant="additions"
        >
          {visible.map((line) => (
            <li
              key={line.key}
              className={line.kind === 'street'
                ? styles.feedStreet
                : styles.feedLine
                  + (line.isYou ? ' ' + styles.feedLineYou : '')
                  + (line.timeout ? ' ' + styles.feedLineTimeout : '')}
            >
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
