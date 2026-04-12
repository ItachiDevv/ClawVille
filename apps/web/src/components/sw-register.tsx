'use client';

import { useEffect } from 'react';

/**
 * Registers the ClawVille service worker (`/sw.js`).
 * Mounts in layout.tsx — fires once after hydration.
 *
 * When the browser detects a new SW waiting to activate (i.e. after a deploy),
 * it calls skipWaiting automatically because the SW itself calls self.skipWaiting()
 * in its install handler. The page will use the new SW on next navigation.
 */
export function SWRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', {
          // Scope to entire origin — needs to cover /game and /models/**
          scope: '/',
        });

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (
              newWorker.state === 'activated' &&
              navigator.serviceWorker.controller
            ) {
              // A new SW just took over. Silent update — no reload prompt needed
              // because the SW uses stale-while-revalidate for JS chunks, so the
              // user won't be broken; they'll pick up new chunks on next nav.
              console.debug('[SW] Updated to new version');
            }
          });
        });
      } catch (err) {
        // Non-fatal — site works fine without the SW
        console.debug('[SW] Registration failed:', err);
      }
    };

    // Defer registration until after the page is interactive to avoid
    // competing with initial resource fetches.
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);

  return null;
}
