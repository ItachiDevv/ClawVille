'use client';

import { useEffect } from 'react';

/**
 * Qwerti embeddable buy widget — partner integration, step 1 (2026-06-16).
 *
 * Mounts Qwerti's persistent floating "buy/swap $CLAWVILLE" launcher (bottom-right
 * by default). Clicking it opens Qwerti's non-custodial buy/swap + fiat on-ramp
 * overlay scoped to our partner campaign, so visitors can purchase $CLAWVILLE
 * (card / Apple Pay / Google Pay / crypto) without leaving clawville.world.
 *
 * Scope + perf decisions (ClawVille priority #1 = web performance):
 *  - HOMEPAGE ONLY. The script is injected here and torn down on unmount, NOT
 *    placed in the root layout — so the floating launcher never appears over the
 *    WebGPU `/game` scene (visual clutter + GPU/CPU cost) or any other route.
 *  - LAZY: injected on `requestIdleCallback` so the third-party script never
 *    competes with the 3D hero's first paint.
 *  - `data-auto-open="false"`: never auto-pop the purchase modal on load. The
 *    dashboard-generated snippet ships `data-auto-open="true"` — intentionally
 *    overridden here (auto-popping a buy modal on every visit is hostile UX).
 *
 * Cleanup fully tears the widget down (`Qwerti.destroy()` + removes the injected
 * <script> and the `#qwerti-widget-root` node it appends) so a client-side
 * navigation away (e.g. to /game) leaves nothing behind.
 *
 * Integration ref: https://partner-demo.qwerti.ai/integration-guide?type=widget
 * Campaign id is the partner-scoped value generated in the Qwerti dashboard.
 */

const WIDGET_SRC = 'https://widget.qwerti.ai/widget/v1/buy.js';
const WIDGET_CAMPAIGN = 'clawville-792703809-76951';
const SCRIPT_ID = 'qwerti-buy-widget';
const ROOT_ID = 'qwerti-widget-root';

declare global {
  interface Window {
    Qwerti?: {
      destroy?: () => void;
      openWidget?: () => void;
      closeWidget?: () => void;
    };
  }
}

export function QwertiBuyWidget() {
  useEffect(() => {
    // Never inject twice (React re-mount / strict-mode double-effect).
    if (document.getElementById(SCRIPT_ID)) return;

    let injected = false;
    const inject = () => {
      if (injected || document.getElementById(SCRIPT_ID)) return;
      injected = true;
      const s = document.createElement('script');
      s.id = SCRIPT_ID;
      s.src = WIDGET_SRC;
      s.async = true;
      s.dataset.widget = 'qwerti-widget'; // -> data-widget
      s.dataset.campaign = WIDGET_CAMPAIGN; // -> data-campaign
      s.dataset.autoOpen = 'false'; // -> data-auto-open (override dashboard default)
      document.head.appendChild(s);
    };

    // Defer past the hero's first paint — load only when the browser is idle.
    const ric = window.requestIdleCallback;
    const handle: number = ric
      ? ric(inject, { timeout: 4000 })
      : window.setTimeout(inject, 2000);

    return () => {
      if (ric) {
        window.cancelIdleCallback?.(handle);
      } else {
        window.clearTimeout(handle);
      }
      try {
        window.Qwerti?.destroy?.();
      } catch {
        /* widget may not have finished loading — safe to ignore */
      }
      document.getElementById(SCRIPT_ID)?.remove();
      document.getElementById(ROOT_ID)?.remove();
    };
  }, []);

  return null;
}
