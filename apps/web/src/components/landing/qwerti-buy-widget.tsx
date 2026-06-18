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
 * THEMING (verified live on staging 2026-06-16): the widget renders in a shadow
 * root but exposes `--wt-*` CSS custom properties on its host `#qwerti-widget-root`.
 * Custom properties inherit THROUGH the shadow boundary, and our `#id` selector
 * (specificity 1,0,0) beats the widget's own `:host` rule (0,1,0), so the rule in
 * THEME_CSS recolors the launcher, modal border, glow, message box, and the
 * "Buy Token" button to ClawVille cyan — no Qwerti-dashboard change needed.
 *
 * Cleanup fully tears the widget down (`Qwerti.destroy()` + removes the injected
 * <script>, the theme <style>, and the `#qwerti-widget-root` node) so a
 * client-side navigation away (e.g. to /game) leaves nothing behind.
 *
 * Integration ref: https://partner-demo.qwerti.ai/integration-guide?type=widget
 * Campaign id is the partner-scoped value generated in the Qwerti dashboard.
 */

const WIDGET_SRC = 'https://widget.qwerti.ai/widget/v1/buy.js';
const WIDGET_CAMPAIGN = 'clawville-792703809-76951';
const SCRIPT_ID = 'qwerti-buy-widget';
const STYLE_ID = 'qwerti-widget-theme';
const ROOT_ID = 'qwerti-widget-root';

/**
 * Hosted buy page ("magic link") — the fallback when a user hits the branded
 * button before the widget script has finished its lazy idle-load.
 */
export const QWERTI_MAGIC_LINK =
  'https://app.qwerti.ai/buy/Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA/792703809?campaign=clawville-792703809-76951';

/**
 * ClawVille cyan theme — see THEMING note above. Values verified live.
 * NOTE: the widget sets these `--wt-*` vars INLINE on the host element, so every
 * declaration needs `!important` for our external `#id` rule to win over inline.
 */
const THEME_CSS = `#${ROOT_ID}{
  --wt-button-bg: linear-gradient(74deg, #00E5FF 5%, #06B6D4 48%, #0E7490 90%) !important;
  --wt-button-border: #22d3ee !important;
  --wt-button-border-bg: linear-gradient(120deg, #67e8f9 0%, #0e7490 100%) !important;
  --wt-trigger-bg: linear-gradient(126deg, #00E5FF 40%, #0e7490 95%) !important;
  --wt-trigger-border-gradient: linear-gradient(120deg, #67e8f9 0%, #0e7490 100%) !important;
  --wt-glow-color: rgba(0, 229, 255, 0.55) !important;
  --wt-modal-border-gradient: linear-gradient(120deg, #00E5FF 0%, #0e7490 100%) !important;
  --wt-message-bg: linear-gradient(88.7deg, rgba(9, 30, 46, 0.66) 0%, rgba(6, 21, 32, 0.55) 100%) !important;
}`;

declare global {
  interface Window {
    Qwerti?: {
      destroy?: () => void;
      openWidget?: () => void;
      closeWidget?: () => void;
    };
  }
}

/**
 * Open the Qwerti buy flow from the branded "Buy $CLAWVILLE" button.
 *
 * Opens the hosted buy page (magic link) in a new tab. We do NOT call the
 * widget's `Qwerti.openWidget()` API here: it is a no-op in the current Qwerti
 * build (verified live on staging 2026-06-16 — only the floating launcher's own
 * real click opens the in-page panel; synthetic / programmatic opens are
 * isTrusted-gated and silently do nothing). `window.open` from a user gesture is
 * always reliable, so the button is never dead. The in-page (cyan-themed) widget
 * remains available via its floating launcher for users who prefer to stay on-site.
 */
export function openQwertiBuy() {
  if (typeof window === 'undefined') return;
  window.open(QWERTI_MAGIC_LINK, '_blank', 'noopener,noreferrer');
}

export function QwertiBuyWidget() {
  useEffect(() => {
    // Never inject twice (React re-mount / strict-mode double-effect).
    if (document.getElementById(SCRIPT_ID)) return;

    let injected = false;
    const inject = () => {
      if (injected || document.getElementById(SCRIPT_ID)) return;
      injected = true;

      // Theme rule first (static CSS — applies whenever the root appears).
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = THEME_CSS;
        document.head.appendChild(style);
      }

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
      document.getElementById(STYLE_ID)?.remove();
      document.getElementById(ROOT_ID)?.remove();
    };
  }, []);

  return null;
}
