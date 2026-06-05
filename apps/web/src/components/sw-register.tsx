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

    // LOCAL DEV/TESTING: do NOT run the service worker. Its stale-while-revalidate
    // strategy for JS chunks serves stale/mixed bundles across rapid rebuilds,
    // producing broken/off-centre/overflowing layouts that don't match the current
    // build (the #1 source of "it looks broken" reports during local iteration).
    // Unregister any existing SW + drop its caches so localhost is ALWAYS fresh.
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if ('caches' in window) {
        caches
          .keys()
          .then((keys) => keys.forEach((k) => { if (k.startsWith('clawville-')) caches.delete(k); }))
          .catch(() => {});
      }
      return;
    }

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', {
          // Scope to entire origin — needs to cover /game and /models/**
          scope: '/',
          // Bypass HTTP cache when fetching the sw.js bytes themselves.
          // Default `'imports'` means Chrome HTTP-caches sw.js for the
          // server-set max-age, so a sw.js redeploy can take up to 24 h
          // (Chrome's default update-check interval) to roll out to all
          // existing clients even after the new bytes are on the origin.
          // 'none' makes EVERY registration/update check refetch sw.js
          // bypass-cache, so the moment we ship a new version it lands
          // on the next page load. Standard option, zero compat cost.
          updateViaCache: 'none',
        });

        // Belt-and-suspenders: explicitly poke the browser to recheck the
        // origin for a newer sw.js right now (within the 5 s post-load
        // budget). Without this, Chrome relies entirely on its built-in
        // 24 h heuristic, which means a hot user who hasn't closed their
        // tab in a day misses every same-day deploy.
        try { await reg.update(); } catch { /* non-fatal */ }

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
